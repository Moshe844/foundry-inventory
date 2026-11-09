'use strict';
const policy=require('../commercial/agent-plan'),P=require('../actions/permissions'),{ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions'),{newId}=require('../lib/util');
const relation='stockchief_runtime.agent_bin_corrections',settingsTable='stockchief_runtime.agent_bin_correction_settings',rulesTable='stockchief_runtime.agent_bin_correction_rules',action='inventory.correct_bin';
function maximum(value){const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>100000)throw new ValidationError('Choose a whole quantity between 1 and 100,000 units.');return n;}
function physicalPermissions(user){for(const permission of [P.OPERATE,P.PICK_TRANSFER,P.DISPATCH_TRANSFER,P.RECEIVE_TRANSFER])P.assertCan(user,permission,'confirm a physical bin move');}
function scope(p){return {skuId:p.skuId,sku:p.sku,productBarcode:p.productBarcode,unit:p.unit,from:p.from,to:p.to,siteId:p.siteId};}
async function actor(db,ctx,{owner=false}={}){
 const u=(await db.query(`SELECT u.* FROM users u JOIN workspaces w ON w.id=u.workspace_id
  WHERE u.workspace_id=$1 AND u.id=$2 AND w.deletion_requested_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)
  AND ($3=false OR (u.role='owner' AND u.account_id=w.owner_account_id)) FOR SHARE OF u,w`,[ctx.workspaceId,ctx.actorId,owner])).rows[0];
 if(!u)throw new AuthorizationError(owner?'Only the inventory owner can authorize bin corrections.':'Your inventory membership could not be verified.');
 P.assertCan(u,P.REQUEST_TRANSFER,'correct a stock bin');return u;
}
async function lockedAccount(db,ctx){
 await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
 return policy.accountState(db,ctx.workspaceId);
}
async function allowed(db,ctx,automatic=false,trained=false){
 await lockedAccount(db,ctx);
 const account=await policy.requireWorkspaceJob(db,ctx.workspaceId,11,automatic?'automatic':'draft',{trained});
 const stopped=await policy.stopped(db,ctx.workspaceId,account,action,automatic);if(stopped)throw new ValidationError(stopped);return account;
}
function printable(value){if(typeof value!=='string'||!value||value.length>80||/[^\x20-\x7e]/.test(value))throw new ValidationError('Set a unique printable scan code on the product and both bins first.');return value;}
async function site(db,workspaceId,id){
 const rows=(await db.query(`WITH RECURSIVE tree AS (
  SELECT id,parent_location_id,is_active,custody_agreement_id,ARRAY[id] path FROM locations WHERE workspace_id=$1 AND id=$2
  UNION ALL SELECT l.id,l.parent_location_id,l.is_active,l.custody_agreement_id,t.path||l.id FROM locations l JOIN tree t ON l.id=t.parent_location_id
   WHERE l.workspace_id=$1 AND NOT l.id=ANY(t.path) AND cardinality(t.path)<32)
  SELECT * FROM tree ORDER BY cardinality(path)`,[workspaceId,id])).rows;
 if(!rows.length||rows.some(r=>!Number(r.is_active)||r.custody_agreement_id)||rows.at(-1).parent_location_id)throw new ValidationError('Both bins need an active internal physical-site layout.');
 await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR SHARE',[workspaceId,rows.map(r=>r.id)]);
 return rows.at(-1).id;
}
async function facts(db,ctx,input,{excludeTransferId=null}={}){
 const quantity=maximum(input.quantity),sku=(await db.query(`SELECT s.id,s.code,s.barcode,i.name,i.unit_label,i.tracking_mode,i.quantity_precision,i.secondary_unit_label
  FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=$2 AND s.is_active=1 AND i.is_active=1 FOR SHARE OF s,i`,[ctx.workspaceId,input.skuId])).rows[0];
 if(!sku||sku.tracking_mode!=='quantity'||Number(sku.quantity_precision)!==0||sku.secondary_unit_label||(await db.query('SELECT 1 FROM kit_components WHERE workspace_id=$1 AND kit_sku_id=$2 LIMIT 1',[ctx.workspaceId,input.skuId])).rowCount)throw new ValidationError('This workflow needs an active whole-unit product. Review lots, serials, measured goods and kits separately.');
 const places=(await db.query("SELECT id,name,barcode FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[]) AND is_active=1 AND kind='bin' AND custody_agreement_id IS NULL FOR SHARE",[ctx.workspaceId,[input.from?.id||input.fromLocationId,input.to?.id||input.toLocationId]])).rows;
 const from=places.find(p=>p.id===(input.from?.id||input.fromLocationId)),to=places.find(p=>p.id===(input.to?.id||input.toLocationId));
 if(!from||!to||from.id===to.id)throw new ValidationError('Choose two different active internal bins.');
 await require('../operations/postgres-warehouse-access').assertLocations(db,ctx,[from.id,to.id]);
 const siteId=await site(db,ctx.workspaceId,from.id);if(siteId!==await site(db,ctx.workspaceId,to.id))throw new ValidationError('Use the transfer workflow for moves between physical sites.');
 const result={skuId:sku.id,sku:sku.code,product:sku.name,unit:sku.unit_label,quantity,productBarcode:printable(sku.barcode||sku.code),
  from:{id:from.id,name:from.name,barcode:printable(from.barcode)},to:{id:to.id,name:to.name,barcode:printable(to.barcode)},siteId,reason:input.reason};
 if(!['wrong-putaway','mis-scan'].includes(result.reason))throw new ValidationError('Choose wrong put-away or mis-scan as the reason.');
 const resolve=require('../operations/postgres-fulfillment-waves').resolveIdentity;
 for(const [code,kind,id]of [[result.productBarcode,'sku',sku.id],[result.from.barcode,'location',from.id],[result.to.barcode,'location',to.id]])if(await resolve(db,ctx.workspaceId,code,kind)!==id)throw new ValidationError('A scan code identifies a different record. Correct it before moving goods.');
 const stock=await require('../domain/postgres-stock-availability').read(db,ctx.workspaceId,sku.id,from.id,{excludeTransferId});
 if(stock.available<quantity)throw new ValidationError('The source bin does not have enough free stock. Check reservations and inspection holds before moving goods.');
 const cost=(await db.query('SELECT quantity_units FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,sku.id,from.id])).rows[0];
 if(Number(cost?.quantity_units||0)<quantity)throw new ValidationError('Record the source stock cost before correcting its bin so its value moves with it.');
 return result;
}
async function open(db,ctx,input){return db.transaction(async c=>{
 await actor(c,ctx);await allowed(c,ctx);
 const key=String(input.requestKey||'');if(!/^[\w-]{8,160}$/.test(key))throw new ValidationError('Open a fresh bin correction form.');
 const resolve=require('../operations/postgres-fulfillment-waves').resolveIdentity;
 const request={skuId:await resolve(c,ctx.workspaceId,input.productCode,'sku'),fromLocationId:await resolve(c,ctx.workspaceId,input.fromCode,'location'),toLocationId:await resolve(c,ctx.workspaceId,input.toCode,'location'),quantity:maximum(input.quantity),reason:input.reason};
 await require('../operations/postgres-warehouse-access').assertLocations(c,ctx,[request.fromLocationId,request.toLocationId]);
 const prior=(await c.query(`SELECT * FROM ${relation} WHERE workspace_id=$1 AND request_key=$2`,[ctx.workspaceId,key])).rows[0];
 if(prior){if(prior.source.skuId!==request.skuId||prior.source.from.id!==request.fromLocationId||prior.source.to.id!==request.toLocationId||prior.source.quantity!==request.quantity||prior.source.reason!==request.reason)throw new ValidationError('This form already prepared a different correction. Open a fresh form.');return {id:prior.id,replayed:true};}
 const p=await facts(c,ctx,request),id=newId('bincorrect');
 const transfer=await require('../transfers/postgres-transfer-service').requestInTransaction(c,ctx,{fromLocationId:p.from.id,toLocationId:p.to.id,reference:id,reason:'Bin correction: '+p.reason,notes:'Use the original scanned bin correction before changing this reservation.',idempotencyKey:'bin-correction:'+id+':reserve',skipDefaultDemandPegs:true,lines:[{skuId:p.skuId,quantity:p.quantity}]});
 await c.query(`INSERT INTO ${relation}(id,workspace_id,request_key,transfer_id,source,fingerprint,opened_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,ctx.workspaceId,key,transfer.id,JSON.stringify(p),hash(p),ctx.actorId]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Bin correction prepared',reference:id,after:{sku:p.sku,quantity:p.quantity,from:p.from.name,to:p.to.name}});return {id};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function get(db,ctx,id,{lock=false}={}){
 await actor(db,ctx);const row=(await db.query(`SELECT * FROM ${relation} WHERE workspace_id=$1 AND id=$2 ${lock?'FOR UPDATE':''}`,[ctx.workspaceId,id])).rows[0];
 if(!row)throw new NotFoundError('That bin correction is not in this inventory.');
 await require('../operations/postgres-warehouse-access').assertLocations(db,ctx,[row.source.from.id,row.source.to.id]);return row;
}
async function automaticAuthority(db,ctx,row){
 const setting=(await db.query(`SELECT * FROM ${settingsTable} WHERE workspace_id=$1 FOR SHARE`,[ctx.workspaceId])).rows[0];
 if(!setting?.enabled||row.source.quantity>setting.maximum_units)throw new ValidationError('This correction needs owner approval under the routine quantity limit.');
 const ownerCtx={workspaceId:ctx.workspaceId,actorId:setting.authorized_by};await actor(db,ownerCtx,{owner:true});
 if(!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)throw new ValidationError('Routine bin corrections are paused.');
 const related=(await db.query(`SELECT * FROM ${rulesTable} WHERE workspace_id=$1 AND scope->>'skuId'=$2 AND scope#>>'{from,id}'=$3 AND scope#>>'{to,id}'=$4 FOR SHARE`,[ctx.workspaceId,row.source.skuId,row.source.from.id,row.source.to.id])).rows;
 const rule=related.find(r=>r.scope_hash===hash(scope(row.source)));
 if(related.length&&!rule)throw new ValidationError('The product, bin scan codes or site changed from the taught correction. Review the scope.');
 for(const r of related){if(r.authorized_by!==setting.authorized_by||row.source.quantity>r.maximum_units)throw new ValidationError('This correction exceeds a lower owner-taught limit.');}
 await allowed(db,ctx,true,Boolean(rule));return ownerCtx;
}
async function reservation(db,ctx,row){
 const transfer=await require('../transfers/postgres-transfer-service').get(db,ctx.workspaceId,row.transfer_id,{lock:true}),line=transfer.lines[0];
 if(transfer.status!=='REQUESTED'||transfer.lines.length!==1||line.sku_id!==row.source.skuId||Number(line.requested_quantity)!==row.source.quantity||transfer.source_location_id!==row.source.from.id||transfer.destination_location_id!==row.source.to.id)throw new ValidationError('The linked stock reservation changed. Review the original correction and transfer before posting.');
 return transfer;
}
async function finish(c,ctx,row,{automatic=false,ownerCtx=null,manualRecovery=false}={}){
 if(row.status==='COMPLETED')return {id:row.id,replayed:true,automatic:row.automatic,manualRecovery:row.manual_recovery};
 if(row.status!=='SCANNED'||!row.scan_proof||!['pro','enterprise'].includes(row.scanned_plan)||(automatic&&Date.now()-Date.parse(row.scanned_at)>86400000))throw new ValidationError('Current physical scan evidence is required. Review older or incomplete corrections individually.');
 const scannerCtx={workspaceId:ctx.workspaceId,actorId:row.scanned_by,binCorrectionId:row.id};physicalPermissions(await actor(c,scannerCtx));
 const transfer=await reservation(c,ctx,row),p=await facts(c,scannerCtx,row.source,{excludeTransferId:row.transfer_id});if(hash(p)!==row.fingerprint)throw new ValidationError('The product, units or bin layout changed. Review the original correction before posting.');
 if(automatic)ownerCtx=await automaticAuthority(c,scannerCtx,row);else{
  await actor(c,ctx,{owner:true});
  if(manualRecovery){
   const account=await lockedAccount(c,ctx);
   if(!['starter','growth'].includes(account.plan)||!['pro','enterprise'].includes(row.scanned_plan))throw new ValidationError('Manual completion after a downgrade is only for an existing physical move confirmed on Pro or Custom. Use the current plan approval controls for other work.');
  }else await allowed(c,ctx);
  ownerCtx=ctx;
 }
 const transfers=require('../transfers/postgres-transfer-service'),base='bin-correction:'+row.id;
 await c.query("SELECT set_config('stockchief.bin_correction_id',$1,true)",[row.id]);
 await transfers.approveInTransaction(c,{...ownerCtx,binCorrectionId:row.id},transfer.id,{idempotencyKey:base+':approve'});
 await transfers.pickInTransaction(c,scannerCtx,transfer.id,{idempotencyKey:base+':pick'});
 await transfers.dispatchInTransaction(c,scannerCtx,transfer.id,{idempotencyKey:base+':dispatch'});
 await transfers.receiveInTransaction(c,scannerCtx,transfer.id,{idempotencyKey:base+':receive',lines:[{lineId:transfer.lines[0].id,received:p.quantity,lost:0,damaged:0}]});
 const proof=await transfers.verify(c,ctx.workspaceId,transfer.id);if(!proof.ok||proof.transfer.status!=='RECEIVED'||proof.transfer.lines[0].cost_status!=='RECORDED')throw new ValidationError('The completed bin transfer did not reconcile its stock and cost.');
 const links=(await c.query('SELECT role,movement_id FROM inventory_transfer_movement_links WHERE workspace_id=$1 AND transfer_line_id=$2',[ctx.workspaceId,transfer.lines[0].id])).rows;
 const result={outMovementId:links.find(x=>x.role==='DISPATCH')?.movement_id,inMovementId:links.find(x=>x.role==='RECEIPT')?.movement_id};
 if(!result.outMovementId||!result.inMovementId)throw new ValidationError('Both physical bin movement records are required.');
 await c.query(`UPDATE ${relation} SET status='COMPLETED',automatic=$3,approved_by=$4,out_movement_id=$5,in_movement_id=$6,manual_recovery=$7,completed_at=now(),problem=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,automatic,ownerCtx.actorId,result.outMovementId,result.inMovementId,manualRecovery]);
 await require('../operations/postgres-security-audit').record(c,manualRecovery?ctx:scannerCtx,{action:manualRecovery?'Existing physical bin move completed manually after downgrade':'Scanned bin correction completed',reference:row.id,after:{automatic,manualRecovery,scannedBy:row.scanned_by,approvedBy:ownerCtx.actorId,quantity:p.quantity,from:p.from.name,to:p.to.name}});
 return {id:row.id,automatic,manualRecovery,replayed:false};
}
async function scan(db,ctx,id,input){return db.transaction(async c=>{
 physicalPermissions(await actor(c,ctx));
 const row=await get(c,ctx,id,{lock:true});if(row.status==='COMPLETED')return {id,replayed:true};const scanAccount=await allowed(c,ctx);
 if(input.confirmed!=='yes'||input.expectedFingerprint!==row.fingerprint||maximum(input.quantity)!==row.source.quantity)throw new ValidationError('Confirm the exact quantity was physically moved, with current product and bin scans.');
 for(const [value,expected]of [[input.productCode,row.source.productBarcode],[input.fromCode,row.source.from.barcode],[input.toCode,row.source.to.barcode]])if(typeof value!=='string'||value.length>240||value.trim()!==expected)throw new ValidationError('Scan the exact product, source bin and destination bin shown on this correction.');
 await reservation(c,ctx,row);
 const fresh=await facts(c,ctx,row.source,{excludeTransferId:row.transfer_id});if(hash(fresh)!==row.fingerprint)throw new ValidationError('The product or bin layout changed after preparation. Review it before recording physical work.');
 if(row.status==='SCANNED'&&row.scanned_by!==ctx.actorId)throw new ValidationError('Another person already confirmed this physical move. Ask the owner to review that scan.');
 if(row.status==='OPEN'){
  row.scan_proof={productCode:row.source.productBarcode,fromCode:row.source.from.barcode,toCode:row.source.to.barcode,quantity:row.source.quantity,confirmed:true};row.scanned_by=ctx.actorId;row.scanned_at=new Date().toISOString();row.scanned_plan=scanAccount.plan;row.status='SCANNED';
  await c.query(`UPDATE ${relation} SET status='SCANNED',scanned_by=$3,scan_proof=$4,scanned_at=$5,scanned_plan=$6 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId,JSON.stringify(row.scan_proof),row.scanned_at,row.scanned_plan]);
 }
 try{await automaticAuthority(c,ctx,row);}catch(error){if(![400,402,403,422].includes(error.status))throw error;await c.query(`UPDATE ${relation} SET problem=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,error.message]);return {id,needsApproval:true,reason:error.message};}
 return finish(c,ctx,row,{automatic:true});
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function approve(db,ctx,id,input){return db.transaction(async c=>{
 await actor(c,ctx,{owner:true});const row=await get(c,ctx,id,{lock:true});
 if(input.confirmed!=='yes'||input.expectedFingerprint!==row.fingerprint)throw new ValidationError('Approve the exact physically scanned correction.');
 return finish(c,ctx,row,{manualRecovery:input.manualRecovery==='yes'});
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function cancel(db,ctx,id,input){return db.transaction(async c=>{
 await actor(c,ctx,{owner:true});const row=await get(c,ctx,id,{lock:true});
 if(input.confirmed!=='yes')throw new ValidationError('Confirm the units have not been physically moved before releasing their reservation.');
 if(row.status==='CANCELLED')return {id,replayed:true};
 if(row.status!=='OPEN')throw new ValidationError('A physically confirmed correction must be reviewed and settled before its stock reservation can be released.');
 await reservation(c,ctx,row);await c.query("SELECT set_config('stockchief.bin_correction_id',$1,true)",[row.id]);
 await require('../transfers/postgres-transfer-service').cancelInTransaction(c,{...ctx,binCorrectionId:id},row.transfer_id,{idempotencyKey:'bin-correction:'+id+':cancel',reason:'Owner confirmed no physical bin movement occurred.'});
 await c.query(`UPDATE ${relation} SET status='CANCELLED',problem=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Unmoved bin correction cancelled',reference:id});return {id};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function configure(db,ctx,input){return db.transaction(async c=>{
 await actor(c,ctx,{owner:true});const prior=(await c.query(`SELECT * FROM ${settingsTable} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
 if(Number(input.revision||0)!==(prior?.revision||0))throw new ValidationError('Reload the current routine correction settings.');
 if(input.stop==='yes'){await c.query(`UPDATE ${settingsTable} SET enabled=false,revision=revision+1 WHERE workspace_id=$1`,[ctx.workspaceId]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Routine bin corrections stopped'});return;}
 await allowed(c,ctx);if(input.confirmed!=='yes')throw new ValidationError('Confirm routine corrections within the chosen whole-unit limit.');const limit=maximum(input.maximumUnits);
 await c.query(`INSERT INTO ${settingsTable}(workspace_id,maximum_units,authorized_by) VALUES($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET maximum_units=EXCLUDED.maximum_units,authorized_by=EXCLUDED.authorized_by,enabled=true,revision=agent_bin_correction_settings.revision+1`,[ctx.workspaceId,limit,ctx.actorId]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Routine bin corrections authorized',after:{maximumUnits:limit}});
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function teach(db,ctx,id,input){return db.transaction(async c=>{
 await actor(c,ctx,{owner:true});const row=await get(c,ctx,id),scopeHash=hash(scope(row.source));
 if(input.confirmed!=='yes')throw new ValidationError('Confirm this exact learned correction scope.');
 const prior=(await c.query(`SELECT * FROM ${rulesTable} WHERE workspace_id=$1 AND scope_hash=$2 FOR UPDATE`,[ctx.workspaceId,scopeHash])).rows[0];
 if(Number(input.revision||0)!==(prior?.revision||0))throw new ValidationError('Reload the current learned bin correction rule.');
 if(input.remove==='yes'){await c.query(`DELETE FROM ${rulesTable} WHERE workspace_id=$1 AND scope_hash=$2`,[ctx.workspaceId,scopeHash]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Learned bin correction limit removed',reference:id});return;}
 await allowed(c,ctx);if(row.status!=='COMPLETED'||row.automatic||row.manual_recovery||row.approved_by!==ctx.actorId)throw new ValidationError('Individually approve a physically scanned correction under the current Pro or Custom plan before teaching its scope. Manual completion after downgrade cannot teach new authority.');
 const limit=maximum(input.maximumUnits);await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?0:1);
 await c.query(`INSERT INTO ${rulesTable}(workspace_id,scope_hash,scope,maximum_units,authorized_by,example_id) VALUES($1,$2,$3,$4,$5,$6)
  ON CONFLICT(workspace_id,scope_hash) DO UPDATE SET maximum_units=EXCLUDED.maximum_units,authorized_by=EXCLUDED.authorized_by,example_id=EXCLUDED.example_id,revision=agent_bin_correction_rules.revision+1`,[ctx.workspaceId,scopeHash,JSON.stringify(scope(row.source)),limit,ctx.actorId,id]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Bin correction scope taught',reference:id,after:{maximumUnits:limit}});
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function page(db,ctx,id=null,{afterRule=''}={}){
 if(afterRule&&!/^[a-f0-9]{64}$/.test(afterRule))throw new ValidationError('Open a valid learned-rule page.');
 const user=await actor(db,ctx),account=await policy.accountState(db,ctx.workspaceId),locked=!policy.usesAgentTerms(account)||!policy.permits(account.plan,11,'draft');
 const row=id?await get(db,ctx,id):null,owner=user.role==='owner';
 const settings=owner?(await db.query(`SELECT * FROM ${settingsTable} WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0]:null;
 const rule=owner&&row?(await db.query(`SELECT * FROM ${rulesTable} WHERE workspace_id=$1 AND scope_hash=$2`,[ctx.workspaceId,hash(scope(row.source))])).rows[0]:null;
 const recent=owner&&!row?(await db.query(`SELECT id,source,status FROM ${relation} WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 50`,[ctx.workspaceId])).rows:[];
 const learned=owner&&!row?(await db.query(`SELECT scope,maximum_units,example_id,scope_hash FROM ${rulesTable} WHERE workspace_id=$1 AND scope_hash>$2 ORDER BY scope_hash LIMIT 101`,[ctx.workspaceId,afterRule])).rows:[];
 const blocked=locked?null:await policy.stopped(db,ctx.workspaceId,account,action,false);
 const manualRecoveryAllowed=owner&&['starter','growth'].includes(account.plan)&&row?.status==='SCANNED'&&['pro','enterprise'].includes(row.scanned_plan);
 return {row,settings,rule,recent,learned:learned.slice(0,100),nextRule:learned.length>100?learned[99].scope_hash:null,owner,locked,blocked,manualRecoveryAllowed,canScan:[P.OPERATE,P.PICK_TRANSFER,P.DISPATCH_TRANSFER,P.RECEIVE_TRANSFER].every(p=>P.can(user,p)),shadow:account.shadow,requestKey:newId('bincorrectform')};
}
async function readPage(db,ctx,{page=1}={}){
 await actor(db,ctx,{owner:true});const rows=(await db.query(`SELECT id,source,status,problem FROM ${relation} WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 101 OFFSET $2`,[ctx.workspaceId,(page-1)*100])).rows;
 return {summary:'Correct a whole-unit product between internal bins at one physical site. Staff must scan and confirm the real move; preparing a correction never moves stock. Pro needs an individually approved example for routine work. Custom can handle scanned work after the owner enables a unit limit. Lower taught limits still apply.',rows:[{Action:'Prepare a scanned bin correction',link:'/warehouse/bin-corrections'},...rows.slice(0,100).map(r=>({SKU:r.source.sku,Quantity:r.source.quantity,From:r.source.from.name,To:r.source.to.name,Status:r.status,Review:r.problem||'',link:'/warehouse/bin-corrections/'+r.id}))],more:rows.length>100};
}
module.exports={open,get,scan,approve,cancel,configure,teach,page,scope,definition:{id:11,key:'bin-corrections',label:'Correct physically scanned stock bins',readPage}};

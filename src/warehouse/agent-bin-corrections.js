'use strict';
const policy=require('../commercial/agent-plan'),P=require('../actions/permissions'),{ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions'),{newId}=require('../lib/util'),exact=require('../domain/exact-quantity');
const relation='stockchief_runtime.agent_bin_corrections',settingsTable='stockchief_runtime.agent_bin_correction_settings',rulesTable='stockchief_runtime.agent_bin_correction_rules',action='inventory.correct_bin';
// Errors that mean "a person must decide", as opposed to a failure.
const held=[400,402,403,422];
function maximum(value){const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>100000)throw new ValidationError('Choose a whole quantity between 1 and 100,000 units.');return n;}
function counted(value,where){const n=Number(value);if(String(value??'').trim()===''||!Number.isSafeInteger(n)||n<0||n>100000)throw new ValidationError('Enter the whole number of units you counted in '+where+'. Enter 0 if it is empty.');return n;}
const physical=[P.OPERATE,P.PICK_TRANSFER,P.DISPATCH_TRANSFER,P.RECEIVE_TRANSFER];
function physicalPermissions(user){for(const permission of physical)P.assertCan(user,permission,'confirm a physical bin move');}
const canMove=user=>physical.every(p=>P.can(user,p));
// A records correction is taught separately from a physical move between the
// same bins. Moves keep the scope they had before records corrections existed.
function scope(p){return {skuId:p.skuId,sku:p.sku,productBarcode:p.productBarcode,unit:p.unit,from:p.from,to:p.to,siteId:p.siteId,...(p.kind==='RECORD'?{kind:'RECORD'}:{})};}
const kindOf=p=>p.kind==='RECORD'?'RECORD':'MOVE';
function line(p){return {skuId:p.skuId,quantity:p.quantity,...(p.lot?{lotId:p.lot.id}:{}),...(p.serials?{serialUnitIds:p.serials.map(s=>s.id)}:{})};}
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
// The exact product, units, bins and identities of one correction. Batch and
// serial goods carry their batch or serial numbers; measured goods and kits
// are refused. allowReserved lets evidence be recorded even when the stock is
// reserved; such a correction waits for a person instead of reserving it.
async function facts(db,ctx,input,{excludeTransferId=null,allowReserved=false}={}){
 const sku=(await db.query(`SELECT s.id,s.code,s.barcode,i.name,i.unit_label,i.tracking_mode,i.quantity_precision,i.secondary_unit_label
  FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=$2 AND s.is_active=1 AND i.is_active=1 FOR SHARE OF s,i`,[ctx.workspaceId,input.skuId])).rows[0];
 if(!sku||!['quantity','lot','serial'].includes(sku.tracking_mode)||Number(sku.quantity_precision)!==0||sku.secondary_unit_label||(await db.query('SELECT 1 FROM kit_components WHERE workspace_id=$1 AND kit_sku_id=$2 LIMIT 1',[ctx.workspaceId,input.skuId])).rowCount)throw new ValidationError('This workflow needs an active whole-unit product. Review measured goods and kits separately.');
 const places=(await db.query("SELECT id,name,barcode FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[]) AND is_active=1 AND kind='bin' AND custody_agreement_id IS NULL FOR SHARE",[ctx.workspaceId,[input.from?.id||input.fromLocationId,input.to?.id||input.toLocationId]])).rows;
 const from=places.find(p=>p.id===(input.from?.id||input.fromLocationId)),to=places.find(p=>p.id===(input.to?.id||input.toLocationId));
 if(!from||!to||from.id===to.id)throw new ValidationError('Choose two different active internal bins.');
 await require('../operations/postgres-warehouse-access').assertLocations(db,ctx,[from.id,to.id]);
 const siteId=await site(db,ctx.workspaceId,from.id);if(siteId!==await site(db,ctx.workspaceId,to.id))throw new ValidationError('Use the transfer workflow for moves between physical sites.');
 const resolve=require('../operations/postgres-fulfillment-waves').resolveIdentity;
 let quantity=maximum(input.quantity),lot=null,serials=null;
 if(sku.tracking_mode==='lot'){
  const lotId=input.lot?.id||(input.lotCode?await resolve(db,ctx.workspaceId,input.lotCode,'lot',{skuId:sku.id,label:'Batch code'}):null);
  const found=lotId&&(await db.query('SELECT id,code FROM lots WHERE workspace_id=$1 AND id=$2 AND sku_id=$3',[ctx.workspaceId,lotId,sku.id])).rows[0];
  if(!found)throw new ValidationError('Scan the batch code for this product.');lot={id:found.id,code:printable(found.code)};
 }
 if(sku.tracking_mode==='serial'){
  const wanted=(input.serials||[]).map(s=>typeof s==='string'?s:s.id);
  const rows=wanted.length?(await db.query(`SELECT id,serial,location_id,status FROM serial_units WHERE workspace_id=$1 AND sku_id=$2 AND (id=ANY($3::text[]) OR serial=ANY($3::text[])) ORDER BY serial,id FOR SHARE`,[ctx.workspaceId,sku.id,wanted])).rows:[];
  if(!rows.length||rows.length!==new Set(wanted).size)throw new ValidationError('Scan each serial number of this product.');
  if(rows.some(r=>r.status!=='in_stock'||r.location_id!==from.id))throw new ValidationError('A serial number is not recorded in '+from.name+'.');
  serials=rows.map(r=>({id:r.id,serial:printable(r.serial)}));if(input.quantity!=null&&quantity!==serials.length)throw new ValidationError('The quantity must match the serial numbers scanned.');quantity=serials.length;
 }
 const result={skuId:sku.id,sku:sku.code,product:sku.name,unit:sku.unit_label,quantity,productBarcode:printable(sku.barcode||sku.code),
  from:{id:from.id,name:from.name,barcode:printable(from.barcode)},to:{id:to.id,name:to.name,barcode:printable(to.barcode)},siteId,reason:input.reason};
 if(!['wrong-putaway','mis-scan'].includes(result.reason))throw new ValidationError('Choose wrong put-away or mis-scan as the reason.');
 if(input.kind==='RECORD')result.kind='RECORD';if(lot)result.lot=lot;if(serials)result.serials=serials;
 for(const [code,kind,id]of [[result.productBarcode,'sku',sku.id],[result.from.barcode,'location',from.id],[result.to.barcode,'location',to.id]])if(await resolve(db,ctx.workspaceId,code,kind)!==id)throw new ValidationError('A scan code identifies a different record. Correct it before moving goods.');
 if(!allowReserved&&await free(db,ctx,result,{excludeTransferId})<quantity)throw new ValidationError('The source bin does not have enough free stock. Check reservations and inspection holds before moving goods.');
 const cost=(await db.query('SELECT quantity_units FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,sku.id,from.id])).rows[0];
 if(Number(cost?.quantity_units||0)<quantity)throw new ValidationError('Record the source stock cost before correcting its bin so its value moves with it.');
 return result;
}
async function free(db,ctx,p,{excludeTransferId=null}={}){return (await require('../domain/postgres-stock-availability').read(db,ctx.workspaceId,p.skuId,p.from.id,{excludeTransferId,lotId:p.lot?.id||null})).available;}
async function value(db,ctx,p){
 const c=(await db.query('SELECT quantity_units::text units,total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,p.skuId,p.from.id])).rows[0];
 return c&&Number(c.units)>0?exact.ratioMinor(Number(c.total_cost_minor),p.quantity,c.units):0;
}
// Stock a person must look at before StockChief corrects it on its own.
async function protections(db,ctx,p,{excludeReviewIds=[],excludeTransferId=null}={}){
 const reasons=[];if(p.lot||p.serials)reasons.push('This is batch or serial-tracked stock.');
 const bins=[p.from.id,p.to.id],{rows:[state]}=await db.query(`SELECT
  EXISTS(SELECT 1 FROM fulfillment_wave_lines wl JOIN fulfillment_waves w ON w.workspace_id=wl.workspace_id AND w.id=wl.wave_id
   WHERE wl.workspace_id=$1 AND wl.sku_id=$2 AND wl.location_id=ANY($3::text[]) AND w.status IN ('RELEASED','PICKING','BLOCKED','PACKED'))
  OR EXISTS(SELECT 1 FROM inventory_transfer_lines tl JOIN inventory_transfers t ON t.workspace_id=tl.workspace_id AND t.id=tl.transfer_id
   WHERE tl.workspace_id=$1 AND tl.sku_id=$2 AND t.source_location_id=ANY($3::text[]) AND t.status IN ('APPROVED','PICKED') AND t.id IS DISTINCT FROM $5) AS picking,
  EXISTS(SELECT 1 FROM locations l WHERE l.workspace_id=$1 AND l.id=ANY($3::text[]) AND l.annual_count_freeze_id IS NOT NULL)
  OR EXISTS(SELECT 1 FROM warehouse_count_campaign_lines q JOIN warehouse_count_campaigns c ON c.workspace_id=q.workspace_id AND c.id=q.campaign_id
   WHERE q.workspace_id=$1 AND q.location_id=ANY($3::text[]) AND q.applied_at IS NULL AND c.status<>'COMPLETED')
  OR EXISTS(SELECT 1 FROM physical_count_reviews r WHERE r.workspace_id=$1 AND r.status='PENDING' AND r.payload->'location'->>'id'=ANY($3::text[]) AND NOT r.id=ANY($4::text[])) AS counting`,
 [ctx.workspaceId,p.skuId,bins,excludeReviewIds,excludeTransferId]);
 if(state.picking)reasons.push('Stock in one of these bins is being picked.');
 if(state.counting)reasons.push('A count is in progress in one of these bins.');
 return reasons;
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
 const transfer=await reserve(c,ctx,id,p);
 await c.query(`INSERT INTO ${relation}(id,workspace_id,request_key,transfer_id,source,fingerprint,opened_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,ctx.workspaceId,key,transfer.id,JSON.stringify(p),hash(p),ctx.actorId]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Bin correction prepared',reference:id,after:{sku:p.sku,quantity:p.quantity,from:p.from.name,to:p.to.name}});return {id};
},{isolation:'SERIALIZABLE',retrySafe:true});}
function reserve(c,ctx,id,p){
 return require('../transfers/postgres-transfer-service').requestInTransaction(c,ctx,{fromLocationId:p.from.id,toLocationId:p.to.id,reference:id,reason:'Bin correction: '+p.reason,notes:'Use the original scanned bin correction before changing this reservation.',idempotencyKey:'bin-correction:'+id+':reserve',skipDefaultDemandPegs:true,lines:[line(p)]});
}
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
 const related=(await db.query(`SELECT * FROM ${rulesTable} WHERE workspace_id=$1 AND scope->>'skuId'=$2 AND scope#>>'{from,id}'=$3 AND scope#>>'{to,id}'=$4 FOR SHARE`,[ctx.workspaceId,row.source.skuId,row.source.from.id,row.source.to.id])).rows.filter(r=>kindOf(r.scope)===kindOf(row.source));
 const rule=related.find(r=>r.scope_hash===hash(scope(row.source)));
 if(related.length&&!rule)throw new ValidationError('The product, bin scan codes or site changed from the taught correction. Review the scope.');
 for(const r of related){if(r.authorized_by!==setting.authorized_by||row.source.quantity>r.maximum_units)throw new ValidationError('This correction exceeds a lower owner-taught limit.');}
 if(setting.maximum_value_minor!=null&&await value(db,ctx,row.source)>Number(setting.maximum_value_minor))throw new ValidationError('This stock is worth more than your routine value limit. A person must approve this correction.');
 const blocked=await protections(db,ctx,row.source,{excludeReviewIds:row.evidence?.reviews||[],excludeTransferId:row.transfer_id});
 if(blocked.length)throw new ValidationError(blocked[0]+' A person must approve this correction.');
 await allowed(db,ctx,true,Boolean(rule));return ownerCtx;
}
async function reservation(db,ctx,row){
 const transfer=await require('../transfers/postgres-transfer-service').get(db,ctx.workspaceId,row.transfer_id,{lock:true}),line=transfer.lines[0];
 if(transfer.status!=='REQUESTED'||transfer.lines.length!==1||line.sku_id!==row.source.skuId||Number(line.requested_quantity)!==row.source.quantity||transfer.source_location_id!==row.source.from.id||transfer.destination_location_id!==row.source.to.id)throw new ValidationError('The linked stock reservation changed. Review the original correction and transfer before posting.');
 return transfer;
}
// Runs the reserved bin transfer to completion: the owner (or the owner's
// routine authority) approves, and the person who confirmed the stock's real
// bin records the physical steps. A records correction approved by the owner
// uses the owner for those steps when the finder cannot record stock moves.
async function finish(c,ctx,row,{automatic=false,ownerCtx=null,manualRecovery=false}={}){
 if(['COMPLETED','UNDONE'].includes(row.status))return {id:row.id,replayed:true,automatic:row.automatic,manualRecovery:row.manual_recovery};
 if(row.status!=='SCANNED'||!row.scan_proof||!['pro','enterprise'].includes(row.scanned_plan)||(automatic&&Date.now()-Date.parse(row.scanned_at)>86400000))throw new ValidationError('Current physical scan evidence is required. Review older or incomplete corrections individually.');
 const scannerCtx={workspaceId:ctx.workspaceId,actorId:row.scanned_by,binCorrectionId:row.id};let physicalCtx=scannerCtx;
 if(automatic||row.kind!=='RECORD')physicalPermissions(await actor(c,scannerCtx));
 else{const scanner=await actor(c,scannerCtx).catch(error=>{if(error instanceof AuthorizationError)return null;throw error;});if(!scanner||!canMove(scanner))physicalCtx=null;}
 const transfer=await reservation(c,ctx,row),p=await facts(c,physicalCtx||ctx,row.source,{excludeTransferId:row.transfer_id});if(hash(p)!==row.fingerprint)throw new ValidationError('The product, units or bin layout changed. Review the original correction before posting.');
 if(automatic)ownerCtx=await automaticAuthority(c,scannerCtx,row);else{
  await actor(c,ctx,{owner:true});
  if(manualRecovery){
   const account=await lockedAccount(c,ctx);
   if(!['starter','growth'].includes(account.plan)||!['pro','enterprise'].includes(row.scanned_plan))throw new ValidationError('Manual completion after a downgrade is only for an existing physical move confirmed on Pro or Custom. Use the current plan approval controls for other work.');
  }else await allowed(c,ctx);
  ownerCtx=ctx;
 }
 physicalCtx=physicalCtx||{...ownerCtx,binCorrectionId:row.id};
 const transfers=require('../transfers/postgres-transfer-service'),base='bin-correction:'+row.id;
 await c.query("SELECT set_config('stockchief.bin_correction_id',$1,true)",[row.id]);
 await transfers.approveInTransaction(c,{...ownerCtx,binCorrectionId:row.id},transfer.id,{idempotencyKey:base+':approve'});
 await transfers.pickInTransaction(c,physicalCtx,transfer.id,{idempotencyKey:base+':pick'});
 await transfers.dispatchInTransaction(c,physicalCtx,transfer.id,{idempotencyKey:base+':dispatch'});
 await transfers.receiveInTransaction(c,physicalCtx,transfer.id,{idempotencyKey:base+':receive',lines:[{lineId:transfer.lines[0].id,received:p.quantity,lost:0,damaged:0,...(p.serials?{receivedSerialUnitIds:p.serials.map(s=>s.id)}:{})}]});
 const proof=await transfers.verify(c,ctx.workspaceId,transfer.id);if(!proof.ok||proof.transfer.status!=='RECEIVED'||proof.transfer.lines[0].cost_status!=='RECORDED')throw new ValidationError('The completed bin transfer did not reconcile its stock and cost.');
 const links=(await c.query('SELECT role,movement_id FROM inventory_transfer_movement_links WHERE workspace_id=$1 AND transfer_line_id=$2',[ctx.workspaceId,transfer.lines[0].id])).rows;
 const result={outMovementId:links.find(x=>x.role==='DISPATCH')?.movement_id,inMovementId:links.find(x=>x.role==='RECEIPT')?.movement_id};
 if(!result.outMovementId||!result.inMovementId)throw new ValidationError('Both physical bin movement records are required.');
 await c.query(`UPDATE ${relation} SET status='COMPLETED',automatic=$3,approved_by=$4,out_movement_id=$5,in_movement_id=$6,manual_recovery=$7,completed_at=now(),problem=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,automatic,ownerCtx.actorId,result.outMovementId,result.inMovementId,manualRecovery]);
 await require('../operations/postgres-security-audit').record(c,manualRecovery?ctx:physicalCtx,{action:manualRecovery?'Existing physical bin move completed manually after downgrade':row.kind==='RECORD'?'Stock records moved to the bin where the stock was found':'Scanned bin correction completed',reference:row.id,after:{automatic,manualRecovery,scannedBy:row.scanned_by,approvedBy:ownerCtx.actorId,quantity:p.quantity,from:p.from.name,to:p.to.name,kind:row.kind,...(p.lot?{batch:p.lot.code}:{}),...(p.serials?{serials:p.serials.map(s=>s.serial)}:{})}});
 if(row.evidence?.reviews?.length)await settleCounts(c,ctx,row,p,ownerCtx);
 return {id:row.id,automatic,manualRecovery,replayed:false};
}
// A count that only differed by this bin mix-up has nothing left to post.
async function settleCounts(c,ctx,row,p,ownerCtx){
 for(const reviewId of row.evidence.reviews){
  const review=(await c.query('SELECT payload,status FROM physical_count_reviews WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,reviewId])).rows[0];
  if(review?.status!=='PENDING'||review.payload.lines.some(l=>Number(l.delta)!==0&&l.skuId!==p.skuId))continue;
  await c.query("UPDATE physical_count_reviews SET status='COMPLETED',approved_at=now(),approved_by_user_id=$3,result=$4 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,reviewId,ownerCtx.actorId,{lines:review.payload.lines.length,changed:0,binCorrectionId:row.id}]);
 }
}
async function scan(db,ctx,id,input){return db.transaction(async c=>{
 physicalPermissions(await actor(c,ctx));
 const row=await get(c,ctx,id,{lock:true});if(row.status==='COMPLETED')return {id,replayed:true};const scanAccount=await allowed(c,ctx);
 if(row.kind==='RECORD'||row.status==='PROPOSED')throw new ValidationError(row.kind==='RECORD'?'This correction moves records only. The owner reviews it.':'The owner must approve this move before you carry it out.');
 if(input.confirmed!=='yes'||input.expectedFingerprint!==row.fingerprint||maximum(input.quantity)!==row.source.quantity)throw new ValidationError('Confirm the exact quantity was physically moved, with current product and bin scans.');
 for(const [value,expected]of [[input.productCode,row.source.productBarcode],[input.fromCode,row.source.from.barcode],[input.toCode,row.source.to.barcode]])if(typeof value!=='string'||value.length>240||value.trim()!==expected)throw new ValidationError('Scan the exact product, source bin and destination bin shown on this correction.');
 await reservation(c,ctx,row);
 const fresh=await facts(c,ctx,row.source,{excludeTransferId:row.transfer_id});if(hash(fresh)!==row.fingerprint)throw new ValidationError('The product or bin layout changed after preparation. Review it before recording physical work.');
 if(row.status==='SCANNED'&&row.scanned_by!==ctx.actorId)throw new ValidationError('Another person already confirmed this physical move. Ask the owner to review that scan.');
 if(row.status==='OPEN'){
  row.scan_proof={productCode:row.source.productBarcode,fromCode:row.source.from.barcode,toCode:row.source.to.barcode,quantity:row.source.quantity,confirmed:true};row.scanned_by=ctx.actorId;row.scanned_at=new Date().toISOString();row.scanned_plan=scanAccount.plan;row.status='SCANNED';
  await c.query(`UPDATE ${relation} SET status='SCANNED',scanned_by=$3,scan_proof=$4,scanned_at=$5,scanned_plan=$6 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId,JSON.stringify(row.scan_proof),row.scanned_at,row.scanned_plan]);
 }
 try{await automaticAuthority(c,ctx,row);}catch(error){if(!held.includes(error.status))throw error;
  // An owner who approved this move before it happened has already decided.
  if(row.approved_by){await c.query('SAVEPOINT bin_preapproved');try{const done=await finish(c,{workspaceId:ctx.workspaceId,actorId:row.approved_by},row,{});await c.query('RELEASE SAVEPOINT bin_preapproved');return done;}catch(failed){await c.query('ROLLBACK TO SAVEPOINT bin_preapproved');if(!held.includes(failed.status))throw failed;error=failed;}}
  await c.query(`UPDATE ${relation} SET problem=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,error.message]);return {id,needsApproval:true,reason:error.message};}
 return finish(c,ctx,row,{automatic:true});
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function approve(db,ctx,id,input){return db.transaction(async c=>{
 await actor(c,ctx,{owner:true});const row=await get(c,ctx,id,{lock:true});
 if(input.confirmed!=='yes'||input.expectedFingerprint!==row.fingerprint)throw new ValidationError('Approve the exact physically scanned correction.');
 if(row.status==='PROPOSED'){
  await allowed(c,ctx);const p=await facts(c,ctx,row.source);if(hash(p)!==row.fingerprint)throw new ValidationError('The product, units or bin layout changed. Review the evidence again.');
  const transfer=await reserve(c,ctx,row.id,p);
  if(row.kind==='RECORD'){await c.query(`UPDATE ${relation} SET status='SCANNED',transfer_id=$3,problem=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,transfer.id]);return finish(c,ctx,{...row,status:'SCANNED',transfer_id:transfer.id},{});}
  await c.query(`UPDATE ${relation} SET status='OPEN',transfer_id=$3,approved_by=$4,problem=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,transfer.id,ctx.actorId]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Bin move approved before staff carry it out',reference:id,after:{sku:p.sku,quantity:p.quantity,from:p.from.name,to:p.to.name}});
  return {id,opened:true};
 }
 return finish(c,ctx,row,{manualRecovery:input.manualRecovery==='yes'});
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function cancel(db,ctx,id,input){return db.transaction(async c=>{
 await actor(c,ctx,{owner:true});const row=await get(c,ctx,id,{lock:true});
 if(input.confirmed!=='yes')throw new ValidationError(row.status==='PROPOSED'||row.kind==='RECORD'?'Confirm you want to decline this correction.':'Confirm the units have not been physically moved before releasing their reservation.');
 if(row.status==='CANCELLED')return {id,replayed:true};
 if(row.status==='PROPOSED'){await c.query(`UPDATE ${relation} SET status='CANCELLED',problem=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Bin correction declined',reference:id});return {id};}
 // Nothing was carried for a records correction, so declining it only
 // releases the units it held back at the recorded bin.
 if(row.kind==='RECORD'&&row.status==='SCANNED'){
  await reservation(c,ctx,row);await c.query(`UPDATE ${relation} SET status='CANCELLED',problem=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
  await require('../transfers/postgres-transfer-service').cancelInTransaction(c,ctx,row.transfer_id,{idempotencyKey:'bin-correction:'+id+':cancel',reason:'Owner declined the records correction.'});
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Bin correction declined',reference:id});return {id};
 }
 if(row.status!=='OPEN')throw new ValidationError('A physically confirmed correction must be reviewed and settled before its stock reservation can be released.');
 await reservation(c,ctx,row);await c.query("SELECT set_config('stockchief.bin_correction_id',$1,true)",[row.id]);
 await require('../transfers/postgres-transfer-service').cancelInTransaction(c,{...ctx,binCorrectionId:id},row.transfer_id,{idempotencyKey:'bin-correction:'+id+':cancel',reason:'Owner confirmed no physical bin movement occurred.'});
 await c.query(`UPDATE ${relation} SET status='CANCELLED',problem=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Unmoved bin correction cancelled',reference:id});return {id};
},{isolation:'SERIALIZABLE',retrySafe:true});}
// Moves the records back with a reverse bin transfer. Only records
// corrections can be undone this way; goods that staff carried need a new move.
async function undo(db,ctx,id,input){return db.transaction(async c=>{
 await actor(c,ctx,{owner:true});const row=await get(c,ctx,id,{lock:true});
 if(row.status==='UNDONE')return {id,replayed:true,transferId:row.undo_transfer_id};
 if(row.kind!=='RECORD'||row.status!=='COMPLETED')throw new ValidationError('Only a completed records correction can be undone. Goods staff moved need a new bin correction.');
 if(input.confirmed!=='yes')throw new ValidationError('Confirm you want the stock records moved back.');
 const back=await facts(c,ctx,{...row.source,from:row.source.to,to:row.source.from}),transfers=require('../transfers/postgres-transfer-service'),base='bin-correction:'+id+':undo';
 const transfer=await transfers.requestInTransaction(c,ctx,{fromLocationId:back.from.id,toLocationId:back.to.id,reference:id,reason:'Undo bin correction',notes:'Moves the records back to where they were before the correction.',idempotencyKey:base+':reserve',skipDefaultDemandPegs:true,lines:[line(back)]});
 await transfers.approveInTransaction(c,ctx,transfer.id,{idempotencyKey:base+':approve'});await transfers.pickInTransaction(c,ctx,transfer.id,{idempotencyKey:base+':pick'});await transfers.dispatchInTransaction(c,ctx,transfer.id,{idempotencyKey:base+':dispatch'});
 await transfers.receiveInTransaction(c,ctx,transfer.id,{idempotencyKey:base+':receive',lines:[{lineId:transfer.lines[0].id,received:back.quantity,lost:0,damaged:0,...(back.serials?{receivedSerialUnitIds:back.serials.map(s=>s.id)}:{})}]});
 const proof=await transfers.verify(c,ctx.workspaceId,transfer.id);if(!proof.ok||proof.transfer.status!=='RECEIVED')throw new ValidationError('The reverse bin transfer did not reconcile its stock and cost.');
 await c.query(`UPDATE ${relation} SET status='UNDONE',undo_transfer_id=$3,undone_by=$4,undone_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,transfer.id,ctx.actorId]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Bin correction undone',reference:id,after:{sku:back.sku,quantity:back.quantity,from:back.from.name,to:back.to.name}});
 return {id,transferId:transfer.id};
},{isolation:'SERIALIZABLE',retrySafe:true});}
// A records correction from evidence that the stock sits in another bin than
// recorded. It reserves the recorded units, then completes on its own when
// the owner's routine authority covers it, or waits for the owner.
async function recordCorrection(c,ctx,{key,request,evidence,proof,reporter,account}){
 const p=await facts(c,ctx,{...request,kind:'RECORD',reason:'mis-scan'},{allowReserved:true}),id=newId('bincorrect');
 let transfer=null,problem=null;
 if(!P.can(reporter,P.REQUEST_TRANSFER))problem='The owner must approve this correction.';
 else if(await free(c,ctx,p)<p.quantity)problem='Some of this stock is reserved for orders or on hold. A person must review it before the records move.';
 else transfer=await reserve(c,ctx,id,p);
 await c.query(`INSERT INTO ${relation}(id,workspace_id,request_key,transfer_id,source,fingerprint,opened_by,kind,evidence,status,scanned_by,scan_proof,scanned_at,scanned_plan,problem)
  VALUES($1,$2,$3,$4,$5,$6,$7,'RECORD',$8,$9,$7,$10,now(),$11,$12)`,[id,ctx.workspaceId,key,transfer?.id||null,JSON.stringify(p),hash(p),ctx.actorId,evidence,transfer?'SCANNED':'PROPOSED',{...proof,confirmed:true},account.plan,problem]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Stock found in another bin than recorded',reference:id,after:{sku:p.sku,quantity:p.quantity,recordedIn:p.from.name,foundIn:p.to.name,evidence:evidence.source}});
 if(!transfer)return {id,needsApproval:true,reason:problem};
 const row=(await c.query(`SELECT * FROM ${relation} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,id])).rows[0];
 try{await automaticAuthority(c,ctx,row);}catch(error){if(!held.includes(error.status))throw error;await c.query(`UPDATE ${relation} SET problem=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,error.message]);return {id,needsApproval:true,reason:error.message};}
 if(!canMove(reporter)){await c.query(`UPDATE ${relation} SET problem=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,'The owner must approve this correction.']);return {id,needsApproval:true,reason:'The owner must approve this correction.'};}
 return finish(c,ctx,row,{automatic:true});
}
// Staff scan the product in the bin where they found it and count both that
// bin and the bin the records name. Only an exact mix-up (one bin short by
// what the other has extra) becomes a correction; anything else is a count.
async function report(db,ctx,input){return db.transaction(async c=>{
 const reporter=await actor(c,ctx);physicalPermissions(reporter);const account=await allowed(c,ctx);
 const key=String(input.requestKey||'');if(!/^[\w-]{8,160}$/.test(key))throw new ValidationError('Open a fresh form before reporting stock.');
 const prior=(await c.query(`SELECT id FROM ${relation} WHERE workspace_id=$1 AND request_key=$2`,[ctx.workspaceId,key])).rows[0];if(prior)return {id:prior.id,replayed:true};
 const resolve=require('../operations/postgres-fulfillment-waves').resolveIdentity;
 const skuId=await resolve(c,ctx.workspaceId,input.productCode,'sku',{label:'Product code'}),foundIn=await resolve(c,ctx.workspaceId,input.foundCode,'location',{label:'Bin where you found it'}),recordedIn=await resolve(c,ctx.workspaceId,input.recordedCode,'location',{label:'Bin the records show'});
 await require('../operations/postgres-warehouse-access').assertLocations(c,ctx,[foundIn,recordedIn]);
 const names=new Map((await c.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,[foundIn,recordedIn]])).rows.map(r=>[r.id,r.name]));
 const tracking=(await c.query('SELECT i.tracking_mode FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=$2',[ctx.workspaceId,skuId])).rows[0]?.tracking_mode;
 const serials=String(input.serials||'').split(/[\r\n,]+/).map(v=>v.trim()).filter(Boolean);
 let quantity,counts;
 if(tracking==='serial'){if(!serials.length)throw new ValidationError('Scan each serial number you found.');quantity=serials.length;counts={serials};}
 else{
  const lotId=tracking==='lot'?await resolve(c,ctx.workspaceId,input.lotCode,'lot',{skuId,label:'Batch code'}):null;
  const recorded=async loc=>Number((await c.query(lotId?'SELECT lb.quantity q FROM lot_balances lb JOIN lots l ON l.workspace_id=lb.workspace_id AND l.id=lb.lot_id AND l.sku_id=$2 WHERE lb.workspace_id=$1 AND lb.lot_id=$4 AND lb.location_id=$3':'SELECT on_hand q FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',lotId?[ctx.workspaceId,skuId,loc,lotId]:[ctx.workspaceId,skuId,loc])).rows[0]?.q||0);
  const inFound=counted(input.foundCount,names.get(foundIn)),inRecorded=counted(input.recordedCount,names.get(recordedIn)),extra=inFound-await recorded(foundIn),missing=await recorded(recordedIn)-inRecorded;
  if(extra<=0||missing<=0)throw new ValidationError('These counts do not show stock recorded in '+names.get(recordedIn)+' and found in '+names.get(foundIn)+'. Record a stock count instead.');
  if(extra!==missing)throw new ValidationError(names.get(foundIn)+' has '+extra+' more than recorded but '+names.get(recordedIn)+' is short by '+missing+'. That is more than a bin mix-up. Count both bins again or record a stock count.');
  quantity=extra;counts={found:inFound,recorded:inRecorded,...(lotId?{lotId}:{})};
  if(lotId)input={...input,lotId};
 }
 const request={skuId,fromLocationId:recordedIn,toLocationId:foundIn,quantity,...(input.lotId?{lot:{id:input.lotId}}:{}),...(serials.length?{serials}:{})};
 return recordCorrection(c,ctx,{key,request,reporter,account,evidence:{source:'scan',counts},proof:{productCode:input.productCode,foundCode:input.foundCode,recordedCode:input.recordedCode,...counts}});
},{isolation:'SERIALIZABLE',retrySafe:true});}
// Two pending counts at bins of the same warehouse: one short, the other
// over by exactly the same units of the same product. Runs inside the count's
// own transaction; anything that cannot become a correction leaves the count
// as it is.
async function fromCount(c,ctx,reviewId){
 const account=await policy.accountState(c,ctx.workspaceId);
 if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,11,'draft')||await policy.stopped(c,ctx.workspaceId,account,action,false))return null;
 const review=(await c.query('SELECT payload FROM physical_count_reviews WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,reviewId])).rows[0];
 for(const l of review?.payload.lines||[]){
  const delta=Number(l.delta);if(!delta)continue;
  const partners=(await c.query(`SELECT r.id,r.payload->'location'->>'id' location_id FROM physical_count_reviews r WHERE r.workspace_id=$1 AND r.status='PENDING' AND r.id<>$2
   AND r.created_at>now()-interval '1 day' AND r.payload->'location'->>'id'<>$3
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.payload->'lines') x WHERE x->>'skuId'=$4 AND (x->>'delta')::numeric=$5)
   AND NOT EXISTS(SELECT 1 FROM ${relation} b WHERE b.workspace_id=r.workspace_id AND b.status IN ('PROPOSED','OPEN','SCANNED') AND b.evidence->'reviews' @> jsonb_build_array(r.id))
   ORDER BY r.created_at DESC,r.id LIMIT 5`,[ctx.workspaceId,reviewId,review.payload.location.id,l.skuId,-delta])).rows;
  for(const partner of partners){
   const [shortIn,overIn]=delta<0?[review.payload.location.id,partner.location_id]:[partner.location_id,review.payload.location.id];
   await c.query('SAVEPOINT bin_from_count');
   try{
    const reporter=(await c.query('SELECT * FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
    const made=await recordCorrection(c,ctx,{key:'count-'+reviewId+'-'+partner.id,reporter,account,request:{skuId:l.skuId,fromLocationId:shortIn,toLocationId:overIn,quantity:Math.abs(delta)},
     evidence:{source:'count',reviews:[partner.id,reviewId]},proof:{reviews:[partner.id,reviewId],quantity:Math.abs(delta)}});
    await c.query('RELEASE SAVEPOINT bin_from_count');return made;
   }catch(error){await c.query('ROLLBACK TO SAVEPOINT bin_from_count');if(!held.includes(error.status))throw error;}
  }
 }
 return null;
}
// A put-away scanned into another bin than planned: staff move the goods to
// the planned bin. Custom, or Pro with a taught scope, opens the move on its
// own; otherwise the owner sees a proposal first.
async function fromPutaway(c,ctx,{source,binId,quantity,serialIds=[],confirmationId,instructionId}){
 const account=await policy.accountState(c,ctx.workspaceId);
 if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,11,'draft')||await policy.stopped(c,ctx.workspaceId,account,action,false))return null;
 await c.query('SAVEPOINT bin_from_putaway');
 try{
  const p=await facts(c,ctx,{skuId:source.skuId,fromLocationId:binId,toLocationId:source.to.id,quantity,reason:'wrong-putaway',...(source.lot?{lot:source.lot}:{}),...(serialIds.length?{serials:serialIds}:{})},{allowReserved:true});
  const id=newId('bincorrect'),evidence={source:'putaway',instructionId,confirmationId},row={id,source:p,kind:'MOVE',evidence,transfer_id:null};
  let problem=null,transfer=null;
  try{await automaticAuthority(c,ctx,row);}catch(error){if(!held.includes(error.status))throw error;problem=error.message;}
  if(!problem&&await free(c,ctx,p)<p.quantity)problem='Some of this stock is reserved for orders or on hold. A person must review it.';
  if(!problem)transfer=await reserve(c,ctx,id,p);
  await c.query(`INSERT INTO ${relation}(id,workspace_id,request_key,transfer_id,source,fingerprint,opened_by,kind,evidence,status,problem,automatic) VALUES($1,$2,$3,$4,$5,$6,$7,'MOVE',$8,$9,$10,false)`,
   [id,ctx.workspaceId,'putaway-'+confirmationId,transfer?.id||null,JSON.stringify(p),hash(p),ctx.actorId,evidence,transfer?'OPEN':'PROPOSED',problem]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:transfer?'Move to the planned bin opened after a wrong put-away':'Move to the planned bin proposed after a wrong put-away',reference:id,after:{sku:p.sku,quantity:p.quantity,from:p.from.name,to:p.to.name}});
  await c.query('RELEASE SAVEPOINT bin_from_putaway');return {id,opened:Boolean(transfer)};
 }catch(error){await c.query('ROLLBACK TO SAVEPOINT bin_from_putaway');if(!held.includes(error.status))throw error;return null;}
}
async function configure(db,ctx,input){return db.transaction(async c=>{
 await actor(c,ctx,{owner:true});const prior=(await c.query(`SELECT * FROM ${settingsTable} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
 if(Number(input.revision||0)!==(prior?.revision||0))throw new ValidationError('Reload the current routine correction settings.');
 if(input.stop==='yes'){await c.query(`UPDATE ${settingsTable} SET enabled=false,revision=revision+1 WHERE workspace_id=$1`,[ctx.workspaceId]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Routine bin corrections stopped'});return;}
 await allowed(c,ctx);if(input.confirmed!=='yes')throw new ValidationError('Confirm routine corrections within the chosen whole-unit limit.');const limit=maximum(input.maximumUnits);
 let money=null,currency=null;
 if(String(input.maximumValue??'').trim()!==''){currency=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency;
  if(!currency)throw new ValidationError('Set up your stock currency before choosing a value limit.');money=require('../domain/currency').toMinor(input.maximumValue,currency,{label:'Maximum stock value'});if(!(money>0))throw new ValidationError('Choose a value limit above zero.');}
 await c.query(`INSERT INTO ${settingsTable}(workspace_id,maximum_units,authorized_by,maximum_value_minor,currency) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id) DO UPDATE SET maximum_units=EXCLUDED.maximum_units,authorized_by=EXCLUDED.authorized_by,maximum_value_minor=EXCLUDED.maximum_value_minor,currency=EXCLUDED.currency,enabled=true,revision=agent_bin_correction_settings.revision+1`,[ctx.workspaceId,limit,ctx.actorId,money,currency]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Routine bin corrections authorized',after:{maximumUnits:limit,...(money?{maximumValueMinor:money,currency}:{})}});
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
 const recent=owner&&!row?(await db.query(`SELECT id,source,status,kind FROM ${relation} WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 50`,[ctx.workspaceId])).rows:[];
 const learned=owner&&!row?(await db.query(`SELECT scope,maximum_units,example_id,scope_hash FROM ${rulesTable} WHERE workspace_id=$1 AND scope_hash>$2 ORDER BY scope_hash LIMIT 101`,[ctx.workspaceId,afterRule])).rows:[];
 const blocked=locked?null:await policy.stopped(db,ctx.workspaceId,account,action,false);
 const manualRecoveryAllowed=owner&&['starter','growth'].includes(account.plan)&&row?.status==='SCANNED'&&['pro','enterprise'].includes(row.scanned_plan);
 const valueLimit=settings?.maximum_value_minor!=null?require('../domain/currency').fromMinor(Number(settings.maximum_value_minor),settings.currency):'';
 return {row,settings,valueLimit,rule,recent,learned:learned.slice(0,100),nextRule:learned.length>100?learned[99].scope_hash:null,owner,locked,blocked,manualRecoveryAllowed,canScan:physical.every(p=>P.can(user,p)),shadow:account.shadow,requestKey:newId('bincorrectform')};
}
async function readPage(db,ctx,{page=1}={}){
 await actor(db,ctx,{owner:true});const rows=(await db.query(`SELECT id,source,status,problem,kind FROM ${relation} WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 101 OFFSET $2`,[ctx.workspaceId,(page-1)*100])).rows;
 return {summary:'Puts stock back in the right bin at one warehouse. When staff scan or count a product in one bin while the records show it in another, or two counts show one bin short by exactly what another has extra, the records follow the stock. When a put-away is scanned into another bin than planned, staff move the goods to the planned bin. Pro proposes each correction until you teach it; Custom corrects on its own within your unit and value limits. Reserved, picked, counted, batch and serial stock wait for a person. Records corrections can be undone.',
  rows:[{Action:'Prepare a scanned bin correction',link:'/warehouse/bin-corrections'},{Action:'Report stock found in the wrong bin',link:'/warehouse/bin-corrections/found'},...rows.slice(0,100).map(r=>({SKU:r.source.sku,Quantity:r.source.quantity,From:r.source.from.name,To:r.source.to.name,Kind:r.kind==='RECORD'?'Records follow the stock':'Staff move the goods',Status:r.status,Review:r.problem||'',link:'/warehouse/bin-corrections/'+r.id}))],more:rows.length>100};
}
module.exports={open,get,scan,approve,cancel,undo,report,fromCount,fromPutaway,configure,teach,page,scope,definition:{id:11,key:'bin-corrections',label:'Correct physically scanned stock bins',readPage}};

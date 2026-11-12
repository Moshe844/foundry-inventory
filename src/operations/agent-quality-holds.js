'use strict';
// Job 51: new supplier deliveries the owner chose wait on a QC hold until a
// person physically inspects them. A rule names a supplier, a product or both,
// at one owned receiving location or all of them. Held units are subtracted
// from available stock, batches and exact serial units included, so they
// cannot be sold, reserved, picked, moved or offered on a sales channel.
// A pass releases the goods; a failure keeps them held for a supplier return
// (job 115) or an owner-approved write-off.
const policy=require('../commercial/agent-plan'),permissions=require('../actions/permissions'),exact=require('../domain/exact-quantity'),stockQuantity=require('../domain/stock-quantity');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors'),{newId}=require('../lib/util');
const action='inventory.inspect_delivery',ACTIVE=['HELD','FAILED'];
const atoms=v=>exact.atoms(exact.canonical(v),6),text=v=>exact.canonical(v);
const businessError=e=>[400,402,403,404,422].includes(e?.status);
async function actor(c,ctx,{owner=false,locationId=null,lock=true}={}){
 const u=(await c.query(`SELECT u.* FROM users u JOIN workspaces w ON w.id=u.workspace_id
  WHERE u.workspace_id=$1 AND u.id=$2 AND w.deletion_requested_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)
   ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!u||owner&&u.role!=='owner')throw new AuthorizationError(owner?'Only the inventory owner can set delivery QC rules, decide suggested holds or write off failed goods.':'Your inventory access needs review.');
 permissions.assertCan(u,permissions.RECEIVE_PO,'inspect supplier deliveries');
 if(locationId)await require('./postgres-warehouse-access').assertLocations(c,ctx,[locationId]);
 return u;
}
// Draft access covers rules, suggested holds and manual holds (Growth and
// above). Automatic holds also need routine authority: not paused, watching,
// in the 14-day shadow period, set to Ask me first or over the rule allowance.
async function access(c,ctx,automatic=false){
 await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
 const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,51,automatic?'automatic':'draft',{trained:automatic});
 if(automatic){
  const stopped=await policy.stopped(c,ctx.workspaceId,account,action,true);
  if(stopped)throw new ValidationError(stopped);
  if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('The owner must authorize routine work before StockChief holds deliveries on its own.');
 }
 return account;
}
async function getPolicy(c,ctx,id,lock=false){
 const p=(await c.query('SELECT * FROM stockchief_runtime.agent_quality_policies WHERE workspace_id=$1 AND id=$2'+(lock==='share'?' FOR SHARE':lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
 if(!p)throw new NotFoundError('That delivery inspection rule is not in this inventory.');return p;
}
async function facts(c,ctx,p){
 if(p.location_id)await require('./postgres-warehouse-access').assertLocations(c,ctx,[p.location_id]);
 const row=(await c.query(`SELECT (SELECT name FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active') supplier_name,
  (SELECT s.code FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=$3 AND s.is_active=1 AND i.is_active=1) code,
  (SELECT name FROM locations WHERE workspace_id=$1 AND id=$4 AND is_active=1 AND custody_agreement_id IS NULL) location_name`,
 [ctx.workspaceId,p.supplier_id,p.sku_id,p.location_id])).rows[0];
 if(p.supplier_id&&!row.supplier_name||p.sku_id&&!row.code||p.location_id&&!row.location_name)throw new ValidationError('QC rules cover active suppliers and products at owned receiving locations. Review this rule’s supplier, product and location.');
 return row;
}
async function audit(c,ctx,message,id,detail){await require('./postgres-security-audit').record(c,ctx,{action:message,reference:id,after:detail});}
function checklistOf(input){
 const checklist=(Array.isArray(input.checklist)?input.checklist:String(input.checklist||'').split(/\r?\n/)).map(v=>String(v).trim()).filter(Boolean);
 const max=String(input.maxUnits||'');
 if(!checklist.length||checklist.length>10||checklist.some(v=>v.length>200)||new Set(checklist).size!==checklist.length||!/^\d{1,6}$/.test(max)||Number(max)<1||Number(max)>100000)throw new ValidationError('Review one to ten distinct physical checks and a unit limit from one to 100,000.');
 return {checklist,maxUnits:Number(max)};
}
async function resolve(c,ctx,input){
 const out={};
 for(const [key,name,table,column,label] of [['supplierId','supplierName','suppliers','name','supplier'],['skuId','skuCode','skus','code','SKU code'],['locationId','locationName','locations','name','receiving location']]){
  if(input[key]){out[key]=String(input[key]);continue;}
  const value=String(input[name]||'').trim();if(!value){out[key]=null;continue;}
  if(value.length>240)throw new ValidationError('Enter the exact supplier name, SKU code or receiving location.');
  const rows=(await c.query(`SELECT id FROM ${table} WHERE workspace_id=$1 AND lower(${column})=lower($2) LIMIT 2`,[ctx.workspaceId,value])).rows;
  if(rows.length!==1)throw new ValidationError('Match the '+label+' to exactly one record in this inventory.');out[key]=rows[0].id;
 }
 if(!out.supplierId&&!out.skuId)throw new ValidationError('Choose a supplier, a product or both. A rule cannot cover every delivery.');
 return {supplier_id:out.supplierId,sku_id:out.skuId,location_id:out.locationId};
}
// Growth is taught by this saved owner rule or by a completed manual example;
// Pro and Custom hold under the owner's rule without training.
async function teach(c,ctx){await policy.requireWorkspaceJob(c,ctx.workspaceId,51,'automatic',{trained:true});}
async function save(db,ctx,input){return db.transaction(async c=>{
 await actor(c,ctx,{owner:true});await access(c,ctx);
 if(input.confirmed!=='yes')throw new ValidationError('Confirm this exact supplier or product scope, checklist and unit limit.');
 const {checklist,maxUnits}=checklistOf(input),automatic=input.mode==='automatic';
 const prior=input.id?await getPolicy(c,ctx,input.id,true):null;
 if(prior&&Number(input.revision)!==prior.revision)throw new ValidationError('Reload this QC rule. Its supplier, product and location stay fixed; use a separate rule for another scope.');
 const p=prior||await resolve(c,ctx,input);await facts(c,ctx,p);
 if(automatic)await teach(c,ctx);
 await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
 if(prior){
  await c.query(`UPDATE stockchief_runtime.agent_quality_policies SET checklist=$3,max_units=$4,enabled=true,automatic_enabled=$6,
   trained_hold_id=NULL,authorized_by=$5,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,prior.id,JSON.stringify(checklist),maxUnits,ctx.actorId,automatic]);
  await audit(c,ctx,'Delivery QC rule revised',prior.id,{checklist,maxUnits,automatic,existingHoldsUnchanged:true});return {id:prior.id};
 }
 const id=newId('quality-rule');
 const inserted=await c.query(`INSERT INTO stockchief_runtime.agent_quality_policies(id,workspace_id,supplier_id,sku_id,location_id,checklist,max_units,authorized_by,automatic_enabled)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,[id,ctx.workspaceId,p.supplier_id,p.sku_id,p.location_id,JSON.stringify(checklist),maxUnits,ctx.actorId,automatic]);
 if(!inserted.rowCount)throw new ValidationError('This supplier, product and location already have a QC rule. Open the existing rule.');
 await audit(c,ctx,'Delivery QC rule recorded',id,{...p,checklist,maxUnits,automatic});return {id};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function configure(db,ctx,id,input){return db.transaction(async c=>{
 await actor(c,ctx,{owner:true});const p=await getPolicy(c,ctx,id,true);
 if(Number(input.revision)!==p.revision)throw new ValidationError('Reload the current QC rule before changing it.');
 if(input.stop==='yes'){
  await c.query('UPDATE stockchief_runtime.agent_quality_policies SET enabled=false,automatic_enabled=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);
  await audit(c,ctx,'QC rule stopped for future deliveries',id,{existingGoodsRemainHeld:true});return;
 }
 await access(c,ctx);
 if(input.mode==='ask'){
  await c.query('UPDATE stockchief_runtime.agent_quality_policies SET enabled=true,automatic_enabled=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);
  await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],p.enabled?0:1);
  await audit(c,ctx,'QC rule set to suggest each hold',id,{});return;
 }
 if(input.confirmed!=='yes')throw new ValidationError('Confirm this exact inspection checklist and unit limit.');
 await facts(c,ctx,p);
 let example=null;
 if(input.exampleId){
  example=(await c.query(`SELECT * FROM stockchief_runtime.agent_quality_holds WHERE workspace_id=$1 AND id=$2 AND policy_id=$3
   AND checklist=$4::jsonb AND status='PASSED' AND NOT automatic`,[ctx.workspaceId,input.exampleId,id,JSON.stringify(p.checklist)])).rows[0];
  if(!example)throw new ValidationError('Choose a completed delivery of this rule that a person held, inspected and released.');
 }
 await teach(c,ctx);
 await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],p.enabled?0:1);
 await c.query(`UPDATE stockchief_runtime.agent_quality_policies SET enabled=true,automatic_enabled=true,authorized_by=$3,
  trained_hold_id=$4,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId,example?.id||null]);
 await audit(c,ctx,'Routine delivery QC authorized',id,{maxUnits:p.max_units,checklist:p.checklist,trainedHoldId:example?.id||null});
},{isolation:'SERIALIZABLE',retrySafe:true});}
// Throws a plain reason whenever StockChief may not hold this delivery alone.
async function automatic(c,workspaceId,p,quantity,receiptChecks=new Map()){
 if(!p.enabled||!p.automatic_enabled)throw new ValidationError('This rule suggests each hold until you teach it to hold on its own.');
 if(atoms(quantity)>atoms(p.max_units))throw new ValidationError('This delivery is over the rule’s '+p.max_units+'-unit limit, so it needs your decision.');
 const key='policy:'+p.id;
 if(!receiptChecks.has(key))receiptChecks.set(key,(async()=>{
  const ctx={workspaceId,actorId:p.authorized_by},ownerKey='owner:'+p.authorized_by;
  if(!receiptChecks.has(ownerKey))receiptChecks.set(ownerKey,actor(c,ctx,{owner:true}));await receiptChecks.get(ownerKey);await facts(c,ctx,p);
  const accessKey='access:'+p.authorized_by;
  if(!receiptChecks.has(accessKey))receiptChecks.set(accessKey,access(c,ctx,true));
  await receiptChecks.get(accessKey);return ctx;
 })());
 return receiptChecks.get(key);
}
// Every receipt line covered by an enabled rule records a decision inside the
// receipt transaction: held on its own, held by the receiving person,
// suggested to the owner, or not held because the plan excludes QC.
async function applyReceipt(c,ctx,receiptId,input={}){
 const candidates=(await c.query(`SELECT DISTINCT ON(l.id) l.id receipt_line_id,p.id policy_id
  FROM purchase_order_receipt_lines l JOIN purchase_order_receipts r ON r.workspace_id=l.workspace_id AND r.id=l.receipt_id
  JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id
  JOIN stockchief_runtime.agent_quality_policies p ON p.workspace_id=l.workspace_id AND p.enabled
   AND (p.supplier_id IS NULL OR p.supplier_id=o.supplier_id) AND (p.sku_id IS NULL OR p.sku_id=l.sku_id) AND (p.location_id IS NULL OR p.location_id=l.location_id)
  WHERE l.workspace_id=$1 AND l.receipt_id=$2 AND l.location_id IS NOT NULL
  ORDER BY l.id,(p.sku_id IS NOT NULL) DESC,(p.supplier_id IS NOT NULL) DESC,(p.location_id IS NOT NULL) DESC,p.created_at,p.id`,[ctx.workspaceId,receiptId])).rows;
 const result={held:[],suggested:[],notHeld:[]};if(!candidates.length)return result;
 const policyIds=[...new Set(candidates.map(r=>r.policy_id))].sort();
 const policies=new Map((await c.query('SELECT * FROM stockchief_runtime.agent_quality_policies WHERE workspace_id=$1 AND id=ANY($2::text[]) AND enabled ORDER BY id FOR SHARE',[ctx.workspaceId,policyIds])).rows.map(p=>[p.id,p]));
 if(policies.size!==policyIds.length)throw new ValidationError('A QC rule changed while this delivery was being received. Try again.');
 const lines=(await c.query(`SELECT l.id,l.purchase_order_line_id,l.sku_id,s.code,l.location_id,l.quantity_units::text quantity,l.lot_id,l.movement_ids,
   s.is_active=1 AND i.is_active=1 AND loc.is_active=1 AND loc.custody_agreement_id IS NULL supported,i.tracking_mode,
   coalesce((SELECT array_agg(m.serial_unit_id ORDER BY m.serial_unit_id) FROM stockchief_runtime.inventory_movement_serial_units m
    WHERE m.workspace_id=l.workspace_id AND m.movement_id IN(SELECT jsonb_array_elements_text(l.movement_ids::jsonb))),'{}') serial_unit_ids
  FROM purchase_order_receipt_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  JOIN locations loc ON loc.workspace_id=l.workspace_id AND loc.id=l.location_id
  WHERE l.workspace_id=$1 AND l.id=ANY($2::text[]) ORDER BY l.id`,[ctx.workspaceId,candidates.map(r=>r.receipt_line_id)])).rows;
 const chosen=new Map(candidates.map(r=>[r.receipt_line_id,policies.get(r.policy_id)])),totals=new Map();
 for(const l of lines){const k=chosen.get(l.id).id+':'+l.sku_id;totals.set(k,exact.add(totals.get(k)||'0',l.quantity));}
 let planLock=null;
 try{await access(c,ctx);}catch(error){if(!businessError(error))throw error;planLock='Delivery QC needs Growth or above, so these goods were not held. '+error.message;}
 const receiptChecks=new Map();let receiver=null;
 for(const l of lines){
  const p=chosen.get(l.id);
  if(input.damagedLineIds?.includes(l.purchase_order_line_id)&&!planLock)throw new ValidationError('This product requires QC. Record it under its inspection hold and mark the physical inspection failed. The owner can then write off the failed goods.');
  let status='HELD',auto=false,reason=null;
  if(planLock){status='NOT_HELD';reason=planLock;}
  else if(!l.supported){status='PROPOSED';reason='This product or receiving location is no longer active and owned, so StockChief stopped. Review this delivery.';}
  else try{await automatic(c,ctx.workspaceId,p,totals.get(p.id+':'+l.sku_id),receiptChecks);auto=true;}catch(error){
   if(!businessError(error))throw error;
   // Job 198: in the first 14 days only the watching stopped this hold; record it for the report.
   if(error.message===policy.SHADOW_REASON)await require('../autopilot/shadow-mode').record(c,ctx.workspaceId,{job:51,kind:'hold',key:'qc-hold:'+l.id,
    summary:'Hold '+text(l.quantity)+' of '+l.code+' from this delivery until it passes inspection',skuId:l.sku_id,locationId:l.location_id,quantity:text(l.quantity),
    evidence:{receiptId,rule:p.id,checks:p.checklist}});
   if(input.qcConfirmed==='yes'){receiver=receiver||await actor(c,ctx);await require('./postgres-warehouse-access').assertLocations(c,ctx,[l.location_id]);}
   else{status='PROPOSED';reason=error.message;}
  }
  const id=newId('quality-hold');await c.query(`INSERT INTO stockchief_runtime.agent_quality_holds
   (id,workspace_id,policy_id,receipt_line_id,sku_id,location_id,quantity,policy_revision,checklist,created_by,automatic,status,proposal_reason,lot_id,serial_unit_ids)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[id,ctx.workspaceId,p.id,l.id,l.sku_id,l.location_id,l.quantity,p.revision,JSON.stringify(p.checklist),ctx.actorId,auto,status,reason,l.lot_id,l.tracking_mode==='serial'?l.serial_unit_ids:[]]);
  ({HELD:result.held,PROPOSED:result.suggested,NOT_HELD:result.notHeld})[status].push(id);
  await audit(c,ctx,status==='HELD'?'Received goods held for physical QC':status==='PROPOSED'?'QC hold suggested for received goods':'Received goods not held: QC is not on this plan',id,{receiptId,quantity:text(l.quantity),automatic:auto,reason});
 }
 return result;
}
async function hold(c,ctx,id,lock=false){
 const h=(await c.query('SELECT * FROM stockchief_runtime.agent_quality_holds WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
 if(!h)throw new NotFoundError('That delivery inspection is not in this inventory.');return h;
}
const remainingOf=h=>exact.subtract(h.quantity,exact.add(h.returned_quantity,h.written_off_quantity));
async function openReturn(c,ctx,h){
 return (await c.query(`SELECT 1 FROM stockchief_runtime.agent_supplier_return_lines s JOIN stockchief_runtime.agent_supplier_return_cases a ON a.workspace_id=s.workspace_id AND a.id=s.case_id
  WHERE s.workspace_id=$1 AND s.receipt_line_id=$2 AND (s.hold_active OR a.cancelled_at IS NULL) LIMIT 1`,[ctx.workspaceId,h.receipt_line_id])).rowCount>0;
}
// The owner turns a suggestion into a hold only while those exact units are
// still free here; otherwise StockChief stops and shows what changed.
async function decide(db,ctx,id,input){return db.transaction(async c=>{
 const h=await hold(c,ctx,id,true);await actor(c,ctx,{owner:true,locationId:h.location_id});
 if(h.status!=='PROPOSED')return {id,replayed:true,status:h.status};
 if(Number(input.revision)!==h.revision||!['hold','skip'].includes(input.decision))throw new ValidationError('Reload this suggested QC hold and choose whether to hold the goods.');
 if(input.decision==='skip'){
  await c.query(`UPDATE stockchief_runtime.agent_quality_holds SET status='NOT_HELD',proposal_reason='The owner chose not to hold these goods.',decided_by=$3,decided_at=clock_timestamp(),revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId]);
  await audit(c,ctx,'Suggested QC hold declined by owner',id,{quantity:text(h.quantity)});return {id,status:'NOT_HELD'};
 }
 await access(c,ctx);
 const position=(await c.query(`SELECT s.is_active=1 AND i.is_active=1 AND l.is_active=1 AND l.custody_agreement_id IS NULL supported FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  JOIN locations l ON l.workspace_id=s.workspace_id AND l.id=$3 WHERE s.workspace_id=$1 AND s.id=$2`,[ctx.workspaceId,h.sku_id,h.location_id])).rows[0];
 if(!position?.supported)throw new ValidationError('This product or location is no longer active and owned. Choose not to hold it, then review the stock.');
 await c.query('SELECT 1 FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE',[ctx.workspaceId,h.sku_id,h.location_id]);
 const free=await require('../domain/postgres-stock-availability').read(c,ctx.workspaceId,h.sku_id,h.location_id,h.lot_id?{lotId:h.lot_id}:{}),available=Math.max(0,Number(free.available||0));
 let short=atoms(available)<atoms(h.quantity);
 if(!short&&h.serial_unit_ids.length)short=(await c.query(`SELECT count(*)::int n FROM serial_units WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 AND status='in_stock' AND id=ANY($4::text[])`,
  [ctx.workspaceId,h.sku_id,h.location_id,h.serial_unit_ids])).rows[0].n!==h.serial_unit_ids.length;
 if(short)throw new ValidationError('Only '+text(available)+' of these '+text(h.quantity)+' units are still free here, so nothing was held. Check where the goods went, or choose not to hold them.');
 await c.query(`UPDATE stockchief_runtime.agent_quality_holds SET status='HELD',decided_by=$3,decided_at=clock_timestamp(),revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId]);
 await audit(c,ctx,'Suggested QC hold approved by owner',id,{quantity:text(h.quantity)});return {id,status:'HELD'};
},{isolation:'SERIALIZABLE',retrySafe:true});}
// The person who physically inspects records the result. A pass releases the
// goods at once: by that person, or on Pro and Custom by the owner's routine
// rule when it may act alone. A failure keeps every remaining unit held.
async function inspect(db,ctx,id,input){return db.transaction(async c=>{
 const h=await hold(c,ctx,id,true);await actor(c,ctx,{locationId:h.location_id});
 if(h.status==='PASSED')return {id,replayed:true,released:true};
 if(!ACTIVE.includes(h.status))throw new ValidationError('These goods are not on QC hold. Approve the suggested hold first.');
 const remaining=remainingOf(h);
 if(atoms(remaining)<=0)throw new ValidationError('Every unit of this delivery has already been returned or written off.');
 if((await c.query('SELECT 1 FROM stockchief_runtime.agent_supplier_return_lines WHERE workspace_id=$1 AND receipt_line_id=$2 AND hold_active LIMIT 1',[ctx.workspaceId,h.receipt_line_id])).rowCount)throw new ValidationError('Finish or cancel the recorded supplier return before inspecting the remaining goods.');
 if(Number(input.revision)!==h.revision||input.physicallyChecked!=='yes'||!['PASS','FAIL'].includes(input.decision))throw new ValidationError('Reload this inspection and confirm the checks were physically performed on these goods.');
 const checks=Array.isArray(input.checks)?input.checks:[input.checks].filter(Boolean);
 if(input.decision==='PASS'&&(checks.length!==h.checklist.length||h.checklist.some((_,i)=>!checks.includes(String(i)))))throw new ValidationError('Confirm every recorded physical check before marking this delivery as passed.');
 const note=String(input.note||'').trim();if(note.length>1000||input.decision==='FAIL'&&!note)throw new ValidationError('Describe a failed inspection in up to 1,000 characters.');
 const damagedText=String(input.damagedQuantity??'').trim();let damagedQuantity=null;
 if(damagedText!==''){
  if(input.decision!=='FAIL')throw new ValidationError('Enter a damaged count only for a failed physical inspection.');
  const item=await stockQuantity.forSku(c,ctx,h.sku_id);
  damagedQuantity=stockQuantity.validate(item,damagedText,{label:'Damaged quantity'});
  if(atoms(damagedQuantity)>atoms(remaining))throw new ValidationError('Enter the actual damaged count within this held delivery.');
 }
 let byRule=false,reason=null,p=null;
 if(input.decision==='PASS')try{
  p=await getPolicy(c,ctx,h.policy_id,'share');const state=await policy.accountState(c,ctx.workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,51,'automatic'))throw new ValidationError('Released by the person who inspected the goods.');
  if(h.policy_revision!==p.revision)throw new ValidationError('The QC rule changed after these goods were held, so the inspector released them.');
  await automatic(c,ctx.workspaceId,p,remaining);byRule=true;
 }catch(error){if(!businessError(error))throw error;reason=error.message;}
 const pass=input.decision==='PASS',releaser=pass?(byRule?p.authorized_by:ctx.actorId):null,prior={...(Number(h.returned_quantity)?{returnedBeforeInspection:Number(h.returned_quantity)}:{}),...(Number(h.written_off_quantity)?{writtenOffBeforeInspection:Number(h.written_off_quantity)}:{})};
 await c.query(`UPDATE stockchief_runtime.agent_quality_holds SET status=$3,inspection=$4,inspected_by=$5,inspected_at=clock_timestamp(),
  released_by=$6,released_at=CASE WHEN $6::text IS NOT NULL THEN clock_timestamp() END,released_by_rule=$7,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,
 [ctx.workspaceId,id,pass?'PASSED':'FAILED',JSON.stringify({decision:input.decision,checks,note,damagedQuantity,...prior,releaseReason:pass?reason:null}),ctx.actorId,releaser,byRule]);
 await audit(c,ctx,pass?(byRule?'Passed delivery released by the owner’s QC rule':'Passed delivery released by the inspector'):'Physical delivery inspection failed; goods stay held',id,{decision:input.decision,released:pass,byRule,quantity:text(remaining),damagedQuantity});
 return {id,released:pass,byRule,reason};
},{isolation:'SERIALIZABLE',retrySafe:true});}
// Holds recorded before this release could carry a passed inspection that
// still waits for a person to release it.
async function release(db,ctx,id,input){return db.transaction(async c=>{
 const h=await hold(c,ctx,id,true);const u=await actor(c,ctx,{locationId:h.location_id});
 if(h.status==='PASSED')return {id,replayed:true};
 if(u.role!=='owner'&&h.inspected_by!==ctx.actorId)throw new AuthorizationError('Only the person who inspected these goods or the inventory owner can release them.');
 if(Number(input.revision)!==h.revision||input.confirmed!=='yes'||h.status!=='HELD'||h.inspection?.decision!=='PASS')throw new ValidationError('Review this exact passed physical inspection before releasing the held units. Failed or uninspected goods stay held.');
 await c.query("UPDATE stockchief_runtime.agent_quality_holds SET status='PASSED',released_by=$3,released_at=clock_timestamp(),revision=revision+1 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,ctx.actorId]);
 await audit(c,ctx,'Inspected delivery released by a person',id,{quantity:text(remainingOf(h))});return {id};
},{isolation:'SERIALIZABLE',retrySafe:true});}
// Writing off stock always needs a person: the owner approves each exact
// removal of failed goods, which posts through the damaged-stock path.
async function writeOff(db,ctx,id,input){return db.transaction(async c=>{
 const requestKey=String(input.requestKey||'').trim();if(!requestKey||requestKey.length>200)throw new ValidationError('Reload this failed inspection before writing off goods.');
 const prior=(await c.query('SELECT * FROM stockchief_runtime.agent_quality_writeoffs WHERE workspace_id=$1 AND request_key=$2',[ctx.workspaceId,requestKey])).rows[0];
 if(prior){if(prior.hold_id!==id)throw new ValidationError('This write-off request belongs to another delivery.');return {id:prior.id,movementId:prior.movement_id,valueMinor:Number(prior.value_minor),replayed:true};}
 const h=await hold(c,ctx,id,true);await actor(c,ctx,{owner:true,locationId:h.location_id});
 if(h.status!=='FAILED')throw new ValidationError('Only goods that failed their physical inspection can be written off here.');
 if(input.confirmed!=='yes')throw new ValidationError('Confirm this exact write-off. It removes these goods and their value from stock.');
 const note=String(input.note||'').trim();if(!note||note.length>1000)throw new ValidationError('Say why these goods are being written off, in up to 1,000 characters.');
 if(Number(h.returned_quantity)>0||await openReturn(c,ctx,h))throw new ValidationError('These failed goods are on a supplier return. Finish or cancel that return instead.');
 const item=await stockQuantity.forSku(c,ctx,h.sku_id),remaining=remainingOf(h);
 const quantity=stockQuantity.validate(item,input.quantity,{label:'Write-off quantity'});
 if(atoms(quantity)>atoms(remaining))throw new ValidationError('Write off at most the '+text(remaining)+' units still held from this delivery.');
 let serials=[];
 if(item.tracking_mode==='serial'){
  serials=[...new Set((Array.isArray(input.serialUnitIds)?input.serialUnitIds:[input.serialUnitIds]).filter(Boolean).map(String))];
  if(serials.length!==quantity||serials.some(s=>!h.serial_unit_ids.includes(s)))throw new ValidationError('Choose the exact held serial numbers being written off, one for each unit.');
 }
 const secondaryQuantity=stockQuantity.secondary(item,input.secondaryQuantity);
 const changed=await c.query(`UPDATE stockchief_runtime.agent_quality_holds SET written_off_quantity=written_off_quantity+$3::numeric,
  serial_unit_ids=ARRAY(SELECT x FROM unnest(serial_unit_ids) x WHERE NOT x=ANY($4::text[]) ORDER BY x),revision=revision+1
  WHERE workspace_id=$1 AND id=$2 AND status='FAILED' AND quantity-returned_quantity-written_off_quantity>=$3::numeric`,[ctx.workspaceId,id,text(quantity),serials]);
 if(!changed.rowCount)throw new ValidationError('These held goods changed. Reload the inspection.');
 const reference=(await c.query(`SELECT o.po_number FROM purchase_order_receipt_lines l JOIN purchase_order_receipts r ON r.workspace_id=l.workspace_id AND r.id=l.receipt_id
  JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id WHERE l.workspace_id=$1 AND l.id=$2`,[ctx.workspaceId,h.receipt_line_id])).rows[0]?.po_number||null;
 const writeoffId=newId('quality-writeoff');
 const removed=await require('../accounting/postgres-stock-removal').issueInTransaction(c,ctx,{skuId:h.sku_id,locationId:h.location_id,quantity,
  ...(h.lot_id?{lotId:h.lot_id}:{}),...(serials.length?{serialUnitIds:serials}:{}),...(secondaryQuantity===null?{}:{secondaryQuantity}),
  reasonCode:'damaged',notes:'Failed delivery QC: '+note,reference,idempotencyKey:'quality-writeoff:'+writeoffId});
 await c.query(`INSERT INTO stockchief_runtime.agent_quality_writeoffs(id,workspace_id,hold_id,request_key,quantity,secondary_quantity,serial_unit_ids,movement_id,journal_entry_id,value_minor,note,approved_by)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[writeoffId,ctx.workspaceId,id,requestKey,text(quantity),secondaryQuantity,serials,removed.movementId,removed.journalEntryId,removed.costRemovedMinor||0,note,ctx.actorId]);
 await audit(c,ctx,'Failed QC goods written off by owner',id,{writeoffId,quantity:text(quantity),secondaryQuantity,serialUnitIds:serials,valueMinor:removed.costRemovedMinor||0,movementId:removed.movementId});
 return {id:writeoffId,movementId:removed.movementId,valueMinor:removed.costRemovedMinor||0,journalEntryId:removed.journalEntryId};
},{isolation:'SERIALIZABLE',retrySafe:true});}
const STATUS={PROPOSED:'Suggested hold — waiting for your decision; goods are still available',NOT_HELD:'Not held',HELD:'Held — unavailable until a person inspects it',FAILED:'Inspection failed — goods stay held',PASSED:'Inspection passed — released'};
function present(h){
 const remaining=remainingOf(h);
 return {...h,quantity:text(h.quantity),returned_quantity:text(h.returned_quantity),written_off_quantity:text(h.written_off_quantity),remaining:text(remaining),statusText:STATUS[h.status]};
}
function scopeLabel(p){return [p.supplier_name||'Any supplier',p.code||'any product',p.location_name||'any owned location'].join(' · ');}
const HOLD_SELECT=`SELECT h.*,s.code,i.name,i.unit_label,i.tracking_mode,i.quantity_precision,i.quantity_increment,i.secondary_unit_label,i.secondary_precision,i.secondary_increment,
  l.name location_name,v.name supplier_name,o.po_number,rl.lot_code FROM stockchief_runtime.agent_quality_holds h
  JOIN skus s ON s.workspace_id=h.workspace_id AND s.id=h.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  JOIN locations l ON l.workspace_id=h.workspace_id AND l.id=h.location_id
  JOIN purchase_order_receipt_lines rl ON rl.id=h.receipt_line_id AND rl.workspace_id=h.workspace_id JOIN purchase_order_receipts r ON r.id=rl.receipt_id AND r.workspace_id=rl.workspace_id
  JOIN purchase_orders o ON o.id=r.purchase_order_id AND o.workspace_id=r.workspace_id JOIN suppliers v ON v.workspace_id=o.workspace_id AND v.id=o.supplier_id`;
async function page(db,ctx,input={}){
 const user=await actor(db,ctx,{lock:false}),state=await policy.accountState(db,ctx.workspaceId),locked=!policy.usesAgentTerms(state)||!policy.permits(state.plan,51,'draft');
 const n=Number(input.page||1);if(!Number.isSafeInteger(n)||n<1||n>1000000)throw new ValidationError('Choose a valid inspection page.');
 const roots=await require('./postgres-warehouse-access').scope(db,ctx);
 const scope=roots===null?null:(await require('./postgres-warehouse-access').locations(db,ctx.workspaceId,roots)).map(l=>l.id);
 const rows=(await db.query(`${HOLD_SELECT} WHERE h.workspace_id=$1 AND ($2::text[] IS NULL OR h.location_id=ANY($2)) AND h.status<>'NOT_HELD'
  ORDER BY CASE h.status WHEN 'PROPOSED' THEN 0 WHEN 'FAILED' THEN 1 WHEN 'HELD' THEN 2 ELSE 3 END,h.created_at DESC,h.id DESC LIMIT 101 OFFSET $3`,[ctx.workspaceId,scope,(n-1)*100])).rows.map(present);
 const policies=user.role==='owner'?(await db.query(`SELECT p.*,s.code,l.name location_name,v.name supplier_name FROM stockchief_runtime.agent_quality_policies p
  LEFT JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id LEFT JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
  LEFT JOIN suppliers v ON v.workspace_id=p.workspace_id AND v.id=p.supplier_id WHERE p.workspace_id=$1 ORDER BY p.created_at DESC,p.id DESC LIMIT 101 OFFSET $2`,[ctx.workspaceId,(n-1)*100])).rows.map(p=>({...p,scope:scopeLabel(p)})):[];
 let selected=null,serials=[],writeoffs=[],returnOpen=false;
 if(input.id){
  const h=await hold(db,ctx,input.id);await actor(db,ctx,{locationId:h.location_id,lock:false});
  selected=present((await db.query(HOLD_SELECT+' WHERE h.workspace_id=$1 AND h.id=$2',[ctx.workspaceId,h.id])).rows[0]);
  serials=(await db.query(`SELECT id,serial FROM serial_units WHERE workspace_id=$1 AND id=ANY($2::text[]) AND status='in_stock' ORDER BY serial LIMIT 500`,[ctx.workspaceId,selected.serial_unit_ids])).rows;
  writeoffs=(await db.query(`SELECT w.*,u.name approver FROM stockchief_runtime.agent_quality_writeoffs w JOIN users u ON u.id=w.approved_by WHERE w.workspace_id=$1 AND w.hold_id=$2 ORDER BY w.created_at`,[ctx.workspaceId,h.id])).rows.map(w=>({...w,quantity:text(w.quantity)}));
  returnOpen=Number(h.returned_quantity)>0||await openReturn(db,ctx,h);
 }
 let editing=null;if(input.edit){await actor(db,ctx,{owner:true,lock:false});editing=await getPolicy(db,ctx,input.edit);editing={...editing,...await facts(db,ctx,editing)};}
 const photos=selected?await require('./quality-photos').list(db,ctx,selected.id):[],claimPhotos=selected?.status==='FAILED'&&user.role==='owner'?await require('./quality-photos').photoSet(db,ctx,{holdId:selected.id}):[],canAddPhotos=policy.usesAgentTerms(state)&&policy.permits(state.plan,46,'draft'),canClaim=user.role==='owner'&&policy.usesAgentTerms(state)&&policy.permits(state.plan,45,'draft'),canReturn=user.role==='owner'&&policy.usesAgentTerms(state)&&policy.permits(state.plan,115,'draft');
 const claimMailboxes=canClaim&&selected?.status==='FAILED'?await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId):[];
 const existingClaim=selected?(await db.query('SELECT id,reference FROM stockchief_runtime.agent_supplier_claims WHERE workspace_id=$1 AND hold_id=$2',[ctx.workspaceId,selected.id])).rows[0]:null;
 const ruleRelease=policy.usesAgentTerms(state)&&policy.permits(state.plan,51,'automatic');
 return {locked,plan:state.plan,shadow:state.shadow,owner:user.role==='owner',rows:rows.slice(0,100),policies:policies.slice(0,100),more:rows.length>100||policies.length>100,page:n,selected,serials,writeoffs,returnOpen,editing,photos,claimPhotos,canAddPhotos,canClaim,canReturn,claimMailboxes,existingClaim,ruleRelease,writeoffKey:newId('qc-writeoff-request')};
}
const definition={id:51,key:'delivery-quality',label:'Hold new deliveries until they pass QC',readPage:async()=>({summary:'Choose suppliers or products whose new deliveries wait on a QC hold. Held goods cannot be sold, reserved, picked or offered on sales channels until a person passes the inspection. Growth suggests holds until you save a rule or teach it with a completed example; Pro and Custom hold under your rules. Failed goods stay held for a supplier return or your write-off.',rows:[{Action:'Open delivery QC',link:'/autopilot/delivery-quality'}],more:false})};
async function inbox(db,workspaceId,actorId){
 // Needs you counts on every page; skip this on a database migrated before the QC write-off columns.
 if(!await require('../db/schema-installed').has(db,'stockchief_runtime.agent_quality_holds','written_off_quantity'))return [];
 await actor(db,{workspaceId,actorId},{owner:true,lock:false});
 const rows=(await db.query(`SELECT h.id,trim_scale(h.quantity-h.returned_quantity-h.written_off_quantity)::text quantity,h.status,h.proposal_reason,h.created_at,s.code,l.name FROM stockchief_runtime.agent_quality_holds h
  JOIN skus s ON s.workspace_id=h.workspace_id AND s.id=h.sku_id JOIN locations l ON l.workspace_id=h.workspace_id AND l.id=h.location_id
  WHERE h.workspace_id=$1 AND (h.status='PROPOSED' OR h.status IN ('HELD','FAILED') AND h.quantity>h.returned_quantity+h.written_off_quantity)
  ORDER BY h.status='PROPOSED' DESC,h.created_at,h.id LIMIT 50`,[workspaceId])).rows;
 return rows.map(h=>h.status==='PROPOSED'?{kind:'purchasing',importance:'Needs You',priority:85,title:'Suggested QC hold: '+h.code+' · '+h.quantity+' units',happened:'A delivery matching your QC rule arrived at '+h.name+'. The goods are still available.',why:h.proposal_reason,recommendation:'Hold the goods for inspection, or choose not to hold them.',href:'/autopilot/delivery-quality/'+h.id,actionLabel:'Decide QC hold',sourceId:'delivery-quality:'+h.id,at:h.created_at,createdAt:h.created_at}:
  {kind:'purchasing',importance:'Needs You',priority:80,title:'Delivery QC: '+h.code+' · '+h.quantity+' units',happened:'Received goods remain unavailable at '+h.name+'.',why:h.status==='FAILED'?'A physical inspection failed. The goods remain held.':'A person must complete the physical checks.',recommendation:h.status==='FAILED'?'Return the goods to the supplier or write them off.':'Inspect the goods. A pass releases them.',href:'/autopilot/delivery-quality/'+h.id,actionLabel:'Review delivery QC',sourceId:'delivery-quality:'+h.id,at:h.created_at,createdAt:h.created_at});
}
module.exports={save,configure,applyReceipt,decide,inspect,release,writeOff,actor,access,hold,getPolicy,page,inbox,definition,action,remainingOf};

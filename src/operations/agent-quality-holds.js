'use strict';
const policy=require('../commercial/agent-plan'),permissions=require('../actions/permissions');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors'),{newId}=require('../lib/util');
const action='inventory.inspect_delivery';
async function actor(c,ctx,{owner=false,locationId=null,lock=true}={}){
 const u=(await c.query(`SELECT u.* FROM users u JOIN workspaces w ON w.id=u.workspace_id
  WHERE u.workspace_id=$1 AND u.id=$2 AND w.deletion_requested_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)
   ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!u||owner&&u.role!=='owner')throw new AuthorizationError(owner?'Only the inventory owner can authorize delivery inspection rules or manually release held goods.':'Your inventory access needs review.');
 permissions.assertCan(u,permissions.RECEIVE_PO,'inspect supplier deliveries');
 if(locationId)await require('./postgres-warehouse-access').assertLocations(c,ctx,[locationId]);
 return u;
}
async function access(c,ctx,automatic=false,trained=false){
 await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
 const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,51,automatic?'automatic':'draft',{trained});
 if(automatic){
  const stopped=await policy.stopped(c,ctx.workspaceId,account,action,true);
  if(stopped)throw new ValidationError(stopped);
  if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('The owner must authorize routine work before automatic QC holds or release.');
 }
 return account;
}
async function getPolicy(c,ctx,id,lock=false){
 const p=(await c.query('SELECT * FROM stockchief_runtime.agent_quality_policies WHERE workspace_id=$1 AND id=$2'+(lock==='share'?' FOR SHARE':lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
 if(!p)throw new NotFoundError('That delivery inspection rule is not in this inventory.');return p;
}
async function facts(c,ctx,p){
 await require('./postgres-warehouse-access').assertLocations(c,ctx,[p.location_id]);
 const row=(await c.query(`SELECT s.code,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  JOIN supplier_items si ON si.workspace_id=s.workspace_id AND si.sku_id=s.id AND si.supplier_id=$3 AND si.is_active=1
  JOIN suppliers v ON v.id=si.supplier_id AND v.workspace_id=s.workspace_id AND v.status='active'
  JOIN locations l ON l.workspace_id=s.workspace_id AND l.id=$4 AND l.is_active=1 AND l.custody_agreement_id IS NULL
  WHERE s.workspace_id=$1 AND s.id=$2 AND s.is_active=1 AND i.is_active=1
   AND i.tracking_mode='quantity' AND i.quantity_precision=0 AND i.secondary_unit_label IS NULL LIMIT 1`,[ctx.workspaceId,p.sku_id,p.supplier_id,p.location_id])).rows[0];
 if(!row)throw new ValidationError('QC currently covers active whole-unit products with a known supplier link and an active owned receiving location. Review this rule’s product, supplier and location.');return row;
}
async function audit(c,ctx,message,id,detail){await require('./postgres-security-audit').record(c,ctx,{action:message,reference:id,after:detail});}
async function save(db,ctx,input){return db.transaction(async c=>{
 await actor(c,ctx,{owner:true});await access(c,ctx);
 const checklist=(Array.isArray(input.checklist)?input.checklist:String(input.checklist||'').split(/\r?\n/)).map(v=>String(v).trim()).filter(Boolean);
 const max=String(input.maxUnits||'');
 if(input.confirmed!=='yes'||!checklist.length||checklist.length>10||checklist.some(v=>v.length>200)||new Set(checklist).size!==checklist.length||!/^\d{1,6}$/.test(max)||Number(max)<1||Number(max)>100000)throw new ValidationError('Review one to ten distinct physical checks and a whole-unit limit from one to 100,000.');
 const resolved={...input};
 for(const [key,name,table,column] of [['supplierId','supplierName','suppliers','name'],['skuId','skuCode','skus','code'],['locationId','locationName','locations','name']])if(!resolved[key]){
  const value=String(input[name]||'').trim();if(!value||value.length>240)throw new ValidationError('Enter the exact supplier name, SKU code and receiving location.');
  const rows=(await c.query(`SELECT id FROM ${table} WHERE workspace_id=$1 AND lower(${column})=lower($2) LIMIT 2`,[ctx.workspaceId,value])).rows;
  if(rows.length!==1)throw new ValidationError('Match the '+name.replace(/([A-Z])/g,' $1').toLowerCase()+' to exactly one record in this inventory.');resolved[key]=rows[0].id;
 }
 const p={supplier_id:String(resolved.supplierId),sku_id:String(resolved.skuId),location_id:String(resolved.locationId)};await facts(c,ctx,p);
 const prior=input.id?await getPolicy(c,ctx,input.id,true):null;
 if(prior&&(Number(input.revision)!==prior.revision||['supplier_id','sku_id','location_id'].some(k=>p[k]!==prior[k])))throw new ValidationError('Reload this QC rule. Its supplier, product and location stay fixed; use a separate rule for another scope.');
 await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
 if(prior){
  await c.query(`UPDATE stockchief_runtime.agent_quality_policies SET checklist=$3,max_units=$4,enabled=true,automatic_enabled=false,
   trained_hold_id=NULL,authorized_by=$5,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,prior.id,JSON.stringify(checklist),Number(max),ctx.actorId]);
  await audit(c,ctx,'Delivery QC rule revised for manual review',prior.id,{checklist,maxUnits:Number(max),existingHoldsUnchanged:true});return {id:prior.id};
 }
 const id=newId('quality-rule');
 const inserted=await c.query(`INSERT INTO stockchief_runtime.agent_quality_policies(id,workspace_id,supplier_id,sku_id,location_id,checklist,max_units,authorized_by)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,supplier_id,sku_id,location_id) DO NOTHING RETURNING id`,[id,ctx.workspaceId,p.supplier_id,p.sku_id,p.location_id,JSON.stringify(checklist),Number(max),ctx.actorId]);
 if(!inserted.rowCount)throw new ValidationError('This supplier, product and location already have a QC rule. Open the existing rule.');
 await audit(c,ctx,'Delivery QC rule recorded',id,{...p,checklist,maxUnits:Number(max),automatic:false});return {id};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function configure(db,ctx,id,input){return db.transaction(async c=>{
 await actor(c,ctx,{owner:true});const p=await getPolicy(c,ctx,id,true);
 if(Number(input.revision)!==p.revision)throw new ValidationError('Reload the current QC rule before changing it.');
 if(input.stop==='yes'){
  await c.query('UPDATE stockchief_runtime.agent_quality_policies SET enabled=false,automatic_enabled=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);
  await audit(c,ctx,'QC rule stopped for future deliveries',id,{existingGoodsRemainHeld:true});return;
 }
 if(input.confirmed!=='yes')throw new ValidationError('Confirm this exact inspection checklist and unit limit.');
 await facts(c,ctx,p);
 let example=null;
 if(input.exampleId)example=(await c.query(`SELECT * FROM stockchief_runtime.agent_quality_holds WHERE workspace_id=$1 AND id=$2 AND policy_id=$3
  AND policy_revision=$4 AND status='PASSED' AND NOT automatic AND released_by=$5`,[ctx.workspaceId,input.exampleId,id,p.revision,ctx.actorId])).rows[0];
 const account=await access(c,ctx,true,Boolean(example||p.trained_hold_id));
 if(account.plan==='growth'&&(!example||p.max_units>example.quantity))throw new ValidationError('On Growth, first complete a matching manual delivery inspection and release. Its quantity must cover the saved unit limit.');
 await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],p.enabled?0:1);
 await c.query(`UPDATE stockchief_runtime.agent_quality_policies SET enabled=true,automatic_enabled=true,authorized_by=$3,
  trained_hold_id=$4,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId,example?.id||p.trained_hold_id]);
 await audit(c,ctx,'Routine delivery QC authorized',id,{maxUnits:p.max_units,checklist:p.checklist,trainedHoldId:example?.id||null});
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function automatic(c,workspaceId,p,quantity,receiptChecks=new Map()){
 if(!p.enabled||!p.automatic_enabled||quantity>p.max_units)throw new ValidationError('This delivery needs one owner approval to apply its QC hold.');
 const key='policy:'+p.id;
 if(!receiptChecks.has(key))receiptChecks.set(key,(async()=>{
  const ctx={workspaceId,actorId:p.authorized_by},ownerKey='owner:'+p.authorized_by;
  if(!receiptChecks.has(ownerKey))receiptChecks.set(ownerKey,actor(c,ctx,{owner:true}));await receiptChecks.get(ownerKey);await facts(c,ctx,p);
  const accessKey='access:'+p.authorized_by+':'+Boolean(p.trained_hold_id);
  if(!receiptChecks.has(accessKey))receiptChecks.set(accessKey,access(c,ctx,true,Boolean(p.trained_hold_id)));
  const account=await receiptChecks.get(accessKey);
  let trainedLimit=null;
  if(account.plan==='growth'){
   const e=(await c.query(`SELECT quantity FROM stockchief_runtime.agent_quality_holds WHERE workspace_id=$1 AND id=$2 AND policy_id=$3
    AND status='PASSED' AND NOT automatic AND released_by=$4 AND checklist=$5::jsonb`,[workspaceId,p.trained_hold_id,p.id,p.authorized_by,JSON.stringify(p.checklist)])).rows[0];
   if(!e)throw new ValidationError('This receipt needs a matching completed Growth QC example. Review it individually.');trainedLimit=e.quantity;
  }
  return {ctx,trainedLimit};
 })());
 const checked=await receiptChecks.get(key);
 if(checked.trainedLimit!==null&&quantity>checked.trainedLimit)throw new ValidationError('This receipt exceeds the matching Growth QC example. Review it individually.');
 return checked.ctx;
}
async function applyReceipt(c,ctx,receiptId,input={}){
 const rows=(await c.query(`SELECT l.id AS receipt_line_id,l.purchase_order_line_id,l.quantity_units,p.* FROM purchase_order_receipt_lines l
  JOIN purchase_order_receipts r ON r.workspace_id=l.workspace_id AND r.id=l.receipt_id
  JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id
  JOIN stockchief_runtime.agent_quality_policies p ON p.workspace_id=l.workspace_id AND p.supplier_id=o.supplier_id
   AND p.sku_id=l.sku_id AND p.location_id=l.location_id AND p.enabled
  WHERE l.workspace_id=$1 AND l.receipt_id=$2 ORDER BY p.id,l.id FOR SHARE OF p`,[ctx.workspaceId,receiptId])).rows;
 const ids=[],receiptChecks=new Map(),quantities=new Map();
 for(const p of rows)quantities.set(p.id,(quantities.get(p.id)||0)+Number(p.quantity_units));
 for(const p of rows){
  if(input.damagedLineIds?.includes(p.purchase_order_line_id))throw new ValidationError('This product requires QC. Record it under its inspection hold and mark the physical inspection failed. A write-off needs separate review.');
  let auto=true;
  try{await automatic(c,ctx.workspaceId,p,quantities.get(p.id),receiptChecks);}catch(error){
   if(![400,402,403,404,422].includes(error.status))throw error;
   if(input.qcConfirmed!=='yes')throw new ValidationError(error.message+' The owner can confirm the inspection hold on the receiving form.');
   await actor(c,ctx,{owner:true,locationId:p.location_id});await access(c,ctx);await facts(c,ctx,p);auto=false;
  }
  const id=newId('quality-hold');await c.query(`INSERT INTO stockchief_runtime.agent_quality_holds
   (id,workspace_id,policy_id,receipt_line_id,sku_id,location_id,quantity,policy_revision,checklist,created_by,automatic)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,ctx.workspaceId,p.id,p.receipt_line_id,p.sku_id,p.location_id,Number(p.quantity_units),p.revision,JSON.stringify(p.checklist),ctx.actorId,auto]);
  ids.push(id);await audit(c,ctx,'Received goods held for physical QC',id,{receiptId,quantity:Number(p.quantity_units),automatic:auto});
 }
 return ids;
}
async function hold(c,ctx,id,lock=false){
 const h=(await c.query('SELECT * FROM stockchief_runtime.agent_quality_holds WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
 if(!h)throw new NotFoundError('That delivery inspection is not in this inventory.');return h;
}
async function inspect(db,ctx,id,input){return db.transaction(async c=>{
 const h=await hold(c,ctx,id,true);await actor(c,ctx,{locationId:h.location_id});await access(c,ctx);
 if(h.status==='PASSED')return {id,replayed:true,released:true};
 if(Number(input.revision)!==h.revision||input.physicallyChecked!=='yes'||!['PASS','FAIL'].includes(input.decision))throw new ValidationError('Reload this inspection and confirm the checks were physically performed on these goods.');
 const checks=Array.isArray(input.checks)?input.checks:[input.checks].filter(Boolean);
 if(input.decision==='PASS'&&(checks.length!==h.checklist.length||h.checklist.some((_,i)=>!checks.includes(String(i)))))throw new ValidationError('Confirm every recorded physical check before marking this delivery as passed.');
 const note=String(input.note||'').trim();if(note.length>1000||input.decision==='FAIL'&&!note)throw new ValidationError('Describe a failed inspection in up to 1,000 characters.');
 let release=false,reason=null;const p=await getPolicy(c,ctx,h.policy_id,'share');
 if(input.decision==='PASS')try{
  if(h.policy_revision!==p.revision)throw new ValidationError('The QC authority changed. The owner must review this exact inspected delivery.');
  await automatic(c,ctx.workspaceId,p,h.quantity);release=true;
 }catch(error){if(![400,402,403,404,422].includes(error.status))throw error;reason=error.message;}
 await c.query(`UPDATE stockchief_runtime.agent_quality_holds SET status=$3,inspection=$4,inspected_by=$5,inspected_at=clock_timestamp(),
  released_by=$6,released_at=CASE WHEN $6::text IS NOT NULL THEN clock_timestamp() END,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,
 [ctx.workspaceId,id,release?'PASSED':input.decision==='FAIL'?'FAILED':'HELD',JSON.stringify({decision:input.decision,checks,note,releaseReason:reason}),ctx.actorId,release?p.authorized_by:null]);
 await audit(c,ctx,'Physical delivery inspection recorded',id,{decision:input.decision,released:release,quantity:h.quantity});return {id,released:release,reason};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function release(db,ctx,id,input){return db.transaction(async c=>{
 const h=await hold(c,ctx,id,true);await actor(c,ctx,{owner:true,locationId:h.location_id});await access(c,ctx);
 if(h.status==='PASSED')return {id,replayed:true};
 if(Number(input.revision)!==h.revision||input.confirmed!=='yes'||h.inspection?.decision!=='PASS')throw new ValidationError('Review this exact passed physical inspection before releasing the held units. Failed or uninspected goods stay held.');
 await c.query("UPDATE stockchief_runtime.agent_quality_holds SET status='PASSED',released_by=$3,released_at=clock_timestamp(),revision=revision+1 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,ctx.actorId]);
 await audit(c,ctx,'Inspected delivery released by owner',id,{quantity:h.quantity});return {id};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function page(db,ctx,input={}){
 const user=await actor(db,ctx,{lock:false}),state=await policy.accountState(db,ctx.workspaceId),locked=!policy.usesAgentTerms(state)||!policy.permits(state.plan,51,'draft');
 const n=Number(input.page||1);if(!Number.isSafeInteger(n)||n<1||n>1000000)throw new ValidationError('Choose a valid inspection page.');
 const roots=await require('./postgres-warehouse-access').scope(db,ctx);
 const scope=roots===null?null:(await require('./postgres-warehouse-access').locations(db,ctx.workspaceId,roots)).map(l=>l.id);
 const rows=(await db.query(`SELECT h.*,s.code,i.name,l.name location_name,v.name supplier_name,o.po_number FROM stockchief_runtime.agent_quality_holds h
  JOIN stockchief_runtime.agent_quality_policies p ON p.workspace_id=h.workspace_id AND p.id=h.policy_id
  JOIN skus s ON s.workspace_id=h.workspace_id AND s.id=h.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  JOIN locations l ON l.workspace_id=h.workspace_id AND l.id=h.location_id JOIN suppliers v ON v.workspace_id=p.workspace_id AND v.id=p.supplier_id
  JOIN purchase_order_receipt_lines rl ON rl.id=h.receipt_line_id AND rl.workspace_id=h.workspace_id JOIN purchase_order_receipts r ON r.id=rl.receipt_id AND r.workspace_id=rl.workspace_id
  JOIN purchase_orders o ON o.id=r.purchase_order_id AND o.workspace_id=r.workspace_id WHERE h.workspace_id=$1 AND ($2::text[] IS NULL OR h.location_id=ANY($2))
  ORDER BY (h.status='PASSED'),h.created_at DESC,h.id DESC LIMIT 101 OFFSET $3`,[ctx.workspaceId,scope,(n-1)*100])).rows;
 const policies=user.role==='owner'?(await db.query(`SELECT p.*,s.code,l.name location_name,v.name supplier_name FROM stockchief_runtime.agent_quality_policies p
  JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
  JOIN suppliers v ON v.workspace_id=p.workspace_id AND v.id=p.supplier_id WHERE p.workspace_id=$1 ORDER BY p.created_at DESC,p.id DESC LIMIT 101 OFFSET $2`,[ctx.workspaceId,(n-1)*100])).rows:[];
 let selected=null;if(input.id){selected=await hold(db,ctx,input.id);await actor(db,ctx,{locationId:selected.location_id,lock:false});selected=rows.find(r=>r.id===selected.id)||{...selected,...(await db.query(`SELECT s.code,i.name,l.name location_name,v.name supplier_name,o.po_number FROM stockchief_runtime.agent_quality_holds h JOIN skus s ON s.id=h.sku_id JOIN items i ON i.id=s.item_id JOIN locations l ON l.id=h.location_id JOIN stockchief_runtime.agent_quality_policies p ON p.id=h.policy_id JOIN suppliers v ON v.id=p.supplier_id JOIN purchase_order_receipt_lines rl ON rl.id=h.receipt_line_id JOIN purchase_order_receipts r ON r.id=rl.receipt_id JOIN purchase_orders o ON o.id=r.purchase_order_id WHERE h.workspace_id=$1 AND h.id=$2`,[ctx.workspaceId,selected.id])).rows[0]};}
 let editing=null;if(input.edit){await actor(db,ctx,{owner:true,lock:false});editing=await getPolicy(db,ctx,input.edit);await facts(db,ctx,editing);editing={...editing,...(await db.query('SELECT s.code,l.name location_name,v.name supplier_name FROM skus s,locations l,suppliers v WHERE s.id=$1 AND l.id=$2 AND v.id=$3',[editing.sku_id,editing.location_id,editing.supplier_id])).rows[0]};}
 return {locked,plan:state.plan,shadow:state.shadow,owner:user.role==='owner',rows:rows.slice(0,100),policies:policies.slice(0,100),more:rows.length>100||policies.length>100,page:n,selected,editing};
}
const definition={id:51,key:'delivery-quality',label:'Hold supplier deliveries until physical inspection',readPage:async()=>({summary:'Configure an exact supplier, whole-unit product, receiving location and physical checklist. Goods stay unavailable until a person checks them. Growth learns from a completed manual example; Pro and Custom can use explicit limits without training. Failed goods stay held.',rows:[{Action:'Open delivery QC',link:'/autopilot/delivery-quality'}],more:false})};
async function inbox(db,workspaceId,actorId){
 await actor(db,{workspaceId,actorId},{owner:true,lock:false});
 const rows=(await db.query(`SELECT h.id,h.quantity,h.status,h.created_at,s.code,l.name FROM stockchief_runtime.agent_quality_holds h
  JOIN skus s ON s.workspace_id=h.workspace_id AND s.id=h.sku_id JOIN locations l ON l.workspace_id=h.workspace_id AND l.id=h.location_id
  WHERE h.workspace_id=$1 AND h.status<>'PASSED' ORDER BY h.created_at,h.id LIMIT 50`,[workspaceId])).rows;
 return rows.map(h=>({kind:'purchasing',importance:'Needs You',priority:80,title:'Delivery QC: '+h.code+' · '+h.quantity+' units',happened:'Received goods remain unavailable at '+h.name+'.',why:h.status==='FAILED'?'A physical inspection failed. The goods remain held.':'A person must complete physical checks, or the owner must review a passed inspection.',recommendation:'Review the exact inspection checklist. Failed or unchecked goods cannot be released.',href:'/autopilot/delivery-quality/'+h.id,actionLabel:'Review delivery QC',sourceId:'delivery-quality:'+h.id,at:h.created_at,createdAt:h.created_at}));
}
module.exports={save,configure,applyReceipt,inspect,release,actor,access,hold,getPolicy,page,inbox,definition,action};

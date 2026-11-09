'use strict';
const policy=require('../commercial/agent-plan'),P=require('../actions/permissions');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions'),{newId}=require('../lib/util');
const relation='stockchief_runtime.agent_putaway_instructions',rules='stockchief_runtime.agent_putaway_rules';

async function access(db,ctx,{owner=false,automatic=false}={}){
 const user=(await db.query(`SELECT u.role,u.permissions FROM users u JOIN workspaces w ON w.id=u.workspace_id
  LEFT JOIN platform_account_access a ON a.account_id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2
  AND w.deletion_requested_at IS NULL AND a.disabled_at IS NULL FOR SHARE OF u`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(owner&&user?.role!=='owner')throw new AuthorizationError('Only the inventory owner can approve put-away instructions or teach a destination.');
 P.assertCan(user,P.VIEW,'read put-away labels');
 if(owner)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
 const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,47,automatic?'automatic':'draft',{trained:automatic});
 return state;
}
function barcode(value,label){
 if(typeof value!=='string'||!value.length||value.length>80||/[^\x20-\x7e]/.test(value))throw new ValidationError('Set a unique printable scan code of up to 80 characters for '+label+' before preparing its label.');
 return value;
}
async function site(db,workspaceId,id){
 const rows=(await db.query(`WITH RECURSIVE ancestors AS (
  SELECT id,parent_location_id,is_active,custody_agreement_id,0 depth FROM locations WHERE workspace_id=$1 AND id=$2
  UNION ALL SELECT l.id,l.parent_location_id,l.is_active,l.custody_agreement_id,a.depth+1 FROM locations l
  JOIN ancestors a ON l.id=a.parent_location_id WHERE l.workspace_id=$1 AND a.depth<20)
  SELECT * FROM ancestors ORDER BY depth`,[workspaceId,id])).rows;
 if(!rows.length||rows.some(r=>!Number(r.is_active)||r.custody_agreement_id)||rows.at(-1).parent_location_id)throw new ValidationError('Choose active business locations with a complete physical-site layout.');
 return rows.at(-1).id;
}
async function facts(db,ctx,lineId,destinationId,{lock=false}={}){
 const row=(await db.query(`SELECT r.id receipt_id,r.received_at,po.po_number,rl.id receipt_line_id,rl.sku_id,rl.location_id,rl.quantity_units::text quantity,
  s.code,s.barcode,i.name,i.tracking_mode,i.quantity_precision,i.secondary_unit_label,
  f.name from_name,f.barcode from_barcode,d.id to_id,d.name to_name,d.barcode to_barcode
  FROM purchase_order_receipt_lines rl JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id
  JOIN purchase_orders po ON po.workspace_id=r.workspace_id AND po.id=r.purchase_order_id
  JOIN skus s ON s.workspace_id=rl.workspace_id AND s.id=rl.sku_id AND s.is_active=1
  JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
  JOIN locations f ON f.workspace_id=rl.workspace_id AND f.id=rl.location_id AND f.is_active=1 AND f.custody_agreement_id IS NULL
  JOIN locations d ON d.workspace_id=rl.workspace_id AND d.id=$3 AND d.is_active=1 AND d.custody_agreement_id IS NULL
  WHERE rl.workspace_id=$1 AND rl.id=$2 ${lock?'FOR SHARE OF rl,r,po,s,i,f,d':''}`,[ctx.workspaceId,lineId,destinationId])).rows[0];
 if(!row)throw new ValidationError('Choose a recorded receipt and an active destination in this inventory.');
 const quantity=Number(row.quantity);
 if(row.tracking_mode!=='quantity'||Number(row.quantity_precision)!==0||row.secondary_unit_label||!Number.isSafeInteger(quantity)||quantity<1||(await db.query('SELECT 1 FROM kit_components WHERE workspace_id=$1 AND kit_sku_id=$2 LIMIT 1',[ctx.workspaceId,row.sku_id])).rowCount)throw new ValidationError('Review lot, serial, kit and measured goods individually before preparing put-away labels.');
 if(row.location_id===row.to_id||await site(db,ctx.workspaceId,row.location_id)!==await site(db,ctx.workspaceId,row.to_id))throw new ValidationError('Choose a different bin at the same physical site. Moves between sites need their transfer workflow.');
 const p=await require('../domain/postgres-stock-availability').read(db,ctx.workspaceId,row.sku_id,row.location_id);
 if(p.available<quantity)throw new ValidationError('The received quantity is no longer free at its receiving location. Review stock, reservations and quality holds before giving staff these instructions.');
 const source={receiptLineId:row.receipt_line_id,receiptId:row.receipt_id,receivedAt:row.received_at,order:row.po_number,skuId:row.sku_id,product:row.name,sku:row.code,quantity,
  from:{id:row.location_id,name:row.from_name,barcode:barcode(row.from_barcode,'the receiving location')},
  to:{id:row.to_id,name:row.to_name,barcode:barcode(row.to_barcode,'the destination')},barcode:barcode(row.barcode||row.code,'the product')};
 const scanner=require('../operations/postgres-fulfillment-waves').resolveIdentity;
 if(await scanner(db,ctx.workspaceId,source.barcode,'sku')!==source.skuId||await scanner(db,ctx.workspaceId,source.from.barcode,'location')!==source.from.id||await scanner(db,ctx.workspaceId,source.to.barcode,'location')!==source.to.id)throw new ValidationError('A printed scan code identifies a different product or location. Correct the scan codes before preparing labels.');
 return {source,fingerprint:hash(source)};
}
async function createInTransaction(db,ctx,lineId,destinationId,{automatic=false,ruleRevision=null}={}){
 await access(db,ctx,{owner:true,automatic});
 const stopped=await require('../autopilot/job-modes').restriction(db,ctx.workspaceId,47,automatic);if(stopped)throw new ValidationError(stopped);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['putaway:'+ctx.workspaceId+':'+lineId]);
 const fresh=await facts(db,ctx,lineId,destinationId,{lock:true});
 if(automatic){
  await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
  if(!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)throw new ValidationError('Automatic put-away instructions are paused or still in shadow mode.');
  const rule=(await db.query(`SELECT *,authorized_at<=$4::timestamptz eligible_receipt FROM ${rules} WHERE workspace_id=$1 AND sku_id=$2 AND from_location_id=$3 FOR SHARE`,[ctx.workspaceId,fresh.source.skuId,fresh.source.from.id,fresh.source.receivedAt])).rows[0];
  if(!rule||!rule.eligible_receipt||rule.actor_id!==ctx.actorId||rule.to_location_id!==destinationId||rule.revision!==ruleRevision||rule.maximum_quantity<fresh.source.quantity)throw new ValidationError('This receipt is outside the current taught product, receiving location, destination, quantity or start date.');
 }
 const prior=(await db.query(`SELECT id,fingerprint FROM ${relation} WHERE workspace_id=$1 AND receipt_line_id=$2`,[ctx.workspaceId,lineId])).rows[0];
 if(prior){if(prior.fingerprint!==fresh.fingerprint)throw new ValidationError('These saved instructions differ from the current source or destination. Review the original instruction before reissuing labels.');return {id:prior.id,replayed:true};}
 const id=newId('putaway');await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'putaway:'+id,Buffer.byteLength(JSON.stringify(fresh.source),'utf8')+8192,{finished:true});
 await db.query(`INSERT INTO ${relation}(id,workspace_id,receipt_line_id,actor_id,automatic,source,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,ctx.workspaceId,lineId,ctx.actorId,automatic,fresh.source,fresh.fingerprint]);
 await require('../operations/postgres-security-audit').record(db,ctx,{action:'Put-away instructions prepared',reference:fresh.source.order,after:{sku:fresh.source.sku,quantity:fresh.source.quantity,from:fresh.source.from.name,to:fresh.source.to.name,automatic}});
 return {id,replayed:false};
}
async function prepare(db,ctx,lineId,destinationId){return db.transaction(c=>createInTransaction(c,ctx,lineId,destinationId),{isolation:'SERIALIZABLE',retrySafe:true});}
async function instruction(db,ctx,id){
 await access(db,ctx);const row=(await db.query(`SELECT * FROM ${relation} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('That put-away instruction is not in this inventory.');
 await require('../operations/postgres-warehouse-access').assertLocations(db,ctx,[row.source.from.id,row.source.to.id]);
 const fresh=await facts(db,ctx,row.receipt_line_id,row.source.to.id);if(fresh.fingerprint!==row.fingerprint)throw new ValidationError('The product, scan code, receipt or destination changed. Review these instructions before printing.');
 const rule=(await db.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND sku_id=$2 AND from_location_id=$3`,[ctx.workspaceId,row.source.skuId,row.source.from.id])).rows[0];
 return {...row,rule};
}
async function teach(db,ctx,id,input){return db.transaction(async c=>{
 const state=await access(c,ctx,{owner:true}),example=(await c.query(`SELECT * FROM ${relation} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id])).rows[0],revision=Number(input.revision);
 if(!example)throw new NotFoundError('That reviewed put-away instruction is not in this inventory.');
 if(!Number.isSafeInteger(revision)||revision<0)throw new ValidationError('Reload the destination rule before changing it.');
 const args=[ctx.workspaceId,example.source.skuId,example.source.from.id];
 if(input.remove==='1'){
  const result=await c.query(`DELETE FROM ${rules} WHERE workspace_id=$1 AND sku_id=$2 AND from_location_id=$3 AND revision=$4`,[...args,revision]);if(!result.rowCount)throw new ValidationError('The destination rule changed. Reload it.');return;
 }
 await instruction(c,ctx,id);
 policy.requireJob(state.plan,47,'automatic',{trained:true});
 if(state.shadow||example.automatic||example.actor_id!==ctx.actorId)throw new ValidationError('Approve a real instruction yourself outside shadow mode before teaching its destination.');
 const maximum=Number(input.maximum);if(!Number.isSafeInteger(maximum)||maximum<example.source.quantity||maximum>2147483647)throw new ValidationError('Choose a whole-unit limit covering this reviewed receipt.');
 await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],revision===0?1:0);
 const values=[...args,example.source.to.id,id,ctx.actorId,maximum];
 const changed=revision===0?await c.query(`INSERT INTO ${rules}(workspace_id,sku_id,from_location_id,to_location_id,example_id,actor_id,maximum_quantity) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,values):await c.query(`UPDATE ${rules} SET to_location_id=$4,example_id=$5,actor_id=$6,maximum_quantity=$7,revision=revision+1,authorized_at=now(),retry_after=now(),problem=NULL WHERE workspace_id=$1 AND sku_id=$2 AND from_location_id=$3 AND revision=$8`,[...values,revision]);
 if(!changed.rowCount)throw new ValidationError('The destination rule changed. Reload it.');
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Put-away destination taught',reference:example.source.sku,after:{from:example.source.from.name,to:example.source.to.name,maximum}});
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function run(db,workspaceId){
 const empty={prepared:0,held:0};
 const state=await policy.accountState(db,workspaceId);if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,47,'automatic',{trained:true}))return empty;
 if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate||await require('../autopilot/job-modes').restriction(db,workspaceId,47,true))return empty;
 const grant=(await db.query("SELECT 1 FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=47 AND mode='routine'",[workspaceId])).rowCount;if(!grant)return empty;
 const rows=(await db.query(`SELECT rl.id,r.actor_id,r.to_location_id,r.revision,r.sku_id,r.from_location_id FROM purchase_order_receipt_lines rl JOIN purchase_order_receipts receipt ON receipt.workspace_id=rl.workspace_id AND receipt.id=rl.receipt_id
  JOIN ${rules} r ON r.workspace_id=rl.workspace_id AND r.sku_id=rl.sku_id AND r.from_location_id=rl.location_id
  WHERE rl.workspace_id=$1 AND receipt.received_at::timestamptz>=r.authorized_at AND r.retry_after<=now()
  AND NOT EXISTS(SELECT 1 FROM ${relation} p WHERE p.workspace_id=rl.workspace_id AND p.receipt_line_id=rl.id)
  ORDER BY receipt.received_at,rl.id LIMIT 20`,[workspaceId])).rows;
 const result={...empty};for(const row of rows){const ctx={workspaceId,actorId:row.actor_id};try{
  const made=await db.transaction(async c=>{
   const grant=(await c.query(`SELECT m.mode,u.role FROM stockchief_runtime.agent_job_modes m JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.updated_by
    WHERE m.workspace_id=$1 AND m.job_id=47 AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) FOR SHARE OF m,u`,[workspaceId])).rows[0];
   if(grant?.mode!=='routine'||grant.role!=='owner')throw new ValidationError('The owner stopped automatic put-away preparation.');
   return createInTransaction(c,ctx,row.id,row.to_location_id,{automatic:true,ruleRevision:row.revision});
  },{isolation:'SERIALIZABLE',retrySafe:true});if(!made.replayed)result.prepared++;
 }catch(error){if(!['validation_error','entitlement_required','forbidden'].includes(error.code))throw error;result.held++;await db.query(`UPDATE ${rules} SET problem=$4,retry_after=now()+interval '15 minutes' WHERE workspace_id=$1 AND actor_id=$2 AND revision=$3 AND sku_id=$5 AND from_location_id=$6`,[workspaceId,row.actor_id,row.revision,error.message,row.sku_id,row.from_location_id]);}}
 return result;
}
async function review(db,ctx,{page=1,filter=''}){
 await access(db,ctx,{owner:true});
 const receipts=(await db.query(`SELECT rl.id,po.po_number,sku.code,i.name,rl.quantity_units::text quantity,l.name location,p.id instruction_id
  FROM purchase_order_receipt_lines rl JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id JOIN purchase_orders po ON po.workspace_id=r.workspace_id AND po.id=r.purchase_order_id
  JOIN skus sku ON sku.workspace_id=rl.workspace_id AND sku.id=rl.sku_id JOIN items i ON i.workspace_id=sku.workspace_id AND i.id=sku.item_id
  JOIN locations l ON l.workspace_id=rl.workspace_id AND l.id=rl.location_id LEFT JOIN ${relation} p ON p.workspace_id=rl.workspace_id AND p.receipt_line_id=rl.id
  WHERE rl.workspace_id=$1 AND ($2='' OR po.po_number ILIKE '%'||$2||'%' OR sku.code ILIKE '%'||$2||'%' OR i.name ILIKE '%'||$2||'%')
  ORDER BY r.received_at DESC,rl.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 const destinations=await require('../domain/postgres-location-service').listHierarchy(db,ctx.workspaceId,{includeStock:false});
 const saved=(await db.query(`SELECT s.code,f.name from_name,d.name to_name,r.maximum_quantity,r.problem,r.example_id,r.revision FROM ${rules} r JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id JOIN locations f ON f.workspace_id=r.workspace_id AND f.id=r.from_location_id JOIN locations d ON d.workspace_id=r.workspace_id AND d.id=r.to_location_id WHERE r.workspace_id=$1 ORDER BY s.code LIMIT 100`,[ctx.workspaceId])).rows;
 const blocked=await require('../autopilot/job-modes').restriction(db,ctx.workspaceId,47,false);
 return {summary:'Print product and destination labels for goods actually received. Choose an exact bin at the same site. Preparing or printing instructions does not move stock or confirm physical work. Taught destinations can prepare future receipts within their whole-unit limits after you enable job 47 routine work.',
  rows:receipts.slice(0,100).map(r=>({Order:r.po_number,Product:r.name,SKU:r.code,Quantity:r.quantity,'Received at':r.location,...(r.instruction_id?{link:'/warehouse/putaway/'+r.instruction_id}:{})})),more:receipts.length>100,
  putawayForm:{receipts:receipts.slice(0,100).filter(r=>!r.instruction_id),destinations:destinations.filter(l=>!l.custody_agreement_id),rules:saved,blocked}};
}
async function trained(db,workspaceId,p){
 if(!p||p.needsPutawayConfirmation!==false||!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return false;
 return Boolean((await db.query(`SELECT 1 FROM ${rules} r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.actor_id AND u.role='owner'
  WHERE r.workspace_id=$1 AND r.sku_id=$2 AND r.from_location_id=$3 AND r.to_location_id=$4 AND r.revision=$5 AND r.maximum_quantity>=$6 AND r.authorized_at<=$7::timestamptz`,[workspaceId,p.source.skuId,p.source.from.id,p.source.to.id,p.ruleRevision,p.source.quantity,p.source.receivedAt])).rowCount);
}
async function build(db,ctx,po,args){
 const lines=(await db.query(`SELECT rl.id FROM purchase_order_receipts r JOIN purchase_order_receipt_lines rl ON rl.workspace_id=r.workspace_id AND rl.receipt_id=r.id
  JOIN skus s ON s.workspace_id=rl.workspace_id AND s.id=rl.sku_id WHERE r.workspace_id=$1 AND r.purchase_order_id=$2 AND (lower(s.code)=lower($3) OR s.id=$3) ORDER BY r.received_at DESC,rl.id LIMIT 2`,[ctx.workspaceId,po.id,String(args.sku||'')])).rows;
 if(lines.length!==1)throw new ValidationError('Choose the exact received product on the put-away page. Multiple deliveries need their individual receipt line.');
 const dest=(await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND (id=$2 OR lower(name)=lower($2)) AND is_active=1 LIMIT 2',[ctx.workspaceId,String(args.location||'')])).rows;
 if(dest.length!==1)throw new ValidationError('Choose one exact destination bin from this inventory.');
 const fresh=await facts(db,ctx,lines[0].id,dest[0].id),rule=(await db.query(`SELECT *,authorized_at<=$4::timestamptz eligible_receipt FROM ${rules} WHERE workspace_id=$1 AND sku_id=$2 AND from_location_id=$3`,[ctx.workspaceId,fresh.source.skuId,fresh.source.from.id,fresh.source.receivedAt])).rows[0];
 const payload={recordId:po.id,source:fresh.source,fingerprint:fresh.fingerprint,ruleRevision:rule?.revision||0,needsPutawayConfirmation:!rule||!rule.eligible_receipt||rule.to_location_id!==dest[0].id||rule.maximum_quantity<fresh.source.quantity};
 return {payload,summary:'Prepare printable labels and instructions for '+fresh.source.quantity+' units of '+fresh.source.product+' received on '+fresh.source.order+', from '+fresh.source.from.name+' to '+fresh.source.to.name+'. This does not record physical movement.'};
}
async function execute(db,ctx,p){
 const fresh=await facts(db,ctx,p.source.receiptLineId,p.source.to.id,{lock:true});if(fresh.fingerprint!==p.fingerprint)throw new ValidationError('The received product or destination changed. Review fresh put-away instructions.');
 const result=await createInTransaction(db,ctx,p.source.receiptLineId,p.source.to.id,{automatic:ctx.agentPutawayScope==='automatic',ruleRevision:p.ruleRevision});return {...result,href:'/warehouse/putaway/'+result.id};
}
module.exports={prepare,instruction,teach,run,review,trained,definition:{id:47,key:'putaway-labels',label:'Prepare put-away instructions and labels',filterLabel:'Purchase order, product or SKU',readPage:review},
 spec:{name:'warehouse.prepare_putaway',agentJob:47,record:'purchase_order',fields:['recordReference','sku','location'],ownerOnly:true,permission:P.OPERATE,capability:'inventory.core',resultingRecords:['stockchief_runtime.agent_putaway_instructions'],
 description:'Prepare printable product and location labels plus put-away directions for one actual received quantity product on a purchase order. Supply its exact SKU and a destination bin at the same site. Multiple deliveries need their individual receipt line on the put-away page. Automatic work needs the current owner-taught destination and quantity limit. Never confirms physical work or moves stock.',build,execute,
 verify:async(db,ctx,r,p)=>Boolean((await db.query(`SELECT 1 FROM ${relation} WHERE workspace_id=$1 AND id=$2 AND receipt_line_id=$3 AND fingerprint=$4`,[ctx.workspaceId,r.id,p.source.receiptLineId,p.fingerprint])).rowCount)}};

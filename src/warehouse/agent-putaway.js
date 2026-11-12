'use strict';
const policy=require('../commercial/agent-plan'),P=require('../actions/permissions');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions'),{newId}=require('../lib/util'),exact=require('../domain/exact-quantity'),units=require('../domain/stock-quantity');
const relation='stockchief_runtime.agent_putaway_instructions',rules='stockchief_runtime.agent_putaway_rules';
const confirmations='stockchief_runtime.agent_putaway_confirmations',holds='stockchief_runtime.agent_putaway_holds';
const capacities='stockchief_runtime.agent_slotting_capacities';
const cmp=(a,b)=>exact.safeNumber(exact.subtract(a,b),{signed:true});

async function access(db,ctx,{owner=false,automatic=false,trained=automatic}={}){
 const user=(await db.query(`SELECT u.role,u.permissions FROM users u JOIN workspaces w ON w.id=u.workspace_id
  LEFT JOIN platform_account_access a ON a.account_id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2
  AND w.deletion_requested_at IS NULL AND a.disabled_at IS NULL FOR SHARE OF u`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(owner&&user?.role!=='owner')throw new AuthorizationError('Only the inventory owner can approve put-away instructions or teach a destination.');
 P.assertCan(user,P.VIEW,'read put-away labels');
 if(owner)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
 const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,47,automatic?'automatic':'draft',{trained});
 return state;
}
function barcode(value,label){
 if(typeof value!=='string'||!value.length||value.length>80||/[^\x20-\x7e]/.test(value))throw new ValidationError('Set a unique printable scan code of up to 80 characters for '+label+' before preparing its label.');
 return value;
}
async function site(db,workspaceId,id){
 const rows=(await db.query(`WITH RECURSIVE ancestors AS (
  SELECT id,parent_location_id,is_active,custody_agreement_id,kind,0 depth FROM locations WHERE workspace_id=$1 AND id=$2
  UNION ALL SELECT l.id,l.parent_location_id,l.is_active,l.custody_agreement_id,l.kind,a.depth+1 FROM locations l
  JOIN ancestors a ON l.id=a.parent_location_id WHERE l.workspace_id=$1 AND a.depth<20)
  SELECT * FROM ancestors ORDER BY depth`,[workspaceId,id])).rows;
 if(!rows.length||rows.some(r=>!Number(r.is_active)||r.custody_agreement_id)||rows.at(-1).parent_location_id)throw new ValidationError('Choose active business locations with a complete physical-site layout.');
 return rows.at(-1).id;
}
// Batch, serial and measured goods keep their identity and exact measure on
// the plan. Whole-unit plans keep the shape they had before these were added.
function extended(row){return row.tracking_mode!=='quantity'||Number(row.quantity_precision)!==0||Boolean(row.secondary_unit_label);}
async function facts(db,ctx,lineId,destinationId,{lock=false,putAway=null}={}){
 const row=(await db.query(`SELECT r.id receipt_id,r.received_at,po.po_number,rl.id receipt_line_id,rl.sku_id,rl.location_id,rl.quantity_units::text quantity,
  rl.secondary_quantity::text secondary_quantity,rl.lot_id,rl.serials,lot.code lot_code,lot.expires_at lot_expires_at,
  s.code,s.barcode,i.name,i.tracking_mode,i.unit_label,i.quantity_precision,i.quantity_increment,i.secondary_unit_label,i.secondary_precision,i.secondary_increment,
  f.name from_name,f.barcode from_barcode,d.id to_id,d.name to_name,d.barcode to_barcode
  FROM purchase_order_receipt_lines rl JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id
  JOIN purchase_orders po ON po.workspace_id=r.workspace_id AND po.id=r.purchase_order_id
  JOIN skus s ON s.workspace_id=rl.workspace_id AND s.id=rl.sku_id AND s.is_active=1
  JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
  JOIN locations f ON f.workspace_id=rl.workspace_id AND f.id=rl.location_id AND f.is_active=1 AND f.custody_agreement_id IS NULL
  JOIN locations d ON d.workspace_id=rl.workspace_id AND d.id=$3 AND d.is_active=1 AND d.custody_agreement_id IS NULL
  LEFT JOIN lots lot ON lot.workspace_id=rl.workspace_id AND lot.id=rl.lot_id
  WHERE rl.workspace_id=$1 AND rl.id=$2 ${lock?'FOR SHARE OF rl,r,po,s,i,f,d':''}`,[ctx.workspaceId,lineId,destinationId])).rows[0];
 if(!row)throw new ValidationError('Choose a recorded receipt and an active destination in this inventory.');
 if((await db.query('SELECT 1 FROM kit_components WHERE workspace_id=$1 AND kit_sku_id=$2 LIMIT 1',[ctx.workspaceId,row.sku_id])).rowCount)throw new ValidationError('Kits are stored as their parts. Put away each part from its own receipt.');
 if(!['quantity','lot','serial'].includes(row.tracking_mode))throw new ValidationError('Review this product’s tracking before preparing put-away labels.');
 const quantity=units.validate(row,row.quantity,{label:'Received quantity'});
 if(row.location_id===row.to_id||await site(db,ctx.workspaceId,row.location_id)!==await site(db,ctx.workspaceId,row.to_id))throw new ValidationError('Choose a different bin at the same physical site. Moves between sites need their transfer workflow.');
 let lot=null,serials=[],secondaryQuantity=null;
 if(row.secondary_unit_label){if(row.secondary_quantity==null)throw new ValidationError('Record the actual '+row.secondary_unit_label+' received before preparing put-away.');secondaryQuantity=units.secondary(row,row.secondary_quantity);}
 if(row.tracking_mode==='lot'){
  if(!row.lot_id)throw new ValidationError('This batch-tracked receipt has no recorded batch. Correct the receipt before put-away.');
  lot={id:row.lot_id,code:barcode(row.lot_code,'the batch'),expiresAt:row.lot_expires_at||null};
 }
 if(row.tracking_mode==='serial'){
  const listed=JSON.parse(row.serials||'[]').map(String);
  const found=(await db.query(`SELECT id,serial,location_id,status,secondary_quantity::text secondary FROM serial_units WHERE workspace_id=$1 AND sku_id=$2 AND serial=ANY($3::text[]) ORDER BY serial,id`,[ctx.workspaceId,row.sku_id,listed])).rows;
  if(!listed.length||listed.length!==quantity||found.length!==listed.length)throw new ValidationError('The received serial numbers do not match this receipt. Correct the receipt before put-away.');
  serials=found.map(s=>({id:s.id,serial:barcode(s.serial,'serial '+s.serial)}));
 }
 const source={receiptLineId:row.receipt_line_id,receiptId:row.receipt_id,receivedAt:row.received_at,order:row.po_number,skuId:row.sku_id,product:row.name,sku:row.code,quantity,
  from:{id:row.location_id,name:row.from_name,barcode:barcode(row.from_barcode,'the receiving location')},
  to:{id:row.to_id,name:row.to_name,barcode:barcode(row.to_barcode,'the destination')},barcode:barcode(row.barcode||row.code,'the product')};
 if(extended(row))Object.assign(source,{tracking:row.tracking_mode,unit:row.unit_label,lot,serials,secondaryQuantity,secondaryUnit:row.secondary_unit_label||null});
 const scanner=require('../operations/postgres-fulfillment-waves').resolveIdentity;
 if(await scanner(db,ctx.workspaceId,source.barcode,'sku')!==source.skuId||await scanner(db,ctx.workspaceId,source.from.barcode,'location')!==source.from.id||await scanner(db,ctx.workspaceId,source.to.barcode,'location')!==source.to.id)throw new ValidationError('A printed scan code identifies a different product or location. Correct the scan codes before preparing labels.');
 if(lot&&await scanner(db,ctx.workspaceId,lot.code,'lot',{skuId:source.skuId})!==lot.id)throw new ValidationError('The batch code identifies a different batch. Correct it before preparing labels.');
 const remaining=exact.safeNumber(exact.subtract(String(quantity),String(putAway?.quantity??0)));
 if(remaining>0){
  if(serials.length){
   const waiting=serials.filter(s=>!(putAway?.serials||[]).includes(s.id)).map(s=>s.id);
   const here=(await db.query(`SELECT count(*)::int n FROM serial_units WHERE workspace_id=$1 AND id=ANY($2::text[]) AND location_id=$3 AND status='in_stock'`,[ctx.workspaceId,waiting,source.from.id])).rows[0].n;
   if(here!==waiting.length)throw new ValidationError('Some received serial numbers are no longer at the receiving location. Review them before giving staff these instructions.');
  }
  const p=await require('../domain/postgres-stock-availability').read(db,ctx.workspaceId,row.sku_id,row.location_id,{lotId:lot?.id||null});
  if(p.available<remaining)throw new ValidationError('The received quantity is no longer free at its receiving location. Review stock, reservations and quality holds before giving staff these instructions.');
 }
 return {source,fingerprint:hash(source),item:row};
}
async function hasRule(db,workspaceId,skuId,fromId,receivedAt){
 return (await db.query(`SELECT *,authorized_at<=$4::timestamptz eligible_receipt FROM ${rules} WHERE workspace_id=$1 AND sku_id=$2 AND from_location_id=$3`,[workspaceId,skuId,fromId,receivedAt])).rows[0];
}
// The bin StockChief would choose: the owner's taught bin, else a bin at the
// same warehouse already holding the product (most stock first, within any
// recorded bin fit), else the empty bin with the shortest recorded walk to
// packing. Bins under count are never used. Anything else waits for a person.
async function suggest(db,ctx,lineId){
 const line=(await db.query(`SELECT rl.id,rl.sku_id,rl.location_id,rl.quantity_units::text quantity,r.received_at FROM purchase_order_receipt_lines rl
  JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id WHERE rl.workspace_id=$1 AND rl.id=$2`,[ctx.workspaceId,lineId])).rows[0];
 if(!line?.location_id)throw new ValidationError('Choose a recorded receipt at one of your locations.');
 const rule=await hasRule(db,ctx.workspaceId,line.sku_id,line.location_id,line.received_at);
 if(rule){
  if(!rule.eligible_receipt||cmp(rule.maximum_quantity,line.quantity)<0)return {destinationId:null,chosenBy:'rule',rule,reason:'This receipt is outside the current taught product, receiving location, destination, quantity or start date.'};
  return {destinationId:rule.to_location_id,chosenBy:'rule',rule,reason:'Your taught bin for this product.'};
 }
 const none=reason=>({destinationId:null,chosenBy:'agent',reason});
 const siteId=await site(db,ctx.workspaceId,line.location_id);
 const bins=(await require('../forecasting/warehouse-slotting-source').bins(db,ctx.workspaceId,siteId)).filter(b=>b.id!==line.location_id&&!b.counting);
 if(!bins.length)return none('This warehouse has no bins StockChief can use. Choose the bin yourself.');
 const fit=(await db.query(`SELECT location_id,primary_limit::text FROM ${capacities} WHERE workspace_id=$1 AND sku_id=$2 AND location_id=ANY($3::text[])`,[ctx.workspaceId,line.sku_id,bins.map(b=>b.id)])).rows;
 const fits=(id,onHand)=>{const c=fit.find(f=>f.location_id===id);return !c||cmp(exact.add(onHand,line.quantity),c.primary_limit)<=0;};
 const holding=(await db.query(`SELECT b.location_id,b.on_hand::text on_hand FROM balances b JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id
  WHERE b.workspace_id=$1 AND b.sku_id=$2 AND b.location_id=ANY($3::text[]) AND b.on_hand>0 ORDER BY b.on_hand DESC,lower(l.name),l.id`,[ctx.workspaceId,line.sku_id,bins.map(b=>b.id)])).rows;
 for(const h of holding)if(fits(h.location_id,h.on_hand))return {destinationId:h.location_id,chosenBy:'agent',reason:'This bin already holds this product.'};
 for(const b of bins)if(b.empty&&b.metres!=null&&fits(b.id,'0'))return {destinationId:b.id,chosenBy:'agent',reason:'The nearest empty bin to packing ('+Number(b.metres)+' m).'};
 return none('No bin at this warehouse holds this product, and no empty bin has a recorded walking distance. Choose its bin.');
}
async function createInTransaction(db,ctx,lineId,destinationId,{automatic=false,ruleRevision=null,chosenBy='owner',reason=null}={}){
 await access(db,ctx,{owner:true,automatic,trained:chosenBy==='rule'});
 const stopped=await require('../autopilot/job-modes').restriction(db,ctx.workspaceId,47,automatic);if(stopped)throw new ValidationError(stopped);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['putaway:'+ctx.workspaceId+':'+lineId]);
 const fresh=await facts(db,ctx,lineId,destinationId,{lock:true});
 if(automatic){
  await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
  if(!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)throw new ValidationError('Automatic put-away instructions are paused or still in shadow mode.');
  if(chosenBy==='rule'){
   const rule=(await db.query(`SELECT *,authorized_at<=$4::timestamptz eligible_receipt FROM ${rules} WHERE workspace_id=$1 AND sku_id=$2 AND from_location_id=$3 FOR SHARE`,[ctx.workspaceId,fresh.source.skuId,fresh.source.from.id,fresh.source.receivedAt])).rows[0];
   if(!rule||!rule.eligible_receipt||rule.actor_id!==ctx.actorId||rule.to_location_id!==destinationId||rule.revision!==ruleRevision||cmp(rule.maximum_quantity,fresh.source.quantity)<0)throw new ValidationError('This receipt is outside the current taught product, receiving location, destination, quantity or start date.');
  }else{
   const now=await suggest(db,ctx,lineId);
   if(now.chosenBy!=='agent'||now.destinationId!==destinationId)throw new ValidationError(now.destinationId?'The bin StockChief would choose changed. It will check again.':now.reason);
  }
 }
 const prior=(await db.query(`SELECT id,fingerprint FROM ${relation} WHERE workspace_id=$1 AND receipt_line_id=$2`,[ctx.workspaceId,lineId])).rows[0];
 if(prior){if(prior.fingerprint!==fresh.fingerprint)throw new ValidationError('These saved instructions differ from the current source or destination. Review the original instruction before reissuing labels.');return {id:prior.id,replayed:true};}
 const id=newId('putaway');await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'putaway:'+id,Buffer.byteLength(JSON.stringify(fresh.source),'utf8')+8192,{finished:true});
 await db.query(`INSERT INTO ${relation}(id,workspace_id,receipt_line_id,actor_id,automatic,source,fingerprint,chosen_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,ctx.workspaceId,lineId,ctx.actorId,automatic,fresh.source,fresh.fingerprint,automatic?chosenBy:'owner',reason]);
 await db.query(`DELETE FROM ${holds} WHERE workspace_id=$1 AND receipt_line_id=$2`,[ctx.workspaceId,lineId]);
 await require('../operations/postgres-security-audit').record(db,ctx,{action:'Put-away instructions prepared',reference:fresh.source.order,after:{sku:fresh.source.sku,quantity:fresh.source.quantity,from:fresh.source.from.name,to:fresh.source.to.name,automatic,chosenBy:automatic?chosenBy:'owner',...(fresh.source.lot?{batch:fresh.source.lot.code}:{}),...(fresh.source.serials?.length?{serials:fresh.source.serials.map(s=>s.serial)}:{})}});
 return {id,replayed:false};
}
async function prepare(db,ctx,lineId,destinationId){return db.transaction(c=>createInTransaction(c,ctx,lineId,destinationId),{isolation:'SERIALIZABLE',retrySafe:true});}
async function progress(db,ctx,id){
 const rows=(await db.query(`SELECT c.*,l.name location_name,u.name confirmed_name FROM ${confirmations} c JOIN locations l ON l.workspace_id=c.workspace_id AND l.id=c.location_id
  LEFT JOIN users u ON u.workspace_id=c.workspace_id AND u.id=c.confirmed_by WHERE c.workspace_id=$1 AND c.instruction_id=$2 ORDER BY c.created_at,c.id`,[ctx.workspaceId,id])).rows;
 const quantity=rows.reduce((n,r)=>exact.add(n,r.quantity),'0'),secondary=rows.reduce((n,r)=>exact.add(n,r.secondary_quantity??'0'),'0');
 return {rows,quantity,secondary,serials:rows.flatMap(r=>r.serial_unit_ids||[])};
}
async function instruction(db,ctx,id){
 await access(db,ctx);const row=(await db.query(`SELECT * FROM ${relation} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('That put-away instruction is not in this inventory.');
 await require('../operations/postgres-warehouse-access').assertLocations(db,ctx,[row.source.from.id,row.source.to.id]);
 const done=await progress(db,ctx,id);
 if(row.status!=='PUT_AWAY'){const fresh=await facts(db,ctx,row.receipt_line_id,row.source.to.id,{putAway:done});if(fresh.fingerprint!==row.fingerprint)throw new ValidationError('The product, scan code, receipt or destination changed. Review these instructions before printing.');}
 const rule=(await db.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND sku_id=$2 AND from_location_id=$3`,[ctx.workspaceId,row.source.skuId,row.source.from.id])).rows[0];
 const remaining=exact.subtract(String(row.source.quantity),done.quantity);
 return {...row,rule,confirmations:done.rows,remaining,remainingSerials:(row.source.serials||[]).filter(s=>!done.serials.includes(s.id)),
  remainingWeight:row.source.secondaryQuantity==null?null:exact.subtract(String(row.source.secondaryQuantity),done.secondary)};
}
// Printable labels. Each is an inline Code 128 drawing the browser prints;
// no printer driver or plug-in is involved.
function labels(row){
 const p=row.source,measure=p.secondaryQuantity!=null?' · '+p.quantity+' '+(p.unit||'units')+' · '+p.secondaryQuantity+' '+p.secondaryUnit:p.unit?' · '+p.quantity+' '+p.unit:'';
 return [{title:'Product',subtitle:p.product+measure,barcode:p.barcode},
  ...(p.lot?[{title:'Batch',subtitle:p.lot.code+(p.lot.expiresAt?' · use by '+String(p.lot.expiresAt).slice(0,10):''),barcode:p.lot.code}]:[]),
  ...(p.serials||[]).map(s=>({title:'Serial',subtitle:p.product,barcode:s.serial})),
  {title:'Receiving location',subtitle:p.from.name,barcode:p.from.barcode},
  {title:'Destination bin',subtitle:p.to.name,barcode:p.to.barcode}];
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
 const maximum=Number(input.maximum);if(!Number.isSafeInteger(maximum)||cmp(String(maximum),String(example.source.quantity))<0||maximum>2147483647)throw new ValidationError('Choose a whole-unit limit covering this reviewed receipt.');
 await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],revision===0?1:0);
 const values=[...args,example.source.to.id,id,ctx.actorId,maximum];
 const changed=revision===0?await c.query(`INSERT INTO ${rules}(workspace_id,sku_id,from_location_id,to_location_id,example_id,actor_id,maximum_quantity) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,values):await c.query(`UPDATE ${rules} SET to_location_id=$4,example_id=$5,actor_id=$6,maximum_quantity=$7,revision=revision+1,authorized_at=now(),retry_after=now(),problem=NULL WHERE workspace_id=$1 AND sku_id=$2 AND from_location_id=$3 AND revision=$8`,[...values,revision]);
 if(!changed.rowCount)throw new ValidationError('The destination rule changed. Reload it.');
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Put-away destination taught',reference:example.source.sku,after:{from:example.source.from.name,to:example.source.to.name,maximum}});
},{isolation:'SERIALIZABLE',retrySafe:true});}
// Each planned receipt checks again, in its own transaction, that the person
// who turned routine work on is still an active owner.
async function routineGrant(db,workspaceId){
 return (await db.query(`SELECT updated_by,changed_at FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=47 AND mode='routine'`,[workspaceId])).rows[0];
}
// Routine planning. Growth uses only taught bins. Pro and Custom also choose
// bins themselves for receipts that arrive after the owner turned routine work
// on; a taught bin's lower limit still applies to its product.
async function run(db,workspaceId){
 const empty={prepared:0,held:0};
 const state=await policy.accountState(db,workspaceId);if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,47,'automatic',{trained:true}))return empty;
 if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate||await require('../autopilot/job-modes').restriction(db,workspaceId,47,true))return empty;
 const grant=await routineGrant(db,workspaceId);if(!grant)return empty;
 const alone=policy.permits(state.plan,47,'automatic');
 const rows=(await db.query(`SELECT rl.id,r.actor_id,r.revision FROM purchase_order_receipt_lines rl JOIN purchase_order_receipts receipt ON receipt.workspace_id=rl.workspace_id AND receipt.id=rl.receipt_id
  LEFT JOIN ${rules} r ON r.workspace_id=rl.workspace_id AND r.sku_id=rl.sku_id AND r.from_location_id=rl.location_id
  LEFT JOIN ${holds} h ON h.workspace_id=rl.workspace_id AND h.receipt_line_id=rl.id
  WHERE rl.workspace_id=$1 AND rl.location_id IS NOT NULL
  AND (r.workspace_id IS NOT NULL AND receipt.received_at::timestamptz>=r.authorized_at AND r.retry_after<=now()
   OR r.workspace_id IS NULL AND $2 AND receipt.received_at::timestamptz>=$3::timestamptz AND (h.retry_after IS NULL OR h.retry_after<=now()))
  AND NOT EXISTS(SELECT 1 FROM ${relation} p WHERE p.workspace_id=rl.workspace_id AND p.receipt_line_id=rl.id)
  ORDER BY receipt.received_at,rl.id LIMIT 20`,[workspaceId,alone,grant.changed_at])).rows;
 const result={...empty};for(const row of rows){const ctx={workspaceId,actorId:row.actor_id||grant.updated_by};try{
  const made=await db.transaction(async c=>{
   const current=(await c.query(`SELECT m.mode,m.changed_at,u.role FROM stockchief_runtime.agent_job_modes m JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.updated_by
    WHERE m.workspace_id=$1 AND m.job_id=47 AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) FOR SHARE OF m,u`,[workspaceId])).rows[0];
   if(current?.mode!=='routine'||current.role!=='owner')throw new ValidationError('The owner stopped automatic put-away preparation.');
   const choice=await suggest(c,ctx,row.id);if(!choice.destinationId)throw new ValidationError(choice.reason);
   if(choice.chosenBy==='rule')return createInTransaction(c,ctx,row.id,choice.destinationId,{automatic:true,ruleRevision:row.revision,chosenBy:'rule',reason:choice.reason});
   return createInTransaction(c,ctx,row.id,choice.destinationId,{automatic:true,chosenBy:'agent',reason:choice.reason});
  },{isolation:'SERIALIZABLE',retrySafe:true});if(!made.replayed)result.prepared++;
 }catch(error){if(!['validation_error','entitlement_required','forbidden'].includes(error.code))throw error;result.held++;
  if(row.actor_id)await db.query(`UPDATE ${rules} SET problem=$4,retry_after=now()+interval '15 minutes' WHERE workspace_id=$1 AND actor_id=$2 AND revision=$3 AND sku_id=(SELECT sku_id FROM purchase_order_receipt_lines WHERE id=$5) AND from_location_id=(SELECT location_id FROM purchase_order_receipt_lines WHERE id=$5)`,[workspaceId,row.actor_id,row.revision,error.message,row.id]);
  else await db.query(`INSERT INTO ${holds}(workspace_id,receipt_line_id,problem,retry_after) VALUES($1,$2,$3,now()+interval '15 minutes') ON CONFLICT(workspace_id,receipt_line_id) DO UPDATE SET problem=EXCLUDED.problem,retry_after=EXCLUDED.retry_after`,[workspaceId,row.id,error.message]);}}
 return result;
}
// The owner changes the bin before anything is put away. This also undoes a
// bin StockChief chose, and takes over a plan paused automation left behind.
async function replan(db,ctx,id,input){return db.transaction(async c=>{
 await access(c,ctx,{owner:true});
 const stopped=await require('../autopilot/job-modes').restriction(c,ctx.workspaceId,47,false);if(stopped)throw new ValidationError(stopped);
 const row=(await c.query(`SELECT * FROM ${relation} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('That put-away instruction is not in this inventory.');
 if(Number(input.revision)!==row.revision)throw new ValidationError('This put-away plan changed. Reload it.');
 if(row.status!=='READY'||cmp(row.put_away_quantity,'0')!==0)throw new ValidationError('Staff have started putting these goods away. Move stock that is already in a bin with a bin correction.');
 const fresh=await facts(c,ctx,row.receipt_line_id,String(input.destination||''),{lock:true});
 await c.query(`UPDATE ${relation} SET source=$3,fingerprint=$4,actor_id=$5,automatic=false,chosen_by='owner',reason=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,fresh.source,fresh.fingerprint,ctx.actorId]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Put-away bin confirmed by the owner',reference:fresh.source.order,before:{to:row.source.to.name,chosenBy:row.chosen_by},after:{to:fresh.source.to.name}});
 return {id};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function staff(db,ctx){
 const user=(await db.query(`SELECT u.* FROM users u JOIN workspaces w ON w.id=u.workspace_id WHERE u.workspace_id=$1 AND u.id=$2 AND w.deletion_requested_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) FOR SHARE OF u`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!user)throw new AuthorizationError('Your inventory membership could not be verified.');
 for(const p of [P.OPERATE,P.REQUEST_TRANSFER,P.PICK_TRANSFER,P.DISPATCH_TRANSFER,P.RECEIVE_TRANSFER])P.assertCan(user,p,'confirm a put-away');
 return user;
}
function serialList(value){return [...new Set(String(value||'').split(/[\r\n,]+/).map(v=>v.trim()).filter(Boolean))];}
// Staff confirm one put-away by scanning the product and bin, or by tapping.
// The goods land in the bin through an ordinary bin transfer that keeps their
// batch, serial numbers, weight and cost. A scan of another bin is accepted
// only when staff confirm the goods really went there.
async function confirm(db,ctx,id,input){return db.transaction(async c=>{
 await staff(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,47,'draft');
 const key=String(input.requestKey||'');if(!/^[\w-]{8,160}$/.test(key))throw new ValidationError('Open the put-away sheet again before confirming.');
 const replay=(await c.query(`SELECT id,instruction_id,location_id,planned_location_id FROM ${confirmations} WHERE workspace_id=$1 AND request_key=$2`,[ctx.workspaceId,key])).rows[0];
 if(replay){if(replay.instruction_id!==id)throw new ValidationError('Open the put-away sheet again before confirming.');return {id:replay.id,instructionId:id,replayed:true,wrongBin:replay.location_id!==replay.planned_location_id};}
 const row=(await c.query(`SELECT * FROM ${relation} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('That put-away instruction is not in this inventory.');
 const access=require('../operations/postgres-warehouse-access');await access.assertLocations(c,ctx,[row.source.from.id,row.source.to.id]);
 if(row.status==='PUT_AWAY')throw new ValidationError('These goods are already put away.');
 if(row.automatic){
  const state=await policy.accountState(c,ctx.workspaceId),why=!policy.permits(state.plan,47,'automatic',{trained:row.chosen_by==='rule'})?'Your plan no longer lets StockChief choose bins on its own.':
   !(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate?'Automatic work is paused or in its first 14 days.':await require('../autopilot/job-modes').restriction(c,ctx.workspaceId,47,true);
  if(why)throw new ValidationError(why+' Ask the owner to confirm this put-away plan first.');
 }
 const done=await progress(c,ctx,id),fresh=await facts(c,ctx,row.receipt_line_id,row.source.to.id,{lock:true,putAway:done});
 if(fresh.fingerprint!==row.fingerprint)throw new ValidationError('The product, scan code, receipt or bin changed. Ask the owner to review this put-away plan.');
 const p=fresh.source,item=fresh.item,method=input.method==='tap'?'tap':'scan';let binId=p.to.id;
 if(method==='tap'){if(input.confirmed!=='yes')throw new ValidationError('Tap to confirm you put these goods in '+p.to.name+'.');}
 else{
  if(String(input.productCode||'').trim()!==p.barcode)throw new ValidationError('Scan the product label shown on this sheet.');
  const code=String(input.binCode||'').trim();
  if(code!==p.to.barcode){
   let other;try{other=await require('../operations/postgres-fulfillment-waves').resolveIdentity(c,ctx.workspaceId,code,'location',{label:'Bin code'});}catch{throw new ValidationError('That bin code does not match one bin. Scan the bin label again.');}
   const place=(await c.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,other])).rows[0];
   if(!place||place.id===p.from.id||await site(c,ctx.workspaceId,place.id)!==await site(c,ctx.workspaceId,p.from.id))throw new ValidationError('That bin is not at this warehouse. Put the goods in '+p.to.name+'.');
   if(input.wrongBin!=='yes')throw new ValidationError('You scanned '+place.name+'. The plan says '+p.to.name+'. Put the goods in '+p.to.name+', or confirm they went into '+place.name+'.');
   await access.assertLocations(c,ctx,[place.id]);binId=place.id;
  }
 }
 const remaining=exact.subtract(String(p.quantity),done.quantity);let quantity,secondary=null,serialIds=[];
 if(p.serials?.length){
  const waiting=p.serials.filter(s=>!done.serials.includes(s.id)),chosen=serialList(input.serials);
  const picked=chosen.length?chosen.map(code=>waiting.find(s=>s.serial.toLowerCase()===code.toLowerCase())):waiting;
  if(!picked.length||picked.some(s=>!s))throw new ValidationError('Scan serial numbers from this receipt that are still waiting to be put away.');
  serialIds=picked.map(s=>s.id);quantity=serialIds.length;
  if(p.secondaryQuantity!=null)secondary=(await c.query('SELECT coalesce(sum(secondary_quantity),0)::text w FROM serial_units WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,serialIds])).rows[0].w;
 }else{
  quantity=String(input.quantity??'').trim()===''?exact.safeNumber(remaining):units.validate(item,input.quantity,{label:'Quantity put away'});
  if(cmp(String(quantity),remaining)>0)throw new ValidationError('Only '+remaining+' '+(p.unit||'units')+' are still waiting to be put away.');
  if(p.secondaryQuantity!=null){
   const left=exact.subtract(String(p.secondaryQuantity),done.secondary);
   secondary=cmp(String(quantity),remaining)===0?left:String(units.secondary(item,input.weight,{label:'Actual '+p.secondaryUnit+' put away'}));
   if(cmp(secondary,left)>0||cmp(String(quantity),remaining)<0&&cmp(secondary,left)>=0)throw new ValidationError('Enter the actual '+p.secondaryUnit+' of the part you put away.');
  }
 }
 const approver=(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner'
  AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)`,[ctx.workspaceId,row.actor_id])).rows[0];
 if(!approver)throw new ValidationError('The owner who approved this plan no longer has access. Ask the owner to confirm the plan again.');
 const confirmationId=newId('putawaydone'),base='putaway:'+confirmationId,transfers=require('../transfers/postgres-transfer-service');
 const transfer=await transfers.requestInTransaction(c,ctx,{fromLocationId:p.from.id,toLocationId:binId,reference:p.order,reason:'Put-away',notes:'Put-away of received goods',idempotencyKey:base+':request',skipDefaultDemandPegs:true,
  lines:[{skuId:p.skuId,quantity,secondaryQuantity:secondary,lotId:p.lot?.id||null,serialUnitIds:serialIds}]});
 const approverCtx={workspaceId:ctx.workspaceId,actorId:approver.id};
 await transfers.approveInTransaction(c,approverCtx,transfer.id,{idempotencyKey:base+':approve'});
 await transfers.pickInTransaction(c,ctx,transfer.id,{idempotencyKey:base+':pick'});
 await transfers.dispatchInTransaction(c,ctx,transfer.id,{idempotencyKey:base+':dispatch'});
 await transfers.receiveInTransaction(c,ctx,transfer.id,{idempotencyKey:base+':receive',lines:[{lineId:transfer.lines[0].id,received:quantity,lost:0,damaged:0,receivedSecondaryQuantity:secondary,receivedSerialUnitIds:serialIds}]});
 const proof=await transfers.verify(c,ctx.workspaceId,transfer.id);if(!proof.ok||proof.transfer.status!=='RECEIVED')throw new ValidationError('The put-away transfer did not reconcile its stock.');
 await c.query(`INSERT INTO ${confirmations}(id,workspace_id,instruction_id,request_key,transfer_id,location_id,planned_location_id,quantity,secondary_quantity,lot_id,serial_unit_ids,method,confirmed_by,approved_by)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[confirmationId,ctx.workspaceId,id,key,transfer.id,binId,p.to.id,quantity,secondary,p.lot?.id||null,JSON.stringify(serialIds),method,ctx.actorId,approver.id]);
 const total=exact.add(done.quantity,String(quantity)),finished=cmp(total,String(p.quantity))===0;
 await c.query(`UPDATE ${relation} SET put_away_quantity=$3,status=$4 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,total,finished?'PUT_AWAY':'READY']);
 const place=binId===p.to.id?p.to.name:(await c.query('SELECT name FROM locations WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,binId])).rows[0].name;
 await require('../operations/postgres-security-audit').record(c,ctx,{action:binId===p.to.id?'Put-away confirmed':'Put-away confirmed in a different bin',reference:p.order,
  after:{sku:p.sku,quantity,bin:place,planned:p.to.name,method,transfer:transfer.transfer_number,...(p.lot?{batch:p.lot.code}:{}),...(serialIds.length?{serials:p.serials.filter(s=>serialIds.includes(s.id)).map(s=>s.serial)}:{}),...(secondary!=null?{measured:secondary}:{})}});
 // Goods in another bin than planned are a wrong put-away for job 11 to move
 // to the planned bin, where the plan allows it.
 const correction=binId===p.to.id?null:await require('./agent-bin-corrections').fromPutaway(c,ctx,{source:p,binId,quantity,serialIds,confirmationId,instructionId:id});
 return {id:confirmationId,instructionId:id,replayed:false,finished,wrongBin:binId!==p.to.id,binId,transferId:transfer.id,correctionId:correction?.id||null};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function review(db,ctx,{page=1,filter=''}){
 await access(db,ctx,{owner:true});
 const receipts=(await db.query(`SELECT rl.id,po.po_number,sku.code,i.name,rl.quantity_units::text quantity,l.name location,p.id instruction_id,p.status,h.problem
  FROM purchase_order_receipt_lines rl JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id JOIN purchase_orders po ON po.workspace_id=r.workspace_id AND po.id=r.purchase_order_id
  JOIN skus sku ON sku.workspace_id=rl.workspace_id AND sku.id=rl.sku_id JOIN items i ON i.workspace_id=sku.workspace_id AND i.id=sku.item_id
  JOIN locations l ON l.workspace_id=rl.workspace_id AND l.id=rl.location_id LEFT JOIN ${relation} p ON p.workspace_id=rl.workspace_id AND p.receipt_line_id=rl.id
  LEFT JOIN ${holds} h ON h.workspace_id=rl.workspace_id AND h.receipt_line_id=rl.id
  WHERE rl.workspace_id=$1 AND ($2='' OR po.po_number ILIKE '%'||$2||'%' OR sku.code ILIKE '%'||$2||'%' OR i.name ILIKE '%'||$2||'%')
  ORDER BY r.received_at DESC,rl.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 const destinations=await require('../domain/postgres-location-service').listHierarchy(db,ctx.workspaceId,{includeStock:false});
 const saved=(await db.query(`SELECT s.code,f.name from_name,d.name to_name,r.maximum_quantity,r.problem,r.example_id,r.revision FROM ${rules} r JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id JOIN locations f ON f.workspace_id=r.workspace_id AND f.id=r.from_location_id JOIN locations d ON d.workspace_id=r.workspace_id AND d.id=r.to_location_id WHERE r.workspace_id=$1 ORDER BY s.code LIMIT 100`,[ctx.workspaceId])).rows;
 const blocked=await require('../autopilot/job-modes').restriction(db,ctx.workspaceId,47,false),open=receipts.slice(0,100).filter(r=>!r.instruction_id);
 const suggestions=[];for(const r of open.slice(0,20)){let s;try{s=await suggest(db,ctx,r.id);}catch(error){if(error.code!=='validation_error')throw error;s={destinationId:null,reason:error.message};}
  const bin=s.destinationId?(await db.query('SELECT name FROM locations WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,s.destinationId])).rows[0]?.name:null;
  suggestions.push({receiptLineId:r.id,label:r.po_number+' · '+r.code+' · '+r.quantity+' at '+r.location,destinationId:s.destinationId,destination:bin,reason:r.problem||s.reason});}
 return {summary:'Print product, batch, serial and bin labels for goods actually received, then staff confirm each put-away by scanning or tapping on their phone. StockChief suggests a bin: a taught bin, a bin that already holds the product, or the nearest empty bin. Growth confirms each suggestion until a bin is taught. Pro and Custom choose bins on their own once you turn on routine work for this job. Preparing or printing never moves stock; the staff confirmation does.',
  rows:receipts.slice(0,100).map(r=>({Order:r.po_number,Product:r.name,SKU:r.code,Quantity:r.quantity,'Received at':r.location,...(r.instruction_id?{Status:r.status==='PUT_AWAY'?'Put away':'Ready',link:'/warehouse/putaway/'+r.instruction_id}:{Status:r.problem?'Needs a bin':'Not planned'})})),more:receipts.length>100,
  putawayForm:{receipts:open,suggestions,destinations:destinations.filter(l=>!l.custody_agreement_id),rules:saved,blocked}};
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
 let destination;
 if(String(args.location||'').trim()){const dest=(await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND (id=$2 OR lower(name)=lower($2)) AND is_active=1 LIMIT 2',[ctx.workspaceId,String(args.location)])).rows;
  if(dest.length!==1)throw new ValidationError('Choose one exact destination bin from this inventory.');destination=dest[0].id;}
 else{const s=await suggest(db,ctx,lines[0].id);if(!s.destinationId)throw new ValidationError(s.reason);destination=s.destinationId;}
 const fresh=await facts(db,ctx,lines[0].id,destination),rule=await hasRule(db,ctx.workspaceId,fresh.source.skuId,fresh.source.from.id,fresh.source.receivedAt);
 const payload={recordId:po.id,source:fresh.source,fingerprint:fresh.fingerprint,ruleRevision:rule?.revision||0,needsPutawayConfirmation:!rule||!rule.eligible_receipt||rule.to_location_id!==destination||cmp(rule.maximum_quantity,String(fresh.source.quantity))<0};
 return {payload,summary:'Prepare printable labels and instructions for '+fresh.source.quantity+' '+(fresh.source.unit||'units')+' of '+fresh.source.product+' received on '+fresh.source.order+', from '+fresh.source.from.name+' to '+fresh.source.to.name+'. This does not record physical movement.'};
}
async function execute(db,ctx,p){
 const fresh=await facts(db,ctx,p.source.receiptLineId,p.source.to.id,{lock:true});if(fresh.fingerprint!==p.fingerprint)throw new ValidationError('The received product or destination changed. Review fresh put-away instructions.');
 const automatic=ctx.agentPutawayScope==='automatic';
 const result=await createInTransaction(db,ctx,p.source.receiptLineId,p.source.to.id,{automatic,ruleRevision:p.ruleRevision,chosenBy:automatic?'rule':'owner'});return {...result,href:'/warehouse/putaway/'+result.id};
}
module.exports={prepare,instruction,labels,suggest,teach,run,replan,confirm,review,trained,definition:{id:47,key:'putaway-labels',label:'Prepare put-away instructions and labels',filterLabel:'Purchase order, product or SKU',readPage:review},
 spec:{name:'warehouse.prepare_putaway',agentJob:47,record:'purchase_order',fields:['recordReference','sku','location'],ownerOnly:true,permission:P.OPERATE,capability:'inventory.core',resultingRecords:['stockchief_runtime.agent_putaway_instructions'],
 description:'Prepare printable product, batch, serial and location labels plus put-away directions for one actual received product on a purchase order. Supply its exact SKU and, optionally, a destination bin at the same site; without one, StockChief suggests the bin. Multiple deliveries need their individual receipt line on the put-away page. Automatic work needs the current owner-taught destination and quantity limit. Never confirms physical work or moves stock.',build,execute,
 verify:async(db,ctx,r,p)=>Boolean((await db.query(`SELECT 1 FROM ${relation} WHERE workspace_id=$1 AND id=$2 AND receipt_line_id=$3 AND fingerprint=$4`,[ctx.workspaceId,r.id,p.source.receiptLineId,p.fingerprint])).rowCount)}};

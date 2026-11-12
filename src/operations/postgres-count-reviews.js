'use strict';
const {createHash}=require('node:crypto');
const {ValidationError,NotFoundError}=require('../domain/errors');
const {newId}=require('../lib/util');
const permissions=require('../actions/permissions');
const exact=require('../domain/exact-quantity');
const stable=value=>value&&typeof value==='object'?Array.isArray(value)?'['+value.map(stable).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}':JSON.stringify(value);
const digest=value=>createHash('sha256').update(stable(value)??'null').digest('hex');
async function authorize(db,ctx,approve=false){
 const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 permissions.assertCan(actor,permissions.ADJUST,'record physical counts');
 if(approve&&actor?.role!=='owner')throw new ValidationError('An owner must approve the count variances.');
 await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'inventory.counts');
}
async function positions(db,ctx,locationId,skuIds){
 return (await db.query(`SELECT s.id,s.code,s.variant_label,i.name,i.tracking_mode,i.secondary_unit_label,i.quantity_precision,i.quantity_increment,
 coalesce(b.on_hand,0)::text AS physical,coalesce(c.quantity_units,0)::text AS costed,coalesce(c.total_cost_minor,0)::text AS value,
 coalesce((SELECT max(m.seq)::text FROM movements m WHERE m.workspace_id=s.workspace_id AND m.sku_id=s.id AND m.location_id=$3),'0') AS last_movement
 FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 LEFT JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id AND b.location_id=$3
 LEFT JOIN accounting_inventory_cost_balances c ON c.workspace_id=s.workspace_id AND c.sku_id=s.id AND c.location_id=$3
 WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 ORDER BY s.id`,[ctx.workspaceId,skuIds,locationId])).rows;
}
async function prepare(db,ctx,input){return db.transaction(async c=>{
 await authorize(c,ctx);const supplied=(Array.isArray(input.lines)?input.lines:Object.values(input.lines||{})).filter(l=>String(l.quantity??'').trim()!=='');
 if(!supplied.length||supplied.length>500||new Set(supplied.map(l=>l.skuId)).size!==supplied.length)throw new ValidationError('Enter counts for between 1 and 500 different variants.');
 const location=(await c.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,input.locationId])).rows[0];
 if(!location)throw new ValidationError('Choose an active location from this inventory.');
 await require('./postgres-warehouse-access').assertLocations(c,ctx,[location.id]);
 const key=input.submissionKey??null;
 if(key!==null&&(typeof key!=='string'||!key.trim()||key.length>140))throw new ValidationError('Open a fresh count form before submitting.');
 const submissionHash=digest({location:location.id,reference:String(input.reference||''),lines:supplied});
 async function replay(){
  const {rows:[prior]}=await c.query('SELECT id,submission_hash FROM physical_count_reviews WHERE workspace_id=$1 AND created_by_user_id=$2 AND submission_key=$3',[ctx.workspaceId,ctx.actorId,key]);
  if(prior&&prior.submission_hash!==submissionHash)throw new ValidationError('This count was already submitted. Open a new form for a different count.');
  return prior?{id:prior.id}:null;
 }
 if(key){const prior=await replay();if(prior)return prior;}
 const current=await positions(c,ctx,location.id,supplied.map(l=>l.skuId));if(current.length!==supplied.length)throw new ValidationError('Every counted variant must be active in this inventory.');
 const currency=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency;
 if(!currency)throw new ValidationError('Set up your stock currency before reviewing a count.');
 const lines=[];
 for(const row of current){
  if(row.tracking_mode!=='quantity'||row.secondary_unit_label)throw new ValidationError('Count lots, serials and measured stock from the product page, where their exact identities or weight can be recorded.');
  const raw=supplied.find(l=>l.skuId===row.id),quantity=require('../domain/stock-quantity').validate(row,raw.quantity,{positive:false}),delta=exact.safeNumber(exact.subtract(quantity,row.physical),{signed:true});
  let unitCostMinor=null,costDeltaMinor=0;
  if(delta<0){if(Number(row.costed)!==Number(row.physical))throw new ValidationError('Record the missing purchase cost for '+row.code+' before reducing its count.');costDeltaMinor=-exact.ratioMinor(Number(row.value),-delta,row.costed);}
  if(delta>0){const explicit=String(raw.unitCost??'').trim();const saved=explicit?null:await require('../pricing/postgres-service').purchaseCost(c,ctx.workspaceId,row.id);
   if(!explicit&&(!saved||saved.currency!==currency))throw new ValidationError('Enter a purchase cost for the additional units of '+row.code+'.');
   unitCostMinor=explicit?require('../domain/currency').toMinor(explicit,currency,{label:'Unit cost'}):Number(saved.amount_minor);costDeltaMinor=exact.costMinor(delta,unitCostMinor);
  }
  lines.push({skuId:row.id,label:row.name+(row.variant_label?' — '+row.variant_label:''),code:row.code,quantity,delta,costDeltaMinor,unitCostMinor,before:row});
 }
 const payload={location,currency,reference:String(input.reference||'').trim().slice(0,160),lines},id=newId('countreview'),integrityHash=digest(payload);
 const decision=await require('../autopilot/count-rules').evaluate(c,ctx,payload,supplied);
 const effective=decision?.action==='post'&&!key?null:decision;
 const inserted=await c.query(`INSERT INTO physical_count_reviews(id,workspace_id,created_by_user_id,payload,integrity_hash,recount_required,agent_decision,submission_key,submission_hash)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,created_by_user_id,submission_key) DO NOTHING`,
  [id,ctx.workspaceId,ctx.actorId,payload,integrityHash,effective?.action==='recount',effective,key,key?submissionHash:null]);
 if(!inserted.rowCount)return replay();
 // A count that pairs with another bin's count as one bin mix-up becomes a
 // bin correction instead of a write-off and a found-stock adjustment.
 const paired=await require('../warehouse/agent-bin-corrections').fromCount(c,ctx,id);
 if(effective?.action==='post'&&!paired)await post(c,{...ctx,actorId:effective.owner},id,integrityHash);
 return {id};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function get(db,ctx,id){await authorize(db,ctx);const row=(await db.query('SELECT * FROM physical_count_reviews WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('This count review is not in this inventory.');await require('./postgres-warehouse-access').assertLocations(db,ctx,[row.payload.location.id]);return row;}
async function assertUnchanged(db,ctx,review,message){
 const current=await positions(db,ctx,review.payload.location.id,review.payload.lines.map(line=>line.skuId));
 const byId=new Map(current.map(row=>[row.id,row]));
 if(review.payload.lines.some(line=>digest(byId.get(line.skuId))!==digest(line.before)))throw new ValidationError(message);
}
async function post(c,ctx,id,integrityHash){
 await authorize(c,ctx,true);const review=(await c.query('SELECT * FROM physical_count_reviews WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
 if(!review||review.integrity_hash!==integrityHash||digest(review.payload)!==integrityHash)throw new ValidationError('Open the current count review before approving.');
 if(review.status==='COMPLETED')return {replayed:true,...review.result};if(review.status!=='PENDING')throw new ValidationError('This count is no longer awaiting approval.');
 if(review.recount_required&&!review.recounted_at)throw new ValidationError('Count these items again before approving this difference.');
 if((await c.query("SELECT 1 FROM stockchief_runtime.agent_bin_corrections WHERE workspace_id=$1 AND status IN ('PROPOSED','OPEN','SCANNED') AND evidence->'reviews' @> jsonb_build_array($2::text) LIMIT 1",[ctx.workspaceId,id])).rowCount)throw new ValidationError('This count found stock in another bin. Settle its bin correction first.');
 await assertUnchanged(c,ctx,review,'Stock or cost changed after this count was reviewed. Enter a new count before approving.');
 const results=[];for(const line of review.payload.lines)results.push(await require('../accounting/postgres-physical-count').applyInTransaction(c,ctx,{skuId:line.skuId,locationId:review.payload.location.id,countedQuantity:line.quantity,unitCostMinor:line.unitCostMinor,expectedBefore:{physical:Number(line.before.physical),costed:Number(line.before.costed),value:Number(line.before.value)},expectedCostDeltaMinor:line.costDeltaMinor,reasonCode:'cycle_count',reference:review.payload.reference,sourceType:'physical_count_review',sourceRecordId:id,idempotencyKey:'count-review:'+id+':'+line.skuId,currency:review.payload.currency}));
 const result={lines:results.length,changed:results.filter(r=>!r.unchanged).length};
 await c.query("UPDATE physical_count_reviews SET status='COMPLETED',approved_at=now(),approved_by_user_id=$3,result=$4 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,ctx.actorId,result]);return {replayed:false,...result};
}
async function approve(db,ctx,id,integrityHash){
 return db.transaction(c=>post(c,ctx,id,integrityHash),{isolation:'SERIALIZABLE',retrySafe:true});
}
async function recount(db,ctx,id,quantities){
 return db.transaction(async c=>{
  await authorize(c,ctx);
  const {rows:[review]}=await c.query('SELECT * FROM physical_count_reviews WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id]);
  if(!review)throw new NotFoundError('This count review is not in this inventory.');
  await require('./postgres-warehouse-access').assertLocations(c,ctx,[review.payload.location.id]);
  if(review.status!=='PENDING'||!review.recount_required)throw new ValidationError('This count does not need a recount.');
  if(review.recounted_at)return;
  await assertUnchanged(c,ctx,review,'Stock or cost changed before this recount. Start a new physical count.');
  for(const line of review.payload.lines.filter(line=>line.delta!==0)){
   const value=quantities?.[line.skuId];
   if(value==null||String(value).trim()===''||exact.canonical(value)!==exact.canonical(line.quantity))
    throw new ValidationError('The recount differs. Start a new physical count with the quantities you found.');
  }
  await c.query('UPDATE physical_count_reviews SET recounted_at=now(),recounted_by=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,ctx.actorId]);
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={prepare,get,approve,recount,positions,snapshotHash:digest};

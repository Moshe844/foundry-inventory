'use strict';
const {ValidationError,NotFoundError,AuthorizationError}=require('../domain/errors'),{newId}=require('../lib/util'),permissions=require('../actions/permissions'),access=require('./postgres-warehouse-access'),exact=require('../domain/exact-quantity');
const observations=require('./agent-count-observations');
async function authorize(c,ctx,approval=false){
 const actor=(await c.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];permissions.assertCan(actor,permissions.ADJUST,'record physical counts');
 if(approval&&actor.role!=='owner')throw new ValidationError('An owner must approve all count variances.');
 await require('../commercial/enforcement').workspace(c,ctx.workspaceId,'inventory.counts');
}
async function header(c,ctx,id,lock=false){
 const row=(await c.query('SELECT * FROM warehouse_count_campaigns WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
 if(!row)throw new NotFoundError('This count worksheet is not in this inventory.');
 const assigned=(await c.query('SELECT counter_id,observed_at FROM stockchief_runtime.agent_count_tasks WHERE workspace_id=$1 AND campaign_id=$2',[ctx.workspaceId,id])).rows[0];
 if(assigned){
  await require('./agent-count-tasks').assertOwner(c,ctx,lock);
  await require('../commercial/agent-plan').requireWorkspaceJob(c,ctx.workspaceId,7,'draft');
 }
 await access.assertLocations(c,ctx,row.scope.locationIds);
 await require('./agent-annual-stocktakes').assertCampaign(c,ctx,id,{lock,readOnly:!lock});
 return assigned?{...row,assigned}:row;
}
async function create(db,ctx,input,options={}){return db.transaction(async c=>{
 await authorize(c,ctx);await access.assertLocations(c,ctx,[input.locationId]);
 let locations=await access.locations(c,ctx.workspaceId,[input.locationId]);if(options.exactLocation)locations=locations.filter(l=>l.id===input.locationId);if(!locations.length)throw new ValidationError('Choose an active warehouse, zone or bin.');
 const category=String(input.category||'').trim().slice(0,120),title=String(input.title||'Physical stock count').trim().slice(0,160),id=newId('countsheet'),ids=locations.map(l=>l.id);
 await c.query('INSERT INTO warehouse_count_campaigns(id,workspace_id,created_by_user_id,title,scope) VALUES($1,$2,$3,$4,$5)',[id,ctx.workspaceId,ctx.actorId,title,
  {locationIds:ids,category,tracking:options.includeTracking?'stock':'quantity'}]);
 await c.query(`INSERT INTO warehouse_count_campaign_lines(workspace_id,campaign_id,sku_id,location_id,before_quantity,before_costed,before_value,balance_version,cost_version)
 SELECT b.workspace_id,$2,b.sku_id,b.location_id,b.on_hand,coalesce(v.quantity_units,0),coalesce(v.total_cost_minor,0),b.updated_at,coalesce(v.updated_at,'')
 FROM balances b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 LEFT JOIN accounting_inventory_cost_balances v ON v.workspace_id=b.workspace_id AND v.sku_id=b.sku_id AND v.location_id=b.location_id
 WHERE b.workspace_id=$1 AND b.location_id=ANY($3::text[]) AND s.is_active=1 AND i.is_active=1
 AND ($6 OR (i.tracking_mode='quantity' AND i.secondary_unit_label IS NULL))
 AND ($5::boolean IS FALSE OR i.quantity_precision=0) AND ($4='' OR EXISTS(SELECT 1 FROM catalogue_item_facts f WHERE f.workspace_id=i.workspace_id AND f.item_id=i.id AND lower(f.category)=lower($4)))`,[ctx.workspaceId,id,ids,category,Boolean(options.exactLocation),Boolean(options.includeTracking)]);
 return {id};
 },{isolation:'REPEATABLE READ',retrySafe:true});}
async function page(db,ctx,id,{afterLocation='',afterSku='',includeTotals=true,limit=100}={}){
 limit=Math.max(1,Math.min(1000,Number(limit)||100));
 await authorize(db,ctx);const campaign=await header(db,ctx,id),rows=(await db.query(`SELECT l.*,s.code,s.variant_label,i.name,i.id item_id,i.unit_label,i.secondary_unit_label,
 loc.name location_name,coalesce(l.counter_recorded_name,counter.name) counter_name,e.before_count,e.observation,e.reviewed_at
 FROM warehouse_count_campaign_lines l JOIN skus s ON s.id=l.sku_id JOIN items i ON i.id=s.item_id JOIN locations loc ON loc.id=l.location_id
 LEFT JOIN users counter ON counter.workspace_id=l.workspace_id AND counter.id=l.counter_recorded_by
 LEFT JOIN stockchief_runtime.agent_count_position_evidence e ON e.campaign_id=l.campaign_id AND e.location_id=l.location_id AND e.sku_id=l.sku_id
 WHERE l.workspace_id=$1 AND l.campaign_id=$2 AND (l.location_id,l.sku_id)>($3,$4) ORDER BY l.location_id,l.sku_id LIMIT $5`,[ctx.workspaceId,id,afterLocation,afterSku,limit+1])).rows;
 const totals=includeTotals?(await db.query(`SELECT count(*)::int positions,
 count(*) FILTER(WHERE l.counted_quantity IS NULL)::int uncounted,
 count(*) FILTER(WHERE l.counted_quantity IS NOT NULL AND (l.counted_quantity<>l.before_quantity OR
   (e.observation IS NOT NULL AND ((e.observation->>'secondary')::numeric IS DISTINCT FROM (e.before_count->>'secondary')::numeric OR EXISTS(
     SELECT 1 FROM jsonb_to_recordset(e.observation->'entries') seen(code text,quantity numeric,secondary numeric)
     FULL JOIN jsonb_to_recordset(e.before_count->'entries') recorded(code text,quantity numeric,secondary numeric) USING(code)
     WHERE seen.code IS DISTINCT FROM recorded.code OR seen.quantity IS DISTINCT FROM recorded.quantity
     OR seen.secondary IS DISTINCT FROM recorded.secondary
   )))))::int variances,
 count(*) FILTER(WHERE l.applied_at IS NOT NULL)::int applied,coalesce(sum(l.cost_delta_minor),0)::text cost_delta_minor,
 count(l.counter_quantity)::int staff_observed FROM warehouse_count_campaign_lines l
 LEFT JOIN stockchief_runtime.agent_count_position_evidence e ON e.campaign_id=l.campaign_id AND e.location_id=l.location_id AND e.sku_id=l.sku_id
 WHERE l.workspace_id=$1 AND l.campaign_id=$2`,[ctx.workspaceId,id])).rows[0]:null;
 if(totals&&!campaign.assigned)delete totals.staff_observed;
 const currency=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency;
 const shown=rows.slice(0,limit),tracked=shown.filter(r=>r.before_count);
 if(tracked.length){
  const pairs=JSON.stringify(tracked.map(({location_id,sku_id})=>({location_id,sku_id})));
  const current=new Map((await observations.current(db,ctx.workspaceId,id,pairs)).map(r=>[JSON.stringify([r.location_id,r.sku_id]),r.evidence]));
  for(const row of tracked){
   row.live_count=current.get(JSON.stringify([row.location_id,row.sku_id]))||null;
   row.matches_original=observations.matches(row.observation,row.before_count);
   row.matches_current=observations.matches(row.observation,row.live_count);
  }
 }
 return {campaign,currency,rows:shown,totals,next:rows.length>limit?rows[limit-1]:null};
}
async function save(db,ctx,id,input){return db.transaction(async c=>{
 await authorize(c,ctx);const campaign=await header(c,ctx,id,true);
 if(campaign.status!=='DRAFT'||Number(input.revision)!==campaign.revision)throw new ValidationError('This count worksheet changed. Reload before saving.');
 const lines=(Array.isArray(input.lines)?input.lines:Object.values(input.lines||{})).filter(l=>String(l.quantity??'').trim()!=='');
 if(!lines.length||lines.length>1000)throw new ValidationError('Enter between 1 and 1,000 counts per save. Blank quantities stay uncounted.');
 const supplied=lines.map((l,position)=>({position,sku_id:String(l.skuId||''),location_id:String(l.locationId||''),sku_code:String(l.skuCode||''),location_name:String(l.locationName||'')}));
 const current=(await c.query(`SELECT x.position,l.*,i.quantity_precision,i.quantity_increment,pc.amount_minor saved_cost,pc.currency saved_currency,
 EXISTS(SELECT 1 FROM stockchief_runtime.agent_count_position_evidence e WHERE e.campaign_id=l.campaign_id AND e.location_id=l.location_id AND e.sku_id=l.sku_id) has_evidence
 FROM jsonb_to_recordset($3::jsonb) x(position integer,sku_id text,location_id text,sku_code text,location_name text)
 JOIN locations loc ON loc.workspace_id=$1 AND ((x.location_id<>'' AND loc.id=x.location_id) OR(x.location_id='' AND loc.name=x.location_name))
 JOIN skus s ON s.workspace_id=$1 AND ((x.sku_id<>'' AND s.id=x.sku_id) OR(x.sku_id='' AND s.code=x.sku_code))
 JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 JOIN warehouse_count_campaign_lines l ON l.workspace_id=$1 AND l.campaign_id=$2 AND l.sku_id=s.id AND l.location_id=loc.id
 LEFT JOIN LATERAL(SELECT amount_minor,currency FROM sku_purchase_costs p WHERE p.workspace_id=$1 AND p.sku_id=s.id ORDER BY p.created_at DESC,p.id DESC LIMIT 1)pc ON true ORDER BY x.position`,[ctx.workspaceId,id,JSON.stringify(supplied)])).rows;
 if(current.length!==lines.length||new Set(current.map(r=>r.position)).size!==lines.length)throw new ValidationError('Every SKU and location must identify one position in this worksheet.');
 const currency=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency,seen=new Set(),updates=[];
 for(const row of current){const line=lines[row.position],key=row.location_id+':'+row.sku_id;if(seen.has(key))throw new ValidationError('Each stock position must appear once.');seen.add(key);
  if(row.has_evidence)throw new ValidationError('Review the staff identifiers and measures for this position on its assigned count.');
  const quantity=exact.safeNumber(line.quantity,{label:'Counted quantity'}),unitCost=String(line.unitCost??'').trim();
  if(unitCost&&!currency)throw new ValidationError('Set up the inventory currency before entering purchase costs.');
  require('../domain/stock-quantity').validate(row,quantity,{positive:false});
  const delta=exact.safeNumber(exact.subtract(quantity,row.before_quantity),{signed:true});let costDelta=0,unitCostMinor=unitCost?require('../domain/currency').toMinor(unitCost,currency):null;
  if(delta<0){if(exact.canonical(row.before_costed)!==exact.canonical(row.before_quantity))throw new ValidationError('Record the missing stock cost before reducing this position.');costDelta=-exact.ratioMinor(Number(row.before_value),-delta,row.before_costed);}
  if(delta>0){if(unitCostMinor===null){const saved=row.saved_cost==null?await require('../pricing/postgres-service').purchaseCost(c,ctx.workspaceId,row.sku_id):{amount_minor:row.saved_cost,currency:row.saved_currency};if(!saved||saved.currency!==currency)throw new ValidationError('Enter a purchase cost for additional stock.');unitCostMinor=Number(saved.amount_minor);}costDelta=exact.costMinor(delta,unitCostMinor);}
  updates.push({sku_id:row.sku_id,location_id:row.location_id,quantity,unit_cost:unitCostMinor,cost_delta:costDelta});
 }
 await c.query(`UPDATE warehouse_count_campaign_lines l SET counted_quantity=x.quantity,unit_cost_minor=x.unit_cost,cost_delta_minor=x.cost_delta FROM jsonb_to_recordset($3::jsonb)x(sku_id text,location_id text,quantity numeric,unit_cost bigint,cost_delta bigint) WHERE l.workspace_id=$1 AND l.campaign_id=$2 AND l.sku_id=x.sku_id AND l.location_id=x.location_id`,[ctx.workspaceId,id,JSON.stringify(updates)]);
 await c.query('UPDATE warehouse_count_campaigns SET revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);return {saved:lines.length,revision:campaign.revision+1};
 },{isolation:'SERIALIZABLE',retrySafe:true});}
// Enqueue on the same transaction/connection as the approved count. A separate
// queue transaction could expose work before its approval is committed.
async function enqueue(c,ctx,id,revision){
 const {rows:[{kind}]}=await c.query(`SELECT CASE
   WHEN EXISTS(SELECT 1 FROM stockchief_runtime.agent_annual_count_teams WHERE workspace_id=$1 AND campaign_id=$2) THEN 'agent.annual-stocktake.apply.v1'
   WHEN EXISTS(SELECT 1 FROM stockchief_runtime.agent_count_position_evidence WHERE workspace_id=$1 AND campaign_id=$2) THEN 'agent.phone-count.apply.v1'
   ELSE 'warehouse.count.apply' END AS kind`,[ctx.workspaceId,id]);
 return require('./postgres-job-queue').enqueue({query:c.query,transaction:operation=>operation(c)},
  {workspaceId:ctx.workspaceId,kind,payload:{campaignId:id,actorId:ctx.actorId},idempotencyKey:'count-campaign:'+id+':'+revision});
}
async function approve(db,ctx,id,revision){return db.transaction(async c=>{
 await authorize(c,ctx,true);const campaign=await header(c,ctx,id,true);
 if(campaign.status==='APPLYING'||campaign.status==='COMPLETED')return {replayed:true};
 if(campaign.status!=='DRAFT'||campaign.revision!==Number(revision))throw new ValidationError('Reload the current count worksheet before approving.');
 if(campaign.assigned){
  if(!campaign.assigned.observed_at)throw new ValidationError('The assigned counter must finish the blind count before approval.');
  await observations.checkReviewed(c,ctx.workspaceId,id);
 }
 const missing=(await c.query('SELECT count(*)::int n FROM warehouse_count_campaign_lines WHERE campaign_id=$1 AND counted_quantity IS NULL',[id])).rows[0].n;if(missing)throw new ValidationError(missing+' positions still need a count. Blank counts are never treated as zero.');
 await c.query("UPDATE warehouse_count_campaigns SET status='APPLYING',approved_by_user_id=$3,approved_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,ctx.actorId]);await enqueue(c,ctx,id,campaign.revision);return {replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});}
async function run(job,db){const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId},id=job.payload.campaignId;
 try{return await db.transaction(async c=>{
  await authorize(c,ctx,true);const campaign=await header(c,ctx,id,true);if(campaign.status!=='APPLYING')return {status:campaign.status};await require('./agent-annual-stocktakes').assertCampaign(c,ctx,id,{lock:true,adjustment:true});
  let lines=(await c.query(`SELECT l.*,EXISTS(SELECT 1 FROM stockchief_runtime.agent_count_position_evidence e
   WHERE e.campaign_id=l.campaign_id AND e.location_id=l.location_id AND e.sku_id=l.sku_id) has_evidence
   FROM warehouse_count_campaign_lines l WHERE l.workspace_id=$1 AND l.campaign_id=$2 AND l.applied_at IS NULL ORDER BY l.location_id,l.sku_id LIMIT 1000 FOR UPDATE OF l`,[ctx.workspaceId,id])).rows;
  if(!lines.length){await c.query("UPDATE warehouse_count_campaigns SET status='COMPLETED',completed_at=now() WHERE id=$1",[id]);return {status:'COMPLETED'};}
  if(lines.filter(l=>exact.canonical(l.counted_quantity)!==exact.canonical(l.before_quantity,{signed:true})).length>100)lines=lines.slice(0,100);
  const pairs=JSON.stringify(lines.map(l=>({sku_id:l.sku_id,location_id:l.location_id}))),positions=(await c.query(`SELECT b.sku_id,b.location_id,b.on_hand::text quantity,b.updated_at balance_version,coalesce(v.updated_at,'') cost_version FROM jsonb_to_recordset($2::jsonb)x(sku_id text,location_id text) JOIN balances b ON b.workspace_id=$1 AND b.sku_id=x.sku_id AND b.location_id=x.location_id LEFT JOIN accounting_inventory_cost_balances v ON v.workspace_id=b.workspace_id AND v.sku_id=b.sku_id AND v.location_id=b.location_id FOR UPDATE OF b`,[ctx.workspaceId,pairs])).rows,currentByKey=new Map(positions.map(p=>[p.location_id+':'+p.sku_id,p]));
  if(lines.some(l=>l.has_evidence))await observations.checkReviewed(c,ctx.workspaceId,id,pairs);
  for(const l of lines){
   if(l.has_evidence)continue;
   const current=currentByKey.get(l.location_id+':'+l.sku_id);
   if(!current||exact.canonical(current.quantity,{signed:true})!==exact.canonical(l.before_quantity,{signed:true})||current.balance_version!==l.balance_version||current.cost_version!==l.cost_version){const label=(await c.query('SELECT s.code,l.name FROM skus s JOIN locations l ON l.workspace_id=s.workspace_id WHERE s.workspace_id=$1 AND s.id=$2 AND l.id=$3',[ctx.workspaceId,l.sku_id,l.location_id])).rows[0];throw new ValidationError('Stock or cost changed for '+(label?.code||'a counted product')+' at '+(label?.name||'the counted location')+'. Completed batches are preserved. Recount this worksheet before continuing.');}
   if(exact.canonical(l.counted_quantity)!==exact.canonical(l.before_quantity,{signed:true})){
    const currency=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency;
    let unitCostMinor=l.unit_cost_minor==null?null:Number(l.unit_cost_minor);if(Number(l.counted_quantity)>Number(l.before_quantity)&&unitCostMinor===null){const saved=await require('../pricing/postgres-service').purchaseCost(c,ctx.workspaceId,l.sku_id);if(saved?.currency!==currency)throw new ValidationError('Enter the purchase cost for additional stock before approving.');unitCostMinor=Number(saved.amount_minor);}
    await require('../accounting/postgres-physical-count').applyInTransaction(c,ctx,{skuId:l.sku_id,locationId:l.location_id,countedQuantity:l.counted_quantity,unitCostMinor,expectedBefore:{physical:Number(l.before_quantity),costed:Number(l.before_costed),value:Number(l.before_value)},expectedCostDeltaMinor:Number(l.cost_delta_minor),reasonCode:'cycle_count',reference:campaign.title,sourceType:'physical_count_review',sourceRecordId:id,idempotencyKey:'count-campaign:'+id+':'+l.location_id+':'+l.sku_id,currency});
   }
  }
  await c.query(`UPDATE warehouse_count_campaign_lines l SET applied_at=now() FROM jsonb_to_recordset($3::jsonb)x(sku_id text,location_id text) WHERE l.workspace_id=$1 AND l.campaign_id=$2 AND l.sku_id=x.sku_id AND l.location_id=x.location_id`,[ctx.workspaceId,id,pairs]);
  await c.query('UPDATE warehouse_count_campaigns SET revision=revision+1 WHERE id=$1',[id]);await enqueue(c,ctx,id,campaign.revision+1);return {status:'APPLYING',processed:lines.length};
 },{isolation:'SERIALIZABLE',retrySafe:true});}catch(error){if(!(error instanceof ValidationError)&&!(error instanceof AuthorizationError)&&error.code!=='entitlement_required')throw error;await db.query("UPDATE warehouse_count_campaigns SET status='REVIEW_REQUIRED',problem=$3 WHERE workspace_id=$1 AND id=$2 AND status='APPLYING'",[ctx.workspaceId,id,error.message]);return {status:'REVIEW_REQUIRED',problem:error.message};}
}
module.exports={create,page,save,approve,run};

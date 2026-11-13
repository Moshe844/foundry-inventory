'use strict';

// Job 199: StockChief shows how sure it is on every action, and asks when it
// is not sure enough.
//
// Each action is checked against the facts that action already relies on.
// A required fact that is missing or does not match makes it low: StockChief
// stops and asks, on every plan (page 13: it never guesses). A helpful fact
// that is missing (no earlier order with this supplier, a changed price, a
// first email to an address, a first count at a location, a large count
// difference) makes it medium. With every fact recorded and matching it is
// high. The reasons shown are those checks, worst first.
//
// The owner sets how sure StockChief must be to act on its own: fairly sure
// (medium, the default) or very sure (high). Below that level an automatic
// action waits for a person instead. Covered actions: purchase orders and
// transfers from the replenishment planner, count postings, and tracking
// emails to customers.

const {has}=require('../db/schema-installed');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const exact=require('../domain/exact-quantity');

const JOB=199,TABLE='stockchief_runtime.agent_confidence_settings';
const LEVELS=['low','medium','high'],WORDS={low:'Low',medium:'Medium',high:'High'};
const MINIMUMS={medium:'When it is fairly sure (medium or high)',high:'Only when it is very sure (high)'};
const rank=level=>LEVELS.indexOf(level);
const measured=value=>(typeof value==='number'||(typeof value==='string'&&value.trim()!==''))&&Number.isFinite(Number(value));
const email=value=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value||''));
const sentence=text=>text.endsWith('.')?text:text+'.';

// checks: [{need:'required'|'helpful', ok:true|false|null, yes, no}]. A check
// whose fact does not apply (ok null) is left out.
function assess(checks){
  let level='high';const missing=[],found=[];
  for(const check of checks){
    if(check.ok===null||check.ok===undefined)continue;
    if(check.ok){found.push(sentence(check.yes));continue;}
    missing.push(sentence(check.no));
    if(check.need==='required')level='low';else if(level==='high')level='medium';
  }
  return {level,label:WORDS[level],missing,found,reasons:[...missing,...found],
    reason:missing.length?missing.join(' '):'Every fact this action needs is recorded and matches.'};
}

// A purchase order from the replenishment planner.
function purchase(c){
  const history=c.history&&typeof c.history==='object'?c.history:null,orders=history?Number(history.orders)||0:null;
  return assess([
    {need:'required',ok:Boolean(c.skuId)&&measured(c.quantity)&&Number(c.quantity)>0,yes:'The item and quantity are recorded',no:'The item or quantity needs verification'},
    {need:'required',ok:Boolean(c.supplierId)&&measured(c.unitCost)&&Number(c.unitCost)>=0&&measured(c.value)&&Number(c.value)>=0&&Boolean(c.currency),
      yes:'The supplier, its unit price and currency are recorded',no:'Confirm the supplier, currency and unit cost before sending this order'},
    {need:'required',ok:[c.destinationAvailable,c.incoming,c.reorderPoint].every(measured),
      yes:'Available stock, incoming stock and the reorder point are recorded',no:'Refresh the available stock, incoming stock and reorder point before sending this order'},
    {need:'helpful',ok:Boolean(c.destinationLocationId),yes:'The receiving location is known',no:'Choose the receiving location'},
    {need:'helpful',ok:orders===null?null:orders>0,yes:'You have ordered this item from '+(c.supplierName||'this supplier')+' before',
      no:'This is the first order of this item from '+(c.supplierName||'this supplier')},
    {need:'helpful',ok:orders&&history.lastUnitCost!=null&&measured(c.unitCost)?Number(history.lastUnitCost)===Number(c.unitCost)&&history.lastCurrency===c.currency:null,
      yes:'The price matches your last order',no:'The price differs from your last order ('+(history?.lastCurrency||'')+' '+(history?.lastUnitCost??'')+' then, '+c.currency+' '+c.unitCost+' now)'}
  ]);
}

// A transfer between two locations from the replenishment planner.
function transfer(c){
  const spare=measured(c.sourceAvailable)&&measured(c.sourceSafety)&&measured(c.quantity)
    ?require('../transfers/agent-transfer-balance-source').cmp(exact.subtract(c.sourceAvailable,c.sourceSafety),c.quantity)>=0:false;
  return assess([
    {need:'required',ok:Boolean(c.skuId)&&measured(c.quantity)&&Number(c.quantity)>0,yes:'The item and quantity are recorded',no:'The item or quantity needs verification'},
    {need:'required',ok:Boolean(c.sourceLocationId&&c.destinationLocationId),yes:'The source and destination are known',no:'Verify the source, destination and stock the source needs to keep'},
    {need:'required',ok:spare,yes:'The source can spare this quantity and still keep its protected stock',no:'Verify the source, destination and stock the source needs to keep'},
    {need:'helpful',ok:measured(c.destinationAvailable)&&measured(c.reorderPoint)?Number(c.destinationAvailable)<=Number(c.reorderPoint):null,
      yes:'The destination is at or below its reorder point',no:'The destination is above its reorder point'}
  ]);
}

// The decisions on a work item the planner prepared, or null for other work.
function forAction(candidate){
  if(candidate?.type==='purchase')return purchase(candidate);
  if(candidate?.type==='transfer')return transfer(candidate);
  return null;
}

// Posting the differences of a physical count. lines carry delta and
// costDeltaMinor, and the recorded quantity (before.physical) when known.
function countPosting({lines=[],supplied=null,earlierCounts=null,locationName=null}){
  const changed=lines.filter(line=>Number(line.delta)!==0);
  const large=changed.find(line=>line.before&&measured(line.before.physical)&&Math.abs(Number(line.delta))>Math.max(1,Math.abs(Number(line.before.physical))*0.25));
  const known=changed.some(line=>line.before&&measured(line.before.physical));
  return assess([
    {need:'required',ok:changed.every(line=>Number(line.costDeltaMinor)),yes:'The value of every difference comes from recorded costs',no:'A difference has no recorded cost'},
    {need:'required',ok:supplied?!supplied.some(line=>String(line.unitCost??'').trim()):null,yes:'No prices were typed in with the count',
      no:'A price was typed in with the count, so its value cannot be checked against your records'},
    {need:'helpful',ok:known?!large:null,yes:'Each difference is small next to the recorded stock',
      no:large?'Counted '+(large.quantity??exact.add(large.before.physical,String(large.delta)))+' of '+(large.code||'an item')+' where your records say '+large.before.physical:'A difference is large'},
    {need:'helpful',ok:earlierCounts===null?null:earlierCounts>0,yes:'Stock here has been counted and approved before',
      no:'This is the first approved count'+(locationName?' at '+locationName:' at this location')}
  ]);
}

// A count's confidence with its history: earlier approved counts at the same
// location (owner-approved count reviews and completed count lists).
async function forCount(db,workspaceId,payload,supplied=null,exceptId=null){
  const locationId=payload?.location?.id||null;
  const earlier=locationId?Number((await db.query(`SELECT
      (SELECT count(*) FROM physical_count_reviews WHERE workspace_id=$1 AND status='COMPLETED' AND payload->'location'->>'id'=$2 AND id IS DISTINCT FROM $3)
      +(SELECT count(*) FROM warehouse_count_campaigns WHERE workspace_id=$1 AND status='COMPLETED' AND scope->'locationIds' ? $2) AS n`,
    [workspaceId,locationId,exceptId])).rows[0].n):null;
  return countPosting({lines:payload?.lines||[],supplied,earlierCounts:earlier,locationName:payload?.location?.name||null});
}

// A tracking email to a customer.
function shippingNotice({recipient,customerEmail,trackingNumber,trackingLink,earlierSent}){
  return assess([
    {need:'required',ok:email(recipient),yes:'The customer’s email address is recorded',no:'There is no valid email address for this customer'},
    {need:'required',ok:Boolean(trackingNumber),yes:'The tracking number is recorded',no:'The tracking number is missing'},
    {need:'helpful',ok:email(customerEmail)?String(customerEmail).toLowerCase()===String(recipient||'').toLowerCase():null,
      yes:'The order’s email matches the customer record',no:'The order’s email differs from the customer record'},
    {need:'helpful',ok:Boolean(trackingLink),yes:'The carrier’s tracking link is known',no:'There is no tracking link for this carrier'},
    {need:'helpful',ok:earlierSent==null?null:Number(earlierSent)>0,yes:'Earlier emails to this address were delivered',no:'This is the first email to this address'}
  ]);
}

// How sure StockChief must be to act on its own: 'medium' unless the owner chose 'high'.
async function minimum(db,workspaceId){
  if(!await has(db,TABLE))return 'medium';
  return (await db.query(`SELECT minimum FROM ${TABLE} WHERE workspace_id=$1`,[workspaceId])).rows[0]?.minimum||'medium';
}

// Null when the action may go ahead on its own, or why it waits for a person.
async function stop(db,workspaceId,assessment){
  if(!assessment)return null;
  if(assessment.level==='low')return 'How sure: low. '+assessment.reason+' StockChief asks you first.';
  const needed=await minimum(db,workspaceId);
  if(rank(assessment.level)>=rank(needed))return null;
  return 'How sure: '+assessment.level+'. '+assessment.reason+' You asked StockChief to act on its own only when it is very sure, so it asks you first.';
}

async function settings(db,workspaceId){
  const value=await minimum(db,workspaceId);
  return {minimum:value,label:MINIMUMS[value],choices:Object.entries(MINIMUMS).map(([key,label])=>({key,label}))};
}

async function configure(db,ctx,input={}){
  const value=String(input.minimum||'');
  if(!MINIMUMS[value])throw new ValidationError('Choose how sure StockChief must be before it acts on its own.');
  return db.transaction(async c=>{
    const owner=(await c.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId])).rowCount;
    if(!owner)throw new AuthorizationError('Only the business owner can change how sure StockChief must be.');
    const account=await require('../commercial/agent-plan').requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    if(!await has(c,TABLE))throw new ValidationError('This inventory is being upgraded. Try again in a few minutes.');
    const prior=(await c.query(`SELECT minimum FROM ${TABLE} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0]?.minimum||'medium';
    if(prior===value)return {minimum:value,changed:false};
    await c.query(`INSERT INTO ${TABLE}(workspace_id,minimum,updated_by) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id) DO UPDATE SET minimum=EXCLUDED.minimum,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,[ctx.workspaceId,value,ctx.actorId]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Changed how sure StockChief must be to act on its own',reference:'confidence',
      before:{minimum:prior},after:{minimum:value,plan:account.plan}});
    return {minimum:value,changed:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Earlier sent purchase orders, per item and supplier, for the purchase checks.
function purchaseHistoryRows(){
  return `SELECT DISTINCT ON(line.sku_id,po.supplier_id) line.sku_id,po.supplier_id,line.unit_cost::text AS unit_cost,po.currency,
      count(*) OVER (PARTITION BY line.sku_id,po.supplier_id)::int AS orders
    FROM purchase_orders po JOIN purchase_order_lines line ON line.workspace_id=po.workspace_id AND line.purchase_order_id=po.id
    WHERE po.workspace_id=$1 AND line.sku_id=ANY($2::text[]) AND po.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')
    ORDER BY line.sku_id,po.supplier_id,po.ordered_at::timestamptz DESC NULLS LAST,po.id DESC,line.id`;
}

// Ask and the agent reviews: how sure StockChief is about each waiting action.
async function review(db,ctx,{page=1}={}){
  const offset=(Number(page)-1)*100;
  const work=(await db.query(`SELECT id,recommended_action,created_at FROM work_items WHERE workspace_id=$1 AND source='postgres_autopilot'
    AND execution_status='WAITING_FOR_APPROVAL' AND category IN ('stock_transfer','replenishment_plan') ORDER BY created_at DESC,id DESC LIMIT 101 OFFSET $2`,[ctx.workspaceId,offset])).rows;
  const notices=offset?[]:await require('../shipping/agent-shipping-notices').waiting(db,ctx.workspaceId);
  const rows=[...work.map(w=>{const a=typeof w.recommended_action==='string'?JSON.parse(w.recommended_action):w.recommended_action,s=forAction(a);
      return {'Action':(a.type==='transfer'?'Transfer ':'Order ')+(a.displayName||a.code||''),'How sure':s?.label||'',
        'Why':s?s.reasons.join(' '):'',link:'/autopilot/work/'+w.id};}),
    ...notices.map(n=>({'Action':'Tracking email for order '+n.order_number,'How sure':n.confidence.label,'Why':n.confidence.reasons.join(' '),link:'/fulfilment/'+n.shipment_id+'#notice'}))];
  const needed=await settings(db,ctx.workspaceId);
  return {summary:'How sure StockChief is about each action waiting for you, from the facts each action checks. It acts on its own '+needed.label.toLowerCase()+'; below that, or when it is unsure, it asks you.',
    rows:rows.slice(0,100),more:work.length>100};
}

module.exports={JOB,LEVELS,WORDS,MINIMUMS,assess,purchase,transfer,forAction,countPosting,forCount,shippingNotice,minimum,stop,settings,configure,purchaseHistoryRows,review,
  definition:{id:JOB,key:'confidence',label:'See how sure StockChief is about each waiting action',readPage:review}};

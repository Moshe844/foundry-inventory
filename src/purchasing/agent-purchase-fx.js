'use strict';

// Job 40: handles purchase orders in other currencies and alerts the owner
// when exchange rates change landed cost.
//
// A foreign purchase keeps its own currency. When it is placed, its goods are
// estimated in the accounting currency at the rate of the day. When goods are
// booked in, stock value is recorded at the rate of the receipt date (see
// receiptRate below and the purchase receipt workflow). Freight, duty and fees
// keep their own landed-cost allocation (job 49).
//
// Alerts compare the open goods on each foreign purchase, and the landed unit
// cost of items bought mostly in a foreign currency, with the rate they were
// ordered or booked at. A change over the owner's threshold opens an alert in
// the app and in Needs you, and an email through a connected mailbox. Starter
// sees one suggestion. Growth, Pro and Custom fetch rates through the worker
// and open and clear alerts on their own. Alerts never change a price or a
// cost. Pause, Watch only, Ask me first and the first 14 days only watch.
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');
const rates=require('./fx-rates');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');
const {hash}=require('../pricing/postgres-promotions');
const {newId}=require('../lib/util');

const JOB=40,ACTION='purchasing.fx_alert',KIND='purchasing.fx-rates.v1',href='/autopilot/purchase-fx';
const OPEN=['DRAFT','APPROVED','ORDERED','PARTIALLY_RECEIVED'];
const tables={estimates:'stockchief_runtime.agent_fx_order_estimates',receipts:'stockchief_runtime.agent_fx_receipt_rates',
  rules:'stockchief_runtime.agent_fx_alert_rules',runs:'stockchief_runtime.agent_fx_runs',alerts:'stockchief_runtime.agent_fx_alerts',
  baselines:'stockchief_runtime.agent_purchase_fx_baselines'};
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(sql,args)=>c.query(sql,args),transaction:operation=>operation(c)});
const alone=state=>policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'automatic');

async function owner(db,ctx,{lock=false}={}){if(!(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)${lock?' FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rowCount)throw new AuthorizationError('Only the current inventory owner can review foreign-currency purchase exposure.');await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);}
async function currentOwner(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.role='owner' ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}
async function baseCurrency(db,workspaceId){const row=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[workspaceId])).rows[0];if(!row)throw new ValidationError('Confirm the accounting currency before comparing foreign purchase costs.');return money.code(row.base_currency);}

// Open goods on one purchase, in its own currency. A missing price or weight stops the review.
function facts(p,base){
  if(!OPEN.includes(p.status))throw new ValidationError('Choose an open purchase order. Received or cancelled orders have no open exposure in this review.');
  if(p.currency===base)throw new ValidationError('This purchase uses the accounting currency and needs no foreign-exchange estimate.');
  const lines=p.source_lines;if(!lines.length||lines.length>1000)throw new ValidationError('This review covers one to 1,000 recorded PO lines.');
  let outstandingMinor=0;
  for(const l of lines){
    const measured=Boolean(l.secondary_unit_label),ordered=measured?l.secondary_quantity_ordered:l.quantity_units,received=measured?l.secondary_quantity_received:l.quantity_received_units;
    if(l.unit_cost==null||ordered==null)throw new ValidationError('This PO has missing prices or weights. No missing cost is treated as zero.');
    const remaining=exact.subtract(ordered,received??0);
    if(remaining.startsWith('-'))continue;
    outstandingMinor=money.sum([outstandingMinor,exact.costMinor(remaining,money.userToMinor(String(l.unit_cost),p.currency,{label:'Recorded PO unit cost'}))]);
  }
  const sourceHash=hash({id:p.id,supplier:p.supplier_id,currency:p.currency,base,lines:lines.map(l=>({id:l.id,sku:l.sku_id,quantity:l.quantity_units,unitCost:l.unit_cost,location:l.destination_location_id,tracking:l.tracking_mode,precision:l.quantity_precision,secondary:l.secondary_unit_label}))});
  const {source_lines,...header}=p;return {...header,base,outstandingMinor,sourceHash};
}
async function loadPurchases(db,ctx,ids,base){
  if(!ids.length)return new Map();const rows=(await db.query(`SELECT p.id,p.po_number,p.supplier_id,p.currency,p.status,p.ordered_at,s.name supplier_name,coalesce(lines.source_lines,'[]'::jsonb) source_lines
  FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
  LEFT JOIN LATERAL(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) source_lines FROM(SELECT l.id,l.sku_id,l.quantity_units::text,l.quantity_received_units::text,l.secondary_quantity_ordered::text,l.secondary_quantity_received::text,l.unit_cost::text,l.destination_location_id,i.tracking_mode,i.quantity_precision,i.secondary_unit_label FROM purchase_order_lines l JOIN skus sk ON sk.workspace_id=l.workspace_id AND sk.id=l.sku_id JOIN items i ON i.workspace_id=sk.workspace_id AND i.id=sk.item_id WHERE l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id ORDER BY l.id LIMIT 1001)x)lines ON true
  WHERE p.workspace_id=$1 AND p.id=ANY($2::text[])`,[ctx.workspaceId,ids])).rows;return new Map(rows.map(p=>{try{return [p.id,{value:facts(p,base)}];}catch(error){if(!(error instanceof ValidationError))throw error;return [p.id,{error}];}}));
}
async function purchase(db,ctx,id){await owner(db,ctx);const rows=await loadPurchases(db,ctx,[id],await baseCurrency(db,ctx.workspaceId)),p=rows.get(id);if(!p)throw new NotFoundError('That purchase order is not in this inventory.');if(p.error)throw p.error;return p.value;}

// The owner's checked original quote for one purchase. It takes precedence over the ordering estimate.
async function saveBaseline(db,ctx,input){return db.transaction(async c=>{
  await owner(c,ctx,{lock:true});await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');if(input.confirmed!=='yes')throw new ValidationError('Confirm the rate direction, quote date and original source.');const p=await purchase(c,ctx,input.purchaseOrderId);if(input.sourceHash!==p.sourceHash)throw new ValidationError('The PO or accounting currency changed. Reload the exact comparison.');const rate=require('./fx-reference').decimal(input.basePerForeign).text,date=require('./fx-reference').day(input.quotedOn),today=await require('../lib/business-time').today(c,ctx.workspaceId);if(date>today)throw new ValidationError('The original comparison quote cannot be future-dated.');const source=String(input.sourceReference||'').trim();if(!source||source.length>200||/[\u0000-\u001f\u007f]/.test(source))throw new ValidationError('Enter the original quote or budget reference, up to 200 plain characters.');const revision=Number(input.revision);if(!Number.isSafeInteger(revision)||revision<0)throw new ValidationError('Reload this comparison before saving.');
  const prior=(await c.query(`SELECT revision FROM ${tables.baselines} WHERE workspace_id=$1 AND purchase_order_id=$2 FOR UPDATE`,[ctx.workspaceId,p.id])).rows[0];if(Number(prior?.revision||0)!==revision)throw new ValidationError('The comparison rate changed. Reload it before saving.');await storage.reserve(c,ctx.workspaceId,'purchase-fx:'+p.id,8192,{finished:true});
  const changed=await c.query(`INSERT INTO ${tables.baselines}(workspace_id,purchase_order_id,base_currency,base_per_foreign,quoted_on,source_reference,source_hash,confirmed_by) VALUES($1,$2,$3,$4,$5::date,$6,$7,$8) ON CONFLICT(workspace_id,purchase_order_id) DO UPDATE SET base_currency=$3,base_per_foreign=$4,quoted_on=$5::date,source_reference=$6,source_hash=$7,confirmed_by=$8,revision=agent_purchase_fx_baselines.revision+1,confirmed_at=clock_timestamp() WHERE agent_purchase_fx_baselines.revision=$9 RETURNING revision`,[ctx.workspaceId,p.id,p.base,rate,date,source,p.sourceHash,ctx.actorId,revision]);if(!changed.rowCount)throw new ValidationError('The comparison rate changed. Reload it before saving.');await audit.record(c,ctx,{action:'Foreign purchase comparison rate confirmed',reference:p.po_number,after:{base:p.base,currency:p.currency,rate,date,source}});return {id:p.id};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function baseline(db,ctx,id){await owner(db,ctx);return (await db.query(`SELECT *,quoted_on::text AS quote_date FROM ${tables.baselines} WHERE workspace_id=$1 AND purchase_order_id=$2`,[ctx.workspaceId,id])).rows[0]||null;}

// Landed cost estimated in the accounting currency at the rate of the day an
// order is placed. Called inside the placement transaction; it never blocks it.
async function recordEstimate(c,workspaceId,orderId){
  const order=(await c.query(`SELECT p.id,p.currency,p.ordered_at,s.base_currency FROM purchase_orders p
    JOIN accounting_settings s ON s.workspace_id=p.workspace_id AND s.enabled=1 WHERE p.workspace_id=$1 AND p.id=$2`,[workspaceId,orderId])).rows[0];
  if(!order||order.currency===order.base_currency)return null;
  try{
    const clock=require('../lib/business-time'),calendar=await clock.forWorkspace(c,workspaceId);
    const on=clock.context(calendar.timeZone,order.ordered_at?new Date(order.ordered_at):new Date()).calendarDate;
    const rate=await rates.rateOn(c,workspaceId,order.currency,order.base_currency,on);if(!rate)return null;
    const lines=(await c.query(`SELECT l.unit_cost::text cost,l.quantity_units::text quantity,l.secondary_quantity_ordered::text secondary,i.secondary_unit_label
      FROM purchase_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE l.workspace_id=$1 AND l.purchase_order_id=$2`,[workspaceId,orderId])).rows;
    if(!lines.length||lines.some(l=>l.cost==null||(l.secondary_unit_label&&l.secondary==null)))return null;
    const goods=money.sum(lines.map(l=>exact.costMinor(l.secondary_unit_label?l.secondary:l.quantity,money.userToMinor(l.cost,order.currency))));
    const estimate=rates.convert(goods,order.currency,order.base_currency,rate.rate);
    await c.query(`INSERT INTO ${tables.estimates}(workspace_id,purchase_order_id,currency,base_currency,rate,rate_date,rate_source,goods_minor,estimate_minor)
      VALUES($1,$2,$3,$4,$5,$6::date,$7,$8,$9) ON CONFLICT DO NOTHING`,[workspaceId,orderId,order.currency,order.base_currency,rate.rate,rate.date,rate.source,goods,estimate]);
    return {rate,goods,estimate};
  }catch(error){if(error instanceof ValidationError)return null;throw error;}
}
// Orders placed before a rate was stored get their estimate once a rate for that day exists.
async function backfillEstimates(db,workspaceId){
  const missing=(await db.query(`SELECT p.id FROM purchase_orders p JOIN accounting_settings s ON s.workspace_id=p.workspace_id AND s.enabled=1
    WHERE p.workspace_id=$1 AND p.currency<>s.base_currency AND p.status IN ('ORDERED','PARTIALLY_RECEIVED') AND p.ordered_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM ${tables.estimates} e WHERE e.workspace_id=p.workspace_id AND e.purchase_order_id=p.id)
    ORDER BY p.ordered_at DESC,p.id LIMIT 200`,[workspaceId])).rows;
  let recorded=0;for(const row of missing)if(await tx(db,c=>recordEstimate(c,workspaceId,row.id)))recorded++;
  return recorded;
}

// The rate a foreign receipt is booked at: the stored rate for the receipt
// date, an owner's manual rate first. No rate stops the receipt and asks.
async function receiptRate(c,ctx,order,at,expected){
  const books=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
  if(!books||books.base_currency===order.currency)return null;
  const base=money.code(books.base_currency),currency=money.code(order.currency),clock=require('../lib/business-time');
  const on=clock.context((await clock.forWorkspace(c,ctx.workspaceId)).timeZone,new Date(at)).calendarDate;
  const rate=await rates.rateOn(c,ctx.workspaceId,currency,base,on);
  if(!rate)throw new ValidationError(`No ${currency} to ${base} exchange rate is recorded for ${on}. Record that day's rate on Foreign purchase costs, then book the delivery in. Nothing was received.`);
  if(expected!=null&&String(expected).trim()!==''&&String(expected).trim()!==rate.rate)
    throw new ValidationError(`The exchange rate changed to 1 ${currency} = ${rates.display(rate.rate)} ${base}. Check it, then book the delivery in. Nothing was received.`);
  return {...rate,currency,base,on};
}
// What the receiving page shows before goods are booked in.
async function receiptPreview(db,workspaceId,currency){
  const books=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[workspaceId])).rows[0];
  if(!books||!currency||books.base_currency===currency)return null;
  const base=money.code(books.base_currency),code=money.code(currency),date=await require('../lib/business-time').today(db,workspaceId);
  const rate=await rates.rateOn(db,workspaceId,code,base,date);
  if(!rate)return {currency:code,base,date,missing:true};
  return {currency:code,base,rate:rate.rate,shown:rates.display(rate.rate),date:rate.date,label:rates.sourceLabel(rate.source)};
}
async function recordReceipt(c,ctx,{receiptId,receiptLineKey,orderId,lineId,skuId,fx,foreignMinor,baseMinor,journalEntryId}){
  await c.query(`INSERT INTO ${tables.receipts}(workspace_id,receipt_id,receipt_line_key,purchase_order_id,purchase_order_line_id,sku_id,currency,base_currency,
      foreign_minor,base_minor,rate,rate_date,rate_source,rate_reference,journal_entry_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13,$14,$15) ON CONFLICT DO NOTHING`,
  [ctx.workspaceId,receiptId,receiptLineKey,orderId,lineId,skuId,fx.currency,fx.base,foreignMinor,baseMinor,fx.rate,fx.date,fx.source,String(fx.reference||fx.source).slice(0,300),journalEntryId||null]);
}

// Compare one purchase's open goods at the basis rate and the current rate.
function compare(p,{checked=null,estimate=null,rate=null}={}){
  if(!rate)return {problem:null};
  const current=rates.convert(p.outstandingMinor,p.currency,p.base,rate.rate);let basis=null,problem=null;
  if(checked){
    if(checked.source_hash!==p.sourceHash||checked.base_currency!==p.base)problem='The PO prices, quantities, products, destination or accounting currency changed. Confirm a new comparison basis.';
    else if(checked.quote_date>rate.date)problem='Your checked quote is newer than the current rate. Wait for a newer rate.';
    else basis={rate:checked.base_per_foreign,date:checked.quote_date,source:'CHECKED',label:'your checked rate'};
  }
  if(!basis&&estimate)basis={rate:estimate.rate,date:estimate.rate_date,source:estimate.rate_source,label:'the rate when ordered'};
  if(!basis)return {current,rate,problem:problem||'No rate was recorded when this order was placed. Current estimate only.'};
  const original=rates.convert(p.outstandingMinor,p.currency,p.base,basis.rate);
  return {current,original,change:current-original,percent:rates.change(basis.rate,rate.rate),basis,rate,problem};
}

// Items bought mostly (by units, over the last year) in one foreign currency.
async function itemCandidates(db,workspaceId,base,limit=500){
  return (await db.query(`WITH bought AS (
      SELECT l.sku_id,p.currency,sum(l.quantity_units) units,
        (array_agg(l.unit_cost::text ORDER BY p.ordered_at DESC,p.id DESC,l.id DESC))[1] last_cost,
        (array_agg(p.id ORDER BY p.ordered_at DESC,p.id DESC,l.id DESC))[1] last_order
      FROM purchase_order_lines l JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
      WHERE l.workspace_id=$1 AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED') AND p.ordered_at IS NOT NULL
        AND p.ordered_at::timestamptz>now()-interval '365 days' AND l.quantity_units>0
      GROUP BY l.sku_id,p.currency),
    mostly AS (SELECT b.* FROM bought b WHERE b.currency<>$2 AND b.units*2>(SELECT sum(x.units) FROM bought x WHERE x.sku_id=b.sku_id))
    SELECT m.sku_id,m.currency,m.last_cost,m.last_order,s.code,i.name,i.secondary_unit_label,
      r.rate receipt_rate,r.rate_date::text receipt_date,r.rate_source receipt_source,
      e.rate order_rate,e.rate_date::text order_date,e.rate_source order_source,
      c.quantity::text stock_units,c.cost::text stock_cost
    FROM mostly m JOIN skus s ON s.workspace_id=$1 AND s.id=m.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    LEFT JOIN LATERAL (SELECT x.rate,x.rate_date,x.rate_source FROM ${tables.receipts} x WHERE x.workspace_id=$1 AND x.sku_id=m.sku_id
      AND x.currency=m.currency AND x.base_currency=$2 ORDER BY x.created_at DESC,x.receipt_id DESC LIMIT 1) r ON true
    LEFT JOIN ${tables.estimates} e ON e.workspace_id=$1 AND e.purchase_order_id=m.last_order AND e.base_currency=$2
    LEFT JOIN LATERAL (SELECT sum(b.quantity_units) quantity,sum(b.total_cost_minor) cost FROM accounting_inventory_cost_balances b
      WHERE b.workspace_id=$1 AND b.sku_id=m.sku_id) c ON true
    ORDER BY s.code,m.sku_id LIMIT $3`,[workspaceId,base,limit+1])).rows;
}
function itemSubject(row,base,rate){
  const subject={kind:'ITEM',id:row.sku_id,label:row.code+' · '+row.name,currency:row.currency,base,href:'/catalog/items?'+new URLSearchParams({q:row.code})};
  if(row.secondary_unit_label)return {...subject,problem:'Weighed goods need a separate cost review.'};
  let unit;try{unit=money.userToMinor(String(row.last_cost),row.currency);}catch(error){if(error instanceof ValidationError)return {...subject,problem:'The last purchase price cannot be read exactly.'};throw error;}
  const basis=row.receipt_rate?{rate:row.receipt_rate,date:row.receipt_date,source:row.receipt_source,label:'the rate when last booked in'}:
    row.order_rate?{rate:row.order_rate,date:row.order_date,source:row.order_source,label:'the rate when last ordered'}:null;
  if(!basis)return {...subject,problem:'No rate was recorded when this item was last bought.'};
  if(!rate)return {...subject,basis,problem:'No current '+row.currency+' rate.'};
  const basisMinor=rates.convert(unit,row.currency,base,basis.rate),currentMinor=rates.convert(unit,row.currency,base,rate.rate),impact=currentMinor-basisMinor;
  const units=Number(row.stock_units||0),cost=Number(row.stock_cost||0),landed=units>0&&cost>=0?Math.round(cost/units):basisMinor;
  if(!(landed>0))return {...subject,basis,rate,problem:'No landed cost to compare with.'};
  return {...subject,basis,rate,foreignMinor:unit,basisMinor,currentMinor,landedMinor:landed,impactMinor:impact,percent:Math.round(impact*10000/landed)/100,problem:null};
}
function orderSubject(p,result){
  const subject={kind:'ORDER',id:p.id,label:p.po_number+' · '+p.supplier_name,currency:p.currency,base:p.base,href:'/purchasing/orders/'+p.id};
  if(result.original==null)return {...subject,problem:result.problem||'No current rate.'};
  return {...subject,basis:result.basis,rate:result.rate,foreignMinor:p.outstandingMinor,basisMinor:result.original,currentMinor:result.current,
    impactMinor:result.change,percent:result.percent,problem:null};
}

async function openOrders(db,workspaceId,base,{offset=0,limit=100}={}){
  return (await db.query(`SELECT p.id,p.po_number,s.name supplier_name,p.currency FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
    WHERE p.workspace_id=$1 AND p.currency<>$2 AND p.status IN('DRAFT','APPROVED','ORDERED','PARTIALLY_RECEIVED') ORDER BY p.po_number,p.id LIMIT $4 OFFSET $3`,
  [workspaceId,base,offset,limit+1])).rows;
}
async function bases(db,workspaceId,ids){
  if(!ids.length)return {checked:new Map(),estimates:new Map()};
  // Sequential: the caller may pass one transaction client.
  const checked=await db.query(`SELECT *,quoted_on::text AS quote_date FROM ${tables.baselines} WHERE workspace_id=$1 AND purchase_order_id=ANY($2::text[])`,[workspaceId,ids]);
  const estimates=await db.query(`SELECT *,rate_date::text AS rate_date FROM ${tables.estimates} WHERE workspace_id=$1 AND purchase_order_id=ANY($2::text[])`,[workspaceId,ids]);
  return {checked:new Map(checked.rows.map(r=>[r.purchase_order_id,r])),estimates:new Map(estimates.rows.map(r=>[r.purchase_order_id,r]))};
}

// Every open foreign purchase and item at the stored rates of the day.
async function evaluate(db,workspaceId,base){
  const today=await require('../lib/business-time').today(db,workspaceId),ctx={workspaceId};
  const orders=await openOrders(db,workspaceId,base,{limit:1000}),items=await itemCandidates(db,workspaceId,base);
  const ids=orders.slice(0,1000).map(o=>o.id),purchases=await loadPurchases(db,ctx,ids,base),known=await bases(db,workspaceId,ids);
  const found=await rates.ratesOn(db,workspaceId,[...orders,...items].map(r=>r.currency),base,today),subjects=[];
  for(const o of orders.slice(0,1000)){
    const entry=purchases.get(o.id);
    if(!entry||entry.error){subjects.push({kind:'ORDER',id:o.id,label:o.po_number+' · '+o.supplier_name,currency:o.currency,base,problem:entry?.error?.message||'This order changed.'});continue;}
    const rate=found.get(o.currency);
    subjects.push(rate?orderSubject(entry.value,compare(entry.value,{checked:known.checked.get(o.id),estimate:known.estimates.get(o.id),rate})):
      {kind:'ORDER',id:o.id,label:o.po_number+' · '+o.supplier_name,currency:o.currency,base,problem:'No current '+o.currency+' rate.'});
  }
  for(const row of items.slice(0,500))subjects.push(itemSubject(row,base,found.get(row.currency)));
  const used=[...found.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([c,r])=>({currency:c,rate:r.rate,date:r.date,source:r.source}));
  return {today,base,subjects,rates:used,rateDate:used.map(r=>r.date).sort().at(-1)||null,complete:orders.length<=1000&&items.length<=500};
}

async function readRule(db,workspaceId,{lock=false}={}){
  return (await db.query(`SELECT *,threshold_percent::text AS threshold FROM ${tables.rules} WHERE workspace_id=$1${lock?' FOR UPDATE':''}`,[workspaceId])).rows[0]||null;
}
// Why StockChief only watches right now, or null.
async function automaticStop(db,workspaceId,state){
  const stop=await policy.stopped(db,workspaceId,state,ACTION,true);if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAct)return 'StockChief is watching only. Change its authority to get alerts.';
  return null;
}
const key=s=>s.kind+'|'+s.id;
const over=(s,threshold)=>!s.problem&&Math.abs(s.percent)>threshold;
function words(s){
  const dir=s.impactMinor>0?'up':'down',amount=money.format(Math.abs(s.impactMinor),s.base),pct=Math.abs(s.percent).toFixed(1)+'%';
  const rate='1 '+s.currency+' = '+rates.display(s.rate.rate)+' '+s.base;
  return s.kind==='ORDER'?`${s.label}: open goods now about ${money.format(s.currentMinor,s.base)}, ${dir} ${amount} (${pct}) since ${s.basis.label}. Rate now ${rate} (${s.rate.date}).`
    :`${s.label}: each unit ${dir} ${amount} (${pct} of its landed cost of ${money.format(s.landedMinor,s.base)}) since ${s.basis.label}. Rate now ${rate} (${s.rate.date}).`;
}

// Open, update and clear alerts for one evaluation. Replaying the same rates and facts does nothing.
async function record(c,ctx,evaluation,rule,{automatic,watch=null}){
  const threshold=Number(rule.threshold),subjects=evaluation.subjects;
  const runKey=hash({watch,threshold,rates:evaluation.rates,subjects:subjects.map(s=>[key(s),s.problem||null,s.basis?.rate||null,s.rate?.rate||null,s.impactMinor??null])});
  const flagged=subjects.filter(s=>over(s,threshold));
  await storage.reserve(scoped(c),ctx.workspaceId,'fx-run:'+runKey.slice(0,48),2048+flagged.length*1024,{finished:true});
  const runId=newId('fxrun');
  const inserted=(await c.query(`INSERT INTO ${tables.runs}(workspace_id,id,run_key,rate_date,outcome,reason,authorization_kind,result,created_by)
    VALUES($1,$2,$3,$4::date,$5,$6,$7,'{}'::jsonb,$8) ON CONFLICT(workspace_id,run_key) DO NOTHING RETURNING id`,
  [ctx.workspaceId,runId,runKey,evaluation.rateDate,watch?'WATCHED':'ALERTED',watch,automatic?'AUTOMATIC':'INDIVIDUAL',automatic?null:ctx.actorId])).rows[0];
  if(!inserted){const prior=(await c.query(`SELECT id,outcome,result FROM ${tables.runs} WHERE workspace_id=$1 AND run_key=$2`,[ctx.workspaceId,runKey])).rows[0];return {replayed:true,runId:prior.id,...prior.result};}
  if(watch){
    const result={watched:flagged.map(s=>({kind:s.kind,id:s.id,label:s.label,text:words(s)})),reason:watch,rateDate:evaluation.rateDate};
    await c.query(`UPDATE ${tables.runs} SET result=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,runId,JSON.stringify(result)]);
    return {runId,...result};
  }
  const open=(await c.query(`SELECT * FROM ${tables.alerts} WHERE workspace_id=$1 AND status='OPEN' ORDER BY id FOR UPDATE`,[ctx.workspaceId])).rows;
  const openBy=new Map(open.map(a=>[a.subject_kind+'|'+a.subject_id,a]));
  const fresh=flagged.filter(s=>!openBy.has(key(s)));
  const seen=fresh.length?new Map((await c.query(`SELECT DISTINCT ON (subject_kind,subject_id) subject_kind,subject_id,change_percent::text FROM ${tables.alerts}
    WHERE workspace_id=$1 AND status='DISMISSED' AND subject_kind||'|'||subject_id=ANY($2::text[]) ORDER BY subject_kind,subject_id,dismissed_at DESC`,
  [ctx.workspaceId,fresh.map(key)])).rows.map(r=>[r.subject_kind+'|'+r.subject_id,Number(r.change_percent)])):new Map();
  const opened=[],updated=[],cleared=[],kept=[];
  for(const s of flagged){
    const values=[s.label,s.basis.rate,s.basis.date||null,s.basis.source,s.rate.rate,s.rate.date,s.rate.source,s.basisMinor,s.currentMinor,s.impactMinor,s.percent,threshold,runId];
    const existing=openBy.get(key(s));
    if(existing){
      await c.query(`UPDATE ${tables.alerts} SET label=$3,basis_rate=$4,basis_date=$5::date,basis_source=$6,current_rate=$7,rate_date=$8::date,rate_source=$9,
          basis_minor=$10,current_minor=$11,impact_minor=$12,change_percent=$13,threshold_percent=$14,last_run_id=$15,updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,existing.id,...values]);
      updated.push(existing.id);continue;
    }
    if(seen.has(key(s))&&Math.abs(seen.get(key(s))-s.percent)<=threshold){kept.push(key(s));continue;}
    const id=newId('fxalert');
    await c.query(`INSERT INTO ${tables.alerts}(workspace_id,id,subject_kind,subject_id,currency,base_currency,label,basis_rate,basis_date,basis_source,current_rate,rate_date,rate_source,
        basis_minor,current_minor,impact_minor,change_percent,threshold_percent,status,opened_run_id,last_run_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12::date,$13,$14,$15,$16,$17,$18,'OPEN',$19,$19)`,
    [ctx.workspaceId,id,s.kind,s.id,s.currency,s.base,...values]);
    opened.push({id,text:words(s)});
  }
  const present=new Map(subjects.map(s=>[key(s),s]));
  for(const a of open){
    const k=a.subject_kind+'|'+a.subject_id,s=present.get(k);
    if(flagged.some(f=>key(f)===k))continue;
    let reason=null;
    if(s&&!s.problem)reason='Back within your '+threshold+'% limit.';
    else if(!s&&evaluation.complete)reason=a.subject_kind==='ORDER'?'The order is no longer open.':'No longer bought mostly in '+a.currency+'.';
    if(!reason)continue;// Missing facts never clear an alert.
    await c.query(`UPDATE ${tables.alerts} SET status='CLEARED',cleared_reason=$3,cleared_at=clock_timestamp(),last_run_id=$4,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,a.id,reason,runId]);
    cleared.push(a.id);
  }
  const result={rateDate:evaluation.rateDate,threshold,opened:opened.map(a=>a.id),updated,cleared,kept};
  if(opened.length||cleared.length||updated.length)await audit.record(c,ctx,{action:automatic?'StockChief checked exchange-rate costs':'Checked exchange-rate costs',
    reference:'Rates of '+evaluation.rateDate,before:{open:open.map(a=>a.id)},after:{opened:result.opened,updated,cleared,threshold,rates:evaluation.rates}});
  if(automatic&&opened.length&&rule.email_connector_id)result.email=await email(c,ctx,rule,runId,opened);
  await c.query(`UPDATE ${tables.runs} SET result=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,runId,JSON.stringify(result)]);
  return {runId,...result};
}

// One email per check for newly opened alerts, through the connected mailbox.
async function email(c,ctx,rule,runId,opened){
  const to=(await c.query('SELECT a.email FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2',[ctx.workspaceId,ctx.actorId])).rows[0]?.email;
  if(!to)return {held:'The owner has no email address.'};
  const body='Exchange rates changed what your foreign purchases cost.\n\n'+opened.map(a=>'- '+a.text).join('\n')+
    '\n\nStockChief has not changed any price or cost. Review: '+(require('../config').connections.publicOrigin||'')+href;
  await c.query('SAVEPOINT fx_alert_email');
  try{
    const queued=await require('../connections/postgres-outbound-mail').queueInTransaction(c,ctx,{recipientKind:'address',recipientEmail:to,
      connectorId:rule.email_connector_id,subject:'Exchange rates changed your purchase costs',body,
      standingAuthority:{kind:'fx_alert',runId,alertIds:opened.map(a=>a.id),connectorId:rule.email_connector_id}},'fx-alert-email:'+runId,{agentRequested:true,agentJob:JOB});
    await c.query('RELEASE SAVEPOINT fx_alert_email');
    return {communicationId:queued.communicationId,effectId:queued.effectId};
  }catch(error){
    await c.query('ROLLBACK TO SAVEPOINT fx_alert_email');await c.query('RELEASE SAVEPOINT fx_alert_email');
    if(!['validation_error','entitlement_required','forbidden','not_found','authorization_error'].includes(error.code))throw error;
    return {held:String(error.message).slice(0,300)};
  }
}
// Checked again before the provider is called.
async function emailAuthority(db,workspaceId,grant){
  const state=await policy.accountState(db,workspaceId);
  if(!alone(state))throw new ValidationError('Exchange-rate alert emails need Growth or above. The email is held.');
  const stop=await policy.stopped(db,workspaceId,state,ACTION,true);if(stop)throw new ValidationError(stop+' The email is held.');
  const rule=await readRule(db,workspaceId);
  if(!rule?.enabled||rule.email_connector_id!==grant.connectorId)throw new ValidationError('Exchange-rate alert emails changed. The email is held.');
  const ids=Array.isArray(grant.alertIds)?grant.alertIds.map(String):[];
  const open=Number((await db.query(`SELECT count(*) n FROM ${tables.alerts} WHERE workspace_id=$1 AND id=ANY($2::text[]) AND opened_run_id=$3 AND status='OPEN'`,
    [workspaceId,ids,String(grant.runId||'')])).rows[0].n);
  if(!ids.length||open!==ids.length)throw new ValidationError('These exchange-rate alerts changed before the email was sent. The email is held.');
}

async function hasForeign(db,workspaceId,base){
  return (await db.query(`SELECT EXISTS(SELECT 1 FROM purchase_orders WHERE workspace_id=$1 AND currency<>$2 AND status<>'CANCELLED')
    OR EXISTS(SELECT 1 FROM suppliers WHERE workspace_id=$1 AND currency<>$2 AND status='active') AS foreign`,[workspaceId,base])).rows[0].foreign;
}

// Worker: fetch the day's rates, then open and clear alerts on their own.
async function run(database,workspaceId){
  const actorId=await currentOwner(database,workspaceId);if(!actorId)return {skipped:'owner_unavailable'};
  const ctx={workspaceId,actorId},state=await policy.accountState(database,workspaceId);
  if(!alone(state))return {skipped:'plan'};
  const pilot=(await database.query('SELECT paused,suspended FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];
  if(Number(pilot?.paused)||Number(pilot?.suspended))return {held:'paused'};
  const books=(await database.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[workspaceId])).rows[0];
  if(!books)return {skipped:'no_books'};
  const base=money.code(books.base_currency);
  if(!(await hasForeign(database,workspaceId,base)))return {skipped:'no_foreign'};
  let fetched;
  try{const r=await rates.refresh(database,workspaceId);fetched={date:r.date,source:r.source,stored:r.stored};}
  catch(error){if(!(error instanceof ValidationError)&&error.code!=='entitlement_required')throw error;fetched={problem:error.message};}
  const estimates=await backfillEstimates(database,workspaceId);
  const rule=await readRule(database,workspaceId);
  if(!rule?.enabled)return {fetched,estimates,skipped:'no_rule'};
  const result=await tx(database,async c=>{
    const current=await readRule(c,workspaceId);
    if(!current?.enabled||current.revision!==rule.revision)return {stale:true};
    const evaluation=await evaluate(c,workspaceId,base);
    if(!evaluation.rateDate)return {problem:'No current exchange rate is stored.'};
    return record(c,ctx,evaluation,current,{automatic:true,watch:await automaticStop(c,workspaceId,state)});
  });
  return {fetched,estimates,...result};
}
async function schedule(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);if(!alone(state))return {queued:0};
  const books=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[workspaceId])).rows[0];
  if(!books||!(await hasForeign(db,workspaceId,books.base_currency)))return {queued:0};
  // Every six hours, so a new day's reference rates are picked up soon after publication.
  const slot=Math.floor(Date.now()/21600000);
  const job=await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:KIND,priority:70,maxAttempts:3,idempotencyKey:'fx-rates:'+slot,payload:{}});
  return {queued:job.created?1:0};
}

// A person fetches rates now; on Growth and above, also checks alerts now.
async function refreshNow(database,ctx){
  await owner(database,ctx);await policy.requireWorkspaceJob(database,ctx.workspaceId,JOB,'suggest');
  const r=await rates.refresh(database,ctx.workspaceId);
  await backfillEstimates(database,ctx.workspaceId);
  return {date:r.date,source:r.source,stored:r.stored};
}
async function checkNow(database,ctx){
  await owner(database,ctx);
  const state=await policy.requireWorkspaceJob(database,ctx.workspaceId,JOB,'draft');
  const stop=await policy.stopped(database,ctx.workspaceId,state,ACTION,false);if(stop)throw new ValidationError(stop);
  const base=await baseCurrency(database,ctx.workspaceId);
  let fetched=null;
  try{const r=await rates.refresh(database,ctx.workspaceId);fetched={date:r.date,stored:r.stored};}
  catch(error){if(!(error instanceof ValidationError))throw error;fetched={problem:error.message};}
  await backfillEstimates(database,ctx.workspaceId);
  return tx(database,async c=>{
    const rule=await readRule(c,ctx.workspaceId);if(!rule?.enabled)throw new ValidationError('Choose the change that should alert you first.');
    const evaluation=await evaluate(c,ctx.workspaceId,base);
    if(!evaluation.rateDate)throw new ValidationError(fetched?.problem||'No current exchange rate is stored. Get today’s rates or enter your own.');
    return {fetched,...(await record(c,ctx,evaluation,rule,{automatic:false}))};
  });
}
async function dismiss(database,ctx,alertId){
  return tx(database,async c=>{
    await owner(c,ctx);
    const row=(await c.query(`UPDATE ${tables.alerts} SET status='DISMISSED',dismissed_by=$3,dismissed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND id=$2 AND status='OPEN' RETURNING subject_kind,subject_id,label,change_percent::text`,[ctx.workspaceId,String(alertId||''),ctx.actorId])).rows[0];
    if(!row)throw new ValidationError('This alert is no longer open.');
    await audit.record(c,ctx,{action:'Marked an exchange-rate alert as seen',reference:row.label,after:{alertId,percent:Number(row.change_percent)}});
    return {dismissed:true};
  });
}

// The owner's alert rule: the change that should alert, and the mailbox for email.
async function configure(database,ctx,input){
  return tx(database,async c=>{
    await owner(c,ctx);
    const prior=await readRule(c,ctx.workspaceId,{lock:true});
    if(Number(input.revision||0)!==(prior?.revision||0))throw new ValidationError('Reload the alert rule before changing it.');
    if(input.stop==='yes'){
      if(prior?.enabled){
        await c.query(`UPDATE ${tables.rules} SET enabled=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1`,[ctx.workspaceId]);
        await audit.record(c,ctx,{action:'Turned off exchange-rate alerts',before:{threshold:Number(prior.threshold)}});
      }
      return {stopped:true};
    }
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm when StockChief should alert you.');
    const text=String(input.thresholdPercent??'').trim();
    if(!/^\d{1,2}(?:\.\d{1,2})?$/.test(text)||Number(text)<=0||Number(text)>50)throw new ValidationError('Choose a change from 0.01% to 50%.');
    const threshold=Number(text);
    let connector=null;const wanted=String(input.mailbox||'').trim();
    if(wanted&&wanted!=='none'){
      const box=(await require('../connections/postgres-outbound-mail').mailboxes(c,ctx.workspaceId)).find(m=>m.id===wanted);
      if(!box)throw new ValidationError('Choose a connected mailbox, or no email.');
      connector=box.id;
    }
    if(prior?.enabled&&Number(prior.threshold)===threshold&&(prior.email_connector_id||null)===connector&&prior.authorized_by===ctx.actorId)return {unchanged:true};
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await storage.reserve(scoped(c),ctx.workspaceId,'fx-rule:'+((prior?.revision||0)+1),1024,{finished:true});
    await c.query(`INSERT INTO ${tables.rules}(workspace_id,threshold_percent,email_connector_id,authorized_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(workspace_id) DO UPDATE SET threshold_percent=EXCLUDED.threshold_percent,email_connector_id=EXCLUDED.email_connector_id,
        authorized_by=EXCLUDED.authorized_by,enabled=true,revision=agent_fx_alert_rules.revision+1,updated_at=now()`,[ctx.workspaceId,text,connector,ctx.actorId]);
    await audit.record(c,ctx,{action:'Saved the exchange-rate alert rule',before:prior?{threshold:Number(prior.threshold),email:Boolean(prior.email_connector_id),enabled:prior.enabled}:{},
      after:{threshold,email:Boolean(connector)}});
    return {saved:true};
  });
}

// The page and review. Starter sees one suggestion; nothing is written here.
async function screen(db,ctx,{order=null,page=1}={}){
  await owner(db,ctx);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'suggest'),tier=policy.usesAgentTerms(state)?state.plan:null;
  const allowed=policy.permits(tier,JOB,'draft'),starter=!allowed;
  page=Number(page);if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid purchase-review page.');
  const base=await baseCurrency(db,ctx.workspaceId);
  const ids=await openOrders(db,ctx.workspaceId,base,{offset:(page-1)*100,limit:100});
  const shown=ids.slice(0,100),selectedIds=shown.map(p=>p.id);
  if(order&&!selectedIds.includes(String(order)))selectedIds.push(String(order));
  const purchases=await loadPurchases(db,ctx,selectedIds,base),known=await bases(db,ctx.workspaceId,selectedIds);
  const items=await itemCandidates(db,ctx.workspaceId,base,starter?50:100),rule=await readRule(db,ctx.workspaceId);
  const selected=order?purchases.get(String(order)):null;
  if(order&&!selected)throw new NotFoundError('That purchase order is not in this inventory.');if(selected?.error)throw selected.error;
  const chosen=selected?.value||null,currencies=[...new Set([...shown.map(p=>p.currency),...items.map(i=>i.currency),...(chosen?[chosen.currency]:[])])];
  const now=await rates.latest(db,ctx.workspaceId,currencies,base);
  const missing=currencies.filter(c=>c!==base&&!now.rates.has(c));
  const problem=missing.length&&now.failed?now.failed:null;
  const result=(p)=>{const rate=now.rates.get(p.currency);if(!rate)return {problem:problem||'The rate source does not cover '+p.currency+' to '+base+'. Enter your own rate for it.'};
    return compare(p,{checked:allowed?known.checked.get(p.id):null,estimate:known.estimates.get(p.id),rate});};
  const rows=[];
  for(const row of shown){try{const entry=purchases.get(row.id);if(!entry)throw new ValidationError('This PO is no longer available. Reload the review.');if(entry.error)throw entry.error;rows.push({...entry.value,...result(entry.value)});}catch(error){if(!(error instanceof ValidationError))throw error;rows.push({...row,problem:error.message});}}
  const itemRows=items.slice(0,starter?50:100).map(row=>itemSubject(row,base,now.rates.get(row.currency)));
  // Starter: the single biggest change, as a suggestion.
  const candidates=[...rows.filter(r=>r.original!=null).map(r=>orderSubject(r,r)),...itemRows.filter(s=>!s.problem)];
  const top=candidates.sort((a,b)=>Math.abs(b.percent)-Math.abs(a.percent)||a.label.localeCompare(b.label))[0]||null;
  let alerts=[],cleared=[],runs=[],mailboxes=[];
  if(allowed){
    alerts=(await db.query(`SELECT *,change_percent::float8 AS percent,rate_date::text AS on_date FROM ${tables.alerts} WHERE workspace_id=$1 AND status='OPEN' ORDER BY abs(impact_minor) DESC,id LIMIT 100`,[ctx.workspaceId])).rows;
    cleared=(await db.query(`SELECT id,label,status,cleared_reason,coalesce(cleared_at,dismissed_at) AS at FROM ${tables.alerts} WHERE workspace_id=$1 AND status<>'OPEN' ORDER BY coalesce(cleared_at,dismissed_at) DESC,id LIMIT 10`,[ctx.workspaceId])).rows;
    runs=(await db.query(`SELECT id,outcome,reason,authorization_kind,result,rate_date::text,created_at FROM ${tables.runs} WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 5`,[ctx.workspaceId])).rows;
    mailboxes=await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId);
  }
  const manual=await rates.manualRates(db,ctx.workspaceId,allowed?20:5);
  const automatic=allowed&&rule?.enabled?await automaticStop(db,ctx.workspaceId,state):null;
  // With no rate source reachable and none stored, there is no estimate at all.
  const saved=chosen?(allowed?known.checked.get(chosen.id)||null:null):null,chosenResult=chosen&&(now.rates.has(chosen.currency)||!now.failed)?result(chosen):null;
  const rateList=[...now.rates.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([currency,r])=>({currency,base,...r,shown:rates.display(r.rate),label:rates.sourceLabel(r.source)}));
  return {allowed,tier,starter,base,today:now.today,rates:rateList,problem,failed:now.failed,rows:starter?rows.slice(0,1):rows,items:starter?[]:itemRows,
    more:!starter&&ids.length>100,page,chosen,saved,result:chosenResult,
    suggestion:top?{...top,text:words(top)}:null,rule,alerts,cleared,runs,manual,mailboxes,automatic,shadow:Boolean(state.shadow),
    provider:{label:rates.current().label,link:rates.current().link},currencies:currencies.filter(c=>c!==base),href,
    display:rates.display,money:(minor,code)=>minor==null?'Unknown':money.format(Number(minor),code)};
}
async function readPage(db,ctx,args){
  const p=await screen(db,ctx,{page:args.page});
  if(p.starter)return {rows:p.suggestion?[{Order:p.suggestion.label,'Cost change':money.format(p.suggestion.impactMinor,p.base),'Change %':p.suggestion.percent.toFixed(2)+'%',Review:p.suggestion.text,link:href}]:
      p.rows.length?p.rows.map(r=>({Order:r.po_number,Review:r.problem||'No change yet',link:href})):[{Review:p.problem||'No open foreign-currency purchase orders.',link:href}],
    more:false,summary:'One suggestion from your foreign-currency purchases. Growth, Pro and Custom check rates every day and alert you when costs move past your limit.'};
  const orders=p.rows.map(r=>({Order:r.po_number,Supplier:r.supplier_name,'PO currency':r.currency,'Open recorded goods':r.outstandingMinor==null?'Needs review':money.format(r.outstandingMinor,r.currency),
    'At ordering':r.original==null?'Not established':money.format(r.original,p.base),'Now':r.current==null?'Unavailable':money.format(r.current,p.base),
    'Cost change':r.change==null?'Not established':money.format(r.change,p.base),'Change %':r.percent==null?'':r.percent.toFixed(2)+'%',
    Review:r.problem||(r.change>0?'Cost increased':r.change<0?'Cost decreased':'No change at this precision'),link:href+'?order='+encodeURIComponent(r.id)}));
  const items=p.items.map(s=>({Order:s.label,'PO currency':s.currency,'Cost change':s.impactMinor==null?'Not established':money.format(s.impactMinor,p.base)+' per unit',
    'Change %':s.percent==null?'':s.percent.toFixed(2)+'%',Review:s.problem||(s.impactMinor>0?'Landed cost increased':s.impactMinor<0?'Landed cost decreased':'No change at this precision'),link:href}));
  const rows=[...orders,...items];
  return {rows:rows.length?rows:[{Review:p.problem||'No open foreign-currency purchase orders.',link:href}],more:p.more,
    summary:'Foreign purchase goods and items bought mostly in another currency, at the latest rates'+(p.rates.length?' ('+p.rates.map(r=>r.currency+' '+r.date).join(', ')+')':'')+'. StockChief alerts you when a change passes your limit and never changes prices or costs. Freight, duty and fees keep their own allocation.'};
}

async function inbox(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);if(!alone(state))return [];
  const rows=(await db.query(`SELECT id,subject_kind,label,currency,base_currency,impact_minor,change_percent::float8 percent,current_minor,rate_date::text on_date,updated_at
    FROM ${tables.alerts} WHERE workspace_id=$1 AND status='OPEN' ORDER BY abs(impact_minor) DESC,id LIMIT 50`,[workspaceId])).rows;
  return rows.map(r=>{const up=Number(r.impact_minor)>0,amount=money.format(Math.abs(Number(r.impact_minor)),r.base_currency);
    return {kind:'purchase',importance:'Needs You',priority:60,title:'Exchange rate '+(up?'raised':'lowered')+' the cost of '+r.label.split(' · ')[0],
      happened:r.currency+' moved '+Math.abs(r.percent).toFixed(1)+'% against '+r.base_currency+(r.subject_kind==='ORDER'?'. Open goods now cost about '+money.format(Number(r.current_minor),r.base_currency)+', '+amount+(up?' more':' less')+'.':'. Each unit costs about '+amount+(up?' more':' less')+'.'),
      why:'This is more than the change you asked to hear about.',recommendation:'Check the order and your selling prices. StockChief has not changed any price or cost.',
      href:href+'#alert-'+r.id,actionLabel:'Review exchange rates',sourceId:'fx-alert:'+r.id,createdAt:r.updated_at,at:r.updated_at,
      moneyCurrency:r.base_currency,moneyValue:Math.abs(Number(r.impact_minor))};});
}

module.exports={JOB,ACTION,KIND,href,owner,purchase,baseline,saveBaseline,compare,screen,recordEstimate,backfillEstimates,receiptRate,receiptPreview,recordReceipt,
  evaluate,run,schedule,refreshNow,checkNow,dismiss,configure,readRule,emailAuthority,inbox,
  definition:{id:40,key:'purchase-fx',label:'Review foreign purchase currency exposure',readPage}};

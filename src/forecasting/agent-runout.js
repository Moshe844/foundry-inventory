'use strict';

// Job 151: shows when each item will run out, and what running out costs.
//
// A daily worker run looks at every active product, across all owned stock
// locations:
//   - free stock: usable stock after reservations, less the units open
//     customer orders and backorders still wait for;
//   - demand day by day: the forecast planning uses (jobs 144, 146 and 148),
//     else the product's own job 144 forecast, else plain sales history;
//   - purchase orders with a delivery date, arriving on that date. Overdue or
//     undated deliveries are listed but not counted: their date is unknown.
// The run-out day is the first day demand cannot be met in full. The next
// delivery is the first dated purchase order; with none, an order placed today
// would arrive after the recorded lead time. Running out before it costs the
// gross margin of the sales that cannot be made (current selling price less
// cost) and keeps the open orders it cannot fill waiting. Items that run out
// before their next delivery go to Needs you, ranked by that cost.
//
// It runs alone on every plan. It changes no stock, order or setting, so Watch
// only, a pause and the first 14 days do not stop it.
const policy=require('../commercial/agent-plan');
const queue=require('../operations/postgres-job-queue');
const permissions=require('../actions/permissions');
const installed=require('../db/schema-installed');
const time=require('../lib/business-time');
const models=require('./models');
const base=require('./agent-demand-forecast');
const decision=require('../purchasing/replenishment-decision');
const money=require('../domain/currency');
const {addDays}=require('../accounting/customer-money');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId}=require('../lib/util');

const JOB=151,KIND='planning.runout.v1',href='/planning/run-out',PAGE=100,HORIZON=365,INBOX_ITEMS=10;
const runs='stockchief_runtime.agent_runout_runs',estimates='stockchief_runtime.agent_runout_estimates';
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
const round=(n,places=2)=>Math.round(n*10**places)/10**places;
const DAY=86400000;
const between=(from,to)=>Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/DAY);

async function member(db,ctx){
  const row=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Choose an inventory you can access.');
  permissions.assertCan(row,permissions.MANAGE_REPLENISHMENT,'see when stock runs out');
  return row;
}
async function plan(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  return policy.usesAgentTerms(account)&&policy.permits(account.plan,JOB,'automatic')?account.plan:null;
}

// Daily demand for the next year, per product.
async function demandFor(db,workspaceId,skuIds,today,rows){
  const used=await base.planningSources(db,workspaceId,skuIds),result=new Map();
  const saved=new Map(await installed.has(db,'stockchief_runtime.agent_demand_forecasts')?(await db.query(`SELECT sku_id,status,shape,method_label
    FROM stockchief_runtime.agent_demand_forecasts WHERE workspace_id=$1 AND sku_id=ANY($2::text[])`,[workspaceId,skuIds])).rows.map(r=>[r.sku_id,r]):[]);
  const days=n=>Array.from({length:n},(_,i)=>addDays(today,i));
  const dates=days(HORIZON);
  const fromShape=(shape,factor=1)=>dates.map(d=>models.rateFor(shape,d)*factor);
  // Products with no forecast on record (Starter, or before the first daily
  // run) get the same job 144 method fitted on their own history.
  const unsaved=skuIds.filter(id=>!used.has(id)&&!saved.has(id));
  const fitted=new Map();
  if(unsaved.length){
    const from=await base.historyStart(db,workspaceId,today),history=await base.demand(db,workspaceId,unsaved,{from,today});
    for(const id of unsaved){const f=base.fit(base.daysOf(history.get(id),today));if(f.shape)fitted.set(id,f);}
  }
  for(const skuId of skuIds){
    const source=used.get(skuId),own=saved.get(skuId),fit=fitted.get(skuId);
    if(source)result.set(skuId,{basis:'FORECAST',label:source.label,daily:fromShape(source.shape,source.factor??1)});
    else if(own&&own.status!=='EXCLUDED'&&own.shape)result.set(skuId,{basis:'FORECAST',label:own.method_label,daily:fromShape(own.shape)});
    else if(fit&&own?.status!=='EXCLUDED')result.set(skuId,{basis:'FORECAST',label:fit.label,daily:fromShape(fit.shape)});
    else{
      const issued=rows.filter(r=>r.sku_id===skuId&&r.location_id&&r.scope!=='workspace').reduce((n,r)=>n+Number(r.issued||0),0);
      const rate=issued/decision.WINDOW_DAYS;
      result.set(skuId,rate>0?{basis:'HISTORY',label:'Sales in the last 90 days',daily:dates.map(()=>rate)}:{basis:'NONE',label:'No recorded sales',daily:dates.map(()=>0)});
    }
  }
  return result;
}

// One estimate per product: the same calculation the daily run saves.
// A scenario (job 149's "what if" answers) changes the same calculation:
//   demandFactor   multiplies demand every day;
//   supplierId with extraLeadDays moves that supplier's dated deliveries;
//   supplierId with withoutSupplier drops that supplier's deliveries;
//   leads          Map(skuId -> lead days) for an order placed today;
//   noSupplier     Set(skuId) with no other supplier: nothing can arrive
//                  within noSupplyDays.
async function estimate(db,workspaceId,skuIds,{today=null,scenario=null}={}){
  if(!skuIds.length)return [];
  today=today||await time.today(db,workspaceId);
  const data=await load(db,workspaceId,skuIds,today);
  return data?compute(data,scenario):[];
}

// Everything the calculation reads, once, so several scenarios can share it.
async function load(db,workspaceId,skuIds,today){
  const args=[workspaceId,skuIds];
  const products=(await db.query(`SELECT s.id sku_id,s.code,i.id item_id,i.name,i.unit_label FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 ORDER BY s.id`,args)).rows;
  if(!products.length)return null;
  const ids=products.map(p=>p.sku_id);
  const rows=await require('../purchasing/postgres-replenishment-state').rows(db,workspaceId,{onlySkuIds:ids});
  const kits=require('../domain/postgres-kit-availability'),usable=await kits.stock(db,workspaceId,ids),kitCapacity=await kits.read(db,workspaceId,ids);
  const free=new Map();
  for(const [key,quantity] of usable){const skuId=JSON.parse(key)[0];free.set(skuId,(free.get(skuId)||0)+Number(quantity));}
  const waiting=(await db.query(`SELECT l.sku_id,o.order_number,o.allocation_priority,o.needed_by,o.order_date,o.id,
      (l.quantity_ordered-l.quantity_fulfilled-coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id),0))::float8 AS units
    FROM sales_order_lines l JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
    WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
    ORDER BY o.allocation_priority,o.needed_by NULLS LAST,o.order_date,o.order_number,o.id`,[workspaceId,ids])).rows.filter(r=>r.units>0);
  const incoming=(await db.query(`SELECT l.sku_id,o.po_number,o.supplier_id,o.expected_date::text AS expected,(l.quantity_units-l.quantity_received_units)::float8 AS units
    FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
    WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND o.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED')
      AND coalesce(to_jsonb(o)->>'delivery_kind','WAREHOUSE')='WAREHOUSE' AND l.quantity_units>l.quantity_received_units
      AND to_jsonb(l)->>'supplier_supply_hold_id' IS NULL
    ORDER BY o.expected_date NULLS LAST,o.po_number`,[workspaceId,ids])).rows;
  const prices=new Map((await db.query(`SELECT s.id,price.amount_minor AS price,price.currency AS price_currency,cost.amount_minor AS cost,cost.currency AS cost_currency,
      book.base_currency,stock.cost_minor AS stock_cost
    FROM skus s LEFT JOIN accounting_settings book ON book.workspace_id=s.workspace_id AND book.enabled=1
    LEFT JOIN LATERAL (SELECT amount_minor,currency FROM sku_prices p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id AND p.amount_minor IS NOT NULL
      ORDER BY created_at DESC,id DESC LIMIT 1) price ON true
    LEFT JOIN LATERAL (SELECT amount_minor,currency FROM sku_purchase_costs p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1) cost ON true
    LEFT JOIN LATERAL (SELECT CASE WHEN sum(quantity_units)>0 THEN round(sum(total_cost_minor)::numeric/sum(quantity_units)) END AS cost_minor
      FROM accounting_inventory_cost_balances b WHERE b.workspace_id=s.workspace_id AND b.sku_id=s.id) stock ON true
    WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])`,[workspaceId,ids])).rows.map(r=>[r.id,r]));
  const demand=await demandFor(db,workspaceId,ids,today,rows);
  return {today,products,rows,free,kitCapacity,waiting,incoming,prices,demand};
}

function compute({today,products,rows,free,kitCapacity,waiting,incoming,prices,demand},scenario=null){
  const factor=scenario?.demandFactor??1,moved=scenario?.supplierId||null;
  const result=[];
  for(const p of products){
    const list=rows.filter(r=>r.sku_id===p.sku_id);
    const sites=list.filter(r=>r.location_id&&r.scope!=='workspace'),global=list.find(r=>r.scope==='workspace');
    const kit=kitCapacity.get(p.sku_id),available=kit?Number(kit.buildable||0):round(free.get(p.sku_id)||0,6);
    const orders=waiting.filter(o=>o.sku_id===p.sku_id),owed=round(orders.reduce((n,o)=>n+o.units,0),6);
    let lines=incoming.filter(l=>l.sku_id===p.sku_id);
    if(moved&&scenario.withoutSupplier)lines=lines.filter(l=>l.supplier_id!==moved);
    else if(moved&&scenario.extraLeadDays)lines=lines.map(l=>l.supplier_id===moved&&l.expected&&l.expected>=today?
      {...l,expected:[addDays(l.expected,scenario.extraLeadDays),today].sort().at(-1)}:l);
    const dated=lines.filter(l=>l.expected&&l.expected>=today).sort((a,b)=>a.expected.localeCompare(b.expected)),
      unknown=lines.filter(l=>!l.expected||l.expected<today);
    const want=demand.get(p.sku_id),daily=factor===1?want.daily:want.daily.map(v=>v*factor);
    if(!available&&!owed&&!lines.length&&want.basis==='NONE'&&!Number(sites.reduce((n,r)=>n+Number(r.on_hand||0),0)))continue;
    // Customer orders already waiting come first, in their order priority.
    let left=available,affected=0;
    for(const o of orders){if(left>=o.units-1e-9)left-=o.units;else{affected++;left=0;}}
    const arrivals=new Map();
    for(const l of dated){const d=between(today,l.expected);if(d<HORIZON)arrivals.set(d,(arrivals.get(d)||0)+l.units);}
    // The next delivery: the first dated purchase order, or an order placed
    // today arriving after the recorded lead time.
    const leads=[...(global?[global]:[]),...sites].filter(r=>!r.lead_time_assumed&&r.lead_time_days!=null).map(r=>Math.ceil(Number(r.local_lead??r.lead_time_days)));
    const lead=scenario?.leads?.has(p.sku_id)?scenario.leads.get(p.sku_id):leads.length?Math.min(...leads):null;
    const next=dated[0]||null,cutOff=!next&&Boolean(scenario?.noSupplier?.has(p.sku_id));
    const nextDay=next?between(today,next.expected):cutOff?scenario.noSupplyDays||90:lead??decision.DEFAULT_LEAD_DAYS;
    let stock=available-owed,runout=null,unmet=0,unmetDays=0;
    for(let d=0;d<HORIZON;d++){
      stock+=arrivals.get(d)||0;
      const need=daily[d];
      if(runout===null&&((d===0&&stock<=0&&(owed>0||need>0))||stock<need-1e-9))runout=d;
      if(runout!==null&&d<nextDay){const short=Math.max(0,need-Math.max(0,stock));unmet+=short;if(short>1e-9)unmetDays++;}
      stock=stock>0?Math.max(0,stock-need):stock;
    }
    const flagged=runout!==null&&runout<nextDay;
    const value=prices.get(p.sku_id)||{};
    const cost=value.cost!=null?{minor:Number(value.cost),currency:value.cost_currency}:value.stock_cost!=null&&value.base_currency?{minor:Number(value.stock_cost),currency:value.base_currency}:null;
    const margin=value.price!=null&&cost&&cost.currency===value.price_currency?Math.max(0,Number(value.price)-cost.minor):null;
    const month=daily.slice(0,30).reduce((a,b)=>a+b,0)/30;
    const daysShort=flagged?nextDay-runout:null;
    const dailyMargin=margin==null?null:Math.round((flagged&&daysShort>0?unmet/daysShort:month)*margin);
    const lost=margin==null||!flagged?null:Math.round(unmet*margin);
    let reason=null;
    if(flagged)reason=runout===0?'Out of stock now':'Runs out '+(runout===1?'tomorrow':'in '+runout+' days');
    if(flagged)reason+=next?', before '+next.po_number+' arrives on '+next.expected+'.':cutOff?'. No delivery is due and no other supplier is on record.':lead!=null?
      '. No delivery is due, and an order placed today would arrive in about '+lead+' days.':'. No delivery is due and no lead time is recorded.';
    else if(runout===null)reason=want.basis==='NONE'&&!owed?'No recorded sales or open orders.':'Enough stock for the next year.';
    else reason='Runs out after its next delivery.';
    if(flagged&&margin==null)reason+=' Record a selling price and cost to see what it costs.';
    result.push({skuId:p.sku_id,itemId:p.item_id,code:p.code,name:p.name,unit:p.unit_label,available,waiting:owed,dailyDemand:round(month,4),
      basis:want.basis,label:want.label,runout:runout===null?null:addDays(today,runout),nextDelivery:!cutOff&&nextDay<HORIZON?addDays(today,nextDay):null,
      nextReference:next?next.po_number:null,beforeDelivery:flagged,daysShort,unitsShort:flagged?round(unmet,4):null,
      currency:margin==null?null:value.price_currency,unitMargin:margin,dailyMargin,lostMargin:lost,ordersAffected:affected,reason,
      price:value.price==null?null:Number(value.price),priceCurrency:value.price_currency||null,cost:cost?.minor??null,costCurrency:cost?.currency||null,noSupplier:cutOff,
      evidence:{lead,leadRecorded:lead!=null,orders:orders.map(o=>({number:o.order_number,units:o.units})).slice(0,20),
        incoming:dated.map(l=>({po:l.po_number,date:l.expected,units:l.units})).slice(0,20),
        notCounted:unknown.map(l=>({po:l.po_number,date:l.expected||null,units:l.units})).slice(0,20)}});
  }
  return result;
}

async function save(c,workspaceId,runId,today,list){
  for(const e of list)await c.query(`INSERT INTO ${estimates}(workspace_id,sku_id,run_id,as_of,available,waiting,daily_demand,demand_basis,demand_label,
      runout_date,next_delivery_date,next_delivery,before_delivery,days_short,units_short,currency,unit_margin_minor,daily_margin_minor,lost_margin_minor,
      orders_affected,reason,evidence,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,now())
    ON CONFLICT(workspace_id,sku_id) DO UPDATE SET run_id=EXCLUDED.run_id,as_of=EXCLUDED.as_of,available=EXCLUDED.available,waiting=EXCLUDED.waiting,
      daily_demand=EXCLUDED.daily_demand,demand_basis=EXCLUDED.demand_basis,demand_label=EXCLUDED.demand_label,runout_date=EXCLUDED.runout_date,
      next_delivery_date=EXCLUDED.next_delivery_date,next_delivery=EXCLUDED.next_delivery,before_delivery=EXCLUDED.before_delivery,days_short=EXCLUDED.days_short,
      units_short=EXCLUDED.units_short,currency=EXCLUDED.currency,unit_margin_minor=EXCLUDED.unit_margin_minor,daily_margin_minor=EXCLUDED.daily_margin_minor,
      lost_margin_minor=EXCLUDED.lost_margin_minor,orders_affected=EXCLUDED.orders_affected,reason=EXCLUDED.reason,evidence=EXCLUDED.evidence,updated_at=now()`,
  [workspaceId,e.skuId,runId,today,e.available,e.waiting,e.dailyDemand,e.basis,e.label,e.runout,e.nextDelivery,e.nextReference,e.beforeDelivery,e.daysShort,
    e.unitsShort,e.currency,e.unitMargin,e.dailyMargin,e.lostMargin,e.ordersAffected,e.reason,JSON.stringify(e.evidence)]);
}

// One worker page: up to 100 active products. A finished run, or a page this
// run already passed, is not processed again.
async function process(c,workspaceId,payload={}){
  const runKey=String(payload.runKey||'');
  if(!runKey||runKey.length>80)throw Object.assign(new ValidationError('A run-out check needs its run key.'),{retryable:false});
  const tier=await plan(c,workspaceId);
  if(!tier)return {skipped:'plan'};
  const today=await time.today(c,workspaceId);
  let run=(await c.query(`INSERT INTO ${runs}(id,workspace_id,run_key,business_date,plan,requested_by) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(workspace_id,run_key) DO NOTHING RETURNING *`,[newId('runout-run'),workspaceId,runKey,today,tier,payload.requestedBy||null])).rows[0];
  if(run){
    await c.query(`DELETE FROM ${runs} r WHERE r.workspace_id=$1 AND r.id<>$2 AND r.started_at<now()-interval '90 days'`,[workspaceId,run.id]);
    await c.query(`DELETE FROM ${estimates} e WHERE e.workspace_id=$1 AND NOT EXISTS(SELECT 1 FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE s.workspace_id=e.workspace_id AND s.id=e.sku_id AND s.is_active=1 AND i.is_active=1)`,[workspaceId]);
  }else run=(await c.query(`SELECT * FROM ${runs} WHERE workspace_id=$1 AND run_key=$2 FOR UPDATE`,[workspaceId,runKey])).rows[0];
  const after=payload.afterSkuId||null;
  if(run.finished_at||(run.cursor&&(!after||after<run.cursor)))return {runId:run.id,replayed:true};
  const ids=(await c.query(`SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    WHERE s.workspace_id=$1 AND s.is_active=1 AND ($2::text IS NULL OR s.id>$2) ORDER BY s.id LIMIT $3`,[workspaceId,after,PAGE+1])).rows.map(r=>r.id);
  const page=ids.slice(0,PAGE);
  if(page.length)await require('../commercial/storage-capacity').reserve(c,workspaceId,'runout:'+run.id+':'+(after||'start'),page.length*1536+4096,{finished:true});
  const list=await estimate(c,workspaceId,page,{today});
  await save(c,workspaceId,run.id,today,list);
  const kept=new Set(list.map(e=>e.skuId));
  const gone=page.filter(id=>!kept.has(id));
  if(gone.length)await c.query(`DELETE FROM ${estimates} WHERE workspace_id=$1 AND sku_id=ANY($2::text[])`,[workspaceId,gone]);
  const counts={checked:list.length,before_delivery:list.filter(e=>e.beforeDelivery).length,within_year:list.filter(e=>e.runout).length};
  const total={...run.counts};
  for(const [name,n] of Object.entries(counts))total[name]=Number(total[name]||0)+n;
  const more=ids.length>PAGE;
  await c.query(`UPDATE ${runs} SET counts=$3::jsonb,cursor=coalesce($4,cursor),finished_at=CASE WHEN $5 THEN NULL ELSE now() END WHERE workspace_id=$1 AND id=$2`,
    [workspaceId,run.id,JSON.stringify(total),page.at(-1)||null,more]);
  if(more)await queue.enqueue(scoped(c),{workspaceId,kind:KIND,idempotencyKey:'runout:'+runKey+':'+page.at(-1),
    payload:{runKey,afterSkuId:page.at(-1),requestedBy:payload.requestedBy||null},priority:66,maxAttempts:3});
  return {runId:run.id,...counts,more};
}

// Called on the first page of each scheduled autopilot check: one run a
// business day on every plan, after the forecasts and reorder point check.
async function schedule(db,workspaceId){
  if(!await plan(db,workspaceId))return {queued:false};
  const day=await time.today(db,workspaceId);
  return {queued:(await queue.enqueue(db,{workspaceId,kind:KIND,idempotencyKey:'runout:'+day,payload:{runKey:day},priority:66,maxAttempts:3})).created};
}
async function requestCheck(db,ctx){
  await member(db,ctx);
  const account=await policy.accountState(db,ctx.workspaceId);
  policy.requireJob(policy.usesAgentTerms(account)?account.plan:null,JOB,'automatic');
  const slot=Math.floor(Date.now()/900000);
  const job=await queue.enqueue(db,{workspaceId:ctx.workspaceId,kind:KIND,idempotencyKey:'runout:manual:'+slot,
    payload:{runKey:'manual-'+slot,requestedBy:ctx.actorId},priority:60,maxAttempts:3});
  return {queued:job.created};
}

const shape=r=>({...r,available:Number(r.available),waiting:Number(r.waiting),daily_demand:r.daily_demand==null?null:Number(r.daily_demand),
  units_short:r.units_short==null?null:Number(r.units_short),lost_margin_minor:r.lost_margin_minor==null?null:Number(r.lost_margin_minor),
  daily_margin_minor:r.daily_margin_minor==null?null:Number(r.daily_margin_minor)});
async function page(db,ctx,{number=1}={}){
  await member(db,ctx);
  const account=await policy.accountState(db,ctx.workspaceId);
  const tier=policy.usesAgentTerms(account)?account.plan:null;
  policy.requireJob(tier,JOB,'automatic');
  number=Number(number);
  if(!Number.isSafeInteger(number)||number<1||number>100000)throw new ValidationError('Choose a valid page.');
  if(!await installed.has(db,estimates))return {plan:tier,run:null,flagged:[],later:[],more:false,number};
  const select=`SELECT e.*,e.runout_date::text AS runout,e.next_delivery_date::text AS delivery,s.code,i.name,i.unit_label,i.id AS item_id
    FROM ${estimates} e JOIN skus s ON s.workspace_id=e.workspace_id AND s.id=e.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE e.workspace_id=$1`;
  const flagged=(await db.query(select+` AND e.before_delivery ORDER BY e.lost_margin_minor DESC NULLS LAST,e.runout_date,s.code LIMIT 100`,[ctx.workspaceId])).rows.map(shape);
  const later=(await db.query(select+` AND NOT e.before_delivery AND e.runout_date IS NOT NULL ORDER BY e.runout_date,s.code,e.sku_id LIMIT 51 OFFSET $2`,
    [ctx.workspaceId,(number-1)*50])).rows.map(shape);
  const run=(await db.query(`SELECT * FROM ${runs} WHERE workspace_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1`,[ctx.workspaceId])).rows[0]||null;
  return {plan:tier,run,flagged,later:later.slice(0,50),more:later.length>50,number,money:(minor,currency)=>minor==null||!currency?null:money.format(minor,currency)};
}

// Needs you: items that run out before their next delivery, ranked by the
// gross margin lost until it arrives.
async function inbox(db,workspaceId){
  if(!await installed.has(db,estimates)||!await plan(db,workspaceId))return [];
  const rows=(await db.query(`SELECT e.*,e.runout_date::text AS runout,e.next_delivery_date::text AS delivery,s.code,i.name FROM ${estimates} e
    JOIN skus s ON s.workspace_id=e.workspace_id AND s.id=e.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE e.workspace_id=$1 AND e.before_delivery ORDER BY e.lost_margin_minor DESC NULLS LAST,e.runout_date,s.code LIMIT $2`,[workspaceId,INBOX_ITEMS+1])).rows;
  const total=rows.length>INBOX_ITEMS?Number((await db.query(`SELECT count(*)::int AS n FROM ${estimates} WHERE workspace_id=$1 AND before_delivery`,[workspaceId])).rows[0].n):rows.length;
  const items=rows.slice(0,INBOX_ITEMS).map(r=>{
    const lost=r.lost_margin_minor==null?null:Number(r.lost_margin_minor),orders=Number(r.orders_affected);
    return {kind:'inventory',importance:'Important',priority:lost==null?52:53,title:r.code+' runs out before its next delivery',
      happened:r.reason,
      why:(lost==null?'Its selling price or cost is not recorded, so the cost is unknown.':'About '+money.format(lost,r.currency)+' of gross margin is lost before the delivery ('+
        money.format(Number(r.daily_margin_minor),r.currency)+' a day for '+r.days_short+' day'+(Number(r.days_short)===1?'':'s')+').')+
        (orders?' '+orders+' open customer order'+(orders===1?' waits':'s wait')+' for it.':''),
      recommendation:'Order more now, or ask the supplier to deliver sooner.',href:href+'#'+encodeURIComponent(r.code),actionLabel:'See when stock runs out',
      sourceId:'runout:'+r.sku_id,moneyValue:lost,moneyCurrency:lost==null?null:r.currency,at:r.updated_at,createdAt:r.updated_at};
  });
  if(total>INBOX_ITEMS)items.push({kind:'inventory',importance:'Important',priority:51,grouped:true,title:'More items run out before their next delivery',
    happened:(total-INBOX_ITEMS)+' more item'+(total-INBOX_ITEMS===1?'':'s')+' will run out before stock arrives.',why:'They cost less than the ones above.',
    recommendation:'Review the full list.',href,actionLabel:'See when stock runs out',sourceId:'runout-more',at:rows[0].updated_at,createdAt:rows[0].updated_at});
  return items;
}

// The agent review: the same calculation, live, for 25 products a page.
async function review(db,ctx,{filter,page:number,today}){
  const selected=await db.query(`SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ($2='' OR lower(s.code)=lower($2)) ORDER BY s.code,s.id LIMIT 26 OFFSET $3`,
  [ctx.workspaceId,filter,(number-1)*25]);
  const list=await estimate(db,ctx.workspaceId,selected.rows.slice(0,25).map(r=>r.id),{today});
  const show=(minor,currency)=>minor==null||!currency?null:money.format(minor,currency);
  const rows=list.sort((a,b)=>a.code.localeCompare(b.code)).map(e=>({SKU:e.code,'Available now':e.available,'Open orders waiting':e.waiting,
    'Demand from':e.basis==='FORECAST'?'Forecast · '+e.label:e.label,'Daily demand':e.dailyDemand,'Runs out':e.runout,'Next delivery':e.nextDelivery,
    'Before the delivery':e.beforeDelivery?'Yes':'No','Gross margin lost a day':show(e.dailyMargin,e.currency),'Gross margin lost before the delivery':show(e.lostMargin,e.currency),
    'Customer orders affected':e.ordersAffected,Reason:e.reason,link:'/inventory/'+e.itemId}));
  return {rows,more:selected.rows.length>25,summary:'Free stock after open orders, against the forecast day by day and purchase orders with a delivery date. Margin is the current selling price less cost. Overdue or undated deliveries are not counted.'};
}

module.exports={JOB,KIND,href,estimate,load,compute,process,schedule,requestCheck,page,inbox,review};

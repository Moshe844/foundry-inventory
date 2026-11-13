'use strict';
// Job 211: learns each customer's and supplier's habits (Growth, Pro and
// Custom; Starter is excluded).
//
// Everything is measured from recorded work, never typed in:
//  - a customer's habits come from confirmed sales orders: how often they
//    order (the middle gap between ordering days), the weekday most of their
//    orders fall on, their usual order size, and whether they are due to order
//    again. Two orders on one day are one ordering day.
//  - a supplier's habits come from completed warehouse purchase orders in the
//    last year (the latest 20): their usual lead time from placing the order to
//    the last receipt, the spread of the middle half, how often the goods came
//    by the date on the order, and how often the first delivery was short or
//    more than ordered.
// A habit needs three ordering days or three completed deliveries.
//
// Putting habits to work: when a product has no delivery history of its own
// and the owner set no lead time for it, reorders and new purchase orders use
// the supplier's usual lead time instead of the typed promise. This changes
// when StockChief suggests ordering and the expected arrival date on new
// purchase orders. It never changes a reorder point, a limit or a saved
// setting. It pauses with automatic work: in the first 14 days, in Watch only,
// and while paused, the promised lead time is used and the habit is only shown.
const time=require('../lib/business-time');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const {addDays}=require('../accounting/customer-money');

const JOB=211,MIN=3,RECENT=20,WEEKDAYS=['','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const plural=(n,one,many)=>n+' '+(Number(n)===1?one:many);
const days=n=>plural(n,'day','days');
const gap=(from,to)=>Math.round((Date.parse(to+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000);

// One complete, physically received order is one delivery. A split receipt
// is complete on its last receipt date in this inventory's time zone.
// $1 workspace, $2 supplier ids (NULL for all), $3 time zone, $4 today.
const deliveries=`SELECT p.id,p.po_number,p.supplier_id,p.expected_date::date AS expected,
  (p.ordered_at::timestamptz AT TIME ZONE $3)::date AS placed,
  (max(r.received_at::timestamptz) AT TIME ZONE $3)::date AS received
  FROM purchase_orders p JOIN purchase_order_receipts r ON r.workspace_id=p.workspace_id AND r.purchase_order_id=p.id
  WHERE p.workspace_id=$1 AND p.status='RECEIVED' AND p.ordered_at IS NOT NULL AND ($2::text[] IS NULL OR p.supplier_id=ANY($2::text[]))
    AND p.ordered_at::timestamptz>=$4::date-730
    AND coalesce(to_jsonb(p)->>'delivery_kind','WAREHOUSE')='WAREHOUSE' GROUP BY p.id`;
const supplierSql=`WITH d AS (${deliveries}),
 recent AS (SELECT * FROM (SELECT d.*,row_number() OVER(PARTITION BY supplier_id ORDER BY received DESC,id DESC) AS n FROM d
   WHERE placed<=received AND received<=$4::date AND received>$4::date-365) x WHERE n<=${RECENT}),
 receipts AS (SELECT r.purchase_order_id,r.id,r.received_at::timestamptz AS at,sum(rl.quantity_units)::numeric AS units,bool_or(rl.over_by_units>0) AS over
   FROM purchase_order_receipts r JOIN purchase_order_receipt_lines rl ON rl.workspace_id=r.workspace_id AND rl.receipt_id=r.id
   WHERE r.workspace_id=$1 AND r.purchase_order_id IN (SELECT id FROM recent) GROUP BY r.id),
 first AS (SELECT DISTINCT ON (purchase_order_id) purchase_order_id,units FROM receipts ORDER BY purchase_order_id,at,id),
 ordered AS (SELECT purchase_order_id,sum(quantity_units)::numeric AS units FROM purchase_order_lines
   WHERE workspace_id=$1 AND purchase_order_id IN (SELECT id FROM recent) GROUP BY purchase_order_id),
 measured AS (SELECT r.*,r.received-r.placed AS lead,o.units AS ordered,f.units AS first_units,
     coalesce((SELECT bool_or(over) FROM receipts x WHERE x.purchase_order_id=r.id),false) AS over
   FROM recent r JOIN ordered o ON o.purchase_order_id=r.id JOIN first f ON f.purchase_order_id=r.id)
 SELECT supplier_id,count(*)::int AS samples,max(received)::text AS latest,
   percentile_disc(0.5) WITHIN GROUP(ORDER BY lead) AS typical,
   percentile_disc(0.25) WITHIN GROUP(ORDER BY lead) AS low,percentile_disc(0.75) WITHIN GROUP(ORDER BY lead) AS high,
   count(*) FILTER(WHERE expected IS NOT NULL)::int AS dated,count(*) FILTER(WHERE expected IS NOT NULL AND received<=expected)::int AS on_time,
   count(*) FILTER(WHERE first_units<ordered)::int AS short,count(*) FILTER(WHERE over)::int AS over,
   percentile_disc(0.5) WITHIN GROUP(ORDER BY round((ordered-first_units)*100/ordered)) FILTER(WHERE first_units<ordered) AS short_percent
 FROM measured GROUP BY supplier_id HAVING count(*)>=${MIN}`;
// $1 workspace, $2 customer ids (NULL for all), $3 today, $4 first sales day the plan keeps (or NULL).
const customerSql=`WITH orders AS (
   SELECT o.customer_id,o.id,o.order_date::date AS day,o.currency,
     (SELECT sum(l.quantity_ordered)::numeric FROM sales_order_lines l WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id) AS units,
     (SELECT CASE WHEN count(*)>0 AND bool_and(l.unit_price_minor IS NOT NULL) THEN sum(l.quantity_ordered*l.unit_price_minor)::numeric END
       FROM sales_order_lines l WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id) AS value
   FROM sales_orders o WHERE o.workspace_id=$1 AND o.status IN('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED')
     AND o.order_date<=$3 AND ($4::text IS NULL OR o.order_date>=$4) AND ($2::text[] IS NULL OR o.customer_id=ANY($2::text[]))),
 days AS (SELECT customer_id,day,sum(units) AS units,CASE WHEN count(DISTINCT currency)=1 AND bool_and(value IS NOT NULL) THEN sum(value) END AS value,min(currency) AS currency
   FROM orders GROUP BY customer_id,day),
 gaps AS (SELECT *,day-lag(day) OVER(PARTITION BY customer_id ORDER BY day) AS gap FROM days),
 weekdays AS (SELECT DISTINCT ON (customer_id) customer_id,extract(isodow FROM day)::int AS weekday,count(*) AS n FROM days
   GROUP BY customer_id,extract(isodow FROM day) ORDER BY customer_id,count(*) DESC,extract(isodow FROM day))
 SELECT g.customer_id,count(*)::int AS samples,max(g.day)::text AS latest,percentile_disc(0.5) WITHIN GROUP(ORDER BY g.gap) AS typical,
   percentile_disc(0.5) WITHIN GROUP(ORDER BY g.units) AS units,
   CASE WHEN count(DISTINCT g.currency)=1 AND bool_and(g.value IS NOT NULL) THEN percentile_disc(0.5) WITHIN GROUP(ORDER BY g.value) END AS value,
   min(g.currency) AS currency,min(w.weekday) AS weekday,min(w.n)::int AS weekday_days
 FROM gaps g JOIN weekdays w ON w.customer_id=g.customer_id GROUP BY g.customer_id HAVING count(*)>=${MIN}`;

const quantity=v=>{const n=Number(v);return Number.isInteger(n)?String(n):String(Number(n.toFixed(3)));};
function supplierFrom(r){
  const typical=Number(r.typical),low=Number(r.low),high=Number(r.high);
  return {supplierId:r.supplier_id,samples:r.samples,latest:r.latest,leadDays:typical,low,high,
    lead:low===high?'About '+days(typical):'About '+days(typical)+' (usually '+low+' to '+high+')',
    onTime:r.dated?r.on_time+' of '+r.dated+' on time ('+Math.round(r.on_time*100/r.dated)+'%)':'No dates on the orders',
    lateDeliveries:r.dated?(r.dated-r.on_time)+' of '+r.dated+' dated deliveries':'No promised dates',
    onTimeRate:r.dated?r.on_time/r.dated:null,short:r.short,over:r.over,
    shortText:r.short?'First delivery short on '+r.short+' of '+r.samples+(r.short_percent!=null?' (usually '+Number(r.short_percent)+'% short)':''):'Never short on the first delivery',
    overText:r.over?'More than ordered on '+r.over+' of '+r.samples:'Never more than ordered'};
}
function customerFrom(r,today){
  const typical=Number(r.typical),next=addDays(r.latest,typical),late=gap(next,today),grace=Math.max(2,Math.ceil(typical/2));
  const due=late<0?{state:'later',text:'Next order expected about '+next,detail:'Expected about '+next}:
    late<=grace?{state:'due',text:'Due to order now (expected '+next+')',detail:'Expected '+next}:
    {state:'late',text:'Later than usual: '+days(late)+' past the usual gap',detail:days(late)+' past the usual gap'};
  return {customerId:r.customer_id,samples:r.samples,latest:r.latest,intervalDays:typical,interval:'Orders about every '+days(typical),
    weekday:r.weekday_days*2>=r.samples?'Usually on '+WEEKDAYS[r.weekday]:'No usual day',
    size:'About '+quantity(r.units)+' units'+(r.value!=null?' ('+money.format(Math.round(Number(r.value)),r.currency)+')':''),
    next,due};
}

async function suppliers(db,workspaceId,supplierIds=null){
  const {timeZone,calendarDate}=await time.forWorkspace(db,workspaceId);
  const {rows}=await db.query(supplierSql,[workspaceId,supplierIds,timeZone,calendarDate]);
  return new Map(rows.map(r=>[r.supplier_id,supplierFrom(r)]));
}
async function customers(db,workspaceId,customerIds=null){
  const {salesFrom}=await require('../commercial/agent-history').access(db,workspaceId);
  const today=await time.today(db,workspaceId);
  const {rows}=await db.query(customerSql,[workspaceId,customerIds,today,salesFrom]);
  return new Map(rows.map(r=>[r.customer_id,customerFrom(r,today)]));
}

// Whether learned habits may change planning now, and why not.
async function use(db,workspaceId,state=null){
  state=state||await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return {active:false,included:false};
  if(state.shadow)return {active:false,included:true,reason:'StockChief is watching during your first 14 days, so reorders still use the promised lead time.'};
  const {rows:[config]}=await db.query('SELECT mode,paused,suspended FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId]);
  if(config?.mode==='OBSERVE')return {active:false,included:true,reason:'StockChief is in Watch only, so reorders still use the promised lead time.'};
  if(Number(config?.paused)||Number(config?.suspended))return {active:false,included:true,reason:'Automatic work is paused, so reorders still use the promised lead time.'};
  return {active:true,included:true};
}
// The usual lead time of each supplier, when reorders may use it.
async function leads(db,workspaceId,supplierIds){
  const ids=[...new Set(supplierIds.filter(Boolean))];
  if(!ids.length||!(await use(db,workspaceId)).active)return new Map();
  return new Map([...(await suppliers(db,workspaceId,ids))].map(([id,h])=>[id,h.leadDays]));
}
// Offers carry the view's lead (measured for this product, else promised).
// A product without three deliveries of its own takes the supplier's habit.
async function applyToOffers(db,workspaceId,offers){
  const learned=await leads(db,workspaceId,offers.filter(o=>o.observed_lead==null&&!(Number(o.samples)>=MIN)).map(o=>o.supplier_id));
  for(const o of offers)if(o.observed_lead==null&&!(Number(o.samples)>=MIN)&&learned.has(o.supplier_id))o.effective_lead=learned.get(o.supplier_id);
  return offers;
}

// The panels on the customer and supplier pages.
async function panel(db,ctx,kind,id){
  const state=await policy.accountState(db,ctx.workspaceId);
  if(!policy.usesAgentTerms(state))return null;
  if(!policy.permits(state.plan,JOB,'suggest'))return {locked:true};
  if(kind==='customer'){
    const habit=(await customers(db,ctx.workspaceId,[id])).get(id);
    return {habit:habit||null,empty:'StockChief learns this customer’s habits after three ordering days.'};
  }
  const habit=(await suppliers(db,ctx.workspaceId,[id])).get(id),feed=await use(db,ctx.workspaceId,state);
  let open=[];
  if(habit){
    const {timeZone}=await time.forWorkspace(db,ctx.workspaceId);
    open=(await db.query(`SELECT id,po_number,expected_date::date::text AS expected,(ordered_at::timestamptz AT TIME ZONE $3)::date::text AS placed
      FROM purchase_orders WHERE workspace_id=$1 AND supplier_id=$2 AND status IN('ORDERED','PARTIALLY_RECEIVED') AND ordered_at IS NOT NULL
      ORDER BY ordered_at,id LIMIT 5`,[ctx.workspaceId,id,timeZone])).rows.map(o=>{const likely=addDays(o.placed,habit.leadDays);
      return {id:o.id,number:o.po_number,expected:o.expected,likely,late:Boolean(o.expected&&likely>o.expected)};});
  }
  return {habit:habit||null,open,feed,empty:'StockChief learns this supplier’s habits after three completed deliveries.'};
}

async function habits(db,ctx,{filter,page,today}){
  const {salesFrom}=await require('../commercial/agent-history').access(db,ctx.workspaceId);
  const {timeZone}=await time.forWorkspace(db,ctx.workspaceId);
  const named=String(filter||'').trim();
  const [customerRows,supplierRows]=await Promise.all([
    db.query(`SELECT id,name FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' AND ($2='' OR id=$2 OR lower(name)=lower($2)) ORDER BY name,id`,[ctx.workspaceId,named]),
    db.query(`SELECT id,name FROM suppliers WHERE workspace_id=$1 AND status='active' AND ($2='' OR id=$2 OR lower(name)=lower($2)) ORDER BY name,id`,[ctx.workspaceId,named])]);
  const learnedCustomers=customerRows.rows.length?new Map((await db.query(customerSql,[ctx.workspaceId,customerRows.rows.map(r=>r.id),today,salesFrom])).rows.map(r=>[r.customer_id,customerFrom(r,today)])):new Map();
  const learnedSuppliers=supplierRows.rows.length?new Map((await db.query(supplierSql,[ctx.workspaceId,supplierRows.rows.map(r=>r.id),timeZone,today])).rows.map(r=>[r.supplier_id,supplierFrom(r)])):new Map();
  const feed=await use(db,ctx.workspaceId);
  const all=[...customerRows.rows.filter(c=>learnedCustomers.has(c.id)).map(c=>{const h=learnedCustomers.get(c.id);
    return {Partner:c.name,Type:'Customer','Observed days or deliveries':h.samples,'Last recorded':h.latest,Pattern:h.interval,
      'Usual day':h.weekday,'Usual size':h.size,'Estimated next order':h.next,'Next step':h.due.text,link:'/sales/customers/'+c.id};}),
  ...supplierRows.rows.filter(s=>learnedSuppliers.has(s.id)).map(s=>{const h=learnedSuppliers.get(s.id);
    return {Partner:s.name,Type:'Supplier','Observed days or deliveries':h.samples,'Last recorded':h.latest,Pattern:'Delivers in about '+days(h.leadDays),
      Spread:h.low===h.high?'Always about '+days(h.leadDays):h.low+' to '+days(h.high),'On time':h.onTime,'Short or over':h.shortText+'. '+h.overText+'.',
      'Estimated next order':null,'Late deliveries':h.lateDeliveries,'Next step':feed.active?'Reorders use '+days(h.leadDays)+' when a product has no deliveries of its own':feed.reason||'Shown only',link:'/suppliers/'+s.id};})];
  const start=(page-1)*100;
  return {summary:'After three ordering days or three completed warehouse deliveries, StockChief shows the usual pattern. Customer dates are estimates. Supplier lead time runs from placing the order to the last warehouse receipt.'+(feed.reason?' '+feed.reason:''),
    more:all.length>start+100,rows:all.slice(start,start+100)};
}
// Job 94: the negotiation email and its facts come from negotiation-evidence.
async function negotiation(db,ctx,filter){
  const ev=require('../purchasing/negotiation-evidence'),found=await ev.collect(db,ctx,filter);
  if(!found.facts.length)return {supplier:found.supplier,summary:'Nothing recorded in the last 12 months to negotiate with: no late or short deliveries, price increases, cheaper quotes or orders.',rows:[]};
  const words=ev.negotiationEmail(found),evidence=ev.key(found,words),count=kind=>found.facts.find(f=>f.kind===kind)?.count||0;
  return {supplier:found.supplier,...words,evidence,sourceKey:evidence,summary:'Check each fact and its evidence before contacting the supplier.',
    rows:[{Supplier:found.supplier.name,'Completed dated orders':found.completed,'Late deliveries':count('late'),'Short order lines':count('short'),'Price increases':count('price'),
      'Cheaper quotes':count('quote'),'Orders placed':count('volume'),Subject:words.subject,Draft:words.body,link:'/autopilot/supplier-negotiations?supplier='+encodeURIComponent(found.supplier.id)}]};
}
const definitions=[
  {id:211,key:'partner-habits',label:'Learn customer order patterns and supplier lead times',filterLabel:'Customer or supplier',readPage:habits},
  {id:94,key:'supplier-negotiation',label:'Draft a supplier negotiation email',filterLabel:'Exact supplier name or ID',requiresFilter:true,
    readPage:async(db,ctx,{filter})=>{
      const result=await negotiation(db,ctx,filter);
      return {...result,negotiationForm:{supplier:result.supplier.id,evidence:result.evidence,
        revision:(await require('../purchasing/negotiation-drafts').setting(db,ctx.workspaceId,result.supplier.id))?.revision||''}};
    }}
];
module.exports={JOB,MIN,negotiation,definitions,suppliers,customers,use,leads,applyToOffers,panel};

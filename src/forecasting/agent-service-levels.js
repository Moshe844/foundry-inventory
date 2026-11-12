'use strict';
// Job 163: forecast accuracy, fill rate and on-time-in-full (OTIF), for
// customers and suppliers.
//
// Forecast accuracy compares each weekly forecast job 144 saved with what then
// sold: the mean absolute percentage error (MAPE) and the bias (how far the
// forecasts ran over or under), for each product and overall. Weeks with no
// sales have no percentage error and are counted apart; weeks marked as not
// comparable (stock-outs) are left out.
//
// Fill rate is the share of ordered units shipped to customers, or received
// into your warehouses from suppliers. An order is on time in full when every
// line arrived by the promised date. Orders without a promised date are left
// out and counted.
//
// Growth, Pro and Custom keep the month so far and the month that just ended
// current through the worker, and keep each month's figures. The report
// downloads as Excel or PDF. Starter is excluded. Nothing is changed.
const {ValidationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const time=require('../lib/business-time');
const {addDays}=require('../accounting/customer-money');
const reports=require('../reports/agent-report-runs');

const JOB=163,ACTION='report.service_levels',KIND='reports.service-levels.v1',href='/autopilot/reviews/service-levels',MODEL='agent-144-v1';
const pct=(n,d)=>d>0?Math.round(n*1000/d)/10:null;

// Weekly forecasts against actual sales, per product and overall.
async function accuracy(db,workspaceId,{start,end,filter='',limit=null}){
  const rows=(await db.query(`SELECT s.id AS sku_id,s.code,i.name,count(*)::int AS weeks,
      round(sum(o.predicted_units)::numeric,2)::float8 AS forecast,round(sum(o.actual_units)::numeric,2)::float8 AS actual,
      count(*) FILTER (WHERE o.actual_units>0)::int AS sold_weeks,
      avg(abs(o.predicted_units-o.actual_units)/o.actual_units) FILTER (WHERE o.actual_units>0)::float8 AS mape
    FROM demand_forecasts f JOIN forecast_outcomes o ON o.workspace_id=f.workspace_id AND o.forecast_id=f.id
    JOIN skus s ON s.workspace_id=f.workspace_id AND s.id=f.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE f.workspace_id=$1 AND f.model_version=$2 AND f.location_id IS NULL AND o.comparable=1 AND o.predicted_units IS NOT NULL
      AND f.horizon_end::date BETWEEN $3::date AND $4::date AND ($5='' OR lower(s.code)=lower($5) OR lower(i.name)=lower($5))
    GROUP BY s.id,s.code,i.name ORDER BY s.code,s.id`,[workspaceId,MODEL,start,end,filter])).rows;
  const items=rows.map(r=>({skuId:r.sku_id,code:r.code,name:r.name,weeks:r.weeks,forecast:r.forecast,actual:r.actual,noSales:r.weeks-r.sold_weeks,
    mape:r.mape==null?null:Math.round(r.mape*1000)/10,bias:pct(r.forecast-r.actual,r.actual)}));
  const weeks=rows.reduce((n,r)=>n+r.weeks,0),sold=rows.reduce((n,r)=>n+r.sold_weeks,0);
  const forecast=Math.round(rows.reduce((n,r)=>n+r.forecast,0)*100)/100,actual=Math.round(rows.reduce((n,r)=>n+r.actual,0)*100)/100;
  const weighted=rows.reduce((n,r)=>n+(r.mape==null?0:r.mape*r.sold_weeks),0);
  return {items:limit?[...items].sort((a,b)=>(b.mape??-1)-(a.mape??-1)||a.code.localeCompare(b.code)).slice(0,limit):items,
    overall:{products:rows.length,weeks,noSales:weeks-sold,forecast,actual,mape:sold?Math.round(weighted*1000/sold)/10:null,bias:pct(forecast-actual,actual)}};
}

// Orders due in the period against what shipped or arrived.
async function delivery(db,workspaceId,{start,end,filter=''}){
  const {rows}=await db.query(`WITH zone AS (
    SELECT coalesce(w.time_zone,a.time_zone,'UTC') AS tz FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1
  ), supplier_lines AS (
    SELECT 'Supplier' AS kind,p.supplier_id AS party,s.name,p.id AS order_id,l.quantity_units AS ordered,
      least(l.quantity_units,coalesce(sum(received.units),0)) AS fulfilled,
      coalesce(sum(received.units) FILTER(WHERE received.day<=p.expected_date::date),0)>=l.quantity_units AS timely
    FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
    JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
    LEFT JOIN LATERAL (SELECT x.quantity_units AS units,(r.received_at::timestamptz AT TIME ZONE z.tz)::date AS day
      FROM purchase_order_receipt_lines x JOIN purchase_order_receipts r ON r.workspace_id=x.workspace_id AND r.id=x.receipt_id CROSS JOIN zone z
      WHERE x.workspace_id=l.workspace_id AND x.purchase_order_line_id=l.id) received ON true
    WHERE p.workspace_id=$1 AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED') AND p.expected_date::date BETWEEN $3::date AND $4::date
      AND coalesce(to_jsonb(p)->>'delivery_kind','WAREHOUSE')='WAREHOUSE'
      AND ($2='' OR lower(s.name)=lower($2)) GROUP BY p.id,p.supplier_id,s.name,l.id,l.quantity_units
  ), customer_lines AS (
    SELECT 'Customer' AS kind,o.customer_id AS party,c.name,o.id AS order_id,l.quantity_ordered AS ordered,
      least(l.quantity_ordered,coalesce(sum(parcel.units) FILTER(WHERE parcel.shipped),0)) AS fulfilled,
      coalesce(sum(parcel.units) FILTER(WHERE parcel.day<=o.needed_by::date),0)>=l.quantity_ordered AS timely
    FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
    LEFT JOIN LATERAL (SELECT x.quantity AS units,h.shipped_at IS NOT NULL AS shipped,
      (coalesce(h.delivered_at,CASE WHEN h.handover IN ('COLLECTED','DELIVERED_BY_US') THEN h.shipped_at END)::timestamptz AT TIME ZONE z.tz)::date AS day
      FROM sales_shipment_lines x JOIN sales_shipments h ON h.workspace_id=x.workspace_id AND h.id=x.shipment_id CROSS JOIN zone z
      WHERE x.workspace_id=l.workspace_id AND x.sales_order_line_id=l.id AND h.status<>'CANCELLED' AND h.customer_return_id IS NULL) parcel ON true
    WHERE o.workspace_id=$1 AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED')
      AND o.needed_by::date BETWEEN $3::date AND $4::date AND ($2='' OR lower(c.name)=lower($2))
    GROUP BY o.id,o.customer_id,c.name,l.id,l.quantity_ordered
  ), orders AS (
    SELECT kind,party,name,order_id,sum(ordered) AS ordered,sum(fulfilled) AS fulfilled,bool_and(timely) AS timely
    FROM (SELECT * FROM supplier_lines UNION ALL SELECT * FROM customer_lines) combined GROUP BY kind,party,name,order_id
  ) SELECT kind,party,name,count(*)::int AS orders,sum(ordered)::float8 AS ordered,sum(fulfilled)::float8 AS filled,count(*) FILTER(WHERE timely)::int AS timely
    FROM orders GROUP BY kind,party,name ORDER BY kind,name,party`,[workspaceId,filter,start,end]);
  const undated=(await db.query(`SELECT
      (SELECT count(*)::int FROM sales_orders o WHERE o.workspace_id=$1 AND o.needed_by IS NULL AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED')
        AND o.created_at::timestamptz::date BETWEEN $2::date AND $3::date) AS customers,
      (SELECT count(*)::int FROM purchase_orders p WHERE p.workspace_id=$1 AND p.expected_date IS NULL AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')
        AND coalesce(p.ordered_at,p.created_at)::timestamptz::date BETWEEN $2::date AND $3::date) AS suppliers`,[workspaceId,start,end])).rows[0];
  const parties=rows.map(r=>({kind:r.kind,party:r.party,name:r.name,orders:r.orders,ordered:r.ordered,filled:r.filled,timely:r.timely,
    fill:pct(r.filled,r.ordered),otif:pct(r.timely,r.orders)}));
  const total=kind=>{const of=parties.filter(p=>p.kind===kind),orders=of.reduce((n,p)=>n+p.orders,0),ordered=of.reduce((n,p)=>n+p.ordered,0),
    filled=of.reduce((n,p)=>n+p.filled,0),timely=of.reduce((n,p)=>n+p.timely,0);
    return {orders,ordered,filled,timely,fill:pct(filled,ordered),otif:pct(timely,orders),undated:undated[kind==='Customer'?'customers':'suppliers']};};
  return {parties,customers:total('Customer'),suppliers:total('Supplier')};
}

// The month (or the month so far) as one report.
function period(today,value){
  const current=today.slice(0,7),month=String(value??'').trim()||reports.lastCompleted(today);
  if(!reports.MONTH.test(month)||month<'1900-01'||month>current)throw new ValidationError('Choose a month as YYYY-MM, for example '+reports.lastCompleted(today)+'.');
  const span=reports.span(month),end=month===current?addDays(today,-1):span.end;
  return {...span,end,partial:month===current};
}
async function compute(db,workspaceId,{month,today,filter=''}){
  const span=period(today,month);
  if(span.end<span.start)return {...span,empty:true,forecasts:{items:[],overall:{products:0,weeks:0,noSales:0,forecast:0,actual:0,mape:null,bias:null}},
    parties:[],customers:{orders:0,ordered:0,filled:0,timely:0,fill:null,otif:null,undated:0},suppliers:{orders:0,ordered:0,filled:0,timely:0,fill:null,otif:null,undated:0}};
  const forecasts=await accuracy(db,workspaceId,{...span,filter});
  const levels=await delivery(db,workspaceId,{...span,filter});
  return {...span,forecasts,...levels};
}
function forecastSentence(f){
  return f.weeks?'Across '+f.weeks+' scored weekly forecast'+(f.weeks===1?'':'s')+' for '+f.products+' product'+(f.products===1?'':'s')+', MAPE was '+(f.mape==null?'not measurable (no sales)':f.mape+'%')+' and bias '+(f.bias==null?'not measurable':(f.bias>0?'+':'')+f.bias+'%')+'.':'No weekly forecast was scored in this period.';
}
function sentence(r){
  const f=r.forecasts.overall,c=r.customers,s=r.suppliers,parts=[];
  parts.push(forecastSentence(f));
  parts.push(c.orders?'Customers: '+c.fill+'% of units filled, '+c.otif+'% of '+c.orders+' order'+(c.orders===1?'':'s')+' on time in full.':'No customer orders were due.');
  parts.push(s.orders?'Suppliers: '+s.fill+'% of units received, '+s.otif+'% of '+s.orders+' order'+(s.orders===1?'':'s')+' on time in full.':'No supplier orders were due.');
  const undated=c.undated+s.undated;if(undated)parts.push(undated+' order'+(undated===1?' has':'s have')+' no promised date and '+(undated===1?'is':'are')+' left out.');
  return parts.join(' ');
}

// ---- Reviews (the list and Ask): the last 90 completed days -----------------

async function report(db,ctx,{today,filter,page}){
  const r={start:addDays(today,-90),end:addDays(today,-1)};
  const forecasts=await accuracy(db,ctx.workspaceId,r),levels=await delivery(db,ctx.workspaceId,{...r,filter});
  const rows=levels.parties.map(p=>({'Party type':p.kind,Name:p.name,'Due orders':p.orders,'Ordered units':p.ordered,'Filled units':p.filled,'Fill rate %':p.fill,
    'On time in full':p.timely,'OTIF %':p.otif,link:href}));
  return {rows:rows.slice((page-1)*100,page*100),more:rows.length>page*100,summary:'Orders due in the previous 90 completed days. Fill rate measures units shipped to customers or received into your warehouses against units ordered. OTIF counts orders for which every line arrived by the promised date. Orders without a promise are excluded. '+
    forecastSentence(forecasts.overall)};
}
async function accuracyReport(db,ctx,{today,filter,page}){
  const forecasts=await accuracy(db,ctx.workspaceId,{start:addDays(today,-90),end:addDays(today,-1),filter});
  const rows=forecasts.items.map(i=>({SKU:i.code,Product:i.name,'Weeks scored':i.weeks,'Forecast units':i.forecast,'Actual units':i.actual,'MAPE %':i.mape,'Bias %':i.bias,
    'Weeks with no sales':i.noSales,link:href}));
  const o=forecasts.overall;
  return {rows:rows.slice((page-1)*100,page*100),more:rows.length>page*100,summary:'Weekly forecasts saved by StockChief, scored against what then sold, for weeks ending in the previous 90 completed days. '+
    (o.weeks?'Overall MAPE '+(o.mape??'not measurable')+(o.mape==null?'':'%')+', bias '+(o.bias==null?'not measurable':o.bias+'%')+' across '+o.weeks+' weeks.':'No weekly forecast was scored yet.')+' Weeks with no sales have no percentage error and are counted apart.'};
}

// ---- Kept current: the worker and the owner ---------------------------------

const plain=v=>JSON.parse(JSON.stringify(v));
async function produce(c,ctx,month,today,{automatic,watch=null}){
  const r=plain(await compute(c,ctx.workspaceId,{month,today}));
  return reports.record(c,ctx,{job:JOB,period:month,facts:r,result:r,flags:[],syncFlags:false,automatic,watch,
    action:automatic?'StockChief updated the forecast and delivery report':'Kept the forecast and delivery report'});
}
// Worker: the month so far and the month that just ended.
async function run(database,workspaceId){
  const actorId=await reports.currentOwner(database,workspaceId);if(!actorId)return {skipped:'owner_unavailable'};
  const ctx={workspaceId,actorId},state=await policy.accountState(database,workspaceId);
  if(!reports.alone(state,JOB))return {skipped:'plan'};
  if(await reports.paused(database,workspaceId))return {held:'paused'};
  const today=await time.today(database,workspaceId);
  const months=[reports.lastCompleted(today),...(today.slice(8,10)==='01'?[]:[today.slice(0,7)])];
  return reports.tx(database,async c=>{const watch=await reports.automaticStop(c,workspaceId,state,ACTION),out=[];
    for(const month of months)out.push({month,...await produce(c,ctx,month,today,{automatic:true,watch})});
    return {months:out};});
}
async function schedule(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);if(!reports.alone(state,JOB))return {queued:0};
  const today=await time.today(db,workspaceId);
  const job=await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:KIND,priority:72,maxAttempts:3,idempotencyKey:'service-levels:'+today,payload:{}});
  return {queued:job.created?1:0};
}
async function keep(database,ctx,input={}){
  await reports.owner(database,ctx);
  const state=await policy.requireWorkspaceJob(database,ctx.workspaceId,JOB,'draft');
  const stop=await policy.stopped(database,ctx.workspaceId,state,ACTION,false);if(stop)throw new ValidationError(stop);
  const today=await time.today(database,ctx.workspaceId),month=period(today,input.month).month;
  return reports.tx(database,async c=>produce(c,ctx,month,today,{automatic:false}));
}

// ---- Page and files --------------------------------------------------------

async function access(db,ctx){await reports.owner(db,ctx);return policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'suggest');}
async function page(db,ctx,query={}){
  const state=await access(db,ctx);
  const today=await time.today(db,ctx.workspaceId),month=period(today,query.month).month;
  const r=await db.transaction(c=>compute(c,ctx.workspaceId,{month,today}),{isolation:'REPEATABLE READ'});
  const runs=await reports.runs(db,ctx.workspaceId,JOB,{limit:60});
  const history=[];for(const run of runs)if(run.outcome!=='STOPPED'&&!history.some(h=>h.period===run.period))history.push(run);
  return {report:r,month,sentence:sentence(r),months:Array.from({length:13},(_,i)=>reports.addMonths(today.slice(0,7),-i)),
    history:history.slice(0,12),shadow:Boolean(state.shadow),automatic:await reports.automaticStop(db,ctx.workspaceId,state,ACTION),
    downloads:{xlsx:href+'/download?'+new URLSearchParams({month,format:'xlsx'}),pdf:href+'/download?'+new URLSearchParams({month,format:'pdf'})}};
}
function sheets(r){
  const party=kind=>r.parties.filter(p=>p.kind===kind).map(p=>[p.name,p.orders,p.ordered,p.filled,p.fill,p.timely,p.otif]);
  const partyColumns=kind=>[kind,'Orders due','Units ordered',kind==='Customer'?'Units shipped':'Units received','Fill rate %','On time in full','OTIF %'];
  const o=r.forecasts.overall;
  return [
    {name:'Summary',heading:'Summary',columns:['Measure','Value'],rows:[['Period',r.start+' to '+r.end],['Forecast MAPE %',o.mape],['Forecast bias %',o.bias],['Weekly forecasts scored',o.weeks],
      ['Weeks with no sales',o.noSales],['Customer fill rate %',r.customers.fill],['Customer OTIF %',r.customers.otif],['Customer orders due',r.customers.orders],
      ['Supplier fill rate %',r.suppliers.fill],['Supplier OTIF %',r.suppliers.otif],['Supplier orders due',r.suppliers.orders],
      ['Orders with no promised date (left out)',r.customers.undated+r.suppliers.undated]]},
    {name:'Forecast accuracy',heading:'Forecast accuracy by product',columns:['SKU','Product','Weeks scored','Forecast units','Actual units','MAPE %','Bias %','Weeks with no sales'],
      rows:r.forecasts.items.map(i=>[i.code,i.name,i.weeks,i.forecast,i.actual,i.mape,i.bias,i.noSales])},
    {name:'Customers',heading:'Customers',columns:partyColumns('Customer'),rows:party('Customer')},
    {name:'Suppliers',heading:'Suppliers',columns:partyColumns('Supplier'),rows:party('Supplier')}];
}
async function download(db,ctx,query={}){
  await access(db,ctx);
  const format=query.format==='pdf'?'pdf':query.format==='xlsx'||!query.format?'xlsx':null;
  if(!format)throw new ValidationError('Choose Excel or PDF.');
  const today=await time.today(db,ctx.workspaceId),month=period(today,query.month).month;
  const r=await db.transaction(c=>compute(c,ctx.workspaceId,{month,today}),{isolation:'REPEATABLE READ'});
  const files=require('../reports/agent-report-files'),parts=sheets(r);
  const body=format==='pdf'?await files.pdf({title:'Forecast accuracy, fill rate and on-time in full · '+r.name+(r.partial?' so far':''),subtitle:r.start+' to '+r.end,lines:[sentence(r)],
    sections:parts.slice(1).map(p=>({heading:p.heading,columns:p.columns,rows:p.rows.map(row=>row.map(v=>v??'—')),empty:'Nothing due in this period.'})),
    footer:'Forecasts are StockChief’s saved weekly forecasts scored against recorded sales. Orders without a promised date are left out.'})
    :files.workbook(parts);
  return {filename:'forecast-and-delivery-'+month+'.'+format,format,body};
}

module.exports={JOB,ACTION,KIND,href,accuracy,delivery,compute,sentence,report,accuracyReport,run,schedule,keep,page,download,
  definitions:[{id:JOB,key:'service-levels',label:'Forecast accuracy, fill rate and on-time delivery',filterLabel:'Customer or supplier name',readPage:report},
    {id:JOB,key:'forecast-accuracy',label:'Forecast accuracy by product',filterLabel:'Product code or name',readPage:accuracyReport}]};

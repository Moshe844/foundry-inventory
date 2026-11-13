'use strict';
// Job 164: one supplier's review for a completed calendar quarter.
//
// Every order placed with the supplier in the quarter, line by line: what was
// ordered, what arrived by the quarter close, the promised date and whether
// the line arrived in full by that date. A summary per currency gives the fill
// rate and on-time-in-full rate. Only this supplier's own orders are in it,
// so the pack can be sent to them as it is.
const {ValidationError}=require('../domain/errors');
const time=require('../lib/business-time');
const {addDays}=require('../accounting/customer-money');
const money=require('../domain/currency');

// The calendar quarter that ended most recently before `today`.
function quarter(today){
  const month=Number(today.slice(5,7))-1;
  const finish=new Date(Date.UTC(Number(today.slice(0,4)),month-month%3,1)).toISOString().slice(0,10);
  const start=new Date(Date.UTC(Number(finish.slice(0,4)),Number(finish.slice(5,7))-4,1)).toISOString().slice(0,10);
  const end=addDays(finish,-1);
  return {start,end,finish,closing:end.slice(0,7),label:'Q'+Math.ceil(Number(end.slice(5,7))/3)+' '+end.slice(0,4)};
}
const percent=(part,whole)=>whole>0?Math.round(part*1000/whole)/10:null;

// Every line of every order placed with this supplier in the quarter.
async function lines(db,workspaceId,supplierId,span,zone,{limit=null,offset=0}={}){
  return (await db.query(`SELECT p.id,p.po_number,p.currency,p.expected_date,l.line_number,s.code,l.quantity_units AS ordered,
    l.unit_cost,coalesce(r.units,0) AS received,coalesce(r.on_time,0) AS on_time,
    p.expected_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AS dated
    FROM purchase_orders p JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    LEFT JOIN LATERAL (SELECT sum(x.quantity_units) AS units,
        sum(x.quantity_units) FILTER (WHERE receipt.received_at::timestamptz < CASE WHEN p.expected_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          THEN ((p.expected_date::date+1)::timestamp AT TIME ZONE $7) END) AS on_time
      FROM purchase_order_receipt_lines x
      JOIN purchase_order_receipts receipt ON receipt.workspace_id=x.workspace_id AND receipt.id=x.receipt_id
      WHERE x.workspace_id=l.workspace_id AND x.purchase_order_line_id=l.id AND receipt.received_at::timestamptz<$4::timestamptz) r ON true
    WHERE p.workspace_id=$1 AND p.supplier_id=$2 AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')
      AND p.ordered_at::timestamptz >= $3::timestamptz AND p.ordered_at::timestamptz < $4::timestamptz
    ORDER BY p.ordered_at,p.id,l.line_number LIMIT $5 OFFSET $6`,
  [workspaceId,supplierId,time.dayBoundary(span.start,zone),time.dayBoundary(span.finish,zone),limit,offset,zone])).rows;
}
function row(r){
  const ordered=Number(r.ordered),received=Number(r.received),onTime=Number(r.on_time);
  return {Order:r.po_number,SKU:r.code,Ordered:r.ordered,'Received by close':r.received,'Promised date':r.expected_date,
    'On time in full':r.dated?(onTime>=ordered?'Yes':'No'):'No date',
    'Unit cost':r.unit_cost==null?'Unknown':money.format(money.toMinor(String(r.unit_cost),r.currency),r.currency),
    Currency:r.currency,link:'/purchasing/orders/'+r.id,_ordered:ordered,_received:received};
}
// One summary line per currency.
function summarize(raw){
  const by=new Map();
  for(const r of raw){
    const s=by.get(r.currency)||{currency:r.currency,orders:new Set(),lines:0,ordered:0,received:0,dated:0,onTimeInFull:0,valueMinor:0,unknownCost:0};
    s.orders.add(r.id);s.lines++;s.ordered+=Number(r.ordered);s.received+=Math.min(Number(r.received),Number(r.ordered));
    if(r.dated){s.dated++;if(Number(r.on_time)>=Number(r.ordered))s.onTimeInFull++;}
    if(r.unit_cost==null)s.unknownCost++;else s.valueMinor+=Math.round(Number(money.toMinor(String(r.unit_cost),r.currency))*Number(r.ordered));
    by.set(r.currency,s);
  }
  return [...by.values()].sort((a,b)=>a.currency.localeCompare(b.currency)).map(s=>({currency:s.currency,orders:s.orders.size,lines:s.lines,
    ordered:Math.round(s.ordered*10000)/10000,received:Math.round(s.received*10000)/10000,fillRate:percent(s.received,s.ordered),
    dated:s.dated,onTimeInFull:s.onTimeInFull,onTimeRate:percent(s.onTimeInFull,s.dated),valueMinor:s.valueMinor,unknownCost:s.unknownCost}));
}
function sentence(s){
  return s.currency+': '+s.orders+' order'+(s.orders===1?'':'s')+' and '+s.lines+' line'+(s.lines===1?'':'s')+'; '+s.received+' of '+s.ordered+' units arrived by the quarter close'+
    (s.fillRate===null?'':' ('+s.fillRate+'% fill rate)')+'; '+(s.dated?s.onTimeInFull+' of '+s.dated+' dated lines arrived in full on time'+(s.onTimeRate===null?'':' ('+s.onTimeRate+'%)'):'no line had a promised date')+
    '; ordered value '+money.format(s.valueMinor,s.currency)+(s.unknownCost?' ('+s.unknownCost+' line'+(s.unknownCost===1?'':'s')+' without a cost)':'')+'.';
}
async function business(db,workspaceId){return (await require('../operations/postgres-company-profile').get(db,workspaceId)).legalName;}

// The whole pack for one supplier (the worker and the kept copy use this).
async function facts(db,workspaceId,supplier,span){
  const zone=(await time.forWorkspace(db,workspaceId)).timeZone;
  const raw=await lines(db,workspaceId,supplier.id,span,zone);
  return {supplier:supplier.name,supplierId:supplier.id,business:await business(db,workspaceId),span,zone,
    totals:summarize(raw),rows:raw.map(row)};
}
const clean=rows=>rows.map(({_ordered,_received,...r})=>r);
function describe(pack){
  return 'Orders '+pack.business+' placed with '+pack.supplier+' from '+pack.span.start+' through '+pack.span.end+'. Received units use receipts dated through the quarter close. '+
    pack.totals.map(sentence).join(' ');
}

async function report(db,ctx,{today,filter,page=1,download=false}){
  const span=quarter(today);
  if(!filter)return {span,rows:[],more:false,summary:'Enter the exact supplier name to prepare their pack for '+span.start+' through '+span.end+'.'};
  const suppliers=(await db.query('SELECT id,name FROM suppliers WHERE workspace_id=$1 AND (id=$2 OR lower(name)=lower($2)) ORDER BY id LIMIT 2',[ctx.workspaceId,filter])).rows;
  if(suppliers.length!==1){
    if(download)throw new ValidationError('Choose one matching supplier in this inventory.');
    return {span,rows:[],more:false,summary:suppliers.length?'Several suppliers have this name. Use the supplier record ID.':'No supplier matched this name.'};
  }
  const [supplier]=suppliers;
  if(download){const pack=await facts(db,ctx.workspaceId,supplier,span);return {...pack,more:false,summary:describe(pack),rows:clean(pack.rows)};}
  const zone=(await time.forWorkspace(db,ctx.workspaceId)).timeZone;
  const raw=await lines(db,ctx.workspaceId,supplier.id,span,zone,{limit:101,offset:(page-1)*100});
  return {supplier:supplier.name,span,more:raw.length>100,
    summary:'Orders placed with '+supplier.name+' from '+span.start+' through '+span.end+'. Received units use receipts dated through the quarter close.',
    rows:clean(raw.slice(0,100).map(row))};
}

async function pdf(report){
  if(!report.supplier)throw new ValidationError('Choose the supplier before downloading a shareable pack.');
  if(!report.rows.length)throw new ValidationError('This supplier has no placed orders in the last completed quarter.');
  const from=(report.business?report.business+' for ':'')+report.supplier,label=report.span.label||report.span.start.slice(0,7);
  const totals=report.totals||[];
  return require('../reports/exports').pdf({config:{title:'Quarterly supplier review · '+report.supplier},sheets:[
    {title:'Summary',sourceLabel:'From '+from+' · '+label+' ('+report.span.start+' to '+report.span.end+'). Only orders placed with you in this quarter are included.',
      columns:['Currency','Orders','Lines','Units ordered','Received by close','Fill rate','Dated lines on time in full','Ordered value'],
      rows:totals.map(s=>({Currency:s.currency,Orders:s.orders,Lines:s.lines,'Units ordered':s.ordered,'Received by close':s.received,
        'Fill rate':s.fillRate===null?'':s.fillRate+'%','Dated lines on time in full':s.dated?s.onTimeInFull+' of '+s.dated+(s.onTimeRate===null?'':' ('+s.onTimeRate+'%)'):'No promised dates',
        'Ordered value':money.format(s.valueMinor,s.currency)+(s.unknownCost?' + '+s.unknownCost+' without a cost':'')}))},
    {title:'Order lines',sourceLabel:'Received units use receipts dated through '+report.span.end+'. On time in full means every unit arrived by the end of the promised date.',
      columns:['Order','SKU','Ordered','Received by close','Promised date','On time in full','Unit cost','Currency'],rows:clean(report.rows)}]});
}
module.exports={quarter,facts,describe,sentence,report,pdf,summarize};

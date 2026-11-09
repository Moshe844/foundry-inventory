'use strict';
const {ValidationError}=require('../domain/errors');
const time=require('../lib/business-time');
const {addDays}=require('../accounting/customer-money');
const money=require('../domain/currency');

async function report(db,ctx,{today,filter,page=1,download=false}){
  const month=Number(today.slice(5,7))-1;
  const finish=new Date(Date.UTC(Number(today.slice(0,4)),month-month%3,1)).toISOString().slice(0,10);
  const start=new Date(Date.UTC(Number(finish.slice(0,4)),Number(finish.slice(5,7))-4,1)).toISOString().slice(0,10);
  const end=addDays(finish,-1),zone=(await time.forWorkspace(db,ctx.workspaceId)).timeZone;
  const span={start,end,closing:end.slice(0,7)};
  if(!filter)return {span,rows:[],more:false,summary:'Enter the exact supplier name to prepare their pack for '+start+' through '+end+'.'};
  const suppliers=(await db.query('SELECT id,name FROM suppliers WHERE workspace_id=$1 AND (id=$2 OR lower(name)=lower($2)) ORDER BY id LIMIT 2',[ctx.workspaceId,filter])).rows;
  if(suppliers.length!==1){
    if(download)throw new ValidationError('Choose one matching supplier in this inventory.');
    return {span,rows:[],more:false,summary:suppliers.length?'Several suppliers have this name. Use the supplier record ID.':'No supplier matched this name.'};
  }
  const [supplier]=suppliers;
  const {rows}=await db.query(`SELECT p.id,p.po_number,p.currency,p.expected_date,l.line_number,s.code,l.quantity_units AS ordered,
    l.unit_cost,coalesce(r.units,0) AS received
    FROM purchase_orders p JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    LEFT JOIN LATERAL (SELECT sum(x.quantity_units) AS units FROM purchase_order_receipt_lines x
      JOIN purchase_order_receipts receipt ON receipt.workspace_id=x.workspace_id AND receipt.id=x.receipt_id
      WHERE x.workspace_id=l.workspace_id AND x.purchase_order_line_id=l.id AND receipt.received_at::timestamptz<$4::timestamptz) r ON true
    WHERE p.workspace_id=$1 AND p.supplier_id=$2 AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')
      AND p.ordered_at::timestamptz >= $3::timestamptz AND p.ordered_at::timestamptz < $4::timestamptz
    ORDER BY p.ordered_at,p.id,l.line_number LIMIT $5 OFFSET $6`,[ctx.workspaceId,supplier.id,time.dayBoundary(start,zone),time.dayBoundary(finish,zone),download?null:101,download?0:(page-1)*100]);
  return {supplier:supplier.name,span,more:!download&&rows.length>100,
    summary:'Orders placed with '+supplier.name+' from '+start+' through '+end+'. Received units use receipts dated through the quarter close.',
    rows:(download?rows:rows.slice(0,100)).map(r=>({Order:r.po_number,SKU:r.code,Ordered:r.ordered,'Received by close':r.received,
      'Promised date':r.expected_date,'Unit cost':r.unit_cost==null?'Unknown':money.format(money.toMinor(String(r.unit_cost),r.currency),r.currency),
      Currency:r.currency,link:'/purchasing/orders/'+r.id}))};
}

async function pdf(report){
  if(!report.supplier)throw new ValidationError('Choose the supplier before downloading a shareable pack.');
  if(!report.rows.length)throw new ValidationError('This supplier has no placed orders in the last completed quarter.');
  return require('../reports/exports').pdf({config:{title:'Quarterly supplier review · '+report.supplier},sourceLabel:report.summary,
    columns:['Order','SKU','Ordered','Received by close','Promised date','Unit cost','Currency'],rows:report.rows});
}
module.exports={report,pdf};

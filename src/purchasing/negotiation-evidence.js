'use strict';
// Job 94: the recorded facts behind a supplier negotiation email. Each fact
// says what happened in plain words and links to its evidence:
//  - late deliveries: final receipt after the order's expected date;
//  - short deliveries: due order lines received with fewer units;
//  - price increases: job 91's checked invoice and price-list findings;
//  - cheaper quotes: current job 92 quotations from other suppliers;
//  - volume: orders placed with this supplier.
// Nothing here sends, orders or changes a price.
const time=require('../lib/business-time'),money=require('../domain/currency'),{addDays}=require('../accounting/customer-money');
const {ValidationError}=require('../domain/errors'),{hash}=require('../pricing/postgres-promotions');
const PLACED="('ORDERED','PARTIALLY_RECEIVED','RECEIVED')";
const minor=(value,currency)=>Math.round(Number(value)*10**money.exponent(currency));
const plural=(n,one,many)=>n+' '+(n===1?one:many);

async function supplier(db,ctx,filter){
 if(!String(filter||'').trim())throw new ValidationError('Choose a supplier by exact name or record ID.');
 const rows=(await db.query("SELECT id,name,email,currency FROM suppliers WHERE workspace_id=$1 AND status='active' AND (id=$2 OR lower(name)=lower($2)) ORDER BY id LIMIT 2",[ctx.workspaceId,String(filter).trim()])).rows;
 if(rows.length!==1)throw new ValidationError('Choose one matching supplier in this inventory. Use the supplier record to distinguish similar names.');
 return rows[0];
}
// Completed warehouse orders, one per order, finished on their last receipt
// date in the business's time zone.
async function lateDeliveries(db,ctx,person,from,to,timeZone){
 const rows=(await db.query(`SELECT p.id,p.po_number,p.expected_date::date::text AS expected,(max(r.received_at::timestamptz) AT TIME ZONE $3)::date::text AS received
  FROM purchase_orders p JOIN purchase_order_receipts r ON r.workspace_id=p.workspace_id AND r.purchase_order_id=p.id
  WHERE p.workspace_id=$1 AND p.supplier_id=$2 AND p.status='RECEIVED' AND p.ordered_at IS NOT NULL AND p.expected_date IS NOT NULL
   AND coalesce(to_jsonb(p)->>'delivery_kind','WAREHOUSE')='WAREHOUSE'
  GROUP BY p.id HAVING (max(r.received_at::timestamptz) AT TIME ZONE $3)::date BETWEEN $4::date AND $5::date
   AND (min(p.ordered_at::timestamptz) AT TIME ZONE $3)::date<=(max(r.received_at::timestamptz) AT TIME ZONE $3)::date
  ORDER BY received,p.id`,[ctx.workspaceId,person.id,timeZone,from,to])).rows;
 return {rows,late:rows.filter(r=>r.received>r.expected)};
}
async function collect(db,ctx,filter,{days=365,routine=false}={}){
 const person=await supplier(db,ctx,filter),{timeZone,calendarDate:today}=await time.forWorkspace(db,ctx.workspaceId),from=addDays(today,-(days-1)),facts=[];
 const delivered=await lateDeliveries(db,ctx,person,from,today,timeZone);
 if(delivered.late.length)facts.push({kind:'late',count:delivered.late.length,total:delivered.rows.length,
  text:delivered.late.length+' of '+delivered.rows.length+' completed orders with an agreed delivery date arrived late.',
  lines:delivered.late.slice(-6).map(r=>r.po_number+' was due '+r.expected+' and fully arrived '+r.received+'.'),
  evidence:delivered.late.map(r=>({label:r.po_number+': due '+r.expected+', arrived '+r.received,href:'/purchasing/orders/'+r.id}))});
 if(!routine){
  const short=(await db.query(`SELECT p.id,p.po_number,count(*) FILTER(WHERE l.quantity_received_units<l.quantity_units)::int AS short_lines,count(*)::int AS lines,
    sum(greatest(l.quantity_units-l.quantity_received_units,0))::bigint AS units
   FROM purchase_orders p JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
   WHERE p.workspace_id=$1 AND p.supplier_id=$2 AND p.status IN ('PARTIALLY_RECEIVED','RECEIVED') AND p.expected_date IS NOT NULL AND p.expected_date::date<=$4::date
    AND (p.ordered_at::timestamptz AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date AND l.quantity_units>0
    AND coalesce(to_jsonb(p)->>'delivery_kind','WAREHOUSE')='WAREHOUSE'
   GROUP BY p.id,p.po_number ORDER BY p.po_number,p.id`,[ctx.workspaceId,person.id,from,today,timeZone])).rows;
  const shortOrders=short.filter(r=>r.short_lines>0),shortLines=short.reduce((n,r)=>n+r.short_lines,0),dueLines=short.reduce((n,r)=>n+r.lines,0),units=shortOrders.reduce((n,r)=>n+Number(r.units),0);
  if(shortLines)facts.push({kind:'short',count:shortLines,total:dueLines,
   text:plural(shortLines,'order line','order lines')+' of '+dueLines+' due came in short, '+plural(units,'unit','units')+' in all.',
   lines:shortOrders.slice(0,6).map(r=>r.po_number+': '+plural(Number(r.units),'unit','units')+' short.'),
   evidence:shortOrders.map(r=>({label:r.po_number+': '+r.units+' short',href:'/purchasing/orders/'+r.id}))});
  const increases=(await require('./agent-supplier-price-increases').readPage(db,ctx,{filter:person.name,page:1})).rows.filter(r=>r.Supplier===person.name);
  if(increases.length)facts.push({kind:'price',count:increases.length,
   text:plural(increases.length,'price went','prices went')+' up against what we agreed before.',
   lines:increases.slice(0,6).map(r=>r.SKU+' went from '+r['Previous trusted price']+' to '+r['Supplier unit price']+(r.Document?' ('+r.Source.toLowerCase()+' '+r.Document+')':'')+'.'),
   evidence:increases.map(r=>({label:r.SKU+': '+r['Previous trusted price']+' to '+r['Supplier unit price'],href:r.link}))});
  // This supplier's latest placed price per product and currency, against
  // the cheapest current quote from anyone else for the same product.
  const mine=(await db.query(`SELECT DISTINCT ON (l.sku_id,p.currency) l.sku_id,k.code,p.currency,l.unit_cost::text AS unit_cost
   FROM purchase_order_lines l JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id JOIN skus k ON k.workspace_id=l.workspace_id AND k.id=l.sku_id
   WHERE l.workspace_id=$1 AND p.supplier_id=$2 AND p.status IN ${PLACED} AND l.unit_cost IS NOT NULL
   ORDER BY l.sku_id,p.currency,p.ordered_at::timestamptz DESC NULLS LAST,p.id DESC LIMIT 500`,[ctx.workspaceId,person.id])).rows;
  const quotes=mine.length?(await db.query(`SELECT DISTINCT ON (line->>'skuId',d.facts::jsonb->>'currency') line->>'skuId' AS sku_id,d.facts::jsonb->>'currency' AS currency,
    (line->>'unitCostMinor')::bigint AS unit_minor,d.message_id,d.facts::jsonb#>>'{quotationTerms,validThrough}' AS valid_through
   FROM supplier_documents d JOIN suppliers s ON s.workspace_id=d.workspace_id AND s.id=d.supplier_id AND s.status='active'
   JOIN connection_email_messages m ON m.workspace_id=d.workspace_id AND m.id=d.message_id AND m.supplier_id=d.supplier_id AND m.trust_status='TRUSTED'
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.facts::jsonb->'lines')='array' THEN d.facts::jsonb->'lines' ELSE '[]'::jsonb END) line
   WHERE d.workspace_id=$1 AND d.document_type='quotation' AND d.status IN ('MATCHED','RECORDED','NEEDS_REVIEW') AND d.supplier_id<>$2
    AND line->>'skuId'=ANY($3::text[]) AND line->>'unitCostMinor' ~ '^\\d{1,15}$'
    AND coalesce(d.facts::jsonb#>>'{quotationTerms,validThrough}','9999-12-31')>=$4
   ORDER BY line->>'skuId',d.facts::jsonb->>'currency',(line->>'unitCostMinor')::bigint,d.processed_at DESC,d.id`,[ctx.workspaceId,person.id,mine.map(r=>r.sku_id),today])).rows:[];
  const cheaper=quotes.map(q=>{const own=mine.find(m=>m.sku_id===q.sku_id&&m.currency===q.currency);return own&&Number(q.unit_minor)<minor(own.unit_cost,own.currency)?{...q,code:own.code,own:minor(own.unit_cost,own.currency)}:null;}).filter(Boolean);
  if(cheaper.length)facts.push({kind:'quote',count:cheaper.length,
   text:'We have current quotes from other suppliers below your last price for '+plural(cheaper.length,'product','products')+'.',
   lines:cheaper.slice(0,6).map(q=>q.code+': quoted at '+money.format(q.unit_minor,q.currency)+' a unit; your last price was '+money.format(q.own,q.currency)+'.'),
   evidence:cheaper.map(q=>({label:q.code+': '+money.format(q.unit_minor,q.currency)+' against '+money.format(q.own,q.currency),href:'/mail/'+q.message_id}))});
  const volume=(await db.query(`SELECT p.currency,count(DISTINCT p.id)::int AS orders,sum(l.quantity_units*l.unit_cost)::text AS value
   FROM purchase_orders p JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
   WHERE p.workspace_id=$1 AND p.supplier_id=$2 AND p.status IN ${PLACED} AND l.unit_cost IS NOT NULL
    AND (p.ordered_at::timestamptz AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
   GROUP BY p.currency ORDER BY p.currency`,[ctx.workspaceId,person.id,from,today,timeZone])).rows;
  if(volume.length){const orders=volume.reduce((n,v)=>n+v.orders,0);facts.push({kind:'volume',count:orders,
   text:'We placed '+plural(orders,'order','orders')+' with you worth '+volume.map(v=>money.format(minor(v.value,v.currency),v.currency)).join(' and ')+'.',lines:[],
   evidence:[{label:'Orders with '+person.name,href:'/suppliers/'+person.id}]});}
 }
 return {supplier:person,from,to:today,facts,completed:delivered.rows.length};
}
// The negotiation email a person edits and sends.
function negotiationEmail(found){
 const {supplier:s,from,to,facts}=found,asks=[];
 if(facts.some(f=>f.kind==='late'))asks.push('the lead time you can reliably meet');
 if(facts.some(f=>f.kind==='short'))asks.push('shipping our orders complete');
 if(facts.some(f=>f.kind==='price'||f.kind==='quote'||f.kind==='volume'))asks.push('your prices for the volume we buy');
 const subject='Our orders with '+s.name;
 const body=['Hello '+s.name+',','','We would like to review how our orders are going. From '+from+' to '+to+':','',
  ...facts.flatMap(f=>['- '+f.text,...f.lines.map(l=>'  '+l)]),'',
  'Could we talk about '+(asks.length>1?asks.slice(0,-1).join(', ')+' and '+asks.at(-1):asks[0])+'?','','Thank you.'].join('\n');
 return {subject,body};
}
// The routine note Custom may send on its own. It asks, and commits nothing.
function leadTimeNote(found){
 const late=found.facts.find(f=>f.kind==='late');
 return {subject:'Delivery times for '+found.supplier.name,body:['Hello '+found.supplier.name+',','',
  'From '+found.from+' to '+found.to+', '+late.text,...late.lines,'',
  'Please confirm the lead time you can meet for our next orders, and let us know what will change so they arrive on time.','',
  'This note does not place, change or cancel any order, and does not change any price or terms.','','Thank you.'].join('\n')};
}
function key(found,words){return hash({supplier:found.supplier,from:found.from,to:found.to,facts:found.facts,...words});}
module.exports={supplier,collect,negotiationEmail,leadTimeNote,key};

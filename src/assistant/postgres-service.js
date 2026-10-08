'use strict';

const config = require('../config');
const { createProviderUnobserved } = require('../ai/provider');
const operatingInstructions = require('../manager/postgres-operating-instructions');
const pricing = require('../pricing/postgres-service');
const outboundMail = require('../connections/postgres-outbound-mail');
const accountingReports = require('../accounting/postgres-reports');
const evidenceAnswers = require('./postgres-evidence-answer');
const projections = require('../projections/postgres-service');
const autonomy = require('../autopilot/postgres-service');
const entitlements=require('../entitlements/postgres-service');
const { ValidationError, NotFoundError, InvariantError } = require('../domain/errors');
const { newId, trimOrNull } = require('../lib/util');

const EMAIL_DRAFT_SCHEMA={type:'object',additionalProperties:false,required:['subject','body'],properties:{
  subject:{type:'string',maxLength:200},body:{type:'string',maxLength:6000},
}};
const EMAIL_DRAFT_SYSTEM=`Copyedit the owner's email words. Return only the schema.
This is a grammar and spelling correction, not a composition task. Keep the same business nouns, verbs, dates, quantities, names, amounts, commitments, and uncertainties. Do not infer what a vague word such as "confirm" refers to.
Do not add a greeting, thanks, sign-off, explanation, promise, fact, deadline, price, order status, shipment claim, receipt claim, or attachment claim unless the owner explicitly supplied it. Do not invent the sender's name.
Use a short subject made only from concepts the owner explicitly stated; if there is no safe subject, return an empty string. The body should contain only the corrected version of the supplied message, ready for the owner to review before sending.`;
function recordHandoff(kind,name,extras={}) {
  const params=new URLSearchParams({name:String(name||'').trim()});
  if(kind==='customer'&&trimOrNull(extras.shippingAddress))params.set('shippingAddress',trimOrNull(extras.shippingAddress));
  const label=kind==='customer'?`Add ${name} as a customer`:`Add ${name} as a supplier`;
  return {href:kind==='customer'?`/sales/customers/new?${params}`:`/suppliers?${params}#add-supplier`,label};
}

async function resolveCustomerOrderLines(database,ctx,raw,message,currency){
  let entries;
  try{entries=JSON.parse(String(raw||''));}catch{return {answer:'I could not safely read all the product lines. Restate the items, quantities, and per-unit prices; nothing was prepared.'};}
  if(!Array.isArray(entries)||entries.length<2||entries.length>12)return {answer:
    'A multi-product draft needs two to twelve distinct product lines. Nothing was prepared.'};
  const quotedAmounts=[...String(message||'').matchAll(/[$€£]\s*(\d[\d,]*(?:\.\d{1,2})?)/g)]
    .map((match)=>pricing.toMinor(match[1].replaceAll(',',''),'Quoted selling price'));
  const seen=new Set(),lines=[],summaries=[];let orderCurrency=currency||null;
  for(const [index,entry] of entries.entries()){
    if(!entry||typeof entry!=='object'||Array.isArray(entry))
      return {answer:'One product line was not an item with a product and quantity. Nothing was prepared.'};
    const normalized=Object.fromEntries(Object.entries(entry)
      .map(([key,value])=>[key.replace(/[^a-z0-9]/gi,'').toLowerCase(),value]));
    const first=(keys)=>keys.map((key)=>normalized[key]).find((value)=>value!==undefined&&value!==null&&value!=='');
    const rawProduct=first(['sku','skucode','product','productname','item','itemname','itemcode','code','name']);
    const product=rawProduct&&typeof rawProduct==='object'
      ?rawProduct.sku||rawProduct.code||rawProduct.name:null;
    const named=trimOrNull(product||rawProduct);
    const quantity=Number(first(['quantity','qty','units','unitcount']));
    const statedPrice=first(['unitprice','priceperunit','perunitprice','sellingprice','price','amount']);
    if(!named||!Number.isSafeInteger(quantity)||quantity<1||quantity>100000)
      return {answer:'Each product line needs an exact product and a positive whole-unit quantity. Nothing was prepared.'};
    const found=await resolveRequestedSku(database,ctx.workspaceId,{sku:named});
    if(!found.row)return {answer:`I could not uniquely verify product “${named}”. Give its exact SKU code; nothing was prepared.`};
    if(seen.has(found.row.id))return {answer:`${found.row.code} appears twice. Combine its quantity into one line; nothing was prepared.`};
    seen.add(found.row.id);
    const current=await pricing.currentPrice(database,ctx.workspaceId,found.row.id);
    if(quotedAmounts.length>=entries.length&&statedPrice===undefined)
      return {answer:`Your request quotes prices for every line, but ${found.row.code} has no preserved quoted price. Nothing was prepared.`};
    if(orderCurrency&&current.currency&&current.currency!==orderCurrency&&statedPrice===undefined)
      return {answer:'Those products have prices in different currencies. Name one order currency and exact per-unit prices; nothing was prepared.'};
    orderCurrency=orderCurrency||current.currency||'USD';
    let unitPriceMinor=current.amount_minor;
    if(statedPrice!==undefined){
      try{unitPriceMinor=pricing.toMinor(String(statedPrice),'Selling price');}
      catch{return {answer:`The per-unit price for ${found.row.code} is invalid. Nothing was prepared.`};}
      if(!quotedAmounts.includes(unitPriceMinor))return {answer:
        `I could not verify the proposed ${pricing.formatMinor(unitPriceMinor,orderCurrency)} per-unit price for ${found.row.code} in your request. Nothing was prepared.`};
      if(quotedAmounts.length===entries.length&&quotedAmounts[index]!==unitPriceMinor)return {answer:
        `The proposed per-unit prices do not follow the line order you gave. Restate the items and prices; nothing was prepared.`};
    }
    if(!Number.isSafeInteger(unitPriceMinor)||unitPriceMinor<=0)return {answer:
      `What selling price per unit should ${found.row.code} use? Nothing was prepared.`};
    lines.push({skuId:found.row.id,quantity,unitPriceMinor});
    summaries.push(`${quantity} × ${found.row.code} at ${pricing.formatMinor(unitPriceMinor,orderCurrency)} each`);
  }
  return {lines,currency:orderCurrency,summary:summaries.join('; ')};
}

function evidenceRow(row,href) {
  return {...row,...(href?{href}:{})};
}

function lookupSearchPatterns(search){
  if(!search)return [];
  const terms=require('./postgres-context-resolver').tokens(search);
  const escaped=terms.map((token)=>token.replace(/[\\%_]/gu,'\\$&'));
  return [`%${escaped.join('%')}%`];
}

function profitComparisonPeriods(now=new Date()){
  const year=now.getUTCFullYear();const month=now.getUTCMonth();const day=now.getUTCDate();
  const previousLastDay=new Date(Date.UTC(year,month,0)).getUTCDate();
  const iso=(value)=>value.toISOString().slice(0,10);
  return {current:{from:iso(new Date(Date.UTC(year,month,1))),to:iso(new Date(Date.UTC(year,month,day)))},
    previous:{from:iso(new Date(Date.UTC(year,month-1,1))),to:iso(new Date(Date.UTC(year,month-1,Math.min(day,previousLastDay))))}};
}

async function explainProfitChange(database,ctx){
  const scope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);
  const access=await entitlements.capabilityState(database,scope,'accounting.explanations');
  if(!access.enabled)return {status:'CLARIFY',answer:'Period-over-period profit explanations are available on Growth and above. Basic accounting records and reports remain available on Starter.',
    handoff:{href:'/upgrade?capability=accounting.explanations&return=/ask',label:'Review accounting intelligence plans'},rows:[],columns:[]};
  const periods=profitComparisonPeriods();const [current,previous]=await Promise.all([
    accountingReports.profitAndLoss(database,ctx.workspaceId,periods.current),
    accountingReports.profitAndLoss(database,ctx.workspaceId,periods.previous),
  ]);const money=(minor)=>pricing.formatMinor(Math.abs(Number(minor||0)),current.currency);
  const metrics=[
    {measure:'Revenue',current:current.revenueMinor,previous:previous.revenueMinor,impact:current.revenueMinor-previous.revenueMinor},
    {measure:'Cost of goods sold',current:current.cogsMinor,previous:previous.cogsMinor,impact:-(current.cogsMinor-previous.cogsMinor)},
    {measure:'Operating expenses',current:current.operatingExpenseMinor,previous:previous.operatingExpenseMinor,
      impact:-(current.operatingExpenseMinor-previous.operatingExpenseMinor)},
  ];const netChange=current.netIncomeMinor-previous.netIncomeMinor;
  const drivers=metrics.filter((entry)=>entry.impact!==0).sort((left,right)=>Math.abs(right.impact)-Math.abs(left.impact)).slice(0,3)
    .map((entry)=>`${entry.measure} ${entry.impact>0?'improved':'reduced'} profit by ${money(entry.impact)}`);
  const direction=netChange<0?`fell by ${money(netChange)}`:netChange>0?`rose by ${money(netChange)}`:'did not change';
  const answer=`Net income ${direction}: ${pricing.formatMinor(current.netIncomeMinor,current.currency)} for ${current.from} through ${current.to}, `+
    `versus ${pricing.formatMinor(previous.netIncomeMinor,previous.currency)} for ${previous.from} through ${previous.to}. `+
    (drivers.length?`Largest recorded drivers: ${drivers.join('; ')}.`:'There is no posted revenue, cost-of-goods or operating-expense difference between those periods.');
  const rows=metrics.concat([{measure:'Net income',current:current.netIncomeMinor,previous:previous.netIncomeMinor,impact:netChange}])
    .map((entry)=>({measure:entry.measure,current:pricing.formatMinor(entry.current,current.currency),
      previous:pricing.formatMinor(entry.previous,current.currency),profitImpact:`${entry.impact>=0?'+':'-'}${money(entry.impact)}`}));
  return {answer,rows,columns:['measure','current','previous','profitImpact'],
    handoff:{href:`/accounting/reports/profit-and-loss?from=${current.from}&to=${current.to}`,label:'Open the current profit and loss report'}};
}

function salesPeriod(timeframe,now=new Date()){
  const iso=(date)=>date.toISOString().slice(0,10);
  const year=now.getUTCFullYear(),month=now.getUTCMonth(),today=iso(now);
  if(timeframe==='today')return {from:today,to:today,label:'today'};
  if(timeframe==='month_to_date')return {from:iso(new Date(Date.UTC(year,month,1))),to:today,label:'this month'};
  if(timeframe==='previous_month')return {from:iso(new Date(Date.UTC(year,month-1,1))),
    to:iso(new Date(Date.UTC(year,month,0))),label:'last month'};
  if(timeframe==='last_30_days')return {from:iso(new Date(Date.UTC(year,month,now.getUTCDate()-29))),
    to:today,label:'in the last 30 days'};
  return {from:'1900-01-01',to:today,label:'so far'};
}

async function salesActivity(database,ctx,timeframe){
  const period=salesPeriod(timeframe);
  const counts=(await database.query(`SELECT COUNT(DISTINCT so.id) AS orders,
    COALESCE(SUM(sol.quantity_fulfilled),0) AS fulfilled_units
    FROM sales_orders so LEFT JOIN sales_order_lines sol ON sol.sales_order_id=so.id
    WHERE so.workspace_id=$1 AND so.order_date BETWEEN $2 AND $3
      AND so.status NOT IN ('DRAFT','CANCELLED')`,[ctx.workspaceId,period.from,period.to])).rows[0];
  let report=null;
  try{report=await accountingReports.profitAndLoss(database,ctx.workspaceId,{from:period.from,to:period.to});}
  catch(error){if(error.code!=='entitlement_required')throw error;}
  const orders=Number(counts.orders),fulfilledUnits=Number(counts.fulfilled_units);
  const revenue=report?pricing.formatMinor(report.revenueMinor,report.currency):null;
  const rows=[{measure:'Customer orders',value:orders},{measure:'Units fulfilled',value:fulfilledUnits},
    {measure:'Posted revenue',value:revenue||'Not available'}];
  const answer=orders===0&&report?.revenueMinor===0
    ?`I don't see any customer orders or posted sales revenue recorded in StockChief ${period.label}. Sales through systems that are not connected or imported here would not appear in this answer.`
    :orders===0&&!report
      ?`I don't see any customer orders recorded in StockChief ${period.label}. Posted revenue is not available here, so I cannot confirm whether other sales occurred.`
    :`StockChief records show ${orders} customer ${orders===1?'order':'orders'} ${period.label}, ${fulfilledUnits} units fulfilled, and ${revenue||'no available posted-revenue figure'}. Orders and posted revenue are different measures; sales outside connected or imported records are not included.`;
  return {answer,rows,columns:['measure','value'],handoff:{href:'/orders',label:'Review customer orders'}};
}

async function lookup(database,ctx,request,options={}) {
  const search=trimOrNull(request.search);
  if(request.view==='inventory_positions'){
    const rows=(await database.query(`SELECT i.id AS item_id,i.name AS product,s.code AS sku,
      COALESCE(s.variant_label,'') AS variant,l.name AS location,b.on_hand,b.updated_at
      FROM balances b JOIN skus s ON s.id=b.sku_id AND s.workspace_id=b.workspace_id
      JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
      JOIN locations l ON l.id=b.location_id AND l.workspace_id=b.workspace_id
      WHERE b.workspace_id=$1 AND i.is_active=1 AND s.is_active=1
      AND ($2::text IS NULL OR i.name ILIKE '%'||$2||'%' OR s.code ILIKE '%'||$2||'%'
        OR COALESCE(s.variant_label,'') ILIKE '%'||$2||'%' OR l.name ILIKE '%'||$2||'%')
      ORDER BY i.name,s.code,l.name LIMIT 100`,[ctx.workspaceId,search])).rows.map((row)=>
      evidenceRow({product:row.product,sku:row.sku,variant:row.variant,location:row.location,
        onHand:Number(row.on_hand),updatedAt:row.updated_at},`/inventory/${row.item_id}`));
    return {answer:rows.length?`${rows.length}${rows.length===100?'+':''} recorded product-location positions matched. These are on-hand quantities, not uncommitted availability.`:
      'No product-location stock position matched that request.',rows,
      columns:['product','sku','variant','location','onHand','updatedAt']};
  }
  if(request.view==='inventory_movements'){
    const rows=(await database.query(`SELECT i.id AS item_id,i.name AS product,s.code AS sku,l.name AS location,
      m.operation,m.quantity_delta,m.balance_after,m.reference,m.reason_code,m.occurred_at
      FROM movements m JOIN items i ON i.id=m.item_id AND i.workspace_id=m.workspace_id
      JOIN skus s ON s.id=m.sku_id AND s.workspace_id=m.workspace_id
      JOIN locations l ON l.id=m.location_id AND l.workspace_id=m.workspace_id
      WHERE m.workspace_id=$1 AND ($2::text IS NULL OR i.name ILIKE '%'||$2||'%'
        OR s.code ILIKE '%'||$2||'%' OR l.name ILIKE '%'||$2||'%'
        OR COALESCE(m.reference,'') ILIKE '%'||$2||'%')
      ORDER BY m.occurred_at DESC,m.seq DESC LIMIT 100`,[ctx.workspaceId,search])).rows.map((row)=>
      evidenceRow({product:row.product,sku:row.sku,location:row.location,operation:row.operation,
        change:Number(row.quantity_delta),balanceAfter:Number(row.balance_after),reference:row.reference||'',
        reason:row.reason_code||'',at:row.occurred_at},`/inventory/${row.item_id}`));
    return {answer:rows.length?`Showing ${rows.length}${rows.length===100?'+':''} recent recorded stock changes matching the request.`:
      'No recorded stock change matched that request.',rows,
      columns:['product','sku','location','operation','change','balanceAfter','reference','reason','at']};
  }
  if(request.view==='inventory_valuation'){
    const currency=(await database.query(`SELECT base_currency FROM accounting_settings
      WHERE workspace_id=$1 AND enabled=1`,[ctx.workspaceId])).rows[0]?.base_currency||'USD';
    const rows=(await database.query(`SELECT i.id AS item_id,i.name AS product,s.code AS sku,
      l.name AS location,b.quantity_units,b.total_cost_minor,b.updated_at,
      stock.on_hand
      FROM accounting_inventory_cost_balances b
      JOIN skus s ON s.id=b.sku_id AND s.workspace_id=b.workspace_id
      JOIN items i ON i.id=s.item_id AND i.workspace_id=b.workspace_id
      JOIN locations l ON l.id=b.location_id AND l.workspace_id=b.workspace_id
      LEFT JOIN balances stock ON stock.workspace_id=b.workspace_id
        AND stock.sku_id=b.sku_id AND stock.location_id=b.location_id
      WHERE b.workspace_id=$1 AND ($2::text IS NULL OR i.name ILIKE '%'||$2||'%'
        OR s.code ILIKE '%'||$2||'%' OR l.name ILIKE '%'||$2||'%')
      ORDER BY i.name,s.code,l.name LIMIT 100`,[ctx.workspaceId,search])).rows.map((row)=>
      evidenceRow({product:row.product,sku:row.sku,location:row.location,
        costedUnits:Number(row.quantity_units),onHand:row.on_hand===null?null:Number(row.on_hand),
        inventoryBookCost:pricing.formatMinor(Number(row.total_cost_minor),currency),
        averageRecordedUnitCost:row.quantity_units>0
          ?pricing.formatMinor(Math.round(Number(row.total_cost_minor)/Number(row.quantity_units)),currency):'Not available',
        valuedAt:row.updated_at},`/inventory/${row.item_id}`));
    return {answer:rows.length?`Showing recorded inventory book cost for ${rows.length}${rows.length===100?'+':''} product-location positions. This is not a current supplier quote.`:
      'No recorded inventory-cost position matched that request.',rows,
      columns:['product','sku','location','costedUnits','onHand','inventoryBookCost','averageRecordedUnitCost','valuedAt']};
  }
  if(request.view==='inventory_cost_movements'){
    const currency=(await database.query(`SELECT base_currency FROM accounting_settings
      WHERE workspace_id=$1 AND enabled=1`,[ctx.workspaceId])).rows[0]?.base_currency||'USD';
    const rows=(await database.query(`SELECT i.id AS item_id,i.name AS product,s.code AS sku,
      l.name AS location,cm.quantity_delta,cm.cost_delta_minor,cm.unit_cost_minor,
      cm.cost_source_type,cm.created_at,ip.source_name,ir.row_number,m.reference
      FROM accounting_inventory_cost_movements cm
      JOIN skus s ON s.id=cm.sku_id AND s.workspace_id=cm.workspace_id
      JOIN items i ON i.id=s.item_id AND i.workspace_id=cm.workspace_id
      JOIN locations l ON l.id=cm.location_id AND l.workspace_id=cm.workspace_id
      JOIN movements m ON m.id=cm.inventory_movement_id AND m.workspace_id=cm.workspace_id
      LEFT JOIN import_rows ir ON ir.id=cm.cost_source_record_id AND ir.workspace_id=cm.workspace_id
        AND cm.cost_source_type='opening_inventory'
      LEFT JOIN import_plans ip ON ip.id=ir.import_id AND ip.workspace_id=cm.workspace_id
      WHERE cm.workspace_id=$1 AND ($2::text IS NULL OR i.name ILIKE '%'||$2||'%'
        OR s.code ILIKE '%'||$2||'%' OR l.name ILIKE '%'||$2||'%'
        OR COALESCE(ip.source_name,'') ILIKE '%'||$2||'%'
        OR COALESCE(m.reference,'') ILIKE '%'||$2||'%')
      ORDER BY cm.created_at DESC,cm.id DESC LIMIT 100`,[ctx.workspaceId,search])).rows.map((row)=>
      evidenceRow({product:row.product,sku:row.sku,location:row.location,
        change:Number(row.quantity_delta),bookCostChange:pricing.formatMinor(Number(row.cost_delta_minor),currency),
        recordedUnitCost:row.unit_cost_minor===null?'Not recorded':pricing.formatMinor(Number(row.unit_cost_minor),currency),
        source:row.source_name?`Import ${row.source_name}, row ${row.row_number}`:row.cost_source_type,
        reference:row.reference||'',at:row.created_at},`/inventory/${row.item_id}`));
    return {answer:rows.length?`Showing ${rows.length}${rows.length===100?'+':''} recorded inventory-cost changes, including import row provenance where available.`:
      'No recorded inventory-cost change matched that request.',rows,
      columns:['product','sku','location','change','bookCostChange','recordedUnitCost','source','reference','at']};
  }
  if(request.view==='prices'){
    const rows=(await database.query(`SELECT i.id AS item_id,i.name AS product,s.code AS sku,
      COALESCE(s.variant_label,'') AS variant,p.amount_minor,p.currency,p.created_at
      FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
      LEFT JOIN LATERAL (SELECT amount_minor,currency,created_at FROM sku_prices
        WHERE workspace_id=s.workspace_id AND sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1) p ON true
      WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1
      AND ($2::text IS NULL OR i.name ILIKE '%'||$2||'%' OR s.code ILIKE '%'||$2||'%'
        OR COALESCE(s.variant_label,'') ILIKE '%'||$2||'%')
      ORDER BY i.name,s.code LIMIT 100`,[ctx.workspaceId,search])).rows.map((row)=>
      evidenceRow({product:row.product,sku:row.sku,variant:row.variant,
        sellingPrice:row.amount_minor===null?'Not recorded':pricing.formatMinor(Number(row.amount_minor),row.currency),
        priceRecordedAt:row.created_at||''},`/inventory/${row.item_id}`));
    return {answer:rows.length?`Showing current recorded selling prices for ${rows.length}${rows.length===100?'+':''} SKUs.`:
      'No product or SKU matched that price request.',rows,
      columns:['product','sku','variant','sellingPrice','priceRecordedAt']};
  }
  if(request.view==='purchase_costs'){
    const rows=(await database.query(`SELECT i.id AS item_id,i.name AS product,s.code AS sku,
      COALESCE(s.variant_label,'') AS variant,c.amount_minor,c.currency,c.created_at
      FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
      LEFT JOIN LATERAL (SELECT amount_minor,currency,created_at FROM sku_purchase_costs
        WHERE workspace_id=s.workspace_id AND sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1) c ON true
      WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1
      AND ($2::text IS NULL OR i.name ILIKE '%'||$2||'%' OR s.code ILIKE '%'||$2||'%'
        OR COALESCE(s.variant_label,'') ILIKE '%'||$2||'%')
      ORDER BY i.name,s.code LIMIT 100`,[ctx.workspaceId,search])).rows.map((row)=>
      evidenceRow({product:row.product,sku:row.sku,variant:row.variant,
        purchaseCost:row.amount_minor===null?'Not recorded':pricing.formatMinor(Number(row.amount_minor),row.currency),
        costRecordedAt:row.created_at||''},`/inventory/${row.item_id}`));
    return {answer:rows.length?`Showing current recorded purchase costs for ${rows.length}${rows.length===100?'+':''} SKUs.`:
      'No product or SKU matched that cost request.',rows,
      columns:['product','sku','variant','purchaseCost','costRecordedAt']};
  }
  if(request.view==='supplier_items'){
    const rows=(await database.query(`SELECT i.id AS item_id,i.name AS product,sku.code AS sku,
      supplier.name AS supplier,si.supplier_sku,si.last_unit_cost,si.last_cost_at,
      si.lead_time_days,si.is_preferred,si.purchase_unit,si.units_per_purchase_unit
      FROM supplier_items si JOIN suppliers supplier ON supplier.id=si.supplier_id AND supplier.workspace_id=si.workspace_id
      JOIN skus sku ON sku.id=si.sku_id AND sku.workspace_id=si.workspace_id
      JOIN items i ON i.id=sku.item_id AND i.workspace_id=si.workspace_id
      WHERE si.workspace_id=$1 AND si.is_active=1 AND supplier.status='active'
      AND ($2::text IS NULL OR i.name ILIKE '%'||$2||'%' OR sku.code ILIKE '%'||$2||'%'
        OR supplier.name ILIKE '%'||$2||'%')
      ORDER BY i.name,si.is_preferred DESC,supplier.name LIMIT 100`,[ctx.workspaceId,search])).rows.map((row)=>
      evidenceRow({product:row.product,sku:row.sku,supplier:row.supplier,
        supplierCode:row.supplier_sku||'',lastUnitCost:row.last_unit_cost===null?'Not recorded':Number(row.last_unit_cost),
        costRecordedAt:row.last_cost_at||'',leadTimeDays:row.lead_time_days===null?'Not recorded':Number(row.lead_time_days),
        preferred:Boolean(row.is_preferred),purchaseUnit:row.purchase_unit,
        unitsPerPurchaseUnit:Number(row.units_per_purchase_unit)},`/inventory/${row.item_id}`));
    return {answer:rows.length?`${rows.length}${rows.length===100?'+':''} active supplier-product relationships matched.`:
      'No active supplier-product relationship matched that request.',rows,
      columns:['product','sku','supplier','supplierCode','lastUnitCost','costRecordedAt','leadTimeDays','preferred','purchaseUnit','unitsPerPurchaseUnit']};
  }
  if(request.view==='messages'){
    const rows=(await database.query(`SELECT kind,recipient,subject,body,status,at FROM (
      SELECT 'sent supplier email' AS kind,recipient,subject,left(body,2000) AS body,status,
        COALESCE(sent_at,created_at) AS at,workspace_id FROM supplier_communications
      UNION ALL SELECT 'sent customer email',recipient,subject,left(body,2000),status,
        COALESCE(sent_at,created_at),workspace_id FROM customer_communications
      UNION ALL SELECT 'received business email',sender,subject,left(body_text,2000),reply_state,
        received_at,workspace_id FROM connection_email_messages
    ) mail WHERE workspace_id=$1 AND ($2::text IS NULL OR recipient ILIKE '%'||$2||'%'
      OR COALESCE(subject,'') ILIKE '%'||$2||'%') ORDER BY at DESC LIMIT 100`,
    [ctx.workspaceId,search])).rows.map((row)=>({kind:row.kind,party:row.recipient,subject:row.subject||'',
      message:row.body||'',status:row.status,at:row.at}));
    return {answer:rows.length?`Showing ${rows.length}${rows.length===100?'+':''} recorded business messages matching the request.`:
      'No recorded business message matched that request.',rows,
      columns:['kind','party','subject','message','status','at']};
  }
  if(['sales_activity','business_analysis'].includes(request.view)&&search)return {status:'CLARIFY',
    answer:'I cannot apply a named record filter to a business-wide summary. Ask me to show matching customer orders, or ask for the unfiltered summary.',
    rows:[],columns:[],reason:'unverified'};
  if(request.view==='sales_activity'&&request.timeframe==='unsupported')return {status:'CLARIFY',
    answer:'I cannot verify that time period from this summary. I can check all recorded time, today, this month, last month, or the last 30 days. Which would you like?',
    rows:[],columns:[],reason:'unverified'};
  if(request.view==='business_analysis'&&!['all_time','month_to_date'].includes(request.timeframe))return {status:'CLARIFY',
    answer:'This comparison covers this month to date against the same days last month. I cannot safely apply the period you named to this comparison.',
    rows:[],columns:[],reason:'unverified'};
  if(request.view==='sales_activity')return salesActivity(database,ctx,request.timeframe);
  if(request.view==='replenishment'){
    const overview=await autonomy.dashboard(database,ctx.workspaceId);
    const recommendations=overview.recent.filter((item)=>item.category==='replenishment_plan'
      &&['WAITING_FOR_APPROVAL','AUTHORIZED','EXECUTING'].includes(item.execution_status)).slice(0,12);
    const rows=recommendations.map((item)=>{
      const action=item.recommendedAction||{};
      return evidenceRow({product:action.displayName||action.code||'Product',quantity:action.quantity||0,
        supplier:action.supplierName||'Not selected',status:item.execution_status},`/autopilot/work/${item.id}`);
    });
    const answer=rows.length?`StockChief has ${rows.length} purchase ${rows.length===1?'recommendation':'recommendations'} in progress. The first is ${rows[0].quantity} ${rows[0].product} from ${rows[0].supplier}. Review the evidence before ordering.`:
      !overview.state.lastEvaluatedAt?'StockChief has not run its first business check, so there is no verified reorder recommendation yet. Run the first check on Home.':
        'StockChief has no open purchase recommendation from its latest check. That does not prove nothing should be bought; check stock rules and current demand before deciding.';
    return {answer,rows,columns:['product','quantity','supplier','status'],
      handoff:{href:rows.length?'/needs-you':'/',label:rows.length?'Review recommendations':'Open Home'}};
  }
  if(request.view==='general_knowledge'){
    let explained;
    try{explained=await evidenceAnswers.answer(options.provider,options.question||'',{},'general');}
    catch(error){if(error.code==='entitlement_required')throw error;
      return {status:'CLARIFY',answer:'I could not verify that answer just now. Nothing was changed. Please try again.',
        rows:[],columns:[],general:true,reason:'unavailable'};}
    return {status:explained.supported?'ANSWERED':'CLARIFY',answer:explained.answer,
      rows:[],columns:[],general:true,reason:explained.supported?null:'unverified'};
  }
  if(request.view==='business_analysis'){
    const scope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);
    const access=await entitlements.capabilityState(database,scope,'accounting.explanations');
    const evidence=await evidenceAnswers.businessEvidence(database,ctx.workspaceId,{includeFinancials:access.enabled});
    let explained;
    try{explained=await evidenceAnswers.answer(options.provider,options.question||'',evidence,'business');}
    catch(error){if(error.code==='entitlement_required')throw error;
      return {status:'CLARIFY',answer:'I could not verify an answer from the business records just now. Nothing was changed. Please try again.',
        rows:[],columns:[],reason:'unavailable'};}
    const rows=explained.evidenceKeys.map((key)=>{
      const fact=evidence[key];
      if(key==='customerOrders')return {measure:'Customer orders',value:`${fact.currentCount} this month; ${fact.priorComparableCount} in the comparable previous period; ${fact.openCount} open`};
      if(key==='lastBusinessCheck')return {measure:'Last business check',value:fact.at?`${fact.at}${fact.paused?' · paused':''}`:'Not run yet'};
      if(key==='availability')return {measure:'Financial analysis',value:fact.postedFinancialAnalysis};
      if(key.startsWith('postedFinancials'))return {measure:key==='postedFinancialsCurrent'?'Posted financials · this month':'Posted financials · previous comparable period',
        value:`Revenue ${pricing.formatMinor(fact.revenueMinor,fact.currency)}; net income ${pricing.formatMinor(fact.netIncomeMinor,fact.currency)}`};
      return null;
    }).filter(Boolean);
    const keys=new Set(explained.evidenceKeys);
    const handoff=keys.has('customerOrders')&&!['postedFinancialsCurrent','postedFinancialsPriorComparable'].some((key)=>keys.has(key))
      ?{href:'/orders',label:'Review customer orders'}
      :keys.has('postedFinancialsCurrent')||keys.has('postedFinancialsPriorComparable')
          ?{href:'/money',label:'Review financial records'}:null;
    return {status:explained.supported?'ANSWERED':'CLARIFY',answer:explained.answer,
      rows,columns:['measure','value'],handoff,reason:explained.supported?null:'unverified'};
  }
  if(request.view==='needs_you'){
    const [needs,state]=await Promise.all([projections.needs(database,ctx.workspaceId),autonomy.getState(database,ctx.workspaceId)]);
    const lastCheck=state.lastEvaluatedAt?Date.parse(state.lastEvaluatedAt):NaN;
    const checkMissing=!Number.isFinite(lastCheck);
    const checkStale=!checkMissing&&Date.now()-lastCheck>86400000;
    const rows=needs.slice(0,10).map((item)=>evidenceRow({decision:item.title,importance:item.importance,
      reason:item.why||item.happened||''},item.href));
    const answer=needs.length?`${needs.length} ${needs.length===1?'thing needs':'things need'} your attention. First: ${needs[0].title}.`:
      checkMissing?'No decisions are waiting yet, but StockChief has not run its first check. This is not an all-clear.':
      checkStale?'No decisions are waiting from the last check, but that check is over a day old. Run a fresh check for a current answer.':
        'Nothing needs your attention right now.';
    return {answer,rows,columns:['decision','importance','reason'],
      handoff:{href:needs.length?'/needs-you':'/',label:needs.length?'Review what needs you':'Open Home'}};
  }
  if(request.view==='inventory_summary'){
    const count=(await database.query(`SELECT
      (SELECT COUNT(*) FROM items WHERE workspace_id=$1 AND is_active=1) AS products,
      (SELECT COUNT(*) FROM items WHERE workspace_id=$1) AS products_ever,
      (SELECT COUNT(*) FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
        WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1) AS skus,
      (SELECT COALESCE(SUM(b.on_hand),0) FROM balances b
        JOIN skus s ON s.id=b.sku_id AND s.workspace_id=b.workspace_id
        JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
        WHERE b.workspace_id=$1 AND s.is_active=1 AND i.is_active=1) AS on_hand`,[ctx.workspaceId])).rows[0];
    const products=Number(count.products),productsEver=Number(count.products_ever),
      skus=Number(count.skus),onHand=Number(count.on_hand);
    const answer=productsEver===0?'No products have ever been recorded in StockChief; you have 0 units on hand.':
      `You have ${products.toLocaleString('en-US')} active ${products===1?'product':'products'} in StockChief, across ${skus.toLocaleString('en-US')} ${skus===1?'SKU':'SKUs'}, with ${onHand.toLocaleString('en-US')} units on hand.${productsEver>products?` ${productsEver.toLocaleString('en-US')} products have been recorded here over time.`:''}`;
    return {answer,
      rows:[{products,skus,onHand,productsEver}],columns:['products','skus','onHand','productsEver'],
      handoff:{href:'/inventory',label:'Open inventory'}};
  }
  if(request.view==='locations'){
    const rows=(await database.query(`SELECT l.id,l.name,l.kind,COALESCE(SUM(b.on_hand),0) AS units
      FROM locations l LEFT JOIN balances b ON b.location_id=l.id AND b.workspace_id=l.workspace_id
      WHERE l.workspace_id=$1 AND l.is_active=1 AND ($2::text IS NULL OR l.name ILIKE '%'||$2||'%')
      GROUP BY l.id ORDER BY l.name LIMIT 100`,[ctx.workspaceId,search])).rows.map((row)=>
      evidenceRow({name:row.name,kind:row.kind,units:Number(row.units)},`/inventory?location=${row.id}`));
    return {answer:rows.length?`${rows.length} active location${rows.length===1?'':'s'} hold ${rows.reduce((sum,row)=>sum+row.units,0).toLocaleString('en-US')} units.`:
      'No active location matched that request.',rows,columns:['name','kind','units']};
  }
  if(request.view==='transfers'){
    const rows=(await database.query(`SELECT t.id,t.transfer_number,t.status,
      source.name AS source_name,destination.name AS destination_name,
      COALESCE(SUM(line.requested_quantity),0) AS requested_units,
      COALESCE(SUM(line.approved_quantity),0) AS approved_units,
      COALESCE(SUM(line.picked_quantity),0) AS picked_units,
      COALESCE(SUM(line.shipped_quantity),0) AS shipped_units,
      COALESCE(SUM(line.received_quantity),0) AS received_units,
      COALESCE(SUM(line.lost_quantity),0) AS lost_units,
      COALESCE(SUM(line.damaged_quantity),0) AS damaged_units,
      COALESCE(SUM(line.shipped_quantity-line.received_quantity-line.lost_quantity-line.damaged_quantity),0)
        AS in_transit_units,
      COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT('sku',sku.code,'product',item.name,
        'requested',line.requested_quantity,'shipped',line.shipped_quantity,
        'received',line.received_quantity)) FILTER (WHERE line.id IS NOT NULL),'[]'::jsonb) AS products
      FROM inventory_transfers t
      JOIN locations source ON source.id=t.source_location_id AND source.workspace_id=t.workspace_id
      JOIN locations destination ON destination.id=t.destination_location_id AND destination.workspace_id=t.workspace_id
      LEFT JOIN inventory_transfer_lines line ON line.transfer_id=t.id AND line.workspace_id=t.workspace_id
      LEFT JOIN skus sku ON sku.id=line.sku_id AND sku.workspace_id=t.workspace_id
      LEFT JOIN items item ON item.id=sku.item_id AND item.workspace_id=t.workspace_id
      WHERE t.workspace_id=$1 AND ($2::text IS NULL OR t.transfer_number ILIKE '%'||$2||'%'
        OR t.status ILIKE '%'||$2||'%' OR source.name ILIKE '%'||$2||'%'
        OR destination.name ILIKE '%'||$2||'%')
      GROUP BY t.id,source.name,destination.name ORDER BY t.created_at DESC LIMIT 100`,
    [ctx.workspaceId,search])).rows.map((row)=>{
      const heldAtSource=['APPROVED','PICKED'].includes(row.status)?Number(row.approved_units):0;
      return evidenceRow({transfer:row.transfer_number,status:row.status,
        source:row.source_name,destination:row.destination_name,
        requestedUnits:Number(row.requested_units),heldAtSource,
        pickedUnits:Number(row.picked_units),departedUnits:Number(row.shipped_units),
        inTransitUnits:Number(row.in_transit_units),receivedUnits:Number(row.received_units),
        lostUnits:Number(row.lost_units),damagedUnits:Number(row.damaged_units),products:row.products},
      `/transfers/${row.id}`);
    });
    const answer=rows.length===1?`${rows[0].transfer} is ${rows[0].status.toLowerCase().replace(/_/g,' ')}: `+
      `${rows[0].heldAtSource} held at ${rows[0].source}, ${rows[0].departedUnits} departed, `+
      `${rows[0].inTransitUnits} in transit, ${rows[0].receivedUnits} received at ${rows[0].destination}.`:
      rows.length?`${rows.length} tracked transfers matched; ${rows.reduce((sum,row)=>sum+row.inTransitUnits,0)} units are in transit.`:
        'No tracked inventory transfer matched that request.';
    return {answer,rows,columns:['transfer','status','source','destination','requestedUnits',
      'heldAtSource','pickedUnits','departedUnits','inTransitUnits','receivedUnits',
      'lostUnits','damagedUnits','products']};
  }
  if(request.view==='customer_returns'){
    const rows=(await database.query(`SELECT r.id,r.return_number,r.status,r.resolution,
      so.order_number,c.name AS customer,q.name AS quarantine_location,
      COALESCE(lines.authorized_units,0) AS authorized_units,
      COALESCE(lines.received_units,0) AS received_units,
      COALESCE(lines.restocked_units,0) AS restocked_units,
      COALESCE(lines.scrapped_units,0) AS scrapped_units,
      COALESCE(lines.repair_units,0) AS repair_units,
      refund.destination AS refund_destination,
      COALESCE(refund.revenue_minor,0)+COALESCE(refund.tax_minor,0) AS refund_minor,
      so.currency
      FROM customer_returns r
      JOIN sales_orders so ON so.id=r.sales_order_id AND so.workspace_id=r.workspace_id
      JOIN customers c ON c.id=so.customer_id AND c.workspace_id=r.workspace_id
      JOIN locations q ON q.id=r.quarantine_location_id AND q.workspace_id=r.workspace_id
      LEFT JOIN accounting_sale_refunds refund ON refund.id=r.refund_id AND refund.workspace_id=r.workspace_id
      LEFT JOIN LATERAL (SELECT SUM(quantity_authorized) AS authorized_units,
        SUM(quantity_received) AS received_units,SUM(quantity_restocked) AS restocked_units,
        SUM(quantity_scrapped) AS scrapped_units,SUM(quantity_repair) AS repair_units
        FROM customer_return_lines WHERE workspace_id=r.workspace_id AND customer_return_id=r.id) lines ON true
      WHERE r.workspace_id=$1 AND ($2::text IS NULL OR r.return_number ILIKE '%'||$2||'%'
        OR so.order_number ILIKE '%'||$2||'%' OR c.name ILIKE '%'||$2||'%'
        OR r.status ILIKE '%'||$2||'%') ORDER BY r.created_at DESC LIMIT 100`,
    [ctx.workspaceId,search])).rows.map((row)=>evidenceRow({return:row.return_number,
      status:row.status,resolution:row.resolution,customer:row.customer,order:row.order_number,
      quarantineLocation:row.quarantine_location,authorizedUnits:Number(row.authorized_units),
      physicallyReceivedUnits:Number(row.received_units),restockedUnits:Number(row.restocked_units),
      scrappedUnits:Number(row.scrapped_units),repairUnits:Number(row.repair_units),
      refundDestination:row.refund_destination||null,
      postedRefundOrCredit:row.refund_destination?pricing.formatMinor(Number(row.refund_minor),row.currency):null,
      cashReturned:row.refund_destination==='CASH',
      unpaidInvoiceCredited:row.refund_destination==='AR'},`/returns/${row.id}`));
    const answer=rows.length===1?`${rows[0].return} is ${rows[0].status.toLowerCase().replace(/_/g,' ')}: `+
      `${rows[0].authorizedUnits} authorized, ${rows[0].physicallyReceivedUnits} physically received, `+
      `${rows[0].restockedUnits} restocked. `+
      (rows[0].refundDestination==='CASH'?`${rows[0].postedRefundOrCredit} cash refund recorded.`:
        rows[0].refundDestination==='AR'?`${rows[0].postedRefundOrCredit} unpaid-invoice credit recorded; no cash returned.`:
          'No refund or invoice credit posted.'):
      rows.length?`${rows.length} customer returns matched.`:'No customer return matched that request.';
    return {answer,rows,columns:['return','status','resolution','customer','order',
      'quarantineLocation','authorizedUnits','physicallyReceivedUnits','restockedUnits',
      'scrappedUnits','repairUnits','refundDestination','postedRefundOrCredit',
      'cashReturned','unpaidInvoiceCredited']};
  }
  if(request.view==='purchase_orders'){
    const rows=(await database.query(`SELECT po.id,po.po_number,po.status,po.currency,s.name AS supplier,
      COALESCE(SUM(pol.quantity_units),0) AS ordered_units,
      COALESCE(SUM(pol.quantity_received_units),0) AS received_units,
      COALESCE(SUM(pol.quantity_units-pol.quantity_received_units),0) AS outstanding_units,
      COALESCE(SUM(pol.line_total),0) AS total_amount,
      COUNT(pol.id) FILTER (WHERE pol.unit_cost IS NULL) AS unpriced_lines,
      COALESCE(bills.invoice_count,0) AS invoice_count,
      COALESCE(bills.disputed_count,0) AS disputed_count,
      COALESCE(bills.invoice_documents_minor,0) AS invoice_documents_minor,
      COALESCE(bills.posted_payable_minor,0) AS posted_payable_minor,
      bills.invoice_documents
      FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id AND s.workspace_id=po.workspace_id
      LEFT JOIN purchase_order_lines pol ON pol.purchase_order_id=po.id AND pol.workspace_id=po.workspace_id
      LEFT JOIN LATERAL (SELECT COUNT(*)::int AS invoice_count,
        COUNT(*) FILTER (WHERE status='DISPUTED')::int AS disputed_count,
        SUM(total_minor) AS invoice_documents_minor,
        SUM(CASE WHEN status IN ('OPEN','PARTIALLY_PAID') THEN balance_minor ELSE 0 END) AS posted_payable_minor,
        (SELECT JSONB_AGG(JSONB_BUILD_OBJECT('number',latest.supplier_invoice_number,
          'status',latest.status,'match',latest.match_status,'total',latest.total_minor,
          'owed',latest.balance_minor,'exceptions',latest.exception_detail::jsonb->'differences'))
          FROM (SELECT supplier_invoice_number,status,match_status,total_minor,balance_minor,exception_detail
            FROM accounting_supplier_bills WHERE workspace_id=po.workspace_id
              AND purchase_order_id=po.id AND status<>'VOID'
            ORDER BY created_at DESC,id DESC LIMIT 10) latest) AS invoice_documents
        FROM accounting_supplier_bills bill WHERE bill.workspace_id=po.workspace_id
          AND bill.purchase_order_id=po.id AND bill.status<>'VOID') bills ON true
      WHERE po.workspace_id=$1 AND ($2::text IS NULL OR po.po_number ILIKE '%'||$2||'%' OR s.name ILIKE '%'||$2||'%'
        OR po.status ILIKE '%'||$2||'%') GROUP BY po.id,s.name,bills.invoice_count,bills.disputed_count,
        bills.invoice_documents_minor,bills.posted_payable_minor,bills.invoice_documents
      ORDER BY po.created_at DESC LIMIT 100`,
    [ctx.workspaceId,search])).rows.map((row)=>{
      const documents=Array.isArray(row.invoice_documents)?row.invoice_documents:[];
      const invoiceDocuments=documents.map((invoice)=>{
        const exceptions=Array.isArray(invoice.exceptions)?invoice.exceptions.map((entry)=>entry.kind).filter(Boolean):[];
        return `${invoice.number||'Unnumbered invoice'} ${String(invoice.status).toLowerCase()} `+
          `${pricing.formatMinor(Number(invoice.total),row.currency)} document, `+
          `${pricing.formatMinor(Number(invoice.owed),row.currency)} balance`+
          (exceptions.length?`; exceptions: ${exceptions.join(', ')}`:'');
      });
      return evidenceRow({order:row.po_number,status:row.status,supplier:row.supplier,
      orderedUnits:Number(row.ordered_units),receivedUnits:Number(row.received_units),
      outstandingUnits:Number(row.outstanding_units),currency:row.currency,
      total:Number(row.unpriced_lines)?null:pricing.formatMinor(Math.round(Number(row.total_amount)*100),row.currency),
      unpricedLines:Number(row.unpriced_lines),invoiceCount:Number(row.invoice_count),
      disputedInvoiceCount:Number(row.disputed_count),
      invoiceDocumentsReceived:pricing.formatMinor(Number(row.invoice_documents_minor),row.currency),
      postedPayable:pricing.formatMinor(Number(row.posted_payable_minor),row.currency),
      invoiceDocuments,invoiceDocumentsTruncated:Number(row.invoice_count)>invoiceDocuments.length},
      `/purchasing/orders/${row.id}`);
    });
    const answer=rows.length===1?`${rows[0].order} is ${rows[0].status.toLowerCase().replace(/_/g,' ')}: `+
      `${rows[0].orderedUnits} ordered, ${rows[0].receivedUnits} received, ${rows[0].outstandingUnits} still expected; `+
      `total ${rows[0].total===null?'not fully priced':rows[0].total}; `+
      `${rows[0].invoiceCount} supplier invoice${rows[0].invoiceCount===1?'':'s'} recorded, `+
      `${rows[0].postedPayable} posted payable.`:
      rows.length?`${rows.length} purchase orders matched; ${rows.reduce((sum,row)=>sum+row.outstandingUnits,0).toLocaleString('en-US')} units remain outstanding.`:
        'No purchase order matched that request.';
    return {answer,rows,columns:['order','status','supplier','orderedUnits','receivedUnits',
      'outstandingUnits','total','currency','unpricedLines','invoiceCount','disputedInvoiceCount',
      'invoiceDocumentsReceived','postedPayable','invoiceDocuments','invoiceDocumentsTruncated']};
  }
  if(request.view==='sales_orders'){
    const rows=(await database.query(`SELECT so.id,so.order_number,so.status,so.currency,c.name AS customer,
      COALESCE(lines.ordered_units,0) AS ordered_units,
      COALESCE(lines.fulfilled_units,0) AS fulfilled_units,
      COALESCE(lines.line_count,0) AS line_count,
      COALESCE(lines.order_total_minor,0) AS order_total_minor,
      COALESCE(lines.line_items_json,'[]'::json) AS line_items_json,
      COALESCE(lines.ordered_units,0)-COALESCE(lines.fulfilled_units,0) AS open_units,
      COALESCE(held.units,0) AS held_units,COALESCE(invoices.invoice_count,0) AS invoice_count,
      COALESCE(invoices.invoiced_minor,0) AS invoiced_minor,
      COALESCE(invoices.outstanding_minor,0) AS outstanding_minor,
      COALESCE(payments.paid_minor,0) AS paid_minor,
      COALESCE(posted.revenue_minor,0) AS posted_revenue_minor,
      COALESCE(posted.cogs_minor,0) AS posted_cogs_minor,
      COALESCE(shipments.shipment_count,0) AS shipment_count
      FROM sales_orders so JOIN customers c ON c.id=so.customer_id AND c.workspace_id=so.workspace_id
      LEFT JOIN LATERAL (SELECT SUM(sol.quantity_ordered) AS ordered_units,
        SUM(sol.quantity_fulfilled) AS fulfilled_units,COUNT(*)::int AS line_count,
        SUM(sol.quantity_ordered*sol.unit_price_minor) AS order_total_minor,
        JSON_AGG(JSON_BUILD_OBJECT('sku',sku.code,'product',item.name,
          'quantity',sol.quantity_ordered,'unitPriceMinor',sol.unit_price_minor,
          'lineTotalMinor',sol.quantity_ordered*sol.unit_price_minor) ORDER BY sol.id) AS line_items_json
        FROM sales_order_lines sol
        JOIN skus sku ON sku.id=sol.sku_id AND sku.workspace_id=sol.workspace_id
        JOIN items item ON item.id=sku.item_id AND item.workspace_id=sku.workspace_id
        WHERE sol.workspace_id=so.workspace_id AND sol.sales_order_id=so.id) lines ON true
      LEFT JOIN LATERAL (SELECT SUM(a.quantity) AS units FROM sales_order_allocations a
        JOIN sales_order_lines sol ON sol.id=a.sales_order_line_id AND sol.workspace_id=a.workspace_id
        WHERE a.workspace_id=so.workspace_id AND sol.sales_order_id=so.id) held ON true
      LEFT JOIN LATERAL (SELECT COUNT(*)::int AS invoice_count,SUM(total_minor) AS invoiced_minor,
        SUM(balance_minor) AS outstanding_minor FROM accounting_customer_invoices
        WHERE workspace_id=so.workspace_id AND sales_order_id=so.id
          AND status IN ('OPEN','PARTIALLY_PAID','PAID')) invoices ON true
      LEFT JOIN LATERAL (SELECT SUM(a.amount_minor) AS paid_minor
        FROM accounting_payment_allocations a
        JOIN accounting_customer_invoices inv ON inv.id=a.customer_invoice_id AND inv.workspace_id=a.workspace_id
        JOIN accounting_payments pay ON pay.id=a.payment_id AND pay.workspace_id=a.workspace_id
        WHERE a.workspace_id=so.workspace_id AND inv.sales_order_id=so.id AND pay.status='POSTED') payments ON true
      LEFT JOIN LATERAL (SELECT
        SUM(CASE WHEN acct.system_key='SALES_REVENUE' THEN line.credit_minor-line.debit_minor ELSE 0 END) AS revenue_minor,
        SUM(CASE WHEN acct.system_key='COST_OF_GOODS_SOLD' THEN line.debit_minor-line.credit_minor ELSE 0 END) AS cogs_minor
        FROM accounting_journal_entries entry
        JOIN accounting_journal_lines line ON line.entry_id=entry.id AND line.workspace_id=entry.workspace_id
        JOIN accounting_accounts acct ON acct.id=line.account_id AND acct.workspace_id=line.workspace_id
        WHERE entry.workspace_id=so.workspace_id AND entry.source_record_type='sales_order'
          AND entry.source_record_id=so.id AND entry.source_type='sale_fulfillment'
          AND entry.status='POSTED') posted ON true
      LEFT JOIN LATERAL (SELECT COUNT(*)::int AS shipment_count FROM sales_shipments
        WHERE workspace_id=so.workspace_id AND sales_order_id=so.id) shipments ON true
      WHERE so.workspace_id=$1 AND ($2::text IS NULL OR so.order_number ILIKE '%'||$2||'%' OR c.name ILIKE '%'||$2||'%'
        OR so.status ILIKE '%'||$2||'%') ORDER BY so.created_at DESC LIMIT 100`,
    [ctx.workspaceId,search])).rows.map((row)=>evidenceRow({order:row.order_number,status:row.status,customer:row.customer,
      orderedUnits:Number(row.ordered_units),heldUnits:Number(row.held_units),
      fulfilledUnits:Number(row.fulfilled_units),openUnits:Number(row.open_units),
      lineCount:Number(row.line_count),orderTotal:pricing.formatMinor(Number(row.order_total_minor),row.currency),
      lineItems:(Array.isArray(row.line_items_json)?row.line_items_json:[]).map((line)=>
        `${line.quantity} × ${line.sku} ${line.product} at ${pricing.formatMinor(Number(line.unitPriceMinor),row.currency)} each = `+
        pricing.formatMinor(Number(line.lineTotalMinor),row.currency)).join('; '),
      invoiceCount:Number(row.invoice_count),invoiced:pricing.formatMinor(Number(row.invoiced_minor),row.currency),
      paid:pricing.formatMinor(Number(row.paid_minor),row.currency),
      outstanding:pricing.formatMinor(Number(row.outstanding_minor),row.currency),
      postedRevenue:pricing.formatMinor(Number(row.posted_revenue_minor),row.currency),
      postedProductCost:pricing.formatMinor(Number(row.posted_cogs_minor),row.currency),
      postedGrossProfit:pricing.formatMinor(Number(row.posted_revenue_minor)-Number(row.posted_cogs_minor),row.currency),
      shipments:Number(row.shipment_count)},`/orders/${row.id}`));
    return {answer:rows.length?`${rows.length===100?'Showing the first 100':rows.length} customer order${rows.length===1?'':'s'} ${search?'matched':'recorded'}; ${rows.reduce((sum,row)=>sum+row.openUnits,0).toLocaleString('en-US')} units remain open.`:
      search?'No customer order matched that request.':'No customer orders are recorded in StockChief. Sales through systems that are not connected or imported here would not appear in this list.',
      rows,columns:['order','status','customer','lineCount','lineItems','orderTotal',
        'orderedUnits','heldUnits','fulfilledUnits','openUnits',
        'invoiceCount','invoiced','paid','outstanding','postedRevenue','postedProductCost',
        'postedGrossProfit','shipments']};
  }
  if(['suppliers','customers'].includes(request.view)){
    const supplier=request.view==='suppliers';
    const table=supplier?'suppliers':'customers';
    const state=supplier?"status='active'":"record_state<>'ARCHIVED'";
    const result=await database.query(`SELECT id,name,email,phone FROM ${table} WHERE workspace_id=$1 AND ${state}
      AND ($2::text IS NULL OR name ILIKE '%'||$2||'%' OR COALESCE(email,'') ILIKE '%'||$2||'%') ORDER BY name LIMIT 100`,
    [ctx.workspaceId,search]);
    const rows=result.rows.map((row)=>evidenceRow({name:row.name,email:row.email || 'Not recorded',phone:row.phone || 'Not recorded'},
      supplier?`/suppliers/${row.id}`:`/sales/customers/${row.id}`));
    return {answer:rows.length?`${rows.length} ${supplier?'supplier':'customer'}${rows.length===1?'':'s'} matched.`:
      `No ${supplier?'supplier':'customer'} matched that request.`,rows,columns:['name','email','phone']};
  }
  if(request.view==='shipping'){
    const rows=(await database.query(`SELECT sh.id,sh.shipment_number,sh.status,sh.carrier,sh.tracking_number,so.order_number
      FROM sales_shipments sh JOIN sales_orders so ON so.id=sh.sales_order_id WHERE sh.workspace_id=$1
      AND ($2::text IS NULL OR sh.shipment_number ILIKE '%'||$2||'%' OR COALESCE(sh.tracking_number,'') ILIKE '%'||$2||'%'
        OR so.order_number ILIKE '%'||$2||'%' OR sh.status ILIKE '%'||$2||'%') ORDER BY sh.created_at DESC LIMIT 100`,
    [ctx.workspaceId,search])).rows.map((row)=>evidenceRow({shipment:row.shipment_number,order:row.order_number,status:row.status,
      carrier:row.carrier || 'Not chosen',tracking:row.tracking_number || 'Not assigned'},`/fulfilment/${row.id}`));
    return {answer:rows.length?`${rows.length} shipment${rows.length===1?'':'s'} matched.`:'No shipment matched that request.',
      rows,columns:['shipment','order','status','carrier','tracking']};
  }
  if(request.view==='connections'){
    const rows=(await database.query(`SELECT id,display_name,status,last_synced_at,last_error FROM workspace_connectors
      WHERE workspace_id=$1 AND ($2::text IS NULL OR display_name ILIKE '%'||$2||'%' OR connector_key ILIKE '%'||$2||'%')
      ORDER BY display_name LIMIT 100`,[ctx.workspaceId,search])).rows.map((row)=>evidenceRow({name:row.display_name,status:row.status,
      lastSynced:row.last_synced_at || 'Never',error:row.last_error || ''},`/settings/connections/${row.id}`));
    const unhealthy=rows.filter((row)=>row.status!=='connected').length;
    return {answer:rows.length?`${rows.length-unhealthy} of ${rows.length} connection${rows.length===1?' is':'s are'} connected.`:
      'No connections are configured.',rows,columns:['name','status','lastSynced','error']};
  }
  if(request.view==='accounting'){
    if(search==='profit_change')return explainProfitChange(database,ctx);
    if(search==='profit_and_loss'){
      const report=await accountingReports.profitAndLoss(database,ctx.workspaceId);
      const money=(minor)=>pricing.formatMinor(Number(minor||0),report.currency);
      const result=Number(report.netIncomeMinor);
      const recorded=Number(report.revenueMinor)||Number(report.cogsMinor)||Number(report.operatingExpenseMinor);
      const outcome=result<0?`Recorded activity shows a net loss of ${money(Math.abs(result))} this month.`:
        result>0?`Recorded activity shows net income of ${money(result)} this month.`:
          recorded?'Recorded income and expenses net to zero so far this month.':
            'No income or expenses are recorded in StockChief for this month.';
      const rows=[
        {measure:'Revenue',value:money(report.revenueMinor)},
        {measure:'Cost of goods sold',value:money(report.cogsMinor)},
        {measure:'Operating expenses',value:money(report.operatingExpenseMinor)},
        {measure:'Net income',value:money(report.netIncomeMinor)},
      ];
      return {answer:`${outcome} Revenue is ${money(report.revenueMinor)}, cost of goods sold is ${money(report.cogsMinor)}, and operating expenses are ${money(report.operatingExpenseMinor)} for ${report.from} through ${report.to}.`,
        rows,columns:['measure','value']};
    }
    const result=(await database.query(`SELECT COUNT(DISTINCT e.id) FILTER (WHERE e.status='POSTED') AS posted,
      COALESCE(SUM(debit_minor),0) AS debits,COALESCE(SUM(credit_minor),0) AS credits
      FROM accounting_journal_entries e LEFT JOIN accounting_journal_lines l ON l.entry_id=e.id
      WHERE e.workspace_id=$1`,[ctx.workspaceId])).rows[0];
    const rows=[{measure:'Posted journal entries',value:Number(result.posted)},{measure:'Debits',value:Number(result.debits)},
      {measure:'Credits',value:Number(result.credits)}];
    return {answer:`The posted journal contains ${Number(result.posted).toLocaleString('en-US')} entries. Debits and credits are ${Number(result.debits)===Number(result.credits)?'balanced':'not balanced'}.`,
      rows,columns:['measure','value']};
  }
  if(request.view==='payments'){
    const rows=(await database.query(`SELECT p.id,p.direction,p.amount_minor,p.currency,p.status,p.payment_date,
      COALESCE(c.name,s.name,'Unassigned') AS party FROM accounting_payments p
      LEFT JOIN customers c ON c.id=p.customer_id LEFT JOIN suppliers s ON s.id=p.supplier_id
      WHERE p.workspace_id=$1 AND ($2::text IS NULL OR COALESCE(c.name,s.name,'') ILIKE '%'||$2||'%'
        OR p.status ILIKE '%'||$2||'%') ORDER BY p.payment_date DESC,p.created_at DESC LIMIT 100`,
    [ctx.workspaceId,search])).rows.map((row)=>evidenceRow({party:row.party,direction:row.direction,status:row.status,
      amount:Number(row.amount_minor),currency:row.currency,date:row.payment_date},`/accounting/payments/${row.id}`));
    return {answer:rows.length?`${rows.length} payment record${rows.length===1?'':'s'} matched.`:'No payment matched that request.',
      rows,columns:['party','direction','status','amount','currency','date']};
  }
  if(['payables','receivables'].includes(request.view)){
    const payable=request.view==='payables';const table=payable?'accounting_supplier_bills':'accounting_customer_invoices';
    const parties=payable?'suppliers':'customers';const partyKey=payable?'supplier_id':'customer_id';
    const documentColumn=payable?'bill_number':'invoice_number';const href=payable?'/accounting/payables':'/accounting/receivables';
    const result=await database.query(`SELECT d.id,d.${documentColumn} AS document,d.status,d.due_date,d.currency,
      d.balance_minor,p.name AS party FROM ${table} d JOIN ${parties} p ON p.id=d.${partyKey}
      WHERE d.workspace_id=$1 AND d.status IN ('OPEN','PARTIALLY_PAID') AND d.balance_minor>0
      AND ($2::text IS NULL OR p.name ILIKE '%'||$2||'%' OR d.${documentColumn} ILIKE '%'||$2||'%')
      ORDER BY COALESCE(d.due_date,'9999-12-31'),d.created_at DESC LIMIT 100`,[ctx.workspaceId,search]);
    const rows=result.rows.map((row)=>evidenceRow({party:row.party,document:row.document,status:row.status,
      due:row.due_date||'Not set',balance:pricing.formatMinor(Number(row.balance_minor),row.currency),
      balanceMinor:Number(row.balance_minor),currency:row.currency},href));
    const totals=new Map();for(const row of result.rows)totals.set(row.currency,(totals.get(row.currency)||0)+Number(row.balance_minor));
    const totalText=[...totals.entries()].map(([currency,amount])=>`${pricing.formatMinor(amount,currency)} ${currency}`).join(' and ');
    const noun=payable?'open supplier bill':'open customer invoice';
    const answer=rows.length
      ?`${payable?'We currently owe suppliers':'Customers currently owe us'} ${totalText} across ${rows.length} ${noun}${rows.length===1?'':'s'}.`
      :payable?'We currently owe suppliers nothing on open bills.':'Customers currently owe us nothing on open invoices.';
    return {answer,rows,columns:['party','document','status','due','balance','currency']};
  }
  const rows=(await database.query(`WITH committed AS (
      SELECT sol.sku_id,SUM(a.quantity) AS quantity FROM sales_order_allocations a
      JOIN sales_order_lines sol ON sol.id=a.sales_order_line_id WHERE a.workspace_id=$1 GROUP BY sol.sku_id
    ), purchase_incoming AS (
      SELECT pol.sku_id,SUM(pol.quantity_units-pol.quantity_received_units) AS quantity FROM purchase_order_lines pol
      JOIN purchase_orders po ON po.id=pol.purchase_order_id WHERE pol.workspace_id=$1
      AND po.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED') GROUP BY pol.sku_id
    ), transfer_incoming AS (
      SELECT tl.sku_id,SUM(CASE t.status WHEN 'REQUESTED' THEN tl.requested_quantity
        WHEN 'APPROVED' THEN tl.approved_quantity WHEN 'PICKED' THEN tl.picked_quantity
        ELSE tl.shipped_quantity-tl.received_quantity-tl.lost_quantity-tl.damaged_quantity END) AS quantity
      FROM inventory_transfer_lines tl JOIN inventory_transfers t ON t.id=tl.transfer_id
      WHERE tl.workspace_id=$1 AND t.status IN ('REQUESTED','APPROVED','PICKED','SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED')
      GROUP BY tl.sku_id
    ), costed AS (
      SELECT sku_id,SUM(quantity_units) AS quantity FROM accounting_inventory_cost_balances
      WHERE workspace_id=$1 GROUP BY sku_id
    ), incoming AS (
      SELECT sku_id,SUM(quantity) AS quantity FROM (
        SELECT * FROM purchase_incoming UNION ALL SELECT * FROM transfer_incoming
      ) sources GROUP BY sku_id)
    SELECT i.id,i.name,s.code,s.variant_label,COALESCE(SUM(b.on_hand),0) AS on_hand,
      COALESCE(c.quantity,0) AS committed,COALESCE(inc.quantity,0) AS incoming,
      COALESCE(costed.quantity,0) AS costed_units,
      COALESCE(STRING_AGG(DISTINCT l.name, ', ') FILTER (WHERE b.on_hand<>0),'') AS locations
    FROM items i JOIN skus s ON s.item_id=i.id LEFT JOIN balances b ON b.sku_id=s.id
    LEFT JOIN locations l ON l.id=b.location_id AND l.workspace_id=b.workspace_id
    LEFT JOIN committed c ON c.sku_id=s.id LEFT JOIN incoming inc ON inc.sku_id=s.id
    LEFT JOIN costed ON costed.sku_id=s.id
    WHERE i.workspace_id=$1 AND i.is_active=1 AND ($2::text IS NULL OR i.name ILIKE ANY($3::text[])
      OR s.code ILIKE ANY($3::text[]) OR COALESCE(s.variant_label,'') ILIKE ANY($3::text[]))
    GROUP BY i.id,s.id,c.quantity,inc.quantity,costed.quantity ORDER BY i.name,s.position LIMIT 100`,
  [ctx.workspaceId,search,lookupSearchPatterns(search)])).rows.map((row)=>{
      const onHand=Number(row.on_hand),committed=Number(row.committed),incoming=Number(row.incoming),
        costedUnits=Number(row.costed_units);
      return evidenceRow({product:row.variant_label?`${row.name} · ${row.variant_label}`:row.name,sku:row.code,
        onHand,committed,available:Math.max(0,onHand-committed),incoming,costedUnits,
        unitsMissingCost:Math.max(0,onHand-costedUnits),locations:row.locations||'No stock location'},`/inventory/${row.id}`);
    });
  const totals=rows.reduce((sum,row)=>({onHand:sum.onHand+row.onHand,committed:sum.committed+row.committed,
    available:sum.available+row.available,incoming:sum.incoming+row.incoming}),{onHand:0,committed:0,available:0,incoming:0});
  const places=[...new Set(rows.flatMap((row)=>row.locations==='No stock location'?[]:row.locations.split(', ')))];
  const where=places.length?` Stock is in ${places.join(', ')}.`:'';
  const missingCost=rows.reduce((sum,row)=>sum+row.unitsMissingCost,0);
  const costWarning=missingCost?` ${missingCost} on-hand units have no recorded inventory cost and cannot be posted as a sale until their cost is established.`:'';
  return {answer:rows.length?`${rows.length} SKU${rows.length===1?'':'s'} matched with ${totals.onHand.toLocaleString('en-US')} units on hand, ${totals.committed.toLocaleString('en-US')} committed, ${totals.available.toLocaleString('en-US')} available and ${totals.incoming.toLocaleString('en-US')} incoming.${where}${costWarning}`:
    'No product or SKU matched that request.',rows,columns:['product','sku','onHand','committed','available','incoming','costedUnits','unitsMissingCost','locations']};
}

const MATCH_NOTHING=new Set(['the','our','my','this','that','some','item','items','product','products','unit','units']);
function matchTerms(value){
  const words=String(value||'').toLowerCase().split(/[^a-z0-9]+/).filter((word)=>word.length>=2)
    .map((word)=>word.length>3&&word.endsWith('s')&&!word.endsWith('ss')?word.slice(0,-1):word);
  const meaningful=words.filter((word)=>!MATCH_NOTHING.has(word));
  return (meaningful.length?meaningful:words).slice(0,8);
}

async function resolveOne(database,table,workspaceId,search,columns) {
  if(!search)return {missing:true};
  const allowed={skus:{select:`s.id,s.code,i.name,s.variant_label,i.tracking_mode`,from:'skus s JOIN items i ON i.id=s.item_id',
    scope:`s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1`,search:`CONCAT_WS(' ',s.code,i.name,COALESCE(s.variant_label,''))`,
    exact:`(lower(s.code)=lower($2) OR lower(i.name)=lower($2))`},
  locations:{select:'id,name,kind',from:'locations',scope:`workspace_id=$1 AND is_active=1`,search:'name',
    exact:`lower(name)=lower($2)`}};
  const target=allowed[table];
  if(!target)throw new TypeError('Unsupported resolution target.');
  const exact=await database.query(`SELECT ${target.select} FROM ${target.from} WHERE ${target.scope}
    AND ${target.exact} ORDER BY ${columns} LIMIT 12`,[workspaceId,search]);
  if(exact.rows.length===1)return {row:exact.rows[0]};
  const broad=exact.rows.length?exact:await database.query(`SELECT ${target.select} FROM ${target.from}
    WHERE ${target.scope} AND ${target.search} ILIKE $2 ORDER BY ${columns} LIMIT 12`,[workspaceId,`%${search}%`]);
  if(broad.rows.length===1)return {row:broad.rows[0]};
  if(broad.rows.length)return {ambiguous:broad.rows};
  const terms=matchTerms(search);
  if(!terms.length)return {notFound:true};
  const tokenMatches=await database.query(`SELECT ${target.select} FROM ${target.from} WHERE ${target.scope}
    AND ${terms.map((_,index)=>`${target.search} ILIKE $${index+2}`).join(' AND ')} ORDER BY ${columns} LIMIT 12`,
  [workspaceId,...terms.map((term)=>`%${term}%`)]);
  if(tokenMatches.rows.length===1)return {row:tokenMatches.rows[0]};
  return tokenMatches.rows.length?{ambiguous:tokenMatches.rows}:{notFound:true};
}

async function resolveRequestedSku(database,workspaceId,request){
  if(request.sku)return resolveOne(database,'skus',workspaceId,request.sku,'i.name,s.position');
  if(request.skuReference!=='stocked')return {missing:true};
  const rows=(await database.query(`SELECT s.id,s.code,i.name,s.variant_label,i.tracking_mode,
    SUM(b.on_hand) AS stocked_units
    FROM balances b JOIN skus s ON s.id=b.sku_id AND s.workspace_id=b.workspace_id
      JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    WHERE b.workspace_id=$1 AND b.on_hand>0 AND s.is_active=1 AND i.is_active=1
    GROUP BY s.id,s.code,i.name,s.variant_label,i.tracking_mode
    ORDER BY lower(i.name),s.code LIMIT 12`,[workspaceId])).rows;
  if(rows.length===1)return {row:rows[0],fromCurrentStock:true};
  if(rows.length>1)return {ambiguous:rows,fromCurrentStock:true};
  return {stockEmpty:true};
}

async function resolvePurchaseSupplier(database,workspaceId,skuId,supplierName){
  if(supplierName)return resolveParty(database,'supplier',workspaceId,supplierName);
  const linked=(await database.query(`SELECT supplier.* ,si.is_preferred FROM supplier_items si
    JOIN suppliers supplier ON supplier.id=si.supplier_id AND supplier.workspace_id=si.workspace_id
    WHERE si.workspace_id=$1 AND si.sku_id=$2 AND si.is_active=1 AND supplier.status='active'
    ORDER BY si.is_preferred DESC,lower(supplier.name),supplier.id LIMIT 12`,[workspaceId,skuId])).rows;
  if(linked.length===1)return {row:linked[0],inferred:true};
  const preferred=linked.filter((row)=>Number(row.is_preferred)===1);
  if(preferred.length===1)return {row:preferred[0],inferred:true};
  return linked.length?{ambiguous:linked}:{missing:true};
}

async function resolvePurchaseDestination(database,workspaceId,skuId,locationName){
  if(locationName)return resolveOne(database,'locations',workspaceId,locationName,'name');
  const places=(await database.query(`SELECT l.id,l.name,l.kind,
    COALESCE(SUM(CASE WHEN b.on_hand>0 THEN b.on_hand ELSE 0 END),0) AS stocked_units
    FROM locations l LEFT JOIN balances b ON b.location_id=l.id AND b.workspace_id=l.workspace_id AND b.sku_id=$2
    WHERE l.workspace_id=$1 AND l.is_active=1 GROUP BY l.id,l.name,l.kind
    ORDER BY stocked_units DESC,lower(l.name) LIMIT 12`,[workspaceId,skuId])).rows;
  const stocked=places.filter((row)=>Number(row.stocked_units)>0);
  if(stocked.length===1)return {row:stocked[0],inferred:true};
  if(places.length===1)return {row:places[0],inferred:true};
  return places.length?{ambiguous:places}:{missing:true};
}

async function resolveParty(database,kind,workspaceId,search){
  if(!search)return {missing:true};
  const supplier=kind==='supplier';
  const table=supplier?'suppliers':'customers';
  const state=supplier?"status='active'":"record_state='ACTIVE'";
  const exact=await database.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND ${state}
    AND (lower(name)=lower($2) OR lower(COALESCE(email,''))=lower($2)) ORDER BY lower(name),id LIMIT 12`,
  [workspaceId,search]);
  if(exact.rows.length===1)return {row:exact.rows[0]};
  const broad=exact.rows.length?exact:await database.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND ${state}
    AND (name ILIKE '%'||$2||'%' OR COALESCE(email,'') ILIKE '%'||$2||'%') ORDER BY lower(name),id LIMIT 12`,
  [workspaceId,search]);
  if(broad.rows.length===1)return {row:broad.rows[0]};
  return broad.rows.length?{ambiguous:broad.rows}:{notFound:true};
}

async function pendingContact(database,workspaceId,kind,name){
  if(!name)return null;
  return (await database.query(`SELECT id,summary FROM stockchief_runtime.assistant_action_proposals
    WHERE workspace_id=$1 AND action_type='contact.create' AND status='PENDING'
      AND payload->>'kind'=$2 AND lower(payload->>'name')=lower($3)
    ORDER BY created_at DESC,id DESC LIMIT 1`,[workspaceId,kind,name])).rows[0]||null;
}

const EMAIL_GRAMMAR_WORDS=new Set('a an and are as at be been but by can could did do for from had has have i if in is it its me my of on or our please should so that the their them there these this to us we were will with would you your hello regards best sincerely thank thanks'.split(' '));
function editDistanceAtMostTwo(left,right){
  if(Math.abs(left.length-right.length)>2)return false;
  let previous=Array.from({length:right.length+1},(_,index)=>index);
  for(let i=1;i<=left.length;i+=1){
    const current=[i];for(let j=1;j<=right.length;j+=1)
      current[j]=Math.min(current[j-1]+1,previous[j]+1,previous[j-1]+(left[i-1]===right[j-1]?0:1));
    previous=current;
  }
  return previous[right.length]<=2;
}
function noNewBusinessWords(original,drafted){
  const words=(text)=>String(text).toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g)||[];
  const source=[...new Set(words(original))];const output=words(drafted);
  if(source.length>300||output.length>450)return false;
  return output.every((word)=>EMAIL_GRAMMAR_WORDS.has(word)||source.includes(word)
    ||(word.length>3&&source.some((existing)=>existing.length>3&&existing[0]===word[0]
      &&editDistanceAtMostTwo(existing,word))));
}
function boundedEmailRewrite(original,drafted){
  const words=(text)=>String(text).toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g)||[];
  const source=[...new Set(words(original))];const output=words(drafted);
  if(source.length>300||output.length>450)return false;
  const meaningWords=['no','not','never','without','cannot',"can't","won't","don't",'only','before','after','until',
    'will','must','may','might','can','could','should','would'];
  const count=(list,word)=>list.filter((entry)=>entry===word).length;
  const sourceWords=words(original);
  if(meaningWords.some((word)=>count(sourceWords,word)!==count(output,word)))return false;
  if((String(original).match(/\?/g)||[]).length!==(String(drafted).match(/\?/g)||[]).length)return false;
  if(source.some((word)=>!EMAIL_GRAMMAR_WORDS.has(word)&&!output.some((candidate)=>candidate===word
    ||(word.length>3&&candidate.length>3&&candidate[0]===word[0]&&editDistanceAtMostTwo(word,candidate)))))return false;
  return noNewBusinessWords(original,drafted);
}
async function draftBusinessEmail(request,businessName,provider){
  const fallback={subject:request.subject||`Message from ${businessName}`,body:request.body,polished:false};
  if(!provider)return fallback;
  try{
    const response=await provider.complete({system:EMAIL_DRAFT_SYSTEM,
      prompt:JSON.stringify({recipientName:request.recipient,ownerSubject:request.subject||null,
        ownerMessage:request.body,businessName}),schema:EMAIL_DRAFT_SCHEMA,
      schemaName:'stockchief_postgres_email_draft',maxOutputTokens:1000});
    const body=trimOrNull(response.data?.body);
    const suggestedSubject=trimOrNull(response.data?.subject);
    if(!body||body.length>6000||!boundedEmailRewrite(request.body,body))return fallback;
    const subject=suggestedSubject&&noNewBusinessWords(`${request.subject||''} ${request.body}`,suggestedSubject)
      ?suggestedSubject:fallback.subject;
    if(subject.length>200)return fallback;
    const numbers=(text)=>String(text).match(/\b\d+(?:[.,]\d+)*\b/g)||[];
    const originalNumbers=numbers(`${request.subject||''} ${request.body}`);
    const draftedNumbers=numbers(`${subject} ${body}`);
    if(originalNumbers.some((number)=>!draftedNumbers.includes(number))
      ||draftedNumbers.some((number)=>!originalNumbers.includes(number)))return fallback;
    return {subject,body,polished:true};
  }catch(error){return fallback;}
}

async function prepareAction(database,ctx,message,request,options={}) {
  if(!request.action)return {status:'CLARIFY',answer:'What would you like StockChief to change?'};
  if(require('./postgres-workflow-capabilities').SPECS.some((spec)=>spec.name===request.action))
    return require('./postgres-workflow-capabilities').prepare(database,ctx,message,request.action,request,createProposal);
  if(request.action==='create_contact'){
    const kind=trimOrNull(request.recipientKind)?.toLowerCase();
    if(!['supplier','customer'].includes(kind))return {status:'CLARIFY',
      answer:'Should this new business contact be a supplier or a customer?',awaitingField:'recipientKind'};
    const name=trimOrNull(request.recipient);
    if(!name||name.includes('@'))return {status:'CLARIFY',
      answer:`What name should I use for the new ${kind}?`,awaitingField:'recipient'};
    if(name.length>200)return {status:'CLARIFY',answer:'That contact name is too long. Give me a shorter name.'};
    const email=trimOrNull(request.recipientEmail);
    if(email&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254))return {status:'CLARIFY',
      answer:'That email address does not look valid. What address should I save?',awaitingField:'recipientEmail'};
    const table=kind==='supplier'?'suppliers':'customers';
    const existing=(await database.query(`SELECT id FROM ${table} WHERE workspace_id=$1 AND lower(name)=lower($2) LIMIT 1`,
      [ctx.workspaceId,name])).rows[0];
    if(existing)return {status:'CLARIFY',
      answer:`${name} is already recorded as a ${kind}. I did not create a duplicate. Tell me if you want to change the existing record.`,
      reason:'duplicate_contact'};
    const phone=trimOrNull(request.phone);
    const details=[email?`email ${email}`:null,phone?`phone ${phone}`:null].filter(Boolean);
    return createProposal(database,ctx,message,'contact.create',{kind,name,email,
      phone,notes:trimOrNull(request.notes)},
    `Add ${name} as a ${kind}${details.length?` with ${details.join(' and ')}`:''}.`);
  }
  if(request.action==='send_email'){
    const commercialScope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);
    const emailAccess=await entitlements.capabilityState(database,commercialScope,'connection.email');
    if(!emailAccess.enabled)return {status:'CLARIFY',answer:'Connected supplier and customer email is available on Growth and above. Nothing was prepared or sent.',
      handoff:{href:'/upgrade?capability=connection.email&return=/ask',label:'Review email automation plans'}};
    const recipient=await outboundMail.resolveRecipient(database,ctx.workspaceId,request.recipient,request.recipientKind);
    if(recipient.missing)return {status:'CLARIFY',answer:'Who should StockChief email? Name an existing customer or supplier, or give the exact email address.',awaitingField:'recipient'};
    let addContactKind=null;let resolved=recipient;
    if(recipient.notFound){
      const kind=request.recipientKind||null;
      if(!request.recipientEmail)return {status:'CLARIFY',answer:`I could not find ${kind?`the ${kind}`:'a customer or supplier'} “${request.recipient}”. Add the contact or send this email once? Enter the exact email address below. Nothing was sent.`,
        awaitingField:'recipientEmail',emailFlow:{kind:'missing_contact',name:request.recipient,recipientKind:kind}};
      addContactKind=request.recipientMode?.startsWith('add_')?request.recipientMode.slice(4):null;
      if(addContactKind&&!['supplier','customer'].includes(addContactKind))throw new ValidationError('Choose a customer or supplier.');
      if(addContactKind&&kind&&addContactKind!==kind)throw new ValidationError('The contact type must match the request.');
      resolved={row:{id:null,name:request.recipient,email:request.recipientEmail,kind:'address'}};
    }
    if(recipient.ambiguous)return {status:'CLARIFY',answer:`“${request.recipient}” matches more than one business contact. Say whether this is the customer or supplier.`,
      choices:recipient.ambiguous.map((row)=>({label:`${row.name} · ${row.kind}`,value:`the ${row.kind} named ${row.name}`}))};
    if(!resolved.row.email&&!request.recipientEmail)return {status:'CLARIFY',answer:`I found ${resolved.row.name}, but no email address is recorded. Enter the address to use below. Nothing was sent.`,
      awaitingField:'recipientEmail',emailFlow:{kind:'missing_email',name:resolved.row.name,recipientKind:resolved.row.kind}};
    if(!request.body)return {status:'CLARIFY',answer:`What would you like the email to ${resolved.row.name} to say? I’ll polish it before you approve it.`,awaitingField:'body'};
    const mailbox=await outboundMail.resolveMailbox(database,ctx.workspaceId,request.mailbox);
    if(mailbox.missing)return {status:'CLARIFY',answer:'Connect and verify a Gmail or Microsoft 365 business mailbox before preparing this email.'};
    if(mailbox.notFound)return {status:'CLARIFY',answer:`No connected business mailbox matches “${request.mailbox}”. Nothing was prepared.`};
    if(mailbox.ambiguous)return {status:'CLARIFY',answer:'More than one business mailbox can send this. Name the exact mailbox to use.',awaitingField:'mailbox',
      choices:mailbox.ambiguous.map((row)=>({label:`${row.display_name}${row.provider_account_name?` · ${row.provider_account_name}`:''}`,value:row.display_name}))};
    const business=(await database.query('SELECT name FROM workspaces WHERE id=$1',[ctx.workspaceId])).rows[0];
    const drafted=await draftBusinessEmail(request,business.name,options.emailDraftProvider);
    const recipientEmail=request.recipientEmail||resolved.row.email;
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(recipientEmail||'')))
      return {status:'CLARIFY',answer:'Enter a valid email address before I prepare the message.',awaitingField:'recipientEmail',
        emailFlow:{kind:recipient.notFound?'missing_contact':'missing_email',name:request.recipient,
          recipientKind:request.recipientKind||null}};
    return createProposal(database,ctx,message,'communication.send_email',{recipientKind:resolved.row.kind,
      recipientId:resolved.row.id,recipientName:resolved.row.name,recipientEmail,subject:drafted.subject,body:drafted.body,
      originalBody:request.body,draftPolished:drafted.polished,addContactKind,addContactName:addContactKind?request.recipient:null,
      saveEmailToContact:request.saveEmailToContact===true,
      connectorId:mailbox.row.id,mailboxName:mailbox.row.display_name},
    `Email ${resolved.row.name} at ${recipientEmail} from ${mailbox.row.display_name}.`);
  }
  if(request.action==='create_customer_invoice'){
    const customer=await resolveParty(database,'customer',ctx.workspaceId,request.customer);
    if(customer.missing)return {status:'CLARIFY',answer:'Which customer should the invoice be for?',awaitingField:'customer'};
    if(customer.notFound){const waiting=await pendingContact(database,ctx.workspaceId,'customer',request.customer);
      return waiting?{status:'CLARIFY',answer:`${request.customer} is prepared but not yet a customer. Approve that contact first; no invoice was recorded.`,
        handoff:{href:`/actions/${waiting.id}`,label:'Approve customer'}}:
        {status:'CLARIFY',answer:`I could not find customer “${request.customer}”. Nothing was prepared.`,
          handoff:recordHandoff('customer',request.customer)};}
    if(customer.ambiguous)return {status:'CLARIFY',answer:'More than one customer matches. Which one should receive the invoice?',
      awaitingField:'customer',choices:customer.ambiguous.map((row)=>({label:row.name,value:row.name}))};
    if(!Number.isSafeInteger(request.quantity)||request.quantity<1)return {status:'CLARIFY',
      answer:'How many units should this invoice cover?',awaitingField:'quantity'};
    let description=request.description||null;let unitAmount=request.amount;
    let priceCurrency=null;
    if(request.sku){
      const sku=await resolveOne(database,'skus',ctx.workspaceId,request.sku,'i.name,s.position');
      if(sku.notFound)return {status:'CLARIFY',answer:`I could not find product “${request.sku}”. Nothing was prepared.`};
      if(sku.ambiguous)return {status:'CLARIFY',answer:'More than one product matches. Which exact SKU should appear on the invoice?',
        awaitingField:'sku'};
      if(sku.row){
        description=description||`${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''}`;
        const price=await pricing.currentPrice(database,ctx.workspaceId,sku.row.id);
        if(unitAmount===null||unitAmount===undefined)unitAmount=price.amount_minor===null?null:price.amount_minor/100;
        priceCurrency=price.currency;
      }
    }
    if(!description)return {status:'CLARIFY',answer:'What product or service should appear on the invoice?',
      awaitingField:'description'};
    if(unitAmount===null||unitAmount===undefined||unitAmount<=0)return {status:'CLARIFY',
      answer:`What is the unit price for ${description}?`,awaitingField:'amount'};
    const base=(await database.query(`SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1`,
      [ctx.workspaceId])).rows[0]?.base_currency;
    if(!base)return {status:'CLARIFY',answer:'Accounting must be configured before StockChief can record an invoice. Nothing was prepared.',
      handoff:{href:'/accounting/settings',label:'Configure accounting'}};
    if(request.currency&&request.currency!==base||!request.currency&&priceCurrency&&priceCurrency!==base)
      return {status:'CLARIFY',answer:`This business records invoices in ${base}; the requested price is in ${request.currency||priceCurrency}. Nothing was prepared.`};
    const issueDate=request.issueDate||new Date().toISOString().slice(0,10);
    const tax=pricing.toMinor(String(request.tax??0),'Invoice tax');
    const unitMinor=pricing.toMinor(String(unitAmount),'Invoice unit price');
    if(unitMinor<=0)return {status:'CLARIFY',answer:'The invoice unit price must be greater than zero.'};
    return createProposal(database,ctx,message,'customer_invoice.create',{
      customerId:customer.row.id,description,quantity:request.quantity,unitAmount:String(unitAmount),
      tax:String(request.tax??0),issueDate,dueDate:request.dueDate||null,notes:request.reference||null,
    },`Record an invoice for ${customer.row.name}: ${request.quantity} × ${description} at ${pricing.formatMinor(unitMinor,base)} each${tax?`, plus ${pricing.formatMinor(tax,base)} tax`:`, with no tax added`}. Approval posts the invoice; it does not send it, fulfill an order, or record payment.`);
  }
  if(request.action==='receive_purchase_order'){
    if(!request.purchaseOrder)return {status:'CLARIFY',answer:'Which exact purchase order number did these goods arrive against?',awaitingField:'purchaseOrder'};
    const orders=(await database.query(`SELECT po.*,supplier.name AS supplier_name FROM purchase_orders po
      JOIN suppliers supplier ON supplier.id=po.supplier_id AND supplier.workspace_id=po.workspace_id
      WHERE po.workspace_id=$1 AND lower(po.po_number)=lower($2) ORDER BY po.created_at DESC`,
    [ctx.workspaceId,request.purchaseOrder])).rows;
    if(!orders.length)return {status:'CLARIFY',answer:`I could not find purchase order “${request.purchaseOrder}” in this inventory. Nothing was prepared.`};
    if(orders.length>1)return {status:'CLARIFY',answer:'More than one purchase order has that number. Open Purchasing and choose the exact order.'};
    const order=orders[0];
    if(!['ORDERED','PARTIALLY_RECEIVED'].includes(order.status))return {status:'CLARIFY',answer:`${order.po_number} is ${order.status}. Only a placed purchase order can be received.`};
    if(request.supplier){
      const party=await resolveParty(database,'supplier',ctx.workspaceId,request.supplier);
      if(party.notFound)return {status:'CLARIFY',answer:`I could not find supplier “${request.supplier}”. Nothing was prepared.`};
      if(party.ambiguous)return {status:'CLARIFY',answer:'More than one supplier matches that name. Use the exact supplier name.'};
      if(party.row&&party.row.id!==order.supplier_id)return {status:'CLARIFY',answer:`${order.po_number} belongs to ${order.supplier_name}, not ${party.row.name}. Nothing was prepared.`};
    }
    const sku=await resolveOne(database,'skus',ctx.workspaceId,request.sku,'i.name,s.position');
    if(sku.missing)return {status:'CLARIFY',answer:'Which product or SKU physically arrived?',awaitingField:'sku'};
    if(sku.notFound)return {status:'CLARIFY',answer:`I could not find product or SKU “${request.sku}”. Nothing was prepared.`};
    if(sku.ambiguous)return {status:'CLARIFY',answer:`More than one SKU matches “${request.sku}”. Use the exact SKU code.`};
    if(sku.row.tracking_mode!=='quantity')return {status:'CLARIFY',answer:`${sku.row.code} needs its exact ${sku.row.tracking_mode==='serial'?'serial numbers':'lot evidence'}. Open ${order.po_number} and record the physical receipt there.`};
    if(!request.quantity||request.quantity<1)return {status:'CLARIFY',answer:'How many units physically arrived?',awaitingField:'quantity'};
    if(!request.receiptReference)return {status:'CLARIFY',answer:'What delivery note, packing slip, or receipt reference proves this arrival?',awaitingField:'receiptReference'};
    const lines=(await database.query(`SELECT pol.*,COALESCE(pol.destination_location_id,po.destination_location_id) AS default_location_id
      FROM purchase_order_lines pol JOIN purchase_orders po ON po.id=pol.purchase_order_id AND po.workspace_id=pol.workspace_id
      WHERE pol.workspace_id=$1 AND pol.purchase_order_id=$2 AND pol.sku_id=$3 ORDER BY pol.line_number`,
    [ctx.workspaceId,order.id,sku.row.id])).rows;
    if(!lines.length)return {status:'CLARIFY',answer:`${sku.row.code} is not on ${order.po_number}. Nothing was prepared.`};
    if(lines.length>1)return {status:'CLARIFY',answer:`${sku.row.code} appears on more than one line of ${order.po_number}. Open the order and choose the exact line.`};
    const line=lines[0];const outstanding=Number(line.quantity_units)-Number(line.quantity_received_units);
    if(request.quantity>outstanding)return {status:'CLARIFY',answer:`${order.po_number} has ${outstanding} ${sku.row.code} still expected, but you said ${request.quantity} arrived. Review the over-receipt on the purchase order before changing stock.`};
    let locationId=line.default_location_id;let locationName=null;
    if(request.location){
      const place=await resolveOne(database,'locations',ctx.workspaceId,request.location,'name');
      if(place.notFound)return {status:'CLARIFY',answer:`I could not find receiving location “${request.location}”. Nothing was prepared.`};
      if(place.ambiguous)return {status:'CLARIFY',answer:'More than one location matches that receiving place. Use its exact name.'};
      locationId=place.row?.id||null;locationName=place.row?.name||null;
    }
    if(!locationId)return {status:'CLARIFY',answer:'Which inventory location physically received these goods?',awaitingField:'location'};
    if(!locationName)locationName=(await database.query(`SELECT name FROM locations WHERE id=$1 AND workspace_id=$2 AND is_active=1`,
      [locationId,ctx.workspaceId])).rows[0]?.name||null;
    if(!locationName)return {status:'CLARIFY',answer:'The purchase order destination is no longer active. Choose an active receiving location.'};
    return createProposal(database,ctx,message,'purchase_order.receive',{purchaseOrderId:order.id,
      reference:request.receiptReference,lines:[{lineId:line.id,quantity:request.quantity,locationId}]},
    `Receive ${request.quantity} × ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} on ${order.po_number} into ${locationName}, supported by ${request.receiptReference}.`);
  }
  if(request.action==='record_supplier_payment'){
    const party=await resolveParty(database,'supplier',ctx.workspaceId,request.supplier);
    if(party.missing)return {status:'CLARIFY',answer:'Which supplier was paid?',awaitingField:'supplier'};
    if(party.notFound)return {status:'CLARIFY',answer:`I could not find supplier “${request.supplier}”. Nothing was prepared.`};
    if(party.ambiguous)return {status:'CLARIFY',answer:'More than one supplier matches that name. Use its exact name.'};
    if(!request.supplierBill)return {status:'CLARIFY',answer:'Which exact supplier bill or supplier invoice number was paid?',awaitingField:'supplierBill'};
    const bills=(await database.query(`SELECT * FROM accounting_supplier_bills WHERE workspace_id=$1 AND supplier_id=$2
      AND (lower(bill_number)=lower($3) OR lower(COALESCE(supplier_invoice_number,''))=lower($3))
      ORDER BY created_at DESC`,[ctx.workspaceId,party.row.id,request.supplierBill])).rows;
    if(!bills.length)return {status:'CLARIFY',answer:`I could not find an open bill matching “${request.supplierBill}” for ${party.row.name}. Nothing was prepared.`};
    if(bills.length>1)return {status:'CLARIFY',answer:'More than one bill matches that number. Open Money and choose the exact bill.'};
    const bill=bills[0];
    if(!['OPEN','PARTIALLY_PAID'].includes(bill.status))return {status:'CLARIFY',answer:`${bill.bill_number} is ${bill.status} and is not open for another payment.`};
    if(request.amount===null||request.amount<=0)return {status:'CLARIFY',answer:`How much was paid toward ${bill.bill_number}?`,awaitingField:'amount'};
    if(!request.paymentDate||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(request.paymentDate))return {status:'CLARIFY',answer:'What exact date was the supplier paid, in YYYY-MM-DD format?',awaitingField:'paymentDate'};
    if(!request.paymentMethod)return {status:'CLARIFY',answer:'How was the supplier paid, for example ACH, check, wire, or card?',awaitingField:'paymentMethod'};
    const amountMinor=pricing.toMinor(String(request.amount),'Payment amount');const currency=request.currency||bill.currency;
    if(request.currency&&request.currency!==bill.currency)return {status:'CLARIFY',answer:`${bill.bill_number} is in ${bill.currency}, not ${request.currency}. Nothing was prepared.`};
    if(amountMinor>Number(bill.balance_minor))return {status:'CLARIFY',answer:`${bill.bill_number} has ${pricing.formatMinor(Number(bill.balance_minor),bill.currency)} outstanding, so ${pricing.formatMinor(amountMinor,currency)} cannot be applied.`};
    return createProposal(database,ctx,message,'supplier_payment.record',{supplierId:party.row.id,supplierBillId:bill.id,
      amountMinor,paymentDate:request.paymentDate,currency,method:request.paymentMethod,reference:request.reference},
    `Record ${pricing.formatMinor(amountMinor,currency)} paid to ${party.row.name} against ${bill.bill_number} on ${request.paymentDate} by ${request.paymentMethod}. Inventory will not change.`);
  }
  if(['create_sales_order','create_purchase_order'].includes(request.action)){
    const sales=request.action==='create_sales_order';
    const multipleLines=sales&&Boolean(request.orderLines);
    const sku=multipleLines?null:await resolveRequestedSku(database,ctx.workspaceId,request);
    if(!multipleLines){
      if(sku.stockEmpty)return {status:'CLARIFY',answer:'I could not find any product currently in stock. Which product should StockChief get more of? Nothing was prepared.',awaitingField:'sku'};
      if(sku.missing)return {status:'CLARIFY',answer:`Which product or SKU ${sales?'is on the customer order':'do you need more of'}?`,awaitingField:'sku'};
      if(sku.notFound)return {status:'CLARIFY',answer:`I could not find a product or SKU matching “${request.sku}”. Nothing was prepared.`};
      if(sku.ambiguous)return {status:'CLARIFY',answer:sku.fromCurrentStock
        ?'I found more than one product currently in stock. Which one needs more? Nothing was prepared.'
        :`More than one SKU matches “${request.sku}”. Which one?`,awaitingField:'sku',
      choices:sku.ambiguous.map((row)=>({label:`${row.name}${row.variant_label?` · ${row.variant_label}`:''} · ${row.code}${row.stocked_units?` · ${row.stocked_units} on hand`:''}`,value:row.code}))};
    }
    const skuContext=multipleLines?{orderLines:request.orderLines}:{sku:sku.row.code,skuReference:''};
    if(!multipleLines&&(!request.quantity||request.quantity<1))return {status:'CLARIFY',answer:'How many units are needed?',awaitingField:'quantity',carryForward:skuContext};
    const party=sales?await resolveParty(database,'customer',ctx.workspaceId,request.customer)
      :await resolvePurchaseSupplier(database,ctx.workspaceId,sku.row.id,request.supplier);
    if(party.missing)return {status:'CLARIFY',answer:sales?'Which customer is this for?'
      :`I found ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} (${sku.row.code})${sku.row.stocked_units?` with ${sku.row.stocked_units} on hand`:''}. Which supplier should provide ${request.quantity} more? Nothing was prepared.`,awaitingField:sales?'customer':'supplier',carryForward:skuContext};
    if(party.notFound){
      const kind=sales?'customer':'supplier';const name=sales?request.customer:request.supplier;
      const waiting=await pendingContact(database,ctx.workspaceId,kind,name);
      if(waiting)return {status:'CLARIFY',answer:`${name} is prepared but not yet a ${kind}. Approve that contact first; no order was recorded.`,
        handoff:{href:`/actions/${waiting.id}`,label:`Approve ${kind}`},carryForward:skuContext};
      return {status:'CLARIFY',answer:`I could not find ${kind} “${name}”. Add the ${kind} record first, then return here to prepare the order. Nothing was prepared.`,
        handoff:recordHandoff(kind,name,{shippingAddress:request.shipToAddress}),carryForward:skuContext};
    }
    if(party.ambiguous)return {status:'CLARIFY',answer:`More than one ${sales?'customer':'supplier'} could be used. Which one? Nothing was prepared.`,
      awaitingField:sales?'customer':'supplier',carryForward:skuContext,
      choices:party.ambiguous.map((row)=>({label:`${row.name}${row.email?` · ${row.email}`:''}`,value:row.name}))};
    const orderContext={...skuContext,[sales?'customer':'supplier']:party.row.name};
    if(request.neededBy&&!/^\d{4}-\d{2}-\d{2}$/.test(request.neededBy))return {status:'CLARIFY',answer:'What exact date is needed, in YYYY-MM-DD format?'};
    if(request.orderDate&&!/^\d{4}-\d{2}-\d{2}$/.test(request.orderDate))return {status:'CLARIFY',
      answer:'What exact customer order date should be recorded, in YYYY-MM-DD format? Nothing changed.'};
    if(sales){
      const deliveryChoice=String(request.deliveryMethod||'').trim().toLowerCase().replace(/[\s-]+/g,'_');
      const deliveryMethod={ship:'SHIP',shipping:'SHIP',carrier:'SHIP',carrier_shipping:'SHIP',
        pickup:'PICKUP',pick_up:'PICKUP',customer_pickup:'PICKUP',customer_collection:'PICKUP',
        collection:'PICKUP',own_delivery:'OWN_DELIVERY',business_delivery:'OWN_DELIVERY',
        delivered_by_us:'OWN_DELIVERY'}[deliveryChoice]||null;
      if(!deliveryMethod)return {status:'CLARIFY',answer:'Should the customer order be shipped, picked up, or delivered by your business?',awaitingField:'deliveryMethod',carryForward:orderContext};
      let fulfillmentLocationId=null;let fulfillmentLocationName=null;
      if(request.location){
        const place=await resolveOne(database,'locations',ctx.workspaceId,request.location,'name');
        if(place.notFound)return {status:'CLARIFY',answer:`I could not find a location matching “${request.location}”. Nothing was prepared.`};
        if(place.ambiguous)return {status:'CLARIFY',answer:'More than one location matches that request. Use its exact name.'};
        fulfillmentLocationId=place.row?.id||null;fulfillmentLocationName=place.row?.name||null;
      }
      if(deliveryMethod==='PICKUP'&&!fulfillmentLocationId)return {status:'CLARIFY',answer:'Which location will the customer pick this order up from?',awaitingField:'location',carryForward:orderContext};
      const destination=deliveryMethod==='PICKUP'?null:
        trimOrNull(request.shipToAddress)||trimOrNull(party.row.shipping_address);
      if(deliveryMethod!=='PICKUP'&&!destination)return {status:'CLARIFY',answer:`What is the delivery address for ${party.row.name}? Nothing will be prepared without a destination.`,awaitingField:'shipToAddress',carryForward:orderContext};
      const orderLines=multipleLines
        ?await resolveCustomerOrderLines(database,ctx,request.orderLines,message,request.currency)
        :null;
      if(orderLines?.answer)return {status:'CLARIFY',answer:orderLines.answer,carryForward:orderContext};
      const current=multipleLines?null:await pricing.currentPrice(database,ctx.workspaceId,sku.row.id);
      const amountMinor=multipleLines?null:request.amount===null?current.amount_minor:
        pricing.toMinor(String(request.amount),'Selling price');
      if(!multipleLines&&amountMinor===null)return {status:'CLARIFY',answer:`What selling price per unit should this order use for ${sku.row.name}?`,awaitingField:'amount',carryForward:orderContext};
      const currency=orderLines?.currency||request.currency||current?.currency||'USD';
      const lines=orderLines?.lines||[{skuId:sku.row.id,quantity:request.quantity,unitPriceMinor:amountMinor}];
      return createProposal(database,ctx,message,'sales_order.create',{customerId:party.row.id,
        deliveryMethod,shipToAddress:destination,fulfillmentLocationId,orderDate:request.orderDate,
        neededBy:request.neededBy,
        currency,reference:request.reference,lines},
      `Prepare one draft customer order for ${party.row.name}: ${orderLines?.summary||
        `${request.quantity} × ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} at ${pricing.formatMinor(amountMinor,currency)} each`}, `+
        `${deliveryMethod==='PICKUP'?`pickup from ${fulfillmentLocationName}`:`to ${destination}`}.`);
    }
    const place=await resolvePurchaseDestination(database,ctx.workspaceId,sku.row.id,request.location);
    if(place.missing)return {status:'CLARIFY',answer:'Which inventory location should receive this purchase order?',awaitingField:'location',carryForward:orderContext};
    if(place.notFound)return {status:'CLARIFY',answer:`I could not find a location matching “${request.location}”. Nothing was prepared.`};
    if(place.ambiguous)return {status:'CLARIFY',answer:'Which location should receive this purchase order? Nothing was prepared.',awaitingField:'location',carryForward:orderContext,
      choices:place.ambiguous.map((row)=>({label:row.name,value:row.name}))};
    const supplierItem=(await database.query(`SELECT * FROM supplier_items WHERE workspace_id=$1 AND supplier_id=$2
      AND sku_id=$3 AND is_active=1`,[ctx.workspaceId,party.row.id,sku.row.id])).rows[0]||null;
    const unitCost=request.amount===null?(supplierItem?.last_unit_cost===null||supplierItem?.last_unit_cost===undefined
      ?null:Number(supplierItem.last_unit_cost)):request.amount;
    const currency=request.currency||party.row.currency||'USD';
    return createProposal(database,ctx,message,'purchase_order.create',{supplierId:party.row.id,
      destinationLocationId:place.row.id,currency,expectedDate:request.neededBy,reference:request.reference,
      lines:[{skuId:sku.row.id,quantityUnits:request.quantity,unitCost,destinationLocationId:place.row.id}]},
    `Prepare a draft purchase order to ${party.row.name}: ${request.quantity} × ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} for ${place.row.name}${unitCost===null?'. Supplier cost is not recorded; the draft cannot be placed until it is priced':` at ${pricing.formatMinor(Math.round(unitCost*100),currency)} per inventory unit`}.`);
  }
  if(request.action==='create_item'){
    if(!request.search && !request.sku)return {status:'CLARIFY',answer:'What is the product name?',awaitingField:'search'};
    return createProposal(database,ctx,message,'catalog.create_item',{name:request.search || request.sku,
      baseCode:request.baseCode||null,trackingMode:'quantity'},
    `Create product “${request.search || request.sku}”${request.baseCode?` with SKU ${request.baseCode}`:''} counted by quantity.`);
  }
  if(request.action==='create_location'){
    if(!request.search && !request.location)return {status:'CLARIFY',answer:'What is the location name?',awaitingField:'location'};
    return createProposal(database,ctx,message,'location.create',{name:request.search || request.location,kind:'warehouse'},
      `Create warehouse location “${request.search || request.location}”.`);
  }
  const sku=await resolveRequestedSku(database,ctx.workspaceId,request);
  if(sku.stockEmpty)return {status:'CLARIFY',answer:'I could not find any product currently in stock. Which product do you mean? Nothing was prepared.'};
  if(sku.missing)return {status:'CLARIFY',answer:'Which product or SKU is this for?',awaitingField:'sku'};
  if(sku.notFound)return {status:'CLARIFY',answer:`I could not find a product or SKU matching “${request.sku}”. Nothing was prepared.`};
  if(sku.ambiguous)return {status:'CLARIFY',answer:sku.fromCurrentStock
    ?'I found more than one product currently in stock. Which one do you mean? Nothing was prepared.'
    :`More than one SKU matches “${request.sku}”. Which one?`,awaitingField:'sku',
  choices:sku.ambiguous.map((row)=>({label:`${row.name}${row.variant_label?` · ${row.variant_label}`:''} · ${row.code}`,value:row.code}))};
  if(['set_price','set_purchase_cost'].includes(request.action)){
    if(request.amount===null)return {status:'CLARIFY',answer:`What ${request.action==='set_price'?'selling price':'purchase cost'} per unit should StockChief use?`,awaitingField:'amount'};
    const currency=request.currency||'USD';const current=request.action==='set_price'?
      await pricing.currentPrice(database,ctx.workspaceId,sku.row.id):await pricing.purchaseCost(database,ctx.workspaceId,sku.row.id);
    const actionType=request.action==='set_price'?'catalog.set_price':'catalog.set_purchase_cost';
    const label=request.action==='set_price'?'selling price':'purchase cost';
    const amountMinor=pricing.toMinor(String(request.amount),label);
    if(Number(current?.amount_minor)===amountMinor&&current?.amount_minor!==null&&current?.amount_minor!==undefined
      &&current?.currency===currency)return {status:'ANSWERED',
      answer:`${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} already has a ${label} of ${pricing.formatMinor(amountMinor,currency)}. Nothing changed.`};
    return createProposal(database,ctx,message,actionType,{skuId:sku.row.id,amountMinor,
      currency,expectedCurrentId:current?.id||null},`Set ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} ${label} to ${pricing.formatMinor(amountMinor,currency)}.`);
  }
  if(sku.row.tracking_mode!=='quantity')return {status:'CLARIFY',answer:`${sku.row.name} is ${sku.row.tracking_mode}-tracked. Include the exact ${sku.row.tracking_mode==='lot'?'lot or batch':'serial numbers'} before StockChief prepares the movement.`};
  if(request.action==='transfer'){
    const from=await resolveOne(database,'locations',ctx.workspaceId,request.fromLocation,'name');
    const to=await resolveOne(database,'locations',ctx.workspaceId,request.toLocation,'name');
    if(from.missing || to.missing)return {status:'CLARIFY',answer:'Which location is stock moving from, and which location is it moving to?'};
    if(from.notFound || to.notFound)return {status:'CLARIFY',answer:'One of those locations is not in this inventory. Nothing was prepared.'};
    if(from.ambiguous || to.ambiguous)return {status:'CLARIFY',answer:'More than one location matches that request. Use the exact source and destination names.'};
    if(!request.quantity || request.quantity<1)return {status:'CLARIFY',answer:'How many units should move?',awaitingField:'quantity'};
    return createProposal(database,ctx,message,'inventory.transfer',{skuId:sku.row.id,sourceLocationId:from.row.id,
      destinationLocationId:to.row.id,quantity:request.quantity,reference:request.reference},
    `Move ${request.quantity} × ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} from ${from.row.name} to ${to.row.name}.`);
  }
  const place=await resolveOne(database,'locations',ctx.workspaceId,request.location,'name');
  if(place.missing)return {status:'CLARIFY',answer:'Which location is this for?',awaitingField:'location'};
  if(place.notFound)return {status:'CLARIFY',answer:`I could not find a location matching “${request.location}”. Nothing was prepared.`};
  if(place.ambiguous)return {status:'CLARIFY',answer:'More than one location matches that request. Use its exact name.'};
  if(request.action==='adjust'){
    if(request.countedQuantity===null)return {status:'CLARIFY',answer:'What was the physical count?',awaitingField:'countedQuantity'};
    if(!request.reason)return {status:'CLARIFY',answer:'Why is the count being corrected?',awaitingField:'reason'};
    return createProposal(database,ctx,message,'inventory.adjust',{skuId:sku.row.id,locationId:place.row.id,
      countedQuantity:request.countedQuantity,reasonCode:'physical_count',notes:request.reason,reference:request.reference},
    `Correct ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} at ${place.row.name} to ${request.countedQuantity}. Reason: ${request.reason}.`);
  }
  if(!request.quantity || request.quantity<1)return {status:'CLARIFY',answer:'How many units?',awaitingField:'quantity'};
  const type=request.action==='receive'?'inventory.receive':'inventory.issue';
  const accountingEnabled=request.action==='receive'&&Boolean((await database.query(`SELECT 1 FROM accounting_settings
    WHERE workspace_id=$1 AND enabled=1`,[ctx.workspaceId])).rows.length);
  return createProposal(database,ctx,message,type,{skuId:sku.row.id,locationId:place.row.id,quantity:request.quantity,
    reasonCode:request.action==='issue'?'other':undefined,notes:request.reason,reference:request.reference},
  `${request.action==='receive'?'Receive':'Issue'} ${request.quantity} × ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} ${request.action==='receive'?'into':'from'} ${place.row.name}.`+
    (accountingEnabled?' Physical stock only: no purchase cost or supplier liability is recorded. These units cannot be sold until their cost is established through a verified purchasing or opening-balance workflow.':''));
}

async function createProposal(database,ctx,message,actionType,payload,summary) {
  const id=newId('pgprop');
  const key=ctx.planStepKey||`assistant:${id}`;
  const inserted=await database.query(`INSERT INTO stockchief_runtime.assistant_action_proposals
    (id,workspace_id,actor_user_id,action_type,payload,summary,source_message,idempotency_key)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
    ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING id`,
  [id,ctx.workspaceId,ctx.actorId,actionType,JSON.stringify(payload),summary,message,key]);
  const proposalId=inserted.rows[0]?.id||(await database.query(`SELECT id,action_type FROM stockchief_runtime.assistant_action_proposals
    WHERE workspace_id=$1 AND idempotency_key=$2 AND actor_user_id=$3`,
  [ctx.workspaceId,key,ctx.actorId])).rows[0]?.id;
  if(!proposalId)throw new InvariantError('A prepared change could not be recovered safely.','proposal_idempotency');
  return {status:'PREPARED',answer:`${summary} Nothing has changed yet. Review and approve the exact change.`,
    proposal:{id:proposalId,summary,actionType}};
}

async function storeInteraction(database,ctx,message,intent,result) {
  const id=newId('pgask');
  const storedIntent={...intent,...(result.carryForward||{}),presentation:{columns:result.columns || [],choices:result.choices || [],handoff:result.handoff || null,
    reason:result.reason||null,awaitingField:result.awaitingField||null,emailFlow:result.emailFlow||null,
    researchViews:result.researchViews||[]}};
  await database.query(`INSERT INTO stockchief_runtime.assistant_interactions
    (id,workspace_id,actor_user_id,message,intent,answer,evidence,status)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)`,[id,ctx.workspaceId,ctx.actorId,message,JSON.stringify(storedIntent),
    result.answer,JSON.stringify(result.rows || []),result.status]);
  return id;
}

function capabilityService(){return {lookup,prepareAction,prepareInstruction,
  discover:(db,scope)=>require('./postgres-discovery').describe(db,scope),
  verifyProposal:async(db,scope,result)=>{
    if(!result?.proposal?.id)return false;
    const saved=await getProposal(db,scope.workspaceId,result.proposal.id).catch(()=>null);
    return Boolean(saved&&saved.status==='PENDING'&&saved.workspace_id===scope.workspaceId);
  },navigate:(_db,_scope,id)=>require('../web/postgres-navigation').destinationById(id),
  navigateRecord:(db,scope,kind,reference)=>require('../web/postgres-record-destinations').resolve(db,scope,kind,reference)};}

async function recordCapabilityOutcome(database,ctx,message,outcome,{batchId=null,planId=null,index=0,count=1}={}){
  const {step,args,provenance}=outcome;const result=outcome.result;const contract=step?.contract;
  const intent={intent:contract?.kind==='mutation'?'action':contract?.kind==='policy'?'instruction':
    contract?.kind==='navigation'?'navigation':'lookup',
    view:contract?.view||null,action:contract?.legacyAction||null,...args,
    controlPlane:contract?{capability:contract.name,args,provenance,dependsOn:step.dependsOn,
      continuesPending:step.continuesPending,...(planId?{planId}:{}),
      ...(result.pendingProposalId?{pendingProposalId:result.pendingProposalId}:{})}:null,
    ...(batchId?{batchId,sourceMessage:message,requestIndex:index+1,requestCount:count}:{}),
    ...(result.proposal?{proposalId:result.proposal.id,
      proposalHref:result.proposal.href||`/actions/${result.proposal.id}`}:{})};
  result.interactionId=await storeInteraction(database,ctx,message,intent,result);
  result.intent=intent;return result;
}

/** The production Ask entry point. Language selects registered contracts;
 * canonical services retain exclusive authority over business state. */
function fundedAskProvider(database,ctx,rawProvider,prefix,
  wrapModel=require('../commercial/model').wrap,verificationProvider=null){
  if(!rawProvider)return null;
  let call=0,fundingKey=null;
  const completeWith=async(modelProvider,request)=>{
    const key=`${prefix}:${call++}`;
    // A failed model attempt reverses its credit reservation. The next attempt
    // must establish new funding before any later calls can be internal.
    const options=fundingKey?{chargeCustomer:false,fundingKey}:{};
    const response=await wrapModel(database,ctx,modelProvider,'ask',key,options).complete(request);
    if(!fundingKey)fundingKey=key;
    return response;
  };
  return {...rawProvider,complete:(request)=>completeWith(rawProvider,request),
    verifyComplete:verificationProvider?(request)=>completeWith(verificationProvider,request):null};
}

async function askCapabilities(database,ctx,message,options={}){
  await require('../commercial/enforcement').workspace(database,ctx.workspaceId,'ask.lookup');
  const clean=String(message||'').trim();if(!clean)throw new ValidationError('Ask a question or describe what should happen.');
  const rawProvider=options.provider||(config.ai.configured?createProviderUnobserved(config.ai.provider,config.ai.tier('fast')):null);
  const strongVerifier=options.verificationProvider||(options.provider?null:
    config.ai.configured?createProviderUnobserved(config.ai.provider,config.ai.tier('standard')):null);
  const usageKey=String(options.usageKey||newId('askusage'));
  const provider=fundedAskProvider(database,ctx,rawProvider,`${usageKey}:capability`,
    require('../commercial/model').wrap,strongVerifier);
  const history=(await database.query(`SELECT message,answer,status,intent FROM stockchief_runtime.assistant_interactions
    WHERE workspace_id=$1 AND actor_user_id=$2 AND ($3::timestamptz IS NULL OR created_at > $3::timestamptz)
    ORDER BY created_at DESC,id DESC LIMIT 6`,[ctx.workspaceId,ctx.actorId,options.startedAt||null])).rows.reverse();
  const latest=history.at(-1);let pending=['CLARIFY','PREPARED'].includes(latest?.status)
    &&latest.intent?.controlPlane?.capability
    ?{capability:latest.intent.controlPlane.capability,args:latest.intent.controlPlane.args,
      question:latest.answer,originalMessage:latest.message,status:latest.status,
      awaitingField:latest.intent.presentation?.awaitingField||null,
      choices:latest.intent.presentation?.choices||[],
      proposalId:latest.intent.controlPlane.pendingProposalId||latest.intent.proposalId||null}:null;
  if(pending?.proposalId){
    const active=await getProposal(database,ctx.workspaceId,pending.proposalId).catch(()=>null);
    if(!active||active.status!=='PENDING')pending=null;
  }
  const selection=await require('./postgres-control-plane').run(capabilityService(),database,ctx,clean,
    {provider,rawProvider,history,pending,page:options.page||null,usageKey});
  const {outcomes,steps}=selection;const batchId=steps.length>1?newId('pgaskbatch'):null;
  for(const outcome of outcomes){
    if(outcome.step?.continuesPending&&pending?.proposalId&&outcome.result.status==='PREPARED'
      &&outcome.result.proposal?.id!==pending.proposalId){
      const replaced=await supersedePendingProposal(database,ctx,pending.proposalId,
        outcome.result.proposal.id,outcome.args);
      if(!replaced)Object.assign(outcome.result,{status:'CLARIFY',proposal:null,
        answer:'The earlier change was already completed or discarded. This correction was not prepared. Review the current record before asking again.',
        reason:'stale_correction'});
    }
    if(outcome.step?.continuesPending&&pending?.proposalId&&outcome.result.status==='CLARIFY')
      outcome.result.pendingProposalId=pending.proposalId;
  }
  const plan=await require('./postgres-capability-plans').save(database,ctx,clean,batchId,steps,outcomes);
  const results=[];
  for(const [index,outcome] of outcomes.entries()){
    if(outcome.result.reason==='dependency_waiting')continue;
    results.push(await recordCapabilityOutcome(database,ctx,clean,outcome,
      {batchId,planId:plan?.id,index,count:steps.length||1}));
  }
  if(results.length===1)return results[0];
  return {status:results.some((row)=>row.status==='CLARIFY')?'CLARIFY':
    results.some((row)=>row.status==='PREPARED')?'PREPARED':'ANSWERED',
  answer:results.map((row)=>row.answer).filter(Boolean).join(' '),results};
}

async function prepareInstruction(database,ctx,message,options={}){
  const proposal=await operatingInstructions.interpret(database,ctx,message,options);
  if(proposal.questions.length)return {status:'CLARIFY',answer:proposal.questions[0],proposal:{id:proposal.id,
    summary:proposal.summary,actionType:'operating.instruction',href:`/operating-instructions/${proposal.id}`}};
  return {status:'PREPARED',answer:`${proposal.summary} Nothing is in force yet. Review the exact limits and approve once.`,
    proposal:{id:proposal.id,summary:proposal.summary,actionType:'operating.instruction',href:`/operating-instructions/${proposal.id}`}};
}

async function listInteractions(database,workspaceId,limit=20,{actorId=null,startedAt=null}={}) {
  const result=await database.query(`SELECT * FROM stockchief_runtime.assistant_interactions
    WHERE workspace_id=$1 AND ($3::text IS NULL OR actor_user_id=$3)
      AND ($4::timestamptz IS NULL OR created_at > $4::timestamptz)
    ORDER BY created_at DESC,id DESC LIMIT $2`,[workspaceId,Math.min(100,Math.max(1,limit)),actorId,startedAt]);
  return result.rows.map((row)=>({...row,intent:row.intent || {},evidence:row.evidence || []})).sort((left,right)=>{
    const byTime=new Date(left.created_at)-new Date(right.created_at);if(byTime)return byTime;
    if(left.intent.batchId&&left.intent.batchId===right.intent.batchId)return Number(left.intent.requestIndex)-Number(right.intent.requestIndex);
    return String(left.id).localeCompare(String(right.id));
  });
}

async function continueEmail(database,ctx,input,options={}){
  await require('../commercial/enforcement').workspace(database,ctx.workspaceId,'ask.lookup');
  const latest=(await database.query(`SELECT id,message,intent,status FROM stockchief_runtime.assistant_interactions
    WHERE workspace_id=$1 AND actor_user_id=$2 AND ($3::timestamptz IS NULL OR created_at > $3::timestamptz)
    ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId,ctx.actorId,options.startedAt||null])).rows[0];
  const flow=latest?.intent?.presentation?.emailFlow;
  if(!latest||latest.id!==input.interactionId||latest.status!=='CLARIFY'
    ||latest.intent?.action!=='send_email'||!['missing_contact','missing_email'].includes(flow?.kind))
    throw new ValidationError('This email question has changed. Read the latest reply before continuing.');
  const email=trimOrNull(input.email);
  if(!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new ValidationError('Enter the exact valid email address to use.');
  const mode=String(input.mode||'');
  if(flow.kind==='missing_contact'&&!['one_off','add_supplier','add_customer'].includes(mode))
    throw new ValidationError('Choose whether to add this contact or send once.');
  if(flow.kind==='missing_contact'&&flow.recipientKind&&mode.startsWith('add_')
    &&mode!==`add_${flow.recipientKind}`)throw new ValidationError('The contact type must match the original request.');
  if(flow.kind==='missing_email'&&!['once','save'].includes(mode))
    throw new ValidationError('Choose whether to save the email on this contact.');
  const original=latest.intent.resolvedRequestText||latest.message;
  const request={...latest.intent.controlPlane?.args,...latest.intent,action:'send_email'};
  request.recipientEmail=email;
  request.recipientMode=flow.kind==='missing_contact'?mode:null;
  request.saveEmailToContact=flow.kind==='missing_email'&&mode==='save';
  const message=flow.kind==='missing_contact'
    ?`${mode==='one_off'?'Send once without adding':`Add ${flow.name} as a ${mode.slice(4)} and send`} to ${email}`
    :`${mode==='save'?'Save and use':'Use once'} ${email} for ${flow.name}`;
  const provider=options.provider||(config.ai.configured?createProviderUnobserved(config.ai.provider,config.ai.tier('fast')):null);
  const result=await prepareAction(database,ctx,`${original} — ${message}`,request,{
    emailDraftProvider:provider?require('../commercial/model').wrap(database,ctx,provider,'ask',
      `${options.usageKey||newId('askusage')}:email-draft`):null});
  const storedIntent={...request,intent:'action',resolvedRequestText:original,
    ...(result.proposal?{proposalId:result.proposal.id,
      proposalHref:result.proposal.href||`/actions/${result.proposal.id}`}:{})};
  result.interactionId=await storeInteraction(database,ctx,message,storedIntent,result);
  return result;
}

async function reviseEmailProposal(database,ctx,id,input){
  const subject=trimOrNull(input.subject);const body=trimOrNull(input.body);
  if(!subject||subject.length>200||!body||body.length>6000)
    throw new ValidationError('The email needs a subject and message within the allowed length.');
  return database.transaction(async(client)=>{
    const proposal=await getProposal(database,ctx.workspaceId,id,true,client);
    if(proposal.actor_user_id!==ctx.actorId||proposal.action_type!=='communication.send_email'
      ||proposal.status!=='PENDING')throw new ValidationError('That email draft is no longer editable.');
    const payload={...proposal.payload,subject,body,draftPolished:false,editedByOwner:true};
    await client.query(`UPDATE stockchief_runtime.assistant_action_proposals SET payload=$3::jsonb
      WHERE workspace_id=$1 AND id=$2 AND status='PENDING'`,[ctx.workspaceId,id,JSON.stringify(payload)]);
    return payload;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function getProposal(database,workspaceId,id,lock=false,client=database) {
  const result=await client.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals
    WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[workspaceId,id]);
  if(!result.rows.length)throw new NotFoundError('That prepared change could not be found.');
  return result.rows[0];
}

async function supersedePendingProposal(database,ctx,oldId,newId,args){
  return database.transaction(async(client)=>{
    const old=await getProposal(database,ctx.workspaceId,oldId,true,client);
    const replacement=await getProposal(database,ctx.workspaceId,newId,true,client);
    if(old.actor_user_id!==ctx.actorId||replacement.actor_user_id!==ctx.actorId)
      throw new ValidationError('The prepared change does not belong to this user.');
    if(old.status!=='PENDING'){
      await client.query(`UPDATE stockchief_runtime.assistant_action_proposals
        SET status='CANCELLED',cancelled_at=now() WHERE workspace_id=$1 AND id=$2 AND status='PENDING'`,
      [ctx.workspaceId,newId]);return false;
    }
    if(replacement.status!=='PENDING')throw new ValidationError('The replacement is no longer waiting for review.');
    await client.query(`UPDATE stockchief_runtime.assistant_action_proposals
      SET status='CANCELLED',cancelled_at=now() WHERE workspace_id=$1 AND id=$2 AND status='PENDING'`,
    [ctx.workspaceId,oldId]);
    const plans=(await client.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 AND actor_user_id=$2 AND status='WAITING' AND steps @> $3::jsonb FOR UPDATE`,
    [ctx.workspaceId,ctx.actorId,JSON.stringify([{proposalId:oldId}])])).rows;
    for(const plan of plans){
      const steps=plan.steps;const step=steps.find((entry)=>entry.proposalId===oldId);
      if(!step)continue;
      if(old.action_type===replacement.action_type){
        step.proposalId=newId;step.args=args;step.state='WAITING';step.reason=null;
      }else{step.state='BLOCKED';step.reason='changed_operation';}
      const waiting=steps.find((entry)=>entry.state==='WAITING');
      await client.query(`UPDATE stockchief_runtime.assistant_capability_plans
        SET steps=$3::jsonb,status=$4,waiting_proposal_id=$5,updated_at=now()
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,plan.id,JSON.stringify(steps),
        waiting?'WAITING':'BLOCKED',waiting?.proposalId||null]);
    }
    return true;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function continueApprovedPlans(database,ctx,proposalId){
  const rawProvider=config.ai.configured?createProviderUnobserved(config.ai.provider,config.ai.tier('fast')):null;
  const provider=fundedAskProvider(database,ctx,rawProvider,`plan:${proposalId}`);
  return require('./postgres-capability-plans').resume(database,ctx,proposalId,{
    service:capabilityService(),provider,rawProvider,
    record:(plan,index,outcome)=>recordCapabilityOutcome(database,ctx,plan.source_message,outcome,
      {batchId:plan.batch_id,planId:plan.id,index,count:plan.steps.length}),
  });
}

async function executeProposal(database,ctx,id) {
  await entitlements.assertCapability(database,await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId),'ask.prepare_actions');
  const committed=await database.transaction(async(client)=>{
    const proposal=await getProposal(database,ctx.workspaceId,id,true,client);
    if(proposal.status==='EXECUTED')return {...proposal,replayed:true};
    if(proposal.status!=='PENDING')throw new InvariantError('That prepared change is no longer waiting for approval.',
      'proposal_not_pending');
    const contract=require('./postgres-capability-registry').registry.get(proposal.action_type);
    if(!contract||contract.kind!=='mutation')throw new InvariantError('That prepared action is not registered.','proposal_action_unknown');
    const actor=(await client.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,ctx.actorId])).rows[0];
    require('../actions/permissions').assertCan(actor,contract.permission,contract.name);
    if(contract.ownerOnly&&actor.role!=='owner')throw new ValidationError(
      'Only this inventory’s owner can approve that connection change.');
    if(contract.commercialCapability)await entitlements.assertCapability(client,
      await entitlements.ownerScopeForWorkspace(client,ctx.workspaceId),contract.commercialCapability);
    for(const capability of contract.additionalCommercialCapabilities||[])await entitlements.assertCapability(client,
      await entitlements.ownerScopeForWorkspace(client,ctx.workspaceId),capability);
    const payload={...proposal.payload,idempotencyKey:proposal.idempotency_key};
    const result=await contract.execute(client,ctx,payload);
    if(!await contract.verifyExecution(client,ctx,result,payload))
      throw new InvariantError('StockChief could not verify the resulting business record. Nothing was committed.',
        'proposal_result_unverified');
    const changed=await client.query(`UPDATE stockchief_runtime.assistant_action_proposals
      SET status='EXECUTED',result=$3::jsonb,executed_at=now() WHERE workspace_id=$1 AND id=$2 AND status='PENDING'
      RETURNING *`,[ctx.workspaceId,id,JSON.stringify(result)]);
    if(!changed.rows.length)throw new InvariantError('That prepared change was updated by another request.','proposal_changed');
    return {...changed.rows[0],replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
  try{return {...committed,continued:await continueApprovedPlans(database,ctx,id)};}
  catch(error){
    console.warn('[stockchief] Ask plan continuation failed',JSON.stringify({
      code:error.code||error.name||'unknown',
      frame:String(error.stack||'').split('\n').slice(1,3).map((line)=>line.trim()).join(' | '),
    }));
    return {...committed,continuationError:error.message};
  }
}

async function cancelProposal(database,ctx,id) {
  const result=await database.query(`UPDATE stockchief_runtime.assistant_action_proposals
    SET status='CANCELLED',cancelled_at=now() WHERE workspace_id=$1 AND id=$2 AND status='PENDING' RETURNING *`,
  [ctx.workspaceId,id]);
  if(!result.rows.length)throw new InvariantError('That prepared change is no longer waiting.','proposal_not_pending');
  await continueApprovedPlans(database,ctx,id).catch(()=>{});
  return result.rows[0];
}

module.exports={lookup,ask:askCapabilities,listInteractions,
  continueEmail,reviseEmailProposal,getProposal,executeProposal,cancelProposal,
  fundedAskProvider};

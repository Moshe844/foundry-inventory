'use strict';

const config = require('../config');
const { createProviderUnobserved } = require('../ai/provider');
const inventory = require('../domain/postgres-inventory-engine');
const transfers = require('../transfers/postgres-transfer-service');
const catalog = require('../domain/postgres-catalog-service');
const locations = require('../domain/postgres-location-service');
const operatingInstructions = require('../manager/postgres-operating-instructions');
const pricing = require('../pricing/postgres-service');
const outboundMail = require('../connections/postgres-outbound-mail');
const workflows = require('../operations/postgres-business-workflows');
const { ValidationError, NotFoundError, InvariantError } = require('../domain/errors');
const { newId, trimOrNull } = require('../lib/util');

const VIEWS = ['inventory','locations','purchase_orders','sales_orders','suppliers','customers','shipping','payments','accounting','connections'];
const ACTIONS = ['receive','issue','transfer','adjust','create_item','create_location','set_price','set_purchase_cost',
  'send_email','create_sales_order','create_purchase_order','receive_purchase_order','record_supplier_payment'];
const PLAN_SCHEMA = {
  type:'object',additionalProperties:false,
  required:['intent','view','action','search','sku','location','fromLocation','toLocation','quantity','countedQuantity',
    'amount','currency','reason','reference','recipient','recipientKind','subject','body','mailbox','customer','supplier',
    'deliveryMethod','shipToAddress','neededBy','purchaseOrder','supplierBill','receiptReference','paymentMethod','paymentDate'],
  properties:{
    intent:{type:'string',enum:['lookup','action','instruction','clarify']},
    view:{anyOf:[{type:'string',enum:VIEWS},{type:'null'}]},
    action:{anyOf:[{type:'string',enum:ACTIONS},{type:'null'}]},
    search:{type:['string','null'],maxLength:160},sku:{type:['string','null'],maxLength:160},
    location:{type:['string','null'],maxLength:160},fromLocation:{type:['string','null'],maxLength:160},
    toLocation:{type:['string','null'],maxLength:160},quantity:{type:['integer','null'],minimum:0},
    countedQuantity:{type:['integer','null'],minimum:0},reason:{type:['string','null'],maxLength:120},
    amount:{type:['number','null'],minimum:0},currency:{type:['string','null'],maxLength:3},
    reference:{type:['string','null'],maxLength:160},
    recipient:{type:'string',maxLength:200},recipientKind:{type:'string',enum:['','customer','supplier']},
    subject:{type:'string',maxLength:300},body:{type:'string',maxLength:10000},mailbox:{type:'string',maxLength:200},
    customer:{type:'string',maxLength:200},supplier:{type:'string',maxLength:200},
    deliveryMethod:{type:'string',enum:['','SHIP','PICKUP','OWN_DELIVERY']},
    shipToAddress:{type:'string',maxLength:500},neededBy:{type:'string',maxLength:10},
    purchaseOrder:{type:'string',maxLength:160},supplierBill:{type:'string',maxLength:160},
    receiptReference:{type:'string',maxLength:160},paymentMethod:{type:'string',maxLength:120},
    paymentDate:{type:'string',maxLength:10},
  },
};
const SYSTEM=`Classify and extract one request to an inventory operations system. Return only the schema.
Use lookup when the person asks what is true. Use action only when they want StockChief to create or change a record.
Use instruction for a lasting rule, preference, threshold, supplier term, stock protection rule, or bounded authority
that should continue applying in the future. One-time work is action, not instruction.
Never invent a product, SKU, location, quantity, reason or reference. Missing values are null.
view is the business dataset needed for a lookup. action is one of the allowed action values.
search is the exact business name, order number, status or phrase they named, without command words.
For receive, issue, transfer and adjust, sku is the product/SKU wording exactly as stated.
For receive and issue, location is the stated place. For transfer, use fromLocation and toLocation.
Use set_price for customer selling-price changes and set_purchase_cost for supplier or purchase-cost changes.
For those actions, sku is the exact product or SKU wording, amount is the stated per-unit amount and currency is its three-letter code.
Use send_email when the person asks to email, message, write to or contact a customer, supplier or email address.
For send_email, recipient is only the named recipient, recipientKind is customer or supplier only when stated,
subject and body are only words explicitly supplied, and mailbox is only an explicitly named connected mailbox.
Use create_sales_order only when the person asks to prepare or record a customer order. Extract customer, SKU, quantity,
deliveryMethod, shipToAddress and neededBy only when stated. Use SHIP, PICKUP or OWN_DELIVERY for deliveryMethod.
Use create_purchase_order only when the person asks to buy stock or prepare a supplier purchase order. Extract supplier,
SKU, quantity, destination inventory location, amount and currency only when stated.
Use receive_purchase_order only when the person says physical goods arrived against a purchase order. Extract the exact
purchaseOrder number, SKU, quantity, receiving location and receiptReference such as a delivery note only when stated.
Use record_supplier_payment only when the person says a supplier bill was paid. Extract supplier, supplierBill number,
amount, currency, paymentMethod, paymentDate and reference only when stated. An invoice is not a physical receipt.
Use an empty string for missing recipient, recipientKind, subject, body, mailbox, customer, supplier, deliveryMethod,
shipToAddress, neededBy, purchaseOrder, supplierBill, receiptReference, paymentMethod or paymentDate values; other missing values are null.
quantity is the movement quantity; countedQuantity is the physical count after an adjustment.`;

function cleanReference(value) {
  const reference=trimOrNull(value);
  return reference ? trimOrNull(reference.replace(/[.,;:!?]+$/,'')) : null;
}

function inventoryLookupSearch(message){
  const text=String(message||'').trim();
  const patterns=[
    /\b(?:how many|how much)\s+(.+?)\s+(?:are|is)\s+(?:currently\s+)?(?:on hand|available|in stock|left)\b/i,
    /\b(?:on hand|available|in stock)\s+(?:for|of)\s+(.+?)(?=\s+(?:at|in|across|and|where)\b|[?.!,]|$)/i,
    /\bwhere\s+(?:is|are)\s+(.+?)\s+(?:held|stocked|stored|located)\b/i,
  ];
  const value=trimOrNull(patterns.map((pattern)=>pattern.exec(text)?.[1]).find(Boolean));
  if(!value)return null;
  const cleaned=trimOrNull(value.replace(/^(?:the|our|my)\s+/i,''));
  return /^(?:inventory|items?|products?|skus?|stock|units?)$/i.test(cleaned||'')?null:cleaned;
}

function lookupSearchPatterns(value){
  const original=trimOrNull(value);
  if(!original)return [];
  const parts=original.split(/\s+/);const last=parts.at(-1);
  let singular=last;
  if(/ies$/i.test(last)&&last.length>3)singular=`${last.slice(0,-3)}y`;
  else if(/(?:sses|xes|zes|ches|shes)$/i.test(last)&&last.length>3)singular=last.slice(0,-2);
  else if(/s$/i.test(last)&&!/ss$/i.test(last)&&last.length>3)singular=last.slice(0,-1);
  const values=[original];
  if(singular!==last)values.push([...parts.slice(0,-1),singular].join(' '));
  return [...new Set(values)].map((entry)=>`%${entry}%`);
}

function fallbackPlan(message) {
  const text=String(message || '').trim();
  const lower=text.toLowerCase();
  const inventorySearch=inventoryLookupSearch(text);
  const email=/^(?:please\s+)?(?:send\s+(?:an?\s+)?email\s+to|email|e-mail|message|write\s+to|contact)\s+(.+?)(?:\s+(?:that|saying|to\s+say|and\s+(?:say|tell|ask)|about|regarding)\s+|\s*[—:]\s*)([\s\S]+)$/i.exec(text);
  const emailOnly=/^(?:please\s+)?(?:send\s+(?:an?\s+)?email\s+to|email|e-mail|message|write\s+to|contact)\s+(.+?)\s*[.!]?$/i.exec(text);
  if(email||emailOnly){const recipient=String((email||emailOnly)[1]||'').trim();const role=/^(?:the\s+)?(supplier|vendor|customer|client)\s+(?:named\s+|called\s+)?(.+)$/i.exec(recipient);
    return {intent:'action',view:null,action:'send_email',search:null,sku:null,location:null,fromLocation:null,toLocation:null,
      quantity:null,countedQuantity:null,amount:null,currency:null,reason:null,reference:null,recipient,
      recipientKind:role?(/supplier|vendor/i.test(role[1])?'supplier':'customer'):null,
      subject:null,body:email?String(email[2]).trim():null,mailbox:null};}
  const lasting=/\b(always|whenever|every time|from now on|automatically|without asking|standing rule|prefer)\b/.test(lower)
    || /\b(?:reorder|restock)\b[\s\S]*\b(?:below|under|at)\s+\d+\b/.test(lower);
  if(lasting)return {intent:'instruction',view:null,action:null,search:null,sku:null,location:null,fromLocation:null,
    toLocation:null,quantity:null,countedQuantity:null,reason:null,reference:null};
  const action=/\b(receive|received|came in|issue|issued|sold|used|move|transfer|count|adjust|correct|create|add)\b/.test(lower);
  const priceChange=/\b(set|change|update|make)\b[\s\S]*\b(price|cost)\b|\b(price|cost)\b[\s\S]*\b(to|at|is)\b/.test(lower);
  const purchaseCost=/\b(supplier|vendor|purchase|buying|wholesale|unit)\s+(price|cost)\b|\bpurchase cost\b/.test(lower);
  const money=text.match(/([$£€¥])\s*([\d,]+(?:\.\d{1,2})?)|\b(USD|EUR|GBP|CAD|AUD|JPY)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if(priceChange&&money){
    const target=text.match(/\b(?:for|of)\s+(.+?)\s+(?:to|at|is)\s*(?=[$£€¥]|\b(?:USD|EUR|GBP|CAD|AUD|JPY)\b)/i)?.[1]
      || text.match(/\b(?:price|cost)\s+(?:of|for)\s+(.+?)\s*(?:to|at|is)\s*/i)?.[1]||null;
    const amount=Number(String(money[2]||money[4]).replace(/,/g,''));
    const currency=money[3]?money[3].toUpperCase():({'$':'USD','£':'GBP','€':'EUR','¥':'JPY'}[money[1]]||'USD');
    return {intent:'action',view:null,action:purchaseCost?'set_purchase_cost':'set_price',search:null,sku:trimOrNull(target),
      location:null,fromLocation:null,toLocation:null,quantity:null,countedQuantity:null,amount,currency,reason:null,reference:null};
  }
  let view='inventory';
  if(/\b(purchase order|po\b|buy|supplier order|incoming)\b/.test(lower))view='purchase_orders';
  else if(/\b(sales order|customer order|orders? from customer)\b/.test(lower))view='sales_orders';
  else if(/\bsuppliers?\b/.test(lower))view='suppliers';
  else if(/\bcustomers?\b/.test(lower))view='customers';
  else if(/\b(ship|shipment|tracking|carrier|delivery)\b/.test(lower))view='shipping';
  else if(/\b(payment|paid|owing|outstanding|receivable|payable)\b/.test(lower))view='payments';
  else if(/\b(account|journal|profit|revenue|expense|books|balance)\b/.test(lower))view='accounting';
  else if(/\b(connection|connected|sync|connector)\b/.test(lower))view='connections';
  else if(!inventorySearch&&/\b(location|warehouse|store|bin|shelf)\b/.test(lower))view='locations';
  if(!action)return {intent:'lookup',view,action:null,search:inventorySearch,sku:null,location:null,fromLocation:null,
    toLocation:null,quantity:null,countedQuantity:null,amount:null,currency:null,reason:null,reference:null};
  const verb=/\b(receive|received|came in)\b/.test(lower)?'receive':/\b(issue|issued|sold|used)\b/.test(lower)?'issue':
    /\b(move|transfer)\b/.test(lower)?'transfer':/\b(count|adjust|correct)\b/.test(lower)?'adjust':
      /\b(location|warehouse|store|bin|shelf)\b/.test(lower)?'create_location':'create_item';
  const number=Number(/\b(\d+)\b/.exec(text)?.[1]);
  const quantity=Number.isSafeInteger(number)?number:null;
  const reference=cleanReference(/\b(?:reference|ref)\s*[:#-]?\s*([a-z0-9][a-z0-9._/-]*)/i.exec(text)?.[1]);
  let sku=null;let location=null;let fromLocation=null;let toLocation=null;
  const tail='(?=\\s+(?:with\\s+)?(?:reference|ref)\\b|[,.;]|$)';
  if(verb==='transfer'){
    const move=new RegExp('\\b(?:move|transfer)\\s+\\d+\\s+(?:x\\s+)?(.+?)\\s+from\\s+(.+?)\\s+to\\s+(.+?)'+tail,'i').exec(text);
    if(move){sku=trimOrNull(move[1]);fromLocation=trimOrNull(move[2]);toLocation=trimOrNull(move[3]);}
  }else if(['receive','issue'].includes(verb)){
    const receive=verb==='receive';
    const productPattern=receive
      ? /\b(?:receive(?:d)?|record(?:ed)?|book(?:ed)?\s+in)\s+\d+\s+(?:x\s+)?(.+?)(?=\s+(?:received\s+)?(?:into|at|in|with|reference|ref)\b|[,.;]|$)/i
      : /\b(?:issue(?:d)?|sell|sold|use|used|record(?:ed)?)\s+\d+\s+(?:x\s+)?(.+?)(?=\s+(?:from|at|in|with|reference|ref)\b|[,.;]|$)/i;
    sku=trimOrNull(productPattern.exec(text)?.[1]);
    const placePattern=receive
      ? /\b(?:received\s+)?(?:into|at|in)\s+(.+?)(?=\s+(?:with\s+)?(?:reference|ref)\b|[,.;]|$)/i
      : /\b(?:from|at|in)\s+(.+?)(?=\s+(?:with\s+)?(?:reference|ref)\b|[,.;]|$)/i;
    location=trimOrNull(placePattern.exec(text)?.[1]);
  }
  return {intent:'action',view:null,action:verb,search:null,sku,location,fromLocation,toLocation,
    quantity,countedQuantity:verb==='adjust'?quantity:null,
    amount:null,currency:null,reason:null,reference};
}

function cleanPlan(raw,message) {
  const fallback=fallbackPlan(message);
  if(!raw || !['lookup','action','instruction','clarify'].includes(raw.intent))return fallback;
  const groundedInventoryLookup=raw.intent==='lookup'&&fallback.intent==='lookup'
    &&fallback.view==='inventory'&&fallback.search;
  return {intent:raw.intent,view:groundedInventoryLookup?'inventory':VIEWS.includes(raw.view)?raw.view:fallback.view,
    action:ACTIONS.includes(raw.action)?raw.action:null,
    search:groundedInventoryLookup?fallback.search:trimOrNull(raw.search),sku:trimOrNull(raw.sku),
    location:trimOrNull(raw.location),fromLocation:trimOrNull(raw.fromLocation),toLocation:trimOrNull(raw.toLocation),
    quantity:Number.isSafeInteger(raw.quantity)?raw.quantity:null,
    countedQuantity:Number.isSafeInteger(raw.countedQuantity)?raw.countedQuantity:null,
    amount:Number.isFinite(raw.amount)&&raw.amount>=0?raw.amount:null,
    currency:/^[A-Z]{3}$/.test(String(raw.currency||'').toUpperCase())?String(raw.currency).toUpperCase():null,
    reason:trimOrNull(raw.reason),reference:cleanReference(raw.reference),recipient:trimOrNull(raw.recipient),
    recipientKind:['customer','supplier'].includes(raw.recipientKind)?raw.recipientKind:null,
    subject:trimOrNull(raw.subject),body:trimOrNull(raw.body),mailbox:trimOrNull(raw.mailbox),
    customer:trimOrNull(raw.customer),supplier:trimOrNull(raw.supplier),
    deliveryMethod:['SHIP','PICKUP','OWN_DELIVERY'].includes(raw.deliveryMethod)?raw.deliveryMethod:null,
    shipToAddress:trimOrNull(raw.shipToAddress),neededBy:trimOrNull(raw.neededBy),
    purchaseOrder:trimOrNull(raw.purchaseOrder),supplierBill:trimOrNull(raw.supplierBill),
    receiptReference:trimOrNull(raw.receiptReference),paymentMethod:trimOrNull(raw.paymentMethod),
    paymentDate:trimOrNull(raw.paymentDate)};
}

async function plan(message,options={}) {
  const provider=options.provider || (config.ai.configured?createProviderUnobserved(config.ai.provider,config.ai.tier('fast')):null);
  if(!provider)return fallbackPlan(message);
  try {
    const response=await provider.complete({system:SYSTEM,prompt:JSON.stringify({message}),schema:PLAN_SCHEMA,
      schemaName:'stockchief_postgres_request'});
    return cleanPlan(response.data,message);
  } catch {
    return fallbackPlan(message);
  }
}

function evidenceRow(row,href) {
  return {...row,...(href?{href}:{})};
}

async function lookup(database,ctx,request) {
  const search=trimOrNull(request.search);
  if(request.view==='locations'){
    const rows=(await database.query(`SELECT l.id,l.name,l.kind,COALESCE(SUM(b.on_hand),0) AS units
      FROM locations l LEFT JOIN balances b ON b.location_id=l.id AND b.workspace_id=l.workspace_id
      WHERE l.workspace_id=$1 AND l.is_active=1 AND ($2::text IS NULL OR l.name ILIKE '%'||$2||'%')
      GROUP BY l.id ORDER BY l.name LIMIT 100`,[ctx.workspaceId,search])).rows.map((row)=>
      evidenceRow({name:row.name,kind:row.kind,units:Number(row.units)},`/inventory?location=${row.id}`));
    return {answer:rows.length?`${rows.length} active location${rows.length===1?'':'s'} hold ${rows.reduce((sum,row)=>sum+row.units,0).toLocaleString('en-US')} units.`:
      'No active location matched that request.',rows,columns:['name','kind','units']};
  }
  if(request.view==='purchase_orders'){
    const rows=(await database.query(`SELECT po.id,po.po_number,po.status,s.name AS supplier,
      COALESCE(SUM(pol.quantity_units-pol.quantity_received_units),0) AS outstanding_units
      FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id
      LEFT JOIN purchase_order_lines pol ON pol.purchase_order_id=po.id
      WHERE po.workspace_id=$1 AND ($2::text IS NULL OR po.po_number ILIKE '%'||$2||'%' OR s.name ILIKE '%'||$2||'%'
        OR po.status ILIKE '%'||$2||'%') GROUP BY po.id,s.name ORDER BY po.created_at DESC LIMIT 100`,
    [ctx.workspaceId,search])).rows.map((row)=>evidenceRow({order:row.po_number,status:row.status,supplier:row.supplier,
      outstandingUnits:Number(row.outstanding_units)},`/purchasing/orders/${row.id}`));
    return {answer:rows.length?`${rows.length} purchase order${rows.length===1?'':'s'} matched; ${rows.reduce((sum,row)=>sum+row.outstandingUnits,0).toLocaleString('en-US')} units remain outstanding.`:
      'No purchase order matched that request.',rows,columns:['order','status','supplier','outstandingUnits']};
  }
  if(request.view==='sales_orders'){
    const rows=(await database.query(`SELECT so.id,so.order_number,so.status,c.name AS customer,
      COALESCE(SUM(sol.quantity_ordered-sol.quantity_fulfilled),0) AS open_units
      FROM sales_orders so JOIN customers c ON c.id=so.customer_id LEFT JOIN sales_order_lines sol ON sol.sales_order_id=so.id
      WHERE so.workspace_id=$1 AND ($2::text IS NULL OR so.order_number ILIKE '%'||$2||'%' OR c.name ILIKE '%'||$2||'%'
        OR so.status ILIKE '%'||$2||'%') GROUP BY so.id,c.name ORDER BY so.created_at DESC LIMIT 100`,
    [ctx.workspaceId,search])).rows.map((row)=>evidenceRow({order:row.order_number,status:row.status,customer:row.customer,
      openUnits:Number(row.open_units)},`/sales/orders/${row.id}`));
    return {answer:rows.length?`${rows.length} customer order${rows.length===1?'':'s'} matched; ${rows.reduce((sum,row)=>sum+row.openUnits,0).toLocaleString('en-US')} units remain open.`:
      'No customer order matched that request.',rows,columns:['order','status','customer','openUnits']};
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
    ), incoming AS (
      SELECT sku_id,SUM(quantity) AS quantity FROM (
        SELECT * FROM purchase_incoming UNION ALL SELECT * FROM transfer_incoming
      ) sources GROUP BY sku_id)
    SELECT i.id,i.name,s.code,s.variant_label,COALESCE(SUM(b.on_hand),0) AS on_hand,
      COALESCE(c.quantity,0) AS committed,COALESCE(inc.quantity,0) AS incoming,
      COALESCE(STRING_AGG(DISTINCT l.name, ', ') FILTER (WHERE b.on_hand<>0),'') AS locations
    FROM items i JOIN skus s ON s.item_id=i.id LEFT JOIN balances b ON b.sku_id=s.id
    LEFT JOIN locations l ON l.id=b.location_id AND l.workspace_id=b.workspace_id
    LEFT JOIN committed c ON c.sku_id=s.id LEFT JOIN incoming inc ON inc.sku_id=s.id
    WHERE i.workspace_id=$1 AND i.is_active=1 AND ($2::text IS NULL OR i.name ILIKE ANY($3::text[])
      OR s.code ILIKE ANY($3::text[]) OR COALESCE(s.variant_label,'') ILIKE ANY($3::text[]))
    GROUP BY i.id,s.id,c.quantity,inc.quantity ORDER BY i.name,s.position LIMIT 100`,
  [ctx.workspaceId,search,lookupSearchPatterns(search)])).rows.map((row)=>{
      const onHand=Number(row.on_hand),committed=Number(row.committed),incoming=Number(row.incoming);
      return evidenceRow({product:row.variant_label?`${row.name} · ${row.variant_label}`:row.name,sku:row.code,
        onHand,committed,available:Math.max(0,onHand-committed),incoming,locations:row.locations||'No stock location'},`/inventory/${row.id}`);
    });
  const totals=rows.reduce((sum,row)=>({onHand:sum.onHand+row.onHand,committed:sum.committed+row.committed,
    available:sum.available+row.available,incoming:sum.incoming+row.incoming}),{onHand:0,committed:0,available:0,incoming:0});
  const places=[...new Set(rows.flatMap((row)=>row.locations==='No stock location'?[]:row.locations.split(', ')))];
  const where=places.length?` Stock is in ${places.join(', ')}.`:'';
  return {answer:rows.length?`${rows.length} SKU${rows.length===1?'':'s'} matched with ${totals.onHand.toLocaleString('en-US')} units on hand, ${totals.committed.toLocaleString('en-US')} committed, ${totals.available.toLocaleString('en-US')} available and ${totals.incoming.toLocaleString('en-US')} incoming.${where}`:
    'No product or SKU matched that request.',rows,columns:['product','sku','onHand','committed','available','incoming','locations']};
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
    scope:`s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1`,search:`CONCAT_WS(' ',s.code,i.name,COALESCE(s.variant_label,''))`},
  locations:{select:'id,name,kind',from:'locations',scope:`workspace_id=$1 AND is_active=1`,search:'name'}};
  const target=allowed[table];
  if(!target)throw new TypeError('Unsupported resolution target.');
  const exact=await database.query(`SELECT ${target.select} FROM ${target.from} WHERE ${target.scope}
    AND lower(${target.search})=lower($2) ORDER BY ${columns} LIMIT 12`,[workspaceId,search]);
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

async function prepareAction(database,ctx,message,request) {
  if(!request.action)return {status:'CLARIFY',answer:'What would you like StockChief to change?'};
  if(request.action==='send_email'){
    const recipient=await outboundMail.resolveRecipient(database,ctx.workspaceId,request.recipient,request.recipientKind);
    if(recipient.missing)return {status:'CLARIFY',answer:'Who should StockChief email? Name an existing customer or supplier, or give the exact email address.'};
    if(recipient.notFound)return {status:'CLARIFY',answer:`I could not find a customer or supplier matching “${request.recipient}”. Nothing was prepared.`};
    if(recipient.ambiguous)return {status:'CLARIFY',answer:`“${request.recipient}” matches more than one business contact. Say whether this is the customer or supplier.`,
      choices:recipient.ambiguous.map((row)=>({label:`${row.name} · ${row.kind}`,value:`the ${row.kind} named ${row.name}`}))};
    if(!recipient.row.email)return {status:'CLARIFY',answer:`${recipient.row.name} has no email address. Add it to the ${recipient.row.kind} record before preparing this message.`};
    if(!request.body)return {status:'CLARIFY',answer:`What exactly should the email to ${recipient.row.name} say?`};
    const mailbox=await outboundMail.resolveMailbox(database,ctx.workspaceId,request.mailbox);
    if(mailbox.missing)return {status:'CLARIFY',answer:'Connect and verify a Gmail or Microsoft 365 business mailbox before preparing this email.'};
    if(mailbox.notFound)return {status:'CLARIFY',answer:`No connected business mailbox matches “${request.mailbox}”. Nothing was prepared.`};
    if(mailbox.ambiguous)return {status:'CLARIFY',answer:'More than one business mailbox can send this. Name the exact mailbox to use.',
      choices:mailbox.ambiguous.map((row)=>({label:`${row.display_name}${row.provider_account_name?` · ${row.provider_account_name}`:''}`,value:row.display_name}))};
    const business=(await database.query('SELECT name FROM workspaces WHERE id=$1',[ctx.workspaceId])).rows[0];
    const subject=request.subject||`Message from ${business.name}`;
    return createProposal(database,ctx,message,'communication.send_email',{recipientKind:recipient.row.kind,
      recipientId:recipient.row.id,recipientName:recipient.row.name,recipientEmail:recipient.row.email,subject,body:request.body,
      connectorId:mailbox.row.id,mailboxName:mailbox.row.display_name},
    `Email ${recipient.row.name} at ${recipient.row.email} from ${mailbox.row.display_name}.`);
  }
  if(request.action==='receive_purchase_order'){
    if(!request.purchaseOrder)return {status:'CLARIFY',answer:'Which exact purchase order number did these goods arrive against?'};
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
    if(sku.missing)return {status:'CLARIFY',answer:'Which product or SKU physically arrived?'};
    if(sku.notFound)return {status:'CLARIFY',answer:`I could not find product or SKU “${request.sku}”. Nothing was prepared.`};
    if(sku.ambiguous)return {status:'CLARIFY',answer:`More than one SKU matches “${request.sku}”. Use the exact SKU code.`};
    if(sku.row.tracking_mode!=='quantity')return {status:'CLARIFY',answer:`${sku.row.code} needs its exact ${sku.row.tracking_mode==='serial'?'serial numbers':'lot evidence'}. Open ${order.po_number} and record the physical receipt there.`};
    if(!request.quantity||request.quantity<1)return {status:'CLARIFY',answer:'How many units physically arrived?'};
    if(!request.receiptReference)return {status:'CLARIFY',answer:'What delivery note, packing slip, or receipt reference proves this arrival?'};
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
    if(!locationId)return {status:'CLARIFY',answer:'Which inventory location physically received these goods?'};
    if(!locationName)locationName=(await database.query(`SELECT name FROM locations WHERE id=$1 AND workspace_id=$2 AND is_active=1`,
      [locationId,ctx.workspaceId])).rows[0]?.name||null;
    if(!locationName)return {status:'CLARIFY',answer:'The purchase order destination is no longer active. Choose an active receiving location.'};
    return createProposal(database,ctx,message,'purchase_order.receive',{purchaseOrderId:order.id,
      reference:request.receiptReference,lines:[{lineId:line.id,quantity:request.quantity,locationId}]},
    `Receive ${request.quantity} × ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} on ${order.po_number} into ${locationName}, supported by ${request.receiptReference}.`);
  }
  if(request.action==='record_supplier_payment'){
    const party=await resolveParty(database,'supplier',ctx.workspaceId,request.supplier);
    if(party.missing)return {status:'CLARIFY',answer:'Which supplier was paid?'};
    if(party.notFound)return {status:'CLARIFY',answer:`I could not find supplier “${request.supplier}”. Nothing was prepared.`};
    if(party.ambiguous)return {status:'CLARIFY',answer:'More than one supplier matches that name. Use its exact name.'};
    if(!request.supplierBill)return {status:'CLARIFY',answer:'Which exact supplier bill or supplier invoice number was paid?'};
    const bills=(await database.query(`SELECT * FROM accounting_supplier_bills WHERE workspace_id=$1 AND supplier_id=$2
      AND (lower(bill_number)=lower($3) OR lower(COALESCE(supplier_invoice_number,''))=lower($3))
      ORDER BY created_at DESC`,[ctx.workspaceId,party.row.id,request.supplierBill])).rows;
    if(!bills.length)return {status:'CLARIFY',answer:`I could not find an open bill matching “${request.supplierBill}” for ${party.row.name}. Nothing was prepared.`};
    if(bills.length>1)return {status:'CLARIFY',answer:'More than one bill matches that number. Open Money and choose the exact bill.'};
    const bill=bills[0];
    if(!['OPEN','PARTIALLY_PAID'].includes(bill.status))return {status:'CLARIFY',answer:`${bill.bill_number} is ${bill.status} and is not open for another payment.`};
    if(request.amount===null||request.amount<=0)return {status:'CLARIFY',answer:`How much was paid toward ${bill.bill_number}?`};
    if(!request.paymentDate||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(request.paymentDate))return {status:'CLARIFY',answer:'What exact date was the supplier paid, in YYYY-MM-DD format?'};
    if(!request.paymentMethod)return {status:'CLARIFY',answer:'How was the supplier paid, for example ACH, check, wire, or card?'};
    const amountMinor=pricing.toMinor(String(request.amount),'Payment amount');const currency=request.currency||bill.currency;
    if(request.currency&&request.currency!==bill.currency)return {status:'CLARIFY',answer:`${bill.bill_number} is in ${bill.currency}, not ${request.currency}. Nothing was prepared.`};
    if(amountMinor>Number(bill.balance_minor))return {status:'CLARIFY',answer:`${bill.bill_number} has ${pricing.formatMinor(Number(bill.balance_minor),bill.currency)} outstanding, so ${pricing.formatMinor(amountMinor,currency)} cannot be applied.`};
    return createProposal(database,ctx,message,'supplier_payment.record',{supplierId:party.row.id,supplierBillId:bill.id,
      amountMinor,paymentDate:request.paymentDate,currency,method:request.paymentMethod,reference:request.reference},
    `Record ${pricing.formatMinor(amountMinor,currency)} paid to ${party.row.name} against ${bill.bill_number} on ${request.paymentDate} by ${request.paymentMethod}. Inventory will not change.`);
  }
  if(['create_sales_order','create_purchase_order'].includes(request.action)){
    const sales=request.action==='create_sales_order';
    const party=await resolveParty(database,sales?'customer':'supplier',ctx.workspaceId,sales?request.customer:request.supplier);
    if(party.missing)return {status:'CLARIFY',answer:`Which ${sales?'customer':'supplier'} is this for?`};
    if(party.notFound)return {status:'CLARIFY',answer:`I could not find a ${sales?'customer':'supplier'} matching “${sales?request.customer:request.supplier}”. Nothing was prepared.`};
    if(party.ambiguous)return {status:'CLARIFY',answer:`More than one ${sales?'customer':'supplier'} matches that name. Which one?`,
      choices:party.ambiguous.map((row)=>({label:`${row.name}${row.email?` · ${row.email}`:''}`,value:row.name}))};
    const sku=await resolveOne(database,'skus',ctx.workspaceId,request.sku,'i.name,s.position');
    if(sku.missing)return {status:'CLARIFY',answer:'Which product or SKU is on the order?'};
    if(sku.notFound)return {status:'CLARIFY',answer:`I could not find a product or SKU matching “${request.sku}”. Nothing was prepared.`};
    if(sku.ambiguous)return {status:'CLARIFY',answer:`More than one SKU matches “${request.sku}”. Which one?`,
      choices:sku.ambiguous.map((row)=>({label:`${row.name}${row.variant_label?` · ${row.variant_label}`:''} · ${row.code}`,value:row.code}))};
    if(!request.quantity||request.quantity<1)return {status:'CLARIFY',answer:'How many units are on the order?'};
    if(request.neededBy&&!/^\d{4}-\d{2}-\d{2}$/.test(request.neededBy))return {status:'CLARIFY',answer:'What exact date is needed, in YYYY-MM-DD format?'};
    if(sales){
      if(!request.deliveryMethod)return {status:'CLARIFY',answer:'Should the customer order be shipped, picked up, or delivered by your business?'};
      let fulfillmentLocationId=null;let fulfillmentLocationName=null;
      if(request.location){
        const place=await resolveOne(database,'locations',ctx.workspaceId,request.location,'name');
        if(place.notFound)return {status:'CLARIFY',answer:`I could not find a location matching “${request.location}”. Nothing was prepared.`};
        if(place.ambiguous)return {status:'CLARIFY',answer:'More than one location matches that request. Use its exact name.'};
        fulfillmentLocationId=place.row?.id||null;fulfillmentLocationName=place.row?.name||null;
      }
      if(request.deliveryMethod==='PICKUP'&&!fulfillmentLocationId)return {status:'CLARIFY',answer:'Which location will the customer pick this order up from?'};
      const destination=trimOrNull(request.shipToAddress)||trimOrNull(party.row.shipping_address);
      if(request.deliveryMethod!=='PICKUP'&&!destination)return {status:'CLARIFY',answer:`What is the delivery address for ${party.row.name}? Nothing will be prepared without a destination.`};
      const current=await pricing.currentPrice(database,ctx.workspaceId,sku.row.id);
      const amountMinor=request.amount===null?current.amount_minor:pricing.toMinor(String(request.amount),'Selling price');
      if(amountMinor===null)return {status:'CLARIFY',answer:`What selling price per unit should this order use for ${sku.row.name}?`};
      const currency=request.currency||current.currency||'USD';
      return createProposal(database,ctx,message,'sales_order.create',{customerId:party.row.id,
        deliveryMethod:request.deliveryMethod,shipToAddress:destination,fulfillmentLocationId,neededBy:request.neededBy,
        currency,reference:request.reference,lines:[{skuId:sku.row.id,quantity:request.quantity,unitPriceMinor:amountMinor}]},
      `Prepare a draft customer order for ${party.row.name}: ${request.quantity} × ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} at ${pricing.formatMinor(amountMinor,currency)} each, ${request.deliveryMethod==='PICKUP'?`pickup from ${fulfillmentLocationName}`:`to ${destination}`}.`);
    }
    const place=await resolveOne(database,'locations',ctx.workspaceId,request.location,'name');
    if(place.missing)return {status:'CLARIFY',answer:'Which inventory location should receive this purchase order?'};
    if(place.notFound)return {status:'CLARIFY',answer:`I could not find a location matching “${request.location}”. Nothing was prepared.`};
    if(place.ambiguous)return {status:'CLARIFY',answer:'More than one location matches that request. Use its exact name.'};
    const supplierItem=(await database.query(`SELECT * FROM supplier_items WHERE workspace_id=$1 AND supplier_id=$2
      AND sku_id=$3 AND is_active=1`,[ctx.workspaceId,party.row.id,sku.row.id])).rows[0]||null;
    const unitCost=request.amount===null?(supplierItem?.last_unit_cost===null||supplierItem?.last_unit_cost===undefined
      ?null:Number(supplierItem.last_unit_cost)):request.amount;
    if(unitCost===null)return {status:'CLARIFY',answer:`What is ${party.row.name}'s cost per inventory unit for ${sku.row.name}?`};
    const currency=request.currency||party.row.currency||'USD';
    return createProposal(database,ctx,message,'purchase_order.create',{supplierId:party.row.id,
      destinationLocationId:place.row.id,currency,expectedDate:request.neededBy,reference:request.reference,
      lines:[{skuId:sku.row.id,quantityUnits:request.quantity,unitCost,destinationLocationId:place.row.id}]},
    `Prepare a draft purchase order to ${party.row.name}: ${request.quantity} × ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} for ${place.row.name} at ${pricing.formatMinor(Math.round(unitCost*100),currency)} per inventory unit.`);
  }
  if(request.action==='create_item'){
    if(!request.search && !request.sku)return {status:'CLARIFY',answer:'What is the product name?'};
    return createProposal(database,ctx,message,'catalog.create_item',{name:request.search || request.sku,trackingMode:'quantity'},
      `Create product “${request.search || request.sku}” counted by quantity.`);
  }
  if(request.action==='create_location'){
    if(!request.search && !request.location)return {status:'CLARIFY',answer:'What is the location name?'};
    return createProposal(database,ctx,message,'location.create',{name:request.search || request.location,kind:'warehouse'},
      `Create warehouse location “${request.search || request.location}”.`);
  }
  const sku=await resolveOne(database,'skus',ctx.workspaceId,request.sku,'i.name,s.position');
  if(sku.missing)return {status:'CLARIFY',answer:'Which product or SKU is this for?'};
  if(sku.notFound)return {status:'CLARIFY',answer:`I could not find a product or SKU matching “${request.sku}”. Nothing was prepared.`};
  if(sku.ambiguous)return {status:'CLARIFY',answer:`More than one SKU matches “${request.sku}”. Which one?`,
    choices:sku.ambiguous.map((row)=>({label:`${row.name}${row.variant_label?` · ${row.variant_label}`:''} · ${row.code}`,value:row.code}))};
  if(['set_price','set_purchase_cost'].includes(request.action)){
    if(request.amount===null)return {status:'CLARIFY',answer:`What ${request.action==='set_price'?'selling price':'purchase cost'} per unit should StockChief use?`};
    const currency=request.currency||'USD';const current=request.action==='set_price'?
      await pricing.currentPrice(database,ctx.workspaceId,sku.row.id):await pricing.purchaseCost(database,ctx.workspaceId,sku.row.id);
    const actionType=request.action==='set_price'?'catalog.set_price':'catalog.set_purchase_cost';
    const label=request.action==='set_price'?'selling price':'purchase cost';
    return createProposal(database,ctx,message,actionType,{skuId:sku.row.id,amountMinor:pricing.toMinor(String(request.amount),label),
      currency,expectedCurrentId:current?.id||null},`Set ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} ${label} to ${pricing.formatMinor(pricing.toMinor(String(request.amount),label),currency)}.`);
  }
  if(sku.row.tracking_mode!=='quantity')return {status:'CLARIFY',answer:`${sku.row.name} is ${sku.row.tracking_mode}-tracked. Include the exact ${sku.row.tracking_mode==='lot'?'lot or batch':'serial numbers'} before StockChief prepares the movement.`};
  if(request.action==='transfer'){
    const from=await resolveOne(database,'locations',ctx.workspaceId,request.fromLocation,'name');
    const to=await resolveOne(database,'locations',ctx.workspaceId,request.toLocation,'name');
    if(from.missing || to.missing)return {status:'CLARIFY',answer:'Which location is stock moving from, and which location is it moving to?'};
    if(from.notFound || to.notFound)return {status:'CLARIFY',answer:'One of those locations is not in this inventory. Nothing was prepared.'};
    if(from.ambiguous || to.ambiguous)return {status:'CLARIFY',answer:'More than one location matches that request. Use the exact source and destination names.'};
    if(!request.quantity || request.quantity<1)return {status:'CLARIFY',answer:'How many units should move?'};
    return createProposal(database,ctx,message,'inventory.transfer',{skuId:sku.row.id,sourceLocationId:from.row.id,
      destinationLocationId:to.row.id,quantity:request.quantity,reference:request.reference},
    `Move ${request.quantity} × ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} from ${from.row.name} to ${to.row.name}.`);
  }
  const place=await resolveOne(database,'locations',ctx.workspaceId,request.location,'name');
  if(place.missing)return {status:'CLARIFY',answer:'Which location is this for?'};
  if(place.notFound)return {status:'CLARIFY',answer:`I could not find a location matching “${request.location}”. Nothing was prepared.`};
  if(place.ambiguous)return {status:'CLARIFY',answer:'More than one location matches that request. Use its exact name.'};
  if(request.action==='adjust'){
    if(request.countedQuantity===null)return {status:'CLARIFY',answer:'What was the physical count?'};
    if(!request.reason)return {status:'CLARIFY',answer:'Why is the count being corrected?'};
    return createProposal(database,ctx,message,'inventory.adjust',{skuId:sku.row.id,locationId:place.row.id,
      countedQuantity:request.countedQuantity,reasonCode:'physical_count',notes:request.reason,reference:request.reference},
    `Correct ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} at ${place.row.name} to ${request.countedQuantity}. Reason: ${request.reason}.`);
  }
  if(!request.quantity || request.quantity<1)return {status:'CLARIFY',answer:'How many units?'};
  const type=request.action==='receive'?'inventory.receive':'inventory.issue';
  return createProposal(database,ctx,message,type,{skuId:sku.row.id,locationId:place.row.id,quantity:request.quantity,
    reasonCode:request.action==='issue'?'other':undefined,notes:request.reason,reference:request.reference},
  `${request.action==='receive'?'Receive':'Issue'} ${request.quantity} × ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} ${request.action==='receive'?'into':'from'} ${place.row.name}.`);
}

async function createProposal(database,ctx,message,actionType,payload,summary) {
  const id=newId('pgprop');
  const key=`assistant:${id}`;
  await database.query(`INSERT INTO stockchief_runtime.assistant_action_proposals
    (id,workspace_id,actor_user_id,action_type,payload,summary,source_message,idempotency_key)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,[id,ctx.workspaceId,ctx.actorId,actionType,JSON.stringify(payload),summary,message,key]);
  return {status:'PREPARED',answer:`${summary} Nothing has changed yet. Review and approve the exact change.`,proposal:{id,summary,actionType}};
}

async function storeInteraction(database,ctx,message,intent,result) {
  const id=newId('pgask');
  await database.query(`INSERT INTO stockchief_runtime.assistant_interactions
    (id,workspace_id,actor_user_id,message,intent,answer,evidence,status)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)`,[id,ctx.workspaceId,ctx.actorId,message,JSON.stringify(intent),
    result.answer,JSON.stringify(result.rows || []),result.status]);
  return id;
}

async function ask(database,ctx,message,options={}) {
  const clean=String(message || '').trim();
  if(!clean)throw new ValidationError('Ask a question or describe what should happen.');
  const intent=await plan(clean,options);
  const result=intent.intent==='action'?await prepareAction(database,ctx,clean,intent):
    intent.intent==='instruction'?await prepareInstruction(database,ctx,clean,options):
    intent.intent==='lookup'?{status:'ANSWERED',...(await lookup(database,ctx,intent))}:
      {status:'CLARIFY',answer:'What would you like StockChief to find or change?',rows:[],columns:[]};
  const storedIntent=result.proposal?{...intent,proposalId:result.proposal.id,proposalHref:result.proposal.href||`/actions/${result.proposal.id}`}:intent;
  result.interactionId=await storeInteraction(database,ctx,clean,storedIntent,result);
  result.intent=intent;
  return result;
}

async function prepareInstruction(database,ctx,message,options={}){
  const proposal=await operatingInstructions.interpret(database,ctx,message,options);
  if(proposal.questions.length)return {status:'CLARIFY',answer:proposal.questions[0],proposal:{id:proposal.id,
    summary:proposal.summary,actionType:'operating.instruction',href:`/operating-instructions/${proposal.id}`}};
  return {status:'PREPARED',answer:`${proposal.summary} Nothing is in force yet. Review the exact limits and approve once.`,
    proposal:{id:proposal.id,summary:proposal.summary,actionType:'operating.instruction',href:`/operating-instructions/${proposal.id}`}};
}

async function listInteractions(database,workspaceId,limit=20) {
  const result=await database.query(`SELECT * FROM stockchief_runtime.assistant_interactions
    WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`,[workspaceId,Math.min(100,Math.max(1,limit))]);
  return result.rows.reverse().map((row)=>({...row,intent:row.intent || {},evidence:row.evidence || []}));
}

async function getProposal(database,workspaceId,id,lock=false,client=database) {
  const result=await client.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals
    WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[workspaceId,id]);
  if(!result.rows.length)throw new NotFoundError('That prepared change could not be found.');
  return result.rows[0];
}

async function executeProposal(database,ctx,id) {
  return database.transaction(async(client)=>{
    const proposal=await getProposal(database,ctx.workspaceId,id,true,client);
    if(proposal.status==='EXECUTED')return {...proposal,replayed:true};
    if(proposal.status!=='PENDING')throw new InvariantError('That prepared change is no longer waiting for approval.',
      'proposal_not_pending');
    const payload={...proposal.payload,idempotencyKey:proposal.idempotency_key};
    let result;
    if(proposal.action_type==='inventory.receive')result=await inventory.receiveInTransaction(client,ctx,payload);
    else if(proposal.action_type==='inventory.issue')result=await inventory.issueInTransaction(client,ctx,payload);
    else if(proposal.action_type==='inventory.transfer'){
      const requested=await transfers.requestInTransaction(client,ctx,{fromLocationId:payload.sourceLocationId,
        toLocationId:payload.destinationLocationId,reference:payload.reference,idempotencyKey:payload.idempotencyKey,
        lines:[{skuId:payload.skuId,quantity:payload.quantity}]});
      const approved=await transfers.approveInTransaction(client,ctx,requested.id,
        {idempotencyKey:`${payload.idempotencyKey}:approve`});
      result={transferId:approved.id,transferNumber:approved.transfer_number,status:approved.status,
        quantity:approved.totals.approved,physicalState:'Stock is reserved at the source; nothing has left yet.'};
    }
    else if(proposal.action_type==='inventory.adjust')result=await inventory.adjustInTransaction(client,ctx,payload);
    else if(proposal.action_type==='catalog.create_item')result=await catalog.createItemInTransaction(client,ctx,payload);
    else if(proposal.action_type==='location.create')result=await locations.createLocationInTransaction(client,ctx,payload);
    else if(proposal.action_type==='catalog.set_price')result=await pricing.setPriceInTransaction(client,ctx,payload);
    else if(proposal.action_type==='catalog.set_purchase_cost')result=await pricing.setPurchaseCostInTransaction(client,ctx,payload);
    else if(proposal.action_type==='communication.send_email')result=await outboundMail.queueInTransaction(client,ctx,payload,proposal.idempotency_key);
    else if(proposal.action_type==='sales_order.create')result=await workflows.createSalesOrderInTransaction(client,ctx,payload);
    else if(proposal.action_type==='purchase_order.create')result=await workflows.createPurchaseOrderInTransaction(client,ctx,payload);
    else if(proposal.action_type==='purchase_order.receive')result=await workflows.receivePurchaseOrderInTransaction(client,ctx,payload.purchaseOrderId,payload);
    else if(proposal.action_type==='supplier_payment.record')result=await workflows.recordSupplierPaymentInTransaction(client,ctx,payload);
    else throw new InvariantError('That prepared action is not executable.','proposal_action_unknown');
    const changed=await client.query(`UPDATE stockchief_runtime.assistant_action_proposals
      SET status='EXECUTED',result=$3::jsonb,executed_at=now() WHERE workspace_id=$1 AND id=$2 AND status='PENDING'
      RETURNING *`,[ctx.workspaceId,id,JSON.stringify(result)]);
    if(!changed.rows.length)throw new InvariantError('That prepared change was updated by another request.','proposal_changed');
    return {...changed.rows[0],replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function cancelProposal(database,ctx,id) {
  const result=await database.query(`UPDATE stockchief_runtime.assistant_action_proposals
    SET status='CANCELLED',cancelled_at=now() WHERE workspace_id=$1 AND id=$2 AND status='PENDING' RETURNING *`,
  [ctx.workspaceId,id]);
  if(!result.rows.length)throw new InvariantError('That prepared change is no longer waiting.','proposal_not_pending');
  return result.rows[0];
}

module.exports={PLAN_SCHEMA,SYSTEM,plan,lookup,ask,listInteractions,getProposal,executeProposal,cancelProposal};

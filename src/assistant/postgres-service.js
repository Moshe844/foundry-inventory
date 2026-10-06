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
const accountingReports = require('../accounting/postgres-reports');
const evidenceAnswers = require('./postgres-evidence-answer');
const projections = require('../projections/postgres-service');
const autonomy = require('../autopilot/postgres-service');
const entitlements=require('../entitlements/postgres-service');
const { ValidationError, NotFoundError, InvariantError } = require('../domain/errors');
const { newId, trimOrNull } = require('../lib/util');

const VIEWS = ['inventory','inventory_summary','needs_you','replenishment','locations','purchase_orders','sales_orders','sales_activity','suppliers','customers','shipping','payments',
  'payables','receivables','accounting','connections','business_analysis','general_knowledge'];
const ACTIONS = ['receive','issue','transfer','adjust','create_item','create_location','set_price','set_purchase_cost',
  'send_email','create_sales_order','create_purchase_order','receive_purchase_order','record_supplier_payment'];
const PLAN_PART_SCHEMA = {
  type:'object',additionalProperties:false,
  required:['requestText','continuesPrevious','clarifyingQuestion','intent','view','action','search','sku','skuReference','location','fromLocation','toLocation','quantity','countedQuantity',
    'amount','currency','reason','reference','recipient','recipientKind','subject','body','mailbox','customer','supplier',
    'deliveryMethod','shipToAddress','neededBy','purchaseOrder','supplierBill','receiptReference','paymentMethod','paymentDate'],
  properties:{
    requestText:{type:'string',maxLength:2000},
    continuesPrevious:{type:'boolean'},
    clarifyingQuestion:{type:'string',maxLength:300},
    intent:{type:'string',enum:['lookup','action','instruction','clarify']},
    view:{anyOf:[{type:'string',enum:VIEWS},{type:'null'}]},
    action:{anyOf:[{type:'string',enum:ACTIONS},{type:'null'}]},
    search:{type:['string','null'],maxLength:160},sku:{type:['string','null'],maxLength:160},
    skuReference:{type:'string',enum:['','stocked']},
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
const PLAN_SCHEMA={type:'object',additionalProperties:false,required:['parts'],properties:{
  parts:{type:'array',minItems:1,maxItems:8,items:PLAN_PART_SCHEMA},
}};
const FOLLOWUP_SCHEMA={type:'object',additionalProperties:false,
  required:['disposition','value','currency'],properties:{
    disposition:{type:'string',enum:['answer','unknown','new_request']},
    value:{type:'string',maxLength:500},currency:{type:'string',maxLength:3},
  }};
const SYSTEM=`Decompose and extract the person's complete message into one or more requests to an inventory operations system. Return only the schema.
Preserve every distinct question, instruction and requested action. Never silently omit a requirement. Each parts entry must contain
one request and requestText must be the exact portion of the person's message represented by that entry. Keep dependent wording with
the request it qualifies. Use one part when the message contains only one request and no more than eight parts total.
The input may include context with the previous unanswered user request and StockChief's clarification. Resolve conversational replies before classifying intent: a short name, SKU, location, quantity, price, date, or yes/no that directly answers the clarification is a continuation of the previous task, not a new lookup. In that case set continuesPrevious=true and make requestText a complete restatement of the combined request, INCLUDING the new message's detail. Populate the corresponding schema field from that detail; never drop the new answer. Carry forward only details actually supplied in the previous request or new message. If the new message is a clearly independent request, set continuesPrevious=false, ignore context, and use the new message alone. Without context, always set continuesPrevious=false.
Use lookup when the person asks what is true. Use action only when they want StockChief to create or change a record.
If the person asks StockChief to carry out a supported action but leaves out a recipient, product, quantity, or other detail, still choose that action and leave the missing field empty; StockChief will ask the precise follow-up before preparing anything.
If the person says they need more stock or asks StockChief to get more, use create_purchase_order to prepare a draft purchase order, even if they do not say "purchase order". Do not treat a need for future stock as goods physically received, and never increase on-hand stock for this request.
If they refer to whichever product is currently in stock without naming it, use skuReference="stocked" and sku=null. StockChief will inspect current inventory and resolve it only if exactly one SKU has positive on-hand quantity. Use skuReference="" when no such reference was made. Do not ask for the SKU before the inventory check.
Use instruction for a lasting rule, preference, threshold, supplier term, stock protection rule, or bounded authority
that should continue applying in the future. One-time work is action, not instruction.
Never invent a product, SKU, location, quantity, reason or reference. Missing values are null.
view is the business dataset needed for a lookup. action is one of the allowed action values.
Use payables for open supplier/vendor bills and amounts the business owes. Use receivables for open customer invoices
and amounts customers owe the business. Use payments only for payment transactions or payment history, never for balances owed.
Use needs_you when the person asks what needs their attention, review, approval, or decision.
Use replenishment when the person asks what stock to buy, reorder, or restock next; it reads existing StockChief recommendations and check status, and never places an order.
Use inventory_summary for business-wide product and SKU totals; use inventory for stock quantities or named products.
Use sales_activity for business-wide questions about whether any sales or customer orders are recorded, or how many sales/orders are recorded in one period. It summarizes recorded customer orders, fulfilled units, and posted revenue; it does not filter by customer or order number.
Use sales_orders to list customer orders or find orders for a named customer, order number, or status. Preserve the exact named customer, order number, or status in search.
Use business_analysis for comparisons, trends, reasons, or questions that need figures from more than one business dataset. It can read posted financials when allowed on this plan, customer order counts, and the last business-check time. Use inventory_summary for inventory totals.
Use general_knowledge for questions that can be answered without this business's records, such as explaining a business term or principle.
If none of the listed business datasets or actions can answer the request, use clarify with a null view. Never choose a nearby dataset merely to return an answer.
When intent is clarify, clarifyingQuestion must be one plain, specific question that would let the owner continue; otherwise use an empty string. Never invent a business fact in that question.
When a sales summary names a time period, preserve that exact wording in requestText. Never infer an unstated time window; StockChief validates the period against the person's words. If the requested period cannot be supported, use clarify.
search is only an explicitly named business entity, order number, or record status, without command words. General words such as any, anything, yet, sales, and this month are not search filters. Never set a search filter on sales_activity or business_analysis; use sales_orders for a filtered order list.
For receive, issue, transfer and adjust, sku is the product/SKU wording exactly as stated.
For receive and issue, location is the stated place. For transfer, use fromLocation and toLocation.
Use set_price for customer selling-price changes and set_purchase_cost for supplier or purchase-cost changes.
For those actions, sku is the exact product or SKU wording, amount is the stated per-unit amount and currency is its three-letter code.
Use send_email when the person asks to email, message, write to or contact a customer, supplier or email address.
For send_email, recipient is only the named recipient, recipientKind is customer or supplier only when stated,
subject and body are only words explicitly supplied, and mailbox is only an explicitly named connected mailbox.
Use create_sales_order only when the person asks to prepare or record a customer order. Extract customer, SKU, quantity,
deliveryMethod, shipToAddress and neededBy only when stated. Use SHIP, PICKUP or OWN_DELIVERY for deliveryMethod.
Use create_purchase_order when the person asks to buy or obtain more stock, or prepare a supplier purchase order. Extract supplier,
SKU, quantity, destination inventory location, amount and currency only when stated.
Use receive_purchase_order only when the person says physical goods arrived against a purchase order. Extract the exact
purchaseOrder number, SKU, quantity, receiving location and receiptReference such as a delivery note only when stated.
Use record_supplier_payment only when the person says a supplier bill was paid. Extract supplier, supplierBill number,
amount, currency, paymentMethod, paymentDate and reference only when stated. An invoice is not a physical receipt.
Use an empty string for missing recipient, recipientKind, subject, body, mailbox, customer, supplier, deliveryMethod,
shipToAddress, neededBy, purchaseOrder, supplierBill, receiptReference, paymentMethod or paymentDate values; other missing values are null.
quantity is the movement quantity; countedQuantity is the physical count after an adjustment.`;

const REQUEST_START='(?:move|transfer|receive|received|issue|issued|sell|sold|email|e-mail|message|write|contact|create|add|set|change|update|record|buy|prepare|what|how|where|which|did|do|show|list|tell)';

function splitRequestTexts(message){
  const text=String(message||'').trim();
  const marked=text.replace(new RegExp(`\\s*(?:;|\\n+|,?\\s+and\\s+|,?\\s+then\\s+|,?\\s+also\\s+)(?=(?:please\\s+)?${REQUEST_START}\\b)`,'gi'),'\n');
  const parts=marked.split(/\n+/).map((part)=>part.trim()).filter(Boolean);
  return parts.length>1?parts:[text];
}

function cleanReference(value) {
  const reference=trimOrNull(value);
  return reference ? trimOrNull(reference.replace(/[.,;:!?]+$/,'')) : null;
}

function recordHandoff(kind,name,extras={}) {
  const params=new URLSearchParams({name:String(name||'').trim()});
  if(kind==='customer'&&trimOrNull(extras.shippingAddress))params.set('shippingAddress',trimOrNull(extras.shippingAddress));
  const label=kind==='customer'?`Add ${name} as a customer`:`Add ${name} as a supplier`;
  return {href:kind==='customer'?`/sales/customers/new?${params}`:`/suppliers?${params}#add-supplier`,label};
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

function wholeInventoryLookup(message){
  const text=String(message||'').toLowerCase();
  return /\bhow many\s+(?:items?|products?|skus?|units?)\b/.test(text)
    || /\b(?:total|overall)\s+(?:items?|products?|skus?|units?|inventory|stock)\b/.test(text)
    || /\bhow much\s+(?:inventory|stock)\b/.test(text);
}

function financialSummaryLookup(message){
  const text=String(message||'').toLowerCase();
  return /\b(?:did|have|are|were|am)\s+(?:i|we|the business|my business|our business)\s+(?:make|made|earn|earned|lose|lost|losing)\b/.test(text)
    || /\b(?:profit|profitable|loss|net income|gross profit|money made|money lost|earnings)\b/.test(text);
}

function financialChangeLookup(message){
  const text=String(message||'').toLowerCase();
  return /\bwhy\b[\s\S]*\b(?:profit|margin|earnings|net income)\b|\bwhat (?:changed|hurt|drove)\b[\s\S]*\b(?:profit|margin|earnings)\b/.test(text);
}

function financialBalanceViews(message){
  const text=String(message||'').toLowerCase();
  const question=/\b(?:what|which|show|list|tell|how much|how many|any|do|does|are|is)\b/.test(text);
  if(!question)return [];
  const payables=/\baccounts? payable\b|\ba\/?p\b|\bpayables?\b|\b(?:supplier|vendor)s?\s+(?:balances?|bills?|invoices?)\b|\b(?:unpaid|open|outstanding|due)\s+(?:supplier|vendor)\s+(?:bills?|invoices?)\b|\b(?:owe|owed|owing)\s+(?:to\s+)?(?:our\s+)?(?:supplier|vendor)s?\b|\bdue\s+to\s+(?:our\s+)?(?:supplier|vendor)s?\b/.test(text)
    || /\bwhat\s+(?:do|does)\s+(?:we|i|the business|our business|my business)\s+owe\b/.test(text);
  const receivables=/\baccounts? receivable\b|\ba\/?r\b|\breceivables?\b|\bcustomer\s+(?:balances?|invoices?|money)\b|\b(?:unpaid|open|outstanding|due)\s+customer\s+(?:balances?|invoices?|money)\b|\bcustomers?\s+(?:owe|owes|owed|owing)\s+(?:us|me|the business)\b|\bdue\s+from\s+(?:our\s+)?customers?\b/.test(text)
    || /\bwhat\s+(?:do|does)\s+(?:our\s+)?customers?\s+owe\b/.test(text);
  return [...(payables?['payables']:[]),...(receivables?['receivables']:[])];
}

function financialBalancePlans(requestText,intent=null){
  const views=financialBalanceViews(requestText);
  if(!views.length)return [];
  return views.map((view)=>({requestText,intent:{...(intent||cleanPlan(null,requestText)),intent:'lookup',view,
    action:null,search:views.length===1?trimOrNull(intent?.search):null}}));
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
  const wholeInventory=wholeInventoryLookup(text);
  const financialSummary=financialSummaryLookup(text);
  const financialChange=financialChangeLookup(text);
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
  else if(financialBalanceViews(text).includes('payables'))view='payables';
  else if(financialBalanceViews(text).includes('receivables'))view='receivables';
  else if(/\bsuppliers?\b/.test(lower))view='suppliers';
  else if(/\bcustomers?\b/.test(lower))view='customers';
  else if(/\b(ship|shipment|tracking|carrier|delivery)\b/.test(lower))view='shipping';
  else if(/\b(payment|paid|owing|outstanding|receivable|payable)\b/.test(lower))view='payments';
  else if(financialSummary||/\b(account|journal|profit|revenue|expense|books|balance)\b/.test(lower))view='accounting';
  else if(/\b(connection|connected|sync|connector)\b/.test(lower))view='connections';
  else if(!inventorySearch&&/\b(locations?|warehouses?|stores?|bins?|shelves?)\b/.test(lower))view='locations';
  else if(wholeInventory)view='inventory_summary';
  if(!action)return {intent:'lookup',view,action:null,
    search:financialChange?'profit_change':financialSummary?'profit_and_loss':wholeInventory?null:inventorySearch,sku:null,location:null,fromLocation:null,
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
  if(!raw)return fallback;
  if(!['lookup','action','instruction','clarify'].includes(raw.intent))return {intent:'clarify',view:null,action:null,
    clarifyingQuestion:'I could not reliably understand that request. Could you say what you want to know or change?'};
  const source=raw;
  const invalidLookup=source.intent==='lookup'&&!VIEWS.includes(source.view);
  const requestedTimeframe=explicitTimeframe(message);
  return {intent:invalidLookup?'clarify':source.intent,
    view:source.intent==='clarify'||invalidLookup?null:VIEWS.includes(source.view)?source.view:fallback.view,
    timeframe:requestedTimeframe||'all_time',
    clarifyingQuestion:invalidLookup?'What business information should I check?':trimOrNull(source.clarifyingQuestion),
    action:source.intent==='clarify'?null:ACTIONS.includes(source.action)?source.action:null,
    search:trimOrNull(source.search),sku:trimOrNull(source.sku),skuReference:source.skuReference==='stocked'?'stocked':'',
    location:trimOrNull(source.location),fromLocation:trimOrNull(source.fromLocation),toLocation:trimOrNull(source.toLocation),
    quantity:Number.isSafeInteger(source.quantity)?source.quantity:null,
    countedQuantity:Number.isSafeInteger(source.countedQuantity)?source.countedQuantity:null,
    amount:Number.isFinite(source.amount)&&source.amount>=0?source.amount:null,
    currency:/^[A-Z]{3}$/.test(String(source.currency||'').toUpperCase())?String(source.currency).toUpperCase():null,
    reason:trimOrNull(source.reason),reference:cleanReference(source.reference),recipient:trimOrNull(source.recipient),
    recipientKind:['customer','supplier'].includes(source.recipientKind)?source.recipientKind:null,
    subject:trimOrNull(source.subject),body:trimOrNull(source.body),mailbox:trimOrNull(source.mailbox),
    customer:trimOrNull(source.customer),supplier:trimOrNull(source.supplier),
    deliveryMethod:['SHIP','PICKUP','OWN_DELIVERY'].includes(source.deliveryMethod)?source.deliveryMethod:null,
    shipToAddress:trimOrNull(source.shipToAddress),neededBy:trimOrNull(source.neededBy),
    purchaseOrder:trimOrNull(source.purchaseOrder),supplierBill:trimOrNull(source.supplierBill),
    receiptReference:trimOrNull(source.receiptReference),paymentMethod:trimOrNull(source.paymentMethod),
    paymentDate:trimOrNull(source.paymentDate)};
}

function explicitTimeframe(message){
  const text=String(message||'').toLowerCase();
  if(/\b(?:today|this day)\b/.test(text))return 'today';
  if(/\b(?:this month|month to date|mtd)\b/.test(text))return 'month_to_date';
  if(/\b(?:last month|previous month)\b/.test(text))return 'previous_month';
  if(/\b(?:last|past)\s+30\s+days\b/.test(text))return 'last_30_days';
  if(/\b(?:yesterday|tomorrow|tonight|morning|afternoon|week|quarter|year|since|until|between|before|after|january|february|march|april|june|july|august|september|october|november|december)\b/.test(text)
    ||/\b(?:in|for|during|of)\s+may\b/.test(text)||/\b(?:last|past|next)\s+\d+\s+days?\b/.test(text)
    ||/\b\d{4}-\d{2}(?:-\d{2})?\b/.test(text))return 'unsupported';
  return null;
}

async function planMany(message,options={}) {
  const provider=options.provider || (config.ai.configured?createProviderUnobserved(config.ai.provider,config.ai.tier('fast')):null);
  let context=options.context||null;
  if(provider&&options.context?.awaitingField&&options.context?.previousIntent?.action){
    const continued=await planClarificationReply(message,options.context,options.followupProvider||provider);
    if(continued?.newRequest)context=null;
    else if(continued)return [continued];
  }
  if(!provider)return splitRequestTexts(message).flatMap((requestText)=>financialBalancePlans(requestText)
    .concat(financialBalanceViews(requestText).length?[]:[{requestText,intent:cleanPlan(null,requestText)}])).slice(0,8);
  try {
    const response=await provider.complete({system:SYSTEM,prompt:JSON.stringify({message,
      ...(context?{context}:{})}),schema:PLAN_SCHEMA,
      schemaName:'stockchief_postgres_request'});
    if(options.onUsage&&response.usage)await options.onUsage(response.usage,{schemaName:'stockchief_postgres_request'});
    const rawParts=Array.isArray(response.data?.parts)&&response.data.parts.length?response.data.parts:[response.data];
    return rawParts.slice(0,8).flatMap((raw)=>{const continued=Boolean(context&&raw?.continuesPrevious);
      const requestText=continued?(trimOrNull(raw?.requestText)||message)
        :rawParts.length===1?message:(trimOrNull(raw?.requestText)||message);
      const intent=cleanPlan(raw,requestText);const balances=intent.intent==='lookup'?financialBalancePlans(requestText,intent):[];
      return balances.length?balances.map((entry)=>({...entry,continued})):[{requestText,intent,continued}];}).slice(0,8);
  } catch(error) {
    if(error.usage&&options.onUsage)await options.onUsage(error.usage,{schemaName:'stockchief_postgres_request',failed:true});
    if(['entitlement_required','validation_error'].includes(error.code))throw error;
    return [{requestText:message,intent:{intent:'clarify',view:null,action:null,
      interpretationUnavailable:true}}];
  }
}

async function planClarificationReply(message,context,provider){
  try{
    const response=await provider.complete({system:`Decide whether the person's new message answers StockChief's immediately preceding clarification. The pending task and exact missing field are provided. A short name, code, number, amount, date, or place can be an answer. Return disposition=answer only when it actually supplies the missing field; value must contain only that supplied value, not a guess from context. For an amount, use digits with an optional decimal point and put an explicitly stated three-letter currency in currency. Return unknown when the person cannot provide the detail. Return new_request for an independent question or task. Never execute an action.`,
      prompt:JSON.stringify({pendingRequest:context.previousUserMessage,
        question:context.previousAssistantQuestion,missingField:context.awaitingField,message}),
      schema:FOLLOWUP_SCHEMA,schemaName:'stockchief_postgres_followup'});
    if(response.data?.disposition==='new_request')return {newRequest:true};
    if(response.data?.disposition!=='answer')return null;
    const value=trimOrNull(response.data.value);if(!value)return null;
    const field=context.awaitingField;const intent={...context.previousIntent};
    if(field==='quantity'||field==='countedQuantity'){
      if(!/^\d+$/.test(value)||Number(value)<(field==='quantity'?1:0)||!Number.isSafeInteger(Number(value)))return null;
      intent[field]=Number(value);
    }else if(field==='amount'){
      if(!/^\d+(?:\.\d{1,2})?$/.test(value))return null;
      intent.amount=Number(value);
      if(/^[A-Z]{3}$/.test(response.data.currency))intent.currency=response.data.currency;
    }else if(['sku','supplier','customer','location','fromLocation','toLocation','purchaseOrder','supplierBill',
      'recipient','mailbox','paymentMethod','paymentDate','neededBy','receiptReference','shipToAddress','body',
      'reason','reference','search'].includes(field)){
      if(!String(message).toLowerCase().includes(value.toLowerCase()))return null;
      intent[field]=value;
      if(field==='sku')intent.skuReference='';
    }else if(field==='deliveryMethod'){
      if(!['SHIP','PICKUP','OWN_DELIVERY'].includes(value))return null;
      intent.deliveryMethod=value;
    }else return null;
    const requestText=`${context.previousUserMessage} — ${message}`;
    return {requestText,intent,continued:true};
  }catch(error){
    if(['entitlement_required','validation_error'].includes(error.code))throw error;
    return null;
  }
}

async function plan(message,options={}) {
  return (await planMany(message,options))[0].intent;
}

function evidenceRow(row,href) {
  return {...row,...(href?{href}:{})};
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
      (SELECT COUNT(*) FROM skus WHERE workspace_id=$1 AND is_active=1) AS skus`,[ctx.workspaceId])).rows[0];
    const products=Number(count.products),skus=Number(count.skus);
    return {answer:`You have ${products.toLocaleString('en-US')} active ${products===1?'product':'products'} in StockChief, across ${skus.toLocaleString('en-US')} ${skus===1?'SKU':'SKUs'}.`,
      rows:[{products,skus}],columns:['products','skus'],handoff:{href:'/inventory',label:'Open inventory'}};
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
    return {answer:rows.length?`${rows.length===100?'Showing the first 100':rows.length} customer order${rows.length===1?'':'s'} ${search?'matched':'recorded'}; ${rows.reduce((sum,row)=>sum+row.openUnits,0).toLocaleString('en-US')} units remain open.`:
      search?'No customer order matched that request.':'No customer orders are recorded in StockChief. Sales through systems that are not connected or imported here would not appear in this list.',
      rows,columns:['order','status','customer','openUnits']};
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
      const outcome=result<0?`The business has lost ${money(Math.abs(result))} this month.`:
        result>0?`The business has earned ${money(result)} this month.`:'The business has broken even so far this month.';
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
      due:row.due_date||'Not set',balance:pricing.formatMinor(Number(row.balance_minor),row.currency),currency:row.currency},href));
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

async function prepareAction(database,ctx,message,request) {
  if(!request.action)return {status:'CLARIFY',answer:'What would you like StockChief to change?'};
  if(request.action==='send_email'){
    const commercialScope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);
    const emailAccess=await entitlements.capabilityState(database,commercialScope,'connection.email');
    if(!emailAccess.enabled)return {status:'CLARIFY',answer:'Connected supplier and customer email is available on Growth and above. Nothing was prepared or sent.',
      handoff:{href:'/upgrade?capability=connection.email&return=/ask',label:'Review email automation plans'}};
    const recipient=await outboundMail.resolveRecipient(database,ctx.workspaceId,request.recipient,request.recipientKind);
    if(recipient.missing)return {status:'CLARIFY',answer:'Who should StockChief email? Name an existing customer or supplier, or give the exact email address.',awaitingField:'recipient'};
    if(recipient.notFound){
      const kind=request.recipientKind||null;
      return {status:'CLARIFY',answer:kind
        ?`I could not find ${kind} “${request.recipient}”. Add the ${kind} record first, then return here to prepare the email. Nothing was prepared.`
        :`I could not find a customer or supplier matching “${request.recipient}”. Say whether this is a customer or supplier, or give the exact email address. Nothing was prepared.`,
      handoff:kind?recordHandoff(kind,request.recipient):null};
    }
    if(recipient.ambiguous)return {status:'CLARIFY',answer:`“${request.recipient}” matches more than one business contact. Say whether this is the customer or supplier.`,
      choices:recipient.ambiguous.map((row)=>({label:`${row.name} · ${row.kind}`,value:`the ${row.kind} named ${row.name}`}))};
    if(!recipient.row.email)return {status:'CLARIFY',answer:`${recipient.row.name} has no email address. Add it to the ${recipient.row.kind} record before preparing this message.`};
    if(!request.body)return {status:'CLARIFY',answer:`What exactly should the email to ${recipient.row.name} say?`,awaitingField:'body'};
    const mailbox=await outboundMail.resolveMailbox(database,ctx.workspaceId,request.mailbox);
    if(mailbox.missing)return {status:'CLARIFY',answer:'Connect and verify a Gmail or Microsoft 365 business mailbox before preparing this email.'};
    if(mailbox.notFound)return {status:'CLARIFY',answer:`No connected business mailbox matches “${request.mailbox}”. Nothing was prepared.`};
    if(mailbox.ambiguous)return {status:'CLARIFY',answer:'More than one business mailbox can send this. Name the exact mailbox to use.',awaitingField:'mailbox',
      choices:mailbox.ambiguous.map((row)=>({label:`${row.display_name}${row.provider_account_name?` · ${row.provider_account_name}`:''}`,value:row.display_name}))};
    const business=(await database.query('SELECT name FROM workspaces WHERE id=$1',[ctx.workspaceId])).rows[0];
    const subject=request.subject||`Message from ${business.name}`;
    return createProposal(database,ctx,message,'communication.send_email',{recipientKind:recipient.row.kind,
      recipientId:recipient.row.id,recipientName:recipient.row.name,recipientEmail:recipient.row.email,subject,body:request.body,
      connectorId:mailbox.row.id,mailboxName:mailbox.row.display_name},
    `Email ${recipient.row.name} at ${recipient.row.email} from ${mailbox.row.display_name}.`);
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
    const sku=await resolveRequestedSku(database,ctx.workspaceId,request);
    if(sku.stockEmpty)return {status:'CLARIFY',answer:'I could not find any product currently in stock. Which product should StockChief get more of? Nothing was prepared.',awaitingField:'sku'};
    if(sku.missing)return {status:'CLARIFY',answer:`Which product or SKU ${sales?'is on the customer order':'do you need more of'}?`,awaitingField:'sku'};
    if(sku.notFound)return {status:'CLARIFY',answer:`I could not find a product or SKU matching “${request.sku}”. Nothing was prepared.`};
    if(sku.ambiguous)return {status:'CLARIFY',answer:sku.fromCurrentStock
      ?'I found more than one product currently in stock. Which one needs more? Nothing was prepared.'
      :`More than one SKU matches “${request.sku}”. Which one?`,awaitingField:'sku',
    choices:sku.ambiguous.map((row)=>({label:`${row.name}${row.variant_label?` · ${row.variant_label}`:''} · ${row.code}${row.stocked_units?` · ${row.stocked_units} on hand`:''}`,value:row.code}))};
    const skuContext={sku:sku.row.code,skuReference:''};
    if(!request.quantity||request.quantity<1)return {status:'CLARIFY',answer:'How many units are needed?',awaitingField:'quantity',carryForward:skuContext};
    const party=sales?await resolveParty(database,'customer',ctx.workspaceId,request.customer)
      :await resolvePurchaseSupplier(database,ctx.workspaceId,sku.row.id,request.supplier);
    if(party.missing)return {status:'CLARIFY',answer:sales?'Which customer is this for?'
      :`I found ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} (${sku.row.code})${sku.row.stocked_units?` with ${sku.row.stocked_units} on hand`:''}. Which supplier should provide ${request.quantity} more? Nothing was prepared.`,awaitingField:sales?'customer':'supplier',carryForward:skuContext};
    if(party.notFound){
      const kind=sales?'customer':'supplier';const name=sales?request.customer:request.supplier;
      return {status:'CLARIFY',answer:`I could not find ${kind} “${name}”. Add the ${kind} record first, then return here to prepare the order. Nothing was prepared.`,
        handoff:recordHandoff(kind,name,{shippingAddress:request.shipToAddress}),carryForward:skuContext};
    }
    if(party.ambiguous)return {status:'CLARIFY',answer:`More than one ${sales?'customer':'supplier'} could be used. Which one? Nothing was prepared.`,
      awaitingField:sales?'customer':'supplier',carryForward:skuContext,
      choices:party.ambiguous.map((row)=>({label:`${row.name}${row.email?` · ${row.email}`:''}`,value:row.name}))};
    const orderContext={...skuContext,[sales?'customer':'supplier']:party.row.name};
    if(request.neededBy&&!/^\d{4}-\d{2}-\d{2}$/.test(request.neededBy))return {status:'CLARIFY',answer:'What exact date is needed, in YYYY-MM-DD format?'};
    if(sales){
      if(!request.deliveryMethod)return {status:'CLARIFY',answer:'Should the customer order be shipped, picked up, or delivered by your business?',awaitingField:'deliveryMethod',carryForward:orderContext};
      let fulfillmentLocationId=null;let fulfillmentLocationName=null;
      if(request.location){
        const place=await resolveOne(database,'locations',ctx.workspaceId,request.location,'name');
        if(place.notFound)return {status:'CLARIFY',answer:`I could not find a location matching “${request.location}”. Nothing was prepared.`};
        if(place.ambiguous)return {status:'CLARIFY',answer:'More than one location matches that request. Use its exact name.'};
        fulfillmentLocationId=place.row?.id||null;fulfillmentLocationName=place.row?.name||null;
      }
      if(request.deliveryMethod==='PICKUP'&&!fulfillmentLocationId)return {status:'CLARIFY',answer:'Which location will the customer pick this order up from?',awaitingField:'location',carryForward:orderContext};
      const destination=trimOrNull(request.shipToAddress)||trimOrNull(party.row.shipping_address);
      if(request.deliveryMethod!=='PICKUP'&&!destination)return {status:'CLARIFY',answer:`What is the delivery address for ${party.row.name}? Nothing will be prepared without a destination.`,awaitingField:'shipToAddress',carryForward:orderContext};
      const current=await pricing.currentPrice(database,ctx.workspaceId,sku.row.id);
      const amountMinor=request.amount===null?current.amount_minor:pricing.toMinor(String(request.amount),'Selling price');
      if(amountMinor===null)return {status:'CLARIFY',answer:`What selling price per unit should this order use for ${sku.row.name}?`,awaitingField:'amount',carryForward:orderContext};
      const currency=request.currency||current.currency||'USD';
      return createProposal(database,ctx,message,'sales_order.create',{customerId:party.row.id,
        deliveryMethod:request.deliveryMethod,shipToAddress:destination,fulfillmentLocationId,neededBy:request.neededBy,
        currency,reference:request.reference,lines:[{skuId:sku.row.id,quantity:request.quantity,unitPriceMinor:amountMinor}]},
      `Prepare a draft customer order for ${party.row.name}: ${request.quantity} × ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} at ${pricing.formatMinor(amountMinor,currency)} each, ${request.deliveryMethod==='PICKUP'?`pickup from ${fulfillmentLocationName}`:`to ${destination}`}.`);
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
    if(unitCost===null)return {status:'CLARIFY',answer:`What is ${party.row.name}'s cost per inventory unit for ${sku.row.name}?`,awaitingField:'amount',
      carryForward:{...orderContext,location:place.row.name}};
    const currency=request.currency||party.row.currency||'USD';
    return createProposal(database,ctx,message,'purchase_order.create',{supplierId:party.row.id,
      destinationLocationId:place.row.id,currency,expectedDate:request.neededBy,reference:request.reference,
      lines:[{skuId:sku.row.id,quantityUnits:request.quantity,unitCost,destinationLocationId:place.row.id}]},
    `Prepare a draft purchase order to ${party.row.name}: ${request.quantity} × ${sku.row.name}${sku.row.variant_label?` · ${sku.row.variant_label}`:''} for ${place.row.name} at ${pricing.formatMinor(Math.round(unitCost*100),currency)} per inventory unit.`);
  }
  if(request.action==='create_item'){
    if(!request.search && !request.sku)return {status:'CLARIFY',answer:'What is the product name?',awaitingField:'search'};
    return createProposal(database,ctx,message,'catalog.create_item',{name:request.search || request.sku,trackingMode:'quantity'},
      `Create product “${request.search || request.sku}” counted by quantity.`);
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
  const storedIntent={...intent,...(result.carryForward||{}),presentation:{columns:result.columns || [],choices:result.choices || [],handoff:result.handoff || null,
    reason:result.reason||null,awaitingField:result.awaitingField||null}};
  await database.query(`INSERT INTO stockchief_runtime.assistant_interactions
    (id,workspace_id,actor_user_id,message,intent,answer,evidence,status)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)`,[id,ctx.workspaceId,ctx.actorId,message,JSON.stringify(storedIntent),
    result.answer,JSON.stringify(result.rows || []),result.status]);
  return id;
}

async function ask(database,ctx,message,options={}) {
  await require('../commercial/enforcement').workspace(database,ctx.workspaceId,'ask.lookup');
  const clean=String(message || '').trim();
  if(!clean)throw new ValidationError('Ask a question or describe what should happen.');
  const provider=options.provider||(config.ai.configured?createProviderUnobserved(config.ai.provider,config.ai.tier('fast')):null);
  const meteredOptions=provider?{...options,onUsage:null,
    provider:require('../commercial/model').wrap(database,ctx,provider,'ask',`${options.usageKey||newId('askusage')}:plan`),
    followupProvider:require('../commercial/model').wrap(database,ctx,provider,'ask',`${options.usageKey||newId('askusage')}:followup`)}:options;
  const requests=await planMany(clean,meteredOptions);const results=[];const batchId=requests.length>1?newId('pgaskbatch'):null;
  for(let index=0;index<requests.length;index+=1){
    const request=requests[index];const intent=request.intent;
    const synthesisProvider=provider?require('../commercial/model').wrap(database,ctx,provider,'ask',
      `${options.usageKey||newId('askusage')}:answer:${index}`):null;
    const result=intent.intent==='action'?await prepareAction(database,ctx,clean,intent):
      intent.intent==='instruction'?await prepareInstruction(database,ctx,request.requestText,options):
      intent.intent==='lookup'?{status:'ANSWERED',...(await lookup(database,ctx,intent,
        {provider:synthesisProvider,question:request.requestText}))}:
        {status:'CLARIFY',answer:intent.interpretationUnavailable
          ?'I could not reliably understand that request just now. Nothing was changed. Please try again.'
          :intent.clarifyingQuestion||'I cannot confirm an answer or safe action from the connected business records for that request. What should I check or change?',
        rows:[],columns:[],reason:intent.interpretationUnavailable?'unavailable':null};
    const requestContext={...(request.continued?{resolvedRequestText:request.requestText}:{}),
      ...(requests.length>1?{batchId,sourceMessage:clean,requestIndex:index+1,requestCount:requests.length}:{})};
    const storedIntent=result.proposal?{...intent,...requestContext,proposalId:result.proposal.id,
      proposalHref:result.proposal.href||`/actions/${result.proposal.id}`}:{...intent,...requestContext};
    result.interactionId=await storeInteraction(database,ctx,request.continued?clean:request.requestText,storedIntent,result);
    result.intent=intent;results.push(result);
  }
  return results.length===1?results[0]:{status:results.some((result)=>result.status==='CLARIFY')?'CLARIFY':'ANSWERED',
    answer:`StockChief handled all ${results.length} parts separately.`,results};
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
  return result.rows.map((row)=>({...row,intent:row.intent || {},evidence:row.evidence || []})).sort((left,right)=>{
    const byTime=new Date(left.created_at)-new Date(right.created_at);if(byTime)return byTime;
    if(left.intent.batchId&&left.intent.batchId===right.intent.batchId)return Number(left.intent.requestIndex)-Number(right.intent.requestIndex);
    return String(left.id).localeCompare(String(right.id));
  });
}

async function pendingClarification(database,ctx,startedAt=null){
  const latest=(await database.query(`SELECT message,intent,answer,status FROM stockchief_runtime.assistant_interactions
    WHERE workspace_id=$1 AND actor_user_id=$2 AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
    ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId,ctx.actorId,startedAt])).rows[0];
  if(!latest||latest.status!=='CLARIFY'||['unverified','unavailable'].includes(latest.intent?.presentation?.reason))return null;
  return {previousUserMessage:latest.intent?.resolvedRequestText||latest.message,
    previousAssistantQuestion:latest.answer,previousIntent:cleanPlan(latest.intent,latest.intent?.resolvedRequestText||latest.message),
    awaitingField:latest.intent?.presentation?.awaitingField||null};
}

async function getProposal(database,workspaceId,id,lock=false,client=database) {
  const result=await client.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals
    WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[workspaceId,id]);
  if(!result.rows.length)throw new NotFoundError('That prepared change could not be found.');
  return result.rows[0];
}

async function executeProposal(database,ctx,id) {
  await entitlements.assertCapability(database,await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId),'ask.prepare_actions');
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

module.exports={PLAN_SCHEMA,SYSTEM,plan,planMany,lookup,ask,listInteractions,pendingClarification,
  getProposal,executeProposal,cancelProposal};

'use strict';

/**
 * Ask's vocabulary is made of business contracts, not user utterances. A
 * capability may be offered to the model only when it has a deterministic
 * implementation and an explicit safety contract.
 */
const permissions=require('../actions/permissions');
const {destinations}=require('../product-brain/catalog');
const {EXECUTORS}=require('./postgres-action-executors');
const {RECORDS}=require('../web/postgres-record-destinations');
const {destinationById}=require('../web/postgres-navigation');

const FIELDS=Object.freeze({
  search:{type:'string',description:'Name, code, or status explicitly being sought.'},
  sku:{type:'string',entity:'sku',description:'Product, variant, or SKU identity.'},
  skuScope:{type:'string',description:'Subset of SKUs explicitly referred to: active or currently_stocked.'},
  location:{type:'string',entity:'location',description:'One inventory location.'},
  fromLocation:{type:'string',entity:'location',description:'Source inventory location.'},
  toLocation:{type:'string',entity:'location',description:'Destination inventory location.'},
  quantity:{type:'integer',description:'Number of units being moved or ordered.'},
  countedQuantity:{type:'integer',description:'Physical quantity counted, not a delta.'},
  amount:{type:'number',description:'Monetary amount in major currency units.'},
  currency:{type:'string',description:'Three-letter currency code.'},
  reason:{type:'string',description:'Reason stated by the owner.'},
  reference:{type:'string',description:'External or business reference.'},
  recipient:{type:'string',entity:'contact',description:'Person, customer, supplier, or email address to contact.'},
  recipientKind:{type:'string',description:'customer or supplier, only if established.'},
  subject:{type:'string',description:'Email subject supplied by the owner.'},
  body:{type:'string',description:'Message content supplied by the owner.'},
  mailbox:{type:'string',entity:'mailbox',description:'Connected sending mailbox.'},
  customer:{type:'string',entity:'customer',description:'Customer identity.'},
  supplier:{type:'string',entity:'supplier',description:'Supplier identity.'},
  deliveryMethod:{type:'string',description:'SHIP, PICKUP, or OWN_DELIVERY.'},
  shipToAddress:{type:'string',description:'Customer delivery address.'},
  neededBy:{type:'string',description:'Requested date in YYYY-MM-DD format.'},
  purchaseOrder:{type:'string',entity:'purchase_order',description:'Purchase order identity or number.'},
  supplierBill:{type:'string',entity:'supplier_bill',description:'Supplier bill identity or number.'},
  receiptReference:{type:'string',description:'Delivery note or receipt reference.'},
  paymentMethod:{type:'string',description:'Actual method of a recorded payment.'},
  paymentDate:{type:'string',description:'Payment date in YYYY-MM-DD format.'},
  destination:{type:'string',description:'Registered page or record destination.'},
  recordReference:{type:'string',description:'The stated name, number, or ID of a business record.'},
  timeframe:{type:'string',description:'all_time, today, month_to_date, previous_month, or last_30_days.'},
});

class Registry {
  constructor(){this.entries=new Map();}
  register(entry){
    if(!entry||typeof entry.name!=='string'||!entry.name||this.entries.has(entry.name))
      throw new TypeError('Capability names must be unique and nonempty.');
    if(!entry.description||!Array.isArray(entry.fields)||!entry.kind||!entry.permission||!entry.confirmation
      ||typeof entry.prepare!=='function'||typeof entry.verify!=='function'||typeof entry.validate!=='function'
      ||!entry.authority||!Array.isArray(entry.resultingRecords))
      throw new TypeError(`Incomplete capability contract: ${entry.name}`);
    if(entry.kind==='mutation'&&(typeof entry.execute!=='function'||typeof entry.verifyExecution!=='function'))
      throw new TypeError(`Mutation capability lacks executor or verifier: ${entry.name}`);
    for(const field of entry.fields)if(!FIELDS[field])throw new TypeError(`Unknown capability field ${field}`);
    this.entries.set(entry.name,Object.freeze({...entry,fields:Object.freeze([...entry.fields])}));
    return this;
  }
  get(name){return this.entries.get(name)||null;}
  list(kind=null){return [...this.entries.values()].filter((entry)=>!kind||entry.kind===kind);}
  description(){return this.list().map(({name,description,fields,kind,confirmation})=>({name,description,kind,
    inputs:fields.map((field)=>({name:field,...FIELDS[field]})),confirmation}));}
}

const registry=new Registry();
const add=(name,description,fields,kind,permission,confirmation,prepare,verify,extra={})=>registry.register({
  name,description,fields,kind,permission,confirmation,prepare,verify,
  validate:(args)=>Object.keys(args||{}).every((field)=>fields.includes(field)),
  contextSources:['workspace','current_page','conversation','applicable_settings'],
  authority:kind==='mutation'||kind==='policy'?{mode:'explicit_approval'}:{mode:'none'},
  resultingRecords:[],...extra});

const RESULT_RECORDS={
  'inventory.receive':['movements','balances'],'inventory.issue':['movements','balances'],
  'inventory.transfer':['inventory_transfers'],'inventory.adjust':['adjustments','movements','balances'],
  'catalog.create_item':['items','skus'],'location.create':['locations'],
  'catalog.set_price':['sku_prices'],'catalog.set_purchase_cost':['sku_purchase_costs'],
  'communication.send_email':['business_communication','stockchief_runtime.provider_effects'],
  'sales_order.create':['sales_orders'],'purchase_order.create':['purchase_orders'],
  'purchase_order.receive':['purchase_order_receipts','movements','balances'],
  'supplier_payment.record':['accounting_payments','accounting_journal_entries'],
};

const action=(name,description,fields,permission,legacyAction,extra={})=>add(name,description,fields,'mutation',permission,
  'owner_review',async(service,db,ctx,text,args,options)=>service.prepareAction(db,ctx,text,{...args,action:legacyAction},options),
  async(service,db,ctx,result)=>service.verifyProposal(db,ctx,result),
  {legacyAction,execute:EXECUTORS[name]?.execute,verifyExecution:EXECUTORS[name]?.verify,
    resultingRecords:RESULT_RECORDS[name],...extra});

const REQUIRED={
  'inventory.receive':['sku','location','quantity'],
  'inventory.issue':['sku','location','quantity'],
  'inventory.transfer':['sku','fromLocation','toLocation','quantity'],
  'inventory.adjust':['sku','location','countedQuantity','reason'],
  'catalog.create_item':['search'],
  'location.create':['location'],
  'catalog.set_price':['sku','amount'],
  'catalog.set_purchase_cost':['sku','amount'],
  'communication.send_email':['recipient'],
  'sales_order.create':['customer','sku','quantity'],
  'purchase_order.create':['sku','quantity'],
  'purchase_order.receive':['purchaseOrder','sku','quantity','location'],
  'supplier_payment.record':['supplier','supplierBill','amount','paymentDate','paymentMethod'],
};
action('inventory.receive','Record physically arrived goods as an inventory receipt, updating on-hand stock without requiring a purchase order. Use for an arrival not explicitly tied to an existing purchase order.',
  ['sku','skuScope','location','quantity','reason','reference'],permissions.OPERATE,'receive');
action('inventory.issue','Record a physical removal of goods from inventory.',
  ['sku','skuScope','location','quantity','reason','reference'],permissions.OPERATE,'issue');
action('inventory.transfer','Request and approve a transfer between inventory locations. This reserves stock; dispatch and receipt are separate physical steps.',
  ['sku','skuScope','fromLocation','toLocation','quantity','reference'],permissions.REQUEST_TRANSFER,'transfer');
action('inventory.adjust','Correct a stock position to a verified physical count.',
  ['sku','skuScope','location','countedQuantity','reason','reference'],permissions.ADJUST,'adjust');
action('catalog.create_item','Create a quantity-tracked product record.',
  ['search'],permissions.OPERATE,'create_item');
action('location.create','Create an inventory location.',
  ['location'],permissions.ADMIN,'create_location');
action('catalog.set_price','Change the current customer selling price of a SKU.',
  ['sku','amount','currency'],permissions.OPERATE,'set_price');
action('catalog.set_purchase_cost','Change the recorded current per-unit purchase cost of a SKU, not historical cost of goods sold.',
  ['sku','amount','currency'],permissions.ADMIN,'set_purchase_cost');
action('communication.send_email','Prepare a business email for review; sending requires a connected verified mailbox and explicit approval.',
  ['recipient','recipientKind','subject','body','mailbox'],permissions.OPERATE,'send_email');
action('sales_order.create','Prepare a draft customer order without claiming it was fulfilled.',
  ['customer','sku','skuScope','quantity','deliveryMethod','shipToAddress','location','neededBy','amount','currency','reference'],
  permissions.MANAGE_SALES,'create_sales_order',{allowUnknownEntities:['customer']});
action('purchase_order.create','Prepare a draft order for stock from a supplier; this does not increase on-hand stock.',
  ['supplier','sku','skuScope','quantity','location','amount','currency','neededBy','reference'],
  permissions.CREATE_PO,'create_purchase_order',{allowUnknownEntities:['supplier']});
action('purchase_order.receive','Receive physically arrived goods against an existing placed purchase order. Requires the owner or context to identify the purchase order; an arrival alone does not establish one.',
  ['purchaseOrder','supplier','sku','quantity','location','receiptReference'],permissions.RECEIVE_PO,'receive_purchase_order');
action('supplier_payment.record','Record a payment already made against an open supplier bill; this does not initiate bank payment.',
  ['supplier','supplierBill','amount','currency','paymentMethod','paymentDate','reference'],permissions.RECORD_PAYMENTS,'record_supplier_payment');
for(const [name,required] of Object.entries(REQUIRED)){
  const current=registry.get(name);
  registry.entries.set(name,Object.freeze({...current,required:Object.freeze(required)}));
}

const READS={
  inventory:'Current stock for a product or SKU.',inventory_positions:'Current stock by product and location.',
  inventory_movements:'Recorded stock movements.',inventory_summary:'Business-wide active product, SKU, and on-hand totals, including confirmation that none have been recorded yet. Requires no product or location.',
  prices:'Current recorded selling prices.',purchase_costs:'Current recorded purchase costs.',
  supplier_items:'Supplier-product links, purchasing terms, and costs.',needs_you:'Owner decisions awaiting attention.',
  replenishment:'Recorded replenishment recommendations and their state.',locations:'Inventory locations.',
  purchase_orders:'Supplier purchase orders and their status.',sales_orders:'Customer orders and their status.',
  sales_activity:'Recorded customer order and sales activity for supported time windows.',
  suppliers:'Supplier records.',customers:'Customer records.',shipping:'Shipping records.',
  payments:'Recorded payment transactions.',payables:'Open supplier bill balances.',
  receivables:'Open customer invoice balances.',accounting:'Posted financial records and reports.',
  connections:'Connected business systems.',messages:'Business email records.',
  business_analysis:'Verified comparisons across multiple recorded business datasets.',
  general_knowledge:'General business explanation that does not claim to read this workspace’s records.',
};
for(const [view,description] of Object.entries(READS))add(`read.${view}`,description,
  ['search','timeframe'],'read',permissions.VIEW,'none',
  async(service,db,ctx,text,args,options)=>service.lookup(db,ctx,{view,search:args.search||null,
    timeframe:args.timeframe||'all_time'},{provider:options.answerProvider,question:text}),
  async(_service,_db,_ctx,result)=>Boolean(result&&Array.isArray(result.rows)),{view});
for(const [name,description,search] of [
  ['read.profit_and_loss','Read the current month’s posted profit and loss; never infer unrecorded activity.','profit_and_loss'],
  ['read.profit_change','Explain the change in posted profit against the comparable prior month when the accounting analysis entitlement allows it.','profit_change'],
])add(name,description,[],'read',permissions.VIEW_ACCOUNTING,'none',
  (service,db,ctx,text)=>service.lookup(db,ctx,{view:'accounting',search},{question:text}),
  async(_service,_db,_ctx,result)=>Boolean(result&&Array.isArray(result.rows)),{view:'accounting'});

add('policy.propose','Propose a lasting operating rule within StockChief’s registered policy domains and limits.',
  [],'policy',permissions.ADMIN,'owner_review',
  (service,db,ctx,text,_args,options)=>service.prepareInstruction(db,ctx,text,options),
  async(_service,_db,_ctx,result)=>Boolean(result?.proposal?.id||result?.status==='CLARIFY'));

// The page catalogue is presentation metadata. Each destination is checked
// against the real PostgreSQL router before it is offered by the navigator.
const PAGE_PERMISSIONS={purchasing:permissions.VIEW_PURCHASING,suppliers:permissions.VIEW_PURCHASING,
  sales:permissions.VIEW_SALES,accounting:permissions.VIEW_ACCOUNTING,transfers:permissions.VIEW_TRANSFERS,
  connections:permissions.ADMIN,settings:permissions.ADMIN,operations:permissions.ADMIN,
  autopilot:permissions.ADMIN,actions:permissions.OPERATE};
for(const destination of destinations){
  const page=destinationById(destination.id);if(!page)continue;
  add(`navigate.${destination.id}`,`Open the ${page.label} area.`,
    [],'navigation',PAGE_PERMISSIONS[destination.id]||permissions.VIEW,'none',
    async(service,db,ctx)=>service.navigate(db,ctx,destination.id),
    async(_service,_db,_ctx,result)=>Boolean(result?.href?.startsWith('/')),{destinationId:destination.id});
}
for(const [kind,record] of Object.entries(RECORDS))add(`navigate.record.${kind}`,
  `Open ${record.description}`,['recordReference'],'navigation',record.permission,'none',
  (service,db,ctx,_text,args)=>service.navigateRecord(db,ctx,kind,args.recordReference),
  async(_service,_db,_ctx,result)=>Boolean(result?.href?.startsWith('/')),
  {recordKind:kind,required:['recordReference']});

module.exports={FIELDS,Registry,registry};

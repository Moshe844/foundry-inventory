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
  baseCode:{type:'string',description:'Exact new product SKU or base code explicitly supplied by the owner.'},
  sku:{type:'string',entity:'sku',description:'Product, variant, or SKU identity.'},
  skuScope:{type:'string',description:'Subset of SKUs explicitly referred to: active or currently_stocked.'},
  location:{type:'string',entity:'location',description:'One inventory location.'},
  fromLocation:{type:'string',entity:'location',description:'Source inventory location.'},
  toLocation:{type:'string',entity:'location',description:'Destination inventory location.'},
  quantity:{type:'integer',description:'Number of units being moved or ordered.'},
  countedQuantity:{type:'integer',description:'Physical quantity counted, not a delta.'},
  amount:{type:'number',description:'Monetary amount in major currency units.'},
  tax:{type:'number',description:'Total invoice tax amount in major currency units, when explicitly supplied.'},
  unitAmount:{type:'number',description:'Cost per unit on one supplier bill line, in major currency units.'},
  supplierInvoiceNumber:{type:'string',description:'The exact invoice number appearing on a supplier bill.'},
  currency:{type:'string',description:'Three-letter currency code.'},
  description:{type:'string',description:'The invoice line description when supplied.'},
  issueDate:{type:'string',description:'Invoice issue date in YYYY-MM-DD format.'},
  dueDate:{type:'string',description:'Invoice due date in YYYY-MM-DD format.'},
  reason:{type:'string',description:'Reason stated by the owner.'},
  reference:{type:'string',description:'External or business reference.'},
  recipient:{type:'string',entity:'contact',description:'Person, customer, supplier, or email address to contact.',
    question:'What is the name of the person or business?'},
  recipientKind:{type:'string',description:'customer or supplier, only if established.',
    question:'Should I add this contact as a supplier or customer?'},
  recipientEmail:{type:'string',description:'Exact email address supplied for the recipient, including a contact not yet on file.'},
  contactName:{type:'string',description:'Contact person’s name for an existing supplier.'},
  contactDisplayName:{type:'string',description:'New displayed business name for an existing customer or supplier.'},
  inviteeName:{type:'string',description:'Name of a person to invite to this inventory.'},
  inviteeEmail:{type:'string',description:'Exact email address of a person to invite to this inventory.'},
  memberRole:{type:'string',description:'Requested inventory role: owner, staff, or accountant.'},
  company:{type:'string',description:'Company name for an existing customer.'},
  recipientMode:{type:'string',description:'For an explicitly requested new contact: add_supplier or add_customer. Otherwise omit; a one-off email must not create a contact.'},
  phone:{type:'string',description:'Telephone number supplied for a new business contact.'},
  notes:{type:'string',description:'Notes explicitly supplied for a new business contact.'},
  subject:{type:'string',description:'Email subject supplied by the owner.'},
  body:{type:'string',description:'Message content supplied by the owner.'},
  mailbox:{type:'string',entity:'mailbox',description:'Connected sending mailbox.'},
  customer:{type:'string',entity:'customer',description:'Customer identity.'},
  supplier:{type:'string',entity:'supplier',description:'Supplier identity.'},
  supplierSku:{type:'string',description:'The code this supplier uses for the named product, only when stated.'},
  purchaseUnit:{type:'string',description:'The unit or pack name in which the supplier sells this product.'},
  unitsPerPurchaseUnit:{type:'integer',description:'Number of stock units in one supplier purchase pack.'},
  leadTimeDays:{type:'integer',description:'Supplier lead time for this product, in days.'},
  minimumOrderQuantity:{type:'integer',description:'Supplier minimum order quantity in purchase packs.'},
  orderMultiple:{type:'integer',description:'Supplier order multiple in purchase packs.'},
  isPreferred:{type:'string',description:'Explicit true or false for preferred supplier for this product.'},
  deliveryMethod:{type:'string',description:'SHIP, PICKUP, or OWN_DELIVERY.'},
  shipToAddress:{type:'string',description:'Customer delivery address.'},
  orderDate:{type:'string',description:'Customer order business date in YYYY-MM-DD format, only when explicitly stated.'},
  neededBy:{type:'string',description:'Requested date in YYYY-MM-DD format.'},
  allocationPriority:{type:'integer',description:'Customer-order stock allocation priority, a whole number from 0 to 1000.'},
  purchaseOrder:{type:'string',entity:'purchase_order',description:'Purchase order identity or number.'},
  supplierBill:{type:'string',entity:'supplier_bill',description:'Supplier bill identity or number.'},
  receiptReference:{type:'string',description:'Delivery note or receipt reference.'},
  paymentMethod:{type:'string',description:'Actual method of a recorded payment.'},
  paymentDate:{type:'string',description:'Payment date in YYYY-MM-DD format.'},
  destination:{type:'string',description:'Registered page or record destination.'},
  recordReference:{type:'string',description:'The stated name, number, or ID of a business record.'},
  rate:{type:'string',description:'One exact quoted carrier rate ID or carrier and service name.'},
  paymentPurpose:{type:'string',description:'The requested payment-link purpose, such as balance or full.'},
  returnResolution:{type:'string',description:'One exact customer-return resolution: REFUND (also invoice credit), EXCHANGE, or NO_REFUND.'},
  refundDestination:{type:'string',description:'Exact refund destination: AR to reduce an unpaid invoice, or CASH to return money already paid.'},
  disposition:{type:'string',description:'Physical return disposition: restock, scrap, or repair.'},
  handover:{type:'string',description:'Physical shipping handoff: carrier, collected, or delivered by us.'},
  trackingNumber:{type:'string',description:'Exact carrier tracking number, when provided.'},
  mode:{type:'string',description:'A registered operating mode for the named subsystem; do not invent a mode.'},
  workspaceName:{type:'string',description:'New name of this inventory workspace.'},
  itemName:{type:'string',description:'New display name for an existing product.'},
  itemDescription:{type:'string',description:'New description for an existing product.'},
  baseCode:{type:'string',description:'New base product code, when explicitly requested.'},
  unitLabel:{type:'string',description:'New unit label for an existing product.'},
  allowNegative:{type:'string',description:'Explicit true or false for whether this product permits negative stock.'},
  enabled:{type:'string',description:'Explicit true or false for the named setting.'},
  minimumSeverity:{type:'string',description:'Email alert threshold: critical, important, or all.'},
  mailboxState:{type:'string',description:'The requested business-message state: needs reply, waiting, or handled.'},
  recipientEmails:{type:'string',description:'Comma-separated exact email addresses for business alerts.'},
  carrier:{type:'string',description:'Exact shipping carrier name, if required by the rule.'},
  service:{type:'string',description:'Exact carrier service name, if required by the rule.'},
  maxCost:{type:'number',description:'Maximum acceptable postage cost in major currency units.'},
  maxDeliveryDays:{type:'integer',description:'Maximum delivery time in days, from 1 to 30.'},
  weightGrams:{type:'integer',description:'Measured weight of a single parcel in grams.'},
  lengthMm:{type:'integer',description:'Measured parcel length in millimeters.'},
  widthMm:{type:'integer',description:'Measured parcel width in millimeters.'},
  heightMm:{type:'integer',description:'Measured parcel height in millimeters.'},
  requireByPromised:{type:'string',description:'Explicit true or false: require arrival by the promised date.'},
  statedText:{type:'string',description:'Additional human-readable condition for the shipping rule.'},
  timeframe:{type:'string',description:'all_time, today, month_to_date, previous_month, or last_30_days.'},
  creditNumber:{type:'string',description:'The exact supplier credit-note number.'},
  creditDate:{type:'string',description:'Date on the supplier credit note, YYYY-MM-DD.'},
  statementEndDate:{type:'string',description:'Bank statement ending date, YYYY-MM-DD.'},
  statementEndingBalance:{type:'number',description:'Exact bank statement ending balance in major currency units.'},
  transactionDate:{type:'string',description:'Bank transaction date, YYYY-MM-DD.'},
  externalId:{type:'string',description:'Exact external provider or bank reference ID.'},
  accountCode:{type:'string',description:'Exact StockChief ledger account code.'},
  authority:{type:'string',description:'Accounting connector authority: OBSERVE or POST.'},
  strategy:{type:'string',description:'Fulfillment picking strategy: WAVE, BATCH, or CLUSTER.'},
  scanLocation:{type:'string',description:'Exact location barcode or name physically scanned.'},
  scanItem:{type:'string',description:'Exact product barcode or SKU physically scanned.'},
  lotBarcode:{type:'string',description:'Exact physical lot barcode, if applicable.'},
  serialBarcode:{type:'string',description:'Exact physical serial barcode, if applicable.'},
  serialNumbers:{type:'string',description:'Comma-separated exact physical serial numbers for every unit in a supplier return.'},
  foundQuantity:{type:'integer',description:'Quantity physically found during a warehouse shortage check.'},
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
  description(){return this.list().map((entry)=>({name:entry.name,description:entry.description,
    kind:entry.kind,inputs:entry.fields.map((field)=>({name:field,...FIELDS[field],
      required:Boolean(entry.required?.includes(field))})),contextSources:entry.contextSources,
    permission:entry.permission,authority:entry.authority,confirmation:entry.confirmation,
    resultingRecords:entry.resultingRecords,
    validation:'StockChief resolves references and validates the exact operation before execution',
    executor:entry.kind==='mutation'?'canonical deterministic business service':null,
    verification:entry.kind==='mutation'?'resulting business records checked in the approval transaction':null}));}
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
  'contact.create':['suppliers','customers'],
  'communication.send_email':['business_communication','stockchief_runtime.provider_effects'],
  'sales_order.create':['sales_orders'],'purchase_order.create':['purchase_orders'],
  'customer_invoice.create':['accounting_customer_invoices','accounting_journal_entries'],
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
  'contact.create':['recipient','recipientKind'],
  'communication.send_email':['recipient'],
  'sales_order.create':['customer','sku','quantity'],
  'customer_invoice.create':['customer','quantity'],
  'purchase_order.create':['sku','quantity'],
  'purchase_order.receive':['purchaseOrder','sku','quantity','location'],
  'supplier_payment.record':['supplier','supplierBill','amount','paymentDate','paymentMethod'],
};
action('inventory.receive','Record physically arrived goods without a purchase order as a physical-only receipt. It does not establish supplier liability or inventory book cost; uncosted units cannot be fulfilled as a sale. For valued supplier goods use a placed purchase order receipt.',
  ['sku','skuScope','location','quantity','reason','reference'],permissions.OPERATE,'receive');
action('inventory.issue','Record a physical removal of goods from inventory.',
  ['sku','skuScope','location','quantity','reason','reference'],permissions.OPERATE,'issue');
action('inventory.transfer','Request and approve a transfer between inventory locations. This reserves stock; dispatch and receipt are separate physical steps.',
  ['sku','skuScope','fromLocation','toLocation','quantity','reference'],permissions.REQUEST_TRANSFER,'transfer',
  {resultReference:'transferId',resultDisplayReference:'transferNumber',resultRecordKind:'transfer',
    satisfiesCapabilities:['transfer.approve']});
action('inventory.adjust','Correct a stock position to a verified physical count.',
  ['sku','skuScope','location','countedQuantity','reason','reference'],permissions.ADJUST,'adjust');
action('catalog.create_item','Create a quantity-tracked product record with its exact SKU code when supplied.',
  ['search','baseCode'],permissions.OPERATE,'create_item');
action('location.create','Create an inventory location.',
  ['location'],permissions.ADMIN,'create_location');
action('catalog.set_price','Change the current customer selling price of a SKU.',
  ['sku','amount','currency'],permissions.OPERATE,'set_price');
action('catalog.set_purchase_cost','Change the recorded current per-unit purchase cost of a SKU, not historical cost of goods sold.',
  ['sku','amount','currency'],permissions.ADMIN,'set_purchase_cost');
action('contact.create','Add a new supplier or customer business contact to this inventory. This creates only the contact record; it does not send email, order goods, or move money.',
  ['recipient','recipientKind','recipientEmail','phone','notes'],permissions.OPERATE,'create_contact');
action('communication.send_email','Prepare a business email for review; sending requires a connected verified mailbox and explicit approval.',
  ['recipient','recipientKind','recipientEmail','recipientMode','subject','body','mailbox'],permissions.OPERATE,'send_email',
  {additionalCommercialCapabilities:['connection.email']});
action('sales_order.create','Prepare a draft customer order without fulfillment or payment. The amount input is the selling price PER UNIT, not the order total.',
  ['customer','sku','skuScope','quantity','deliveryMethod','shipToAddress','location','orderDate','neededBy','amount','currency','reference'],
  permissions.MANAGE_SALES,'create_sales_order',{allowUnknownEntities:['customer'],
    resultReference:'salesOrderId',resultDisplayReference:'orderNumber',resultRecordKind:'sales_order'});
action('customer_invoice.create','Prepare a customer invoice for review. Approval records and posts the invoice in StockChief; it does not create or fulfill a customer order, send the invoice, or collect payment.',
  ['customer','sku','quantity','amount','tax','currency','description','issueDate','dueDate','reference'],
  permissions.MANAGE_ACCOUNTING,'create_customer_invoice',{allowUnknownEntities:['customer']});
action('purchase_order.create','Prepare a draft supplier order; amount is cost PER UNIT, not total. Unit cost may remain unknown in draft but must be priced before placement; no on-hand stock changes.',
  ['supplier','sku','skuScope','quantity','location','amount','currency','neededBy','reference'],
  permissions.CREATE_PO,'create_purchase_order',{allowUnknownEntities:['supplier'],
    resultReference:'purchaseOrderId',resultDisplayReference:'poNumber',resultRecordKind:'purchase_order'});
action('purchase_order.receive','Receive physically arrived goods against an existing placed purchase order. Requires the owner or context to identify the purchase order; an arrival alone does not establish one.',
  ['purchaseOrder','supplier','sku','quantity','location','receiptReference'],permissions.RECEIVE_PO,'receive_purchase_order');
action('supplier_payment.record','Record a payment already made against an open supplier bill; this does not initiate bank payment.',
  ['supplier','supplierBill','amount','currency','paymentMethod','paymentDate','reference'],permissions.RECORD_PAYMENTS,'record_supplier_payment');
for(const spec of require('./postgres-workflow-capabilities').SPECS)action(spec.name,spec.description,
  spec.fields,spec.permission,spec.name,{required:[...(spec.record?['recordReference']:[]),...(spec.name==='customer_return.request'
    ?['quantity','reason','location']:[])],commercialCapability:spec.capability,
    additionalCommercialCapabilities:spec.additionalCapabilities||[],
    resultingRecords:spec.record?[spec.record]:spec.resultingRecords||[],recordKind:spec.record||null,
    singleEffectPerTarget:Boolean(spec.singleEffectPerTarget),
    satisfiesCapabilities:spec.satisfiesCapabilities||[],
    ownerOnly:Boolean(spec.ownerOnly),
    discovery:{label:spec.name.replace(/[._]/g,' ').replace(/^./,(letter)=>letter.toUpperCase()),
      prompt:`Help me ${spec.name.replace(/[._]/g,' ')}`,rank:160,
      commercialCapability:spec.capability||null}});
for(const [name,required] of Object.entries(REQUIRED)){
  const current=registry.get(name);
  registry.entries.set(name,Object.freeze({...current,required:Object.freeze(required)}));
}

const READS={
  inventory:'Current SKU stock across the business, including on-hand, committed, available-to-fulfill quantities, incoming, and stock locations.',
  inventory_positions:'Current on-hand stock by product and location only. It does not account for commitments and cannot establish what is available to ship.',
  inventory_movements:'Recorded stock movements.',
  inventory_valuation:'Current recorded inventory book cost by product and location; distinct from supplier purchase quotes.',
  inventory_cost_movements:'Recorded changes in inventory book cost with import file and row provenance.',
  inventory_summary:'Business-wide current and historical inventory setup evidence: active product and SKU counts, total on-hand units, and count of every product record ever created, including inactive records. Valid even when this business is empty; requires no product or location.',
  prices:'Current recorded selling prices.',purchase_costs:'Current supplier or owner-recorded unit purchase costs; not the book value of imported opening inventory.',
  supplier_items:'Supplier-product links, purchasing terms, and costs.',needs_you:'Owner decisions awaiting attention.',
  replenishment:'Recorded replenishment recommendations and their state.',locations:'Inventory locations.',
  purchase_orders:'Read supplier purchase orders, deliveries, linked invoice documents including disputes and exceptions, and the actually posted open payable; PO planned cost and disputed documents are not posted debt.',
  transfers:'Read tracked inventory transfers, their exact workflow state, source and destination, units held at source, departed/in transit, physically received, and unresolved loss or damage. An approved transfer has not physically left.',
  sales_orders:'Read recorded customer orders with ordered, held, fulfilled and open units, invoice and payment balances, and posted sale revenue, product cost and gross profit from fulfillment journals; answers do not change business records.',
  sales_activity:'Recorded customer order and sales activity for supported time windows.',
  suppliers:'Supplier records.',customers:'Customer records.',shipping:'Shipping records.',
  payments:'Recorded payment transactions.',payables:'Open supplier bill balances.',
  receivables:'Open customer invoice balances.',accounting:'Posted financial records and reports.',
  connections:'Connected business systems.',messages:'Business email records.',
  business_analysis:'Verified comparisons across multiple recorded business datasets.',
  general_knowledge:'General business explanation that does not claim to read this workspace’s records.',
};
const READ_RECORD_KINDS={sales_orders:'sales_order',purchase_orders:'purchase_order',transfers:'transfer'};
for(const [view,description] of Object.entries(READS))add(`read.${view}`,description,
  ['search','timeframe'],'read',permissions.VIEW,'none',
  async(service,db,ctx,text,args,options)=>service.lookup(db,ctx,{view,search:args.search||null,
    timeframe:args.timeframe||'all_time'},{provider:options.answerProvider,question:text}),
  async(_service,_db,_ctx,result)=>Boolean(result&&Array.isArray(result.rows)),
  {view,recordKind:READ_RECORD_KINDS[view]||null,
    answerMode:['general_knowledge','business_analysis','inventory_summary'].includes(view)?'executor':'evidence'});
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
  add(`navigate.${destination.id}`,`Change the visible application page to ${page.label}. Use only for a requested page change; it does not answer a question about records or counts.`,
    [],'navigation',PAGE_PERMISSIONS[destination.id]||permissions.VIEW,'none',
    async(service,db,ctx)=>service.navigate(db,ctx,destination.id),
    async(_service,_db,_ctx,result)=>Boolean(result?.href?.startsWith('/')),{destinationId:destination.id});
}
for(const [kind,record] of Object.entries(RECORDS))add(`navigate.record.${kind}`,
  `Open ${record.description}`,['recordReference'],'navigation',record.permission,'none',
  (service,db,ctx,_text,args)=>service.navigateRecord(db,ctx,kind,args.recordReference),
  async(_service,_db,_ctx,result)=>Boolean(result?.href?.startsWith('/')),
  {recordKind:kind,required:['recordReference']});

// Discovery copy lives beside executable contracts. It is not a command
// parser: the model still selects capabilities by meaning, and unavailable
// contracts are removed for each user/workspace before they are suggested.
const DISCOVERY=Object.freeze({
  'read.needs_you':{label:'See what needs your attention',prompt:'What needs my attention?',rank:10},
  'read.inventory':{label:'Check available stock',prompt:'What stock is available to fulfill?',rank:20},
  'read.replenishment':{label:'Review reorder recommendations',prompt:'What should I reorder?',rank:30,
    commercialCapability:'planning.basic',requires:'product'},
  'read.sales_orders':{label:'Review customer orders',prompt:'Which customer orders need work?',rank:40},
  'read.purchase_orders':{label:'Review supplier purchase orders',prompt:'What is happening with our purchase orders?',rank:45},
  'read.payables':{label:'Review unpaid supplier bills',prompt:'Which supplier bills are unpaid?',rank:50},
  'read.messages':{label:'Review recorded business messages',prompt:'What business messages came in?',rank:60},
  'read.profit_and_loss':{label:'Explain posted profit and loss',prompt:'How did we do this month?',rank:70,
    commercialCapability:'accounting.reports'},
  'inventory.receive':{label:'Prepare a stock receipt',prompt:'Help me receive stock',rank:80,
    commercialCapability:'receiving.core'},
  'inventory.transfer':{label:'Prepare an inventory transfer',prompt:'Help me transfer stock',rank:90,
    commercialCapability:'inventory.transfers',requires:'product'},
  'catalog.create_item':{label:'Add a product to the catalog',prompt:'Help me add a product',rank:95},
  'purchase_order.create':{label:'Prepare a purchase order',prompt:'Help me prepare a purchase order',rank:100,
    commercialCapability:'purchasing.core',requires:'product'},
  'sales_order.create':{label:'Prepare a customer order',prompt:'Help me prepare a customer order',rank:110,
    commercialCapability:'sales_orders.core',requires:'product'},
  'supplier_payment.record':{label:'Record a supplier payment already made',prompt:'Help me record a supplier payment',rank:115,
    commercialCapability:'accounting.core'},
  'communication.send_email':{label:'Prepare an email for approval',prompt:'Help me email a supplier',rank:120,
    commercialCapability:'communications.send_approved',requires:'mailbox'},
  'policy.propose':{label:'Propose an operating rule',prompt:'Help me set a reorder rule',rank:130,
    commercialCapability:'authority.advanced'},
  'navigate.connections':{label:'Open connected services',prompt:'Open my connections',rank:140},
});
for(const [name,discovery] of Object.entries(DISCOVERY)){
  const contract=registry.get(name);
  if(!contract)throw new TypeError(`Discovery metadata has no executable contract: ${name}`);
  registry.entries.set(name,Object.freeze({...contract,discovery:Object.freeze(discovery)}));
}
add('read.capabilities','Explain what StockChief can actually do for this user in this workspace, based on registered executable capabilities, permissions, current plan, and connected systems. Use for questions about what you can do, how you can help, or how to get started. Never claim unsupported actions.',
  [],'read',permissions.VIEW,'none',
  (service,db,ctx)=>service.discover(db,ctx),
  async(_service,_db,_ctx,result)=>Boolean(result&&Array.isArray(result.rows)),
  {view:'capabilities',answerMode:'executor',discovery:{label:'Explore what StockChief can do',
    prompt:'What can you help me do here?',rank:0}});

const LEGACY_CAPABILITIES={
  'inventory.receive':'receiving.core','inventory.issue':'inventory.core',
  'inventory.transfer':'inventory.transfers','inventory.adjust':'inventory.counts',
  'catalog.create_item':'inventory.core','location.create':'inventory.multi_location',
  'catalog.set_price':'inventory.core','catalog.set_purchase_cost':'inventory.core',
  'communication.send_email':'communications.send_approved',
  'sales_order.create':'sales_orders.core','customer_invoice.create':'accounting.core',
  'purchase_order.create':'purchasing.core','purchase_order.receive':'receiving.core',
  'supplier_payment.record':'accounting.core',
};
for(const contract of registry.list('mutation')){
  const commercialCapability=contract.commercialCapability||LEGACY_CAPABILITIES[contract.name]||null;
  if(contract.discovery){registry.entries.set(contract.name,Object.freeze({...contract,commercialCapability}));continue;}
  const label=contract.description.split(/[.!?]/,1)[0];
  const discovery=Object.freeze({label,
    prompt:`Help me ${label.toLowerCase()}`,rank:160,commercialCapability});
  registry.entries.set(contract.name,Object.freeze({...contract,commercialCapability,discovery}));
}

module.exports={FIELDS,Registry,registry};

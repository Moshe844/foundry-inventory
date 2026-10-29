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
const governedReports=require('../reports/postgres-registry');

const FIELDS=Object.freeze({
  supplierDocument:{type:'string',maxLength:32000,description:'Exact supplier evidence JSON: documentType order_acknowledgement/shipment_notice/backorder_notice/quotation/price_update/capacity_notice/substitution_offer/dispute, sourceMessageId, optional sourceAttachmentHash, evidenceQuote copied from the new supplier text or readable attachment, optional documentReference, expectedArrivalDate YYYY-MM-DD, currency, exceptionDetail, lines[{purchaseOrderLineId or supplierSku or sku,quantity,quantityBasis stock/purchase,unitCostMinor if supplied}]. Quantities and costs retain the document unit basis; the canonical matcher uses the PO pack snapshot. No physical receipt, bill, payment or send is inferred.'},
  correctionKinds:{type:'string',maxLength:100,description:'JSON array of requested historical corrections: calendar and/or pending_return_cost. Read accounting correction evidence first. Only proven automatic dates and unresolved legacy refund-cost recognition can be corrected; original journals and stock remain intact.'},
  aliasSettings:{type:'string',maxLength:2000,description:'Business nickname JSON: alias, kind (location, sku, item, customer, supplier), exact recordReference, optional remove boolean. Resolve and verify the existing target before proposing.'},
  answerPreferences:{type:'string',maxLength:2000,description:'Partial answer-presentation preference JSON: answerStyle (at most 500 characters), answerLanguage (BCP47 or auto), timeZone (IANA). Omitted fields retain their current values. Style affects prose only, never business actions, authority or identity matching.'},
  reportDefinition:{type:'string',maxLength:16000,description:'Complete governed report definition JSON. Discover read.report_catalogue first. Include dataset,title,columns,groups,aggregate,measure,filters,sort,direction,chart,summary,dateGrain as required by the canonical report validator; no SQL. For low stock use the registered low_stock dataset which compares each SKU with its saved reorder point.'},
  custodyInput:{type:'string',maxLength:32000,description:'Exact agreement JSON. A lineId is an existing line ID or an exact SKU ID/code resolved unambiguously inside this agreement; it never selects a line in another agreement. Creation returns its canonical agreement ID for dependent steps. create: kind RENTAL/CONSIGN_OUT/CONSIGN_IN, customerId or supplierId, startDate,dueDate,lines[{skuId,quantity,unitPriceMinor,unitCostMinor}]. dispatch: lineId,quantity,locationId,optional lotId/serialUnitIds,confirmed yes. receive_consigned: lineId,quantity,optional lotId/lotCode/serials/expiresAt,confirmed. return: lineId,quantity,optional original lotId/serialUnitIds,confirmed. restock: same plus locationId. sell: lineId,quantity,optional lotId/serialUnitIds,taxMinor,issueDate,dueDate,confirmed. take_ownership: lineId,quantity,locationId,optional lotId/serialUnitIds,confirmed. return_supplier: lineId,quantity,optional lotId/serialUnitIds,confirmed. charge: amountMinor,taxMinor,description naming the agreed rental period,issueDate,dueDate. write_off: lineId,quantity,stage external/inspection,optional lotId/serialUnitIds,reason,confirmed. schedule: startsAt,endsAt (ISO instants with offsets),timeZone,bufferMinutes,expectedRevision (0 for new),lines[{lineId,locationId,quantity}],acknowledgeExpectedReturns yes only if owner approves dependence on a scheduled return. cancel_booking: expectedRevision,reason. set_recurring: expectedRevision 0,amountMinor,taxRateId or null,description,intervalUnit DAY/WEEK/MONTH,timeZone,dueDays,maxPeriods,maxTotalMinor (including tax),prorateFinal boolean. Recurring fees are a fixed fee for the whole agreement, in arrears, beginning after all agreed goods are dispatched; no automatic payment/email. pause_recurring,resume_recurring,stop_recurring: expectedRevision. review_recurring: expectedRevision,optional pricingBasisHash; a fresh financial approval for changed pricing/tax within the unchanged original fee/period/total limits. Pause delays billing but retains earned fees; stop ends accrual without inventing physical return. bill_earned: {} (only periods actually earned under saved recurring authority, never future fees). close: {}. Physical confirmation must come from user evidence, never inferred from the goal to automate.'},
  reportSchedule:{type:'string',maxLength:2000,description:'Exact local delivery schedule JSON: frequency none/daily/weekly, hour 0–23, minute 0–59, weekday 0 Sunday through 6 Saturday, timeZone IANA zone. Unspecified fields retain the current schedule. Discover the saved report first; do not convert a local requested hour to UTC.'},
  manufacturingInput:{type:'string',maxLength:32000,description:'Exact structured production inputs using IDs discovered in this inventory. configure: wipAccountId; create_work_centre: name,capacityMinutesPerDay; create_bom: outputSkuId,outputQuantity,leadTimeDays,components[{skuId,quantity}],routing[{name,workCentreId,setupMinutes,minutesPerBatch}]; approve_bom: {}; create_work_order: bomId,quantity,neededBy; start: confirmed yes only for an explicitly established physical event,materials[{component zero-based,skuId,locationId,quantity,optional lotId/serialUnitIds}]; reserve_capacity: confirmed,earliestStart; record_operation: operation zero-based,quantity,actualMinutes; complete: confirmed,good,scrap,locationId,optional lotCode/lotId,serials,expiresAt; add_cost: confirmed,sourceJournalLineId,amountMinor; reverse_cost: confirmed,costAdditionId; recover_material: confirmed,materialUseId (the exact consumption ID or an unambiguous SKU ID/code within this work order),quantity,locationId,optional original serialUnitIds; blocks further output and requires cancellation after recovery. cancel: confirmed,reason. Only the fields for the selected operation are accepted. Do not infer physical events, costs or identities.'},
  quantitySyncMode:{type:'string',enum:['off','inbound','outbound','two_way'],description:'Channel quantity direction. Outbound publishes costed, uncommitted sellable units. Incoming count differences require physical confirmation; no sale, receipt or inventory cost is invented.'},
  priceSyncMode:{type:'string',enum:['off','inbound','outbound','two_way'],description:'Selling price direction for one mapped product. Two-way uses verified baselines, exact currency, historical prices and conflict review.'},
  initialSyncSource:{type:'string',enum:['require_equal','stockchief','provider'],description:'Explicitly selected initial authority if current values differ. require_equal blocks a disagreement. Never infer authority to replace a different value.'},
  invoiceDocument:{type:'string',maxLength:16000,description:'Complete supplier invoice JSON read from actual source evidence: supplierInvoiceNumber, issueDate, dueDate if present, currency, documentTotalMinor, taxMinor, lines [{sku or supplierSku or purchaseOrderLineId, quantity, quantityBasis stock/purchase, unitCostMinor in that same unit basis, description}], charges [{kind freight/insurance/duty/discount/other,label,amountMinor signed}], optional sourceMessageId and sourceAttachmentHash. Match internal or saved supplier codes exactly. Use purchase basis only when the document confirms the saved purchase pack; ask a precise question when its units are unclear. Never infer physical receipt or payment from an invoice.'},
  couponCodes:{type:'string',description:'Comma-separated promotion codes explicitly supplied by the customer or owner. The pricing engine verifies eligibility, dates, stacking and limits; a code is not approval to bypass safeguards.'},
  priceListId:{type:'string',description:'Exact eligible price-list ID discovered in current approved pricing records; omit to use the deterministic customer/quantity pricing hierarchy.'},
  pricingDefinition:{type:'string',maxLength:12000,description:'JSON pricing policy using the discovered pricing form and records: kind price_list/promotion/guard, name, currency, optional enabled/priority/scope(customerIds,skuIds,categoryIds)/startsAt/endsAt. Lists contain entries(skuId,minQuantity,unitPriceMinor); promotions contain discount(type percent/fixed_order/fixed_line/fixed_unit/bundle,value in basis points or minor units, optional bundle items skuId/quantity), stacking stack/exclusive, optional code/stackGroup/excludes/minimumOrderMinor/minimumQuantity/maxRedemptions/maxPerCustomer. Guards contain minimumMarginBps/maximumDiscountBps. Exact IDs must come from this business. This proposes a future policy, never rewrites historical orders.'},
  pricingRuleId:{type:'string',description:'Exact existing governed pricing-rule ID to revise; omit for a new rule.'},
  expectedRevision:{type:'integer',description:'Current pricing-rule revision shown in the governed record; zero for a new rule.'},
  costBasis:{type:'string',description:'Confirmed accounting basis: opening_inventory for stock owned before accounting setup; previously_expensed for a purchase already recorded as an expense. Never infer either from a current purchase quote. Unrecorded/unpaid purchases require the supplier-invoice workflow.'},
  postingDate:{type:'string',description:'Accounting posting date, YYYY-MM-DD. Defaults to today and is shown for approval; closed periods cannot be used.'},
  ruleChanges:{type:'string',description:'A JSON array of proposed typed operating-rule changes using the discovered canonical schema. Supply only established facts and requested effects. Canonical identity resolution, intent verification and owner approval still apply.'},
  search:{type:'string',description:'Name, code, or status explicitly being sought.'},
  priceScope:{type:'string',enum:['current','history'],description:'Current prices or saved history with prior values, currencies and current-price markers. Proposals alone prove no change.'},
  offset:{type:'integer',description:'Nonnegative page offset. Start at zero and follow the returned nextOffset with the same search. Saved stock-warning pages use stockWarningCoverage.nextOffset and separate enabled/disabled counts; directory and supplier-product pages use extent.nextOffset.'},
  baseCode:{type:'string',description:'Exact new product SKU or base code explicitly supplied by the owner.'},
  sku:{type:'string',entity:'sku',description:'Product, variant, or SKU identity.'},
  skuScope:{type:'string',description:'Subset of SKUs explicitly referred to: active or currently_stocked.'},
  location:{type:'string',entity:'location',description:'One inventory location.'},
  locationName:{type:'string',description:'Display name of the new inventory location. Supply only its name, without the operation instructions.'},
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
  supplierAcceptance:{type:'string',description:'Set to required only when the owner explicitly requires a matching supplier reply accepting the purchase order before dependent mission steps. Otherwise omit.'},
  customer:{type:'string',entity:'customer',description:'Customer identity.'},
  supplier:{type:'string',entity:'supplier',description:'Supplier identity.'},
  supplierSku:{type:'string',description:'The code this supplier uses for the named product, only when stated.'},
  purchaseUnit:{type:'string',description:'The unit or pack name in which the supplier sells this product.'},
  unitsPerPurchaseUnit:{type:'integer',description:'Number of stock units in one supplier purchase pack.'},
  leadTimeDays:{type:'integer',description:'Supplier lead time for this product, in days.'},
  minimumOrderQuantity:{type:'integer',description:'Supplier minimum order quantity in purchase packs.'},
  orderMultiple:{type:'integer',description:'Supplier order multiple in purchase packs.'},
  isPreferred:{type:'string',description:'Explicit true or false for preferred supplier for this product.'},
  deliveryMethod:{type:'string',description:'SHIP for an order sent to an address, including delivery by your business; PICKUP for customer collection. OWN_DELIVERY is a compatible alias for SHIP. Actual own transport is recorded at shipment handoff.'},
  shipToAddress:{type:'string',description:'Customer delivery address.'},
  orderDate:{type:'string',description:'Customer order business date in YYYY-MM-DD format, only when explicitly stated.'},
  neededBy:{type:'string',description:'Requested date in YYYY-MM-DD format.'},
  allocationPriority:{type:'integer',description:'Customer-order stock allocation priority, a whole number from 0 to 1000.'},
  purchaseOrder:{type:'string',entity:'purchase_order',description:'Purchase order identity or number.'},
  poNumber:{type:'string',description:'Exact identifier for a new draft purchase order when explicitly supplied; otherwise omit for canonical numbering.'},
  supplierBill:{type:'string',entity:'supplier_bill',description:'Supplier bill identity or number.'},
  orderLines:{type:'string',description:'For a customer order with multiple products: a JSON array of distinct line objects, each with exact sku/product name, integer quantity, and optional unitPrice decimal from the owner. Preserve every requested line in ONE order; never invent a price.'},
  receiptReference:{type:'string',description:'Delivery note or receipt reference.'},
  paymentMethod:{type:'string',description:'Actual method of a recorded payment.'},
  paymentDate:{type:'string',description:'Payment date in YYYY-MM-DD format.'},
  destination:{type:'string',description:'Registered page or record destination.'},
  recordReference:{type:'string',description:'The stated name, number, or ID of a business record.'},
  shipmentRates:{type:'string',maxLength:30000,description:'JSON array of exact discovered shipmentId and rateId pairs, one current quoted rate per parcel in this business.'},
  minWeightGrams:{type:'integer',description:'Optional shipping-rule lower bound on measured total parcel weight in grams.'},
  maxWeightGrams:{type:'integer',description:'Optional shipping-rule upper bound on measured total parcel weight in grams.'},
  rollingDayCost:{type:'number',description:'Maximum postage over any rolling 24 hours, in major units of the explicitly selected currency.'},
  rate:{type:'string',description:'One exact quoted carrier rate ID or carrier and service name.'},
  paymentPurpose:{type:'string',description:'The requested payment-link purpose, such as balance or full.'},
  paymentProvider:{type:'string',description:'The connected payment gateway chosen by the user. Ask when multiple gateways are available.'},
  returnResolution:{type:'string',description:'One exact customer-return resolution: REFUND (also invoice credit), EXCHANGE, or NO_REFUND.'},
  refundDestination:{type:'string',description:'Exact refund destination: AR to reduce an unpaid invoice, or CASH to return money already paid.'},
  disposition:{type:'string',description:'Physical return disposition: restock, scrap, or repair.'},
  handover:{type:'string',description:'Physical shipping handoff: CARRIER, COLLECTED, or DELIVERED_BY_US. Spaces and hyphens are accepted in place of underscores.'},
  trackingNumber:{type:'string',description:'Exact carrier tracking number, when provided.'},
  mode:{type:'string',description:'A registered operating mode for the named subsystem; do not invent a mode.'},
  workspaceName:{type:'string',description:'New name of this inventory workspace.'},
  itemName:{type:'string',description:'The requested product display name itself. Keep the name separate from operation instructions and SKU codes.'},
  itemDescription:{type:'string',description:'New description for an existing product.'},
  baseCode:{type:'string',description:'New base product code, when explicitly requested.'},
  unitLabel:{type:'string',description:'New unit label for an existing product.'},
  allowNegative:{type:'string',description:'Explicit true or false for whether this product permits negative stock.'},
  enabled:{type:'string',description:'Explicit true or false for the named setting.'},
  checkIntervalMinutes:{type:'integer',description:'Requested connection check interval in minutes: 1, 5, 10, 15, 30 or 60. Provider limits may require a slower effective interval.'},
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
  packages:{type:'string',description:'JSON array of every measured package, each with weightGrams and optional complete lengthMm, widthMm, heightMm. Values are measurements, never guesses.'},
  printChoice:{type:'string',description:'Label printer choice: PDF:4x6, PDF:letter, or ZPL:4x6.'},
  signature:{type:'string',description:'Delivery confirmation requirement: NONE (carrier standard), SIGNATURE, or ADULT. Carrier support and surcharges are checked in fresh rates.'},
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
    const aliases={...entry.agentArgumentAliases},targets=new Set();
    for(const [alias,target]of Object.entries(aliases)){
      if(!FIELDS[alias]||!entry.fields.includes(target)||entry.fields.includes(alias)||targets.has(target)||FIELDS[alias].type!==FIELDS[target].type)
        throw new TypeError(`Invalid native argument alias ${alias}`);
      targets.add(target);
    }
    this.entries.set(entry.name,Object.freeze({...entry,fields:Object.freeze([...entry.fields]),agentArgumentAliases:Object.freeze(aliases)}));
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
  'report.template.create':['stockchief_runtime.report_templates'],
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
  'sales_order.create':['customer'],
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
  ['search','baseCode'],permissions.OPERATE,'create_item',{agentArgumentAliases:{itemName:'search'}});
action('location.create','Create an inventory location.',
  ['location'],permissions.ADMIN,'create_location',{agentArgumentAliases:{locationName:'location'}});
action('catalog.set_price','Change the current customer selling price of a SKU.',
  ['sku','amount','currency'],permissions.OPERATE,'set_price');
action('catalog.set_purchase_cost','Change the SKU-wide current per-unit purchase quote, not a named supplier-product term or historical cost of goods sold. Use supplier.link_product to record a particular supplier’s unit cost.',
  ['sku','amount','currency'],permissions.ADMIN,'set_purchase_cost');
add('inventory.establish_cost','Establish evidenced actual unit cost for existing uncosted stock without a physical receipt, quantity change, payment or supplier liability. Records immutable cost evidence and a balanced inventory valuation journal. Current purchase quotes alone are not historical cost evidence. Human approval is mandatory.',
  ['sku','location','quantity','amount','currency','costBasis','reference','postingDate'],'mutation',permissions.MANAGE_ACCOUNTING,'owner_review',
  (_service,db,ctx,text,args)=>require('../accounting/postgres-inventory-costs').prepareFromArgs(db,ctx,args,text),
  (service,db,ctx,result)=>service.verifyProposal(db,ctx,result),
  {required:['sku','location','amount','costBasis','reference'],execute:EXECUTORS['inventory.establish_cost'].execute,
    verifyExecution:EXECUTORS['inventory.establish_cost'].verify,commercialCapability:'accounting.core',additionalCommercialCapabilities:['inventory.core'],
    resultingRecords:['accounting_inventory_cost_establishments','accounting_inventory_cost_balances','accounting_journal_entries']});
action('contact.create','Add a new supplier or customer business contact to this inventory. This creates only the contact record; it does not send email, order goods, or move money.',
  ['recipient','recipientKind','recipientEmail','phone','notes'],permissions.OPERATE,'create_contact');
action('communication.send_email','After approval, send a business email through a connected mailbox. Dependent steps wait for verified provider delivery; when supplierAcceptance=required, they instead wait for a trusted reply in that sent thread explicitly accepting the related purchase order without changed terms. An unclear or failed outcome never counts as acceptance.',
  ['recipient','recipientKind','recipientEmail','recipientMode','subject','body','mailbox','supplierAcceptance'],permissions.OPERATE,'send_email',
  {additionalCommercialCapabilities:['connection.email'],completionGate:'provider_effect_succeeded'});
action('sales_order.create','Prepare ONE draft customer order without fulfillment or payment. For several products use orderLines JSON, preserving every SKU, quantity and price PER UNIT; for one product use sku, quantity and amount. Do not create separate orders for separate lines.',
  ['customer','sku','skuScope','quantity','orderLines','deliveryMethod','shipToAddress','location','orderDate','neededBy','amount','currency','reference','couponCodes','priceListId'],
  permissions.MANAGE_SALES,'create_sales_order',{allowUnknownEntities:['customer'],
    resultReference:'salesOrderId',resultDisplayReference:'orderNumber',resultRecordKind:'sales_order'});
action('report.template.create','Prepare a private saved report from governed PostgreSQL datasets. Delivery supports business-local hour and minute, daily or any weekday. Relative dates resolve at each run. No email is sent until approved. Use for a new saved report; existing templates have separate schedule, pause, resume, delete and send_now contracts.',
  ['reportDefinition','reportSchedule'],permissions.VIEW,'save_report',{resultReference:'reportId'});
action('customer_invoice.create','Prepare a customer invoice for review. Approval records and posts the invoice in StockChief; it does not create or fulfill a customer order, send the invoice, or collect payment.',
  ['customer','sku','quantity','amount','tax','currency','description','issueDate','dueDate','reference','couponCodes','priceListId'],
  permissions.MANAGE_ACCOUNTING,'create_customer_invoice',{allowUnknownEntities:['customer']});
action('purchase_order.create','Prepare a draft supplier order; amount is cost PER UNIT, not total. Unit cost may remain unknown in draft but must be priced before placement; no on-hand stock changes.',
  ['supplier','sku','skuScope','quantity','location','amount','currency','neededBy','reference','poNumber'],
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
    resultingRecords:spec.resultingRecords||(spec.record?[spec.record]:[]),recordKind:spec.record||null,
    resultReference:spec.resultReference,resultDisplayReference:spec.resultDisplayReference,resultRecordKind:spec.resultRecordKind,
    singleEffectPerTarget:Boolean(spec.singleEffectPerTarget),
    satisfiesCapabilities:spec.satisfiesCapabilities||[],
    ownerOnly:Boolean(spec.ownerOnly)});
for(const [name,required] of Object.entries(REQUIRED)){
  const current=registry.get(name);
  registry.entries.set(name,Object.freeze({...current,required:Object.freeze(required)}));
}

const READS={
  pricing:'Approved and pending pricing policies from visual setup and Ask: schedules, disabled rules, approvals and margin safeguards. Scope and currency determine quote applicability; historical prices stay frozen. Rule IDs grant no execution authority.',
  inventory:'Current SKU physical stock, commitments, uncommitted quantities, units with recorded inventory cost and units missing cost across the business. An uncommitted quantity is not proof that all fulfillment prerequisites are met; canonical execution also checks its applicable costing, order and authority requirements. Incoming purchase-order units are new supply; planned/in-transit internal transfers relocate existing stock and must not be added to business-wide incoming supply.',
  inventory_positions:'Current on-hand stock by product and location, with a complete filtered position count and physical quantity total in summary from the same snapshot. The location rows are bounded; coverage states whether every position is shown. It does not account for commitments and cannot establish what is available to ship.',
  inventory_movements:'Recorded physical stock movements with verified source kind: import, supplier purchase receipt, customer return, internal transfer, customer sale fulfillment, or other. Count movements by source without treating imports or returns as supplier deliveries.',
  inventory_valuation:'Complete matching physical units, costed units, missing-cost units and recorded inventory book-cost totals with currency, plus product/location detail including positions with no cost record. Each detail row distinguishes physical, costed and missing-cost units; an unrecorded book cost is not zero. Totals cover the full matching scope independently of detail pagination; distinct from supplier purchase quotes.',
  inventory_cost_movements:'Recorded changes in inventory book cost with import file and row provenance.',
  inventory_summary:'Business-wide current and historical inventory setup evidence: active product and SKU counts, total on-hand units, and count of every product record ever created, including inactive records. Valid even when this business is empty; requires no product or location.',
  prices:'Current selling prices or priceScope=history: actual saved prior prices, dates, currencies and current markers. Zero, cleared and missing prices differ. Includes inactive SKUs. Follow nextOffset; proposals alone prove no executed change.',purchase_costs:'Purchase quotes, current inventory book cost, and historical opening-import cost by SKU, including inactive records; all are separate. Missing quote does not imply uncosted stock. Exact paged coverage is returned; follow nextOffset with the same search.',
  supplier_items:'Active supplier-product links with exact paged coverage, saved product lead-time overrides, inherited supplier defaults, minimum quantities, order multiples, pack sizes and costs. A missing value is not zero or one. Read suppliers for defaults and exact link counts, including suppliers with no linked products.',needs_you:'Owner decisions awaiting attention.',
  operating_rules:'Approved operating rules and settings. Stock warnings include enabled rows, inactiveStockWarnings, exact stockWarningCoverage and recorded evaluation receipts; follow nextOffset for more saved rules. Other setting kinds are bounded current in-force rows. Do not substitute the general capability catalogue.',
  replenishment:'Current low stock compared with each saved reorder point, using the canonical low-stock report, plus the same current inventory warnings as Needs You and recorded purchase recommendations. Missing reorder settings are not proof of sufficient stock. For all existing owner warnings also read needs_you.',locations:'Inventory locations.',
  purchase_orders:'Read supplier purchase orders, deliveries, linked invoice documents including disputes and exceptions, and the actually posted open payable; PO planned cost and disputed documents are not posted debt.',
  transfers:'Read tracked inventory transfers, their exact workflow state, source and destination, units held at source, departed/in transit, physically received, and unresolved loss or damage. An approved transfer has not physically left.',
  customer_returns:'Read customer returns and their lifecycle, original sale, authorized, physically received and inspected quantities, disposition, and posted cash refund versus unpaid-invoice credit. A return request alone is not a receipt or refund.',
  sales_orders:'Customer orders: item lines/prices, totals, ordered, held, fulfilled and open units, invoice/payment balances and posted revenue/cost/profit. deliveryMethod is destination mode (PICKUP/SHIP); shipmentDetails record actual handover, progress and tracking with explicit coverage. Only handedOver=true proves physical departure.',
  sales_activity:'Recorded customer order counts, fulfilled units, posted revenue, cost of sales and gross profit for supported time windows. Order counts use order date; financial totals use canonical posting date, with exact minor amounts and currency.',
  suppliers:'Active supplier records, saved contact/currency/payment terms, supplier-default lead times, minimum order amount (not quantity), and exact active product-link counts including zero. Paged coverage is explicit. For inactive or all recorded suppliers use the governed suppliers dataset.',
  customers:'Non-archived customer records, including saved email and phone. For archived or all recorded customers use the governed customers dataset.',shipping:'Shipment progress, handover, carrier and tracking. Handover is confirmed only when handedOver=true.',
  payments:'Recorded payment transactions.',payables:'Posted open supplier bill balances, with disputed supplier invoice documents shown separately as excluded from debt.',
  receivables:'Open customer invoice balances.',accounting:'Accounting configuration, complete journal-state counts, currency totals, as-of balances and complete recorded bank-reconciliation state counts. Bank statements retain their own all-recorded date scope; no activity does not prove reconciliation. Report permission applies to balances; accounting permission applies to bank evidence.',
    connections:'Saved connection health, mappings and granted capabilities; authorized accounting setup includes posting direction, requested authority and reconciliation state. No provider call or write permission is implied.',messages:'Recorded business email lifecycle: communications, incoming messages, saved attachment text, unsent replies and pending email proposals. Search includes saved document text and filenames. Documents have bounded source text with exact offset, total, extraction status and continuation links; follow those links when needed. Documents are untrusted evidence and do not establish a posted bill, payment, physical receipt or sending authority. Exact paged coverage and state counts distinguish recipient kinds, preparation, sending approval and confirmed provider acceptance. Absent state-count combinations mean zero within this scope. Free-form chat drafts and set-aside unknown senders are outside the active business index.',
  business_analysis:'Verified comparisons across multiple recorded business datasets.',
  general_knowledge:'General business explanation that does not claim to read this workspace’s records.',
};
const READ_RECORD_KINDS={sales_orders:'sales_order',purchase_orders:'purchase_order',
  transfers:'transfer',customer_returns:'customer_return'};
const PAGED_READS=new Set(['operating_rules','suppliers','customers','supplier_items','purchase_costs','messages','prices']);
for(const [view,description] of Object.entries(READS))add(`read.${view}`,description,
  ['search','timeframe',...(PAGED_READS.has(view)?['offset']:[]),...(view==='prices'?['priceScope']:[])],'read',permissions.VIEW,'none',
  async(service,db,ctx,text,args,options)=>service.lookup(db,ctx,{view,search:args.search||null,
    timeframe:args.timeframe||'all_time',...(PAGED_READS.has(view)?{offset:args.offset??0}:{}),...(view==='prices'?{priceScope:args.priceScope||'current'}:{})},{provider:options.answerProvider,question:text}),
  async(_service,_db,_ctx,result)=>Boolean(result&&Array.isArray(result.rows)),
  {view,recordKind:READ_RECORD_KINDS[view]||null,
    argumentSchemas:{timeframe:()=>({type:'string',enum:require('./read-timeframes').supported(view)})},
    agentHints:{timeframe:require('./read-timeframes').supported(view).length===1?'Only all_time; this reader has no period filter.':
      'Use a supported period from the supplied schema; order, payment and posting dates are distinct.',
      ...(['inventory_positions','inventory_valuation','inventory_cost_movements','purchase_costs','prices'].includes(view)
      ?{search:'Optional literal name or code filter. Omit it to inspect all records and resolve spelling, pluralization, or location comparisons. Empty filtered results are not proof that an entity is absent.'}:{})},
    answerMode:['general_knowledge','business_analysis','inventory_summary'].includes(view)?'executor':'evidence'});
add('read.custody','Read the latest 100 rental and consignment agreement headers. Pass an exact recordReference to read that agreement and 50 product lines, following extent.nextOffset with offset. Read booking capacity, expected-return dependencies and bounded recurring billing terms and invoices on the exact agreement. Due dates never prove a physical return.',['recordReference','offset'],'read',permissions.VIEW,'none',(_service,db,ctx,_text,args)=>require('../custody/ask-contracts').read(db,ctx,args),async(_service,_db,_ctx,result)=>Boolean(result&&Array.isArray(result.rows)),{view:'custody',recordKind:'custody_agreement',answerMode:'evidence',commercialCapability:'inventory.core'});
add('read.report_schedules','List your private saved reports, definitions, local schedules, next send, last sent, pause state and exact IDs. Coverage is the latest 100 active templates in this inventory.',[],'read',permissions.VIEW,'none',(_service,db,ctx)=>require('../reports/ask-schedules').read(db,ctx),async(_service,_db,_ctx,result)=>Boolean(result&&Array.isArray(result.rows)),{view:'report_schedules',answerMode:'evidence'});
add('read.report_catalogue','Discover permitted report datasets and their exact calculation schemas. Search by dataset name or description; follow nextOffset for more. No second AI model is invoked.',['search','offset'],'read',permissions.VIEW,'none',async(_service,db,ctx,_text,args)=>{const actor=await require('../reports/ask-schedules').actor(db,ctx),term=String(args.search||'').toLowerCase().replaceAll('_',' '),offset=Math.max(0,Number(args.offset)||0),available=governedReports.list(actor).filter(r=>!term||(r.key.replaceAll('_',' ')+' '+r.label).toLowerCase().includes(term));return {rows:available.slice(offset,offset+6).map(r=>({dataset:r.key,label:r.label,...require('../reports/postgres-service').queryContract(r.key,actor)})),extent:{offset,total:available.length,nextOffset:offset+6<available.length?offset+6:null},syntax:require('../reports/postgres-service').querySyntax,timeZone:(await require('../lib/business-time').forWorkspace(db,ctx.workspaceId)).timeZone,sources:[{kind:'page',href:'/reports',label:'Reports'}]};},async(_s,_d,_c,r)=>Array.isArray(r?.rows),{answerMode:'evidence'});
add('read.record_aliases','Read this inventory’s durable business nicknames and their current active canonical targets.',[],'read',permissions.ADMIN,'none',async(_s,db,ctx)=>({rows:await require('./postgres-record-aliases').list(db,ctx),sources:[{kind:'page',href:'/settings#ask-preferences',label:'Business nicknames'}]}),async()=>true,{answerMode:'evidence'});
add('read.ask_preferences','Read this inventory’s saved answer language, style and business time zone. These are presentation settings, not operating authority or location aliases.',[],'read',permissions.VIEW,'none',async(_s,db,ctx)=>({rows:[await require('./postgres-answer-preferences').read(db,ctx)],sources:[{kind:'page',href:'/settings#ask-preferences',label:'Ask preferences'}]}),async(_s,_d,_c,r)=>r?.rows?.length===1,{answerMode:'evidence'});
add('read.accounting_corrections','Review proven historical UTC-day and pending-refund cost corrections. Original posted journals are preserved. Closed periods and dates before accounting setup are held for review.',[],'read',permissions.MANAGE_ACCOUNTING,'none',async(_s,db,ctx)=>{const p=await require('../accounting/postgres-history-corrections').preview(db,ctx);return {rows:p.changes.map(c=>({kind:c.kind,entryId:c.entryId,entryNumber:c.entryNumber,from:c.originalDate,to:c.targetDate,amountMinor:c.amountMinor??null})),held:p.held,hasMore:p.hasMore,coverage:p.hasMore?'First 500 source journals; more remain for a separate reviewed batch.':'All proven candidates in this inventory.',reviewHash:p.integrity,timeZone:p.timeZone,sources:[{kind:'page',href:'/money',label:'Money'}]};},async(_s,_d,_c,r)=>Array.isArray(r?.rows),{answerMode:'evidence'});
add('read.manufacturing','Read recorded manufacturing setup, approved and draft BOM revisions, work centres, work orders, physical completion and remaining WIP. Coverage is explicitly limited to the latest 100 jobs and revisions. This does not imply finite-capacity reservations or unrecorded production.',[],'read',permissions.VIEW,'none',
  (_service,db,ctx)=>require('../manufacturing/ask-contracts').read(db,ctx),async(_service,_db,_ctx,result)=>Boolean(result&&Array.isArray(result.rows)),{view:'manufacturing',answerMode:'evidence',commercialCapability:'inventory.core'});
for(const [name,description,search] of [
  ['read.profit_and_loss','Read the current month’s posted profit and loss; never infer unrecorded activity.','profit_and_loss'],
  ['read.profit_change','Explain the change in posted profit against the comparable prior month when the accounting analysis entitlement allows it.','profit_change'],
])add(name,description,[],'read',permissions.VIEW_ACCOUNTING,'none',
  (service,db,ctx,text)=>service.lookup(db,ctx,{view:'accounting',search},{question:text}),
  async(_service,_db,_ctx,result)=>Boolean(result&&Array.isArray(result.rows)),{view:'accounting'});

add('read.custom_report',`Compose governed PostgreSQL reports with fields, filters, grouping, charts, and safe formulas across approved dataset joins. Datasets: ${Object.keys(governedReports.datasets).join(', ')}. Weighted metrics: ${[...new Set(Object.values(governedReports.datasets).flatMap((dataset)=>Object.values(dataset.metrics||{}).map((metric)=>metric.label)))].join(', ')}. Groups drill down to source records; detail rows link to canonical records. Use for report generation, comparison and customization, never unregistered metrics.`,
  [],'read',permissions.VIEW,'none',
  (_service,db,ctx,text,_args,options)=>require('../reports/postgres-ask').prepare(db,ctx,text,
    {provider:options.answerProvider,priorReport:options.priorReport}),
  async(_service,_db,_ctx,result)=>Boolean(result&&Array.isArray(result.rows)),
  {view:'custom_report',answerMode:'executor',discovery:{label:'Build a custom business report',
    prompt:'Help me build a report from my business records',rank:72}});

add('policy.propose','Propose a lasting operating rule within StockChief’s registered policy domains and limits.',
  [],'policy',permissions.ADMIN,'owner_review',
  (service,db,ctx,text,args,options)=>service.prepareInstruction(db,ctx,text,{...options,...(args.ruleChanges!==undefined?{proposedChanges:args.ruleChanges}:{})}),
  async(_service,_db,_ctx,result)=>Boolean(result?.proposal?.id||result?.status==='CLARIFY'),
  // One typed instruction can contain several rule changes. Planning it twice
  // would create duplicate proposals and reuse the same funded model request.
  {singleEffectPerTarget:true,agentFields:['ruleChanges'],argumentSchemas:{ruleChanges:()=>require('../manager/postgres-operating-instructions').PROPOSED_CHANGES_SCHEMA}});

// The page catalogue is presentation metadata. Each destination is checked
// against the real PostgreSQL router before it is offered by the navigator.
const PAGE_PERMISSIONS={purchasing:permissions.VIEW_PURCHASING,suppliers:permissions.VIEW_PURCHASING,
  sales:permissions.VIEW_SALES,customers:permissions.VIEW_SALES,accounting:permissions.VIEW_ACCOUNTING,transfers:permissions.VIEW_TRANSFERS,
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
add('read.capabilities','Explain what StockChief can actually do for this user in this workspace, based on registered executable capabilities, permissions, current plan, and connected systems. Use for broad discovery questions about what you can do, how you can help, or how to get started. This does not read or explain a specific approved rule; use read.operating_rules for that. Never claim unsupported actions.',
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

add('read.authorized_work','Inspect existing recorded replenishment work and its current standing-authority requirements.',[],
  'read',permissions.ADMIN,'none',(_service,db,ctx)=>require('./postgres-goal-authority').inspect(db,ctx),
  async()=>true,{ownerOnly:true,adaptiveOnly:true,commercialCapability:'authority.advanced'});
add('authority.execute_work','Execute one existing work item already covered by a current bounded standing rule. Never grants authority or confirms physical events.',
  ['recordReference'],'authority',permissions.ADMIN,'existing_standing_rule',
  (_service,db,ctx,_message,args,options)=>require('./postgres-goal-authority').execute(db,ctx,args,options),
  async()=>true,{required:['recordReference'],ownerOnly:true,adaptiveOnly:true,commercialCapability:'authority.advanced',
    authority:{mode:'existing_standing_rule'},resultingRecords:['work_items']});

module.exports={FIELDS,Registry,registry};

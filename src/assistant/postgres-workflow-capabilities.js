'use strict';

const permissions=require('../actions/permissions');
const workflows=require('../operations/postgres-business-workflows');
const commerce=require('../operations/postgres-commerce');
const transfers=require('../transfers/postgres-transfer-service');
const returns=require('../operations/postgres-returns');
const waves=require('../operations/postgres-fulfillment-waves');
const banking=require('../accounting/postgres-banking');
const accountingSync=require('../accounting/postgres-integration-sync');
const payments=require('../payments/postgres-collection');
const shipping=require('../shipping/postgres-service');
const pricing=require('../pricing/postgres-service');
const entitlements=require('../entitlements/postgres-service');
const autonomy=require('../autopilot/postgres-service');
const connections=require('../connections/postgres-service');
const catalog=require('../domain/postgres-catalog-service');
const mail=require('../connections/postgres-mail');
const accountLifecycle=require('../domain/postgres-account-lifecycle');
const config=require('../config');
const imports=require('../imports/postgres-service');
const jobQueue=require('../operations/postgres-job-queue');
const {ValidationError}=require('../domain/errors');
const {nowIso,newId}=require('../lib/util');

// These are executable business contracts, not phrases to match in a user's
// message. Their prepare step resolves one current, tenant-scoped record and
// freezes the exact requested effect for approval. The canonical service
// validates and executes it again inside the approval transaction.
const RECORDS=Object.freeze({
  sales_order:{table:'sales_orders',number:'order_number',label:'customer order'},
  purchase_order:{table:'purchase_orders',number:'po_number',label:'purchase order'},
  transfer:{table:'inventory_transfers',number:'transfer_number',label:'inventory transfer'},
  shipment:{table:'sales_shipments',number:'shipment_number',label:'shipment'},
  customer_return:{table:'customer_returns',number:'return_number',label:'customer return'},
  connection:{table:'workspace_connectors',number:'display_name',label:'connection'},
  shipping_rule:{table:'shipping_rules',number:'name',label:'shipping rule'},
  item:{table:'items',number:'name',label:'product'},
  customer:{table:'customers',number:'name',label:'customer'},
  supplier:{table:'suppliers',number:'name',label:'supplier'},
  customer_invoice:{table:'accounting_customer_invoices',number:'invoice_number',label:'customer invoice'},
  mail_message:{table:'connection_email_messages',number:'subject',label:'business message'},
  import_plan:{table:'import_plans',number:'source_name',label:'import preview'},
  supplier_return:{table:'supplier_returns',number:'return_number',label:'supplier return'},
  fulfillment_wave:{table:'fulfillment_waves',number:'title',label:'fulfillment wave'},
  bank_account:{table:'accounting_bank_accounts',number:'name',label:'financial account'},
  bank_transaction:{table:'accounting_bank_transactions',number:'external_id',sort:'imported_at',label:'bank transaction'},
});
function sameClient(client){return {query:(sql,values)=>client.query(sql,values),transaction:(work)=>work(client)};}
async function record(database,ctx,kind,reference,message=''){
  const source=RECORDS[kind];if(!source)throw new TypeError(`Unknown business record kind ${kind}`);
  let wanted=String(reference||'').trim();
  if(!wanted&&message){
    const mentioned=(await database.query(`SELECT id,${source.number} AS number FROM ${source.table}
      WHERE workspace_id=$1 AND length(${source.number})>=4
        AND strpos(lower($2),lower(${source.number}))>0
      ORDER BY length(${source.number}) DESC LIMIT 2`,[ctx.workspaceId,message])).rows;
    if(mentioned.length===1)wanted=mentioned[0].number;
    else if(mentioned.length>1)return {ambiguous:true,label:source.label};
  }
  if(!wanted)return {missing:true,label:source.label};
  const rows=(await database.query(`SELECT * FROM ${source.table} WHERE workspace_id=$1
    AND (lower(id)=lower($2) OR lower(${source.number})=lower($2))
    ORDER BY ${source.sort||'created_at'} DESC LIMIT 2`,
  [ctx.workspaceId,wanted])).rows;
  if(rows.length===1)return {row:rows[0],label:source.label};
  if(!rows.length&&wanted.length>=4){
    const related=(await database.query(`SELECT * FROM ${source.table} WHERE workspace_id=$1
      AND strpos(lower(${source.number}),lower($2))>0
      ORDER BY ${source.sort||'created_at'} DESC LIMIT 2`,[ctx.workspaceId,wanted])).rows;
    if(related.length===1)return {row:related[0],label:source.label};
    if(related.length>1)return {ambiguous:true,label:source.label};
  }
  return {notFound:!rows.length,ambiguous:rows.length>1,label:source.label};
}
async function state(client,ctx,table,id,allowed){
  const row=(await client.query(`SELECT status FROM ${table} WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,id])).rows[0];
  return Boolean(row&&allowed.includes(row.status));
}
function prepareResult(payload,summary){return {payload,summary};}
function requireState(row,states,label){if(!states.includes(row.status))
  throw new ValidationError(`${label} is ${row.status.toLowerCase().replace(/_/g,' ')}; that operation is not available now.`);}
function positive(value,label){const number=Number(value);if(!Number.isSafeInteger(number)||number<1)
  throw new ValidationError(`${label} must be a positive whole number.`);return number;}
async function actor(client,ctx){const row=(await client.query(`SELECT role,permissions FROM users
  WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new ValidationError('The acting user does not belong to this inventory.');return row;}

async function fulfillment(database,ctx,order,args){
  requireState(order,['CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED'],'This customer order');
  const allocations=(await database.query(`SELECT sol.id AS line_id,sol.sku_id,sol.quantity_ordered,
    sol.quantity_fulfilled,sol.unit_price_minor,s.code,i.tracking_mode,a.location_id,a.quantity
    FROM sales_order_lines sol JOIN sales_order_allocations a ON a.sales_order_line_id=sol.id
      AND a.workspace_id=sol.workspace_id JOIN skus s ON s.id=sol.sku_id AND s.workspace_id=sol.workspace_id
    JOIN items i ON i.id=s.item_id AND i.workspace_id=sol.workspace_id
    WHERE sol.workspace_id=$1 AND sol.sales_order_id=$2 AND a.quantity>0
    ORDER BY sol.id,a.location_id`,[ctx.workspaceId,order.id])).rows;
  const chosen=args.sku?allocations.filter((line)=>line.code.toLowerCase()===args.sku.toLowerCase()):allocations;
  if(!chosen.length)throw new ValidationError('This order has no matching allocated stock ready to fulfill. Confirm and allocate it first.');
  if(chosen.some((line)=>line.tracking_mode!=='quantity'))throw new ValidationError(
    'This fulfillment needs exact lot or serial evidence. Open the order and choose the physical units; Ask did not move stock.');
  if(args.quantity!=null&&new Set(chosen.map((line)=>line.line_id)).size!==1)
    throw new ValidationError('A partial quantity needs one exact product or SKU on this order.');
  let remaining=args.quantity==null?null:positive(args.quantity,'Fulfillment quantity');
  const lines=[];
  for(const line of chosen){const quantity=remaining==null?Number(line.quantity):Math.min(remaining,Number(line.quantity));
    if(quantity>0)lines.push({lineId:line.line_id,locationId:line.location_id,quantity});
    if(remaining!==null)remaining-=quantity;}
  if(remaining>0)throw new ValidationError('The requested quantity exceeds stock allocated to this order.');
  const units=lines.reduce((sum,line)=>sum+line.quantity,0);
  return prepareResult({salesOrderId:order.id,lines},
    `Record ${units} allocated unit${units===1?'':'s'} physically leaving on ${order.order_number}; post stock, revenue, cost and the customer invoice together.`);
}

async function paymentLink(database,ctx,order,args){
  const purpose=String(args.paymentPurpose||'BALANCE').toUpperCase();
  if(!['BALANCE','FULL'].includes(purpose))throw new ValidationError(
    'Ask can prepare a link for an open invoice balance. An agreed deposit needs its terms reviewed on the order first.');
  const invoice=(await database.query(`SELECT id,invoice_number,balance_minor,currency FROM accounting_customer_invoices
    WHERE workspace_id=$1 AND sales_order_id=$2 AND status IN ('OPEN','PARTIALLY_PAID')
    ORDER BY issue_date DESC,id DESC LIMIT 2`,[ctx.workspaceId,order.id])).rows;
  if(invoice.length!==1)throw new ValidationError(invoice.length?
    'This order has more than one open invoice. Open the order and choose the exact invoice.':
    'This order has no open invoice to collect. Fulfill it first, or review deposit terms on the order.');
  const account=(await database.query(`SELECT charges_enabled FROM payment_connect_accounts
    WHERE workspace_id=$1 AND provider='stripe'`,[ctx.workspaceId])).rows[0];
  if(!account||Number(account.charges_enabled)!==1)throw new ValidationError(
    'Connect and activate this inventory’s own Stripe payment account before preparing a customer payment link.');
  return prepareResult({salesOrderId:order.id,invoiceId:invoice[0].id,
    expectedAmountMinor:Number(invoice[0].balance_minor),purpose,provider:'stripe'},
  `Queue one Stripe payment-link request for ${order.order_number}, invoice ${invoice[0].invoice_number}, `+
    `${pricing.formatMinor(Number(invoice[0].balance_minor),invoice[0].currency)}. No customer message or payment is created by approval.`);
}

async function recordCustomerPayment(database,ctx,order,args){
  if(!args.paymentMethod)throw new ValidationError('Name the method of the payment that has already been received. Ask will not charge the customer.');
  const invoice=(await database.query(`SELECT id,invoice_number,customer_id,balance_minor,currency
    FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2
      AND status IN ('OPEN','PARTIALLY_PAID') ORDER BY issue_date DESC,id DESC LIMIT 2`,
  [ctx.workspaceId,order.id])).rows;
  if(invoice.length!==1)throw new ValidationError(invoice.length?
    'More than one invoice is open on this order. Open the exact invoice before recording payment.':
    'No open customer invoice exists on this order.');
  const balance=Number(invoice[0].balance_minor);
  const amountMinor=args.amount==null&&['BALANCE','FULL'].includes(String(args.paymentPurpose||'').toUpperCase())
    ?balance:Math.round(Number(args.amount)*100);
  if(!Number.isSafeInteger(amountMinor)||amountMinor<=0||amountMinor>balance)throw new ValidationError(
    'State the actual amount received, no more than the open invoice balance.');
  return prepareResult({direction:'CUSTOMER_RECEIPT',customerId:invoice[0].customer_id,
    customerInvoiceId:invoice[0].id,salesOrderId:order.id,amountMinor,
    currency:invoice[0].currency,method:args.paymentMethod,paymentDate:args.paymentDate||null,
    reference:args.reference||null,expectedBalanceMinor:balance},
  `Record an already-received ${pricing.formatMinor(amountMinor,invoice[0].currency)} ${args.paymentMethod} payment `+
    `against invoice ${invoice[0].invoice_number}. This posts cash and reduces the invoice balance; it does not initiate a charge.`);
}
function invoicePayment(_database,_ctx,invoice,args){
  if(!['OPEN','PARTIALLY_PAID'].includes(invoice.status)||Number(invoice.balance_minor)<=0)
    throw new ValidationError('This customer invoice has no open balance to pay.');
  if(!args.paymentMethod)throw new ValidationError('Name the method of payment already received.');
  const amountMinor=args.amount==null?Number(invoice.balance_minor):Math.round(Number(args.amount)*100);
  if(!Number.isSafeInteger(amountMinor)||amountMinor<1||amountMinor>Number(invoice.balance_minor))
    throw new ValidationError('State the amount actually received, no more than the invoice balance.');
  return prepareResult({customerId:invoice.customer_id,customerInvoiceId:invoice.id,
    expectedBalanceMinor:Number(invoice.balance_minor),amountMinor,currency:invoice.currency,
    method:args.paymentMethod,paymentDate:args.paymentDate||null,reference:args.reference||null},
  `Record ${pricing.formatMinor(amountMinor,invoice.currency)} already received against invoice `+
    `${invoice.invoice_number}. This posts cash and allocation; it does not charge the customer.`);
}
async function supplierBill(database,ctx,supplier,args){
  if(supplier.status!=='active')throw new ValidationError('This supplier is archived. Restore it before recording a new bill.');
  const number=String(args.supplierInvoiceNumber||'').trim();
  const description=String(args.description||'').trim();
  const quantity=Number(args.quantity);
  const unitCostMinor=Math.round(Number(args.unitAmount)*100);
  const taxMinor=args.tax==null?0:Math.round(Number(args.tax)*100);
  if(!number||number.length>80)throw new ValidationError('State the supplier’s invoice number (up to 80 characters).');
  if(!description||description.length>250)throw new ValidationError('State the bill line description (up to 250 characters).');
  if(!Number.isFinite(quantity)||quantity<=0||!Number.isSafeInteger(unitCostMinor)||unitCostMinor<0||
    !Number.isSafeInteger(taxMinor)||taxMinor<0)throw new ValidationError(
    'State a positive quantity, non-negative unit cost, and non-negative tax.');
  const prior=(await database.query(`SELECT id FROM accounting_supplier_bills WHERE workspace_id=$1
    AND supplier_id=$2 AND supplier_invoice_number=$3 AND status<>'VOID'`,
  [ctx.workspaceId,supplier.id,number])).rows[0];
  if(prior)throw new ValidationError('That supplier invoice is already recorded. Ask about its existing bill instead.');
  return prepareResult({supplierId:supplier.id,supplierInvoiceNumber:number,
    issueDate:args.issueDate||nowIso().slice(0,10),dueDate:args.dueDate||null,taxMinor,
    lines:[{description,quantity,unitCostMinor}]},
  `Record supplier invoice ${number} from ${supplier.name}: ${quantity} × `+
    `${pricing.formatMinor(unitCostMinor,supplier.currency||'USD')} plus `+
    `${pricing.formatMinor(taxMinor,supplier.currency||'USD')} tax. This creates a payable and expense, `+
    'not a physical stock receipt or bank payment.');
}

async function purchaseOrderSupplierInvoice(database,ctx,order,args){
  requireState(order,['ORDERED','PARTIALLY_RECEIVED','RECEIVED'],'This purchase order');
  const number=String(args.supplierInvoiceNumber||'').trim();
  const quantity=Number(args.quantity);
  const unitCostMinor=Math.round(Number(args.unitAmount)*100);
  const taxMinor=args.tax==null?0:Math.round(Number(args.tax)*100);
  if(!number||number.length>80)throw new ValidationError('State the supplier’s exact invoice number (up to 80 characters).');
  if(!Number.isSafeInteger(quantity)||quantity<1||!Number.isSafeInteger(unitCostMinor)||unitCostMinor<0
    ||!Number.isSafeInteger(taxMinor)||taxMinor<0)throw new ValidationError(
    'State the invoiced stock-unit quantity, non-negative unit cost, and non-negative tax.');
  const prior=(await database.query(`SELECT id FROM accounting_supplier_bills WHERE workspace_id=$1
    AND supplier_id=$2 AND supplier_invoice_number=$3 AND status<>'VOID'`,
  [ctx.workspaceId,order.supplier_id,number])).rows[0];
  if(prior)throw new ValidationError('That supplier invoice is already recorded. Ask about its existing bill instead.');
  const lines=(await database.query(`SELECT pol.id,pol.sku_id,pol.description,pol.quantity_received_units,
      pol.unit_cost,s.code,i.name AS item_name,
      COALESCE((SELECT SUM(bl.quantity) FROM accounting_supplier_bill_lines bl
        JOIN accounting_supplier_bills b ON b.id=bl.bill_id AND b.workspace_id=bl.workspace_id
        WHERE bl.workspace_id=pol.workspace_id AND bl.purchase_order_line_id=pol.id
          AND b.status IN ('OPEN','PARTIALLY_PAID','PAID')),0) AS billed_units
    FROM purchase_order_lines pol JOIN skus s ON s.id=pol.sku_id AND s.workspace_id=pol.workspace_id
    JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    WHERE pol.workspace_id=$1 AND pol.purchase_order_id=$2 ORDER BY pol.line_number`,
  [ctx.workspaceId,order.id])).rows;
  const matching=args.sku?lines.filter((line)=>[line.code,line.item_name].some((value)=>
    value.toLowerCase()===String(args.sku).trim().toLowerCase())):lines;
  if(matching.length!==1)throw new ValidationError(matching.length?
    'This purchase order has several products. Name the exact invoiced SKU.':
    'The invoiced product does not match a line on this purchase order.');
  const line=matching[0],approvedCostMinor=Math.round(Number(line.unit_cost)*100);
  const disputed=Number(line.billed_units)+quantity>Number(line.quantity_received_units)
    ||unitCostMinor!==approvedCostMinor;
  const totalMinor=quantity*unitCostMinor+taxMinor;
  return prepareResult({supplierId:order.supplier_id,purchaseOrderId:order.id,
    purchaseOrderLineId:line.id,supplierInvoiceNumber:number,
    issueDate:args.issueDate||nowIso().slice(0,10),dueDate:args.dueDate||null,
    currency:order.currency,taxMinor,expectedReceivedUnits:Number(line.quantity_received_units),
    expectedBilledUnits:Number(line.billed_units),expectedApprovedCostMinor:approvedCostMinor,
    expectedStatus:disputed?'DISPUTED':'OPEN',expectedTotalMinor:totalMinor,
    lines:[{purchaseOrderLineId:line.id,skuId:line.sku_id,
      description:line.description||line.item_name,quantity,unitCostMinor}]},
  `Record supplier invoice ${number} against ${order.po_number}: ${quantity} × ${line.code} at `+
    `${pricing.formatMinor(unitCostMinor,order.currency)} plus ${pricing.formatMinor(taxMinor,order.currency)} tax. `+
    (disputed?'This exceeds received quantity or approved unit cost, so it will be disputed without a journal.':
      'This matches the received quantity and approved unit cost; it creates a payable without receiving stock again.')+
    ' No bank payment occurs.');
}

async function shippingHandoff(database,ctx,shipment,args){
  requireState(shipment,['PACKED'],'This shipment');
  const handover=String(args.handover||shipment.handover||'CARRIER').toUpperCase();
  if(!['CARRIER','COLLECTED','DELIVERED_BY_US'].includes(handover))throw new ValidationError(
    'Choose carrier handoff, customer collection, or delivery by your business.');
  const trackingNumber=args.trackingNumber||shipment.tracking_number||null;
  if(handover==='CARRIER'&&shipment.label_status!=='PURCHASED'&&!trackingNumber)throw new ValidationError(
    'Name the carrier tracking number or buy a verified label before recording physical handoff.');
  return prepareResult({recordId:shipment.id,handover,trackingNumber},
    `Record ${shipment.shipment_number} physically handed off as ${handover.toLowerCase().replace(/_/g,' ')}${trackingNumber?` with tracking ${trackingNumber}`:''}. This fulfills its order lines and posts stock, revenue, cost, and invoice.`);
}

async function label(database,ctx,shipment,args){
  if(['CANCELLED','SHIPPED','DELIVERED'].includes(shipment.status))throw new ValidationError(
    'This parcel has already left or was cancelled; StockChief cannot buy a new label for it.');
  const rates=(await database.query(`SELECT id,carrier,service,amount_minor,currency,quoted_at FROM shipment_rates
    WHERE workspace_id=$1 AND shipment_id=$2 ORDER BY amount_minor,id`,[ctx.workspaceId,shipment.id])).rows;
  const wanted=String(args.rate||'').trim().toLowerCase();
  const matches=wanted?rates.filter((rate)=>rate.id.toLowerCase()===wanted||
    `${rate.carrier} ${rate.service}`.toLowerCase()===wanted):rates;
  if(matches.length!==1)throw new ValidationError(matches.length?
    'More than one carrier rate is available. Name the exact carrier and service before buying a label.':
    'No matching current carrier rate exists. Get rates for this parcel first.');
  const rate=matches[0];
  if(Date.now()-new Date(rate.quoted_at).getTime()>30*60_000)throw new ValidationError(
    'The carrier quote is older than 30 minutes. Refresh rates before approving a label purchase.');
  return prepareResult({shipmentId:shipment.id,rateId:rate.id,amountMinor:Number(rate.amount_minor),
    currency:rate.currency},`Buy one ${rate.carrier} ${rate.service} label for ${shipment.shipment_number} `+
    `at ${pricing.formatMinor(Number(rate.amount_minor),rate.currency)} from the merchant’s carrier account. `+
    'Approval queues the provider purchase; delivery is not yet confirmed.');
}

function returnResolution(value){
  const raw=String(value||'REFUND').trim().toUpperCase().replace(/[\s-]+/g,'_');
  if(['REFUND','EXCHANGE','NO_REFUND'].includes(raw))return raw;
  const words=new Set(raw.split(/[^A-Z]+/).filter(Boolean));
  const refund=words.has('REFUND')||words.has('CREDIT');
  const exchange=words.has('EXCHANGE');
  if(refund&&!exchange&&!words.has('NO')&&!words.has('NOT')&&!words.has('WITHOUT'))return 'REFUND';
  if(exchange&&!refund)return 'EXCHANGE';
  throw new ValidationError('Choose refund, exchange, or no refund as the return resolution.');
}

async function returnRequest(database,ctx,order,args){
  requireState(order,['FULFILLED','PARTIALLY_FULFILLED'],'This customer order');
  if(!args.reason)throw new ValidationError('State why the customer is returning the goods.');
  if(!args.location)throw new ValidationError('Name the quarantine location for returned stock.');
  const place=(await database.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1
    AND lower(name)=lower($2)`,[ctx.workspaceId,args.location])).rows;
  if(place.length!==1)throw new ValidationError('Choose one active quarantine location.');
  const lines=(await database.query(`SELECT sol.id,sol.sku_id,sol.quantity_fulfilled,s.code,i.name AS item_name,
    COALESCE((SELECT SUM(rl.quantity_authorized) FROM customer_return_lines rl
      JOIN customer_returns r ON r.id=rl.customer_return_id AND r.workspace_id=rl.workspace_id
      WHERE rl.workspace_id=sol.workspace_id AND rl.sales_order_line_id=sol.id AND r.status<>'CANCELLED'),0) AS already_returned
    FROM sales_order_lines sol JOIN skus s ON s.id=sol.sku_id AND s.workspace_id=sol.workspace_id
    JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    WHERE sol.workspace_id=$1 AND sol.sales_order_id=$2 AND sol.quantity_fulfilled>0`,
  [ctx.workspaceId,order.id])).rows;
  const eligible=args.sku?lines.filter((line)=>[line.code,line.item_name].some((candidate)=>
    candidate.toLowerCase()===String(args.sku).trim().toLowerCase())):lines;
  if(eligible.length!==1)throw new ValidationError(eligible.length?
    'More than one fulfilled product is on this order. Name the exact SKU being returned.':
    'No fulfilled line matches that product on this order.');
  const line=eligible[0],quantity=positive(args.quantity,'Return quantity');
  if(quantity>Number(line.quantity_fulfilled)-Number(line.already_returned))throw new ValidationError(
    'The return quantity exceeds fulfilled units not already in another return.');
  const resolution=returnResolution(args.returnResolution);
  return prepareResult({salesOrderId:order.id,quarantineLocationId:place[0].id,resolution,
    reason:args.reason,lines:[{salesOrderLineId:line.id,quantity}]},
  `Request return of ${quantity} × ${line.code} from ${order.order_number} into ${place[0].name}, `+
    `resolution ${resolution.toLowerCase().replace('_',' ')}. No refund or stock receipt occurs at this step.`);
}

async function transferReceipt(database,ctx,transfer){
  requireState(transfer,['SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED'],'This transfer');
  const lines=(await database.query(`SELECT l.id,l.shipped_quantity,l.received_quantity,l.lost_quantity,
    l.damaged_quantity,i.tracking_mode FROM inventory_transfer_lines l
    JOIN skus s ON s.id=l.sku_id AND s.workspace_id=l.workspace_id
    JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    WHERE l.workspace_id=$1 AND l.transfer_id=$2 ORDER BY l.id`,[ctx.workspaceId,transfer.id])).rows;
  if(lines.some((line)=>line.tracking_mode==='serial'))throw new ValidationError(
    'Serialized transfer receipt needs exact unit identities. Open the transfer and scan the physical units.');
  const pending=lines.map((line)=>({lineId:line.id,
    received:Number(line.shipped_quantity)-Number(line.received_quantity)-Number(line.lost_quantity)-Number(line.damaged_quantity),
    lost:0,damaged:0})).filter((line)=>line.received>0);
  if(!pending.length)throw new ValidationError('There is no in-transit quantity left to receive.');
  return prepareResult({recordId:transfer.id,lines:pending},
    `Record all ${pending.reduce((sum,line)=>sum+line.received,0)} remaining units on ${transfer.transfer_number} physically received in good condition. Report loss or damage separately.`);
}

async function shipmentPrepare(database,ctx,order,args){
  if(order.delivery_method!=='SHIP')throw new ValidationError('This customer order is not set for carrier shipping.');
  const ready=await fulfillment(database,ctx,order,args);
  return prepareResult({salesOrderId:order.id,lines:ready.payload.lines},
    `Pack ${ready.payload.lines.reduce((sum,line)=>sum+line.quantity,0)} allocated units from ${order.order_number} as one shipment. This does not buy a label or record carrier handoff.`);
}

async function returnReceive(database,ctx,customerReturn){
  requireState(customerReturn,['AUTHORIZED','PARTIALLY_RECEIVED'],'This customer return');
  const detail=await returns.getCustomerReturn(database,ctx.workspaceId,customerReturn.id);
  if(detail.lines.some((line)=>line.tracking_mode!=='quantity'))throw new ValidationError(
    'This return needs the exact returned lot or serial numbers. Open the return and scan the physical goods.');
  const lines=detail.lines.map((line)=>({lineId:line.id,
    quantity:Number(line.quantity_authorized)-Number(line.quantity_received)})).filter((line)=>line.quantity>0);
  if(!lines.length)throw new ValidationError('No authorized return quantity remains to receive.');
  return prepareResult({recordId:customerReturn.id,lines},
    `Receive all ${lines.reduce((sum,line)=>sum+line.quantity,0)} remaining returned units on ${customerReturn.return_number} into quarantine. This records physical receipt and restores documented inventory cost; it does not refund the customer.`);
}

async function returnInspect(database,ctx,customerReturn,args){
  requireState(customerReturn,['RECEIVED'],'This customer return');
  const disposition=String(args.disposition||'').toLowerCase();
  if(!['restock','scrap','repair'].includes(disposition))throw new ValidationError(
    'Choose restock, scrap, or repair for the physically inspected returned goods.');
  const detail=await returns.getCustomerReturn(database,ctx.workspaceId,customerReturn.id);
  let locationId=null;
  if(disposition!=='scrap'){
    const location=(await database.query(`SELECT id FROM locations WHERE workspace_id=$1 AND is_active=1
      AND lower(name)=lower($2)`,[ctx.workspaceId,args.location||''])).rows;
    if(location.length!==1)throw new ValidationError(`Choose one active ${disposition} location.`);
    locationId=location[0].id;
  }
  const lines=detail.lines.map((line)=>({lineId:line.id,
    restock:disposition==='restock'?Number(line.quantity_received):0,
    scrap:disposition==='scrap'?Number(line.quantity_received):0,
    repair:disposition==='repair'?Number(line.quantity_received):0,
    restockLocationId:disposition==='restock'?locationId:null,
    repairLocationId:disposition==='repair'?locationId:null,
    conditionNote:args.reason||null}));
  return prepareResult({recordId:customerReturn.id,lines},
    `Record inspection of every unit on ${customerReturn.return_number} as ${disposition}${args.location?` at ${args.location}`:''}. This applies the physical disposition but does not issue a customer refund.`);
}

async function returnRefund(database,ctx,customerReturn,args){
  requireState(customerReturn,['AWAITING_REFUND'],'This customer return');
  const destination=normalizeRefundDestination(args.refundDestination);
  const detail=await returns.getCustomerReturn(database,ctx.workspaceId,customerReturn.id);
  if(detail.resolution!=='REFUND')throw new ValidationError('This return does not have an approved refund resolution.');
  const amountMinor=detail.lines.reduce((sum,line)=>sum+(line.trackingEvidence.costAllocations||[])
    .reduce((part,allocation)=>part+Number(allocation.quantity)*Number(line.unit_price_minor),0),0);
  if(!Number.isSafeInteger(amountMinor)||amountMinor<=0)throw new ValidationError(
    'StockChief cannot verify a positive refund against the original sale.');
  return prepareResult({recordId:customerReturn.id,destination,amountMinor},
    `${destination==='CASH'?'Refund money already paid':'Reduce the unpaid invoice balance'} by `+
    `${pricing.formatMinor(amountMinor,detail.currency)} for ${customerReturn.return_number}. `+
    (destination==='CASH'?'An original provider payment is refunded through the verified provider first when one exists.':
      'No money is sent to the customer by this receivable adjustment.'));
}

function normalizeRefundDestination(value){
  const raw=String(value||'').trim().toUpperCase();
  if(['AR','CASH'].includes(raw))return raw;
  const words=raw.split(/[^A-Z]+/).filter(Boolean);
  const asserted=(terms)=>words.some((word,index)=>terms.includes(word)
    &&!words.slice(Math.max(0,index-4),index).some((prior)=>['NO','NOT','WITHOUT','NEVER'].includes(prior)));
  const receivable=asserted(['AR','RECEIVABLE','INVOICE','CREDIT','UNPAID']);
  const paidFunds=asserted(['CASH','MONEY','PROVIDER','PAID']);
  if(receivable&&!paidFunds)return 'AR';
  if(paidFunds&&!receivable)return 'CASH';
  throw new ValidationError('Choose whether to reduce an unpaid invoice balance or return money already paid.');
}

async function returnExchange(database,ctx,customerReturn){
  requireState(customerReturn,['INSPECTED'],'This customer return');
  const detail=await returns.getCustomerReturn(database,ctx.workspaceId,customerReturn.id);
  if(detail.resolution!=='EXCHANGE')throw new ValidationError('This return does not have an exchange resolution.');
  const lines=detail.lines.map((line)=>({skuId:line.sku_id,quantity:Number(line.quantity_received),unitPriceMinor:0}))
    .filter((line)=>line.quantity>0);
  if(!lines.length)throw new ValidationError('No inspected returned units are available for exchange.');
  return prepareResult({recordId:customerReturn.id,lines},
    `Prepare a zero-price replacement order for ${lines.reduce((sum,line)=>sum+line.quantity,0)} inspected units on ${customerReturn.return_number}. It will still need normal allocation and fulfillment.`);
}

async function autonomyMode(database,ctx,_row,args){
  const mode=String(args.mode||'').toUpperCase();
  if(!Object.values(autonomy.MODES).includes(mode))throw new ValidationError(
    'Choose watch only, ask first, or bounded automatic work.');
  if(mode==='POLICY_AUTOMATED')await entitlements.assertCapability(database,
    await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId),'authority.advanced');
  return prepareResult({mode},`Set StockChief automatic-work mode to ${mode.toLowerCase().replace(/_/g,' ')}. Existing rules and limits still apply.`);
}

async function workspaceRename(database,ctx,_row,args){
  const name=String(args.workspaceName||'').trim();
  if(!name||name.length>120)throw new ValidationError('Inventory name must be between 1 and 120 characters.');
  const current=(await database.query('SELECT name FROM workspaces WHERE id=$1',[ctx.workspaceId])).rows[0];
  if(!current)throw new ValidationError('This inventory is no longer available.');
  return prepareResult({name,expectedName:current.name},
    `Rename this inventory from ${current.name} to ${name}. Products, orders and connections remain unchanged.`);
}
async function emailAlerts(database,ctx,_row,args){
  const raw=String(args.enabled||'').toLowerCase();
  if(!['true','false'].includes(raw))throw new ValidationError('Say whether automatic email alerts should be on or off.');
  const current=(await database.query('SELECT * FROM notification_email_settings WHERE workspace_id=$1',
    [ctx.workspaceId])).rows[0];
  const severity=String(args.minimumSeverity||current?.minimum_severity||'important').toLowerCase();
  if(!['critical','important','all'].includes(severity))throw new ValidationError(
    'Email alert threshold must be critical, important, or all.');
  const storedRecipients=typeof current?.recipients==='string'?JSON.parse(current.recipients||'[]'):
    current?.recipients;
  const recipients=args.recipientEmails==null?(Array.isArray(storedRecipients)?storedRecipients:[]):
    [...new Set(String(args.recipientEmails).split(/[\s,;]+/).map((email)=>email.trim().toLowerCase()).filter(Boolean))];
  if(recipients.some((email)=>!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))throw new ValidationError(
    'Enter valid alert email addresses.');
  return prepareResult({enabled:raw==='true',minimumSeverity:severity,recipients,
    expectedUpdatedAt:current?.updated_at?new Date(current.updated_at).toISOString():null},
  `${raw==='true'?'Enable':'Disable'} automatic email alerts at ${severity} severity${recipients.length?
    ` for ${recipients.join(', ')}`:''}. This changes preferences, not past alerts.`);
}
async function shippingMode(database,ctx,_row,args){
  const mode=String(args.mode||'').toUpperCase();
  if(!['MANUAL','RECOMMEND','AUTOMATIC'].includes(mode))throw new ValidationError(
    'Choose manual shipping, rate recommendations, or bounded automatic shipping.');
  if(mode==='AUTOMATIC')await entitlements.assertCapability(database,
    await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId),'shipping.automation');
  const previous=(await database.query('SELECT mode FROM shipping_operation_policy WHERE workspace_id=$1',
    [ctx.workspaceId])).rows[0]?.mode||'RECOMMEND';
  return prepareResult({mode,previous},`Change shipping handling from ${previous} to ${mode}. `+
    'Automatic postage still requires an approved matching rule and bounded authority.');
}
async function shippingRule(database,ctx,_row,args){
  const maxCostMinor=args.maxCost==null?null:Math.round(Number(args.maxCost)*100);
  const maxDeliveryDays=args.maxDeliveryDays==null?null:Number(args.maxDeliveryDays);
  if(maxCostMinor!==null&&(!Number.isSafeInteger(maxCostMinor)||maxCostMinor<0))throw new ValidationError(
    'Enter a valid maximum postage cost.');
  if(maxDeliveryDays!==null&&(!Number.isSafeInteger(maxDeliveryDays)||maxDeliveryDays<1||maxDeliveryDays>30))
    throw new ValidationError('Delivery days must be between 1 and 30.');
  const promised=args.requireByPromised==null?false:String(args.requireByPromised).toLowerCase()==='true';
  if(args.requireByPromised!=null&&!['true','false'].includes(String(args.requireByPromised).toLowerCase()))
    throw new ValidationError('Say whether delivery by the promised date is required.');
  const carrier=String(args.carrier||'').trim()||null;
  const service=String(args.service||'').trim()||null;
  if(!carrier&&!service&&maxCostMinor===null&&maxDeliveryDays===null&&!promised)throw new ValidationError(
    'Give at least one shipping limit, carrier, service, or promised-date requirement.');
  const name=[carrier?carrier.toUpperCase():'Any carrier',service,
    maxCostMinor!==null?`under $${(maxCostMinor/100).toFixed(2)}`:null].filter(Boolean).join(' · ');
  return prepareResult({ruleId:newId('shiprule'),name,carrier,service,maxCostMinor,maxDeliveryDays,
    requireByPromised:promised,statedText:String(args.statedText||'').trim()||null},
  `Create a shipping rule for ${name}${maxDeliveryDays?`, no more than ${maxDeliveryDays} days`:''}`+
    `${promised?', arriving by the promised date':''}. This does not purchase postage.`);
}
function shippingPackage(_database,_ctx,row,args){
  if(['SHIPPED','DELIVERED','CANCELLED'].includes(row.status)||
    ['PURCHASED','PENDING'].includes(row.label_status))throw new ValidationError(
    'Package measurements cannot change after the parcel leaves or is cancelled.');
  if(Number(row.package_count)>1)throw new ValidationError(
    'This shipment has multiple parcels. Open it and review each measured package individually.');
  const weight=positive(args.weightGrams,'Package weight in grams');
  const dimensions={};
  for(const field of ['lengthMm','widthMm','heightMm']){
    const value=args[field]==null?null:positive(args[field],field);
    dimensions[field]=value;
  }
  if(Object.values(dimensions).filter((value)=>value!==null).length%3!==0)throw new ValidationError(
    'Give all three parcel dimensions, or only the measured weight.');
  return prepareResult({recordId:row.id,expectedStatus:row.status,expectedPackageCount:Number(row.package_count),
    box:{weightGrams:weight,...dimensions}},
  `Save measured parcel weight ${weight} grams${dimensions.lengthMm?
    ` and dimensions ${dimensions.lengthMm} × ${dimensions.widthMm} × ${dimensions.heightMm} mm`:''} `+
    `for ${row.shipment_number}. Carrier rates must be refreshed after a measurement change.`);
}
async function shippingQuote(database,ctx,row){
  if(!['PICKING','PACKED'].includes(row.status)||['PURCHASED','PENDING'].includes(row.label_status))
    throw new ValidationError('Only a prepared, not-yet-shipped parcel without a purchased label can request new rates.');
  const view=await shipping.state(database,ctx.workspaceId,row.id);
  if(!view.ready)throw new ValidationError(`Carrier rates are not ready: ${view.blocked.join(' ')}`);
  return prepareResult({recordId:row.id,fingerprint:shipping.quoteFingerprint(view),
    provider:view.account.provider},
  `Request fresh carrier rates for ${row.shipment_number} using its measured parcel, addresses, and `+
    `${view.account.provider} account. No postage will be purchased.`);
}
function productDetails(_database,_ctx,row,args){
  const fields=['itemName','baseCode','itemDescription','unitLabel','allowNegative'];
  if(!fields.some((field)=>args[field]!=null))throw new ValidationError(
    'Say which product detail to change; nothing was changed.');
  const value={name:args.itemName==null?row.name:String(args.itemName).trim(),
    baseCode:args.baseCode==null?row.base_code:String(args.baseCode).trim(),
    description:args.itemDescription==null?row.description:String(args.itemDescription),
    unitLabel:args.unitLabel==null?row.unit_label:String(args.unitLabel).trim(),
    allowNegative:args.allowNegative==null?Boolean(Number(row.allow_negative)):
      String(args.allowNegative).toLowerCase()==='true'};
  if(args.allowNegative!=null&&!['true','false'].includes(String(args.allowNegative).toLowerCase()))
    throw new ValidationError('Say whether negative stock should be allowed: true or false.');
  if(!value.name||value.name.length>240)throw new ValidationError('Enter a product name up to 240 characters.');
  const changed=fields.filter((field)=>args[field]!=null).join(', ');
  return prepareResult({recordId:row.id,expectedUpdatedAt:new Date(row.updated_at).toISOString(),value},
    `Update ${changed} for product ${row.name}. Existing stock, orders, and cost history remain unchanged.`);
}
function contactDetails(kind,row,args){
  const isCustomer=kind==='customer';
  const possible=isCustomer?['contactDisplayName','company','recipientEmail','phone','shipToAddress','notes']:
    ['contactDisplayName','contactName','recipientEmail','phone','notes'];
  if(!possible.some((field)=>args[field]!=null))throw new ValidationError(
    `Say which ${kind} detail to change; nothing was changed.`);
  const name=args.contactDisplayName==null?row.name:String(args.contactDisplayName).trim();
  if(!name||name.length>(isCustomer?160:240))throw new ValidationError(
    `Enter a ${kind} name up to ${isCustomer?160:240} characters.`);
  const email=args.recipientEmail==null?row.email:String(args.recipientEmail).trim().toLowerCase();
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new ValidationError('Enter a valid email address.');
  const value={name,email,phone:args.phone==null?row.phone:String(args.phone).trim()||null,
    notes:args.notes==null?row.notes:String(args.notes).trim()||null};
  if(isCustomer){value.company=args.company==null?row.company:String(args.company).trim()||null;
    value.shippingAddress=args.shipToAddress==null?row.shipping_address:String(args.shipToAddress).trim()||null;}
  else value.contactName=args.contactName==null?row.contact_name:String(args.contactName).trim()||null;
  return prepareResult({recordId:row.id,expectedUpdatedAt:new Date(row.updated_at).toISOString(),value},
    `Update ${possible.filter((field)=>args[field]!=null).join(', ')} for ${kind} ${row.name}. `+
    'Existing orders, invoices and posted history remain unchanged.');
}
function mailboxState(_database,_ctx,row,args){
  const target=String(args.mailboxState||'').trim().toUpperCase().replace(/[\s-]+/g,'_');
  if(!['NEEDS_REPLY','WAITING','HANDLED'].includes(target))throw new ValidationError(
    'Choose needs reply, waiting, or handled for this message.');
  return prepareResult({recordId:row.id,expectedState:row.reply_state,target,reason:args.reason||null},
    `Mark ${row.subject||'this message'} ${target.toLowerCase().replace('_',' ')}. `+
    'No reply will be sent and no business record will be deleted.');
}
function teamInvitation(_database,_ctx,_row,args){
  const email=String(args.inviteeEmail||'').trim().toLowerCase();
  const name=String(args.inviteeName||'').trim();
  const role=String(args.memberRole||'staff').trim().toLowerCase();
  if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new ValidationError(
    'Give the exact work email address for the invitee.');
  if(!name||name.length>120)throw new ValidationError('Give the invitee’s name, up to 120 characters.');
  if(!['owner','staff','accountant'].includes(role))throw new ValidationError(
    'Choose owner, staff, or accountant access.');
  if(!config.connections.publicOrigin)throw new ValidationError(
    'A public StockChief URL must be configured before inviting a teammate.');
  return prepareResult({email,name,role},`Invite ${name} (${email}) to this inventory as ${role}. `+
    'The invitation email is queued after approval; access begins only when they accept.');
}
function importApproval(_database,_ctx,row){
  if(row.status!=='READY'||!['DRAFT','AWAITING_APPROVAL'].includes(row.approval_status))
    throw new ValidationError('This import preview is not waiting for approval.');
  if(!Number(row.records_valid))throw new ValidationError('This preview has no valid rows to import.');
  return prepareResult({recordId:row.id,integrityHash:row.integrity_hash},
    `Approve the exact ${row.source_name} preview: ${row.records_valid} valid and `+
    `${row.records_invalid} invalid rows. Approval alone changes no stock.`);
}
function importRun(_database,_ctx,row){
  if(row.status!=='READY'||row.approval_status!=='APPROVED')throw new ValidationError(
    'Approve the current preview before importing.');
  return prepareResult({recordId:row.id,integrityHash:row.integrity_hash},
    `Queue import and verification of ${row.records_valid} valid rows from ${row.source_name}. `+
    'The worker will record completion or a failure; it will not silently duplicate this source.');
}
function importCancel(_database,_ctx,row){
  if(row.status!=='READY')throw new ValidationError('Only an import waiting to run can be cancelled.');
  return prepareResult({recordId:row.id,integrityHash:row.integrity_hash},
    `Cancel the ${row.source_name} preview. No stock will be imported.`);
}
async function sendSavedReply(database,ctx,row){
  if(!row.draft_subject||!row.draft_body)throw new ValidationError(
    'This message has no saved reply to review. Prepare and edit a draft first.');
  if(row.reply_sent_at)throw new ValidationError('A reply to this message was already sent.');
  await entitlements.assertCapability(database,
    await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId),'communications.send_approved');
  return prepareResult({recordId:row.id,subject:row.draft_subject,body:row.draft_body},
    `Queue the saved reply “${row.draft_subject}” to ${row.sender}. Review its exact text before approving. `+
    'StockChief will say sent only after the mailbox provider confirms delivery.');
}

function dateOnly(value,label){
  const text=String(value||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text)||!Number.isFinite(Date.parse(`${text}T00:00:00Z`))||
    new Date(`${text}T00:00:00Z`).toISOString().slice(0,10)!==text)
    throw new ValidationError(`${label} must be a real date in YYYY-MM-DD format.`);
  return text;
}
function moneyMinor(value,label){
  if(!/^-?\d+(?:\.\d{1,2})?$/.test(String(value||'').trim()))
    throw new ValidationError(`${label} must be an exact money amount.`);
  const minor=Math.round(Number(value)*100);
  if(!Number.isSafeInteger(minor))throw new ValidationError(`${label} is too large.`);
  return minor;
}
async function supplierReturnRequest(database,ctx,order,args){
  if(!args.reason)throw new ValidationError('State why stock is being returned to the supplier.');
  const quantity=positive(args.quantity,'Supplier return quantity');
  const lines=(await database.query(`SELECT pol.sku_id,pol.destination_location_id,s.code,i.name,
    i.tracking_mode FROM purchase_order_lines pol JOIN skus s ON s.id=pol.sku_id
    JOIN items i ON i.id=s.item_id WHERE pol.workspace_id=$1 AND pol.purchase_order_id=$2`,
  [ctx.workspaceId,order.id])).rows;
  const wanted=String(args.sku||'').trim().toLowerCase();
  const matches=wanted?lines.filter((line)=>line.code.toLowerCase()===wanted||line.name.toLowerCase()===wanted):lines;
  if(matches.length!==1)throw new ValidationError(matches.length?
    'This purchase order has multiple products. Name the exact SKU to return.':
    'No product on that purchase order matches the named SKU.');
  const line=matches[0];
  const tracking={};
  if(line.tracking_mode==='lot'){
    const lotCode=String(args.lotBarcode||'').trim();
    if(!lotCode)throw new ValidationError('Name the exact physical lot code being returned.');
    tracking.lotCode=lotCode;
  }else if(line.tracking_mode==='serial'){
    const serials=String(args.serialNumbers||'').split(',').map(value=>value.trim()).filter(Boolean);
    if(serials.length!==quantity||new Set(serials.map(value=>value.toLowerCase())).size!==quantity)
      throw new ValidationError('Name each distinct physical serial number being returned, one per unit.');
    tracking.serials=serials;
  }else if(args.lotBarcode||args.serialNumbers)throw new ValidationError(
    'This SKU is quantity-tracked; no lot or serial identity belongs on this return.');
  const bill=(await database.query(`SELECT id FROM accounting_supplier_bills WHERE workspace_id=$1
    AND purchase_order_id=$2 AND status IN ('OPEN','PARTIALLY_PAID') ORDER BY created_at DESC LIMIT 2`,
  [ctx.workspaceId,order.id])).rows;
  if(bill.length>1)throw new ValidationError('More than one open supplier bill matches this purchase order. Choose it in the return screen.');
  const expectedCreditMinor=args.amount==null?null:moneyMinor(args.amount,'Expected supplier credit');
  if(expectedCreditMinor!==null&&expectedCreditMinor<=0)throw new ValidationError('Expected supplier credit must be positive.');
  return prepareResult({supplierId:order.supplier_id,supplierBillId:bill[0]?.id||null,
    expectedCreditMinor,reason:args.reason,lines:[{skuId:line.sku_id,
      locationId:line.destination_location_id,quantity,...tracking}]},
  `Request return of ${quantity} ${line.code} from ${order.po_number} to its supplier. `+
    'Stock remains on hand until shipping is separately approved; a credit is not assumed.');
}
function supplierCredit(_database,_ctx,row,args){
  requireState(row,['AWAITING_CREDIT'],'This supplier return');
  if(!row.supplier_bill_id)throw new ValidationError('This return has no matched open supplier bill. Match it in the supplier-return screen first.');
  const amountMinor=moneyMinor(args.amount,'Received supplier credit');
  if(amountMinor<=0)throw new ValidationError('The received supplier credit must be positive.');
  const creditNumber=String(args.creditNumber||'').trim();
  if(!creditNumber)throw new ValidationError('State the supplier’s actual credit-note number.');
  const creditDate=dateOnly(args.creditDate,'Credit date');
  return prepareResult({recordId:row.id,amountMinor,creditNumber,creditDate},
    `Reconcile supplier credit ${creditNumber} for ${row.return_number} at `+
    `${pricing.formatMinor(amountMinor,row.currency||'USD')}. This reduces the matched payable, `+
    'posts the cost difference, and marks any expected-credit mismatch explicitly.');
}
function warehouseScan(_database,_ctx,row,args){
  requireState(row,['PICKING','BLOCKED'],'This fulfillment wave');
  const locationBarcode=String(args.scanLocation||'').trim();
  const itemBarcode=String(args.scanItem||'').trim();
  if(!locationBarcode||!itemBarcode)throw new ValidationError('Give both the actual scanned location and product barcodes.');
  const quantity=positive(args.quantity||1,'Picked quantity');
  return prepareResult({recordId:row.id,locationBarcode,itemBarcode,quantity,
    lotBarcode:args.lotBarcode||null,serialBarcode:args.serialBarcode||null},
  `Scan ${quantity} ${itemBarcode} at ${locationBarcode} into wave ${row.title}. `+
    'The warehouse engine will verify the physical identity, allocation and remaining quantity.');
}
function bankImport(_database,_ctx,row,args){
  if(!Number(row.active))throw new ValidationError('This financial account is inactive.');
  const transactionDate=dateOnly(args.transactionDate,'Bank transaction date');
  const amountMinor=moneyMinor(args.amount,'Bank transaction amount');
  if(!amountMinor)throw new ValidationError('Bank transaction amount cannot be zero.');
  const description=String(args.description||'').trim();
  if(!description||description.length>500)throw new ValidationError('Give the exact bank transaction description.');
  return prepareResult({recordId:row.id,transactionDate,amount:String(args.amount),description,
    externalId:args.externalId||null},`Import one ${transactionDate} statement line for ${row.name}: `+
    `${pricing.formatMinor(Math.abs(amountMinor),row.currency||'USD')} ${amountMinor<0?'out':'in'}. `+
    'This creates unmatched bank evidence, not an accounting posting.');
}
function bankReconcile(_database,_ctx,row,args){
  if(!Number(row.active))throw new ValidationError('This financial account is inactive.');
  const statementEndDate=dateOnly(args.statementEndDate,'Statement ending date');
  moneyMinor(args.statementEndingBalance,'Statement ending balance');
  const complete=String(args.enabled||'').toLowerCase();
  if(!['true','false'].includes(complete))throw new ValidationError(
    'Say whether to complete the reconciliation now or save it for review.');
  return prepareResult({recordId:row.id,statementEndDate,
    statementEndingBalance:String(args.statementEndingBalance),complete:complete==='true'},
  `${complete==='true'?'Complete':'Save for review'} ${row.name} reconciliation through ${statementEndDate} `+
    `at ${args.statementEndingBalance}. Completion requires exact ledger balance and zero unmatched lines.`);
}
async function accountMapping(database,ctx,row,args){
  if(!['quickbooks','xero'].includes(row.provider_type))throw new ValidationError('Choose a QuickBooks or Xero accounting connection.');
  const code=String(args.accountCode||'').trim();
  const externalId=String(args.externalId||'').trim();
  if(!code||!externalId)throw new ValidationError('Give the exact StockChief account code and verified provider account ID.');
  const matches=(await database.query(`SELECT id,name FROM accounting_accounts WHERE workspace_id=$1
    AND active=1 AND lower(code)=lower($2)`,[ctx.workspaceId,code])).rows;
  if(matches.length!==1)throw new ValidationError('That account code does not identify one active StockChief account.');
  return prepareResult({recordId:row.id,accountId:matches[0].id,accountCode:code,externalId},
    `Map StockChief account ${code} (${matches[0].name}) to provider account ${externalId} `+
    `on ${row.display_name}. The canonical connection service requires prior provider snapshot evidence.`);
}

const SPECS=Object.freeze([
  {name:'sales_order.revise_draft_line',description:'Change the exact quantity and optionally per-unit price of one product already on an existing DRAFT customer order. Preserve customer, date, pickup or shipping method and every other line. Do not confirm, reserve, invoice, fulfill, send or charge anything.',
    singleEffectPerTarget:true,record:'sales_order',fields:['recordReference','sku','quantity','amount'],
    permission:permissions.MANAGE_SALES,capability:'sales_orders.core',
    build:async(database,ctx,row,args)=>{
      requireState(row,['DRAFT'],'This customer order');
      const wanted=String(args.sku||'').trim().toLowerCase();
      if(!wanted)throw new ValidationError('Which product on this draft order should change?');
      const matches=(await database.query(`SELECT l.id,l.sku_id,l.quantity_ordered,l.unit_price_minor,
        s.code,i.name FROM sales_order_lines l JOIN skus s ON s.id=l.sku_id AND s.workspace_id=l.workspace_id
        JOIN items i ON i.id=s.item_id AND i.workspace_id=l.workspace_id
        WHERE l.workspace_id=$1 AND l.sales_order_id=$2 AND
          (lower(s.code)=lower($3) OR lower(i.name)=lower($3))`,
      [ctx.workspaceId,row.id,wanted])).rows;
      if(matches.length!==1)throw new ValidationError(matches.length
        ?'More than one order line matches that product. Give its exact SKU code.':
          'That product is not on this draft customer order.');
      const line=matches[0],quantity=positive(args.quantity,'Draft order quantity');
      const changedPrice=args.amount!=null;
      const amount=changedPrice?Number(args.amount):null;
      if(changedPrice&&(!Number.isFinite(amount)||amount<0||
        Math.abs(Math.round(amount*100)-amount*100)>0.000001))
        throw new ValidationError('State a valid per-unit selling price with at most two decimal places.');
      const unitPriceMinor=changedPrice?Math.round(amount*100):
        line.unit_price_minor==null?NaN:Number(line.unit_price_minor);
      if(!Number.isSafeInteger(unitPriceMinor)||unitPriceMinor<0)
        throw new ValidationError('This order line needs a verified per-unit price before changing it.');
      return prepareResult({recordId:row.id,skuId:line.sku_id,quantity,unitPriceMinor,
        expectedVersion:Number(row.version),expectedQuantity:Number(line.quantity_ordered),
        expectedUnitPriceMinor:Number(line.unit_price_minor)},
      `Change only ${line.name} (${line.code}) on draft ${row.order_number} from ${line.quantity_ordered} to ${quantity} units `+
        `at ${pricing.formatMinor(unitPriceMinor,row.currency)} each. `+
        `Needed by ${row.needed_by||'not set'}; ${String(row.delivery_method||'delivery method not set').toLowerCase()}. `+
        'The order remains a draft; no stock is reserved, invoice is posted, or message is sent.');
    },
    execute:(client,ctx,p)=>workflows.reviseDraftSalesOrderLineInTransaction(client,ctx,p.recordId,p),
    verify:async(client,ctx,result,p)=>Boolean(result.status==='DRAFT'&&result.quantity===p.quantity&&
      (await client.query(`SELECT 1 FROM sales_orders o JOIN sales_order_lines l
        ON l.sales_order_id=o.id AND l.workspace_id=o.workspace_id
        WHERE o.workspace_id=$1 AND o.id=$2 AND o.status='DRAFT' AND o.version=$3
          AND l.sku_id=$4 AND l.quantity_ordered=$5 AND l.unit_price_minor=$6
          AND NOT EXISTS (SELECT 1 FROM sales_order_allocations a WHERE a.workspace_id=o.workspace_id
            AND a.sales_order_line_id=l.id)`,
      [ctx.workspaceId,p.recordId,p.expectedVersion+1,p.skuId,p.quantity,p.unitPriceMinor])).rows.length)},
  {name:'sales_order.confirm',description:'Confirm an existing draft customer order and reserve available stock; report a real shortage rather than invent stock.',
    singleEffectPerTarget:true,
    record:'sales_order',fields:['recordReference'],permission:permissions.MANAGE_SALES,capability:'sales_orders.core',
    states:['DRAFT','CONFIRMED','BACKORDERED'],verb:'Confirm and allocate',
    execute:(client,ctx,p)=>workflows.confirmSalesOrderInTransaction(client,ctx,p.recordId,p),
    verify:(client,ctx,r,p)=>state(client,ctx,'sales_orders',p.recordId,[r.status])},
  {name:'sales_order.reserve_all',description:'Confirm an existing draft or backordered customer order only if every open unit can be reserved now. If stock is insufficient, leave the order and allocations unchanged and explain the shortage; do not substitute a partial backorder.',
    singleEffectPerTarget:true,
    record:'sales_order',fields:['recordReference'],permission:permissions.MANAGE_SALES,capability:'sales_orders.core',
    states:['DRAFT','CONFIRMED','BACKORDERED'],verb:'Reserve all remaining stock for',
    execute:(client,ctx,p)=>workflows.confirmSalesOrderInTransaction(client,ctx,p.recordId,{...p,requireFullAllocation:true}),
    verify:async(client,ctx,r,p)=>Boolean(!r.shortage&&r.status==='CONFIRMED'&&
      await state(client,ctx,'sales_orders',p.recordId,['CONFIRMED']))},
  {name:'sales_order.fulfill',description:'Record allocated, quantity-tracked goods physically leaving an existing customer order; atomically post inventory, revenue, cost and invoice. Never substitute a draft or a shipment label.',
    record:'sales_order',fields:['recordReference','sku','quantity'],permission:permissions.FULFILL_SALES,
    capability:'fulfillment.core',build:fulfillment,
    execute:(client,ctx,p)=>workflows.fulfillSalesOrderInTransaction(client,ctx,p.salesOrderId,p),
    verify:async(client,ctx,r,p)=>Boolean(r.invoiceId&&r.lines?.length===p.lines.length&&
      await state(client,ctx,'sales_orders',p.salesOrderId,[r.status]))},
  {name:'sales_order.cancel',description:'Cancel the unfulfilled remainder of an existing customer order and release its stock commitment; do not reverse goods that already left.',
    record:'sales_order',fields:['recordReference','reason'],permission:permissions.FULFILL_SALES,
    capability:'sales_orders.core',states:['DRAFT','CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED'],verb:'Cancel the open remainder of',
    execute:(client,ctx,p)=>workflows.cancelSalesOrderInTransaction(client,ctx,p.recordId,p),
    verify:(client,ctx,_r,p)=>state(client,ctx,'sales_orders',p.recordId,['CANCELLED','PARTIALLY_FULFILLED'])},
  {name:'sales_order.allocation_priority',description:'Change one open customer order’s allocation priority and needed-by date without silently reallocating, shipping, or charging the customer.',
    record:'sales_order',fields:['recordReference','allocationPriority','neededBy'],
    permission:permissions.MANAGE_SALES,capability:'sales_orders.core',
    build:(_database,_ctx,row,args)=>{if(['FULFILLED','CANCELLED'].includes(row.status))throw new ValidationError(
      'A finished order cannot be reprioritized.');
      const priority=Number(args.allocationPriority);
      if(!Number.isSafeInteger(priority)||priority<0||priority>1000)throw new ValidationError(
        'State an allocation priority from 0 to 1000.');
      const neededBy=args.neededBy==null?row.needed_by:String(args.neededBy);
      if(neededBy&&!/^\d{4}-\d{2}-\d{2}$/.test(String(neededBy)))throw new ValidationError(
        'The needed-by date must be YYYY-MM-DD.');
      return prepareResult({recordId:row.id,expectedVersion:Number(row.version),priority,neededBy},
        `Set allocation priority of ${row.order_number} to ${priority}${neededBy?` and needed-by date to ${neededBy}`:''}. `+
        'This changes scheduling preferences, not physical stock or payment.');},
    execute:async(client,ctx,p)=>{const changed=await client.query(`UPDATE sales_orders SET allocation_priority=$3,
      needed_by=$4,updated_at=$5,version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$6
      AND status NOT IN ('FULFILLED','CANCELLED') RETURNING version`,
      [ctx.workspaceId,p.recordId,p.priority,p.neededBy,nowIso(),p.expectedVersion]);
      if(!changed.rows.length)throw new ValidationError('This order changed after review. Ask again.');
      return changed.rows[0];},
    verify:async(client,ctx,r,p)=>Boolean(Number(r.version)===p.expectedVersion+1&&
      (await client.query(`SELECT allocation_priority,needed_by FROM sales_orders
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,p.recordId])).rows.some((row)=>
        Number(row.allocation_priority)===p.priority&&String(row.needed_by||'')===String(p.neededBy||'')))},
  {name:'shipping.prepare',description:'Pack existing allocated lines of a confirmed shipping order into one shipment, without buying postage or recording handoff.',
    record:'sales_order',fields:['recordReference','sku','quantity'],permission:permissions.FULFILL_SALES,
    capability:'shipping.workflow',build:shipmentPrepare,
    execute:(client,ctx,p)=>shipping.prepare(sameClient(client),ctx,p.salesOrderId,p),
    verify:async(client,ctx,r,p)=>Boolean(r.shipmentId&&await state(client,ctx,'sales_shipments',r.shipmentId,['PACKED'])&&
      (await client.query(`SELECT COUNT(*)::int AS count FROM sales_shipment_lines WHERE workspace_id=$1 AND shipment_id=$2`,
      [ctx.workspaceId,r.shipmentId])).rows[0].count===p.lines.length)},
  {name:'shipping.package_measurement',description:'Set the measured weight and optional dimensions of one not-yet-shipped parcel, invalidating stale carrier quotes. Multi-parcel shipments require individual review.',
    record:'shipment',fields:['recordReference','weightGrams','lengthMm','widthMm','heightMm'],
    permission:permissions.FULFILL_SALES,capability:'shipping.workflow',build:shippingPackage,
    execute:async(client,ctx,p)=>{const row=(await client.query(`SELECT status,package_count,label_status
      FROM sales_shipments WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [ctx.workspaceId,p.recordId])).rows[0];
      if(!row||row.status!==p.expectedStatus||Number(row.package_count)!==p.expectedPackageCount||
        ['PURCHASED','PENDING'].includes(row.label_status))throw new ValidationError(
        'This parcel changed after review. Measure it again before saving.');
      return shipping.setPackages(sameClient(client),ctx,p.recordId,[p.box]);},
    verify:async(client,ctx,_r,p)=>Boolean((await client.query(`SELECT weight_grams,length_mm,width_mm,
      height_mm FROM shipment_packages WHERE workspace_id=$1 AND shipment_id=$2`,
      [ctx.workspaceId,p.recordId])).rows.some((box)=>Number(box.weight_grams)===p.box.weightGrams&&
        Number(box.length_mm||0)===Number(p.box.lengthMm||0)&&
        Number(box.width_mm||0)===Number(p.box.widthMm||0)&&
        Number(box.height_mm||0)===Number(p.box.heightMm||0))&&
      (await client.query(`SELECT COUNT(*)::int AS count FROM shipment_rates
        WHERE workspace_id=$1 AND shipment_id=$2`,[ctx.workspaceId,p.recordId])).rows[0].count===0)},
  {name:'shipping.quote',description:'Request fresh live carrier rates for a measured, addressed, not-yet-shipped parcel using the inventory’s own postage account. Approval queues a bounded provider call; it does not buy a label.',
    record:'shipment',fields:['recordReference'],permission:permissions.FULFILL_SALES,
    capability:'shipping.rates',build:shippingQuote,
    execute:async(client,ctx,p)=>{const view=await shipping.state(sameClient(client),ctx.workspaceId,p.recordId);
      if(!view.ready||shipping.quoteFingerprint(view)!==p.fingerprint)throw new ValidationError(
        'The parcel, address, or postage account changed after review. Ask again for current rates.');
      return jobQueue.enqueue(sameClient(client),{workspaceId:ctx.workspaceId,
        kind:'shipping.quote',idempotencyKey:`ask-quote:${p.idempotencyKey}`,
        payload:{shipmentId:p.recordId,actorId:ctx.actorId,fingerprint:p.fingerprint,
          provider:p.provider},priority:25,maxAttempts:1});},
    verify:async(client,ctx,r,p)=>Boolean(r.job?.id&&
      (await client.query(`SELECT 1 FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND id=$2
        AND kind='shipping.quote' AND payload->>'shipmentId'=$3`,
      [ctx.workspaceId,r.job.id,p.recordId])).rows.length)},
  {name:'purchase_order.approve',description:'Approve the priced lines of an existing draft purchase order; approval does not send the supplier an order.',
    record:'purchase_order',fields:['recordReference'],permission:permissions.APPROVE_PO,
    capability:'purchasing.core',states:['DRAFT','AWAITING_APPROVAL'],verb:'Approve',
    execute:(client,ctx,p)=>workflows.approvePurchaseOrder(sameClient(client),ctx,p.recordId,p),
    verify:(client,ctx,_r,p)=>state(client,ctx,'purchase_orders',p.recordId,['APPROVED'])},
  {name:'purchase_order.revise_draft_line',description:'Change the ordered stock-unit quantity of one exact line on an unapproved draft purchase order. Preserve its recorded supplier unit cost, supplier, and destination. No supplier message, receipt, or invoice is created.',
    record:'purchase_order',fields:['recordReference','sku','quantity'],permission:permissions.CREATE_PO,
    capability:'purchasing.core',build:async(database,ctx,row,args)=>{
      requireState(row,['DRAFT','AWAITING_APPROVAL'],'This purchase order');
      const quantity=positive(args.quantity,'Revised ordered quantity');
      const lines=(await database.query(`SELECT pol.id,pol.quantity_units,pol.quantity_received_units,
        pol.units_per_purchase_unit,pol.unit_cost,s.code,i.name
        FROM purchase_order_lines pol JOIN skus s ON s.id=pol.sku_id AND s.workspace_id=pol.workspace_id
        JOIN items i ON i.id=s.item_id AND i.workspace_id=pol.workspace_id
        WHERE pol.workspace_id=$1 AND pol.purchase_order_id=$2 ORDER BY pol.line_number`,
      [ctx.workspaceId,row.id])).rows;
      const named=String(args.sku||'').trim().toLowerCase();
      const selected=named?lines.filter((line)=>line.code.toLowerCase()===named||
        line.name.toLowerCase()===named):lines;
      if(selected.length!==1)throw new ValidationError(named?
        'Name the exact SKU on this draft purchase order; no line was changed.':
        'This order has several lines. Name the exact SKU to revise.');
      const line=selected[0];
      if(Number(line.quantity_received_units)!==0)throw new ValidationError(
        'This line already has received stock and cannot be revised as a draft.');
      if(quantity%Number(line.units_per_purchase_unit)!==0)throw new ValidationError(
        `Order a multiple of ${line.units_per_purchase_unit} stock units for this supplier pack.`);
      const cost=line.unit_cost==null?null:Number(line.unit_cost);
      return prepareResult({recordId:row.id,lineId:line.id,quantityUnits:quantity,
        expectedQuantityUnits:Number(line.quantity_units),expectedUpdatedAt:new Date(row.updated_at).toISOString()},
      `Revise ${row.po_number}: ${line.code} from ${line.quantity_units} to ${quantity} stock units`+
        `${cost==null?' (unit cost not yet recorded)':` at ${row.currency} ${cost.toFixed(2)} per unit, new line total ${row.currency} ${(cost*quantity).toFixed(2)}`}. `+
        'Keep this draft unapproved; no supplier message or inventory movement occurs.');},
    execute:(client,ctx,p)=>workflows.reviseDraftPurchaseOrderLineInTransaction(client,ctx,p.recordId,p),
    verify:async(client,ctx,r,p)=>Boolean(r.lineId===p.lineId&&r.quantityUnits===p.quantityUnits&&
      (await client.query(`SELECT 1 FROM purchase_order_lines WHERE workspace_id=$1
        AND purchase_order_id=$2 AND id=$3 AND quantity_units=$4`,
      [ctx.workspaceId,p.recordId,p.lineId,p.quantityUnits])).rows.length&&
      await state(client,ctx,'purchase_orders',p.recordId,['DRAFT','AWAITING_APPROVAL']))},
  {name:'purchase_order.place',description:'Approved PO only: record ORDERED status internally; no email, API transmission, or supplier acceptance. This records the business commitment but does not contact the supplier.',
    record:'purchase_order',fields:['recordReference','reference'],permission:permissions.APPROVE_PO,
    capability:'purchasing.core',states:['APPROVED'],verb:'Record placement of',
    execute:(client,ctx,p)=>workflows.placePurchaseOrder(sameClient(client),ctx,p.recordId,
      {idempotencyKey:p.idempotencyKey,externalReference:p.reference}),
    verify:(client,ctx,_r,p)=>state(client,ctx,'purchase_orders',p.recordId,['ORDERED'])},
  {name:'purchase_order.cancel',description:'Cancel an unreceived purchase order. Stock already physically received remains in inventory and purchase history is retained.',
    record:'purchase_order',fields:['recordReference','reason'],permission:permissions.APPROVE_PO,
    capability:'purchasing.core',states:['DRAFT','AWAITING_APPROVAL','APPROVED','ORDERED','PARTIALLY_RECEIVED'],
    verb:'Cancel',execute:(client,ctx,p)=>workflows.cancelPurchaseOrderInTransaction(client,ctx,p.recordId,p),
    verify:(client,ctx,_r,p)=>state(client,ctx,'purchase_orders',p.recordId,['CANCELLED'])},
  {name:'transfer.pick',description:'Mark approved transfer stock physically picked at its source; it has not left the building yet.',
    record:'transfer',fields:['recordReference'],permission:permissions.PICK_TRANSFER,
    capability:'inventory.transfers',states:['APPROVED'],verb:'Pick',
    execute:(client,ctx,p)=>transfers.pickInTransaction(client,ctx,p.recordId,p),
    verify:(client,ctx,_r,p)=>state(client,ctx,'inventory_transfers',p.recordId,['PICKED'])},
  {name:'transfer.approve',description:'Approve an existing requested inventory transfer, reserving only stock that is genuinely available.',
    record:'transfer',fields:['recordReference'],permission:permissions.APPROVE_TRANSFER,
    capability:'inventory.transfers',states:['REQUESTED'],verb:'Approve',
    execute:(client,ctx,p)=>transfers.approveInTransaction(client,ctx,p.recordId,p),
    verify:(client,ctx,_r,p)=>state(client,ctx,'inventory_transfers',p.recordId,['APPROVED'])},
  {name:'transfer.dispatch',description:'Record that picked transfer stock physically left its source; atomically move it into transit and post its cost.',
    record:'transfer',fields:['recordReference'],permission:permissions.DISPATCH_TRANSFER,
    capability:'inventory.transfers',states:['PICKED'],verb:'Dispatch',
    execute:(client,ctx,p)=>transfers.dispatchInTransaction(client,ctx,p.recordId,p),
    verify:(client,ctx,_r,p)=>state(client,ctx,'inventory_transfers',p.recordId,['SHIPPED'])},
  {name:'transfer.depart',description:'Confirm an approved transfer physically left its source. Use the canonical pick, dispatch, and in-transit transitions together, as the transfer page does. Do not mark goods received at destination.',
    record:'transfer',fields:['recordReference'],permission:permissions.DISPATCH_TRANSFER,
    capability:'inventory.transfers',states:['APPROVED','PICKED','SHIPPED'],verb:'Confirm departure of',
    satisfiesCapabilities:['transfer.pick','transfer.dispatch','transfer.in_transit'],
    execute:async(client,ctx,p)=>{
      let transfer=await transfers.get(client,ctx.workspaceId,p.recordId,{lock:true});
      if(transfer.status==='APPROVED')transfer=await transfers.pickInTransaction(client,ctx,p.recordId,
        {idempotencyKey:`${p.idempotencyKey}:pick`});
      if(transfer.status==='PICKED')transfer=await transfers.dispatchInTransaction(client,ctx,p.recordId,
        {idempotencyKey:`${p.idempotencyKey}:dispatch`});
      if(transfer.status==='SHIPPED')transfer=await transfers.markInTransitInTransaction(client,ctx,p.recordId,
        {idempotencyKey:`${p.idempotencyKey}:in-transit`});
      return transfer;
    },
    verify:(client,ctx,_r,p)=>state(client,ctx,'inventory_transfers',p.recordId,['IN_TRANSIT'])},
  {name:'transfer.cancel',description:'Cancel a transfer only while the canonical transfer engine permits cancellation; never silently undo physically dispatched stock.',
    record:'transfer',fields:['recordReference','reason'],permission:permissions.APPROVE_TRANSFER,
    capability:'inventory.transfers',verb:'Cancel',
    execute:(client,ctx,p)=>transfers.cancelInTransaction(client,ctx,p.recordId,p),
    verify:(client,ctx,_r,p)=>state(client,ctx,'inventory_transfers',p.recordId,['CANCELLED'])},
  {name:'transfer.in_transit',description:'Mark a dispatched transfer as in transit. This records custody status, not arrival.',
    record:'transfer',fields:['recordReference'],permission:permissions.DISPATCH_TRANSFER,
    capability:'inventory.transfers',states:['SHIPPED'],verb:'Mark in transit',
    execute:(client,ctx,p)=>transfers.markInTransitInTransaction(client,ctx,p.recordId,p),
    verify:(client,ctx,_r,p)=>state(client,ctx,'inventory_transfers',p.recordId,['IN_TRANSIT'])},
  {name:'transfer.receive',description:'Record all outstanding dispatched transfer units physically received in good condition at the destination. Loss, damage, and serialized identities require the transfer review screen.',
    record:'transfer',fields:['recordReference'],permission:permissions.RECEIVE_TRANSFER,
    capability:'inventory.transfers',build:transferReceipt,
    execute:(client,ctx,p)=>transfers.receiveInTransaction(client,ctx,p.recordId,p),
    verify:(client,ctx,_r,p)=>state(client,ctx,'inventory_transfers',p.recordId,['RECEIVED'])},
  {name:'customer_payment.link',description:'Prepare a Stripe payment link for the exact open customer invoice balance on an existing order. This queues creation; it does not collect money or email the customer.',
    record:'sales_order',fields:['recordReference','paymentPurpose'],permission:permissions.RECORD_PAYMENTS,
    capability:'payments.customer',build:paymentLink,
    execute:async(client,ctx,p)=>{const current=(await client.query(`SELECT balance_minor FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,p.invoiceId])).rows[0];
      if(!current||Number(current.balance_minor)!==p.expectedAmountMinor)throw new ValidationError(
        'The invoice balance changed after review. Ask again to approve the new exact amount.');
      return payments.queueRequest(sameClient(client),ctx,p.salesOrderId,{invoiceId:p.invoiceId,
        purpose:p.purpose,provider:p.provider,idempotencyKey:p.idempotencyKey});},
    verify:async(client,ctx,r,p)=>Boolean(r.request?.id&&r.effectId&&r.request.invoiceId===p.invoiceId&&
      Number(r.request.amountMinor)===p.expectedAmountMinor&&
      (await client.query(`SELECT 1 FROM stockchief_runtime.provider_effects WHERE workspace_id=$1
        AND id=$2 AND kind='payment.request.create'`,[ctx.workspaceId,r.effectId])).rows.length)},
  {name:'customer_payment.record',description:'Record a customer payment that was already actually received against an existing order invoice. This posts cash and invoice allocation; it never initiates a payment.',
    record:'sales_order',fields:['recordReference','amount','paymentPurpose','paymentMethod','paymentDate','reference'],
    permission:permissions.RECORD_PAYMENTS,capability:'payments.customer',build:recordCustomerPayment,
    execute:async(client,ctx,p)=>{const row=(await client.query(`SELECT balance_minor FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,p.customerInvoiceId])).rows[0];
      if(!row||Number(row.balance_minor)!==p.expectedBalanceMinor)throw new ValidationError(
        'The invoice balance changed after review. Ask again before recording payment.');
      return workflows.recordCustomerPayment(sameClient(client),ctx,p);},
    verify:async(client,ctx,r,p)=>Boolean(r.paymentId&&r.amountMinor===p.amountMinor&&
      (await client.query(`SELECT 1 FROM accounting_payment_allocations WHERE workspace_id=$1
        AND payment_id=$2 AND customer_invoice_id=$3 AND amount_minor=$4`,
      [ctx.workspaceId,r.paymentId,p.customerInvoiceId,p.amountMinor])).rows.length)},
  {name:'customer_invoice.payment',description:'Record a payment already received against one exact open customer invoice, including an invoice not linked to a sales order. Never initiate a charge.',
    record:'customer_invoice',fields:['recordReference','amount','paymentMethod','paymentDate','reference'],
    permission:permissions.RECORD_PAYMENTS,capability:'payments.customer',build:invoicePayment,
    execute:async(client,ctx,p)=>{const row=(await client.query(`SELECT balance_minor FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,p.customerInvoiceId])).rows[0];
      if(!row||Number(row.balance_minor)!==p.expectedBalanceMinor)throw new ValidationError(
        'The invoice balance changed after review. Ask again before recording payment.');
      return workflows.recordCustomerPayment(sameClient(client),ctx,p);},
    verify:async(client,ctx,r,p)=>Boolean(r.paymentId&&r.amountMinor===p.amountMinor&&
      (await client.query(`SELECT 1 FROM accounting_payment_allocations WHERE workspace_id=$1
        AND payment_id=$2 AND customer_invoice_id=$3 AND amount_minor=$4`,
      [ctx.workspaceId,r.paymentId,p.customerInvoiceId,p.amountMinor])).rows.length)},
  {name:'supplier_bill.create',description:'Record a one-line supplier expense bill from an existing supplier with exact invoice number, quantity, unit cost and tax. This creates a payable, not a stock receipt or bank payment.',
    record:'supplier',fields:['recordReference','supplierInvoiceNumber','description','quantity','unitAmount',
      'tax','issueDate','dueDate'],permission:permissions.MANAGE_ACCOUNTING,
    capability:'accounting.core',build:supplierBill,
    execute:async(client,ctx,p)=>{const prior=(await client.query(`SELECT id FROM accounting_supplier_bills
      WHERE workspace_id=$1 AND supplier_id=$2 AND supplier_invoice_number=$3 AND status<>'VOID'`,
      [ctx.workspaceId,p.supplierId,p.supplierInvoiceNumber])).rows[0];
      if(prior)throw new ValidationError('This supplier invoice was recorded after review. Ask about that bill.');
      return workflows.recordSupplierInvoice(sameClient(client),ctx,p);},
    verify:async(client,ctx,r,p)=>Boolean(r.billId&&r.status==='OPEN'&&
      (await client.query(`SELECT 1 FROM accounting_supplier_bills WHERE workspace_id=$1 AND id=$2
        AND supplier_id=$3 AND supplier_invoice_number=$4 AND total_minor=$5`,
      [ctx.workspaceId,r.billId,p.supplierId,p.supplierInvoiceNumber,r.totalMinor])).rows.length)},
  {name:'purchase_order.record_supplier_invoice',description:'Record a one-line supplier invoice against an existing placed purchase order using its exact SKU, invoiced quantity, per-stock-unit cost, invoice number and tax. The canonical three-way match posts a payable only when received quantity and approved cost agree; exceptions are retained as disputed without a journal. Never receive stock or pay the supplier from this action.',
    record:'purchase_order',fields:['recordReference','supplierInvoiceNumber','sku','quantity','unitAmount',
      'tax','issueDate','dueDate'],permission:permissions.MANAGE_ACCOUNTING,
    capability:'accounting.core',build:purchaseOrderSupplierInvoice,
    execute:async(client,ctx,p)=>{
      const current=(await client.query(`SELECT pol.quantity_received_units,pol.unit_cost,
        COALESCE((SELECT SUM(bl.quantity) FROM accounting_supplier_bill_lines bl
          JOIN accounting_supplier_bills b ON b.id=bl.bill_id AND b.workspace_id=bl.workspace_id
          WHERE bl.workspace_id=pol.workspace_id AND bl.purchase_order_line_id=pol.id
            AND b.status IN ('OPEN','PARTIALLY_PAID','PAID')),0) AS billed_units
        FROM purchase_order_lines pol WHERE pol.workspace_id=$1 AND pol.id=$2 AND pol.purchase_order_id=$3
        FOR UPDATE`,[ctx.workspaceId,p.purchaseOrderLineId,p.purchaseOrderId])).rows[0];
      if(!current||Number(current.quantity_received_units)!==p.expectedReceivedUnits
        ||Number(current.billed_units)!==p.expectedBilledUnits
        ||Math.round(Number(current.unit_cost)*100)!==p.expectedApprovedCostMinor)
        throw new ValidationError('The purchase order or received quantity changed after review. Ask again.');
      const duplicate=(await client.query(`SELECT id FROM accounting_supplier_bills
        WHERE workspace_id=$1 AND supplier_id=$2 AND supplier_invoice_number=$3 AND status<>'VOID'`,
      [ctx.workspaceId,p.supplierId,p.supplierInvoiceNumber])).rows[0];
      if(duplicate)throw new ValidationError('This supplier invoice was recorded after review. Ask about that bill.');
      return workflows.recordSupplierInvoice(sameClient(client),ctx,p);},
    verify:async(client,ctx,r,p)=>Boolean(r.billId&&r.status===p.expectedStatus
      &&r.totalMinor===p.expectedTotalMinor
      &&(r.status==='DISPUTED'?!r.journalEntryId:Boolean(r.journalEntryId))
      &&(await client.query(`SELECT 1 FROM accounting_supplier_bills WHERE workspace_id=$1
        AND id=$2 AND purchase_order_id=$3 AND supplier_invoice_number=$4 AND total_minor=$5
        AND status=$6`,[ctx.workspaceId,r.billId,p.purchaseOrderId,p.supplierInvoiceNumber,
        p.expectedTotalMinor,p.expectedStatus])).rows.length)},
  {name:'shipping.label',description:'Buy a carrier label at one exact recent quoted rate for an existing prepared shipment. Explicit owner approval is required; a queued purchase is not a confirmed label.',
    record:'shipment',fields:['recordReference','rate'],permission:permissions.ADMIN,
    capability:'shipping.labels',build:label,
    execute:async(client,ctx,p)=>{const rate=(await client.query(`SELECT amount_minor,currency,quoted_at FROM shipment_rates
      WHERE workspace_id=$1 AND shipment_id=$2 AND id=$3 FOR UPDATE`,[ctx.workspaceId,p.shipmentId,p.rateId])).rows[0];
      if(!rate||Number(rate.amount_minor)!==p.amountMinor||rate.currency!==p.currency||
        Date.now()-new Date(rate.quoted_at).getTime()>30*60_000)throw new ValidationError(
        'The carrier rate changed or expired after review. Refresh rates and approve again.');
      return shipping.queueLabelPurchase(sameClient(client),ctx,p.shipmentId,p.rateId,
        {idempotencyKey:p.idempotencyKey});},
    verify:async(client,ctx,r,p)=>Boolean(r.transactionId&&r.effectId&&
      (await client.query(`SELECT 1 FROM shipping_label_transactions WHERE workspace_id=$1 AND id=$2
        AND shipment_id=$3 AND status='PENDING'`,[ctx.workspaceId,r.transactionId,p.shipmentId])).rows.length)},
  {name:'shipping.handoff',description:'Record actual physical handoff of a packed shipment, fulfill its allocated order lines, and post stock and accounting together. Carrier handoff requires a purchased label or exact tracking number.',
    record:'shipment',fields:['recordReference','handover','trackingNumber'],permission:permissions.FULFILL_SALES,
    capability:'shipping.workflow',build:shippingHandoff,
    execute:(client,ctx,p)=>shipping.handoff(sameClient(client),ctx,p.recordId,p),
    verify:async(client,ctx,r,p)=>Boolean(r.fulfillment?.invoiceId&&
      await state(client,ctx,'sales_shipments',p.recordId,['SHIPPED']))},
  {name:'shipping.delivered',description:'Record a manual confirmation that an already-shipped parcel was physically delivered. Does not buy postage or move stock again.',
    record:'shipment',fields:['recordReference'],permission:permissions.FULFILL_SALES,
    capability:'shipping.workflow',states:['SHIPPED'],verb:'Confirm delivery of',
    execute:(client,ctx,p)=>shipping.applyTracking(sameClient(client),ctx,p.recordId,{provider:'manual',status:'DELIVERED',
        externalEventId:`ask-delivered:${p.idempotencyKey}`,detail:'Owner confirmed delivery through Ask StockChief.',
        occurredAt:nowIso()}),
    verify:async(client,ctx,r,p)=>Boolean(r.applied&&await state(client,ctx,'sales_shipments',p.recordId,['DELIVERED']))},
  {name:'shipping.cancel',description:'Cancel a shipment only before goods leave. Its order allocation remains intact; no customer order is cancelled.',
    record:'shipment',fields:['recordReference','reason'],permission:permissions.FULFILL_SALES,
    capability:'shipping.workflow',states:['PICKING','PACKED'],verb:'Cancel',
    execute:async(client,ctx,p)=>{const changed=await client.query(`UPDATE sales_shipments
      SET status='CANCELLED',notes=COALESCE($3,notes),updated_at=$4
      WHERE workspace_id=$1 AND id=$2 AND status IN ('PICKING','PACKED') RETURNING id`,
      [ctx.workspaceId,p.recordId,p.reason||null,nowIso()]);
      if(!changed.rowCount)throw new ValidationError('This shipment has already left or was cancelled.');
      return {status:'CANCELLED'};},
    verify:(client,ctx,_r,p)=>state(client,ctx,'sales_shipments',p.recordId,['CANCELLED'])},
  {name:'customer_return.request',description:'Request a return for one exact fulfilled product and quantity, recording the proposed resolution and quarantine location. This does not receive goods or issue a refund.',
    record:'sales_order',fields:['recordReference','sku','quantity','reason','location','returnResolution'],
    permission:permissions.AUTHORIZE_CUSTOMER_RETURN,capability:'returns.core',build:returnRequest,
    execute:(client,ctx,p)=>returns.requestCustomerReturn(sameClient(client),ctx,p),
    verify:async(client,ctx,r)=>Boolean(r.customerReturnId&&
      await state(client,ctx,'customer_returns',r.customerReturnId,['REQUESTED']))},
  {name:'customer_return.authorize',description:'Authorize an existing customer return request. Authorization alone does not receive physical goods or refund money.',
    record:'customer_return',fields:['recordReference'],permission:permissions.AUTHORIZE_CUSTOMER_RETURN,
    capability:'returns.core',states:['REQUESTED'],verb:'Authorize',
    execute:(client,ctx,p)=>returns.authorizeCustomerReturn(sameClient(client),ctx,p.recordId,p),
    verify:(client,ctx,_r,p)=>state(client,ctx,'customer_returns',p.recordId,['AUTHORIZED'])},
  {name:'customer_return.receive',description:'Record all authorized quantity-tracked return units actually received into quarantine, restoring original inventory-cost evidence. Lot and serial units require exact scans.',
    record:'customer_return',fields:['recordReference'],permission:permissions.INSPECT_CUSTOMER_RETURN,
    capability:'returns.core',build:returnReceive,
    execute:(client,ctx,p)=>returns.receiveCustomerReturn(sameClient(client),ctx,p.recordId,p),
    verify:(client,ctx,_r,p)=>state(client,ctx,'customer_returns',p.recordId,['RECEIVED'])},
  {name:'customer_return.inspect',description:'Record physical inspection and disposition of all received returned units as restock, scrap, or repair. A refund remains a separate decision.',
    record:'customer_return',fields:['recordReference','disposition','location','reason'],permission:permissions.INSPECT_CUSTOMER_RETURN,
    capability:'returns.core',build:returnInspect,
    execute:(client,ctx,p)=>returns.inspectCustomerReturn(sameClient(client),ctx,p.recordId,p),
    verify:(client,ctx,r,p)=>state(client,ctx,'customer_returns',p.recordId,[r.status])},
  {name:'customer_return.refund',description:'After return inspection, either reduce the unpaid invoice or refund already-paid money. A provider-paid refund is queued to the original provider and accounting waits for confirmation.',
    record:'customer_return',fields:['recordReference','refundDestination'],permission:permissions.REFUND_CUSTOMER_RETURN,
    capability:'returns.core',build:returnRefund,
    execute:async(client,ctx,p)=>{
      if(p.destination==='AR')return returns.refundCustomerReturn(sameClient(client),ctx,p.recordId,
        {destination:'AR',idempotencyKey:p.idempotencyKey});
      const queued=await payments.queueCustomerReturnRefund(sameClient(client),ctx,p.recordId,{provider:'stripe'});
      if(queued.noProviderPayment)return returns.refundCustomerReturn(sameClient(client),ctx,p.recordId,
        {destination:'CASH',idempotencyKey:p.idempotencyKey});
      return queued;
    },
    verify:async(client,ctx,r,p)=>r.queued?
      Boolean(r.refund?.id&&r.effectId&&(await client.query(`SELECT 1 FROM payment_refund_requests
        WHERE workspace_id=$1 AND id=$2 AND customer_return_id=$3 AND amount_minor=$4 AND status='PENDING'`,
      [ctx.workspaceId,r.refund.id,p.recordId,p.amountMinor])).rows.length):
      Boolean(r.amountMinor===p.amountMinor&&await state(client,ctx,'customer_returns',p.recordId,['COMPLETED']))},
  {name:'customer_return.exchange',description:'After inspecting an authorized exchange return, prepare a zero-price replacement sales order for the returned SKU quantities. It still needs confirmation and physical fulfillment.',
    record:'customer_return',fields:['recordReference'],permission:permissions.REFUND_CUSTOMER_RETURN,
    capability:'returns.core',build:returnExchange,
    execute:(client,ctx,p)=>returns.exchangeCustomerReturn(sameClient(client),ctx,p.recordId,p),
    verify:async(client,ctx,r,p)=>Boolean(r.exchangeOrderId&&await state(client,ctx,'customer_returns',p.recordId,['COMPLETED'])&&
      await state(client,ctx,'sales_orders',r.exchangeOrderId,['DRAFT']))},
  {name:'autopilot.pause',description:'Pause autonomous work for this inventory immediately after approval. Existing business records stay available and old jobs are not replayed.',
    record:null,fields:['reason'],permission:permissions.OPERATE,
    build:(_database,_ctx,_row,args)=>prepareResult({reason:args.reason||null},
      `Pause automatic work${args.reason?` because ${args.reason}`:''}. No business data is deleted.`),
    execute:async(client,ctx,p)=>autonomy.pause(sameClient(client),ctx,await actor(client,ctx),p.reason),
    verify:async(client,ctx,r)=>Boolean(r.paused&&
      (await client.query('SELECT paused FROM workspace_autopilot WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.paused)},
  {name:'autopilot.resume',description:'Resume autonomous monitoring under the existing approved policies; do not replay old work.',
    record:null,fields:[],permission:permissions.OPERATE,
    build:()=>prepareResult({},'Resume automatic monitoring under the existing approved policies. Old work will not replay.'),
    execute:async(client,ctx)=>autonomy.resume(sameClient(client),ctx,await actor(client,ctx)),
    verify:async(client,ctx,r)=>Boolean(!r.paused&&
      Number((await client.query('SELECT paused FROM workspace_autopilot WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.paused)===0)},
  {name:'autopilot.mode',description:'Change autonomous-work authority among OBSERVE, SUPERVISED, or POLICY_AUTOMATED. Bounded automatic mode requires existing plan entitlement and approved policies; it grants no new policy by itself.',
    record:null,fields:['mode'],permission:permissions.ADMIN,build:autonomyMode,
    execute:async(client,ctx,p)=>autonomy.setMode(sameClient(client),ctx,await actor(client,ctx),p.mode),
    verify:async(client,ctx,r,p)=>Boolean(r.mode===p.mode&&
      (await client.query('SELECT mode FROM workspace_autopilot WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.mode===p.mode)},
  {name:'connection.pause',description:'Pause one existing connected provider so StockChief stops new processing from it; keep credentials and history for later resumption.',
    record:'connection',fields:['recordReference'],permission:permissions.ADMIN,ownerOnly:true,
    states:['connected'],verb:'Pause',
    execute:(client,ctx,p)=>connections.pause(sameClient(client),ctx.workspaceId,p.recordId),
    verify:async(client,ctx,r,p)=>Boolean(r.id===p.recordId&&
      (await client.query('SELECT paused_at FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,p.recordId])).rows[0]?.paused_at)},
  {name:'connection.resume',description:'Resume one paused existing connection only if its credentials remain present; a disconnected account still needs the provider authorization flow.',
    record:'connection',fields:['recordReference'],permission:permissions.ADMIN,ownerOnly:true,
    build:(_db,_ctx,row)=>{if(!row.paused_at||row.status==='disconnected')throw new ValidationError(
      'This connection is not paused with reusable credentials. Reconnect it from Connections if needed.');
      return prepareResult({recordId:row.id},`Resume ${row.display_name} processing using the existing stored credentials.`);},
    execute:(client,ctx,p)=>connections.resume(sameClient(client),ctx.workspaceId,p.recordId),
    verify:async(client,ctx,r,p)=>Boolean(r.id===p.recordId&&r.status==='connected'&&
      !(await client.query('SELECT paused_at FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,p.recordId])).rows[0]?.paused_at)},
  {name:'connection.disconnect',description:'Disconnect one provider, revoke feed tokens and remove its encrypted credentials while retaining audit and business history. Reconnection later needs OAuth or fresh credentials.',
    record:'connection',fields:['recordReference'],permission:permissions.ADMIN,ownerOnly:true,
    build:(_db,_ctx,row)=>{if(row.status==='disconnected')throw new ValidationError('This provider is already disconnected.');
      return prepareResult({recordId:row.id},`Disconnect ${row.display_name}, revoke its feed tokens and remove stored credentials. Historical business records remain; reconnecting requires provider authorization again.`);},
    execute:(client,ctx,p)=>connections.disconnect(sameClient(client),ctx.workspaceId,p.recordId),
    verify:async(client,ctx,r,p)=>Boolean(r.id===p.recordId&&r.status==='disconnected'&&
      (await client.query(`SELECT 1 FROM workspace_connectors WHERE workspace_id=$1 AND id=$2
        AND credential_ref IS NULL AND status='disconnected'`,[ctx.workspaceId,p.recordId])).rows.length)},
  {name:'workspace.rename',description:'Rename this inventory workspace without changing its records, connected accounts or commercial owner.',
    record:null,fields:['workspaceName'],permission:permissions.ADMIN,ownerOnly:true,
    capability:'workspace.core',build:workspaceRename,
    execute:async(client,ctx,p)=>{const changed=await client.query(`UPDATE workspaces SET name=$3
      WHERE id=$1 AND name=$2 AND owner_account_id=(SELECT account_id FROM users
        WHERE workspace_id=$1 AND id=$4 AND role='owner') RETURNING name`,
      [ctx.workspaceId,p.expectedName,p.name,ctx.actorId]);
      if(!changed.rows.length)throw new ValidationError('The inventory name or owner changed after review. Ask again.');
      return changed.rows[0];},
    verify:async(client,ctx,r,p)=>Boolean(r.name===p.name&&
      (await client.query('SELECT name FROM workspaces WHERE id=$1',[ctx.workspaceId])).rows[0]?.name===p.name)},
  {name:'team.invite',description:'Invite a named teammate by exact email address with an explicit owner, staff, or accountant role. Access starts only after acceptance; no password is shared.',
    record:null,fields:['inviteeName','inviteeEmail','memberRole'],permission:permissions.ADMIN,
    ownerOnly:true,capability:'workspace.core',build:teamInvitation,
    execute:async(client,ctx,p)=>accountLifecycle.createInvitation(sameClient(client),ctx,
      {name:p.name,email:p.email,role:p.role},{origin:config.connections.publicOrigin}),
    verify:async(client,ctx,r,p)=>Boolean(r.id&&r.email===p.email&&r.role===p.role&&
      (await client.query(`SELECT 1 FROM workspace_invitations WHERE workspace_id=$1 AND id=$2
        AND email=$3 AND role=$4 AND status='PENDING'`,[ctx.workspaceId,r.id,p.email,p.role])).rows.length)},
  {name:'import.approve',description:'Approve one exact, already-analyzed inventory import preview and its frozen integrity hash. Approval alone does not create products or stock.',
    record:'import_plan',fields:['recordReference'],permission:permissions.OPERATE,
    capability:'imports.spreadsheet',build:importApproval,
    execute:async(client,ctx,p)=>imports.approve(sameClient(client),ctx,p.recordId,p.integrityHash),
    verify:async(client,ctx,r,p)=>Boolean(r.approvalStatus==='APPROVED'&&
      (await client.query(`SELECT approval_status,integrity_hash FROM import_plans
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,p.recordId])).rows.some((row)=>
        row.approval_status==='APPROVED'&&row.integrity_hash===p.integrityHash))},
  {name:'import.run',description:'Queue the canonical import engine to apply one exact approved preview asynchronously, with durable idempotency and verified row/stock results.',
    record:'import_plan',fields:['recordReference'],permission:permissions.OPERATE,
    capability:'imports.spreadsheet',build:importRun,
    execute:async(client,ctx,p)=>{const current=(await client.query(`SELECT integrity_hash,status,approval_status
      FROM import_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [ctx.workspaceId,p.recordId])).rows[0];
      if(!current||current.integrity_hash!==p.integrityHash||current.status!=='READY'||
        current.approval_status!=='APPROVED')throw new ValidationError(
        'The approved import changed after review. Ask again.');
      return jobQueue.enqueue(sameClient(client),{workspaceId:ctx.workspaceId,
        kind:'import.execute-approved',idempotencyKey:`ask-import:${p.recordId}:${p.integrityHash}`,
        payload:{planId:p.recordId,actorId:ctx.actorId,integrityHash:p.integrityHash},priority:30,maxAttempts:3});},
    verify:async(client,ctx,r,p)=>Boolean(r.job?.id&&
      (await client.query(`SELECT 1 FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND id=$2
        AND kind='import.execute-approved' AND payload->>'planId'=$3`,
      [ctx.workspaceId,r.job.id,p.recordId])).rows.length)},
  {name:'import.cancel',description:'Cancel one exact import preview that has not run, retaining its review history and changing no product or stock records.',
    record:'import_plan',fields:['recordReference'],permission:permissions.OPERATE,
    capability:'imports.spreadsheet',build:importCancel,
    execute:async(client,ctx,p)=>{const current=(await client.query(`SELECT integrity_hash,status FROM import_plans
      WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,p.recordId])).rows[0];
      if(!current||current.integrity_hash!==p.integrityHash||current.status!=='READY')
        throw new ValidationError('The import preview changed after review. Ask again.');
      return imports.cancel(sameClient(client),ctx,p.recordId);},
    verify:async(client,ctx,_r,p)=>Boolean((await client.query(`SELECT 1 FROM import_plans
      WHERE workspace_id=$1 AND id=$2 AND status='CANCELLED' AND approval_status='CANCELLED'`,
      [ctx.workspaceId,p.recordId])).rows.length)},
  {name:'catalog.update_item',description:'Update the name, base code, description, unit label, or negative-stock preference of one exact existing product without replacing unmentioned details.',
    record:'item',fields:['recordReference','itemName','baseCode','itemDescription','unitLabel','allowNegative'],
    permission:permissions.OPERATE,capability:'inventory.core',build:productDetails,
    execute:async(client,ctx,p)=>{const row=(await client.query(`SELECT updated_at FROM items
      WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,p.recordId])).rows[0];
      if(!row||new Date(row.updated_at).toISOString()!==p.expectedUpdatedAt)throw new ValidationError(
        'Product details changed after review. Ask again before saving.');
      return catalog.updateItem(sameClient(client),ctx,p.recordId,p.value);},
    verify:async(client,ctx,r,p)=>Boolean(r.id===p.recordId&&
      (await client.query(`SELECT name,base_code,description,unit_label,allow_negative FROM items
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,p.recordId])).rows.some((row)=>
        row.name===p.value.name&&row.base_code===(p.value.baseCode||null)&&
        row.description===(p.value.description||null)&&row.unit_label===(p.value.unitLabel||'unit')&&
        Number(row.allow_negative)===(p.value.allowNegative?1:0)))},
  {name:'customer.update',description:'Update the name, company, email, phone, delivery address, or notes of one existing customer; do not alter historical order addresses.',
    record:'customer',fields:['recordReference','contactDisplayName','company','recipientEmail','phone','shipToAddress','notes'],
    permission:permissions.OPERATE,capability:'sales_orders.core',
    build:(_database,_ctx,row,args)=>contactDetails('customer',row,args),
    execute:async(client,ctx,p)=>{const changed=await client.query(`UPDATE customers SET name=$3,company=$4,
      email=$5,phone=$6,shipping_address=$7,notes=$8,updated_at=$9 WHERE workspace_id=$1 AND id=$2
      AND updated_at=$10 RETURNING id`,[ctx.workspaceId,p.recordId,p.value.name,p.value.company,p.value.email,
        p.value.phone,p.value.shippingAddress,p.value.notes,nowIso(),p.expectedUpdatedAt]);
      if(!changed.rows.length)throw new ValidationError('Customer details changed after review. Ask again.');
      return changed.rows[0];},
    verify:async(client,ctx,r,p)=>Boolean(r.id===p.recordId&&
      (await client.query(`SELECT name,company,email,phone,shipping_address,notes FROM customers
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,p.recordId])).rows.some((row)=>
        row.name===p.value.name&&row.company===p.value.company&&row.email===p.value.email&&
        row.phone===p.value.phone&&row.shipping_address===p.value.shippingAddress&&row.notes===p.value.notes))},
  {name:'supplier.update',description:'Update the name, contact person, email, phone, or notes of one existing supplier; preserve all purchasing and approval limits.',
    record:'supplier',fields:['recordReference','contactDisplayName','contactName','recipientEmail','phone','notes'],
    permission:permissions.MANAGE_SUPPLIERS,capability:'purchasing.core',
    build:(_database,_ctx,row,args)=>contactDetails('supplier',row,args),
    execute:async(client,ctx,p)=>{const changed=await client.query(`UPDATE suppliers SET name=$3,
      contact_name=$4,email=$5,phone=$6,notes=$7,updated_at=$8 WHERE workspace_id=$1 AND id=$2
      AND updated_at=$9 RETURNING id`,[ctx.workspaceId,p.recordId,p.value.name,p.value.contactName,
        p.value.email,p.value.phone,p.value.notes,nowIso(),p.expectedUpdatedAt]);
      if(!changed.rows.length)throw new ValidationError('Supplier details changed after review. Ask again.');
      return changed.rows[0];},
    verify:async(client,ctx,r,p)=>Boolean(r.id===p.recordId&&
      (await client.query(`SELECT name,contact_name,email,phone,notes FROM suppliers
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,p.recordId])).rows.some((row)=>
        row.name===p.value.name&&row.contact_name===p.value.contactName&&row.email===p.value.email&&
        row.phone===p.value.phone&&row.notes===p.value.notes))},
  {name:'supplier.link_product',description:'Link one exact active SKU to one existing supplier, optionally recording the supplier code, unit cost, lead time, pack terms and preferred status. This records purchasing terms but does not create or send an order.',
    record:'supplier',fields:['recordReference','sku','supplierSku','purchaseUnit','unitsPerPurchaseUnit',
      'amount','leadTimeDays','minimumOrderQuantity','orderMultiple','isPreferred'],
    permission:permissions.MANAGE_SUPPLIERS,capability:'purchasing.core',
    build:async(database,ctx,supplier,args)=>{
      if(!args.sku)throw new ValidationError('Which exact product or SKU should I link to this supplier?');
      const matches=(await database.query(`SELECT s.id,s.code,i.name FROM skus s
        JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
        WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1
          AND (lower(s.id)=lower($2) OR lower(s.code)=lower($2) OR lower(i.name)=lower($2))
        ORDER BY s.code LIMIT 2`,[ctx.workspaceId,args.sku])).rows;
      if(matches.length!==1)throw new ValidationError(matches.length?
        'More than one SKU matches. Give the exact SKU code.':'That SKU was not found in this inventory.');
      const sku=matches[0];const previous=(await database.query(`SELECT updated_at FROM supplier_items
        WHERE workspace_id=$1 AND supplier_id=$2 AND sku_id=$3`,
      [ctx.workspaceId,supplier.id,sku.id])).rows[0];
      const input={supplierId:supplier.id,skuId:sku.id,
        ...(previous?{expectedUpdatedAt:new Date(previous.updated_at).toISOString()}:{expectAbsent:true}),
        ...Object.fromEntries([['supplierSku','supplierSku'],['purchaseUnit','purchaseUnit'],
          ['unitsPerPurchaseUnit','unitsPerPurchaseUnit'],['amount','lastUnitCost'],
          ['leadTimeDays','leadTimeDays'],['minimumOrderQuantity','minimumOrderQuantity'],
          ['orderMultiple','orderMultiple'],['isPreferred','isPreferred']]
          .filter(([field])=>args[field]!=null).map(([field,target])=>[target,
            field==='isPreferred'?String(args[field]).toLowerCase():args[field]]))};
      const terms=[args.supplierSku?`supplier SKU ${args.supplierSku}`:null,
        args.amount!=null?`unit cost $${Number(args.amount).toFixed(2)}`:null,
        args.purchaseUnit?`purchase unit ${args.purchaseUnit}`:null,
        args.unitsPerPurchaseUnit!=null?`${args.unitsPerPurchaseUnit} stock units per purchase unit`:null,
        args.leadTimeDays!=null?`${args.leadTimeDays}-day lead time`:null,
        args.minimumOrderQuantity!=null?`minimum order ${args.minimumOrderQuantity} purchase units`:null,
        args.orderMultiple!=null?`order multiple ${args.orderMultiple} purchase units`:null,
        args.isPreferred!=null?`${String(args.isPreferred).toLowerCase()==='true'?'preferred':'not preferred'}`:null].filter(Boolean);
      return prepareResult(input,`Link ${sku.name} (${sku.code}) to ${supplier.name}`+
        `${terms.length?` with ${terms.join(', ')}`:''}. No purchase order is created.`);
    },
    execute:(client,ctx,p)=>commerce.linkSupplierItemInTransaction(client,ctx,p),
    verify:async(client,ctx,r,p)=>Boolean(r.supplier_id===p.supplierId&&r.sku_id===p.skuId&&
      Number(r.is_active)===1&&(await client.query(`SELECT 1 FROM supplier_items
        WHERE workspace_id=$1 AND id=$2 AND supplier_id=$3 AND sku_id=$4 AND is_active=1`,
      [ctx.workspaceId,r.id,p.supplierId,p.skuId])).rows.length)},
  {name:'mail.state',description:'Mark one exact received business message as needing reply, waiting, or handled. This is a triage decision; it neither sends email nor deletes evidence.',
    record:'mail_message',fields:['recordReference','mailboxState','reason'],
    permission:permissions.OPERATE,build:mailboxState,
    execute:async(client,ctx,p)=>{const current=(await client.query(`SELECT reply_state FROM connection_email_messages
      WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,p.recordId])).rows[0];
      if(!current||current.reply_state!==p.expectedState)throw new ValidationError(
        'This message changed after review. Ask again before triaging it.');
      return mail.setState(sameClient(client),ctx,p.recordId,p.target,p.reason);},
    verify:async(client,ctx,r,p)=>Boolean(r.reply_state===p.target&&
      (await client.query(`SELECT reply_state FROM connection_email_messages
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,p.recordId])).rows[0]?.reply_state===p.target)},
  {name:'mail.send_saved_reply',description:'Queue the exact saved, reviewed reply to one connected business message. Provider delivery is asynchronous and never claimed before confirmation.',
    record:'mail_message',fields:['recordReference'],permission:permissions.OPERATE,
    capability:'connection.email',additionalCapabilities:['communications.send_approved'],build:sendSavedReply,
    execute:async(client,ctx,p)=>{await entitlements.assertCapability(client,
      await entitlements.ownerScopeForWorkspace(client,ctx.workspaceId),'communications.send_approved');
      const current=(await client.query(`SELECT draft_subject,draft_body,reply_sent_at
      FROM connection_email_messages WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
    [ctx.workspaceId,p.recordId])).rows[0];
      if(!current||current.reply_sent_at||current.draft_subject!==p.subject||current.draft_body!==p.body)
        throw new ValidationError('The saved reply changed after review. Ask again before sending.');
      return mail.queueSend(sameClient(client),ctx,p.recordId,{subject:p.subject,body:p.body});},
    verify:async(client,ctx,r,p)=>Boolean((r.queued||r.sent)&&
      (await client.query(`SELECT 1 FROM stockchief_runtime.email_reply_outbox
        WHERE workspace_id=$1 AND message_id=$2 AND subject=$3 AND body=$4
        AND status IN ('PENDING','SENDING','SENT')`,[ctx.workspaceId,p.recordId,p.subject,p.body])).rows.length)},
  {name:'settings.email_alerts',description:'Enable or disable operational email alerts and set the severity threshold and recipient email addresses for this inventory.',
    record:null,fields:['enabled','minimumSeverity','recipientEmails'],permission:permissions.ADMIN,ownerOnly:true,
    capability:'operations.alerts',build:emailAlerts,
    execute:async(client,ctx,p)=>{const current=(await client.query(`SELECT updated_at FROM notification_email_settings
      WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
      if((current?.updated_at?new Date(current.updated_at).toISOString():null)!==(p.expectedUpdatedAt||null))throw new ValidationError(
        'Email alert settings changed after review. Ask again before saving.');
      const at=nowIso();await client.query(`INSERT INTO notification_email_settings
        (workspace_id,enabled,minimum_severity,recipients,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(workspace_id) DO UPDATE SET
          enabled=EXCLUDED.enabled,minimum_severity=EXCLUDED.minimum_severity,
          recipients=EXCLUDED.recipients,updated_at=EXCLUDED.updated_at`,
      [ctx.workspaceId,p.enabled?1:0,p.minimumSeverity,JSON.stringify(p.recipients),at]);
      return {enabled:p.enabled,minimumSeverity:p.minimumSeverity,recipients:p.recipients};},
    verify:async(client,ctx,r,p)=>Boolean(r.enabled===p.enabled&&
      (await client.query(`SELECT enabled,minimum_severity,recipients FROM notification_email_settings
        WHERE workspace_id=$1`,[ctx.workspaceId])).rows.some((row)=>Number(row.enabled)===(p.enabled?1:0)&&
          row.minimum_severity===p.minimumSeverity&&JSON.stringify(typeof row.recipients==='string'?
            JSON.parse(row.recipients):row.recipients)===JSON.stringify(p.recipients)))},
  {name:'shipping.operation_mode',description:'Set shipping handling to manual, recommend rates for approval, or bounded automatic handling under separately approved rules and authority.',
    record:null,fields:['mode'],permission:permissions.ADMIN,capability:'shipping.rates',build:shippingMode,
    execute:async(client,ctx,p)=>{const current=(await client.query(`SELECT mode FROM shipping_operation_policy
      WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0]?.mode||'RECOMMEND';
      if(current!==p.previous)throw new ValidationError('Shipping handling changed after review. Ask again.');
      const at=nowIso();await client.query(`INSERT INTO shipping_operation_policy
        (workspace_id,mode,updated_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,$4)
        ON CONFLICT(workspace_id) DO UPDATE SET mode=EXCLUDED.mode,
        updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=EXCLUDED.updated_at`,
      [ctx.workspaceId,p.mode,ctx.actorId,at]);return {mode:p.mode};},
    verify:async(client,ctx,r,p)=>Boolean(r.mode===p.mode&&
      (await client.query('SELECT mode FROM shipping_operation_policy WHERE workspace_id=$1',
      [ctx.workspaceId])).rows[0]?.mode===p.mode)},
  {name:'shipping.rule.create',description:'Create a conditional shipping rule with a specified carrier, service, postage ceiling, delivery-time ceiling, or promised-date requirement. Does not purchase postage or grant automatic authority.',
    record:null,fields:['carrier','service','maxCost','maxDeliveryDays','requireByPromised','statedText'],
    permission:permissions.OPERATE,build:shippingRule,
    execute:async(client,ctx,p)=>{const at=nowIso();const inserted=await client.query(`INSERT INTO shipping_rules
      (id,workspace_id,name,carrier,service,max_cost_minor,require_by_promised,max_delivery_days,
       is_active,stated_text,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$11) RETURNING id`,
      [p.ruleId,ctx.workspaceId,p.name,p.carrier,p.service,p.maxCostMinor,p.requireByPromised?1:0,
        p.maxDeliveryDays,p.statedText,ctx.actorId,at]);return inserted.rows[0];},
    verify:async(client,ctx,r,p)=>Boolean(r.id===p.ruleId&&
      (await client.query(`SELECT 1 FROM shipping_rules WHERE workspace_id=$1 AND id=$2
        AND name=$3 AND is_active=1`,[ctx.workspaceId,p.ruleId,p.name])).rows.length)},
  {name:'shipping.rule.disable',description:'Turn off one exact existing shipping rule. Future carrier decisions will not use it; existing shipments and purchased labels remain unchanged.',
    record:'shipping_rule',fields:['recordReference'],permission:permissions.OPERATE,
    build:(_database,_ctx,row)=>{if(!Number(row.is_active))throw new ValidationError('That shipping rule is already off.');
      return prepareResult({recordId:row.id,expectedName:row.name},`Turn off shipping rule ${row.name}. Existing shipments stay unchanged.`);},
    execute:async(client,ctx,p)=>{const changed=await client.query(`UPDATE shipping_rules SET is_active=0,
      updated_at=$4 WHERE workspace_id=$1 AND id=$2 AND name=$3 AND is_active=1 RETURNING id`,
      [ctx.workspaceId,p.recordId,p.expectedName,nowIso()]);
      if(!changed.rows.length)throw new ValidationError('This shipping rule changed after review. Ask again.');
      return changed.rows[0];},
    verify:async(client,ctx,r,p)=>Boolean(r.id===p.recordId&&
      Number((await client.query(`SELECT is_active FROM shipping_rules WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,p.recordId])).rows[0]?.is_active)===0)},
  {name:'supplier_return.request',description:'Request a supplier return for an exact SKU on an existing purchase order. Lot-tracked goods require the exact lot code; serial-tracked goods require every physical serial. This neither ships stock nor assumes a supplier credit.',
    record:'purchase_order',fields:['recordReference','sku','quantity','reason','amount','lotBarcode','serialNumbers'],
    permission:permissions.AUTHORIZE_SUPPLIER_RETURN,capability:'returns.core',build:supplierReturnRequest,
    execute:(client,ctx,p)=>returns.requestSupplierReturn(sameClient(client),ctx,p),
    verify:async(client,ctx,r,p)=>Boolean(r.supplierReturnId&&r.status==='REQUESTED'&&
      await state(client,ctx,'supplier_returns',r.supplierReturnId,['REQUESTED']))},
  {name:'supplier_return.authorize',description:'Authorize one requested supplier return; stock stays on hand until separately shipped.',
    record:'supplier_return',fields:['recordReference'],permission:permissions.AUTHORIZE_SUPPLIER_RETURN,
    capability:'returns.core',states:['REQUESTED'],verb:'Authorize',
    execute:(client,ctx,p)=>returns.authorizeSupplierReturn(sameClient(client),ctx,p.recordId,p),
    verify:async(client,ctx,r,p)=>Boolean(r.status==='AUTHORIZED'&&
      await state(client,ctx,'supplier_returns',p.recordId,['AUTHORIZED']))},
  {name:'supplier_return.ship',description:'Record the physical shipment of an authorized supplier return; the canonical engine moves stock and cost together. A supplier credit remains outstanding.',
    record:'supplier_return',fields:['recordReference'],permission:permissions.SHIP_SUPPLIER_RETURN,
    capability:'returns.core',states:['AUTHORIZED'],verb:'Ship',
    execute:(client,ctx,p)=>returns.shipSupplierReturn(sameClient(client),ctx,p.recordId,{...p,shippedAt:nowIso()}),
    verify:async(client,ctx,r,p)=>Boolean(r.status==='AWAITING_CREDIT'&&r.lines?.length&&
      await state(client,ctx,'supplier_returns',p.recordId,['AWAITING_CREDIT']))},
  {name:'supplier_return.reconcile',description:'Reconcile an actual supplier credit note against the return’s matched open bill, posting the payable and any price variance. Never invent a credit.',
    record:'supplier_return',fields:['recordReference','amount','creditNumber','creditDate'],
    permission:permissions.RECONCILE_SUPPLIER_RETURN,capability:'returns.core',build:supplierCredit,
    execute:(client,ctx,p)=>returns.reconcileSupplierReturn(sameClient(client),ctx,p.recordId,p),
    verify:async(client,ctx,r,p)=>Boolean(r.supplierCreditId&&r.amountMinor===p.amountMinor&&
      (await client.query(`SELECT 1 FROM accounting_supplier_credits WHERE workspace_id=$1 AND id=$2
        AND amount_minor=$3`,[ctx.workspaceId,r.supplierCreditId,p.amountMinor])).rows.length)},
  {name:'warehouse.wave.create',description:'Release one exact confirmed, allocated order as a warehouse picking wave. Strategy WAVE (one order, default), BATCH or CLUSTER. Stock remains on hand until actual shipping handoff.',
    record:'sales_order',fields:['recordReference','strategy'],permission:permissions.MANAGE_FULFILLMENT_WAVES,
    capability:'warehouse.advanced',build:(_database,_ctx,row,args)=>{
      requireState(row,['CONFIRMED','PARTIALLY_FULFILLED'],'This order');
      const requestedStrategy=String(args.strategy||'WAVE').toUpperCase();
      // Model phrasing for the single-order default is not the canonical
      // warehouse enum. Keep the warehouse engine's three actual strategies.
      const strategy=requestedStrategy==='PICK_BY_ORDER'?'WAVE':requestedStrategy;
      if(!['WAVE','BATCH','CLUSTER'].includes(strategy))throw new ValidationError('Choose a wave, batch, or cluster picking strategy.');
      return prepareResult({orderIds:[row.id],strategy,title:`${strategy} pick for ${row.order_number}`},
        `Release ${row.order_number} to a ${strategy.toLowerCase()} pick. No stock leaves yet.`);},
    execute:(client,ctx,p)=>waves.create(sameClient(client),ctx,p),
    verify:async(client,ctx,r)=>Boolean(r.waveId&&r.status==='PICKING'&&
      await state(client,ctx,'fulfillment_waves',r.waveId,['PICKING']))},
  {name:'warehouse.wave.scan',description:'Verify a physically scanned location, SKU and optional lot or serial on an open fulfillment wave. The canonical scan engine rejects mismatches and duplicates.',
    record:'fulfillment_wave',fields:['recordReference','scanLocation','scanItem','quantity','lotBarcode','serialBarcode'],
    permission:permissions.MANAGE_FULFILLMENT_WAVES,capability:'warehouse.advanced',build:warehouseScan,
    execute:async(client,ctx,p)=>{const result=await waves.scan(sameClient(client),ctx,p.recordId,
      {clientScanId:p.idempotencyKey,locationBarcode:p.locationBarcode,itemBarcode:p.itemBarcode,
        quantity:p.quantity,lotBarcode:p.lotBarcode,serialBarcode:p.serialBarcode});
      if(result.status!=='ACCEPTED')throw new ValidationError(result.message);
      return result;},
    verify:async(client,ctx,r,p)=>Boolean(r.id&&
      (await client.query(`SELECT 1 FROM fulfillment_wave_scans WHERE workspace_id=$1 AND id=$2
        AND wave_id=$3 AND status='ACCEPTED'`,[ctx.workspaceId,r.id,p.recordId])).rows.length)},
  {name:'warehouse.wave.pack',description:'Pack one scan-complete shipment in a warehouse wave. All planned units must have accepted physical scans; no stock is shipped by packing.',
    record:'fulfillment_wave',fields:['recordReference','weightGrams'],
    permission:permissions.MANAGE_FULFILLMENT_WAVES,capability:'warehouse.advanced',
    build:async(database,ctx,row,args)=>{requireState(row,['PICKING','BLOCKED'],'This wave');
      const shipments=(await database.query(`SELECT shipment_id FROM fulfillment_wave_shipments
        WHERE workspace_id=$1 AND wave_id=$2 AND status='PICKING'`,[ctx.workspaceId,row.id])).rows;
      if(shipments.length!==1)throw new ValidationError('Choose the exact carton on the wave page; Ask will not guess among multiple shipments.');
      const weightGrams=args.weightGrams==null?null:positive(args.weightGrams,'Measured package weight');
      return prepareResult({recordId:row.id,shipmentId:shipments[0].shipment_id,weightGrams,packageCount:1},
        `Pack the scan-complete carton in ${row.title}${weightGrams?` at ${weightGrams} grams`:''}. Goods do not leave yet.`);},
    execute:(client,ctx,p)=>waves.packShipment(sameClient(client),ctx,p.recordId,p.shipmentId,p),
    verify:async(client,ctx,r,p)=>Boolean(r.status==='PACKED'&&
      await state(client,ctx,'sales_shipments',p.shipmentId,['PACKED']))},
  {name:'warehouse.wave.shortage',description:'Record a verified shortage for one exact open SKU line in a warehouse wave. The wave is blocked; stock and the customer order do not move.',
    record:'fulfillment_wave',fields:['recordReference','sku','foundQuantity','reason'],
    permission:permissions.MANAGE_FULFILLMENT_WAVES,capability:'warehouse.advanced',
    build:async(database,ctx,row,args)=>{requireState(row,['PICKING','BLOCKED'],'This wave');
      const wanted=String(args.sku||'').trim().toLowerCase();
      if(!wanted)throw new ValidationError('Name the exact SKU that was short.');
      const lines=(await database.query(`SELECT l.id,s.code,l.planned_quantity,l.picked_quantity
        FROM fulfillment_wave_lines l JOIN skus s ON s.id=l.sku_id AND s.workspace_id=l.workspace_id
        WHERE l.workspace_id=$1 AND l.wave_id=$2 AND lower(s.code)=lower($3)
          AND l.picked_quantity<l.planned_quantity`,[ctx.workspaceId,row.id,wanted])).rows;
      if(lines.length!==1)throw new ValidationError('Name an exact open SKU line; multiple cartons need individual review.');
      const found=Number(args.foundQuantity);
      if(!Number.isSafeInteger(found)||found<0||found>=Number(lines[0].planned_quantity)-Number(lines[0].picked_quantity))
        throw new ValidationError('The physically found quantity must be below the unpicked amount.');
      return prepareResult({recordId:row.id,lineId:lines[0].id,foundQuantity:found,note:args.reason||null},
        `Record a shortage of ${lines[0].code} on ${row.title}: only ${found} found. `+
        'The wave will block for recount or replenishment; no stock leaves.');},
    execute:(client,ctx,p)=>waves.reportShortage(sameClient(client),ctx,p.recordId,p.lineId,p.foundQuantity,p.note),
    verify:async(client,ctx,_r,p)=>Boolean(await state(client,ctx,'fulfillment_waves',p.recordId,['BLOCKED'])&&
      (await client.query(`SELECT 1 FROM fulfillment_wave_lines WHERE workspace_id=$1 AND id=$2
        AND wave_id=$3 AND status='SHORT'`,[ctx.workspaceId,p.lineId,p.recordId])).rows.length)},
  {name:'warehouse.wave.refresh',description:'Verify whether every carton in an existing wave has physically shipped or been cancelled, completing the wave only when the canonical service confirms it.',
    record:'fulfillment_wave',fields:['recordReference'],permission:permissions.MANAGE_FULFILLMENT_WAVES,
    capability:'warehouse.advanced',states:['PACKED','PICKING','BLOCKED'],verb:'Verify shipment outcomes for',
    execute:(client,ctx,p)=>waves.refresh(sameClient(client),ctx,p.recordId),
    verify:async(client,ctx,r,p)=>Boolean(r.waveId===p.recordId&&
      await state(client,ctx,'fulfillment_waves',p.recordId,[r.completed?'COMPLETED':'PACKED','PICKING','BLOCKED']))},
  {name:'accounting.bank_import',description:'Import one exact bank statement transaction as unmatched evidence, without creating a sale, payment or accounting posting.',
    record:'bank_account',fields:['recordReference','transactionDate','amount','description','externalId'],
    permission:permissions.RECONCILE_ACCOUNTS,capability:'accounting.core',build:bankImport,
    execute:(client,ctx,p)=>banking.importOne(sameClient(client),ctx,p.recordId,p),
    verify:async(client,ctx,r,p)=>Boolean(r.transaction?.id&&
      (await client.query(`SELECT 1 FROM accounting_bank_transactions WHERE workspace_id=$1 AND id=$2
        AND bank_account_id=$3 AND status='UNMATCHED'`,[ctx.workspaceId,r.transaction.id,p.recordId])).rows.length)},
  {name:'accounting.bank_match',description:'Match one exact imported statement line to an existing posted payment or journal entry of the same amount and financial account; no posting is created.',
    record:'bank_transaction',fields:['recordReference','mode','reference'],
    permission:permissions.RECONCILE_ACCOUNTS,capability:'accounting.core',
    build:(_database,_ctx,row,args)=>{if(row.status!=='UNMATCHED')throw new ValidationError('This statement line is already matched.');
      const kind=String(args.mode||'').trim().toLowerCase();
      if(!['payment','journal'].includes(kind)||!args.reference)throw new ValidationError(
        'Give an exact posted payment or journal entry ID and identify its kind.');
      return prepareResult({recordId:row.id,target:`${kind}:${args.reference}`},
        `Match statement line ${row.external_id||row.id} to ${kind} ${args.reference}. `+
        'The banking engine verifies account and amount; no new posting is made.');},
    execute:(client,ctx,p)=>banking.match(sameClient(client),ctx,p.recordId,p.target),
    verify:async(client,ctx,r,p)=>Boolean(r.transaction?.id===p.recordId&&
      (await client.query(`SELECT 1 FROM accounting_bank_transactions WHERE workspace_id=$1 AND id=$2
        AND status='MATCHED'`,[ctx.workspaceId,p.recordId])).rows.length)},
  {name:'accounting.reconcile',description:'Save or complete an exact bank or credit-card statement reconciliation. Completion requires the statement and posted ledger to agree with zero unmatched lines.',
    record:'bank_account',fields:['recordReference','statementEndDate','statementEndingBalance','enabled'],
    permission:permissions.RECONCILE_ACCOUNTS,capability:'accounting.core',build:bankReconcile,
    execute:(client,ctx,p)=>banking.reconcile(sameClient(client),ctx,p.recordId,p),
    verify:async(client,ctx,r,p)=>Boolean(r.id&&r.status===(p.complete?'COMPLETED':'IN_PROGRESS')&&
      (await client.query(`SELECT 1 FROM accounting_reconciliations WHERE workspace_id=$1 AND id=$2
        AND bank_account_id=$3 AND status=$4`,[ctx.workspaceId,r.id,p.recordId,r.status])).rows.length)},
  {name:'connection.accounting_authority',description:'Choose read-only observation or request governed posting for an existing QuickBooks/Xero connection. POST does not enable exports until mappings and shadow parity pass.',
    record:'connection',fields:['recordReference','authority'],permission:permissions.ADMIN,
    ownerOnly:true,capability:'connections.accounting',
    build:(_database,_ctx,row,args)=>{if(!['quickbooks','xero'].includes(row.provider_type))throw new ValidationError('Choose a QuickBooks or Xero connection.');
      const authority=String(args.authority||'').toUpperCase();
      if(!['OBSERVE','POST'].includes(authority))throw new ValidationError('Choose OBSERVE or POST accounting authority.');
      return prepareResult({recordId:row.id,authority},
        `${authority==='POST'?'Request governed posting':'Keep read-only observation'} for ${row.display_name}. `+
        'No provider journal is sent by this change.');},
    execute:(client,ctx,p)=>accountingSync.chooseAuthority(sameClient(client),ctx,p.recordId,p.authority),
    verify:async(client,ctx,r,p)=>Boolean(r.requested_authority===p.authority)},
  {name:'connection.map_account',description:'Map one exact StockChief ledger account to an external QuickBooks/Xero account verified in the latest provider snapshot. No journal is exported.',
    record:'connection',fields:['recordReference','accountCode','externalId'],permission:permissions.ADMIN,
    ownerOnly:true,capability:'connections.accounting',build:accountMapping,
    execute:(client,ctx,p)=>accountingSync.mapAccount(sameClient(client),ctx,p.recordId,p),
    verify:async(client,ctx,r,p)=>Boolean(r.account?.id===p.accountId&&
      (await client.query(`SELECT 1 FROM accounting_posting_account_mappings WHERE workspace_id=$1
        AND connector_id=$2 AND foundry_account_id=$3 AND external_id=$4`,
      [ctx.workspaceId,p.recordId,p.accountId,p.externalId])).rows.length)},
  {name:'connection.accounting_enable',description:'Enable governed accounting posting on one connection only after a matched shadow run, complete verified mappings, and provider write scope. No journal is sent by enabling.',
    record:'connection',fields:['recordReference'],permission:permissions.ADMIN,ownerOnly:true,
    capability:'accounting.post_connected',
    build:(_database,_ctx,row)=>{if(!['quickbooks','xero'].includes(row.provider_type))
      throw new ValidationError('Choose a QuickBooks or Xero accounting connection.');
      return prepareResult({recordId:row.id},`Enable governed journal posting on ${row.display_name} `+
        'only if its latest read-only shadow comparison matched and the authorization grants posting scope.');},
    execute:(client,ctx,p)=>accountingSync.enableWrites(sameClient(client),ctx,p.recordId),
    verify:async(client,ctx,r,p)=>Boolean(r.stage==='WRITE_ENABLED'&&
      (await client.query(`SELECT 1 FROM accounting_sync_policies WHERE workspace_id=$1
        AND connector_id=$2 AND stage='WRITE_ENABLED'`,[ctx.workspaceId,p.recordId])).rows.length)},
  {name:'connection.accounting_export',description:'Queue unmapped-free posted journals for asynchronous export through one enabled accounting connection. The provider must confirm each export separately.',
    record:'connection',fields:['recordReference'],permission:permissions.ADMIN,ownerOnly:true,
    capability:'accounting.post_connected',
    build:(_database,_ctx,row)=>{if(!['quickbooks','xero'].includes(row.provider_type))
      throw new ValidationError('Choose a QuickBooks or Xero accounting connection.');
      return prepareResult({recordId:row.id},`Queue ready posted journals for ${row.display_name}. `+
        'The worker will contact the provider; queued is not posted.');},
    execute:(client,ctx,p)=>accountingSync.queuePending(sameClient(client),ctx,p.recordId,{}),
    verify:async(client,ctx,r,p)=>{
      if(!Number.isSafeInteger(r.queued)||r.queued!==r.effects?.length)return false;
      for(const effect of r.effects){
        if(!effect.id||!effect.aggregateId)return false;
        const found=await client.query(`SELECT 1 FROM stockchief_runtime.provider_effects
          WHERE workspace_id=$1 AND id=$2 AND aggregate_id=$3 AND kind='accounting.journal.export'
            AND payload->>'connectorId'=$4`,[ctx.workspaceId,effect.id,effect.aggregateId,p.recordId]);
        if(!found.rows.length)return false;
      }
      return true;
    }},
]);
const byName=new Map(SPECS.map((spec)=>[spec.name,spec]));
if(byName.size!==SPECS.length)throw new TypeError('Duplicate workflow capability.');

async function prepare(database,ctx,message,name,args,createProposal){
  const spec=byName.get(name);if(!spec)throw new TypeError(`Unknown workflow capability ${name}`);
  if(spec.ownerOnly&&(await actor(database,ctx)).role!=='owner')throw new ValidationError(
    'Only this inventory’s owner can approve this change.');
  if(spec.capability)await entitlements.assertCapability(database,
    await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId),spec.capability);
  if(!spec.record){const outcome=await spec.build(database,ctx,null,args);
    return createProposal(database,ctx,message,name,outcome.payload,outcome.summary);}
  const found=await record(database,ctx,spec.record,args.recordReference,message);
  if(!found.row)return {status:'CLARIFY',answer:found.missing?`Which ${found.label} should I use? Nothing changed.`:
    found.ambiguous?`More than one ${found.label} matches. Give its exact number. Nothing changed.`:
      `I could not find that ${found.label} in this inventory. Nothing changed.`,awaitingField:'recordReference'};
  const row=found.row;
  const outcome=spec.build?await spec.build(database,ctx,row,args):(()=>{
    if(spec.states)requireState(row,spec.states,`This ${found.label}`);
    return prepareResult({recordId:row.id,...Object.fromEntries(spec.fields.filter((field)=>
      field!=='recordReference'&&args[field]!=null).map((field)=>[field,args[field]]))},
      `${spec.verb} ${found.label} ${row[RECORDS[spec.record].number]}.`);
  })();
  return createProposal(database,ctx,message,name,outcome.payload,outcome.summary);
}

const EXECUTORS=Object.fromEntries(SPECS.map((spec)=>[spec.name,{execute:spec.execute,verify:spec.verify}]));
module.exports={SPECS,EXECUTORS,prepare,record,RECORDS,returnResolution,normalizeRefundDestination};

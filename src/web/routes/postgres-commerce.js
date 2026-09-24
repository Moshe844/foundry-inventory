'use strict';

const express=require('express');
const commerce=require('../../operations/postgres-commerce');
const workflows=require('../../operations/postgres-business-workflows');
const returns=require('../../operations/postgres-returns');
const shipping=require('../../shipping/postgres-service');
const payments=require('../../payments/postgres-collection');
const paymentConnect=require('../../payments/postgres-connect');
const planning=require('../../forecasting/postgres-planning-service');
const presenters=require('../postgres-presenters');
const permissions=require('../../actions/permissions');
const {requireAuth,requirePermission,asyncRoute}=require('../middleware');
const {newId,nowIso,trimOrNull}=require('../../lib/util');
const {ValidationError}=require('../../domain/errors');

function key(req,kind){return trimOrNull(req.body.idempotencyKey)||`${kind}:${newId('form')}`;}

function minor(value,label){
  const text=String(value??'').trim();
  if(!/^\d+(?:\.\d{1,2})?$/.test(text))throw new ValidationError(`${label} must be a positive money amount.`);
  const amount=Math.round(Number(text)*100);
  if(!Number.isSafeInteger(amount)||amount<0)throw new ValidationError(`${label} is invalid.`);
  return amount;
}

function dateToday(){return new Date().toISOString().slice(0,10);}

function purchasingPermissions(req){return {
  suppliers:permissions.can(req.user,permissions.MANAGE_SUPPLIERS),
  create:permissions.can(req.user,permissions.CREATE_PO),
  approve:permissions.can(req.user,permissions.APPROVE_PO),
  receive:permissions.can(req.user,permissions.RECEIVE_PO),
  payments:permissions.can(req.user,permissions.RECORD_PAYMENTS),
  landedCosts:permissions.can(req.user,permissions.ALLOCATE_LANDED_COST),
};}

function jsonValue(value,fallback){
  if(value===null||value===undefined||value==='')return fallback;
  if(typeof value!=='string')return value;
  try{return JSON.parse(value);}catch{return fallback;}
}

async function purchaseOrderPage(database,workspaceId,id){
  const detail=await commerce.purchaseOrder(database,workspaceId,id);
  const [receiptLines,charges,documents,communications,supplierRows]=await Promise.all([
    database.query(`SELECT rl.*,i.name AS item_name,s.variant_label,l.name AS location_name
      FROM purchase_order_receipt_lines rl
      JOIN skus s ON s.id=rl.sku_id AND s.workspace_id=rl.workspace_id
      JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
      JOIN locations l ON l.id=rl.location_id AND l.workspace_id=rl.workspace_id
      JOIN purchase_order_receipts r ON r.id=rl.receipt_id AND r.workspace_id=rl.workspace_id
      WHERE rl.workspace_id=$1 AND r.purchase_order_id=$2 ORDER BY rl.created_at,rl.id`,[workspaceId,id]),
    database.query(`SELECT label,kind,amount_minor FROM purchase_order_charges
      WHERE workspace_id=$1 AND purchase_order_id=$2 ORDER BY created_at,id`,[workspaceId,id]),
    database.query(`SELECT * FROM supplier_documents WHERE workspace_id=$1 AND purchase_order_id=$2
      ORDER BY processed_at DESC,id DESC`,[workspaceId,id]),
    database.query(`SELECT sc.*,wc.display_name AS mailbox_name,wc.provider_type
      FROM supplier_communications sc LEFT JOIN workspace_connectors wc
        ON wc.id=sc.connector_id AND wc.workspace_id=sc.workspace_id
      WHERE sc.workspace_id=$1 AND sc.purchase_order_id=$2 ORDER BY sc.created_at DESC,sc.id DESC`,[workspaceId,id]),
    database.query(`SELECT * FROM suppliers WHERE workspace_id=$1 AND id=$2`,[workspaceId,detail.order.supplier_id]),
  ]);
  const lines=detail.lines.map((line)=>({
    ...line,displayName:line.item_name+(line.variant_label?` / ${line.variant_label}`:''),skuCode:line.code,
    supplierSku:line.supplier_sku,unitLabel:line.unit_label||'unit',trackingMode:line.tracking_mode,
    purchaseUnit:line.purchase_unit||'unit',unitsPerPurchaseUnit:Number(line.units_per_purchase_unit||1),
    quantityPurchaseUnits:Number(line.quantity_purchase_units||line.quantity_units),quantityUnits:Number(line.quantity_units),
    quantityReceivedUnits:Number(line.quantity_received_units),outstandingUnits:Math.max(0,Number(line.quantity_units)-Number(line.quantity_received_units)),
    unitCost:line.unit_cost===null?null:Number(line.unit_cost),lineTotal:line.line_total===null?null:Number(line.line_total),
    destinationLocationName:line.location_name,isComplete:Number(line.quantity_received_units)>=Number(line.quantity_units),
  }));
  const orderedUnits=lines.reduce((sum,line)=>sum+line.quantityUnits,0);
  const receivedUnits=lines.reduce((sum,line)=>sum+line.quantityReceivedUnits,0);
  const order={...detail.order,poNumber:detail.order.po_number,supplierName:detail.order.supplier_name,
    orderDate:detail.order.order_date,expectedDate:detail.order.expected_date,createdAt:detail.order.created_at,
    cancelReason:detail.order.cancel_reason,sourceDetail:jsonValue(detail.order.source_detail,{}),
    supplierItemCodeLabel:supplierRows.rows[0]?.item_code_label||'Supplier code',lines,orderedUnits,receivedUnits,
    outstandingUnits:Math.max(0,orderedUnits-receivedUnits),subtotal:lines.reduce((sum,line)=>sum+Number(line.lineTotal||0),0),
    hasCosts:lines.length>0&&lines.every((line)=>line.unitCost!==null),isEditable:['DRAFT','AWAITING_APPROVAL'].includes(detail.order.status),
    isOpen:['ORDERED','PARTIALLY_RECEIVED'].includes(detail.order.status),
    canCancel:!['RECEIVED','CANCELLED'].includes(detail.order.status),integrityHash:detail.order.integrity_hash||'',
    destinationLocationName:lines.find((line)=>line.destinationLocationName)?.destinationLocationName||null};
  const receiptLineMap=new Map();
  for(const line of receiptLines.rows){
    if(!receiptLineMap.has(line.receipt_id))receiptLineMap.set(line.receipt_id,[]);
    receiptLineMap.get(line.receipt_id).push({displayName:line.item_name+(line.variant_label?` / ${line.variant_label}`:''),
      locationName:line.location_name,quantityUnits:Number(line.quantity_units),lotCode:line.lot_code,
      serials:jsonValue(line.serials,[]),overByUnits:Number(line.over_by_units||0)});
  }
  const receipts=detail.receipts.map((receipt)=>{const receiptItems=receiptLineMap.get(receipt.id)||[];return {
    ...receipt,receivedAt:receipt.received_at,overReceiptApproved:Boolean(Number(receipt.over_receipt_approved)),
    totalUnits:receiptItems.reduce((sum,line)=>sum+line.quantityUnits,0),lines:receiptItems};});
  const supplierBills=detail.bills;
  const approvedBills=supplierBills.filter((bill)=>['OPEN','PARTIALLY_PAID','PAID'].includes(bill.status));
  const billSummary={invoiceCount:supplierBills.length,
    invoiceTotalMinor:supplierBills.reduce((sum,bill)=>sum+Number(bill.total_minor),0),
    approvedTotalMinor:approvedBills.reduce((sum,bill)=>sum+Number(bill.total_minor),0),
    paidMinor:approvedBills.reduce((sum,bill)=>sum+Number(bill.total_minor)-Number(bill.balance_minor),0),
    owedMinor:approvedBills.reduce((sum,bill)=>sum+Number(bill.balance_minor),0),
    needsReview:supplierBills.some((bill)=>['DRAFT','DISPUTED'].includes(bill.status))};
  return {detail,order,receipts,supplierBills,billSummary,
    events:detail.events.map((event)=>({...event,createdAt:event.created_at,actorName:null})),
    charges:charges.rows.map((charge)=>({...charge,amountMinor:Number(charge.amount_minor)})),
    supplierDocuments:documents.rows,
    communications:communications.rows.map((communication)=>({...communication,
      connectorId:communication.connector_id,mailboxName:communication.mailbox_name||'the connected mailbox',
      mailboxProviderName:communication.provider_type==='gmail'?'Gmail':communication.provider_type==='microsoft365'?'Microsoft 365':null})),
    supplier:supplierRows.rows[0]||null};
}

async function salesOrderPage(database,workspaceId,id){
  const detail=await commerce.salesOrder(database,workspaceId,id);
  const [shipmentLines,communications,receipts,accountingRows,catalogue,customers,paymentAccount]=await Promise.all([
    database.query(`SELECT sl.*,l.name AS location_name FROM sales_shipment_lines sl
      JOIN locations l ON l.id=sl.location_id AND l.workspace_id=sl.workspace_id
      JOIN sales_shipments sh ON sh.id=sl.shipment_id AND sh.workspace_id=sl.workspace_id
      WHERE sl.workspace_id=$1 AND sh.sales_order_id=$2 ORDER BY sl.created_at,sl.id`,[workspaceId,id]),
    database.query(`SELECT * FROM customer_communications WHERE workspace_id=$1 AND sales_order_id=$2
      ORDER BY created_at,id`,[workspaceId,id]),
    database.query(`SELECT p.*,COALESCE((SELECT SUM(a.amount_minor) FROM accounting_payment_allocations a
        JOIN accounting_customer_invoices i ON i.id=a.customer_invoice_id
        WHERE a.workspace_id=p.workspace_id AND a.payment_id=p.id AND i.sales_order_id=$2),p.amount_minor)::bigint AS order_amount_minor
      FROM accounting_payments p WHERE p.workspace_id=$1 AND p.sales_order_id=$2
        AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED' ORDER BY p.payment_date,p.created_at,p.id`,[workspaceId,id]),
    database.query(`SELECT e.id,e.status,
        COALESCE(SUM(CASE WHEN a.system_key='SALES_REVENUE' THEN l.credit_minor ELSE 0 END),0)::bigint AS revenue_minor,
        COALESCE(SUM(CASE WHEN a.system_key='COST_OF_GOODS_SOLD' THEN l.debit_minor ELSE 0 END),0)::bigint AS cogs_minor
      FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.entry_id=e.id
      JOIN accounting_accounts a ON a.id=l.account_id
      WHERE e.workspace_id=$1 AND e.source_record_type='sales_order' AND e.source_record_id=$2
        AND e.source_type='sale_fulfillment' GROUP BY e.id,e.status ORDER BY e.created_at DESC`,[workspaceId,id]),
    commerce.catalogue(database,workspaceId),commerce.customers(database,workspaceId),paymentConnect.describe(database,workspaceId),
  ]);
  const lines=detail.lines.map((line)=>{
    const ordered=Number(line.quantity_ordered);const fulfilled=Number(line.quantity_fulfilled);const allocated=Number(line.allocated);
    return {...line,displayName:line.item_name+(line.variant_label?` / ${line.variant_label}`:''),
      lineTotalMinor:line.unit_price_minor===null?null:ordered*Number(line.unit_price_minor),allocated,
      backordered:Math.max(0,ordered-fulfilled-allocated),quantity_fulfilled:fulfilled,isKit:false,
      allocations:line.allocations.map((allocation)=>({...allocation,quantity:Number(allocation.quantity),
        location_name:allocation.location_name,kit_component_id:null}))};
  });
  const totals={ordered:lines.reduce((sum,line)=>sum+Number(line.quantity_ordered),0),
    fulfilled:lines.reduce((sum,line)=>sum+Number(line.quantity_fulfilled),0),
    allocated:lines.reduce((sum,line)=>sum+Number(line.allocated),0),
    backordered:lines.reduce((sum,line)=>sum+Number(line.backordered),0)};
  const subtotalMinor=lines.reduce((sum,line)=>sum+Number(line.lineTotalMinor||0),0);
  const order={...detail.order,customer:{id:detail.order.customer_id,name:detail.order.customer_name,
    email:detail.order.customer_email},lines,totals,
    customer_decision_required:Number(detail.order.customer_decision_required)===1,
    delivery_decision_required:Number(detail.order.delivery_decision_required)===1,
    pricing:{missingPriceLines:lines.filter((line)=>line.unit_price_minor===null).length,subtotalMinor,
      discountMinor:Number(detail.order.discount_minor||0),taxMinor:Number(detail.order.tax_minor||0),totalMinor:detail.orderTotalMinor},
    events:detail.events.map((event)=>({...event,event_type:String(event.event_type||event.event||'updated').toUpperCase(),actor_name:null}))};
  const linesByShipment=new Map();
  for(const line of shipmentLines.rows){
    if(!linesByShipment.has(line.shipment_id))linesByShipment.set(line.shipment_id,[]);
    linesByShipment.get(line.shipment_id).push(line);
  }
  const shipments=detail.shipments.map((shipment)=>{const packed=linesByShipment.get(shipment.id)||[];return {...shipment,
    units:packed.reduce((sum,line)=>sum+Number(line.quantity),0),trackingUrl:shipment.tracking_url,
    wentBy:shipment.handover==='COLLECTED'?'Collected by the customer':shipment.handover==='DELIVERED_BY_US'
      ?'Delivered by us':shipment.carrier||'Carrier'};});
  const pickable=lines.flatMap((line)=>line.allocations.map((allocation)=>({lineId:line.id,locationId:allocation.location_id,
    available:Number(allocation.quantity),displayName:line.displayName,locationName:allocation.location_name})));
  const invoiceTotal=detail.invoices.reduce((sum,invoice)=>sum+Number(invoice.total_minor),0);
  const invoiceOutstanding=detail.invoices.reduce((sum,invoice)=>sum+Number(invoice.balance_minor),0);
  const paidMinor=receipts.rows.reduce((sum,payment)=>sum+Number(payment.order_amount_minor||payment.amount_minor),0);
  const terms=detail.paymentTerms;const termsText=!terms?'Payment due when invoiced':terms.kind==='BEFORE_FULFILMENT'
    ?'Payment before fulfilment':terms.kind==='DEPOSIT'?'Deposit before fulfilment':`Net ${Number(terms.net_days||0)}`;
  const held=detail.depositDueMinor>0||terms?.kind==='BEFORE_FULFILMENT'&&paidMinor<detail.orderTotalMinor;
  const money={invoiced:detail.invoices.length>0,hasInvoice:detail.invoices.length>0,invoices:detail.invoices,
    totalMinor:detail.invoices.length?invoiceTotal:detail.orderTotalMinor,paidMinor,
    outstandingMinor:detail.invoices.length?invoiceOutstanding:Math.max(0,detail.orderTotalMinor-paidMinor),
    dueNowMinor:detail.depositDueMinor||0,currency:detail.order.currency,state:invoiceOutstanding===0&&detail.invoices.length?'Paid':
      paidMinor>0?'Partially paid':'Unpaid',terms:terms||{source:'business default'},termsText,
    heldReason:{pick:held?'The agreed payment is still due before this order can be picked.':null,
      ship:terms?.hold_shipping&&invoiceOutstanding>0?'The remaining balance is due before this order can ship.':null},
    blocksPicking:held,blocksShipping:Boolean(terms?.hold_shipping&&invoiceOutstanding>0),override:null,dueDate:null};
  const accountingTotals=accountingRows.rows.reduce((total,row)=>({revenueMinor:total.revenueMinor+Number(row.revenue_minor),
    cogsMinor:total.cogsMinor+Number(row.cogs_minor)}),{revenueMinor:0,cogsMinor:0});
  const latestAccounting=accountingRows.rows[0];const accounting=latestAccounting?{id:latestAccounting.id,
    journal_entry_id:latestAccounting.id,status:latestAccounting.status,outcome:accountingTotals}:{status:'DISABLED',outcome:{}};
  const fulfilmentState=totals.fulfilled===totals.ordered?'Shipped':shipments.some((shipment)=>['PICKING','PACKED'].includes(shipment.status))
    ?'Being prepared':totals.allocated?'Ready to pick':totals.backordered?'Waiting for stock':'Not started';
  return {detail,order,shipments,pickable,money,accounting,paymentAccount,
    fulfilment:{state:fulfilmentState,label:fulfilmentState,detail:shipments.length?`${shipments.length} shipment${shipments.length===1?'':'s'}`:null},
    customerNotices:communications.rows.map((notice)=>({...notice,shipmentId:notice.shipment_id,
      messageKind:notice.message_kind,status:notice.status,sentAt:notice.sent_at})),
    customerReceipts:receipts.rows,paymentRequests:detail.paymentRequests.map((request)=>({...request,
      hostedUrl:request.hosted_url,amountMinor:Number(request.amount_minor),paidMinor:Number(request.paid_minor),
      lastError:request.last_error})),
    skus:catalogue.map((sku)=>({
      ...sku,
      display_name:sku.display_name,
      price:{
        isSet:sku.amount_minor!==null,
        formatted:sku.amount_minor===null?'':`${sku.currency||'USD'} ${(Number(sku.amount_minor)/100).toFixed(2)}`,
      },
    })),
    customers,
  };
}

function supplierForView(row){return {id:row.id,name:row.name,code:row.code,contactName:row.contact_name,
  email:row.email,phone:row.phone,notes:row.notes,status:row.status,defaultLeadTimeDays:row.default_lead_time_days,
  minimumOrderAmount:row.minimum_order_amount===null?null:Number(row.minimum_order_amount),currency:row.currency,
  paymentTerms:row.payment_terms,itemCodeLabel:row.item_code_label||'Supplier code',
  itemCodeAliases:Array.isArray(row.item_code_aliases)?row.item_code_aliases:(()=>{try{return JSON.parse(row.item_code_aliases||'[]');}catch{return [];}})(),
  preferredOrderingMethod:row.preferred_ordering_method||'email',watchedConnectorId:row.watched_connector_id,
  prepareCommunications:Boolean(Number(row.prepare_communications)),autoSendEnabled:Boolean(Number(row.auto_send_enabled)),
  autoSendLimit:row.auto_send_limit_minor===null?null:Number(row.auto_send_limit_minor)/100,
  priceTolerancePercent:Number(row.price_tolerance_percent??5),quantityTolerancePercent:Number(row.quantity_tolerance_percent??0),
  trustedDeliveryReceipt:Boolean(Number(row.trusted_delivery_receipt)),followUpDays:Number(row.follow_up_days||2)};}

function purchaseOrderForView(row){return {...row,poNumber:row.po_number,supplierName:row.supplier_name,
  expectedDate:row.expected_date,createdAt:row.created_at,orderedUnits:Number(row.ordered_units||0),
  outstandingUnits:Number(row.units_outstanding||0),subtotal:Number(row.total||0),
  hasCosts:Number(row.line_count||0)>0&&Number(row.priced_line_count||0)===Number(row.line_count||0),
  isOpen:['APPROVED','ORDERED','PARTIALLY_RECEIVED'].includes(row.status)};}

function createPostgresCommerceRouter(database,options={}){
  const router=express.Router();
  router.use(['/purchasing','/orders','/sales'],requireAuth);

  router.get('/suppliers',requireAuth,requirePermission(permissions.VIEW_PURCHASING,'see suppliers'),asyncRoute(async(req,res)=>{
    const rows=(await database.query(`SELECT s.*,
      COALESCE((SELECT COUNT(*) FROM supplier_items si WHERE si.workspace_id=s.workspace_id AND si.supplier_id=s.id AND si.is_active=1),0)::integer AS item_count,
      COALESCE((SELECT COUNT(*) FROM purchase_orders po WHERE po.workspace_id=s.workspace_id AND po.supplier_id=s.id
        AND po.status IN ('DRAFT','APPROVED','ORDERED','PARTIALLY_RECEIVED')),0)::integer AS open_orders
      FROM suppliers s WHERE s.workspace_id=$1 ORDER BY lower(s.name),s.id`,[req.ctx.workspaceId])).rows;
    const suppliers=rows.map((supplier)=>({id:supplier.id,name:supplier.name,email:supplier.email,status:supplier.status,
      contactName:supplier.contact_name,defaultLeadTimeDays:supplier.default_lead_time_days,
      itemCount:Number(supplier.item_count),openOrders:Number(supplier.open_orders),isActive:supplier.status==='active'}));
    const prefill=['name','email','phone','contactName'].some((field)=>trimOrNull(req.query[field]))
      ?{name:trimOrNull(req.query.name)||'',email:trimOrNull(req.query.email)||'',phone:trimOrNull(req.query.phone)||'',
        contactName:trimOrNull(req.query.contactName)||''}:null;
    return res.page('purchasing/suppliers',{title:'Suppliers',nav:'purchasing',suppliers,prefill,
      permissions:purchasingPermissions(req)});
  }));
  router.post('/suppliers',requireAuth,requirePermission(permissions.MANAGE_SUPPLIERS,'add suppliers'),asyncRoute(async(req,res)=>{
    const supplier=await commerce.createSupplier(database,req.ctx,req.body);req.flash('success',`${supplier.name} was added.`);
    return res.redirect(303,`/suppliers/${supplier.id}`);
  }));

  router.get('/suppliers/:id',requireAuth,requirePermission(permissions.VIEW_PURCHASING,'see suppliers'),asyncRoute(async(req,res)=>{
    const [supplierRows,itemRows,orderRows,mailboxRows,senderRows,priceRows,catalogueRows,usageRows]=await Promise.all([
      database.query('SELECT * FROM suppliers WHERE workspace_id=$1 AND id=$2',[req.ctx.workspaceId,req.params.id]),
      database.query(`SELECT si.*,s.code AS internal_code,s.variant_label,i.name AS item_name,
        CASE WHEN COALESCE(s.variant_label,'')='' THEN i.name ELSE i.name||' / '||s.variant_label END AS display_name
        FROM supplier_items si JOIN skus s ON s.id=si.sku_id AND s.workspace_id=si.workspace_id
        JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
        WHERE si.workspace_id=$1 AND si.supplier_id=$2 ORDER BY lower(i.name),s.position,si.id`,[req.ctx.workspaceId,req.params.id]),
      commerce.purchaseOrders(database,req.ctx.workspaceId),
      database.query(`SELECT id,display_name,provider_type,status,last_synced_at FROM workspace_connectors
        WHERE workspace_id=$1 AND provider_type IN ('gmail','microsoft365','supplier_email') ORDER BY lower(display_name)`,[req.ctx.workspaceId]),
      database.query(`SELECT r.*,wc.display_name AS connection_name FROM connection_email_rules r
        JOIN workspace_connectors wc ON wc.id=r.connector_id AND wc.workspace_id=r.workspace_id
        WHERE r.workspace_id=$1 AND r.supplier_id=$2 AND r.is_active=1 ORDER BY lower(r.sender_pattern)`,[req.ctx.workspaceId,req.params.id]),
      database.query(`SELECT h.*,s.code AS sku_code,i.name AS item_name FROM supplier_price_history h
        JOIN skus s ON s.id=h.sku_id JOIN items i ON i.id=s.item_id
        WHERE h.workspace_id=$1 AND h.supplier_id=$2 ORDER BY h.observed_at DESC LIMIT 20`,[req.ctx.workspaceId,req.params.id]),
      database.query(`SELECT s.id,s.code,s.variant_label,i.name AS item_name,i.unit_label FROM skus s
        JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
        WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 ORDER BY lower(i.name),s.position LIMIT 500`,[req.ctx.workspaceId]),
      database.query(`SELECT
        (SELECT COUNT(*) FROM purchase_orders WHERE workspace_id=$1 AND supplier_id=$2)::integer AS orders,
        (SELECT COUNT(*) FROM accounting_supplier_bills WHERE workspace_id=$1 AND supplier_id=$2)::integer AS bills,
        (SELECT COUNT(*) FROM supplier_items WHERE workspace_id=$1 AND supplier_id=$2)::integer AS items`,[req.ctx.workspaceId,req.params.id]),
    ]);
    if(!supplierRows.rows.length)throw new ValidationError('That supplier is not available in this inventory.');
    const supplier=supplierForView(supplierRows.rows[0]);const usageRow=usageRows.rows[0];
    const used=[['orders','purchase orders'],['bills','supplier bills'],['items','linked products']]
      .filter(([key])=>Number(usageRow[key])>0).map(([key,label])=>({count:Number(usageRow[key]),label}));
    const items=itemRows.rows.map((row)=>({id:row.id,displayName:row.display_name,internalCode:row.internal_code,
      supplierSku:row.supplier_sku,purchaseUnit:row.purchase_unit,unitsPerPurchaseUnit:Number(row.units_per_purchase_unit),
      lastUnitCost:row.last_unit_cost===null?null:Number(row.last_unit_cost),
      effectiveLeadTimeDays:row.lead_time_days===null?supplier.defaultLeadTimeDays:Number(row.lead_time_days),
      minimumOrderQuantity:row.minimum_order_quantity===null?null:Number(row.minimum_order_quantity),
      orderMultiple:row.order_multiple===null?null:Number(row.order_multiple),isPreferred:Boolean(Number(row.is_preferred)),
      isActive:Boolean(Number(row.is_active))}));
    return res.page('purchasing/supplier',{title:supplier.name,nav:'purchasing',supplier,items,
      orders:orderRows.filter((row)=>row.supplier_id===supplier.id).slice(0,10).map(purchaseOrderForView),
      mailboxConnections:mailboxRows.rows,senderRules:senderRows.rows,reliability:null,priceHistory:priceRows.rows,
      codeMappings:[],catalogue:catalogueRows.rows,usage:{deletable:used.length===0,used,total:used.reduce((sum,row)=>sum+row.count,0)},
      permissions:purchasingPermissions(req)});
  }));

  router.post('/suppliers/:id',requireAuth,requirePermission(permissions.MANAGE_SUPPLIERS,'manage suppliers'),asyncRoute(async(req,res)=>{
    const current=(await database.query('SELECT * FROM suppliers WHERE workspace_id=$1 AND id=$2',[req.ctx.workspaceId,req.params.id])).rows[0];
    if(!current)throw new ValidationError('That supplier is not available in this inventory.');
    const has=(name)=>Object.prototype.hasOwnProperty.call(req.body,name);const text=(name,column)=>has(name)?trimOrNull(req.body[name]):current[column];
    const fields={name:text('name','name'),contactName:text('contactName','contact_name'),email:text('email','email'),
      phone:text('phone','phone'),notes:text('notes','notes'),paymentTerms:text('paymentTerms','payment_terms'),
      currency:has('currency')?(trimOrNull(req.body.currency)||'USD').toUpperCase():current.currency,
      preferredOrderingMethod:has('preferredOrderingMethod')?(trimOrNull(req.body.preferredOrderingMethod)||'email'):current.preferred_ordering_method};
    if(!fields.name)throw new ValidationError('Supplier name is required.');
    const optionalNumber=(name,column)=>has(name)?(req.body[name]===''?null:Number(req.body[name])):current[column];
    const lead=optionalNumber('defaultLeadTimeDays','default_lead_time_days');const minimum=optionalNumber('minimumOrderAmount','minimum_order_amount');
    const limit=has('autoSendLimit')?(req.body.autoSendLimit===''?null:minor(req.body.autoSendLimit,'Automatic order limit')):current.auto_send_limit_minor;
    await database.query(`UPDATE suppliers SET name=$3,contact_name=$4,email=$5,
      phone=$6,notes=$7,default_lead_time_days=$8,minimum_order_amount=$9,currency=$10,
      payment_terms=$11,preferred_ordering_method=$12,prepare_communications=$13,auto_send_enabled=$14,
      auto_send_limit_minor=$15,price_tolerance_percent=$16,quantity_tolerance_percent=$17,trusted_delivery_receipt=$18,
      follow_up_days=$19,updated_at=$20 WHERE workspace_id=$1 AND id=$2`,[req.ctx.workspaceId,req.params.id,
      fields.name,fields.contactName,fields.email,fields.phone,fields.notes,Number.isSafeInteger(lead)&&lead>=0?lead:null,
      Number.isFinite(minimum)&&minimum>=0?minimum:null,fields.currency,fields.paymentTerms,fields.preferredOrderingMethod,
      has('prepareCommunications')?(req.body.prepareCommunications==='1'?1:0):current.prepare_communications,
      has('autoSendEnabled')?(req.body.autoSendEnabled==='1'?1:0):current.auto_send_enabled,limit,
      optionalNumber('priceTolerancePercent','price_tolerance_percent'),optionalNumber('quantityTolerancePercent','quantity_tolerance_percent'),
      has('trustedDeliveryReceipt')?(req.body.trustedDeliveryReceipt==='1'?1:0):current.trusted_delivery_receipt,
      has('followUpDays')?Math.max(1,Number(req.body.followUpDays||2)):current.follow_up_days,nowIso()]);
    req.flash('success','Supplier details and rules saved.');return res.redirect(303,`/suppliers/${req.params.id}`);
  }));

  router.post('/suppliers/:id/archive',requireAuth,requirePermission(permissions.MANAGE_SUPPLIERS,'manage suppliers'),asyncRoute(async(req,res)=>{
    const restore=req.body.restore==='1';
    if(!restore){const open=(await database.query(`SELECT COUNT(*)::integer AS count FROM purchase_orders WHERE workspace_id=$1
      AND supplier_id=$2 AND status IN ('DRAFT','AWAITING_APPROVAL','APPROVED','ORDERED','PARTIALLY_RECEIVED')`,[req.ctx.workspaceId,req.params.id])).rows[0];
      if(Number(open.count)>0)throw new ValidationError('Finish or cancel this supplier’s open purchase orders before archiving them.');}
    await database.query('UPDATE suppliers SET status=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2',
      [req.ctx.workspaceId,req.params.id,restore?'active':'inactive',nowIso()]);
    req.flash('success',restore?'Supplier restored.':'Supplier archived without removing purchase history.');
    return res.redirect(303,`/suppliers/${req.params.id}`);
  }));

  router.post('/suppliers/:id/senders',requireAuth,requirePermission(permissions.MANAGE_SUPPLIERS,'manage suppliers'),asyncRoute(async(req,res)=>{
    const connectorId=trimOrNull(req.body.connectorId);const sender=trimOrNull(req.body.senderPattern);
    if(!connectorId||!sender)throw new ValidationError('Choose a connected mailbox and the supplier sender address.');const at=nowIso();
    await database.transaction(async(client)=>{await client.query(`INSERT INTO connection_email_rules
      (id,workspace_id,connector_id,sender_pattern,supplier_id,document_mode,is_active,created_by_user_id,created_at)
      VALUES($1,$2,$3,$4,$5,'supplier_documents',1,$6,$7)
      ON CONFLICT(workspace_id,connector_id,sender_pattern) DO UPDATE SET supplier_id=EXCLUDED.supplier_id,
        document_mode='supplier_documents',is_active=1`,[newId('emailrule'),req.ctx.workspaceId,connectorId,sender,req.params.id,req.ctx.actorId,at]);
      await client.query('UPDATE suppliers SET watched_connector_id=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2',
        [req.ctx.workspaceId,req.params.id,connectorId,at]);});
    req.flash('success',`Messages from ${sender} are now trusted supplier evidence.`);return res.redirect(303,`/suppliers/${req.params.id}`);
  }));

  router.post('/suppliers/:id/items',requireAuth,requirePermission(permissions.MANAGE_SUPPLIERS,'manage suppliers'),asyncRoute(async(req,res)=>{
    const skuId=trimOrNull(req.body.skuId);if(!skuId)throw new ValidationError('Choose a product to link.');const at=nowIso();
    const units=Math.max(1,Number(req.body.unitsPerPurchaseUnit||1));
    await database.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,supplier_sku,purchase_unit,
      units_per_purchase_unit,last_unit_cost,last_cost_at,lead_time_days,minimum_order_quantity,order_multiple,is_preferred,is_active,notes,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$9,$9)
      ON CONFLICT(workspace_id,supplier_id,sku_id) DO UPDATE SET supplier_sku=EXCLUDED.supplier_sku,
        purchase_unit=EXCLUDED.purchase_unit,units_per_purchase_unit=EXCLUDED.units_per_purchase_unit,
        last_unit_cost=EXCLUDED.last_unit_cost,last_cost_at=EXCLUDED.last_cost_at,lead_time_days=EXCLUDED.lead_time_days,
        minimum_order_quantity=EXCLUDED.minimum_order_quantity,order_multiple=EXCLUDED.order_multiple,
        is_preferred=EXCLUDED.is_preferred,is_active=1,notes=EXCLUDED.notes,updated_at=EXCLUDED.updated_at`,
    [newId('supitem'),req.ctx.workspaceId,req.params.id,skuId,trimOrNull(req.body.supplierSku),
      trimOrNull(req.body.purchaseUnit)||'unit',units,req.body.lastUnitCost===''?null:Number(req.body.lastUnitCost),at,
      req.body.leadTimeDays===''?null:Number(req.body.leadTimeDays),req.body.minimumOrderQuantity===''?null:Number(req.body.minimumOrderQuantity),
      req.body.orderMultiple===''?null:Number(req.body.orderMultiple),req.body.isPreferred==='1'?1:0,trimOrNull(req.body.notes)]);
    req.flash('success','Product linked to this supplier.');return res.redirect(303,`/suppliers/${req.params.id}`);
  }));

  router.post('/suppliers/:id/items/:supplierItemId/remove',requireAuth,
    requirePermission(permissions.MANAGE_SUPPLIERS,'manage suppliers'),asyncRoute(async(req,res)=>{
      await database.query(`UPDATE supplier_items SET is_active=0,updated_at=$4 WHERE workspace_id=$1 AND supplier_id=$2 AND id=$3`,
        [req.ctx.workspaceId,req.params.id,req.params.supplierItemId,nowIso()]);req.flash('success','Removed from this supplier.');
      return res.redirect(303,`/suppliers/${req.params.id}`);
    }));

  router.get('/fulfilment',requireAuth,requirePermission(permissions.VIEW_SALES,'view fulfilment'),asyncRoute(async(req,res)=>{
    const [openRows,readyRows,noticeRows,policyRows,mailboxRows]=await Promise.all([
      database.query(`SELECT sh.id,sh.shipment_number,sh.sales_order_id,sh.status,so.order_number,c.name AS customer_name,
        l.name AS ship_from_location_name,COALESCE(SUM(sl.quantity),0)::integer AS units
        FROM sales_shipments sh JOIN sales_orders so ON so.id=sh.sales_order_id AND so.workspace_id=sh.workspace_id
        JOIN customers c ON c.id=so.customer_id LEFT JOIN locations l ON l.id=sh.ship_from_location_id
        LEFT JOIN sales_shipment_lines sl ON sl.shipment_id=sh.id AND sl.workspace_id=sh.workspace_id
        WHERE sh.workspace_id=$1 AND sh.status IN ('PICKING','PACKED')
        GROUP BY sh.id,so.order_number,c.name,l.name ORDER BY sh.created_at`,[req.ctx.workspaceId]),
      database.query(`SELECT so.id,so.order_number,so.needed_by,c.name AS customer_name,
        COALESCE(SUM(a.quantity),0)::integer AS units FROM sales_orders so JOIN customers c ON c.id=so.customer_id
        JOIN sales_order_lines sol ON sol.sales_order_id=so.id AND sol.workspace_id=so.workspace_id
        JOIN sales_order_allocations a ON a.sales_order_line_id=sol.id AND a.workspace_id=so.workspace_id
        WHERE so.workspace_id=$1 AND so.status IN ('CONFIRMED','PARTIALLY_FULFILLED')
          AND NOT EXISTS(SELECT 1 FROM sales_shipments sh WHERE sh.workspace_id=so.workspace_id AND sh.sales_order_id=so.id
            AND sh.status IN ('PICKING','PACKED'))
        GROUP BY so.id,c.name HAVING SUM(a.quantity)>0 ORDER BY COALESCE(so.needed_by,'9999-12-31'),so.created_at`,[req.ctx.workspaceId]),
      database.query(`SELECT cc.*,c.name AS customer_name,so.order_number,sh.shipment_number FROM customer_communications cc
        LEFT JOIN customers c ON c.id=cc.customer_id LEFT JOIN sales_orders so ON so.id=cc.sales_order_id
        LEFT JOIN sales_shipments sh ON sh.id=cc.shipment_id WHERE cc.workspace_id=$1 AND cc.status IN ('PREPARED','FAILED')
        ORDER BY cc.created_at`,[req.ctx.workspaceId]),
      database.query('SELECT * FROM customer_communication_policy WHERE workspace_id=$1',[req.ctx.workspaceId]),
      database.query(`SELECT id,display_name FROM workspace_connectors WHERE workspace_id=$1
        AND provider_type IN ('gmail','microsoft365') AND status='connected' ORDER BY display_name`,[req.ctx.workspaceId]),
    ]);
    const policy=policyRows.rows[0]||{};
    return res.page('sales/fulfilment',{title:'Fulfilment',nav:'sales',queue:{open:openRows.rows,ready:readyRows.rows},
      waitingNotices:noticeRows.rows.map((row)=>({shipmentId:row.shipment_id,customerName:row.customer_name,
        recipient:row.recipient,orderNumber:row.order_number,shipmentNumber:row.shipment_number,status:row.status,errorMessage:row.error_message})),
      noticePolicy:{shippingNotice:policy.shipping_notice||'prepare',outForDeliveryNotice:policy.out_for_delivery_notice||'prepare',
        deliveredNotice:policy.delivered_notice||'prepare',exceptionNotice:policy.exception_notice||'prepare',
        connectorId:policy.connector_id||'',businessName:policy.business_name||'',signature:policy.signature||''},
      mailboxes:mailboxRows.rows,canManageSettings:permissions.can(req.user,permissions.ADMIN)});
  }));
  router.post('/fulfilment/settings/notices',requireAuth,requirePermission(permissions.ADMIN,'change customer notices'),asyncRoute(async(req,res)=>{
    const allowed=new Set(['off','prepare','send']);const pick=(value)=>allowed.has(value)?value:'prepare';const at=nowIso();
    await database.query(`INSERT INTO customer_communication_policy(workspace_id,shipping_notice,out_for_delivery_notice,
      delivered_notice,exception_notice,connector_id,business_name,signature,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT(workspace_id) DO UPDATE SET shipping_notice=excluded.shipping_notice,
      out_for_delivery_notice=excluded.out_for_delivery_notice,delivered_notice=excluded.delivered_notice,
      exception_notice=excluded.exception_notice,connector_id=excluded.connector_id,business_name=excluded.business_name,
      signature=excluded.signature,updated_at=excluded.updated_at`,[req.ctx.workspaceId,pick(req.body.shippingNotice),
      pick(req.body.outForDeliveryNotice),pick(req.body.deliveredNotice),pick(req.body.exceptionNotice),
      trimOrNull(req.body.connectorId),trimOrNull(req.body.businessName),trimOrNull(req.body.signature),at]);
    req.flash('success','Customer shipment-message policy saved.');return res.redirect(303,'/fulfilment#customer-notices');
  }));

  router.get('/purchasing',requirePermission(permissions.VIEW_PURCHASING,'see purchasing'),asyncRoute(async(req,res)=>{
    const result=await presenters.purchasing(database,req.ctx.workspaceId);
    return res.page('purchasing/plan',{title:'Purchasing',nav:'purchasing',room:true,...result,postgresQuickEntry:true,
      permissions:{create:permissions.can(req.user,permissions.CREATE_PO),
        receive:permissions.can(req.user,permissions.RECEIVE_PO)}});
  }));

  router.get('/purchasing/orders',requirePermission(permissions.VIEW_PURCHASING,'see purchasing'),asyncRoute(async(req,res)=>{
    const orders=(await commerce.purchaseOrders(database,req.ctx.workspaceId)).map(purchaseOrderForView);
    return res.page('purchasing/orders',{title:'Purchases',nav:'purchasing',room:true,orders:orders.slice(0,200),
      truncated:orders.length>200,view:['late','waiting','open','done'].includes(req.query.view)?req.query.view:'all',
      status:null,statuses:['DRAFT','AWAITING_APPROVAL','APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED'],
      permissions:purchasingPermissions(req)});
  }));
  router.get('/purchasing/receive',requirePermission(permissions.RECEIVE_PO,'book in deliveries'),asyncRoute(async(req,res)=>{
    const supplierName=trimOrNull(req.query.supplier);const all=(await commerce.purchaseOrders(database,req.ctx.workspaceId))
      .filter((row)=>['APPROVED','ORDERED','PARTIALLY_RECEIVED'].includes(row.status)&&Number(row.units_outstanding)>0)
      .map((row)=>({...row,outstanding_units:Number(row.units_outstanding)}));
    const matched=supplierName?all.filter((row)=>row.supplier_name.toLowerCase().includes(supplierName.toLowerCase())):all;
    return res.page('purchasing/receive-pick',{title:'Book in a delivery',nav:'purchasing',orders:matched.length?matched:all,
      supplierName,noMatch:Boolean(supplierName)&&matched.length===0,permissions:purchasingPermissions(req),screenGuide:null});
  }));
  router.get('/purchasing/setup',requirePermission(permissions.VIEW_PURCHASING,'see purchasing'),asyncRoute(async(req,res)=>{
    const [rows,supplierRows]=await Promise.all([planning.position(database,req.ctx.workspaceId),commerce.suppliers(database,req.ctx.workspaceId)]);
    const supplierLinks=(await database.query(`SELECT si.sku_id,s.name AS supplier_name FROM supplier_items si JOIN suppliers s ON s.id=si.supplier_id
      WHERE si.workspace_id=$1 AND si.is_active=1 AND s.status='active' ORDER BY si.is_preferred DESC,lower(s.name)`,[req.ctx.workspaceId])).rows;
    const bySku=new Map();for(const link of supplierLinks){if(!bySku.has(link.sku_id))bySku.set(link.sku_id,[]);bySku.get(link.sku_id).push({supplierName:link.supplier_name});}
    const consolidated=new Map();for(const row of rows){const current=consolidated.get(row.sku_id)||{...row,onHand:0,issuedInWindow:0,policyId:row.policy_id};
      current.onHand+=row.onHand;current.issuedInWindow+=row.sold90;if(row.policy_id)current.policyId=row.policy_id;consolidated.set(row.sku_id,current);}
    const lines=[...consolidated.values()].map((row)=>{const linked=bySku.get(row.sku_id)||[];const proposal={reorderPoint:row.inferredReorder,
      targetStock:Math.max(row.inferredReorder,Math.ceil((row.issuedInWindow/90)*Math.max(30,row.leadTimeDays+14)))};
      return {skuId:row.sku_id,displayName:row.displayName,onHand:row.onHand,issuedInWindow:row.issuedInWindow,windowDays:90,
        proposal,derivedFrom:[{label:'sold in 90 days',value:row.issuedInWindow},{label:'lead time',value:`${row.leadTimeDays} days`}],
        hasSupplier:linked.length>0,suppliers:linked,because:'No outbound history yet.',policyId:row.policyId};});
    const proposals=lines.filter((row)=>!row.policyId&&row.issuedInWindow>0);const blocked=lines.filter((row)=>!row.policyId&&row.issuedInWindow<=0);
    const configured=lines.filter((row)=>row.policyId);const assessment={proposals,blocked,configured,summary:{lines:lines.length,
      canPropose:proposals.length,needHistory:blocked.length,alreadySet:configured.length,withoutSupplier:lines.filter((row)=>!row.hasSupplier).length}};
    return res.page('purchasing/setup',{title:'Set up purchasing',nav:'purchasing',assessment,
      suppliers:supplierRows.map((row)=>supplierForView(row)),canManage:permissions.can(req.user,permissions.MANAGE_REPLENISHMENT),
      canManageSuppliers:permissions.can(req.user,permissions.MANAGE_SUPPLIERS)});
  }));
  router.post('/purchasing/setup/policies',requirePermission(permissions.MANAGE_REPLENISHMENT,'set reorder policies'),asyncRoute(async(req,res)=>{
    const skuIds=Array.isArray(req.body.skuIds)?req.body.skuIds:[req.body.skuIds].filter(Boolean);const rows=await planning.position(database,req.ctx.workspaceId);
    const at=nowIso();for(const skuId of skuIds){const candidates=rows.filter((row)=>row.sku_id===skuId);if(!candidates.length)continue;
      const sold=candidates.reduce((sum,row)=>sum+row.sold90,0);const lead=Math.max(...candidates.map((row)=>row.leadTimeDays));
      const reorder=Math.max(1,Math.ceil((sold/90)*(lead+7)));const target=Math.max(reorder,Math.ceil((sold/90)*(lead+30)));
      const changed=await database.query(`UPDATE reorder_policies SET reorder_point=$3,target_stock=$4,safety_stock=0,
        source='manual',notes='Set from actual 90-day usage',updated_at=$5 WHERE workspace_id=$1 AND sku_id=$2 AND location_id IS NULL`,
      [req.ctx.workspaceId,skuId,reorder,target,at]);
      if(!changed.rowCount)await database.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,
        target_stock,safety_stock,source,notes,created_at,updated_at)
        VALUES($1,$2,$3,NULL,$4,$5,0,'manual','Set from actual 90-day usage',$6,$6)`,
      [newId('rpol'),req.ctx.workspaceId,skuId,reorder,target,at]);}
    req.flash('success',`Reorder points set for ${skuIds.length} line${skuIds.length===1?'':'s'}, derived from actual usage.`);
    return res.redirect(303,'/purchasing/setup');
  }));
  router.post('/purchasing/setup/supplier',requirePermission(permissions.MANAGE_SUPPLIERS,'manage suppliers'),asyncRoute(async(req,res)=>{
    const skuIds=Array.isArray(req.body.skuIds)?req.body.skuIds:[req.body.skuIds].filter(Boolean);let supplierId=trimOrNull(req.body.supplierId);
    if(!supplierId){supplierId=(await commerce.createSupplier(database,req.ctx,{name:req.body.newSupplierName,
      defaultLeadTimeDays:req.body.leadTimeDays})).id;}const at=nowIso();
    for(const skuId of skuIds)await database.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,purchase_unit,
      units_per_purchase_unit,lead_time_days,minimum_order_quantity,is_active,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$9) ON CONFLICT(workspace_id,supplier_id,sku_id) DO UPDATE SET
      purchase_unit=EXCLUDED.purchase_unit,units_per_purchase_unit=EXCLUDED.units_per_purchase_unit,
      lead_time_days=EXCLUDED.lead_time_days,minimum_order_quantity=EXCLUDED.minimum_order_quantity,is_active=1,updated_at=EXCLUDED.updated_at`,
    [newId('supitem'),req.ctx.workspaceId,supplierId,skuId,trimOrNull(req.body.purchaseUnit)||'unit',
      Math.max(1,Number(req.body.unitsPerPurchaseUnit||1)),req.body.leadTimeDays===''?null:Number(req.body.leadTimeDays),
      req.body.minimumOrderQuantity===''?null:Number(req.body.minimumOrderQuantity),at]);
    req.flash('success',`Supplier attached to ${skuIds.length} product line${skuIds.length===1?'':'s'}.`);
    return res.redirect(303,'/purchasing/setup');
  }));
  router.get('/purchasing/orders/:id/receive',requirePermission(permissions.RECEIVE_PO,'book in deliveries'),asyncRoute(async(req,res)=>{
    const [detail,locations]=await Promise.all([commerce.purchaseOrder(database,req.ctx.workspaceId,req.params.id),
      commerce.locations(database,req.ctx.workspaceId)]);
    const order={...detail.order,id:detail.order.id,poNumber:detail.order.po_number,supplierName:detail.order.supplier_name,
      outstandingUnits:detail.lines.reduce((sum,line)=>sum+Math.max(0,Number(line.quantity_units)-Number(line.quantity_received_units)),0)};
    const lines=detail.lines.filter((line)=>Number(line.quantity_received_units)<Number(line.quantity_units)).map((line)=>({
      id:line.id,displayName:line.item_name+(line.variant_label?` / ${line.variant_label}`:''),skuCode:line.code,
      trackingMode:line.tracking_mode,unitLabel:line.unit_label||'unit',purchaseUnit:line.purchase_unit||'unit',
      unitsPerPurchaseUnit:Number(line.units_per_purchase_unit||1),quantityUnits:Number(line.quantity_units),
      quantityReceivedUnits:Number(line.quantity_received_units),
      outstandingUnits:Number(line.quantity_units)-Number(line.quantity_received_units),destinationLocationId:line.destination_location_id}));
    if(!lines.length){req.flash('info','There is nothing outstanding on that order.');return res.redirect(303,`/purchasing/orders/${req.params.id}`);}
    return res.page('purchasing/receive',{title:`Receive ${order.poNumber}`,nav:'purchasing',order,lines,locations,
      warnings:[],overReceipt:null,submitted:null,receiptIdempotencyKey:newId('uireceipt'),sourceEvent:null,
      permissions:purchasingPermissions(req),screenGuide:null});
  }));
  router.get('/purchasing/orders/new',requirePermission(permissions.CREATE_PO,'prepare purchase orders'),asyncRoute(async(req,res)=>{
    const [supplierRows,catalogue,locationRows]=await Promise.all([commerce.suppliers(database,req.ctx.workspaceId),
      commerce.catalogue(database,req.ctx.workspaceId),commerce.locations(database,req.ctx.workspaceId)]);
    const supplierId=trimOrNull(req.query.supplier);
    const suppliers=supplierRows.map((supplier)=>({...supplier,contactName:supplier.contact_name,
      defaultLeadTimeDays:supplier.default_lead_time_days,paymentTerms:supplier.payment_terms}));
    const supplierItems=supplierId?catalogue.map((item)=>({skuId:item.id,displayName:item.display_name,
      supplierSku:null,unitsPerPurchaseUnit:1,purchaseUnit:'unit',lastUnitCost:null})):[];
    return res.page('purchasing/order-new',{title:'New purchase order',nav:'purchasing',suppliers,supplierId,
      supplierItems,locations:locationRows,orderErrors:[],submitted:null});
  }));

  router.post('/purchasing/suppliers',requirePermission(permissions.MANAGE_SUPPLIERS,'add suppliers'),asyncRoute(async(req,res)=>{
    const supplier=await commerce.createSupplier(database,req.ctx,req.body);
    req.flash('success',`${supplier.name} was added.`);
    return res.redirect(303,`/suppliers/${supplier.id}`);
  }));

  router.post('/purchasing/orders',requirePermission(permissions.CREATE_PO,'prepare purchase orders'),asyncRoute(async(req,res)=>{
    const quantities=req.body.quantity&&typeof req.body.quantity==='object'?req.body.quantity:null;
    const costs=req.body.unitCost&&typeof req.body.unitCost==='object'?req.body.unitCost:{};
    const lines=quantities?Object.entries(quantities).filter(([,quantity])=>Number(quantity)>0).map(([skuId,quantity])=>({
      skuId,quantityUnits:quantity,unitCost:costs[skuId],destinationLocationId:req.body.destinationLocationId})):
      [{skuId:req.body.skuId,quantityUnits:req.body.quantity,unitCost:req.body.unitCost,
        destinationLocationId:req.body.destinationLocationId}];
    const result=await workflows.createPurchaseOrder(database,req.ctx,{supplierId:req.body.supplierId,
      orderDate:req.body.orderDate||dateToday(),expectedDate:trimOrNull(req.body.expectedDate),
      destinationLocationId:req.body.destinationLocationId,currency:trimOrNull(req.body.currency)||'USD',
      notes:trimOrNull(req.body.notes),idempotencyKey:key(req,'purchase-order'),lines});
    req.flash('success',`${result.poNumber} was prepared. Nothing was sent to the supplier.`);
    return res.redirect(303,`/purchasing/orders/${result.purchaseOrderId}`);
  }));

  router.get('/purchasing/orders/:id',requirePermission(permissions.VIEW_PURCHASING,'see purchase orders'),asyncRoute(async(req,res)=>{
    const [page,supplierReturns]=await Promise.all([
      purchaseOrderPage(database,req.ctx.workspaceId,req.params.id),
      returns.listSupplierReturns(database,req.ctx.workspaceId,req.params.id),
    ]);
    return res.page('purchasing/order',{title:`${page.order.poNumber} · ${page.order.supplierName}`,nav:'purchasing',room:false,
      screenGuide:null,story:null,evidenceTrace:null,order:page.order,receipts:page.receipts,events:page.events,
      charges:page.charges,documentTotalMinor:null,locations:await commerce.locations(database,req.ctx.workspaceId),
      permissions:purchasingPermissions(req),expectedInFuture:Boolean(page.order.expectedDate&&page.order.expectedDate>dateToday()),
      communications:page.communications,supplierDocuments:page.supplierDocuments,supplierResponsePlans:[],
      supplierBills:page.supplierBills,billSummary:page.billSummary,landedCostDocuments:[],supplierReturns,
      postgresPlacement:true,today:dateToday(),returnFormKey:newId('supplier-return-form')});
  }));

  router.get('/purchasing/orders/:id/document',requirePermission(permissions.VIEW_PURCHASING,'see purchase orders'),asyncRoute(async(req,res)=>{
    const page=await purchaseOrderPage(database,req.ctx.workspaceId,req.params.id);
    return res.render('purchasing/document',{layout:false,title:page.order.poNumber,order:page.order,
      supplier:{name:page.supplier?.name||page.order.supplierName,contactName:page.supplier?.contact_name,
        email:page.supplier?.email,phone:page.supplier?.phone,paymentTerms:page.supplier?.payment_terms},
      businessName:req.ctx.workspaceName||'StockChief inventory'});
  }));

  router.post('/purchasing/orders/:id/prices',requirePermission(permissions.CREATE_PO,'edit draft purchase orders'),asyncRoute(async(req,res)=>{
    const page=await purchaseOrderPage(database,req.ctx.workspaceId,req.params.id);
    if(!page.order.isEditable)throw new ValidationError('Only a draft purchase order can be repriced.');
    const prices=req.body.unitCost&&typeof req.body.unitCost==='object'?req.body.unitCost:{};
    await database.transaction(async(client)=>{
      for(const line of page.order.lines){
        if(!Object.prototype.hasOwnProperty.call(prices,line.id))continue;
        const unitCost=Number(prices[line.id]);
        if(!Number.isFinite(unitCost)||unitCost<0)throw new ValidationError(`Enter a valid cost for ${line.displayName}.`);
        await client.query(`UPDATE purchase_order_lines SET unit_cost=$3,line_total=$3*quantity_units
          WHERE workspace_id=$1 AND id=$2`,[req.ctx.workspaceId,line.id,unitCost]);
      }
    });
    req.flash('success','The purchase order prices are complete.');
    return res.redirect(303,`/purchasing/orders/${req.params.id}`);
  }));

  router.post('/purchasing/orders/:id/receive-all',requirePermission(permissions.RECEIVE_PO,'book in deliveries'),asyncRoute(async(req,res)=>{
    const detail=await commerce.purchaseOrder(database,req.ctx.workspaceId,req.params.id);
    const lines=detail.lines.filter((line)=>Number(line.quantity_received_units)<Number(line.quantity_units)).map((line)=>({
      lineId:line.id,quantity:Number(line.quantity_units)-Number(line.quantity_received_units),locationId:line.destination_location_id}));
    if(!lines.length)throw new ValidationError('There is nothing outstanding on this order.');
    if(lines.some((line)=>!line.locationId))throw new ValidationError('Choose where the delivery arrived before receiving it.');
    if(detail.lines.some((line)=>Number(line.quantity_received_units)<Number(line.quantity_units)&&['lot','serial'].includes(line.tracking_mode)))
      throw new ValidationError('Batch or serial details are required. Use “Something is different” to book this delivery.');
    await workflows.receivePurchaseOrder(database,req.ctx,req.params.id,{idempotencyKey:key(req,'po-receive-all'),
      reference:null,note:null,overReceiptApproved:false,lines});
    req.flash('success','The complete physical delivery was recorded through the inventory ledger.');
    return res.redirect(303,`/purchasing/orders/${req.params.id}`);
  }));

  router.post('/purchasing/orders/:id/cancel',requirePermission(permissions.APPROVE_PO,'cancel purchase orders'),asyncRoute(async(req,res)=>{
    const at=nowIso();
    const changed=await database.query(`UPDATE purchase_orders SET status='CANCELLED',cancel_reason=$3,
      cancelled_by_user_id=$4,cancelled_at=$5,updated_at=$5 WHERE workspace_id=$1 AND id=$2 AND status NOT IN ('RECEIVED','CANCELLED')`,
    [req.ctx.workspaceId,req.params.id,trimOrNull(req.body.reason),req.ctx.actorId,at]);
    if(!changed.rowCount)throw new ValidationError('That purchase order can no longer be cancelled.');
    await database.query(`INSERT INTO purchase_order_events(id,workspace_id,purchase_order_id,event,data,created_at)
      VALUES($1,$2,$3,'cancelled',$4,$5)`,[newId('poevt'),req.ctx.workspaceId,req.params.id,
      JSON.stringify({reason:trimOrNull(req.body.reason)}),at]);
    req.flash('success','Purchase order cancelled. Anything already received remains in inventory.');
    return res.redirect(303,`/purchasing/orders/${req.params.id}`);
  }));

  router.post('/purchasing/orders/:id/returns',
    requirePermission(permissions.AUTHORIZE_SUPPLIER_RETURN,'authorize supplier returns'),asyncRoute(async(req,res)=>{
      const detail=await commerce.purchaseOrder(database,req.ctx.workspaceId,req.params.id);
      const lines=detail.lines.map((line)=>({skuId:line.sku_id,locationId:line.destination_location_id,
        quantity:req.body[`quantity_${line.id}`],lotCode:trimOrNull(req.body[`lot_${line.id}`]),
        serials:String(req.body[`serials_${line.id}`]||'').split(',').map((value)=>value.trim()).filter(Boolean)}))
        .filter((line)=>Number(line.quantity)>0);
      const result=await returns.requestSupplierReturn(database,req.ctx,{supplierId:detail.order.supplier_id,
        supplierBillId:trimOrNull(req.body.supplierBillId),
        expectedCreditMinor:minor(req.body.expectedCredit,'Expected supplier credit'),reason:trimOrNull(req.body.reason),
        lines,idempotencyKey:key(req,'supplier-return-request')});
      req.flash('success',`${result.returnNumber} was requested. Stock and supplier money have not changed.`);
      return res.redirect(303,`/supplier-returns/${result.supplierReturnId}`);
    }));

  router.get('/supplier-returns/:id',requirePermission(permissions.VIEW_PURCHASING,'see supplier returns'),
    asyncRoute(async(req,res)=>{
      const supplierReturn=await returns.getSupplierReturn(database,req.ctx.workspaceId,req.params.id);
      return res.page('purchasing/postgres-supplier-return',{title:supplierReturn.return_number,nav:'purchasing',
        supplierReturn,today:dateToday(),formKey:newId('supplier-return-step')});
    }));

  router.post('/supplier-returns/:id/authorize',
    requirePermission(permissions.AUTHORIZE_SUPPLIER_RETURN,'authorize supplier returns'),asyncRoute(async(req,res)=>{
      await returns.authorizeSupplierReturn(database,req.ctx,req.params.id,{idempotencyKey:key(req,'supplier-return-authorize')});
      req.flash('success','Supplier return authorized. Nothing has left inventory yet.');
      return res.redirect(303,`/supplier-returns/${req.params.id}`);
    }));

  router.post('/supplier-returns/:id/ship',
    requirePermission(permissions.SHIP_SUPPLIER_RETURN,'ship supplier returns'),asyncRoute(async(req,res)=>{
      await returns.shipSupplierReturn(database,req.ctx,req.params.id,{shippedAt:req.body.shippedAt||nowIso(),
        idempotencyKey:key(req,'supplier-return-ship')});
      req.flash('success','Supplier return shipped. Physical stock and inventory value left together; the supplier credit is still outstanding.');
      return res.redirect(303,`/supplier-returns/${req.params.id}`);
    }));

  router.post('/supplier-returns/:id/reconcile',
    requirePermission(permissions.RECONCILE_SUPPLIER_RETURN,'reconcile supplier credits'),asyncRoute(async(req,res)=>{
      const result=await returns.reconcileSupplierReturn(database,req.ctx,req.params.id,{
        amountMinor:minor(req.body.amount,'Supplier credit'),creditNumber:trimOrNull(req.body.creditNumber),
        creditDate:req.body.creditDate||dateToday(),idempotencyKey:key(req,'supplier-return-reconcile')});
      req.flash(result.status==='CREDIT_MISMATCH'?'warn':'success',result.status==='CREDIT_MISMATCH'
        ?'Supplier credit was recorded, but it differs from the expected amount and remains an exception.'
        :'Supplier credit reconciled to the open bill. Inventory did not move again.');
      return res.redirect(303,`/supplier-returns/${req.params.id}`);
    }));

  router.post('/purchasing/orders/:id/approve',requirePermission(permissions.APPROVE_PO,'approve purchase orders'),asyncRoute(async(req,res)=>{
    await workflows.approvePurchaseOrder(database,req.ctx,req.params.id,{idempotencyKey:key(req,'po-approve')});
    req.flash('success','Purchase order approved. It has not been sent yet.');
    return res.redirect(303,`/purchasing/orders/${req.params.id}`);
  }));

  router.post('/purchasing/orders/:id/place',requirePermission(permissions.APPROVE_PO,'place purchase orders'),asyncRoute(async(req,res)=>{
    await workflows.placePurchaseOrder(database,req.ctx,req.params.id,{idempotencyKey:key(req,'po-place'),
      externalReference:trimOrNull(req.body.externalReference)});
    req.flash('success','Supplier placement recorded. Incoming stock changed; on-hand stock did not.');
    return res.redirect(303,`/purchasing/orders/${req.params.id}`);
  }));

  router.post('/purchasing/orders/:id/receive',requirePermission(permissions.RECEIVE_PO,'book in deliveries'),asyncRoute(async(req,res)=>{
    const detail=await commerce.purchaseOrder(database,req.ctx.workspaceId,req.params.id);
    const lines=req.body.lineId?[{lineId:req.body.lineId,quantity:req.body.quantity,locationId:req.body.locationId}]:
      detail.lines.map((line)=>({lineId:line.id,quantity:req.body[`qty_${line.id}`],locationId:req.body[`location_${line.id}`]||line.destination_location_id,
        lotCode:trimOrNull(req.body[`lot_${line.id}`]),expiresAt:trimOrNull(req.body[`expires_${line.id}`]),
        serials:String(req.body[`serials_${line.id}`]||'').split(/[\n,]+/).map((value)=>value.trim()).filter(Boolean)}))
        .filter((line)=>Number(line.quantity)>0);
    if(!lines.length)throw new ValidationError('Say how much of the order physically arrived.');
    await workflows.receivePurchaseOrder(database,req.ctx,req.params.id,{idempotencyKey:key(req,'po-receive'),
      reference:trimOrNull(req.body.reference),note:trimOrNull(req.body.note),
      overReceiptApproved:req.body.overReceiptApproved==='1'||req.body.approveOverReceipt==='1',lines});
    req.flash('success','Physical receipt recorded through the inventory ledger.');
    return res.redirect(303,`/purchasing/orders/${req.params.id}`);
  }));

  router.post('/purchasing/orders/:id/invoices',requirePermission(permissions.MANAGE_ACCOUNTING,'record supplier invoices'),asyncRoute(async(req,res)=>{
    const detail=await commerce.purchaseOrder(database,req.ctx.workspaceId,req.params.id);
    const line=detail.lines.find((candidate)=>candidate.id===req.body.lineId);
    if(!line)throw new ValidationError('Choose a line from this purchase order.');
    const result=await workflows.recordSupplierInvoice(database,req.ctx,{supplierId:detail.order.supplier_id,
      purchaseOrderId:detail.order.id,purchaseReceiptId:trimOrNull(req.body.purchaseReceiptId),
      supplierInvoiceNumber:trimOrNull(req.body.supplierInvoiceNumber),issueDate:req.body.issueDate||dateToday(),
      dueDate:trimOrNull(req.body.dueDate),currency:detail.order.currency,taxMinor:minor(req.body.tax||'0','Tax'),
      idempotencyKey:key(req,'supplier-invoice'),lines:[{purchaseOrderLineId:line.id,skuId:line.sku_id,
        description:line.description,quantity:req.body.quantity,unitCostMinor:minor(req.body.unitCost,'Unit cost')}]});
    req.flash(result.status==='DISPUTED'?'warn':'success',result.status==='DISPUTED'
      ?'Invoice recorded as disputed. No accounting journal was invented.':'Supplier invoice recorded without receiving stock again.');
    return res.redirect(303,`/purchasing/orders/${req.params.id}`);
  }));

  router.post('/purchasing/orders/:id/payments',requirePermission(permissions.RECORD_PAYMENTS,'record supplier payments'),asyncRoute(async(req,res)=>{
    const detail=await commerce.purchaseOrder(database,req.ctx.workspaceId,req.params.id);
    const bill=detail.bills.find((candidate)=>candidate.id===req.body.billId);
    if(!bill)throw new ValidationError('Choose an open bill from this purchase order.');
    await workflows.recordSupplierPayment(database,req.ctx,{supplierId:detail.order.supplier_id,supplierBillId:bill.id,
      amountMinor:minor(req.body.amount,'Payment amount'),paymentDate:req.body.paymentDate||dateToday(),
      currency:bill.currency,method:trimOrNull(req.body.method),reference:trimOrNull(req.body.reference),
      idempotencyKey:key(req,'supplier-payment')});
    req.flash('success','Supplier payment recorded. Physical inventory did not change.');
    return res.redirect(303,`/purchasing/orders/${req.params.id}`);
  }));

  const renderOrders=async(req,res)=>{
    const result=await presenters.sales(database,req.ctx.workspaceId);
    result.view=['stuck','ready','moving','unpaid','done'].includes(req.query.view)?req.query.view:'all';
    return res.page('sales/orders',{title:'Orders',nav:'sales',room:true,...result,postgresQuickEntry:true});
  };
  router.get(['/orders','/sales'],requirePermission(permissions.VIEW_SALES,'see customer orders'),asyncRoute(renderOrders));

  router.get(['/orders/new','/sales/new'],requirePermission(permissions.OPERATE,'create sales orders'),asyncRoute(async(req,res)=>{
    const [customers,catalogue,locations]=await Promise.all([commerce.customers(database,req.ctx.workspaceId),
      commerce.catalogue(database,req.ctx.workspaceId),commerce.locations(database,req.ctx.workspaceId)]);
    const skus=catalogue.map((sku)=>({...sku,price:{isSet:sku.amount_minor!==null,
      formatted:sku.amount_minor===null?'':`${sku.currency||'USD'} ${(Number(sku.amount_minor)/100).toFixed(2)}`},
      stock:{onHand:sku.on_hand,committed:sku.committed,available:sku.available}}));
    return res.page('sales/order-new',{title:'New sales order',nav:'sales',customers,skus,locations,
      form:{customerId:trimOrNull(req.query.customer)||'',deliveryMethod:'SHIP'},formError:null,
      unpricedCount:skus.filter((sku)=>!sku.price.isSet).length,allowNewCustomer:false,screenGuide:null,suppressBack:true});
  }));

  router.get('/sales/customers/new',requirePermission(permissions.OPERATE,'add customers'),(req,res)=>res.page('sales/customer-new',{
    title:'New customer',nav:'sales',form:{name:trimOrNull(req.query.name)||'',email:trimOrNull(req.query.email)||'',
      phone:trimOrNull(req.query.phone)||'',shippingAddress:trimOrNull(req.query.shippingAddress)||''},formError:null,screenGuide:null}));

  router.post('/sales/customers',requirePermission(permissions.OPERATE,'add customers'),asyncRoute(async(req,res)=>{
    const customer=await commerce.createCustomer(database,req.ctx,req.body);
    req.flash('success',`${customer.name} was added.`);
    return res.redirect(303,'/orders');
  }));

  router.post(['/orders','/sales/orders'],requirePermission(permissions.OPERATE,'create sales orders'),asyncRoute(async(req,res)=>{
    const skuIds=Array.isArray(req.body.skuId)?req.body.skuId:[req.body.skuId];
    const quantities=Array.isArray(req.body.quantity)?req.body.quantity:[req.body.quantity];
    const submittedPrices=Array.isArray(req.body.unitPrice)?req.body.unitPrice:[req.body.unitPrice];
    const catalogue=await commerce.catalogue(database,req.ctx.workspaceId);
    const prices=new Map(catalogue.map((sku)=>[sku.id,sku.amount_minor]));
    const lines=skuIds.map((skuId,index)=>({skuId,quantity:quantities[index],unitPriceMinor:
      String(submittedPrices[index]||'').trim()?minor(submittedPrices[index],'Selling price'):prices.get(skuId)}));
    const result=await workflows.createSalesOrder(database,req.ctx,{customerId:req.body.customerId,
      orderDate:req.body.orderDate||dateToday(),neededBy:trimOrNull(req.body.neededBy),
      fulfillmentLocationId:trimOrNull(req.body.fulfillmentLocationId),deliveryMethod:req.body.deliveryMethod||'SHIP',
      shipToAddress:trimOrNull(req.body.shipToAddress||req.body.customerShippingAddress),currency:trimOrNull(req.body.currency)||'USD',
      notes:trimOrNull(req.body.notes),idempotencyKey:key(req,'sales-order'),lines});
    req.flash('success',`${result.orderNumber} was drafted. Stock is not committed until confirmation.`);
    return res.redirect(303,`/orders/${result.salesOrderId}`);
  }));

  router.get(['/orders/:id','/sales/orders/:id'],requirePermission(permissions.VIEW_SALES,'see customer orders'),asyncRoute(async(req,res)=>{
    const [page,returnRows,locationRows]=await Promise.all([
      salesOrderPage(database,req.ctx.workspaceId,req.params.id),
      returns.listCustomerReturns(database,req.ctx.workspaceId,req.params.id),
      commerce.locations(database,req.ctx.workspaceId),
    ]);
    return res.page('sales/order',{title:`${page.order.order_number} · ${page.order.customer.name}`,nav:'sales',room:false,
      suppressBack:true,screenGuide:null,story:null,evidenceTrace:null,order:page.order,shortButAvailable:0,postgresPlacement:true,
      shortageDetails:[],cameFromEmail:null,goneWord:page.order.delivery_method==='PICKUP'?'collected':'shipped',
      accounting:page.accounting,money:page.money,orderNext:null,openSection:['fulfilment','money'].includes(req.query.open)?req.query.open:null,
      shipments:page.shipments,pickable:page.order.delivery_method==='PICKUP'?[]:page.pickable,fulfilment:page.fulfilment,customerNotices:page.customerNotices,
      customerReceipts:page.customerReceipts,paymentRequests:page.paymentRequests,paymentCompleted:req.query.payment==='paid',
      openPaymentUrl:null,paymentProviders:['stripe'],paymentAccount:page.paymentAccount,
      canManagePaymentAccount:req.user?.role==='owner',canSetAllocation:permissions.can(req.user,permissions.OPERATE),
      customers:page.customers,skus:page.skus,carriers:[],returns:returnRows,locations:locationRows,today:dateToday(),
      returnFormKey:newId('return-form'),paymentRequestFormKey:newId('payment-request-form')});
  }));

  router.post(['/orders/:id/returns','/sales/orders/:id/returns'],
    requirePermission(permissions.AUTHORIZE_CUSTOMER_RETURN,'authorize customer returns'),asyncRoute(async(req,res)=>{
      const detail=await commerce.salesOrder(database,req.ctx.workspaceId,req.params.id);
      const lines=detail.lines.map((line)=>({salesOrderLineId:line.id,quantity:req.body[`quantity_${line.id}`]}))
        .filter((line)=>Number(line.quantity)>0);
      const result=await returns.requestCustomerReturn(database,req.ctx,{salesOrderId:req.params.id,
        quarantineLocationId:req.body.quarantineLocationId,resolution:req.body.resolution,
        reason:trimOrNull(req.body.reason),lines,idempotencyKey:key(req,'customer-return-request')});
      req.flash('success',`${result.returnNumber} was requested. No stock or money moved.`);
      return res.redirect(303,`/returns/${result.customerReturnId}`);
    }));

  router.get('/returns/:id',requirePermission(permissions.VIEW_SALES,'see customer returns'),asyncRoute(async(req,res)=>{
    const [customerReturn,locationRows,refundRequestResult]=await Promise.all([
      returns.getCustomerReturn(database,req.ctx.workspaceId,req.params.id),
      commerce.locations(database,req.ctx.workspaceId),
      database.query(`SELECT refund.*,effect.status AS effect_status,effect.error_message AS effect_error_message
        FROM payment_refund_requests refund LEFT JOIN stockchief_runtime.provider_effects effect
          ON effect.workspace_id=refund.workspace_id AND effect.kind='payment.refund.create'
          AND effect.payload->>'refundRequestId'=refund.id
        WHERE refund.workspace_id=$1 AND refund.customer_return_id=$2 ORDER BY refund.created_at DESC LIMIT 1`,
      [req.ctx.workspaceId,req.params.id]),
    ]);
    const refundableMinor=customerReturn.lines.reduce((sum,line)=>sum+
      (line.trackingEvidence.costAllocations||[]).reduce((lineSum,allocation)=>
        lineSum+Number(allocation.quantity)*Number(line.unit_price_minor),0),0);
    return res.page('sales/postgres-return',{title:customerReturn.return_number,nav:'sales',customerReturn,
      locations:locationRows,refundableMinor,refundRequest:refundRequestResult.rows[0]||null,
      today:dateToday(),formKey:newId('return-step')});
  }));

  router.post('/returns/:id/authorize',requirePermission(permissions.AUTHORIZE_CUSTOMER_RETURN,'authorize customer returns'),
    asyncRoute(async(req,res)=>{
      await returns.authorizeCustomerReturn(database,req.ctx,req.params.id,{idempotencyKey:key(req,'customer-return-authorize')});
      req.flash('success','Return authorized. Inventory still has not changed.');
      return res.redirect(303,`/returns/${req.params.id}`);
    }));

  router.post('/returns/:id/receive',requirePermission(permissions.INSPECT_CUSTOMER_RETURN,'receive customer returns'),
    asyncRoute(async(req,res)=>{
      const customerReturn=await returns.getCustomerReturn(database,req.ctx.workspaceId,req.params.id);
      const lines=customerReturn.lines.map((line)=>({lineId:line.id,quantity:req.body[`quantity_${line.id}`],
        lotCode:trimOrNull(req.body[`lot_${line.id}`]),
        serials:String(req.body[`serials_${line.id}`]||'').split(',').map((value)=>value.trim()).filter(Boolean)}))
        .filter((line)=>Number(line.quantity)>0);
      await returns.receiveCustomerReturn(database,req.ctx,req.params.id,{lines,
        idempotencyKey:key(req,'customer-return-receive')});
      req.flash('success','Returned goods received into quarantine. Stock and original product cost were restored together.');
      return res.redirect(303,`/returns/${req.params.id}`);
    }));

  router.post('/returns/:id/inspect',requirePermission(permissions.INSPECT_CUSTOMER_RETURN,'inspect customer returns'),
    asyncRoute(async(req,res)=>{
      const customerReturn=await returns.getCustomerReturn(database,req.ctx.workspaceId,req.params.id);
      const lines=customerReturn.lines.map((line)=>({lineId:line.id,restock:req.body[`restock_${line.id}`],
        scrap:req.body[`scrap_${line.id}`],repair:req.body[`repair_${line.id}`],
        restockLocationId:trimOrNull(req.body[`restockLocation_${line.id}`]),
        repairLocationId:trimOrNull(req.body[`repairLocation_${line.id}`]),
        conditionNote:trimOrNull(req.body[`condition_${line.id}`])}));
      const result=await returns.inspectCustomerReturn(database,req.ctx,req.params.id,{lines,
        idempotencyKey:key(req,'customer-return-inspect')});
      req.flash('success',result.status==='AWAITING_REFUND'
        ?'Inspection recorded. The exact customer refund is ready for approval.'
        :'Inspection and physical disposition completed.');
      return res.redirect(303,`/returns/${req.params.id}`);
    }));

  router.post('/returns/:id/refund',requirePermission(permissions.REFUND_CUSTOMER_RETURN,'approve customer refunds'),
    asyncRoute(async(req,res)=>{
      let result;
      if(req.body.destination==='CASH'){
        const queued=await payments.queueCustomerReturnRefund(database,req.ctx,req.params.id,{provider:'stripe'});
        if(queued.noProviderPayment)result=await returns.refundCustomerReturn(database,req.ctx,req.params.id,
          {destination:'CASH',refundDate:req.body.refundDate||dateToday(),idempotencyKey:key(req,'customer-return-refund')});
        else {req.flash('success',queued.replayed
          ?'That provider refund is already pending or under review. It was not sent twice.'
          :'Refund queued with the original payment provider. Cash and accounting remain unchanged until confirmation.');
          return res.redirect(303,`/returns/${req.params.id}`);}
      }else result=await returns.refundCustomerReturn(database,req.ctx,req.params.id,{destination:'AR',
        refundDate:req.body.refundDate||dateToday(),idempotencyKey:key(req,'customer-return-refund')});
      req.flash('success',`Refund recorded for ${(result.amountMinor/100).toFixed(2)} ${result.destination}. Inventory did not move again.`);
      return res.redirect(303,`/returns/${req.params.id}`);
    }));

  router.post('/returns/:id/exchange',requirePermission(permissions.REFUND_CUSTOMER_RETURN,'approve return exchanges'),
    asyncRoute(async(req,res)=>{
      const customerReturn=await returns.getCustomerReturn(database,req.ctx.workspaceId,req.params.id);
      const lines=customerReturn.lines.map((line)=>({skuId:line.sku_id,quantity:req.body[`quantity_${line.id}`],
        unitPriceMinor:0})).filter((line)=>Number(line.quantity)>0);
      const result=await returns.exchangeCustomerReturn(database,req.ctx,req.params.id,{lines,
        orderDate:req.body.orderDate||dateToday(),fulfillmentLocationId:trimOrNull(req.body.fulfillmentLocationId),
        notes:trimOrNull(req.body.notes),idempotencyKey:key(req,'customer-return-exchange')});
      req.flash('success',`${result.exchangeOrderNumber} was prepared as a zero-price replacement order for review.`);
      return res.redirect(303,`/orders/${result.exchangeOrderId}`);
    }));

  router.post(['/orders/:id/confirm','/sales/orders/:id/confirm'],requirePermission(permissions.OPERATE,'confirm sales orders'),asyncRoute(async(req,res)=>{
    const result=await workflows.confirmSalesOrder(database,req.ctx,req.params.id,{idempotencyKey:key(req,'sales-confirm')});
    req.flash(result.shortage?'warn':'success',result.shortage?'Order confirmed with a real stock shortage.':'Available stock committed to this order.');
    return res.redirect(303,`/orders/${req.params.id}`);
  }));

  router.post(['/orders/:id/fulfill','/sales/orders/:id/fulfill'],requirePermission(permissions.OPERATE,'fulfill sales orders'),asyncRoute(async(req,res)=>{
    const lineIds=Array.isArray(req.body.lineId)?req.body.lineId:[req.body.lineId];
    const locationIds=Array.isArray(req.body.locationId)?req.body.locationId:[req.body.locationId];
    const quantities=Array.isArray(req.body.quantity)?req.body.quantity:[req.body.quantity];
    const lines=lineIds.map((lineId,index)=>({lineId,locationId:locationIds[index]||locationIds[0],quantity:quantities[index]}))
      .filter((line)=>Number(line.quantity)>0);
    await workflows.fulfillSalesOrder(database,req.ctx,req.params.id,{idempotencyKey:key(req,'sales-fulfill'),lines});
    req.flash('success','Fulfillment recorded. Inventory, revenue, COGS and the customer invoice changed together.');
    return res.redirect(303,`/orders/${req.params.id}`);
  }));

  router.post('/sales/orders/:id/pick',requirePermission(permissions.OPERATE,'fulfill sales orders'),asyncRoute(async(req,res)=>{
    const detail=await commerce.salesOrder(database,req.ctx.workspaceId,req.params.id);
    if(detail.order.delivery_method!=='SHIP')throw new ValidationError(
      'Pickup orders do not need a carrier parcel. Use “Record what physically left” when the customer collects it.');
    const lines=detail.lines.flatMap((line)=>line.allocations.map((allocation)=>({lineId:line.id,
      locationId:allocation.location_id,quantity:Number(allocation.quantity)})));
    if(!lines.length)throw new ValidationError('There is no committed stock ready to pick.');
    const locationId=lines[0].locationId;
    if(lines.some((line)=>line.locationId!==locationId))throw new ValidationError(
      'This order is held at more than one location. Prepare one shipment from each location.');
    const result=await shipping.prepare(database,req.ctx,req.params.id,{idempotencyKey:key(req,'shipment-pick'),
      shipFromLocationId:locationId,shipToAddress:detail.order.ship_to_address,lines});
    req.flash('success','Pick list opened. Stock remains committed until the parcel is handed over.');
    return res.redirect(303,`/fulfilment/${result.shipmentId}`);
  }));

  router.post('/sales/orders/:id/allocation-settings',requirePermission(permissions.OPERATE,'change customer allocation priorities'),asyncRoute(async(req,res)=>{
    const priority=Number(req.body.allocationPriority);
    if(!Number.isSafeInteger(priority)||priority<0||priority>1000)throw new ValidationError('Allocation priority must be a whole number from 0 to 1000.');
    const changed=await database.query(`UPDATE sales_orders SET allocation_priority=$3,needed_by=$4,updated_at=$5,version=version+1
      WHERE workspace_id=$1 AND id=$2 AND status NOT IN ('FULFILLED','CANCELLED')`,[req.ctx.workspaceId,req.params.id,
      priority,trimOrNull(req.body.neededBy),nowIso()]);
    if(!changed.rowCount)throw new ValidationError('That completed order can no longer be reprioritized.');
    req.flash('success','Customer allocation priority saved.');
    return res.redirect(303,`/orders/${req.params.id}`);
  }));

  router.post('/sales/orders/:id/lines',requirePermission(permissions.OPERATE,'change sales orders'),asyncRoute(async(req,res)=>{
    const detail=await commerce.salesOrder(database,req.ctx.workspaceId,req.params.id);
    const catalogue=await commerce.catalogue(database,req.ctx.workspaceId);const sku=catalogue.find((row)=>row.id===req.body.skuId);
    if(!sku)throw new ValidationError('Choose an active product from this inventory.');
    const submitted=String(req.body.unitPrice||'').trim();const unitPriceMinor=submitted?minor(submitted,'Selling price'):sku.amount_minor;
    if(unitPriceMinor===null||unitPriceMinor===undefined)throw new ValidationError('Enter the selling price for that product.');
    const desired=detail.lines.map((line)=>({skuId:line.sku_id,quantity:Number(line.quantity_ordered),
      unitPriceMinor:Number(line.unit_price_minor),notes:line.notes}));
    const existing=desired.find((line)=>line.skuId===sku.id);
    if(existing)existing.quantity+=Number(req.body.quantity);else desired.push({skuId:sku.id,quantity:req.body.quantity,unitPriceMinor});
    await workflows.synchronizeSalesOrder(database,req.ctx,req.params.id,{lines:desired,idempotencyKey:key(req,'sales-line')});
    if(detail.order.status!=='DRAFT')await workflows.confirmSalesOrder(database,req.ctx,req.params.id,
      {idempotencyKey:key(req,'sales-line-reallocate')});
    req.flash('success','Product added and available stock recalculated.');
    return res.redirect(303,`/orders/${req.params.id}`);
  }));

  router.post('/sales/orders/:id/cancel',requirePermission(permissions.OPERATE,'cancel sales orders'),asyncRoute(async(req,res)=>{
    await workflows.cancelSalesOrder(database,req.ctx,req.params.id,{reason:trimOrNull(req.body.reason),
      idempotencyKey:key(req,'sales-cancel')});
    req.flash('success','The unfulfilled remainder was cancelled and its committed stock was released.');
    return res.redirect(303,`/orders/${req.params.id}`);
  }));

  router.post(['/orders/:id/shipments','/sales/orders/:id/shipments'],requirePermission(permissions.OPERATE,'prepare shipments'),asyncRoute(async(req,res)=>{
    const result=await shipping.prepare(database,req.ctx,req.params.id,{idempotencyKey:key(req,'shipment-prepare'),
      shipFromLocationId:req.body.locationId,shipToAddress:trimOrNull(req.body.shipToAddress),
      weightGrams:req.body.weightGrams,lines:[{lineId:req.body.lineId,locationId:req.body.locationId,quantity:req.body.quantity}]});
    req.flash('success','Parcel prepared. Stock remains committed until carrier handoff.');
    return res.redirect(303,`/fulfilment/${result.shipmentId}`);
  }));

  router.post(['/orders/:id/payments','/sales/orders/:id/payments'],requirePermission(permissions.RECORD_PAYMENTS,'record customer payments'),asyncRoute(async(req,res)=>{
    const detail=await commerce.salesOrder(database,req.ctx.workspaceId,req.params.id);
    const invoice=detail.invoices.find((candidate)=>candidate.id===req.body.invoiceId);
    if(!invoice)throw new ValidationError('Choose an open invoice from this order.');
    await workflows.recordCustomerPayment(database,req.ctx,{customerId:detail.order.customer_id,
      customerInvoiceId:invoice.id,salesOrderId:detail.order.id,amountMinor:minor(req.body.amount,'Payment amount'),
      paymentDate:req.body.paymentDate||dateToday(),currency:invoice.currency,method:trimOrNull(req.body.method),
      reference:trimOrNull(req.body.reference),idempotencyKey:key(req,'customer-payment')});
    req.flash('success','Customer payment recorded through the same receivables and journal engine.');
    return res.redirect(303,`/orders/${req.params.id}`);
  }));

  router.post('/sales/orders/:id/payment',requirePermission(permissions.RECORD_PAYMENTS,'record customer payments'),asyncRoute(async(req,res)=>{
    const detail=await commerce.salesOrder(database,req.ctx.workspaceId,req.params.id);
    const invoice=detail.invoices.find((candidate)=>['OPEN','PARTIALLY_PAID'].includes(candidate.status));
    if(!invoice)throw new ValidationError('This order has no open customer invoice to pay.');
    await workflows.recordCustomerPayment(database,req.ctx,{customerId:detail.order.customer_id,
      customerInvoiceId:invoice.id,salesOrderId:detail.order.id,amountMinor:minor(req.body.amount,'Payment amount'),
      paymentDate:req.body.paymentDate||dateToday(),currency:invoice.currency,method:trimOrNull(req.body.method),
      reference:trimOrNull(req.body.reference),idempotencyKey:key(req,'customer-payment')});
    req.flash('success','Customer payment recorded through the same receivables and journal engine.');
    return res.redirect(303,`/orders/${req.params.id}?payment=paid&open=money`);
  }));

  router.post(['/orders/:id/payment-requests','/sales/orders/:id/payment-requests'],
    requirePermission(permissions.RECORD_PAYMENTS,'prepare customer payment requests'),asyncRoute(async(req,res)=>{
      const queued=await payments.queueRequest(database,req.ctx,req.params.id,{invoiceId:trimOrNull(req.body.invoiceId),
        purpose:req.body.purpose,provider:req.body.provider,idempotencyKey:key(req,'payment-request')});
      req.flash(queued.request.status==='OPEN'?'success':'success',queued.request.status==='OPEN'
        ?'That secure payment page was already ready. No duplicate request was created.'
        :'Secure payment-page creation queued. The customer has not been sent anything yet.');
      return res.redirect(303,`/orders/${req.params.id}`);
  }));

  router.post('/sales/orders/:id/payment-request',requirePermission(permissions.RECORD_PAYMENTS,'prepare customer payment requests'),
    asyncRoute(async(req,res)=>{
      const detail=await commerce.salesOrder(database,req.ctx.workspaceId,req.params.id);
      const invoice=detail.invoices.find((candidate)=>['OPEN','PARTIALLY_PAID'].includes(candidate.status));
      const queued=await payments.queueRequest(database,req.ctx,req.params.id,{invoiceId:invoice?.id||null,
        purpose:req.body.purpose||'BALANCE',provider:'stripe',idempotencyKey:key(req,'payment-request')});
      req.flash('success',queued.request.status==='OPEN'?'That secure payment page was already ready. No duplicate request was created.':
        'Secure payment-page creation queued. The customer has not been sent anything yet.');
      return res.redirect(303,`/orders/${req.params.id}?open=money`);
    }));

  return router;
}

module.exports={createPostgresCommerceRouter};

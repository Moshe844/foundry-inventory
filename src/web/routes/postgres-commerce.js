'use strict';

const express=require('express');
const commerce=require('../../operations/postgres-commerce');
const workflows=require('../../operations/postgres-business-workflows');
const returns=require('../../operations/postgres-returns');
const shipping=require('../../shipping/postgres-service');
const payments=require('../../payments/postgres-collection');
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

function createPostgresCommerceRouter(database,options={}){
  const router=express.Router();
  router.use(['/purchasing','/orders','/sales'],requireAuth);

  router.get('/purchasing',requirePermission(permissions.VIEW_PURCHASING,'see purchasing'),asyncRoute(async(req,res)=>{
    const [orders,suppliers,catalogue,locations]=await Promise.all([
      commerce.purchaseOrders(database,req.ctx.workspaceId),commerce.suppliers(database,req.ctx.workspaceId),
      commerce.catalogue(database,req.ctx.workspaceId),commerce.locations(database,req.ctx.workspaceId),
    ]);
    return res.page('purchasing/postgres-plan',{title:'Purchasing',nav:'purchasing',orders,suppliers,catalogue,locations,
      today:dateToday()});
  }));

  router.post('/purchasing/suppliers',requirePermission(permissions.MANAGE_SUPPLIERS,'add suppliers'),asyncRoute(async(req,res)=>{
    const supplier=await commerce.createSupplier(database,req.ctx,req.body);
    req.flash('success',`${supplier.name} was added.`);
    return res.redirect(303,'/purchasing');
  }));

  router.post('/purchasing/orders',requirePermission(permissions.CREATE_PO,'prepare purchase orders'),asyncRoute(async(req,res)=>{
    const result=await workflows.createPurchaseOrder(database,req.ctx,{supplierId:req.body.supplierId,
      orderDate:req.body.orderDate||dateToday(),expectedDate:trimOrNull(req.body.expectedDate),
      destinationLocationId:req.body.destinationLocationId,currency:trimOrNull(req.body.currency)||'USD',
      notes:trimOrNull(req.body.notes),idempotencyKey:key(req,'purchase-order'),lines:[{skuId:req.body.skuId,
        quantityUnits:req.body.quantity,unitCost:req.body.unitCost,destinationLocationId:req.body.destinationLocationId}]});
    req.flash('success',`${result.poNumber} was prepared. Nothing was sent to the supplier.`);
    return res.redirect(303,`/purchasing/orders/${result.purchaseOrderId}`);
  }));

  router.get('/purchasing/orders/:id',requirePermission(permissions.VIEW_PURCHASING,'see purchase orders'),asyncRoute(async(req,res)=>{
    const [detail,supplierReturns]=await Promise.all([
      commerce.purchaseOrder(database,req.ctx.workspaceId,req.params.id),
      returns.listSupplierReturns(database,req.ctx.workspaceId,req.params.id),
    ]);
    return res.page('purchasing/postgres-order',{title:detail.order.po_number,nav:'purchasing',...detail,
      supplierReturns,today:dateToday(),returnFormKey:newId('supplier-return-form')});
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
    await workflows.receivePurchaseOrder(database,req.ctx,req.params.id,{idempotencyKey:key(req,'po-receive'),
      reference:trimOrNull(req.body.reference),note:trimOrNull(req.body.note),overReceiptApproved:req.body.overReceiptApproved==='1',
      lines:[{lineId:req.body.lineId,quantity:req.body.quantity,locationId:req.body.locationId}]});
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
    const [orders,customers,catalogue,locations]=await Promise.all([
      commerce.salesOrders(database,req.ctx.workspaceId),commerce.customers(database,req.ctx.workspaceId),
      commerce.catalogue(database,req.ctx.workspaceId),commerce.locations(database,req.ctx.workspaceId),
    ]);
    return res.page('sales/postgres-orders',{title:'Orders',nav:'sales',orders,customers,catalogue,locations,today:dateToday()});
  };
  router.get(['/orders','/sales'],requirePermission(permissions.VIEW_SALES,'see customer orders'),asyncRoute(renderOrders));

  router.post('/sales/customers',requirePermission(permissions.OPERATE,'add customers'),asyncRoute(async(req,res)=>{
    const customer=await commerce.createCustomer(database,req.ctx,req.body);
    req.flash('success',`${customer.name} was added.`);
    return res.redirect(303,'/orders');
  }));

  router.post(['/orders','/sales/orders'],requirePermission(permissions.OPERATE,'create sales orders'),asyncRoute(async(req,res)=>{
    const result=await workflows.createSalesOrder(database,req.ctx,{customerId:req.body.customerId,
      orderDate:req.body.orderDate||dateToday(),neededBy:trimOrNull(req.body.neededBy),
      fulfillmentLocationId:trimOrNull(req.body.fulfillmentLocationId),deliveryMethod:req.body.deliveryMethod||'SHIP',
      shipToAddress:trimOrNull(req.body.shipToAddress),currency:trimOrNull(req.body.currency)||'USD',
      notes:trimOrNull(req.body.notes),idempotencyKey:key(req,'sales-order'),lines:[{skuId:req.body.skuId,
        quantity:req.body.quantity,unitPriceMinor:minor(req.body.unitPrice,'Selling price')}]});
    req.flash('success',`${result.orderNumber} was drafted. Stock is not committed until confirmation.`);
    return res.redirect(303,`/orders/${result.salesOrderId}`);
  }));

  router.get(['/orders/:id','/sales/orders/:id'],requirePermission(permissions.VIEW_SALES,'see customer orders'),asyncRoute(async(req,res)=>{
    const [detail,returnRows,locationRows]=await Promise.all([
      commerce.salesOrder(database,req.ctx.workspaceId,req.params.id),
      returns.listCustomerReturns(database,req.ctx.workspaceId,req.params.id),
      commerce.locations(database,req.ctx.workspaceId),
    ]);
    return res.page('sales/postgres-order',{title:detail.order.order_number,nav:'sales',...detail,
      returns:returnRows,locations:locationRows,today:dateToday(),returnFormKey:newId('return-form'),
      paymentRequestFormKey:newId('payment-request-form')});
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
    await workflows.fulfillSalesOrder(database,req.ctx,req.params.id,{idempotencyKey:key(req,'sales-fulfill'),
      lines:[{lineId:req.body.lineId,locationId:req.body.locationId,quantity:req.body.quantity}]});
    req.flash('success','Fulfillment recorded. Inventory, revenue, COGS and the customer invoice changed together.');
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

  router.post(['/orders/:id/payment-requests','/sales/orders/:id/payment-requests'],
    requirePermission(permissions.RECORD_PAYMENTS,'prepare customer payment requests'),asyncRoute(async(req,res)=>{
      const queued=await payments.queueRequest(database,req.ctx,req.params.id,{invoiceId:trimOrNull(req.body.invoiceId),
        purpose:req.body.purpose,provider:req.body.provider,idempotencyKey:key(req,'payment-request')});
      req.flash(queued.request.status==='OPEN'?'success':'success',queued.request.status==='OPEN'
        ?'That secure payment page was already ready. No duplicate request was created.'
        :'Secure payment-page creation queued. The customer has not been sent anything yet.');
      return res.redirect(303,`/orders/${req.params.id}`);
    }));

  return router;
}

module.exports={createPostgresCommerceRouter};

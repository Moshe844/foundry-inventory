'use strict';

const express=require('express');
const commerce=require('../../operations/postgres-commerce');
const workflows=require('../../operations/postgres-business-workflows');
const returns=require('../../operations/postgres-returns');
const shipping=require('../../shipping/postgres-service');
const payments=require('../../payments/postgres-collection');
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

function createPostgresCommerceRouter(database,options={}){
  const router=express.Router();
  router.use(['/purchasing','/orders','/sales'],requireAuth);

  router.get('/suppliers',requireAuth,requirePermission(permissions.VIEW_PURCHASING,'see suppliers'),asyncRoute(async(req,res)=>{
    const rows=(await database.query(`SELECT s.*,
      COALESCE((SELECT COUNT(*) FROM supplier_items si WHERE si.workspace_id=s.workspace_id AND si.supplier_id=s.id AND si.is_active=1),0)::integer AS item_count,
      COALESCE((SELECT COUNT(*) FROM purchase_orders po WHERE po.workspace_id=s.workspace_id AND po.supplier_id=s.id
        AND po.status IN ('DRAFT','APPROVED','ORDERED','PARTIALLY_RECEIVED')),0)::integer AS open_orders
      FROM suppliers s WHERE s.workspace_id=$1 ORDER BY lower(s.name),s.id`,[req.ctx.workspaceId])).rows;
    const suppliers=rows.map((supplier)=>({id:supplier.id,name:supplier.name,email:supplier.email,
      contactName:supplier.contact_name,defaultLeadTimeDays:supplier.default_lead_time_days,
      itemCount:Number(supplier.item_count),openOrders:Number(supplier.open_orders),isActive:supplier.status==='active'}));
    return res.page('purchasing/suppliers',{title:'Suppliers',nav:'purchasing',suppliers,prefill:null,
      permissions:{suppliers:permissions.can(req.user,permissions.MANAGE_SUPPLIERS),
        create:permissions.can(req.user,permissions.CREATE_PO)}});
  }));
  router.post('/suppliers',requireAuth,requirePermission(permissions.MANAGE_SUPPLIERS,'add suppliers'),asyncRoute(async(req,res)=>{
    const supplier=await commerce.createSupplier(database,req.ctx,req.body);req.flash('success',`${supplier.name} was added.`);
    return res.redirect(303,'/suppliers');
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

  router.get('/purchasing/orders',requirePermission(permissions.VIEW_PURCHASING,'see purchasing'),(req,res)=>res.redirect(302,'/purchasing'));
  router.get('/purchasing/receive',requirePermission(permissions.RECEIVE_PO,'book in deliveries'),(req,res)=>res.redirect(302,'/purchasing'));
  router.get('/purchasing/setup',requirePermission(permissions.VIEW_PURCHASING,'see purchasing'),(req,res)=>res.redirect(302,'/planning'));
  router.get('/purchasing/orders/:id/receive',requirePermission(permissions.RECEIVE_PO,'book in deliveries'),
    (req,res)=>res.redirect(302,`/purchasing/orders/${req.params.id}#receive`));
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
    return res.redirect(303,'/purchasing');
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
      phone:trimOrNull(req.query.phone)||''},formError:null,screenGuide:null}));

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

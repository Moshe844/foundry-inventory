'use strict';

const {AuthorizationError,NotFoundError,ValidationError}=require('../domain/errors');
const {newId,requireText}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const policy=require('../commercial/agent-plan');
const exact=require('../domain/exact-quantity');
const quantities=require('./direct-shipment-quantities');
const addresses=require('../shipping/address');

const path='/autopilot/direct-shipments',action='purchasing.supplier_direct';
const orders='stockchief_runtime.agent_direct_orders',lines='stockchief_runtime.agent_direct_order_lines';
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});

async function owner(db,ctx,lock=false){
  const result=await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId]);
  if(!result.rowCount)throw new AuthorizationError('Only the current inventory owner can arrange supplier-direct deliveries.');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
}

function manualCompletion(state,row){
  return policy.usesAgentTerms(state)&&state.plan==='starter'&&Boolean(row?.committed_at)&&
    ['APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED'].includes(row.purchase_status);
}

async function authorize(db,ctx,{lock=false,automatic=false,existingOrder=null}={}){
  await owner(db,ctx,lock);
  if(lock)await db.query(`SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id
    WHERE w.id=$1 FOR SHARE OF s`,[ctx.workspaceId]);
  if(!automatic&&existingOrder){
    const current=await policy.accountState(db,ctx.workspaceId);
    if(manualCompletion(current,existingOrder)){
      await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'fulfillment.core');
      return {...current,manualCompletion:true};
    }
  }
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,37,automatic?'automatic':'draft');
  const reason=await policy.stopped(db,ctx.workspaceId,state,action,automatic);
  if(reason)throw new ValidationError(reason);
  return state;
}

async function get(db,ctx,id,lock=false){
  const row=(await db.query(`SELECT d.*,p.po_number,p.status AS purchase_status,p.currency,p.delivery_kind,
    s.order_number,s.status AS customer_order_status,s.version AS customer_order_version
    FROM ${orders} d JOIN purchase_orders p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_id
    JOIN sales_orders s ON s.workspace_id=d.workspace_id AND s.id=d.sales_order_id
    WHERE d.workspace_id=$1 AND d.id=$2${lock?' FOR UPDATE OF d,p,s':''}`,[ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That supplier-direct delivery was not found in this inventory.');
  return row;
}

function selected(input){
  if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>100)
    throw new ValidationError('Choose one to 100 exact customer order lines for this supplier.');
  const result=input.lines.map(line=>({lineId:requireText(line.lineId,'Customer order line',{max:120}),
    quantity:exact.canonical(line.quantity),
    secondaryQuantity:line.secondaryQuantity==null||line.secondaryQuantity===''?null:exact.canonical(line.secondaryQuantity)}));
  if(new Set(result.map(line=>line.lineId)).size!==result.length)
    throw new ValidationError('Choose each customer order line once per supplier purchase.');
  return result.sort((a,b)=>a.lineId.localeCompare(b.lineId));
}

async function customerOrder(db,ctx,id){
  const order=(await db.query(`SELECT o.*,c.name AS customer_name,c.record_state AS customer_state,
    c.shipping_address_fields AS customer_address_fields,c.shipping_address AS customer_shipping_address
    FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    WHERE o.workspace_id=$1 AND o.id=$2 FOR UPDATE OF o`,[ctx.workspaceId,id])).rows[0];
  if(!order||!['DRAFT','CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED'].includes(order.status)||order.customer_state!=='ACTIVE')
    throw new ValidationError('Choose an open order for an active customer in this inventory.');
  const addressFields=order.ship_to_address===order.customer_shipping_address?order.customer_address_fields:null;
  if(order.delivery_method!=='SHIP'||!addresses.parse(order.ship_to_address,addressFields).complete||
    Number(order.customer_decision_required)||Number(order.delivery_decision_required))
    throw new ValidationError('Confirm the exact customer and complete delivery address before preparing a supplier-direct order.');
  await require('../sales/agent-order-checks').assertCanRelease(db,ctx.workspaceId,id);
  return {...order,addressFields};
}

async function supplier(db,ctx,id){
  const row=(await db.query("SELECT * FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active' FOR SHARE",
    [ctx.workspaceId,id])).rows[0];
  if(!row)throw new ValidationError('Choose an active supplier from this inventory.');
  return row;
}

async function orderLine(db,ctx,orderId,id,supplierId){
  const row=(await db.query(`SELECT l.*,s.code,s.variant_label,i.name AS item_name,i.unit_label,i.tracking_mode,i.quantity_precision,i.quantity_increment,
    i.secondary_unit_label,i.secondary_precision,i.secondary_increment,si.id AS supplier_item_id,si.supplier_sku,
    si.purchase_unit,si.units_per_purchase_unit,si.minimum_order_quantity,si.order_multiple,si.last_unit_cost
    FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id AND s.is_active=1
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    JOIN supplier_items si ON si.workspace_id=l.workspace_id AND si.sku_id=l.sku_id AND si.supplier_id=$4 AND si.is_active=1
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2 AND l.id=$3 FOR UPDATE OF l FOR SHARE OF s,i,si`,
    [ctx.workspaceId,orderId,id,supplierId])).rows[0];
  if(!row)throw new ValidationError('Each customer line needs an active product and a saved link to this exact supplier.');
  return row;
}

async function prepare(db,ctx,input){
  return db.transaction(async c=>{
    const tx=scoped(c);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['supplier-direct:'+ctx.workspaceId]);
    await authorize(tx,ctx,{lock:true});
    const selection=selected(input),requestKey=requireText(input.requestKey,'Supplier-direct request key',{max:140});
    const requestHash=hash([input.salesOrderId,input.supplierId,selection]);
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that this supplier should deliver these exact goods directly to the customer.');
    const previous=(await c.query(`SELECT id,request_hash FROM ${orders} WHERE workspace_id=$1 AND request_key=$2`,
      [ctx.workspaceId,requestKey])).rows[0];
    if(previous){
      if(previous.request_hash!==requestHash)throw new ValidationError('This saved request has different direct-delivery details. Review the original draft.');
      return {...await get(c,ctx,previous.id),replayed:true};
    }
    const customer=await customerOrder(c,ctx,input.salesOrderId),seller=await supplier(c,ctx,input.supplierId);
    const proposed=[];
    for(const selectionLine of selection){
      const line=await orderLine(c,ctx,customer.id,selectionLine.lineId,seller.id);
      const quote=quantities.claim(line,line,{...line,currency:seller.currency},selectionLine);
      const picked=(await c.query(`SELECT 1 FROM sales_shipment_lines l JOIN sales_shipments s
        ON s.workspace_id=l.workspace_id AND s.id=l.shipment_id WHERE l.workspace_id=$1 AND l.sales_order_line_id=$2
        AND s.status IN ('PICKING','PACKED') LIMIT 1`,[ctx.workspaceId,line.id])).rowCount;
      if(picked)throw new ValidationError('Finish or cancel the existing packed shipment for '+line.code+' before buying it for supplier-direct delivery.');
      proposed.push({line,quote});
    }
    const location=(await c.query(`SELECT id FROM locations WHERE workspace_id=$1 AND is_active=1
      AND custody_agreement_id IS NULL AND ($2::text IS NULL OR id=$2) ORDER BY id LIMIT 1 FOR SHARE`,
      [ctx.workspaceId,customer.fulfillment_location_id])).rows[0];
    if(!location)throw new ValidationError('Choose the business location responsible for this customer order.');
    const id=newId('direct'),facts={supplier:{id:seller.id,name:seller.name,currency:seller.currency,email:seller.email},
      customer:{id:customer.customer_id,name:customer.customer_name,address:customer.ship_to_address,addressFields:customer.addressFields,
        email:customer.contact_email,phone:customer.contact_phone},businessLocationId:location.id,customerOrderVersion:customer.version,
      products:proposed.map(({line,quote})=>({salesOrderLineId:line.id,skuId:line.sku_id,code:line.code,
        name:line.item_name+(line.variant_label?' / '+line.variant_label:''),
        supplierItemId:line.supplier_item_id,supplierSku:line.supplier_sku,quantity:quote.quantity,secondaryQuantity:quote.secondaryQuantity,
        unit:line.unit_label,weightUnit:line.secondary_unit_label,purchaseUnit:line.purchase_unit,unitsPerPurchaseUnit:String(line.units_per_purchase_unit),
        purchaseUnits:quote.purchaseUnits,unitCost:String(line.last_unit_cost),unitCostMinor:quote.unitCostMinor,totalMinor:quote.totalMinor,
        trackingMode:line.tracking_mode,stockProfile:quantities.profileSnapshot(line),customerQuantity:String(line.quantity_ordered),
        customerSecondaryQuantity:line.secondary_quantity_ordered==null?null:String(line.secondary_quantity_ordered),
        customerUnitPriceMinor:Number(line.unit_price_minor),pricingHash:hash(line.pricing_snapshot)}))};
    await require('../commercial/storage-capacity').reserve(tx,ctx.workspaceId,'supplier-direct:'+id,Buffer.byteLength(JSON.stringify(facts))+16384,{finished:true});
    const po=await require('../operations/postgres-business-workflows').createPurchaseOrder(tx,ctx,{
      supplierId:seller.id,currency:seller.currency,destinationLocationId:location.id,idempotencyKey:'direct:'+requestKey,
      source:'instruction',sourceDetail:{kind:'supplier_direct',directOrderId:id,salesOrderId:customer.id},
      reference:customer.order_number,notes:'Supplier delivers directly to the customer on '+customer.order_number+'.',
      lines:facts.products.map(product=>({skuId:product.skuId,quantityUnits:product.quantity,
        quantityPurchaseUnits:product.purchaseUnits,unitsPerPurchaseUnit:product.unitsPerPurchaseUnit,purchaseUnit:product.purchaseUnit,
        unitCost:product.unitCost,secondaryQuantity:product.secondaryQuantity,supplierSku:product.supplierSku}))
    });
    await c.query(`UPDATE purchase_orders SET delivery_kind='CUSTOMER_DIRECT',direct_sales_order_id=$3,destination_location_id=NULL,
      expected_date=NULL,expected_date_source='unknown'
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,po.purchaseOrderId,customer.id]);
    await c.query('UPDATE purchase_order_lines SET destination_location_id=NULL WHERE workspace_id=$1 AND purchase_order_id=$2',
      [ctx.workspaceId,po.purchaseOrderId]);
    await c.query(`INSERT INTO ${orders}(workspace_id,id,sales_order_id,purchase_order_id,prepared_by,request_key,request_hash,facts,source_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[ctx.workspaceId,id,customer.id,po.purchaseOrderId,ctx.actorId,requestKey,requestHash,JSON.stringify(facts),hash(facts)]);
    for(const [index,product] of facts.products.entries()){
      await c.query(`INSERT INTO ${lines}(workspace_id,id,direct_order_id,sales_order_line_id,purchase_order_line_id,quantity,secondary_quantity)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[ctx.workspaceId,newId('directline'),id,product.salesOrderLineId,po.lineIds[index],product.quantity,product.secondaryQuantity]);
    }
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier-direct purchase drafted',reference:id,
      after:{salesOrderId:customer.id,purchaseOrderId:po.purchaseOrderId,supplierId:seller.id}});
    return {...await get(c,ctx,id),replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function purchaseLock(c,ctx){
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('account-purchase:'||owner_account_id,0)) FROM workspaces WHERE id=$1",[ctx.workspaceId]);
  await require('./postgres-purchase-exposure').lock(c,ctx.workspaceId);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['supplier-direct:'+ctx.workspaceId]);
}

async function currentSource(c,ctx,row,{committed=false}={}){
  const customer=await customerOrder(c,ctx,row.sales_order_id),seller=await supplier(c,ctx,row.facts.supplier.id);
  if(seller.currency!==row.currency||seller.email!==row.facts.supplier.email||
    customer.customer_id!==row.facts.customer.id||customer.ship_to_address!==row.facts.customer.address||
    hash(customer.addressFields)!==hash(row.facts.customer.addressFields))
    throw new ValidationError('The customer destination, supplier contact or purchase currency changed. Prepare the direct purchase again.');
  const purchased=(await c.query('SELECT * FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2 ORDER BY line_number,id FOR UPDATE',
    [ctx.workspaceId,row.purchase_order_id])).rows;
  if(purchased.length!==row.facts.products.length)throw new ValidationError('The supplier purchase lines changed after review.');
  const sources=[];
  for(const [index,product] of row.facts.products.entries()){
    const line=await orderLine(c,ctx,customer.id,product.salesOrderLineId,seller.id),poLine=purchased[index];
    const unpromised=committed?{...line,direct_committed_quantity:exact.subtract(line.direct_committed_quantity,product.quantity),
      direct_committed_secondary_quantity:exact.subtract(line.direct_committed_secondary_quantity,product.secondaryQuantity??0)}:line;
    const quote=quantities.claim(unpromised,line,{...line,currency:seller.currency},{quantity:product.quantity,secondaryQuantity:product.secondaryQuantity});
    if(line.sku_id!==product.skuId||line.supplier_item_id!==product.supplierItemId||line.purchase_unit!==product.purchaseUnit||
      line.supplier_sku!==product.supplierSku||hash(quantities.profileSnapshot(line))!==hash(product.stockProfile)||
      exact.canonical(line.last_unit_cost)!==exact.canonical(product.unitCost)||
      exact.canonical(line.units_per_purchase_unit)!==exact.canonical(product.unitsPerPurchaseUnit)||
      String(line.quantity_ordered)!==product.customerQuantity||
      (line.secondary_quantity_ordered==null?null:String(line.secondary_quantity_ordered))!==product.customerSecondaryQuantity||
      Number(line.unit_price_minor)!==product.customerUnitPriceMinor||hash(line.pricing_snapshot)!==product.pricingHash||
      poLine.sku_id!==product.skuId||Number(poLine.quantity_units)!==product.quantity||
      exact.canonical(poLine.unit_cost)!==exact.canonical(product.unitCost)||Number(poLine.units_per_purchase_unit)!==Number(product.unitsPerPurchaseUnit)||
      (poLine.secondary_quantity_ordered==null?null:Number(poLine.secondary_quantity_ordered))!==product.secondaryQuantity||
      quote.purchaseUnits!==product.purchaseUnits||quote.totalMinor!==product.totalMinor)
      throw new ValidationError('The customer quantity, supplier price, pack or agreed selling terms changed for '+product.code+'. Prepare a new direct purchase.');
    const activePick=(await c.query(`SELECT 1 FROM sales_shipment_lines l JOIN sales_shipments s
      ON s.workspace_id=l.workspace_id AND s.id=l.shipment_id WHERE l.workspace_id=$1 AND l.sales_order_line_id=$2
      AND s.status IN ('PICKING','PACKED') LIMIT 1`,[ctx.workspaceId,line.id])).rowCount;
    if(activePick)throw new ValidationError('Finish or cancel the existing warehouse pick for '+product.code+' before placing its supplier-direct order.');
    sources.push({line,quote,product,purchaseLine:poLine});
  }
  return {customer,seller,sources};
}

async function commitCustomerPromises(c,ctx,row,current,input){
  const ids=current.sources.map(source=>source.line.id);
  const held=(await c.query(`SELECT id FROM sales_order_allocations WHERE workspace_id=$1 AND sales_order_line_id=ANY($2::text[])
    UNION ALL SELECT a.id FROM sales_order_kit_allocations a JOIN sales_order_kit_components k ON k.workspace_id=a.workspace_id AND k.id=a.kit_component_id
    WHERE a.workspace_id=$1 AND k.sales_order_line_id=ANY($2::text[])`,[ctx.workspaceId,ids])).rows;
  if(held.length&&input.releaseReserved!=='yes')
    throw new ValidationError('Confirm releasing the selected products’ local reservations before promising them to the supplier. Remaining local quantities will be reserved again.');
  await c.query('DELETE FROM sales_order_allocations WHERE workspace_id=$1 AND sales_order_line_id=ANY($2::text[])',[ctx.workspaceId,ids]);
  await c.query(`DELETE FROM sales_order_kit_allocations a USING sales_order_kit_components k WHERE a.workspace_id=$1
    AND k.workspace_id=a.workspace_id AND k.id=a.kit_component_id AND k.sales_order_line_id=ANY($2::text[])`,[ctx.workspaceId,ids]);
  for(const {line,quote} of current.sources){
    await c.query(`UPDATE sales_order_lines SET direct_committed_quantity=direct_committed_quantity+$3,
      direct_committed_secondary_quantity=direct_committed_secondary_quantity+$4 WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,line.id,quote.quantity,quote.secondaryQuantity??0]);
  }
  await require('../operations/postgres-business-workflows').confirmSalesOrderInTransaction(c,ctx,row.sales_order_id,
    {idempotencyKey:'direct-confirm:'+row.id});
}

async function approve(db,ctx,id,input,{automatic=false,ruleId=null}={}){
  return db.transaction(async c=>{
    const tx=scoped(c);
    const state=await authorize(tx,ctx,{lock:true,automatic});
    await purchaseLock(c,ctx);
    const row=await get(c,ctx,id,true);
    const replay=row.committed_at&&row.purchase_status==='APPROVED'&&Number(input.revision)===row.revision-1;
    if(input.confirmed!=='yes'||Number(input.revision)!==row.revision&&!replay||input.sourceHash!==row.source_hash)
      throw new ValidationError('Review this exact supplier purchase and customer destination before approving.');
    if(row.committed_at&&row.purchase_status==='APPROVED')return {...row,replayed:true};
    if(row.purchase_status!=='DRAFT')throw new ValidationError('Only the current direct purchase draft can be approved.');
    if(input.routine==='yes')await authorize(tx,ctx,{automatic:true});
    const current=await currentSource(c,ctx,row);
    if(automatic){
      await require('./direct-shipment-routines').assertPurchase(c,ctx,row,ruleId,state);
    }else if(input.routine==='yes'){
      await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    }
    await commitCustomerPromises(c,ctx,row,current,input);
    const granted=require('./direct-shipment-authority').context(ctx,row.purchase_order_id,'approve');
    await require('../operations/postgres-business-workflows').approvePurchaseOrder(tx,granted,row.purchase_order_id,
      {idempotencyKey:'direct-approve:'+row.id});
    await c.query(`UPDATE ${orders} SET committed_at=clock_timestamp(),committed_by=$3,routine=$4,revision=revision+1,
      automatic_purchase=$5,rule_id=$6 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId,input.routine==='yes',automatic,ruleId]);
    if(automatic)await require('./direct-shipment-routines').recordPurchase(c,ctx,row,ruleId);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier-direct purchase approved',reference:id,
      after:{purchaseOrderId:row.purchase_order_id,salesOrderId:row.sales_order_id,routine:input.routine==='yes'}});
    return {...await get(c,ctx,id),replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function place(db,ctx,id,input){
  return db.transaction(async c=>{
    const existing=await get(c,ctx,id);
    await authorize(scoped(c),ctx,{lock:true,existingOrder:existing});
    await purchaseLock(c,ctx);
    const row=await get(c,ctx,id,true);
    if(input.confirmed!=='yes'||input.sentExternally!=='yes'||Number(input.revision)!==row.revision||input.sourceHash!==row.source_hash)
      throw new ValidationError('Confirm that you sent this exact supplier purchase, including the customer destination, outside StockChief.');
    const reference=requireText(input.externalReference,'Evidence of the purchase sent to the supplier',{max:500});
    if(row.purchase_status==='ORDERED')return {...row,replayed:true};
    if(row.purchase_status!=='APPROVED')throw new ValidationError('Approve this customer’s supplier-direct purchase before placing it.');
    await currentSource(c,ctx,row,{committed:true});
    const granted=require('./direct-shipment-authority').context(ctx,row.purchase_order_id,'place');
    await require('../operations/postgres-business-workflows').placePurchaseOrder(scoped(c),granted,row.purchase_order_id,
      {idempotencyKey:'direct-place:'+row.id,externalReference:reference});
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier-direct purchase sent outside StockChief confirmed',reference:id,
      after:{purchaseOrderId:row.purchase_order_id,evidence:reference}});
    await c.query(`UPDATE ${orders} SET revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
    return {...await get(c,ctx,id),replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

function shipmentTime(value,orderDate){
  const text=String(value||'').trim(),time=new Date(text);
  const day=new Date(text.slice(0,10)+'T00:00:00Z');
  const dated=/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(text);
  if(!dated||!Number.isFinite(day.getTime())||day.toISOString().slice(0,10)!==text.slice(0,10)||
    !Number.isFinite(time.getTime())||time.getTime()>Date.now()||
    time.toISOString().slice(0,10)<String(orderDate).slice(0,10))
    throw new ValidationError('Record the actual time the supplier shipped, on or after the purchase date and before now.');
  return time.toISOString();
}

async function dispatchLines(c,ctx,row){
  return (await c.query(`SELECT d.*,p.sku_id,p.unit_cost,p.quantity_units,p.quantity_received_units,
    p.secondary_quantity_ordered,p.secondary_quantity_received,i.unit_label,i.tracking_mode,i.quantity_precision,i.quantity_increment,
    i.secondary_unit_label,i.secondary_precision,i.secondary_increment
    FROM ${lines} d JOIN purchase_order_lines p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_line_id
    JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE d.workspace_id=$1 AND d.direct_order_id=$2 ORDER BY d.id FOR UPDATE OF d,p FOR SHARE OF i`,[ctx.workspaceId,row.id])).rows;
}

async function captureInTransaction(c,ctx,id,input,{supplierLink=false}={}){
  const existing=await get(c,ctx,id);
  await authorize(scoped(c),ctx,{lock:true,existingOrder:existing});
  const row=await get(c,ctx,id,true);
  if(!supplierLink&&input.actualShipment!=='yes')throw new ValidationError('Confirm that the supplier has actually shipped these goods.');
  const po=(await c.query('SELECT order_date FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,row.purchase_order_id])).rows[0];
  const shippedAt=shipmentTime(input.shippedAt,po.order_date),supplierReference=quantities.identifiers(input.supplierReference,'supplier dispatch reference');
  const prior=(await c.query(`SELECT * FROM stockchief_runtime.agent_direct_dispatches
    WHERE workspace_id=$1 AND direct_order_id=$2 AND supplier_reference=$3 FOR UPDATE`,[ctx.workspaceId,id,supplierReference])).rows[0];
  if(!prior&&!['ORDERED','PARTIALLY_RECEIVED'].includes(row.purchase_status))
    throw new ValidationError('The supplier-direct purchase must be placed before recording goods actually dispatched.');
  const carrier=quantities.identifiers(input.carrier,'carrier name',200),trackingNumber=quantities.identifiers(input.trackingNumber,'tracking number');
  if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>100||new Set(input.lines.map(line=>line.lineId)).size!==input.lines.length)
    throw new ValidationError('Record one to 100 distinct lines actually shipped by this supplier.');
  const available=await dispatchLines(c,ctx,row),verified=[];
  for(const requested of input.lines){
    const line=available.find(line=>line.id===requested.lineId);
    if(!line)throw new ValidationError('Each dispatch line must belong to this exact supplier purchase.');
    const open={quantity:prior?line.quantity:exact.subtract(line.quantity,line.dispatched_quantity),
      secondary:line.secondary_quantity==null?null:prior?line.secondary_quantity:exact.subtract(line.secondary_quantity,line.dispatched_secondary_quantity)};
    const detail=quantities.dispatch(line,requested,open,shippedAt.slice(0,10));
    const costMinor=exact.costMinor(detail.secondaryQuantity??detail.quantity,require('../domain/currency').userToMinor(String(line.unit_cost),row.currency));
    verified.push({lineId:line.id,...detail,costMinor});
  }
  verified.sort((a,b)=>a.lineId.localeCompare(b.lineId));
  const original={shippedAt,supplierReference,carrier,trackingNumber,lines:verified};
  if(prior){
    if(hash(prior.original)!==hash(original))throw new ValidationError('This supplier dispatch reference already has different saved shipping evidence.');
    return {...prior,replayed:true};
  }
  const dispatchId=newId('directdispatch');
  await require('../commercial/storage-capacity').reserve(scoped(c),ctx.workspaceId,'supplier-direct-dispatch:'+dispatchId,
    Buffer.byteLength(JSON.stringify(original))+16384,{finished:true});
  await c.query(`INSERT INTO stockchief_runtime.agent_direct_dispatches(workspace_id,id,direct_order_id,supplier_reference,source_kind,original)
    VALUES($1,$2,$3,$4,$5,$6)`,[ctx.workspaceId,dispatchId,id,supplierReference,supplierLink?'SUPPLIER_LINK':'OWNER',JSON.stringify(original)]);
  for(const line of verified)await c.query(`INSERT INTO stockchief_runtime.agent_direct_dispatch_lines
    (workspace_id,id,dispatch_id,direct_order_line_id,quantity,secondary_quantity,tracking,cost_minor)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[ctx.workspaceId,newId('directdispatchline'),dispatchId,line.lineId,line.quantity,
    line.secondaryQuantity,JSON.stringify({lots:line.lots,serials:line.serials}),line.costMinor]);
  return {...(await c.query('SELECT * FROM stockchief_runtime.agent_direct_dispatches WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,dispatchId])).rows[0],replayed:false};
}

async function capture(db,ctx,id,input){
  return db.transaction(c=>captureInTransaction(c,ctx,id,input),{isolation:'SERIALIZABLE',retrySafe:true});
}

async function applyDispatch(db,ctx,id,input,{automatic=false}={}){
  return db.transaction(async c=>{
    const tx=scoped(c);
    const source=(await c.query(`SELECT direct_order_id FROM stockchief_runtime.agent_direct_dispatches WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,id])).rows[0];
    const existing=source?await get(c,ctx,source.direct_order_id):null;
    await authorize(tx,ctx,{lock:true,automatic,existingOrder:existing});
    const dispatch=(await c.query(`SELECT * FROM stockchief_runtime.agent_direct_dispatches
      WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,id])).rows[0];
    if(!dispatch)throw new NotFoundError('That supplier dispatch was not found in this inventory.');
    const row=await get(c,ctx,dispatch.direct_order_id,true);
    if(automatic&&dispatch.state==='APPLIED')return {...dispatch,replayed:true};
    if(automatic&&(!row.routine||dispatch.source_kind!=='SUPPLIER_LINK'))
      throw new ValidationError('Automatic direct fulfillment needs an authorized supplier link and the owner’s current routine-delivery permission.');
    if(automatic&&row.rule_id){
      const routines=require('./direct-shipment-routines');
      await routines.active(c,ctx,await routines.rule(c,ctx,row.rule_id,{lock:true}));
    }
    const replay=dispatch.state==='APPLIED'&&Number(input.revision)===dispatch.revision-1;
    if(!automatic&&(input.confirmed!=='yes'||Number(input.revision)!==dispatch.revision&&!replay||input.evidenceHash!==hash(dispatch.original)))
      throw new ValidationError('Review the exact supplier quantities, actual shipping time, carrier and tracking before recording this shipment.');
    if(dispatch.state==='APPLIED')return {...dispatch,replayed:true};
    if(dispatch.state!=='REVIEW'||!['ORDERED','PARTIALLY_RECEIVED'].includes(row.purchase_status))
      throw new ValidationError('Only an active supplier purchase with an unrecorded dispatch can be fulfilled.');
    const customer=await customerOrder(c,ctx,row.sales_order_id);
    if(customer.customer_id!==row.facts.customer.id||customer.ship_to_address!==row.facts.customer.address||
      hash(customer.addressFields)!==hash(row.facts.customer.addressFields))
      throw new ValidationError('The customer destination changed after this supplier purchase was sent. Confirm its delivery amendment before recording dispatch.');
    shipmentTime(dispatch.original.shippedAt,(await c.query('SELECT order_date FROM purchase_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,row.purchase_order_id])).rows[0].order_date);
    const available=await dispatchLines(c,ctx,row);
    const captured=(await c.query(`SELECT * FROM stockchief_runtime.agent_direct_dispatch_lines
      WHERE workspace_id=$1 AND dispatch_id=$2 ORDER BY id FOR UPDATE`,[ctx.workspaceId,id])).rows;
    const receiptId=newId('poreceipt'),at=new Date().toISOString();
    await c.query(`INSERT INTO purchase_order_receipts(id,workspace_id,purchase_order_id,idempotency_key,received_by_user_id,
      received_at,reference,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[receiptId,ctx.workspaceId,row.purchase_order_id,
      'supplier-direct:'+id,ctx.actorId,dispatch.original.shippedAt,dispatch.supplier_reference,'Supplier dispatched directly to the customer.',at]);
    await c.query(`UPDATE stockchief_runtime.agent_direct_dispatches SET purchase_receipt_id=$3 WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,id,receiptId]);
    const granted=require('./direct-shipment-authority').context(ctx,row.purchase_order_id,'fulfill',id);
    const result=await require('../operations/postgres-business-workflows').fulfillSalesOrderInTransaction(c,granted,row.sales_order_id,{
      idempotencyKey:'supplier-direct:'+id,fulfilledAt:dispatch.original.shippedAt,
      lines:captured.map(line=>({lineId:available.find(open=>open.id===line.direct_order_line_id).sales_order_line_id,
        quantity:line.quantity,secondaryQuantity:line.secondary_quantity,locationId:row.facts.businessLocationId})),
      shipment:{handover:'CARRIER',carrier:dispatch.original.carrier,trackingNumber:dispatch.original.trackingNumber,shippedAt:dispatch.original.shippedAt}
    });
    for(const line of captured){
      const source=available.find(open=>open.id===line.direct_order_line_id);
      await c.query(`UPDATE ${lines} SET dispatched_quantity=dispatched_quantity+$3,
        dispatched_secondary_quantity=dispatched_secondary_quantity+$4 WHERE workspace_id=$1 AND id=$2`,
        [ctx.workspaceId,source.id,line.quantity,line.secondary_quantity??0]);
      await c.query(`UPDATE purchase_order_lines SET quantity_received_units=quantity_received_units+$3,
        secondary_quantity_received=secondary_quantity_received+$4 WHERE workspace_id=$1 AND id=$2`,
        [ctx.workspaceId,source.purchase_order_line_id,line.quantity,line.secondary_quantity??0]);
      await c.query(`INSERT INTO purchase_order_receipt_lines(id,workspace_id,receipt_id,purchase_order_line_id,sku_id,quantity_units,
        secondary_quantity,created_at,direct_dispatch_line_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newId('porline'),ctx.workspaceId,receiptId,source.purchase_order_line_id,source.sku_id,line.quantity,line.secondary_quantity,at,line.id]);
    }
    const open=(await c.query(`SELECT 1 FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2
      AND quantity_received_units<quantity_units LIMIT 1`,[ctx.workspaceId,row.purchase_order_id])).rowCount;
    await c.query(`UPDATE purchase_orders SET status=$3,updated_at=$4,completed_at=CASE WHEN $3='RECEIVED' THEN $4 ELSE completed_at END
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.purchase_order_id,open?'PARTIALLY_RECEIVED':'RECEIVED',at]);
    await c.query('UPDATE purchase_order_receipts SET result=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,receiptId,
      JSON.stringify({supplierDirect:true,dispatchId:id,shipmentId:result.shipments[0].shipmentId,lines:result.lines})]);
    await c.query(`UPDATE stockchief_runtime.agent_direct_dispatches SET state='APPLIED',confirmed_by=$3,automatic=$4,shipment_id=$5,last_issue=NULL,
      revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId,automatic,result.shipments[0].shipmentId]);
    await c.query(`UPDATE ${orders} SET revision=revision+1,routine=CASE WHEN $3 THEN routine ELSE false END
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,Boolean(open)]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier-direct shipment recorded',reference:id,
      after:{purchaseOrderId:row.purchase_order_id,salesOrderId:row.sales_order_id,receiptId,shipmentId:result.shipments[0].shipmentId,
        invoiceId:result.invoiceId,automatic}});
    return {...result,dispatchId:id,receiptId,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function stop(db,ctx,id,input){
  return db.transaction(async c=>{
    await owner(c,ctx,true);
    await purchaseLock(c,ctx);
    const row=await get(c,ctx,id,true);
    if(input.confirmed!=='yes'||Number(input.revision)!==row.revision||row.committed_at&&input.supplierStopped!=='yes')
      throw new ValidationError('Confirm with the supplier that the remaining direct delivery has stopped before releasing its customer promises.');
    const reason=requireText(input.reason,'Supplier cancellation evidence',{max:1000});
    const pending=(await c.query(`SELECT e.id,e.status,m.id AS message_id,m.status AS message_status
      FROM stockchief_runtime.provider_effects e JOIN supplier_communications m ON m.workspace_id=e.workspace_id AND m.id=e.aggregate_id
      WHERE e.workspace_id=$1 AND e.kind='mail.outbound.send' AND m.idempotency_key=$2 FOR UPDATE OF e,m`,
      [ctx.workspaceId,'supplier-direct-purchase:'+id])).rows[0];
    if(pending&&(['RUNNING','AMBIGUOUS'].includes(pending.status)||pending.message_status==='SENDING'))
      throw new ValidationError('This purchase email is still being sent or needs delivery review. Confirm its outcome and the supplier’s cancellation before stopping the delivery.');
    if(pending?.status==='PENDING'){
      await c.query("UPDATE stockchief_runtime.provider_effects SET status='CANCELLED',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId,pending.id]);
      await c.query("UPDATE supplier_communications SET status='CANCELLED',updated_at=clock_timestamp()::text WHERE workspace_id=$1 AND id=$2 AND status='QUEUED'",
        [ctx.workspaceId,pending.message_id]);
    }
    const granted=require('./direct-shipment-authority').context(ctx,row.purchase_order_id,'cancel');
    await require('../operations/postgres-business-workflows').cancelPurchaseOrder(scoped(c),granted,row.purchase_order_id,
      {idempotencyKey:'supplier-direct-stop:'+id,reason});
    await c.query(`UPDATE ${orders} SET routine=false,stopped_at=clock_timestamp(),revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
    if(row.committed_at){
      for(const line of await dispatchLines(c,ctx,row))await c.query(`UPDATE sales_order_lines
        SET direct_committed_quantity=direct_committed_quantity-$3,direct_committed_secondary_quantity=direct_committed_secondary_quantity-$4
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,line.sales_order_line_id,exact.subtract(line.quantity,line.dispatched_quantity),
        line.secondary_quantity==null?0:exact.subtract(line.secondary_quantity,line.dispatched_secondary_quantity)]);
      await require('../operations/postgres-business-workflows').confirmSalesOrderInTransaction(c,ctx,row.sales_order_id,
        {idempotencyKey:'supplier-direct-stop-confirm:'+id});
    }
    await c.query(`UPDATE stockchief_runtime.agent_direct_dispatches SET state='STOPPED',revision=revision+1
      WHERE workspace_id=$1 AND direct_order_id=$2 AND state='REVIEW'`,[ctx.workspaceId,id]);
    return {...await get(c,ctx,id),replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function page(db,ctx,{id=null,orderId=null,supplierId=null,page=1}={}){
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId);
  const allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,37,'draft');
  page=Number(page);
  if(!Number.isSafeInteger(page)||page<1||page>10000)throw new ValidationError('Choose a valid direct-delivery page.');
  const rows=(await db.query(`SELECT d.id,p.po_number,p.status,s.order_number,c.name AS customer_name,v.name AS supplier_name
    FROM ${orders} d JOIN purchase_orders p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_id
    JOIN sales_orders s ON s.workspace_id=d.workspace_id AND s.id=d.sales_order_id
    JOIN customers c ON c.workspace_id=s.workspace_id AND c.id=s.customer_id
    JOIN suppliers v ON v.workspace_id=p.workspace_id AND v.id=p.supplier_id
    WHERE d.workspace_id=$1 ORDER BY d.created_at DESC,d.id LIMIT 101 OFFSET $2`,[ctx.workspaceId,(page-1)*100])).rows;
  const selected=id?await get(db,ctx,id):null;
  const purchaseMail=selected?(await db.query(`SELECT id,status,error_message,sent_at FROM supplier_communications
    WHERE workspace_id=$1 AND idempotency_key=$2`,[ctx.workspaceId,'supplier-direct-purchase:'+selected.id])).rows[0]:null;
  const routine=selected?(await db.query('SELECT * FROM stockchief_runtime.agent_direct_rules WHERE workspace_id=$1 AND reference_order_id=$2',
    [ctx.workspaceId,id])).rows[0]:null;
  const selectedLines=selected?(await db.query(`SELECT d.*,s.code,i.name,i.unit_label,i.secondary_unit_label FROM ${lines} d
    JOIN purchase_order_lines p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_line_id
    JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE d.workspace_id=$1 AND d.direct_order_id=$2 ORDER BY p.line_number,d.id`,[ctx.workspaceId,id])).rows:[];
  const dispatches=selected?(await db.query(`SELECT x.*,s.shipment_number,i.invoice_number,i.id AS invoice_id
    FROM stockchief_runtime.agent_direct_dispatches x LEFT JOIN sales_shipments s ON s.workspace_id=x.workspace_id AND s.id=x.shipment_id
    LEFT JOIN accounting_customer_invoices i ON i.workspace_id=x.workspace_id AND i.sales_order_id=$3
    WHERE x.workspace_id=$1 AND x.direct_order_id=$2 ORDER BY x.created_at DESC,x.id LIMIT 101`,[ctx.workspaceId,id,selected.sales_order_id])).rows:[];
  const choices=allowed&&!selected?(await db.query(`SELECT o.id,o.order_number,c.name FROM sales_orders o
    JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    WHERE o.workspace_id=$1 AND o.status IN ('DRAFT','CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
    AND o.delivery_method='SHIP' AND c.record_state='ACTIVE' ORDER BY o.created_at DESC,o.id LIMIT 201`,[ctx.workspaceId])).rows:[];
  const suppliers=allowed&&!selected?(await db.query("SELECT id,name FROM suppliers WHERE workspace_id=$1 AND status='active' ORDER BY name,id LIMIT 201",
    [ctx.workspaceId])).rows:[];
  const customer=allowed&&!selected&&orderId?(await db.query(`SELECT o.*,c.name AS customer_name FROM sales_orders o
    JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id WHERE o.workspace_id=$1 AND o.id=$2`,[ctx.workspaceId,orderId])).rows[0]:null;
  const products=customer&&supplierId?(await db.query(`SELECT l.*,s.code,i.name,i.unit_label,i.secondary_unit_label,
    si.units_per_purchase_unit,si.purchase_unit,si.last_unit_cost,v.currency
    FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id JOIN supplier_items si ON si.workspace_id=l.workspace_id
    AND si.sku_id=l.sku_id AND si.supplier_id=$3 AND si.is_active=1
    JOIN suppliers v ON v.workspace_id=si.workspace_id AND v.id=si.supplier_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2 AND l.quantity_ordered>l.quantity_fulfilled+l.direct_committed_quantity
    ORDER BY l.created_at,l.id LIMIT 101`,[ctx.workspaceId,orderId,supplierId])).rows:[];
  return {allowed,canComplete:allowed||manualCompletion(state,selected),canAutomate:allowed&&policy.permits(state.plan,37,'automatic'),plan:state.plan,shadow:state.shadow,
    page,rows:rows.slice(0,100),more:rows.length>100,selected,selectedLines,dispatches,routine:routine||null,purchaseMail:purchaseMail||null,
    emailPreview:selected?require('./direct-shipment-mail').compose(selected):null,
    choices:choices.slice(0,200),moreOrders:choices.length>200,suppliers:suppliers.slice(0,200),moreSuppliers:suppliers.length>200,
    customer,products:products.slice(0,100),moreProducts:products.length>100,orderId,supplierId,
    mailboxes:allowed?await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId):[],
    requestKey:newId('directrequest'),evidenceHash:hash};
}

function fromForm(input){
  const chosen=Array.isArray(input.lines)?input.lines:Object.values(input.lines||{});
  const rows=chosen.filter(line=>line&&String(line.quantity||'').trim()!==''&&Number(line.quantity)!==0).map(line=>{
    const result={...line};
    if(line.lotsText?.trim())result.lots=String(line.lotsText).trim().split(/\r?\n/).map(text=>{
      const [lotCode,quantity,expiresAt,secondaryQuantity,...extra]=text.split('|').map(part=>part.trim());
      if(extra.length)throw new ValidationError('Use batch, quantity, expiry date and actual weight for each batch line.');
      return {lotCode,quantity,expiresAt:expiresAt||null,secondaryQuantity:secondaryQuantity||null};
    });
    if(line.serialsText?.trim())result.serials=String(line.serialsText).trim().split(/\r?\n/).map(text=>{
      const [serial,weight,lotCode,expiresAt,...extra]=text.split('|').map(part=>part.trim());
      if(extra.length)throw new ValidationError('Use serial, actual weight, batch and expiry date for each serial line.');
      return {serial,weight:weight||null,lotCode:lotCode||null,expiresAt:expiresAt||null};
    });
    return result;
  });
  return {...input,lines:rows};
}

async function supplierPage(db,token){
  const po=await require('./supplier-order-link').lookup(db,token,false,{includeCompleted:true});
  const row=(await db.query(`SELECT d.* FROM ${orders} d WHERE d.workspace_id=$1 AND d.purchase_order_id=$2`,
    [po.workspace_id,po.id])).rows[0];
  if(!row)return null;
  const ctx={workspaceId:po.workspace_id,actorId:row.committed_by};
  await authorize(db,ctx,{existingOrder:await get(db,ctx,row.id)});
  const products=(await db.query(`SELECT d.id,d.quantity,d.dispatched_quantity,d.secondary_quantity,d.dispatched_secondary_quantity,
    s.code,i.name,i.unit_label,i.secondary_unit_label,i.tracking_mode FROM ${lines} d
    JOIN purchase_order_lines p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_line_id
    JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE d.workspace_id=$1 AND d.direct_order_id=$2 ORDER BY p.line_number,d.id`,[ctx.workspaceId,row.id])).rows;
  return {id:row.id,poNumber:po.po_number,canRespond:po.status!=='RECEIVED',customer:row.facts.customer,products};
}

async function supplierSubmit(db,token,input){
  return db.transaction(async c=>{
    const po=await require('./supplier-order-link').lookup(c,token,true,{includeCompleted:true});
    const row=(await c.query(`SELECT * FROM ${orders} WHERE workspace_id=$1 AND purchase_order_id=$2 FOR UPDATE`,[po.workspace_id,po.id])).rows[0];
    if(!row)throw new NotFoundError('This purchase does not have a supplier-direct customer delivery.');
    const ctx={workspaceId:po.workspace_id,actorId:row.committed_by};
    if(input.actualShipment!=='yes')throw new ValidationError('Confirm that you actually dispatched these goods to this purchase’s customer destination.');
    const captured=await captureInTransaction(c,ctx,row.id,fromForm(input),{supplierLink:true});
    const state=await policy.accountState(c,ctx.workspaceId);
    if(row.routine&&!captured.replayed&&policy.usesAgentTerms(state)&&policy.permits(state.plan,37,'automatic'))
      await require('../operations/postgres-job-queue').enqueue(scoped(c),{
      workspaceId:ctx.workspaceId,kind:'agent.supplier_direct.dispatch.v1',idempotencyKey:'supplier-direct-dispatch:'+captured.id,
      payload:{dispatchId:captured.id,actorId:ctx.actorId},priority:30,maxAttempts:3});
    return {saved:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function process(job,db){
  try{return await applyDispatch(db,{workspaceId:job.workspaceId,actorId:job.payload.actorId},job.payload.dispatchId,{}, {automatic:true});}
  catch(error){
    if(![400,402,403,404,422].includes(error.status))throw error;
    await db.query(`UPDATE stockchief_runtime.agent_direct_dispatches SET last_issue=$3
      WHERE workspace_id=$1 AND id=$2 AND state='REVIEW'`,[job.workspaceId,job.payload.dispatchId,String(error.message).slice(0,1000)]);
    return {held:true,reason:error.message};
  }
}

async function deliveryFacts(c,ctx,id,{lock=false,automatic=false}={}){
  await authorize(scoped(c),ctx,{lock,automatic});
  const row=await get(c,ctx,id,lock);
  if(row.purchase_status!=='APPROVED'||!row.committed_at)throw new ValidationError('Approve the exact current supplier-direct purchase before sending it.');
  await currentSource(c,ctx,row,{committed:true});
  if(automatic&&row.automatic_purchase){
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,37,'automatic');
    await require('./direct-shipment-routines').assertPurchase(c,ctx,row,row.rule_id,state);
  }
  return row;
}

const definition={id:37,key:'direct-shipments',label:'Supplier-direct customer deliveries',readPage:async()=>({
  summary:'Turn a checked customer order into an exact supplier purchase, record actual supplier dispatches and tracking, and post its customer invoice and supplier cost. Growth requires individual approvals. Review the exact current delivery before placing its purchase.',
  rows:[{Action:'Open supplier-direct deliveries',link:path}],more:false})};

async function inbox(db,workspaceId,{installed=false}={}){
  if(!installed){
    const schema=(await db.query("SELECT to_regclass('stockchief_runtime.agent_direct_orders') IS NOT NULL AS installed")).rows[0];
    if(!schema?.installed)return [];
  }
  const rows=(await db.query(`WITH purchases AS(
    SELECT d.id,d.created_at,p.po_number,s.order_number,
    (SELECT x.last_issue FROM stockchief_runtime.agent_direct_dispatches x WHERE x.workspace_id=d.workspace_id
      AND x.direct_order_id=d.id AND x.state='REVIEW' ORDER BY x.created_at,x.id LIMIT 1) AS issue
    FROM ${orders} d JOIN purchase_orders p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_id
    JOIN sales_orders s ON s.workspace_id=d.workspace_id AND s.id=d.sales_order_id WHERE d.workspace_id=$1 AND (
      p.status='DRAFT' OR p.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM supplier_communications m
        WHERE m.workspace_id=d.workspace_id AND m.purchase_order_id=p.id AND m.status IN ('QUEUED','SENDING'))
      OR EXISTS(SELECT 1 FROM stockchief_runtime.agent_direct_dispatches x
        WHERE x.workspace_id=d.workspace_id AND x.direct_order_id=d.id AND x.state='REVIEW'))
    ORDER BY d.created_at,d.id LIMIT 50),rules AS(
    SELECT d.id,d.created_at,p.po_number,s.order_number,r.last_issue AS issue FROM stockchief_runtime.agent_direct_rules r
    JOIN ${orders} d ON d.workspace_id=r.workspace_id AND d.id=r.reference_order_id
    JOIN purchase_orders p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_id
    JOIN sales_orders s ON s.workspace_id=d.workspace_id AND s.id=d.sales_order_id
    WHERE r.workspace_id=$1 AND r.enabled AND r.last_issue IS NOT NULL ORDER BY r.next_check_at,r.id LIMIT 50)
    SELECT * FROM purchases UNION ALL SELECT * FROM rules`,[workspaceId])).rows;
  const unique=new Map(rows.map(row=>[row.id,row]));
  return [...unique.values()].map(row=>({kind:'purchase',importance:'Needs You',priority:70,
    title:row.po_number?'Review direct delivery '+row.po_number+' for '+row.order_number:'Review supplier-direct purchasing rule',
    happened:row.issue||'A supplier purchase or actual dispatch needs your review.',
    why:'Use the exact customer destination, supplier quantities and current shipping evidence.',
    actionLabel:'Review direct delivery',href:path+'/'+row.id,sourceId:'supplier-direct:'+row.id,at:row.created_at,createdAt:row.created_at}));
}

module.exports={path,action,prepare,approve,place,capture,applyDispatch,stop,page,fromForm,definition,inbox,
  supplierPage,supplierSubmit,process,deliveryFacts};

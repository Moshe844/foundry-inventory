'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const direct=require('../../src/purchasing/agent-direct-shipments');
const {hash}=require('../../src/pricing/postgres-promotions');

test('supplier-direct purchases dispatch exact fractional, weighted, lot, serial, variant and finished-kit goods without local stock effects',{timeout:720000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service');
  await f.subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const quarantine=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Direct return inspection',kind:'warehouse'});
  await require('../../src/operations/postgres-company-profile').save(db,ctx,{legalName:'Direct invoice issuer',addressLine1:'1 Main St',
    city:'Albany',region:'NY',postalCode:'12207',country:'US',revision:0});
  const cases=[
    {name:'Fractional fabric',profile:{trackingMode:'quantity',unitLabel:'m',quantityPrecision:3,quantityIncrement:'0.001'},quantity:'1.25',costMinor:938},
    {name:'Measured cuts',profile:{trackingMode:'quantity',unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3},quantity:2,secondaryQuantity:'2.35',costMinor:1763},
    {name:'Supplier batches',profile:{trackingMode:'lot'},quantity:2,costMinor:1500,lots:[{lotCode:'BATCH-A',quantity:1},{lotCode:'BATCH-B',quantity:1}]},
    {name:'Supplier flavor variant',profile:{trackingMode:'lot',hasVariants:true,options:[{name:'Flavor',values:'Vanilla,Chocolate'}]},
      quantity:2,costMinor:1500,lots:[{lotCode:'VARIANT-BATCH',quantity:2}]},
    {name:'Supplier serials',profile:{trackingMode:'serial'},quantity:2,costMinor:1500,serials:['DIRECT-SERIAL-1','DIRECT-SERIAL-2']},
    {name:'Measured supplier serials',profile:{trackingMode:'serial',unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3},
      quantity:2,secondaryQuantity:'2.35',costMinor:1763,serials:[{serial:'DIRECT-WEIGHT-1',weight:'1.10'},{serial:'DIRECT-WEIGHT-2',weight:'1.25'}]},
    {name:'Supplier finished bundle',profile:{trackingMode:'quantity'},quantity:2,costMinor:1500,kit:true}
  ];
  for(const example of cases){
    const item=await catalog.createItem(db,ctx,{name:example.name,baseCode:'DIRECT-'+randomUUID().slice(0,8),...example.profile});
    const skuId=item.skuIds[0];
    if(example.kit)await require('../../src/domain/postgres-kit-service').define(db,ctx,{kitSkuId:skuId,
      components:[{skuId:f.item.skuIds[0],quantity:2}]});
    await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId,lastUnitCost:'7.50',
      purchaseUnit:example.profile.unitLabel||'unit',unitsPerPurchaseUnit:1,minimumOrderQuantity:example.profile.quantityIncrement||1,
      orderMultiple:example.profile.quantityIncrement||1});
    const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:f.location.id,
      idempotencyKey:randomUUID(),lines:[{skuId,quantity:example.quantity,secondaryQuantity:example.secondaryQuantity,unitPriceMinor:1500}]});
    if(example.kit)await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
    const prepared=await direct.prepare(db,ctx,{salesOrderId:order.salesOrderId,supplierId:'fixture-supplier',requestKey:randomUUID(),confirmed:'yes',
      lines:[{lineId:order.lineIds[0],quantity:example.quantity,secondaryQuantity:example.secondaryQuantity}]});
    const approved=await direct.approve(db,ctx,prepared.id,{confirmed:'yes',revision:prepared.revision,sourceHash:prepared.source_hash,releaseReserved:'yes'});
    await direct.place(db,ctx,prepared.id,{confirmed:'yes',sentExternally:'yes',revision:approved.revision,sourceHash:approved.source_hash,
      externalReference:'Supplier confirmed exact '+example.name+' by phone'});
    const source=(await db.query('SELECT id FROM stockchief_runtime.agent_direct_order_lines WHERE workspace_id=$1 AND direct_order_id=$2',
      [ctx.workspaceId,prepared.id])).rows[0];
    const dispatch=await direct.capture(db,ctx,prepared.id,{actualShipment:'yes',supplierReference:randomUUID(),
      shippedAt:new Date(Date.now()-1000).toISOString(),carrier:'UPS',trackingNumber:'1Z999AA10123456784',
      lines:[{lineId:source.id,quantity:example.quantity,secondaryQuantity:example.secondaryQuantity,lots:example.lots,serials:example.serials}]});
    const applied=await direct.applyDispatch(db,ctx,dispatch.id,{confirmed:'yes',revision:dispatch.revision,evidenceHash:hash(dispatch.original)});
    assert.equal(applied.status,'FULFILLED',example.name);
    assert.equal(applied.lines[0].costMinor,example.costMinor,example.name);
    assert.equal(applied.lines[0].movementId,null);
    assert.equal((await db.query('SELECT count(*)::int n FROM movements WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,skuId])).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM sales_stock_commitments WHERE workspace_id=$1 AND sales_order_id=$2',
      [ctx.workspaceId,order.salesOrderId])).rows[0].n,0);
    const receipt=[...(await require('../../src/purchasing/supplier-invoice-match').receiptEvidence(db,ctx.workspaceId,prepared.purchase_order_id)).values()][0];
    assert.equal(receipt.proven,true,example.name);
    assert.equal(receipt.value,example.costMinor,example.name);
    const invoices=require('../../src/accounting/agent-customer-invoices');
    const paperwork=await db.transaction(c=>invoices.facts(c,ctx,applied.invoiceId));
    const printable=invoices.render(paperwork);
    assert.match(printable,/Confirmed supplier dispatch details/);
    assert.match(printable,/1Z999AA10123456784/);
    if(example.lots)assert(printable.includes(example.lots[0].lotCode));
    if(example.serials)assert(printable.includes(typeof example.serials[0]==='string'?example.serials[0]:example.serials[0].serial));
    const reviews=require('../../src/autopilot/job-reviews');
    if(example.lots){
      const trace=await reviews.run(db,ctx,'recall-trace',{filter:example.lots[0].lotCode});
      assert.equal(trace.rows[0].Customer,'Receiver');
      assert.equal(Number(trace.rows[0]['Units issued']),example.lots[0].quantity);
    }
    if(example.serials){
      const serial=typeof example.serials[0]==='string'?example.serials[0]:example.serials[0].serial;
      const trace=await reviews.run(db,ctx,'serial-history',{filter:serial});
      assert.equal(trace.rows[0].Action,'Supplier direct dispatch');
    }
    assert.equal(Number((await db.query('SELECT sum(on_hand) n FROM balances WHERE workspace_id=$1 AND sku_id=$2',
      [ctx.workspaceId,f.item.skuIds[0]])).rows[0].n),20);
    const returns=require('../../src/operations/postgres-returns');
    const returnedQuantity=example.profile.quantityPrecision?0.5:1;
    const requested=await returns.requestCustomerReturn(db,ctx,{salesOrderId:order.salesOrderId,quarantineLocationId:quarantine.id,
      resolution:'REFUND',idempotencyKey:randomUUID(),lines:[{salesOrderLineId:order.lineIds[0],quantity:returnedQuantity}]});
    await returns.authorizeCustomerReturn(db,ctx,requested.customerReturnId,{idempotencyKey:randomUUID()});
    const customerReturn=await returns.getCustomerReturn(db,ctx.workspaceId,requested.customerReturnId);
    const view=await f.browser.get('/returns/'+customerReturn.id);
    assert.equal(view.status,200,view.text.slice(-2000));
    const received=await returns.receiveCustomerReturn(db,ctx,customerReturn.id,{idempotencyKey:randomUUID(),
      lines:[{lineId:customerReturn.lines[0].id,quantity:returnedQuantity,secondaryQuantity:example.secondaryQuantity?'1.10':undefined,
        lotCode:example.lots?.[0].lotCode,serials:example.serials?[typeof example.serials[0]==='string'?example.serials[0]:example.serials[0].serial]:undefined}]});
    assert.equal(received.lines[0].costMinor,example.secondaryQuantity?825:example.profile.quantityPrecision?375:750,example.name);
    const receivedReturn=await returns.getCustomerReturn(db,ctx.workspaceId,customerReturn.id);
    const allocations=receivedReturn.lines[0].trackingEvidence.costAllocations;
    assert(allocations.every(allocation=>allocation.inventoryMovementId===null&&allocation.evidenceId.startsWith('supplier-direct:')));
    await returns.inspectCustomerReturn(db,ctx,customerReturn.id,{idempotencyKey:randomUUID(),
      lines:[{lineId:customerReturn.lines[0].id,restock:returnedQuantity,restockLocationId:f.location.id}]});
    assert.equal(Number((await db.query('SELECT sum(on_hand) n FROM balances WHERE workspace_id=$1 AND sku_id=$2',
      [ctx.workspaceId,skuId])).rows[0].n),returnedQuantity,example.name);
    if(example.secondaryQuantity)assert.equal(Number((await db.query('SELECT sum(secondary_on_hand) n FROM balances WHERE workspace_id=$1 AND sku_id=$2',
      [ctx.workspaceId,skuId])).rows[0].n),1.1);
    assert.equal(Number((await db.query('SELECT sum(on_hand) n FROM balances WHERE workspace_id=$1 AND sku_id=$2',
      [ctx.workspaceId,f.item.skuIds[0]])).rows[0].n),20);
  }
});

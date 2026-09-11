'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const auth = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const locations = require('../../src/domain/location-service');
const prices = require('../../src/pricing/price-service');
const sales = require('../../src/sales/sales-order-service');
const shipments = require('../../src/sales/shipment-service');
const counts = require('../../src/operations/counts');
const returns = require('../../src/operations/returns');
const waves = require('../../src/operations/fulfillment-waves');
const suppliers = require('../../src/purchasing/supplier-service');
const purchaseOrders = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const ledger = require('../../src/accounting/ledger');
const payables = require('../../src/accounting/payables');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, makeLotItem, makeSerialItem } = require('../helpers');

test.after(cleanupAll);
const TODAY = new Date().toISOString().slice(0,10);

function setup(name='Mission 8 Company') {
  const { db }=makeDatabase();
  const workspace=seedWorkspace(db,{workspaceName:name});
  const membership=auth.getMembership(db,workspace.workspaceId,workspace.accountId);
  locations.updateLocation(db,workspace.ctx,workspace.main.id,{name:workspace.main.name,kind:workspace.main.kind,barcode:'MAIN-M8'});
  return {db,workspace,membership,ctx:workspace.ctx};
}

function fulfilledOrder(env,item,quantity=2){
  prices.setPrice(env.db,env.ctx,{skuId:item.skuId,amount:'25.00',currency:'USD'});
  inventory.receive(env.db,env.ctx,{skuId:item.skuId,locationId:env.workspace.main.id,quantity:10});
  let order=sales.createOrder(env.db,env.ctx,{customerName:'Return Customer',fulfillmentLocationId:env.workspace.main.id,
    lines:[{skuId:item.skuId,quantity}]});
  order=sales.confirm(env.db,env.ctx,order.id);
  sales.fulfill(env.db,env.ctx,order.id,{}, {idempotencyKey:`fulfill-${order.id}`});
  return sales.getOrder(env.db,env.workspace.workspaceId,order.id);
}

test('blind cycle counts require a recount and approval before one canonical adjustment',()=>{
  const env=setup('Blind count company');
  const item=makeQuantityItem(env.db,env.ctx,{name:'Counted shoe',baseCode:'COUNT-M8'});
  inventory.receive(env.db,env.ctx,{skuId:item.skuId,locationId:env.workspace.main.id,quantity:10});
  const first=counts.createCampaign(env.db,env.ctx,env.membership,{countKind:'CYCLE',locationId:env.workspace.main.id,skuIds:[item.skuId],blindCount:true});
  counts.recordCount(env.db,env.ctx,env.membership,first.id,first.lines[0].id,8,'Shelf counted twice');
  assert.equal(counts.submit(env.db,env.ctx,env.membership,first.id).status,'RECOUNT_REQUIRED');
  assert.equal(repo.getBalance(env.db,env.workspace.workspaceId,item.skuId,env.workspace.main.id),10,'first pass cannot mutate stock');

  const second=counts.startRecount(env.db,env.ctx,env.membership,first.id);
  counts.recordCount(env.db,env.ctx,env.membership,second.id,second.lines[0].id,8,'Independent recount');
  assert.equal(counts.submit(env.db,env.ctx,env.membership,second.id).status,'AWAITING_APPROVAL');
  assert.equal(repo.getBalance(env.db,env.workspace.workspaceId,item.skuId,env.workspace.main.id),10,'recount cannot mutate stock');
  assert.equal(counts.approve(env.db,env.ctx,env.membership,second.id).status,'COMPLETED');
  assert.equal(counts.approve(env.db,env.ctx,env.membership,second.id).status,'COMPLETED','approval replay is harmless');
  assert.equal(repo.getBalance(env.db,env.workspace.workspaceId,item.skuId,env.workspace.main.id),8);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE operation='adjust' AND reference LIKE 'Count %'").get().n,1);
});

test('count plans persist, launch once, advance their due date, and preserve lot identity',()=>{
  const env=setup('Planned counts company');
  const item=makeLotItem(env.db,env.ctx,{name:'Lot medicine',baseCode:'LOT-M8'});
  inventory.receive(env.db,env.ctx,{skuId:item.skuId,locationId:env.workspace.main.id,quantity:5,lotCode:'LOT-A'});
  inventory.receive(env.db,env.ctx,{skuId:item.skuId,locationId:env.workspace.main.id,quantity:3,lotCode:'LOT-B'});
  const plan=counts.createPlan(env.db,env.ctx,env.membership,{name:'Weekly lot count',countKind:'CYCLE',locationId:env.workspace.main.id,
    frequencyDays:7,nextDueDate:'2026-09-10',skuIds:[item.skuId],blindCount:true});
  const session=counts.launchPlan(env.db,env.ctx,env.membership,plan.id);
  const replay=counts.launchPlan(env.db,env.ctx,env.membership,plan.id);
  assert.equal(replay.id,session.id,'starting the same active plan cannot duplicate work');
  assert.deepEqual(session.lines.map((line)=>Number(line.expected_quantity)).sort((a,b)=>a-b),[3,5]);
  assert.equal(session.lines.every((line)=>Boolean(line.lot_id)),true,'each counted quantity remains attached to an exact lot');
  assert.equal(counts.requirePlan(env.db,env.workspace.workspaceId,plan.id).next_due_date,'2026-09-17');
});

test('customer RMA holds stock in quarantine until evidence-based inspection',()=>{
  const env=setup('Customer returns company');
  const item=makeQuantityItem(env.db,env.ctx,{name:'Returned shoe',baseCode:'RMA-M8'});
  const order=fulfilledOrder(env,item,2);
  const quarantine=locations.createLocation(env.db,env.ctx,{name:'Returns quarantine',kind:'zone',barcode:'QUAR-M8'});
  let rma=returns.requestCustomerReturn(env.db,env.ctx,env.membership,{salesOrderId:order.id,quarantineLocationId:quarantine.id,
    resolution:'NO_REFUND',reason:'Wrong size',lines:[{salesOrderLineId:order.lines[0].id,quantity:2}]});
  rma=returns.authorizeCustomerReturn(env.db,env.ctx,env.membership,rma.id);
  let partial=returns.receiveCustomerReturn(env.db,env.ctx,env.membership,rma.id,{lines:[{lineId:rma.lines[0].id,quantity:1}]});
  assert.equal(partial.status,'PARTIALLY_RECEIVED');
  returns.receiveCustomerReturn(env.db,env.ctx,env.membership,rma.id,{lines:[{lineId:rma.lines[0].id,quantity:1}]});
  assert.equal(repo.getBalance(env.db,env.workspace.workspaceId,item.skuId,quarantine.id),2);
  assert.equal(repo.getBalance(env.db,env.workspace.workspaceId,item.skuId,env.workspace.main.id),8);
  rma=returns.inspectCustomerReturn(env.db,env.ctx,env.membership,rma.id,{lines:[{lineId:rma.lines[0].id,restock:1,scrap:1,repair:0,
    restockLocationId:env.workspace.main.id,conditionNote:'One sealed; one sole damaged'}]});
  assert.equal(rma.status,'COMPLETED');
  assert.equal(repo.getBalance(env.db,env.workspace.workspaceId,item.skuId,quarantine.id),0);
  assert.equal(repo.getBalance(env.db,env.workspace.workspaceId,item.skuId,env.workspace.main.id),9);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE reference=? AND reason_code='damaged'").get(rma.return_number).n,1);
});

test('supplier RTV removes stock once and leaves an explicit credit mismatch',()=>{
  const env=setup('Supplier return company');
  ledger.configure(env.db,env.ctx,env.membership,{startDate:TODAY,currency:'USD',costingMethod:'WEIGHTED_AVERAGE'});
  const item=makeQuantityItem(env.db,env.ctx,{name:'Vendor shoe',baseCode:'RTV-M8'});
  const supplier=suppliers.createSupplier(env.db,env.ctx,env.membership,{name:'Vendor Supply'});
  suppliers.linkItem(env.db,env.ctx,env.membership,{supplierId:supplier.id,skuId:item.skuId,supplierSku:'VS-1',purchaseUnit:'unit',unitsPerPurchaseUnit:1,lastUnitCost:10});
  let po=purchaseOrders.createOrder(env.db,env.ctx,env.membership,{supplierId:supplier.id,destinationLocationId:env.workspace.main.id,
    lines:[{skuId:item.skuId,quantityUnits:5,unitCost:10}]});
  po=purchaseOrders.approve(env.db,env.ctx,env.membership,po.id);
  receiving.receive(env.db,env.ctx,env.membership,po.id,{idempotencyKey:'m8-receipt',lines:[{lineId:po.lines[0].id,quantityUnits:5}]});
  const draft=payables.createDraft(env.db,env.ctx,env.membership,{supplierId:supplier.id,purchaseOrderId:po.id,supplierInvoiceNumber:'INV-M8',
    issueDate:TODAY,sourceKey:'m8-bill',lines:[{description:'Vendor shoes',quantity:5,unitCostMinor:1000,itemId:item.itemId,skuId:item.skuId,purchaseOrderLineId:po.lines[0].id}]});
  const bill=payables.open(env.db,env.ctx,env.membership,draft.bill.id);
  let rtv=returns.requestSupplierReturn(env.db,env.ctx,env.membership,{supplierId:supplier.id,supplierBillId:bill.id,expectedCreditMinor:2000,
    reason:'Two damaged',lines:[{skuId:item.skuId,locationId:env.workspace.main.id,quantity:2}]});
  rtv=returns.authorizeSupplierReturn(env.db,env.ctx,env.membership,rtv.id);
  returns.shipSupplierReturn(env.db,env.ctx,env.membership,rtv.id);
  returns.shipSupplierReturn(env.db,env.ctx,env.membership,rtv.id);
  assert.equal(repo.getBalance(env.db,env.workspace.workspaceId,item.skuId,env.workspace.main.id),3,'retry cannot remove stock twice');
  rtv=returns.reconcileSupplierReturn(env.db,env.ctx,env.membership,rtv.id,{amountMinor:1500,creditNumber:'CM-M8',creditDate:TODAY});
  assert.equal(rtv.status,'CREDIT_MISMATCH');
  assert.equal(rtv.expected_credit_minor,2000);
  assert.equal(rtv.actual_credit_minor,1500);
});

test('a partial customer return posts an exact refund and a separate exchange creates the replacement order',()=>{
  const env=setup('Refund and exchange company');
  ledger.configure(env.db,env.ctx,env.membership,{startDate:TODAY,currency:'USD',costingMethod:'WEIGHTED_AVERAGE'});
  const item=makeQuantityItem(env.db,env.ctx,{name:'Exchange shoe',baseCode:'EX-M8'});
  const order=fulfilledOrder(env,item,3);
  const saleEntry=ledger.post(env.db,env.ctx,{postingDate:TODAY,description:'Returnable sale',sourceType:'sales_fulfillment',
    sourceRecordType:'sales_order',sourceRecordId:order.id,sourceKey:`m8-sale:${order.id}`,
    metadata:{salesOrderId:order.id,revenueMinor:7500,taxMinor:0,cogsMinor:0},
    lines:[{accountKey:'CASH',debitMinor:7500},{accountKey:'SALES_REVENUE',creditMinor:7500}]}).entry;
  assert.ok(saleEntry.id);
  const quarantine=locations.createLocation(env.db,env.ctx,{name:'Return inspection',kind:'zone',barcode:'RETURN-M8'});
  let refund=returns.requestCustomerReturn(env.db,env.ctx,env.membership,{salesOrderId:order.id,quarantineLocationId:quarantine.id,
    resolution:'REFUND',reason:'One pair returned',lines:[{salesOrderLineId:order.lines[0].id,quantity:1}]});
  returns.authorizeCustomerReturn(env.db,env.ctx,env.membership,refund.id);
  returns.receiveCustomerReturn(env.db,env.ctx,env.membership,refund.id,{lines:[{lineId:refund.lines[0].id,quantity:1}]});
  refund=returns.inspectCustomerReturn(env.db,env.ctx,env.membership,refund.id,{lines:[{lineId:refund.lines[0].id,restock:1,scrap:0,repair:0,
    restockLocationId:env.workspace.main.id,conditionNote:'Unworn'}]});
  assert.equal(refund.status,'AWAITING_REFUND');
  refund=returns.refundCustomerReturn(env.db,env.ctx,env.membership,refund.id,{revenueMinor:2500,taxMinor:0,cogsMinor:0,destination:'CASH'});
  assert.equal(refund.status,'COMPLETED');
  assert.equal(env.db.prepare("SELECT revenue_minor FROM accounting_sale_refunds WHERE id=?").get(refund.refund_id).revenue_minor,2500);

  let exchange=returns.requestCustomerReturn(env.db,env.ctx,env.membership,{salesOrderId:order.id,quarantineLocationId:quarantine.id,
    resolution:'EXCHANGE',reason:'Needs another size',lines:[{salesOrderLineId:order.lines[0].id,quantity:1}]});
  returns.authorizeCustomerReturn(env.db,env.ctx,env.membership,exchange.id);
  returns.receiveCustomerReturn(env.db,env.ctx,env.membership,exchange.id,{lines:[{lineId:exchange.lines[0].id,quantity:1}]});
  exchange=returns.inspectCustomerReturn(env.db,env.ctx,env.membership,exchange.id,{lines:[{lineId:exchange.lines[0].id,restock:1,scrap:0,repair:0,
    restockLocationId:env.workspace.main.id,conditionNote:'Saleable'}]});
  exchange=returns.exchangeCustomerReturn(env.db,env.ctx,env.membership,exchange.id,{lines:[{skuId:item.skuId,quantity:1}]});
  assert.equal(exchange.status,'COMPLETED');
  assert.equal(sales.getOrder(env.db,env.workspace.workspaceId,exchange.exchange_order_id).status,'CONFIRMED');
});

test('a wave shortage is durable, idempotent, and never pretends the order was picked',()=>{
  const env=setup('Wave shortage company');
  const item=makeQuantityItem(env.db,env.ctx,{name:'Short wave shoe',baseCode:'SHORT-M8'});
  prices.setPrice(env.db,env.ctx,{skuId:item.skuId,amount:'20.00',currency:'USD'});
  inventory.receive(env.db,env.ctx,{skuId:item.skuId,locationId:env.workspace.main.id,quantity:5});
  let order=sales.createOrder(env.db,env.ctx,{customerName:'Short Customer',fulfillmentLocationId:env.workspace.main.id,lines:[{skuId:item.skuId,quantity:4}]});
  order=sales.confirm(env.db,env.ctx,order.id);
  const wave=waves.create(env.db,env.ctx,env.membership,{strategy:'WAVE',orderIds:[order.id]});
  waves.reportShortage(env.db,env.ctx,env.membership,wave.id,wave.lines[0].id,2,'Only two were on the shelf');
  waves.reportShortage(env.db,env.ctx,env.membership,wave.id,wave.lines[0].id,2,'Offline replay');
  const blocked=waves.get(env.db,env.workspace.workspaceId,wave.id);
  assert.equal(blocked.status,'BLOCKED');
  assert.equal(blocked.lines[0].status,'SHORT');
  assert.equal(blocked.lines[0].picked_quantity,0);
  assert.equal(blocked.scans.filter((scan)=>scan.client_scan_id.startsWith('shortage:')).length,1);
  assert.equal(repo.getBalance(env.db,env.workspace.workspaceId,item.skuId,env.workspace.main.id),5);
});

test('wave scans reject wrong identity, deduplicate offline replay, expose shortage, and move no stock before shipping',()=>{
  const env=setup('Fulfillment wave company');
  const item=makeQuantityItem(env.db,env.ctx,{name:'Wave shoe',baseCode:'WAVE-M8'});
  const order=fulfilledOrder(env,item,3);
  // fulfilledOrder shipped this first order; create a second allocated order for the wave.
  let ready=sales.createOrder(env.db,env.ctx,{customerName:'Wave Customer',fulfillmentLocationId:env.workspace.main.id,
    lines:[{skuId:item.skuId,quantity:2}]});
  ready=sales.confirm(env.db,env.ctx,ready.id);
  const wave=waves.create(env.db,env.ctx,env.membership,{strategy:'CLUSTER',orderIds:[ready.id]});
  const line=wave.lines[0];
  const wrong=waves.scan(env.db,env.ctx,env.membership,wave.id,{clientScanId:'m8-wrong',locationBarcode:'MAIN-M8',itemBarcode:'NOT-A-SKU',quantity:1});
  assert.equal(wrong.status,'REJECTED');
  assert.equal(waves.get(env.db,env.workspace.workspaceId,wave.id).status,'BLOCKED');
  const accepted=waves.scan(env.db,env.ctx,env.membership,wave.id,{clientScanId:'m8-good',locationBarcode:'MAIN-M8',itemBarcode:item.sku.code,quantity:2});
  assert.equal(accepted.status,'ACCEPTED');
  assert.equal(waves.scan(env.db,env.ctx,env.membership,wave.id,{clientScanId:'m8-good',locationBarcode:'MAIN-M8',itemBarcode:item.sku.code,quantity:2}).duplicate,true);
  assert.equal(repo.getBalance(env.db,env.workspace.workspaceId,item.skuId,env.workspace.main.id),7,'picking and packing must not move stock');
  waves.packShipment(env.db,env.ctx,env.membership,wave.id,line.shipment_id,{packageCount:1,weightGrams:900});
  assert.equal(repo.getBalance(env.db,env.workspace.workspaceId,item.skuId,env.workspace.main.id),7);
  shipments.ship(env.db,env.ctx,line.shipment_id,{carrier:'manual',service:'Ground'});
  assert.equal(repo.getBalance(env.db,env.workspace.workspaceId,item.skuId,env.workspace.main.id),5,'shipping is the only physical issue');
  assert.equal(waves.refresh(env.db,env.ctx,env.membership,wave.id).status,'COMPLETED');
});

test('wave shipping preserves exact lot and serial identity from scan through inventory issue',()=>{
  const env=setup('Tracked wave company');
  const serial=makeSerialItem(env.db,env.ctx,{name:'Serialized scanner',baseCode:'SER-WAVE'});
  serial.sku=repo.requireSku(env.db,env.workspace.workspaceId,serial.skuId);
  prices.setPrice(env.db,env.ctx,{skuId:serial.skuId,amount:'50.00',currency:'USD'});
  inventory.receive(env.db,env.ctx,{skuId:serial.skuId,locationId:env.workspace.main.id,serials:['SER-M8-001']});
  let serialOrder=sales.createOrder(env.db,env.ctx,{customerName:'Serial customer',fulfillmentLocationId:env.workspace.main.id,lines:[{skuId:serial.skuId,quantity:1}]});
  serialOrder=sales.confirm(env.db,env.ctx,serialOrder.id);
  let wave=waves.create(env.db,env.ctx,env.membership,{strategy:'CLUSTER',orderIds:[serialOrder.id]});
  let line=wave.lines[0];
  const serialScan=waves.scan(env.db,env.ctx,env.membership,wave.id,{clientScanId:'serial-wave-1',locationBarcode:'MAIN-M8',
    itemBarcode:serial.sku.code,serialBarcode:'SER-M8-001',quantity:1});
  assert.equal(serialScan.status,'ACCEPTED');assert.ok(serialScan.serial_unit_id);
  waves.packShipment(env.db,env.ctx,env.membership,wave.id,line.shipment_id,{packageCount:1});
  shipments.ship(env.db,env.ctx,line.shipment_id,{carrier:'manual'});
  const unit=env.db.prepare("SELECT * FROM serial_units WHERE workspace_id=? AND sku_id=? AND serial='SER-M8-001'").get(env.workspace.workspaceId,serial.skuId);
  assert.equal(unit.id,serialScan.serial_unit_id);assert.equal(unit.status,'issued');

  const lotItem=makeLotItem(env.db,env.ctx,{name:'Lot tracked cream',baseCode:'LOT-WAVE'});
  lotItem.sku=repo.requireSku(env.db,env.workspace.workspaceId,lotItem.skuId);
  prices.setPrice(env.db,env.ctx,{skuId:lotItem.skuId,amount:'10.00',currency:'USD'});
  inventory.receive(env.db,env.ctx,{skuId:lotItem.skuId,locationId:env.workspace.main.id,quantity:4,lotCode:'LOT-M8-1'});
  let lotOrder=sales.createOrder(env.db,env.ctx,{customerName:'Lot customer',fulfillmentLocationId:env.workspace.main.id,lines:[{skuId:lotItem.skuId,quantity:2}]});
  lotOrder=sales.confirm(env.db,env.ctx,lotOrder.id);
  wave=waves.create(env.db,env.ctx,env.membership,{strategy:'BATCH',orderIds:[lotOrder.id]});line=wave.lines[0];
  const lotScan=waves.scan(env.db,env.ctx,env.membership,wave.id,{clientScanId:'lot-wave-1',locationBarcode:'MAIN-M8',
    itemBarcode:lotItem.sku.code,lotBarcode:'LOT-M8-1',quantity:2});
  assert.equal(lotScan.status,'ACCEPTED');assert.ok(lotScan.lot_id);
  waves.packShipment(env.db,env.ctx,env.membership,wave.id,line.shipment_id,{packageCount:1});
  shipments.ship(env.db,env.ctx,line.shipment_id,{carrier:'manual'});
  assert.equal(repo.getLotBalance(env.db,env.workspace.workspaceId,lotScan.lot_id,env.workspace.main.id),2);
});

test('a serialized customer return reactivates only the exact unit proven on the sale',()=>{
  const env=setup('Serialized return company');
  const item=makeSerialItem(env.db,env.ctx,{name:'Serialized device',baseCode:'SER-RMA'});
  const sku=repo.requireSku(env.db,env.workspace.workspaceId,item.skuId);
  prices.setPrice(env.db,env.ctx,{skuId:item.skuId,amount:'100.00',currency:'USD'});
  inventory.receive(env.db,env.ctx,{skuId:item.skuId,locationId:env.workspace.main.id,serials:['SOLD-SERIAL','OTHER-SERIAL']});
  const sold=env.db.prepare("SELECT id FROM serial_units WHERE workspace_id=? AND sku_id=? AND serial='SOLD-SERIAL'").get(env.workspace.workspaceId,item.skuId);
  let order=sales.createOrder(env.db,env.ctx,{customerName:'Serial return customer',fulfillmentLocationId:env.workspace.main.id,lines:[{skuId:item.skuId,quantity:1}]});
  order=sales.confirm(env.db,env.ctx,order.id);
  sales.fulfill(env.db,env.ctx,order.id,{lines:[{lineId:order.lines[0].id,locationId:env.workspace.main.id,quantity:1,serialUnitIds:[sold.id]}]},
    {idempotencyKey:'serial-rma-sale'});
  order=sales.getOrder(env.db,env.workspace.workspaceId,order.id);
  const quarantine=locations.createLocation(env.db,env.ctx,{name:'Serial quarantine',kind:'zone',barcode:'SER-QUAR'});
  let rma=returns.requestCustomerReturn(env.db,env.ctx,env.membership,{salesOrderId:order.id,quarantineLocationId:quarantine.id,
    resolution:'NO_REFUND',reason:'Faulty',lines:[{salesOrderLineId:order.lines[0].id,quantity:1}]});
  returns.authorizeCustomerReturn(env.db,env.ctx,env.membership,rma.id);
  assert.throws(()=>returns.receiveCustomerReturn(env.db,env.ctx,env.membership,rma.id,{lines:[{lineId:rma.lines[0].id,quantity:1,serials:['OTHER-SERIAL']}]}),/not proven to have left/);
  returns.receiveCustomerReturn(env.db,env.ctx,env.membership,rma.id,{lines:[{lineId:rma.lines[0].id,quantity:1,serials:['SOLD-SERIAL']}]});
  const returned=repo.requireSerialUnit(env.db,env.workspace.workspaceId,sold.id);
  assert.equal(returned.status,'in_stock');assert.equal(returned.location_id,quarantine.id);assert.equal(returned.condition,'unknown');
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM serial_units WHERE workspace_id=? AND sku_id=? AND serial='SOLD-SERIAL'").get(env.workspace.workspaceId,item.skuId).n,1,
    'a return preserves the original serial identity instead of creating a duplicate unit');
  assert.equal(sku.tracking_mode,'serial');
});

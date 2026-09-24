'use strict';

if (process.env.NODE_ENV !== 'test' || !process.env.DATABASE_PATH) throw new Error('An isolated test database is required.');
const { advance } = require('./business-clock');
const { openDatabase } = require('../../src/db');
const { seedWorkspace,makeQuantityItem } = require('../helpers');
const { createApp } = require('../../src/app');
const suppliers = require('../../src/purchasing/supplier-service');
const orders = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const policies = require('../../src/purchasing/policy-service');
const modes = require('../../src/autopilot/modes');

advance('2026-09-18T12:00:00.000Z');
const now = Date.now();
const db = openDatabase(process.env.DATABASE_PATH);
const workspace = seedWorkspace(db,{workspaceName:'Weekly Operations Acceptance',email:'weekly@example.test',password:'weekly-ui-acceptance-2026'});
const membership = {role:'owner',id:workspace.ownerId,workspace_id:workspace.workspaceId};
modes.setMode(db,workspace.ctx,membership,'OBSERVE');
db.prepare(`INSERT INTO workspace_configuration (workspace_id,configured_at,configuration_version,
  terminology,operational_defaults,inventory_model,updated_at) VALUES (?,?,1,'{}',?,?,?)`)
  .run(workspace.workspaceId,new Date().toISOString(),JSON.stringify({allowNegativeStock:false,transfersEnabled:true}),
    JSON.stringify({primaryArchetype:'quantity',usesVariants:false}),new Date().toISOString());
const day = 86400000;
const ago = (days) => new Date(now-days*day).toISOString();
const historical = makeQuantityItem(db,workspace.ctx,{name:'Historical Supply',baseCode:'HISTORY'});
const supplier = suppliers.createSupplier(db,workspace.ctx,membership,{name:'Measured Historical Supplier',defaultLeadTimeDays:5});
suppliers.linkItem(db,workspace.ctx,membership,{supplierId:supplier.id,skuId:historical.skuId,lastUnitCost:1});

function historicalOrder(sentDaysAgo,receipts,expectedDays=5) {
  let order = orders.createOrder(db,workspace.ctx,membership,{supplierId:supplier.id,destinationLocationId:workspace.main.id,
    expectedDate:ago(sentDaysAgo-expectedDays).slice(0,10),lines:[{skuId:historical.skuId,quantityUnits:10,unitCost:1}]});
  order = orders.approve(db,workspace.ctx,membership,order.id,{expectedHash:order.integrityHash,markOrdered:true});
  db.prepare('UPDATE purchase_orders SET ordered_at=?,approved_at=? WHERE id=?').run(ago(sentDaysAgo),ago(sentDaysAgo),order.id);
  for (const [index,receipt] of receipts.entries()) receiving.receive(db,workspace.ctx,membership,order.id,{
    idempotencyKey:`weekly:${order.id}:${index}`,receivedAt:ago(sentDaysAgo-receipt.afterDays),
    lines:[{lineId:order.lines[0].id,quantityUnits:receipt.quantity,locationId:workspace.main.id}]});
}
for (let index=0;index<12;index+=1) historicalOrder(30+index*10,[{afterDays:5,quantity:10}]);
historicalOrder(20,[{afterDays:4,quantity:8},{afterDays:8,quantity:2}]);
historicalOrder(10,[]);
historicalOrder(1,[],10);
historicalOrder(250,[{afterDays:5,quantity:10}]);

const economic = makeQuantityItem(db,workspace.ctx,{name:'Economical Replenishment',baseCode:'ECONOMIC'});
const economicSuppliers = [];
for (const [name,price,pack,minimum] of [['Bulk False Economy',1,1,1000],['Practical Cases',2,6,1],['Unknown Price',null,1,1]]) {
  const candidate = suppliers.createSupplier(db,workspace.ctx,membership,{name,defaultLeadTimeDays:7});
  economicSuppliers.push(candidate.id);
  suppliers.linkItem(db,workspace.ctx,membership,{supplierId:candidate.id,skuId:economic.skuId,lastUnitCost:price,
    purchaseUnit:pack>1?'case':'unit',unitsPerPurchaseUnit:pack,minimumOrderQuantity:minimum,orderMultiple:1,isPreferred:false});
}
policies.setPolicy(db,workspace.ctx,membership,economic.skuId,{reorderPoint:5,targetStock:12,safetyStock:0});
const timingSkus = [];
for (const [name,expectedDate,usage] of [['Overdue Incoming Coverage','2026-09-16',false],['Unknown Incoming Coverage',null,false],['Too Late Incoming Coverage','2026-10-20',true]]) {
  const item = makeQuantityItem(db,workspace.ctx,{name,baseCode:`TIMING-${timingSkus.length}`});
  const timingSupplier = suppliers.createSupplier(db,workspace.ctx,membership,{name:`Supplier ${name}`});
  suppliers.linkItem(db,workspace.ctx,membership,{supplierId:timingSupplier.id,skuId:item.skuId,lastUnitCost:1});
  policies.setPolicy(db,workspace.ctx,membership,item.skuId,{reorderPoint:5,targetStock:12,safetyStock:0});
  if (usage) {
    advance('2026-08-20T12:00:00.000Z');
    require('../../src/domain/inventory-engine').receive(db,workspace.ctx,{skuId:item.skuId,locationId:workspace.main.id,quantity:21});
    for (let index=0;index<20;index+=1) {
      advance(new Date(Date.parse('2026-08-21T12:00:00.000Z')+index*day).toISOString());
      require('../../src/domain/inventory-engine').issue(db,workspace.ctx,{skuId:item.skuId,locationId:workspace.main.id,quantity:1});
    }
    advance('2026-09-18T12:00:00.000Z');
  }
  let purchase = orders.createOrder(db,workspace.ctx,membership,{supplierId:timingSupplier.id,destinationLocationId:workspace.main.id,
    expectedDate,lines:[{skuId:item.skuId,quantityUnits:20,unitCost:1}]});
  purchase = orders.approve(db,workspace.ctx,membership,purchase.id,{expectedHash:purchase.integrityHash,markOrdered:true});
  timingSkus.push({skuId:item.skuId,name,purchaseId:purchase.id});
}
const ledger = require('../../src/accounting/ledger');
const payments = require('../../src/accounting/payments');
ledger.configure(db,workspace.ctx,membership,{startDate:'2025-01-01',currency:'USD'});
for (const [postingDate,revenue,cost] of [['2026-06-15',10000,6000],['2026-08-15',20000,18000]]) {
  ledger.post(db,workspace.ctx,{postingDate,sourceKey:`weekly-revenue:${postingDate}`,description:'Historical realized sale',lines:[
    {accountKey:'CASH',debitMinor:revenue},{accountKey:'SALES_REVENUE',creditMinor:revenue,skuId:historical.skuId,locationId:workspace.main.id},
    {accountKey:'COST_OF_GOODS_SOLD',debitMinor:cost,skuId:historical.skuId,locationId:workspace.main.id},
    {accountKey:'INVENTORY_ASSET',creditMinor:cost,skuId:historical.skuId,locationId:workspace.main.id}]});
}
const customer = require('../../src/sales/sales-order-service').createCustomer(db,workspace.ctx,{name:'Quarter Customer',email:'quarter@example.test'});
for (let index=0;index<12;index+=1) payments.record(db,workspace.ctx,membership,{
  direction:'CUSTOMER_RECEIPT',customerId:customer.id,paymentDate:'2026-06-15',amountMinor:1000,method:'cash',sourceKey:`weekly-payment:${index}`});
for (const [paymentDate,amountMinor] of [['2026-08-15',90000],['2026-10-15',999900]]) payments.record(db,workspace.ctx,membership,{
  direction:'CUSTOMER_RECEIPT',customerId:customer.id,paymentDate,amountMinor,method:'cash',sourceKey:`weekly-payment:${paymentDate}`});
const paidOnly = suppliers.createSupplier(db,workspace.ctx,membership,{name:'Paid Only Supplier'});
payments.record(db,workspace.ctx,membership,{direction:'SUPPLIER_PAYMENT',supplierId:paidOnly.id,
  paymentDate:'2026-06-15',amountMinor:5500,method:'cash',sourceKey:'weekly-supplier-cash'});
for (let index=0;index<12;index+=1) {
  const counterparty = index===0 ? supplier : suppliers.createSupplier(db,workspace.ctx,membership,{name:`Historical Purchase Supplier ${index}`});
  const amount = index===0 ? 8000 : 100;
  ledger.post(db,workspace.ctx,{postingDate:'2026-06-15',sourceType:'supplier_bill',sourceKey:`weekly-purchase:${index}`,
    description:'Historical supplier purchase',lines:[{accountKey:'INVENTORY_ASSET',debitMinor:amount,supplierId:counterparty.id},
      {accountKey:'ACCOUNTS_PAYABLE',creditMinor:amount,supplierId:counterparty.id}]});
}
const aiProvider = {name:'unavailable-fixture',model:'fixture',complete:async () => {throw new Error('No external model calls in this fixture.');}};
const automationPolicies = require('../../src/autopilot/policy-service');
const purchasingAuthority = automationPolicies.propose(db,workspace.ctx,membership,{
  name:'Fixture existing purchasing authority',allowedActionTypes:['approve_purchase_order'],itemScope:[economic.skuId],supplierScope:economicSuppliers,
  maximumQuantity:100,maximumValue:100,thresholds:{maxUnitPriceChangePercent:5},
  conditions:[automationPolicies.CONDITIONS.REPLENISHMENT_EVIDENCE,automationPolicies.CONDITIONS.MOQ_ORDER_MULTIPLE_COMPLIANT,
    automationPolicies.CONDITIONS.NO_DUPLICATE_INCOMING_DEMAND,automationPolicies.CONDITIONS.PRICE_WITHIN_POLICY]});
automationPolicies.approve(db,workspace.ctx,membership,purchasingAuthority.id);
const app = createApp({db,env:'test',sessionSecret:'weekly-operations-acceptance',aiProvider});
let projectionFailure = false;
const prepare = db.prepare.bind(db);
db.prepare = (statement) => {
  if (projectionFailure && statement.includes("json_extract(simulation,'$.summary')")) throw new Error('Injected exception projection failure');
  return prepare(statement);
};
process.on('message',(message) => {
  if (message.type==='projection-failure') {
    projectionFailure = Boolean(message.enabled);
    process.send({type:'projection-failure-ready'});
  }
});
const sales = require('../../src/sales/sales-order-service');
const allocationItem = makeQuantityItem(db,workspace.ctx,{name:'Allocation Acceptance Stock',baseCode:'ALLOCATE'});
require('../../src/pricing/price-service').setPrice(db,workspace.ctx,{skuId:allocationItem.skuId,amountMinor:1000,currency:'USD'});
const allocationOrders = [];
for (let index=0;index<150;index+=1) {
  const neededBy = index===149 ? '2026-09-19' : index===1 ? '2026-09-25' : index===0 ? '2026-09-30' : null;
  const draft = sales.createOrder(db,workspace.ctx,{customerName:`Allocation Customer ${String(index).padStart(3,'0')}`,
    orderNumber:`ALLOC-${String(index).padStart(3,'0')}`,deliveryMethod:'PICKUP',neededBy,
    fulfillmentLocationId:workspace.main.id,lines:[{skuId:allocationItem.skuId,quantity:1}]});
  allocationOrders.push(sales.confirm(db,workspace.ctx,draft.id).id);
}
require('../../src/domain/inventory-engine').receive(db,workspace.ctx,{skuId:allocationItem.skuId,locationId:workspace.main.id,quantity:100});
sales.reconcileForSkus(db,workspace.ctx,[allocationItem.skuId]);
const waitingOrderId = allocationOrders.find((orderId) => sales.getOrder(db,workspace.workspaceId,orderId).totals.backordered===1);
const allocationSupplier = suppliers.createSupplier(db,workspace.ctx,membership,{name:'Allocation Incoming Supplier'});
let allocationPurchase = orders.createOrder(db,workspace.ctx,membership,{supplierId:allocationSupplier.id,destinationLocationId:workspace.main.id,
  expectedDate:'2026-09-20',lines:[{skuId:allocationItem.skuId,quantityUnits:50,unitCost:1}]});
allocationPurchase = orders.approve(db,workspace.ctx,membership,allocationPurchase.id,{expectedHash:allocationPurchase.integrityHash,markOrdered:true});
for (let index=0;index<25;index+=1) {
  const queueSupplier = suppliers.createSupplier(db,workspace.ctx,membership,{name:`Queue Verification Supplier ${String(index).padStart(2,'0')}`});
  orders.createOrder(db,workspace.ctx,membership,{supplierId:queueSupplier.id,destinationLocationId:workspace.main.id,
    lines:[{skuId:allocationItem.skuId,quantityUnits:1,unitCost:1}]});
}
modes.setMode(db,workspace.ctx,membership,'POLICY_AUTOMATED');
const server = app.listen(0,'127.0.0.1',() => process.send({type:'ready',port:server.address().port,
  email:workspace.account.email,password:workspace.account.password,supplierId:supplier.id,economicSkuId:economic.skuId,
  timingSkus,allocationOrders,waitingOrderId,pickedOrderId:allocationOrders[1],earlyOrderId:allocationOrders[149],
  allocationPurchaseId:allocationPurchase.id,allocationPurchaseLineId:allocationPurchase.lines[0].id}));
process.on('SIGTERM',() => server.close(() => {db.close();process.exit(0);}));

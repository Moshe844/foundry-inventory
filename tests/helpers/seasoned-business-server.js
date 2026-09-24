'use strict';

if (process.env.NODE_ENV !== 'test' || !process.env.DATABASE_PATH) {
  throw new Error('This fixture requires an isolated test database.');
}

const { advance } = require('./business-clock');
const { openDatabase } = require('../../src/db');
const { seedWorkspace, makeQuantityItem } = require('../helpers');
const inventory = require('../../src/domain/inventory-engine');
const suppliers = require('../../src/purchasing/supplier-service');
const { createApp } = require('../../src/app');
const scheduler = require('../../src/autopilot/scheduler');
const modes = require('../../src/autopilot/modes');

const db = openDatabase(process.env.DATABASE_PATH);
advance('2026-03-16T12:00:00.000Z');
const workspace = seedWorkspace(db, { workspaceName: 'Six Month Outfitters',
  email: 'calendar@example.test', password: 'calendar-business-2026' });
const membership = { role: 'owner', id: workspace.ownerId, workspace_id: workspace.workspaceId };
db.prepare(`INSERT INTO workspace_configuration (workspace_id,configured_at,configuration_version,
  terminology,operational_defaults,inventory_model,updated_at) VALUES (?,?,1,'{}',?,?,?)`)
  .run(workspace.workspaceId,new Date().toISOString(),JSON.stringify({allowNegativeStock:false,transfersEnabled:true}),
    JSON.stringify({primaryArchetype:'quantity',usesVariants:false}),new Date().toISOString());
const fast = makeQuantityItem(db,workspace.ctx,{name:'Weekend Bestseller',baseCode:'WEEKEND'});
const steady = makeQuantityItem(db,workspace.ctx,{name:'Weekday Staple',baseCode:'STAPLE'});
const slow = makeQuantityItem(db,workspace.ctx,{name:'Slow Shelf Item',baseCode:'SLOW'});
const supplier = suppliers.createSupplier(db,workspace.ctx,membership,{name:'Calendar Supplier',defaultLeadTimeDays:7});
for (const item of [fast,steady]) {
  suppliers.linkItem(db,workspace.ctx,membership,{supplierId:supplier.id,skuId:item.skuId,
    purchaseUnit:'case',unitsPerPurchaseUnit:6,lastUnitCost:12,leadTimeDays:7,
    minimumOrderQuantity:2,orderMultiple:2,isPreferred:true});
}
const start = Date.parse('2026-03-16T12:00:00.000Z');
const end = Date.parse('2026-09-11T12:00:00.000Z');
const days = [];
for (let at=start;at<end;at+=86400000) {
  const weekday=new Date(at).getUTCDay();
  days.push({at,fast:weekday===0||weekday===6?8:2,steady:weekday===0||weekday===6?0:3});
}
inventory.receive(db,workspace.ctx,{skuId:fast.skuId,locationId:workspace.main.id,quantity:days.reduce((sum,day)=>sum+day.fast,0)+8});
inventory.receive(db,workspace.ctx,{skuId:steady.skuId,locationId:workspace.main.id,quantity:days.reduce((sum,day)=>sum+day.steady,0)+5});
inventory.receive(db,workspace.ctx,{skuId:slow.skuId,locationId:workspace.main.id,quantity:300});
for (const day of days) {
  advance(new Date(day.at).toISOString());
  inventory.issue(db,workspace.ctx,{skuId:fast.skuId,locationId:workspace.main.id,quantity:day.fast,reasonCode:'sold'});
  if(day.steady) inventory.issue(db,workspace.ctx,{skuId:steady.skuId,locationId:workspace.main.id,quantity:day.steady,reasonCode:'sold'});
}
advance('2026-09-11T12:00:00.000Z');
const fresh=makeQuantityItem(db,workspace.ctx,{name:'Unobserved New Product',baseCode:'NEW'});
inventory.receive(db,workspace.ctx,{skuId:fresh.skuId,locationId:workspace.main.id,quantity:9});
const ledger = require('../../src/accounting/ledger');
ledger.configure(db,workspace.ctx,membership,{startDate:'2026-03-16',currency:'USD'});
for (const [skuId,postingDate,revenue,cost] of [
  [fast.skuId,'2026-06-15',10000,6000],
  [steady.skuId,'2026-06-15',90000,1000],
  [fast.skuId,'2026-08-15',20000,18000],
]) {
  ledger.post(db,workspace.ctx,{postingDate,sourceKey:`calendar-history:${skuId}:${postingDate}`,
    description:'Historical posted revenue and product cost',lines:[
      {accountKey:'CASH',debitMinor:revenue},
      {accountKey:'SALES_REVENUE',creditMinor:revenue,skuId,locationId:workspace.main.id},
      {accountKey:'COST_OF_GOODS_SOLD',debitMinor:cost,skuId,locationId:workspace.main.id},
      {accountKey:'INVENTORY_ASSET',creditMinor:cost,skuId,locationId:workspace.main.id},
    ]});
}
modes.ensure(db,workspace.workspaceId);
let aiProvider;
if(process.env.STOCKCHIEF_TEST_STALLED_READER==='1') {
  const provider=require('../../src/ai/provider').createProviderForTier('standard');
  aiProvider={complete(request){
    if(request.schemaName==='inventory_action_intent')return new Promise(()=>{});
    return provider.complete(request);
  }};
}
const app=createApp({db,env:'test',sessionSecret:'seasoned-business-browser-only',aiProvider});
const server=app.listen(Number(process.env.PORT||0),'127.0.0.1',()=>{
  if(process.send)process.send({type:'stockchief.test.ready',port:server.address().port,
    email:workspace.account.email,password:workspace.account.password,locationId:workspace.main.id,
    fastSkuId:fast.skuId,fastItemId:fast.itemId,steadySkuId:steady.skuId});
});
const stop=scheduler.start(db,{intervalMs:500,immediate:false});
process.on('SIGTERM',()=>{stop();server.close(()=>{db.close();process.exit(0);});});

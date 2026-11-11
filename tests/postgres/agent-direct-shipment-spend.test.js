'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

test('automatic direct purchases count actual weight, every approved order and charges against the account weekly limit',{timeout:720000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx}=f;
  const origin=process.env.FOUNDRY_PUBLIC_URL;
  process.env.FOUNDRY_PUBLIC_URL='https://stockchief.example.test';
  t.after(()=>{if(origin===undefined)delete process.env.FOUNDRY_PUBLIC_URL;else process.env.FOUNDRY_PUBLIC_URL=origin;});
  const direct=require('../../src/purchasing/agent-direct-shipments');
  const routines=require('../../src/purchasing/direct-shipment-routines');
  const policy=require('../../src/commercial/agent-plan');
  await f.subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await db.query("UPDATE suppliers SET email='weighted-direct@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
  const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Weight-priced supplier goods',
    baseCode:'DIRECT-WEIGHT-'+randomUUID().slice(0,8),trackingMode:'quantity',unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3});
  const skuId=item.skuIds[0];
  await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId,
    lastUnitCost:'7.50',purchaseUnit:'piece',unitsPerPurchaseUnit:1,minimumOrderQuantity:1,orderMultiple:1});
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,
    status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
    VALUES($1,$2,$1,'Weighted purchase mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'weighted-mailbox',now(),now())`,
    [connector,ctx.workspaceId,'connection_credentials:'+connector,ctx.actorId]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',
    {accessToken:'synthetic-token'}));
  async function customerOrder(weight){
    return f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',fulfillmentLocationId:f.location.id,deliveryMethod:'SHIP',
      idempotencyKey:randomUUID(),lines:[{skuId,quantity:1,secondaryQuantity:weight,unitPriceMinor:1500}]});
  }
  const referenceOrder=await customerOrder('80');
  const reference=await direct.prepare(db,ctx,{salesOrderId:referenceOrder.salesOrderId,supplierId:'fixture-supplier',
    requestKey:randomUUID(),confirmed:'yes',lines:[{lineId:referenceOrder.lineIds[0],quantity:1,secondaryQuantity:'80'}]});
  const rule=await routines.configure(db,ctx,reference.id,{confirmed:'yes',revision:0,sourceHash:reference.source_hash,
    maximum:'1000.00',connectorId:connector});
  const jobs=require('../../src/operations/postgres-job-queue');
  const handler=require('../../src/operations/postgres-runtime-handlers').create()[routines.kind];
  const approved=[];
  for(let index=0;index<8;index++){
    const order=await customerOrder('80');
    await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
    const completed=await jobs.processOne(db,{[routines.kind]:handler},{owner:'weighted-direct-limit'});
    assert.equal(completed.status,'COMPLETED',JSON.stringify(completed.lastError));
    const purchase=(await db.query(`SELECT d.purchase_order_id,p.status FROM stockchief_runtime.agent_direct_orders d
      JOIN purchase_orders p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_id
      WHERE d.workspace_id=$1 AND d.sales_order_id=$2 AND d.rule_id=$3`,[ctx.workspaceId,order.salesOrderId,rule.id])).rows[0];
    assert(purchase,JSON.stringify({index,result:completed.result,rule:(await db.query(
      'SELECT last_issue FROM stockchief_runtime.agent_direct_rules WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,rule.id])).rows[0]}));
    assert.equal(purchase.status,'APPROVED');
    assert.equal(await require('../../src/operations/postgres-team-access').purchaseAmount(db,ctx.workspaceId,
      {id:purchase.purchase_order_id,currency:'USD'}),60000);
    approved.push(purchase.purchase_order_id);
  }
  const overLimit=await customerOrder('40');
  await f.workflows.confirmSalesOrder(db,ctx,overLimit.salesOrderId,{idempotencyKey:randomUUID()});
  const held=await jobs.processOne(db,{[routines.kind]:handler},{owner:'weighted-direct-limit'});
  assert.equal(held.status,'COMPLETED',JSON.stringify(held.lastError));
  assert.equal(held.result.held,1);
  assert.match((await db.query('SELECT last_issue FROM stockchief_runtime.agent_direct_rules WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,rule.id])).rows[0].last_issue,/weekly automatic purchasing limit/);
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_direct_orders WHERE workspace_id=$1 AND sales_order_id=$2',
    [ctx.workspaceId,overLimit.salesOrderId])).rows[0].n,0);
  assert.equal((await db.query('SELECT direct_committed_quantity::text FROM sales_order_lines WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,overLimit.lineIds[0]])).rows[0].direct_committed_quantity,'0');
  const state=await policy.accountState(db,ctx.workspaceId);
  const candidate={supplierId:'fixture-supplier',skuId,currency:'USD',value:200,unitCost:'7.50',unitsPerPurchaseUnit:1};
  assert.equal(await policy.purchaseReview(db,ctx.workspaceId,candidate,{itemScope:[skuId]},state),null);
  await db.query(`INSERT INTO purchase_order_charges(id,workspace_id,purchase_order_id,label,kind,amount_minor,created_at)
    VALUES($1,$2,$3,'Known supplier freight','freight',1,now())`,[randomUUID(),ctx.workspaceId,approved[0]]);
  assert.match(await policy.purchaseReview(db,ctx.workspaceId,candidate,{itemScope:[skuId]},state),/weekly automatic purchasing limit/);
  assert.equal(await f.balance(),20);
});

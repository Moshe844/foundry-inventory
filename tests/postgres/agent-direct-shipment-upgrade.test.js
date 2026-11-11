'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

test('direct-shipping upgrade preserves existing stock, cost, customer reservations and migration identities',{timeout:720000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20,through:'340-agent-slack-commands.sql'});
  const {db,ctx}=f;
  await f.subscribe('growth');
  const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',fulfillmentLocationId:f.location.id,
    deliveryMethod:'SHIP',idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:3,unitPriceMinor:1500}]});
  await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
  assert.equal((await f.browser.get('/orders/'+order.salesOrderId)).status,200);
  await f.parcel();
  const storage=require('../../src/commercial/storage-capacity');
  await storage.refresh(db,ctx.workspaceId);
  const baseline=await storage.state(db,f.owner.accountId);
  const nativeRelations=['purchase_orders','sales_order_lines','purchase_order_receipt_lines','sales_shipments','sales_shipment_lines'];
  const nativeBytes=async()=>(await db.query(`SELECT relation::text,baseline_bytes::text AS bytes FROM commercial_storage_usage
    WHERE workspace_id=$1 AND relation::text=ANY($2::text[]) ORDER BY relation::text`,[ctx.workspaceId,nativeRelations])).rows;
  const beforeBytes=await nativeBytes();
  assert.equal(beforeBytes.length,nativeRelations.length);
  const previous=(await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows;
  const cost=(await db.query('SELECT * FROM accounting_inventory_cost_balances WHERE workspace_id=$1 ORDER BY sku_id,location_id',[ctx.workspaceId])).rows;
  const reservations=(await db.query('SELECT * FROM sales_order_allocations WHERE workspace_id=$1 ORDER BY id',[ctx.workspaceId])).rows;
  const migrate=require('../../src/db/migrate-postgres').migratePostgres;
  assert((await migrate(db)).includes('341-agent-supplier-direct.sql'));
  assert.equal(await storage.state(db,f.owner.accountId),baseline);
  await storage.refresh(db,ctx.workspaceId);
  assert.deepEqual(await nativeBytes(),beforeBytes);
  assert.deepEqual((await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows.slice(0,previous.length),previous);
  assert.deepEqual((await db.query('SELECT * FROM accounting_inventory_cost_balances WHERE workspace_id=$1 ORDER BY sku_id,location_id',[ctx.workspaceId])).rows,cost);
  assert.deepEqual((await db.query('SELECT * FROM sales_order_allocations WHERE workspace_id=$1 ORDER BY id',[ctx.workspaceId])).rows,reservations);
  assert.equal((await db.query('SELECT direct_committed_quantity::text FROM sales_order_lines WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,order.lineIds[0]])).rows[0].direct_committed_quantity,'0');
  assert.equal(await f.balance(),20);
  await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:f.item.skuIds[0],
    lastUnitCost:'7.5',purchaseUnit:'unit',unitsPerPurchaseUnit:1,minimumOrderQuantity:1,orderMultiple:1});
  const direct=require('../../src/purchasing/agent-direct-shipments');
  const input={salesOrderId:order.salesOrderId,supplierId:'fixture-supplier',requestKey:randomUUID(),confirmed:'yes',
    lines:[{lineId:order.lineIds[0],quantity:3}]};
  await assert.rejects(direct.prepare(db,ctx,input),/first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const prepared=await direct.prepare(db,ctx,input);
  const decision={confirmed:'yes',revision:prepared.revision,sourceHash:prepared.source_hash};
  await assert.rejects(direct.approve(db,ctx,prepared.id,decision),/Confirm releasing/);
  await direct.approve(db,ctx,prepared.id,{...decision,releaseReserved:'yes'});
  assert.equal((await db.query('SELECT count(*)::int n FROM sales_order_allocations WHERE workspace_id=$1 AND sales_order_line_id=$2',
    [ctx.workspaceId,order.lineIds[0]])).rows[0].n,0);
  assert.equal(await f.balance(),20);
  await storage.refresh(db,ctx.workspaceId);
  const afterBytes=await nativeBytes();
  for(const relation of ['purchase_orders','sales_order_lines']){
    assert(Number(afterBytes.find(row=>row.relation===relation).bytes)>Number(beforeBytes.find(row=>row.relation===relation).bytes));
  }
  assert.deepEqual(await migrate(db),[]);
  const removal=require('../../src/domain/postgres-workspace-removal');
  const inventory=await removal.describe(db,f.owner.accountId,ctx.workspaceId);
  await removal.remove(db,f.owner.accountId,ctx.workspaceId,{confirmName:inventory.workspace.name});
  assert((await db.query('SELECT deletion_requested_at FROM workspaces WHERE id=$1',[ctx.workspaceId])).rows[0].deletion_requested_at);
  await assert.rejects(direct.prepare(db,ctx,{...input,requestKey:randomUUID()}),/current inventory owner/);
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_direct_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
});

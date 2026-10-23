'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fixtures=require('../../scripts/environment-agent-demo/openai-certification-fixtures');
test('certification browser surfaces render with real tenant-scoped SELECT-only permissions and no business writes',async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 const cleanup=[()=>cluster.stop(),()=>db.close()];t.after(async()=>{for(const close of cleanup.reverse())await close();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const f=await fixtures.seed(db,fixtures.createTasks().find(t=>t.family==='parcel-readiness'));
 const server=await require('../../scripts/environment-agent-demo/inspection').createInspectionServer({cluster,database:db,ctx:f.ctx});cleanup.push(()=>server.close());
 const browser=await require('playwright').chromium.launch({headless:true});cleanup.push(()=>browser.close());
 const ui=await require('../../scripts/environment-agent-demo/browser').createBrowserTools(browser,{origin:server.origin});cleanup.push(()=>ui.close());
 const order=(await db.query('SELECT id FROM sales_orders WHERE workspace_id=$1',[f.ctx.workspaceId])).rows[0];
 const targets=[['/inventory/table'],['/inventory/new',true],['/purchasing/orders/'+f.po.purchaseOrderId],['/purchasing/orders/new',true],
  ['/suppliers'],['/accounting/receivables'],['/settings/connections'],['/accounting/receivables/new',true],['/accounting/banking'],
  ['/settings/shipping'],['/fulfilment/'+f.shipment.shipmentId,true],['/orders/'+order.id],['/reports/builder',true],
  ['/accounting/reports/profit-and-loss'],['/accounting/transactions'],['/settings'],['/autopilot',true],['/locations',true],
  ['/pricing/new',true],['/what-you-told-me'],['/settings/operations'],['/actions'],['/sales/customers/new',true],['/transfers/new',true]];
 const failures=[];
 // Direct setup/evaluator visits deliberately do not count as agent navigation.
 for(const [url,form]of targets){
  const response=await ui.page.goto(server.origin+url,{waitUntil:'domcontentloaded'});
  // Evaluator-only reachability setup: exercise the real intermediate screen,
  // never supply this route or interaction sequence to a paid agent.
  if(url==='/purchasing/orders/new')await ui.page.getByRole('link').filter({hasText:f.task.supplierName}).first().click();
  if(url==='/locations')await ui.page.locator('[data-modal-open="modal-location"]').click();
  if(url==='/pricing/new')await ui.page.getByRole('link',{name:'Set price',exact:true}).first().click();
  const screen=await ui.inspect();
  if(response.status()!==200)failures.push(`${url}: HTTP ${response.status()}`);
  if(form&&!screen.controls.some(c=>['input','textarea','select'].includes(c.tag)&&c.type!=='hidden'&&c.name&&!['q','search','_csrf'].includes(c.name)))failures.push(`${url}: missing business form`);
  assert.ok(!screen.text.includes('FOREIGN-CHECKPOINT-CANARY'),url);
 }
 assert.deepEqual(await fixtures.snapshot(db,f),f.before,'GET exploration must not mutate business records');
 assert.deepEqual(failures,[]);
});

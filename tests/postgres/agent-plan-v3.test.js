'use strict';
process.env.NODE_ENV='test';
process.env.FOUNDRY_PUBLIC_URL='https://fixture.example.test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const auth=require('../../src/domain/postgres-auth-service');
const autonomy=require('../../src/autopilot/postgres-service');
const agentPlan=require('../../src/commercial/agent-plan');
const commerce=require('../../src/operations/postgres-commerce');
const orders=require('../../src/operations/postgres-business-workflows');

test('paid subscriptions constrain real standing rules, PO creation and queued work', {timeout:240000}, async t=>{
  const cluster=await startCluster(), db=openPostgres(cluster.connectionString);
  t.after(async()=>{await db.close();await cluster.stop();});
  await migratePostgres(db);
  const owner=await auth.createBusiness(db,{name:'Plan owner',businessName:'Agent audit',email:randomUUID()+'@example.test',password:'Test!'+randomUUID()});
  const ctx={workspaceId:owner.workspaceId,actorId:owner.userId}, member={role:'owner'};
  async function subscribe(plan) {
    await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status)
      VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' LIMIT 1),'ACTIVE')
      ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id`,
      [randomUUID(),owner.accountId,plan]);
  }
  const supplier=await commerce.createSupplier(db,ctx,{name:'Repeat supplier',email:'repeat@example.test'});
  const location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Main',kind:'warehouse'});
  const catalog=require('../../src/domain/postgres-catalog-service');
  const item=await catalog.createItem(db,ctx,{name:'Trusted item',baseCode:'REPEAT',trackingMode:'quantity'});
  const sku=item.skuIds[0], code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  await commerce.linkSupplierItem(db,ctx,{supplierId:supplier.id,skuId:sku,lastUnitCost:10,unitsPerPurchaseUnit:1,minimumOrderQuantity:1,orderMultiple:1,isPreferred:true});
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,created_at,updated_at)
      VALUES($1,$2,$1,'Test mailbox','gmail','[]','{}','connected','[]',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId]);
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at)
     VALUES($1,$2,$3,$4,20,50,0,'manual',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId,sku,location.id]);
  const rule={purchaseEnabled:true,supplierIds:[supplier.id],trustedItemCodes:code,maximumValue:500,weeklyValue:2000};
  await subscribe('growth');
  assert.equal((await autonomy.getState(db,ctx.workspaceId)).mode,'OBSERVE');
  await assert.rejects(autonomy.configureRoutine(db,ctx,member,rule),/shadow/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '15 days')::text WHERE id=$1",[owner.accountId]);
  await assert.rejects(autonomy.configureRoutine(db,ctx,{role:'staff',permissions:'["ADMIN"]'},rule),/owner/);
  await assert.rejects(autonomy.configureRoutine(db,ctx,member,{...rule,maximumValue:500.01}),/500 per order/);
  await assert.rejects(autonomy.configureRoutine(db,ctx,member,{...rule,weeklyValue:2000.01}),/2000 per week/);
  await assert.rejects(autonomy.configureRoutine(db,ctx,member,{...rule,trustedItemCodes:''}),/trusted/);
  await assert.rejects(autonomy.configureRoutine(db,ctx,member,{...rule,transferEnabled:true,maximumQuantity:2}),/Pro/);
  await autonomy.configureRoutine(db,ctx,member,rule);
  await autonomy.setCapability(db,ctx,member,'supplier_emails',true);
  let plan=await autonomy.plan(db,ctx.workspaceId);
  assert.ok(plan.created.every(w=>w.approval_requirement!=='NONE'));
  assert.match(plan.created[0].policyEvaluation.reason,/first order/);
  const first=await orders.createPurchaseOrder(db,ctx,{supplierId:supplier.id,destinationLocationId:location.id,currency:'USD',
    lines:[{skuId:sku,quantityUnits:1,unitCost:10,destinationLocationId:location.id}],idempotencyKey:randomUUID()});
  await orders.approvePurchaseOrder(db,ctx,first.purchaseOrderId,{idempotencyKey:randomUUID()});
  await orders.placePurchaseOrder(db,ctx,first.purchaseOrderId,{idempotencyKey:randomUUID()});
  plan=await autonomy.plan(db,ctx.workspaceId);
  const pending=plan.created.find(w=>w.approval_requirement==='NONE');
  assert.ok(pending,'Growth can prepare a repeat order inside its ceiling');
  await subscribe('starter');
  const held=await autonomy.execute(db,ctx,pending.id);
  assert.equal(held.execution_status,'WAITING_FOR_APPROVAL');
  assert.equal(held.purchase_order_id,null);
  await assert.rejects(autonomy.configureRoutine(db,ctx,member,rule));
  await subscribe('pro');
  await assert.rejects(autonomy.configureRoutine(db,ctx,member,{...rule,maximumValue:1000.01}),/1000 per order/);
  await assert.rejects(autonomy.configureRoutine(db,ctx,member,{...rule,weeklyValue:5000.01}),/5000 per week/);
  await autonomy.configureRoutine(db,ctx,member,{...rule,transferEnabled:true,maximumQuantity:5,maximumValue:1000,weeklyValue:5000});
  await subscribe('growth');
  await autonomy.configureRoutine(db,ctx,member,rule);
  // A changed shortage is a new work item. The old reviewed item stays held.
  await db.query('UPDATE reorder_policies SET target_stock=49 WHERE workspace_id=$1',[ctx.workspaceId]);
  plan=await autonomy.plan(db,ctx.workspaceId);
  const repeat=plan.created.find(w=>w.approval_requirement==='NONE');assert.ok(repeat);
  const executed=await autonomy.execute(db,ctx,repeat.id);
  assert.equal(executed.execution_status,'EXECUTING');
  assert.ok(executed.purchase_order_id);
  assert.ok(executed.outcome.effectId,'Supplier email was queued in the same transaction');
  const outbound=(await db.query('SELECT body FROM supplier_communications WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,executed.outcome.communicationId])).rows[0];
  const token=outbound.body.match(/fixture\.example\.test\/supplier\/order\/([A-Za-z0-9_-]{43})/)[1];
  const links=require('../../src/purchasing/supplier-order-link');
  assert.equal((await links.lookup(db,token)).id,executed.purchase_order_id);
  await assert.rejects(links.lookup(db,'x'.repeat(43)),/no longer active/);
  await links.submit(db,token,'confirm',null);
  await links.submit(db,token,'confirm',null);
  await assert.rejects(links.submit(db,token,'date','2040-02-31'),/valid delivery date/);
  await links.submit(db,token,'date','2040-01-14');
  await assert.rejects(links.submit(db,token,'invoice',Buffer.from('<html>')),/Choose a PDF/);
  for(const kind of ['invoice','ship-notice']) await links.submit(db,token,kind,Buffer.from('%PDF-1.4\nfixture'));
  assert.equal((await links.responses(db,ctx.workspaceId,executed.purchase_order_id)).length,4);
  assert.equal((await links.responses(db,'another-workspace',executed.purchase_order_id)).length,0);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'local-supplier-link-fixture'});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const browser=await require('playwright').chromium.launch();
  try {
    const page=await browser.newPage();
    await page.goto('http://127.0.0.1:'+server.address().port+'/supplier/order/'+token);
    assert.ok(await page.getByRole('heading',{name:/Purchase order/}).isVisible());
    await page.getByRole('button',{name:'Confirm this order'}).click();
    await page.getByText('Your response was saved.').waitFor();
    await page.locator('input[type=file]').setInputFiles({name:'invoice.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nBrowser fixture')});
    await page.getByRole('button',{name:'Upload document'}).click();
    await page.getByText('Your document was received.').waitFor();
    assert.equal((await links.responses(db,ctx.workspaceId,executed.purchase_order_id)).length,5);
  } finally {
    await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await app.locals.sessionStore.close();
  }
  assert.equal((await db.query('SELECT status FROM purchase_orders WHERE id=$1',[executed.purchase_order_id])).rows[0].status,'APPROVED');
  await subscribe('starter');
  const time=require('../../src/autopilot/time-saved');
  const measured=await time.report(db,ctx);
  assert.equal(measured.minutes,null);
  assert.deepEqual(measured.rows.map(r=>r.count),[0,5]);
  await assert.rejects(time.report(db,{...ctx,actorId:'another-owner'}),/owner/);
  const timing={activity:'supplier-response',manualMinutes:7,reviewMinutes:1,requestKey:randomUUID()};
  await time.sample(db,ctx,timing);await time.sample(db,ctx,timing);
  assert.equal((await time.report(db,ctx)).minutes,30);
  await time.sample(db,ctx,{...timing,requestKey:randomUUID(),activity:'repeat-order',manualMinutes:10,reviewMinutes:2});
  await db.query("UPDATE supplier_communications SET status='SENT',external_message_id='simulated-provider-receipt',sent_at=(now()-interval '8 days')::text WHERE id=$1",[executed.outcome.communicationId]);
  assert.equal((await time.report(db,ctx,'week')).minutes,30);
  assert.equal((await time.report(db,ctx,'month')).minutes,38);
  const beforeSend=await autonomy.evaluate(db,ctx.workspaceId,executed.recommendedAction,await autonomy.getState(db,ctx.workspaceId),{committedPurchaseOrderId:executed.purchase_order_id});
  assert.notEqual(beforeSend.decision,'authorized');
  const instructions=require('../../src/manager/postgres-operating-instructions');
  for(let i=0;i<6;i++){
    const name='RULE-'+i;
    await catalog.createItem(db,ctx,{name,baseCode:name,trackingMode:'quantity'});
    const draft=await instructions.prepareReorderForm(db,ctx,{sku:name,reorderPoint:4,targetStock:10});
    if(i<5) await instructions.approve(db,ctx,draft.id,draft.integrityHash);
    else await assert.rejects(instructions.approve(db,ctx,draft.id,draft.integrityHash),/5 active rules/);
  }
  const edit=await instructions.prepareReorderForm(db,ctx,{sku:'RULE-0',reorderPoint:5,targetStock:12});
  await instructions.approve(db,ctx,edit.id,edit.integrityHash);
  await subscribe('enterprise');
  assert.equal(agentPlan.purchaseLimits(await agentPlan.accountState(db,ctx.workspaceId)),null);
  await autonomy.pause(db,ctx,{role:'accountant'},'Leaving for the day');
  await assert.rejects(autonomy.resume(db,ctx,{role:'staff'}),/owner/);
});

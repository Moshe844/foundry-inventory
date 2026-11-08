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
  assert.deepEqual(measured.rows.map(r=>[r.key,r.count]),[['repeat-order',0],['supplier-response',5],['staff-request',0],['invoice-match',0],['accounting-export',0]]);assert.equal(measured.coverage,5);
  await assert.rejects(time.report(db,{...ctx,actorId:'another-owner'}),/owner/);
  const timing={activity:'supplier-response',manualMinutes:7,reviewMinutes:1,requestKey:randomUUID()};
  await time.sample(db,ctx,timing);await time.sample(db,ctx,timing);
  assert.equal((await time.report(db,ctx)).minutes,30);
  await time.sample(db,ctx,{...timing,requestKey:randomUUID(),activity:'repeat-order',manualMinutes:10,reviewMinutes:2});
  await db.query("UPDATE supplier_communications SET status='SENT',external_message_id='simulated-provider-receipt',sent_at=(now()-interval '8 days')::text WHERE id=$1",[executed.outcome.communicationId]);
  assert.equal((await time.report(db,ctx,'week')).minutes,30);
  assert.equal((await time.report(db,ctx,'month')).minutes,38);
  const connector=(await db.query("SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND provider_type='gmail'",[ctx.workspaceId])).rows[0];
  const mail=require('../../src/connections/postgres-outbound-mail'),sendKey=randomUUID();
  const manual={recipientKind:'supplier',recipientId:supplier.id,recipientEmail:'repeat@example.test',connectorId:connector.id,
    subject:'Approved order',body:'Please confirm this purchase order.',purchaseOrderId:first.purchaseOrderId};
  const queueManual=(payload,key)=>db.transaction(c=>mail.queueInTransaction(c,ctx,payload,key));
  const starterMessage=await queueManual(manual,sendKey);
  assert.equal((await queueManual(manual,sendKey)).communicationId,starterMessage.communicationId);
  await assert.rejects(queueManual({...manual,purchaseOrderId:executed.purchase_order_id},sendKey),/different message/);
  const starterBody=(await db.query('SELECT body FROM supplier_communications WHERE id=$1',[starterMessage.communicationId])).rows[0].body;
  assert.equal((await links.lookup(db,starterBody.split('/supplier/order/')[1])).id,first.purchaseOrderId);
  const scope={accountId:owner.accountId,workspaceId:ctx.workspaceId},ent=require('../../src/commercial/entitlements');
  const used={meter:'agent_documents',units:49,idempotencyKey:'already-processed'};
  await ent.reserveUsage(db,scope,used);await ent.commitUsage(db,scope,used);
  const capture=require('../../src/connections/postgres-mail').capture,extract=require('../../src/connections/postgres-attachments').extractMessage;
  async function doc(name) {
    const note=await capture(db,{...connector,workspace_id:ctx.workspaceId,provider_type:'gmail'},{messageId:randomUUID(),sender:'repeat@example.test',
      subject:'Supplier file',bodyText:'Attached',attachments:[{filename:name,mimeType:'text/plain',contentBase64:Buffer.from('Confirmed units and order reference').toString('base64')}]});
    return note.messageId;
  }
  assert.equal((await extract(db,ctx.workspaceId,await doc('unsupported.foo'))).attachments[0].status,'NEEDS_REVIEW');
  const lastIncluded=await doc('fiftieth.txt'),overLimit=await doc('fifty-first.txt');
  assert.equal((await extract(db,ctx.workspaceId,lastIncluded)).attachments[0].status,'READABLE');
  assert.equal((await extract(db,ctx.workspaceId,lastIncluded)).attachments[0].status,'READABLE');
  assert.equal((await extract(db,ctx.workspaceId,overLimit)).attachments[0].status,'NEEDS_REVIEW');
  assert.equal((await ent.meterState(db,scope,'agent_documents')).used,50);
  await subscribe('growth');
  assert.equal((await extract(db,ctx.workspaceId,overLimit)).attachments[0].status,'READABLE');
  assert.equal((await ent.meterState(db,scope,'agent_documents')).used,51);
  await subscribe('starter');
  const assistant=require('../../src/assistant/postgres-service');
  const expensiveActions=[
    ['manufacturing.create_work_order',14],['sales_order.reserve_all',12],['sales_order.allocation_priority',65],
    ['warehouse.wave.scan',57],['customer_return.inspect',113],['shipping.return_parcel',112],
    ['customer_return.receive',114],['supplier_return.reconcile',115],['connection.accounting_export',184]
  ];
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const available=await require('../../src/assistant/postgres-discovery').available(db,ctx);
    for(const [action,job] of expensiveActions){
      assert.equal(agentPlan.actionJob(action,'draft'),job);
      if(agentPlan.permits(tier,job,'draft'))continue;
      assert.ok(!available.some(c=>c.name===action),tier+' discovery '+action);
      await assert.rejects(assistant.createProposal(db,ctx,'Review this action',action,{},'Review'),e=>e.code==='entitlement_required',tier+' proposal '+action);
    }
  }
  await subscribe('starter');
  const refund=()=>assistant.createProposal(db,ctx,'Prepare refund','customer_return.refund',{},'Review refund.');
  await assert.rejects(refund(),/Pro/);
  await subscribe('growth');await assert.rejects(refund(),/Pro/);
  await subscribe('pro');const preparedRefund=await refund();
  await subscribe('starter');
  await assert.rejects(assistant.executeProposal(db,ctx,preparedRefund.proposal.id),/Pro/);
  const savedRefund=await assistant.getProposal(db,ctx.workspaceId,preparedRefund.proposal.id);
  assert.equal(savedRefund.status,'PENDING');
  const followup={...manual,followUpPhase:'supplier_delivery_late',subject:'Late delivery',body:'Please confirm the outstanding delivery.'};
  await assert.rejects(assistant.createProposal(db,ctx,'Chase this delivery','communication.send_email',followup,'Ask the supplier for a date.'),/Growth/);
  await assert.rejects(assistant.createProposal(db,ctx,'Email the supplier','communication.send_email',{...manual,purchaseOrderId:null},'Discuss buying terms.'),/Growth/);
  await subscribe('growth');
  const chase=await assistant.createProposal(db,ctx,'Chase this delivery','communication.send_email',followup,'Ask the supplier for a date.');
  const tracked=await assistant.executeProposal(db,ctx,chase.proposal.id);
  const effect=(await db.query('SELECT payload FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,tracked.result.effectId])).rows[0];
  assert.equal(effect.payload.agentJob,30);
  // Exercise a queued delivery created before the job marker existed.
  await db.query("UPDATE stockchief_runtime.provider_effects SET payload=payload-'agentJob' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,tracked.result.effectId]);
  await subscribe('starter');
  let providerCalls=0;
  await assert.rejects(mail.executeSendEffect(db,ctx.workspaceId,tracked.result.effectId,{provider:{send:async()=>{providerCalls++;return {externalMessageId:'incorrect-delivery'};}}}),/Growth/);
  assert.equal(providerCalls,0);
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

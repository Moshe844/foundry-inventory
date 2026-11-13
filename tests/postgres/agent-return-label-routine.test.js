'use strict';process.env.NODE_ENV='test';
// Job 112 on every plan: an authorized return gets its label bought through
// the connected carrier account (job 59 limits) from the customer's checked
// address (job 69), and the label and instructions go out through the
// connected mailbox. A test carrier and a test mailbox stand in for the live ones.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function setup(t,plan){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:60}),{db,ctx}=f;await f.subscribe('pro');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const auto=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');await f.subscribe(plan);
 const connector=randomUUID();await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
  VALUES($1,$2,$1,'Returns mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'returns-mailbox',now(),now())`,[connector,ctx.workspaceId,'connection_credentials:'+connector,ctx.actorId]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',{accessToken:'test-token'}));
 const state={buys:0,price:900,rates:true};
 const carrier={quote:async()=>({providerShipmentIds:['return-parcel'],rates:state.rates?[{rateId:'ground',carrier:'usps',service:'Ground Advantage',amountMinor:state.price,currency:'USD',deliveryDays:3},
   {rateId:'priority',carrier:'usps',service:'Priority Mail',amountMinor:state.price+700,currency:'USD',deliveryDays:1}]:[]}),
  buy:async(_ctx,input)=>{state.buys++;return {providerLabelIds:['return-label-'+state.buys],providerShipmentId:'return-label-'+state.buys,trackingNumber:'RETURN'+state.buys,
   labelUrl:'https://labels.example.test/return-'+state.buys+'.pdf',labelFormat:'PDF',amountMinor:input.approvedAmountMinor,currency:'USD',carrier:'usps',service:'Ground Advantage'};}};
 const labels=require('../../src/shipping/agent-return-labels'),returns=require('../../src/operations/postgres-returns'),mail=require('../../src/connections/postgres-outbound-mail');
 const sent=[],mailbox={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}};
 async function rma(quantity=1){
  const outbound=await f.parcel({quantity});await f.shipping.handoff(db,ctx,outbound.shipmentId,{trackingNumber:'OUT-'+randomUUID(),idempotencyKey:randomUUID()});
  const r=await returns.requestCustomerReturn(db,ctx,{salesOrderId:outbound.order.salesOrderId,quarantineLocationId:f.location.id,resolution:'NO_REFUND',reason:'Wrong size',idempotencyKey:randomUUID(),lines:[{salesOrderLineId:outbound.order.lineIds[0],quantity}]});
  await returns.authorizeCustomerReturn(db,ctx,r.customerReturnId,{idempotencyKey:randomUUID()});return {...r,id:r.customerReturnId,outbound};
 }
 const routine=()=>labels.run(db,{workspaceId:ctx.workspaceId},{providerResolver:()=>carrier});
 const parcelOf=async id=>(await db.query("SELECT * FROM sales_shipments WHERE workspace_id=$1 AND customer_return_id=$2 AND status<>'CANCELLED'",[ctx.workspaceId,id])).rows[0];
 const runOf=async id=>{const p=await parcelOf(id);return p?(await db.query('SELECT * FROM stockchief_runtime.agent_label_runs WHERE workspace_id=$1 AND shipment_id=$2 ORDER BY updated_at DESC LIMIT 1',[ctx.workspaceId,p.id])).rows[0]:null;};
 // The carrier and the mailbox finish whatever is queued.
 async function work(){
  for(const e of (await db.query("SELECT id,kind FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND status='PENDING' ORDER BY created_at",[ctx.workspaceId])).rows){
   if(e.kind==='shipping.label.purchase')await f.shipping.executeLabelPurchaseEffect(db,ctx.workspaceId,e.id,{provider:carrier});
   if(e.kind==='mail.outbound.send')await mail.executeSendEffect(db,ctx.workspaceId,e.id,{provider:mailbox});
  }
 }
 const cycle=async()=>{await routine();await work();await routine();await work();};
 const approve=async r=>{const run=await runOf(r.id);return labels.approve(db,ctx,r.id,{runId:run.id,confirmed:'yes'},{providerResolver:()=>carrier});};
 const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).filter(n=>/^return-label/.test(String(n.sourceId)));
 const limits=perLabel=>require('../../src/shipping/postgres-purchase-policy').save(db,ctx,{currency:'USD',perLabelMinor:perLabel,rollingDayMinor:null});
 const audits=async like=>(await db.query('SELECT action,after_state FROM security_event_history WHERE workspace_id=$1 AND action LIKE $2 ORDER BY created_at',[ctx.workspaceId,like])).rows;
 return {...f,auto,modes,connector,state,carrier,labels,returns,rma,routine,parcelOf,runOf,work,cycle,approve,needs,limits,sent,audits};
}

test('Starter is locked; Growth prepares each label for a tap until taught, then buys and emails alone within $25 and the taught limit',{timeout:300000},async t=>{
 const f=await setup(t,'starter'),{db,ctx,labels}=f;
 const locked=await f.rma();assert.deepEqual(await f.routine(),{skipped:'plan'});assert.equal(await f.parcelOf(locked.id),undefined);
 assert.deepEqual(await labels.view(db,ctx.workspaceId,locked.id),{locked:true});
 await assert.rejects(labels.approve(db,ctx,locked.id,{confirmed:'yes'}),e=>e.code==='entitlement_required');
 await f.subscribe('growth');await db.query("UPDATE customer_returns SET status='CANCELLED' WHERE id=$1",[locked.id]);
 const first=await f.rma();await f.routine();let run=await f.runOf(first.id);
 assert.deepEqual([run.status,run.mode],['SUGGESTED','draft']);assert.match(run.label_reason,/Approve this label/);assert.equal(f.state.buys,0);
 const parcel=await f.parcelOf(first.id);assert.match(JSON.stringify(parcel.return_origin),/10 Jobsite Rd/,'collected from the customer’s address');
 assert.equal(Number((await db.query('SELECT weight_grams FROM shipment_packages WHERE shipment_id=$1',[parcel.id])).rows[0].weight_grams),350,'the original parcel’s measured weight');
 assert.ok((await f.needs()).some(n=>n.actionLabel==='Approve the label'&&/Ground Advantage at \$9\.00/.test(n.happened)));
 await f.approve(first);run=await f.runOf(first.id);assert.equal(run.status,'QUEUED');assert.equal(run.decided_by,ctx.actorId);
 await f.cycle();assert.equal(f.state.buys,1);assert.equal(f.sent.length,1);
 assert.match(f.sent[0].body,/https:\/\/labels\.example\.test\/return-1\.pdf/);assert.match(f.sent[0].body,/1 × Parcel item/);assert.match(f.sent[0].body,/Return destination: Dispatch/);
 let page=await labels.view(db,ctx.workspaceId,first.id);assert.equal(page.email.status,'SENT');assert.equal(page.canTeach,true);
 await assert.rejects(labels.configure(db,ctx,{locationId:f.location.id,connectorId:'not-a-mailbox',maximum:'50',currency:'USD',confirmed:'yes'}),/mailbox/);
 await labels.configure(db,ctx,{locationId:page.teachLocationId,connectorId:page.teachConnectorId,maximum:'50',currency:'USD',confirmed:'yes'});
 // Taught: the next one is bought and emailed alone, once.
 const second=await f.rma();await f.cycle();run=await f.runOf(second.id);
 assert.deepEqual([run.status,run.mode,run.decided_by],['QUEUED','automatic',null]);assert.equal(f.state.buys,2);assert.equal(f.sent.length,2);
 await f.cycle();assert.equal(f.state.buys,2,'running again buys nothing twice');assert.equal(f.sent.length,2,'and emails nothing twice');
 assert.equal((await db.query('SELECT count(*)::int n FROM shipping_label_transactions WHERE shipment_id=$1',[(await f.parcelOf(second.id)).id])).rows[0].n,1);
 // Over Growth's $25 a label, and over the taught goods limit: a tap again.
 f.state.price=2600;const dear=await f.rma();await f.routine();run=await f.runOf(dear.id);assert.equal(run.status,'SUGGESTED');assert.match(run.label_reason,/\$25/);
 f.state.price=900;const big=await f.rma(5);await f.routine();run=await f.runOf(big.id);assert.equal(run.status,'SUGGESTED');assert.match(run.label_reason,/worth more than the \$50\.00/);
 assert.equal(f.state.buys,2);
 assert.deepEqual((await f.audits('Bought a return label%')).map(a=>a.after_state.automatic),[true]);
 assert.deepEqual((await f.audits('Emailed the return label%')).map(a=>a.action),['Emailed the return label and instructions after approval','Emailed the return label and instructions on its own']);
 // Removing the rule puts Growth back to one tap each.
 await labels.configure(db,ctx,{remove:'yes'});const after=await f.rma();await f.routine();assert.equal((await f.runOf(after.id)).status,'SUGGESTED');
});

test('Pro and Custom buy and email alone within the owner’s $ per label; first emails, Ask me first, pause and shadow wait for a tap',{timeout:300000},async t=>{
 const f=await setup(t,'pro'),{db,ctx,labels}=f;
 const first=await f.rma();await f.routine();let run=await f.runOf(first.id);assert.equal(run.status,'SUGGESTED');assert.match(run.label_reason,/\$ per label/);
 await f.limits(2000);await f.routine();run=await f.runOf(first.id);assert.equal(run.status,'SUGGESTED');assert.match(run.label_reason,/first email/);
 await f.approve(first);await f.cycle();assert.equal(f.sent.length,1);
 for(const plan of ['pro','enterprise']){
  await f.subscribe(plan);const r=await f.rma();
  // The routine's own cycle finds the waiting return.
  assert.deepEqual(await db.transaction(c=>require('../../src/shipping/agent-return-labels').schedule(c,ctx.workspaceId,'schedule-'+plan)),{queued:true},plan);
  await f.cycle();run=await f.runOf(r.id);
  assert.deepEqual([run.status,run.mode,run.decided_by],['QUEUED','automatic',null],plan);
 }
 assert.equal(f.sent.length,3);assert.equal(f.state.buys,3);
 f.state.price=2500;const dear=await f.rma();await f.routine();run=await f.runOf(dear.id);assert.equal(run.status,'SUGGESTED');assert.match(run.label_reason,/per-parcel postage limit/);f.state.price=900;
 await f.modes.save(db,ctx,112,{mode:'ask',revision:0});const ask=await f.rma();await f.routine();assert.match((await f.runOf(ask.id)).label_reason,/Ask me first/);
 await f.modes.save(db,ctx,112,{mode:'inherit',revision:1});
 await f.auto.pause(db,ctx,{role:'owner'},'Owner pause');const paused=await f.rma();await f.routine();assert.match((await f.runOf(paused.id)).label_reason,/paused/i);
 await f.auto.resume(db,ctx,{role:'owner'});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);const watched=await f.rma();await f.routine();assert.match((await f.runOf(watched.id)).label_reason,/14 days/);
 await assert.rejects(f.approve(watched),/14 days/);
 assert.equal(f.state.buys,3,'nothing bought while waiting for a tap');
 // A bought label whose email is paused waits in Needs you for one tap.
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await f.routine();await f.work();const queued=await f.runOf(paused.id);assert.equal(queued.status,'QUEUED');
 await f.auto.pause(db,ctx,{role:'owner'},'Pause before the email');await f.routine();
 assert.match((await f.runOf(paused.id)).reason,/paused/i);assert.ok((await f.needs()).some(n=>n.actionLabel==='Send the email'));
 await f.auto.resume(db,ctx,{role:'owner'});await labels.send(db,ctx,paused.id,{confirmed:'yes'});await f.work();assert.equal(f.sent.length,4);
});

test('missing or mismatched facts stop and ask: an unconfirmed address, no measured weight, no rates; pickups need no label',{timeout:300000},async t=>{
 const f=await setup(t,'enterprise'),{db,ctx}=f;await f.limits(5000);
 const flagged=await f.rma();
 await db.query(`INSERT INTO stockchief_runtime.agent_address_checks(id,workspace_id,shipment_id,fingerprint,address,result,hold,hold_reason)
  SELECT 'check-'||id,workspace_id,id,'flagged',ship_to_address,'UNDELIVERABLE','undeliverable','The carrier says it cannot deliver to this address.' FROM sales_shipments WHERE id=$1`,[flagged.outbound.shipmentId]);
 await f.routine();let run=await f.runOf(flagged.id);assert.deepEqual([run.status,run.hold],['HELD','address']);assert.match(run.reason,/address check flagged/);
 await db.query("UPDATE stockchief_runtime.agent_address_checks SET decision='KEPT',decided_by=$2,decided_at=now() WHERE shipment_id=$1",[flagged.outbound.shipmentId,ctx.actorId]);
 await f.routine();run=await f.runOf(flagged.id);assert.notEqual(run.status,'HELD','a person confirmed the address');
 const unweighed=await f.rma();await db.query("UPDATE shipment_packages SET weight_source='ESTIMATED' WHERE shipment_id=$1",[unweighed.outbound.shipmentId]);
 await f.routine();run=await f.runOf(unweighed.id);assert.deepEqual([run.status,run.hold],['HELD','parcel']);assert.match(run.reason,/weight of the return parcel/);
 f.state.rates=false;const quiet=await f.rma();await f.routine();run=await f.runOf(quiet.id);assert.deepEqual([run.status,run.hold],['HELD','rates']);f.state.rates=true;
 const asks=await f.needs();for(const r of [flagged.id,unweighed.id,quiet.id].slice(1))assert.ok(asks.some(n=>n.href==='/returns/'+r+'#return-label'),'Needs you lists '+r);
 // Picked up in person: no carrier parcel went out, so there is nothing to buy.
 const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:1200}]});
 await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});await f.workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:order.lineIds[0],quantity:1,locationId:f.location.id}],shipment:{handover:'COLLECTED'}});
 const pickup=await f.returns.requestCustomerReturn(db,ctx,{salesOrderId:order.salesOrderId,quarantineLocationId:f.location.id,resolution:'NO_REFUND',idempotencyKey:randomUUID(),lines:[{salesOrderLineId:order.lineIds[0],quantity:1}]});
 await f.returns.authorizeCustomerReturn(db,ctx,pickup.customerReturnId,{idempotencyKey:randomUUID()});await f.routine();
 assert.equal(await f.parcelOf(pickup.customerReturnId),undefined);assert.equal(f.state.buys,0);
});

test('the return page shows the prepared label at desktop width and on a phone, and one tap buys and emails it',{timeout:300000},async t=>{
 const f=await setup(t,'growth'),{db,ctx}=f;const r=await f.rma();await f.routine();
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(res=>{const s=app.listen(0,'127.0.0.1',()=>res(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(res=>server.close(res));await app.locals.sessionStore.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 for(const viewport of [{width:1366,height:900},{width:390,height:844}]){
  const page=await browser.newPage({viewport});page.setDefaultTimeout(12000);
  await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(origin+'/returns/'+r.id);const card=page.locator('#return-label');
  assert.match(await card.innerText(),/Return label from StockChief[\s\S]*Ground Advantage at \$9\.00/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no sideways scroll at '+viewport.width);
  if(viewport.width===390){await page.getByLabel('Buy this label and email it to the customer.').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve the label',exact:true}).click()]);
   assert.match(await page.locator('#return-label').innerText(),/Buying the label/);}
  await page.close();
 }
 await f.cycle();assert.equal(f.sent.length,1);
});

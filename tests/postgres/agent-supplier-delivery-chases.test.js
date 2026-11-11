'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const ownership=require('../../src/operations/postgres-workflow-ownership');
const chases=require('../../src/purchasing/agent-supplier-delivery-chases');
const outbound=require('../../src/connections/postgres-outbound-mail');
const jobs=require('../../src/operations/postgres-job-queue');

test('Growth authorizes late reminders for placed orders without teaching and sends only inside the current supplier rule',{timeout:300000},async t=>{
  const priorOrigin=process.env.FOUNDRY_PUBLIC_URL;
  process.env.FOUNDRY_PUBLIC_URL='https://stockchief.example.test';
  t.after(()=>{if(priorOrigin===undefined)delete process.env.FOUNDRY_PUBLIC_URL;else process.env.FOUNDRY_PUBLIC_URL=priorOrigin;});
  const f=await require('../helpers/agent-claim-fixture').fixture(t,'growth'),{db,ctx,workflows}=f;
  const day=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const offset=days=>require('../../src/accounting/customer-money').addDays(day,days);
  const input={supplierId:'fixture-supplier',expectedRecipient:'damage@example.test',connectorId:f.connectorId,
    maximumMessages:2,intervalHours:24,confirmed:'yes'};
  const chosen=chases.path+'?supplierId=fixture-supplier';
  await f.subscribe('starter');
  const locked=await f.browser.get(chosen).expect(200);
  assert.match(locked.text,/Late supplier reminders require Growth/);
  assert.doesNotMatch(locked.text,/name="maximumMessages"/);
  await f.browser.post(chases.path).set('Accept','application/json').type('form').send({_csrf:f.csrf(locked.text),...input}).expect(402);
  await f.subscribe('growth');
  const page=await f.browser.get(chosen).expect(200);
  assert.match(page.text,/damage@example.test/);
  await assert.rejects(chases.configure(db,ctx,{...input,expectedRecipient:'old@example.test'}),/email changed/);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
  const browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const origin='http://127.0.0.1:'+server.address().port;
  const errors=[];
  phone.on('pageerror',error=>errors.push(error.message));
  phone.setDefaultTimeout(15000);
  await phone.goto(origin+'/login');
  await phone.getByLabel('Work email').fill(f.email);
  await phone.locator('[name=password]').fill(f.password);
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await phone.goto(origin+chosen);
  await phone.getByLabel('Sending mailbox').selectOption(f.connectorId);
  await phone.getByLabel('Maximum reminders for each late order').fill('2');
  await phone.getByLabel('Minimum hours between late reminders').fill('24');
  await phone.locator('[name=confirmed]').check();
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Authorize late-delivery reminders',exact:true}).click()]);
  const settingsHref=new URL(phone.url()).pathname;
  const ruleId=settingsHref.split('/').at(-1);
  assert.match(await phone.locator('main').innerText(),/2 per late order/);
  assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);

  async function order(expectedDate=offset(-2),{place=true}={}){
    const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
      orderDate:offset(-5),expectedDate,idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:4,unitCost:1}]});
    await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    if(place)await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    const work=(await db.query('SELECT id FROM work_items WHERE workspace_id=$1 AND idempotency_key=$2',
      [ctx.workspaceId,'business-outcome:purchase:'+po.purchaseOrderId])).rows[0];
    return {...po,workId:work.id};
  }
  const state=async po=>(await db.query('SELECT outcome::jsonb FROM work_items WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,po.workId])).rows[0].outcome;
  const effects=async po=>(await state(po)).followUps||[];
  const refresh=(po,now)=>ownership.refresh(db,ctx.workspaceId,po.workId,now?{now}:{});
  const kind='agent.mail.purchase_followup.v1',handlers=require('../../src/operations/postgres-runtime-handlers').create({get:()=>f.provider});
  const send=()=>jobs.processOne(db,{[kind]:handlers[kind]},{owner:'synthetic-late-delivery-worker'});
  const savedTime=async()=>(await require('../../src/autopilot/time-saved').report(db,ctx)).rows.find(row=>row.key==='supplier-delivery-followup');

  const unsent=await order(offset(-2),{place:false});
  await refresh(unsent);
  assert.equal((await effects(unsent)).length,0);
  const future=await order(offset(4));
  await refresh(future);
  assert.equal((await effects(future)).length,0);
  const late=await order();
  const orderPage=await f.browser.get('/purchasing/orders/'+late.purchaseOrderId).expect(200);
  assert.match(orderPage.text,/Authorize reminders for this supplier/);
  assert.match(orderPage.text,/supplier-delivery-chases\?supplierId=fixture-supplier/);
  await Promise.all([refresh(late),refresh(late)]);
  const [first]=await effects(late);
  assert(first,JSON.stringify(await state(late)));
  assert.equal(first.ruleId,ruleId);
  assert(first.effectId);
  assert.equal((await savedTime()).count,0);
  assert.equal((await send()).status,'COMPLETED');
  assert.equal(f.sent.length,1);
  assert.match(f.sent[0].subject,/Delivery update for/);
  assert.match(f.sent[0].body,/4 ordered, 0 received/);
  assert.match(f.sent[0].body,/https:\/\/stockchief\.example\.test\/supplier\/order\//);
  assert.equal((await savedTime()).count,1);
  assert.equal((await savedTime()).minutes,null);
  await refresh(late,new Date(Date.now()+3*3600000));
  assert.equal((await effects(late)).length,1);
  await refresh(late,new Date(Date.now()+26*3600000));
  assert.equal((await effects(late)).length,2);
  assert.equal((await send()).status,'COMPLETED');
  await refresh(late,new Date(Date.now()+52*3600000));
  assert.equal((await effects(late)).length,2);
  assert.equal(f.sent.length,2);

  const stale=await order();
  await refresh(stale);
  const [pending]=await effects(stale);
  await assert.rejects(outbound.executeSendEffect(db,ctx.workspaceId,pending.effectId,{provider:f.provider,beforeSend:async()=>{
    await db.query('UPDATE purchase_orders SET expected_date=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,stale.purchaseOrderId,offset(4)]);
  }}),/delivery date, receipt or supplier evidence changed/);
  assert.equal(f.sent.length,2);

  const held=await order();
  const link=require('../../src/purchasing/supplier-order-link');
  const url=await db.transaction(tx=>link.issue(tx,ctx.workspaceId,held.purchaseOrderId,input.expectedRecipient,process.env.FOUNDRY_PUBLIC_URL));
  await require('../../src/purchasing/agent-backup-suppliers').supplierReply(db,new URL(url).pathname.split('/').at(-1),{
    lineId:held.lineIds[0],validThrough:offset(4),reason:'Goods on this order are currently unavailable.',confirmed:'yes'});
  await refresh(held);
  assert.equal((await state(held)).phase,'SUPPLIER_AVAILABILITY_REVIEW');
  assert.equal((await effects(held)).length,0);

  await f.subscribe('pro');
  const downgraded=await order();
  await refresh(downgraded);
  const [blocked]=await effects(downgraded);
  await f.subscribe('starter');
  await assert.rejects(outbound.executeSendEffect(db,ctx.workspaceId,blocked.effectId,{provider:f.provider}),/Growth/);
  const selected=await f.browser.get(settingsHref).expect(200);
  await f.browser.post(settingsHref).type('form').send({_csrf:f.csrf(selected.text),revision:1,stop:'yes'}).expect(303);
  assert.match((await f.browser.get(settingsHref).expect(200)).text,/Stopped/);
  assert.equal(f.sent.length,2);
  await f.subscribe('enterprise');
  assert.match((await f.browser.get(settingsHref).expect(200)).text,/Authorize late-delivery reminders/);
  await chases.configure(db,ctx,{...input,id:ruleId,revision:2});
  const reauthorized=await order();
  await refresh(reauthorized);
  const [custom]=await effects(reauthorized);
  await outbound.executeSendEffect(db,ctx.workspaceId,custom.effectId,{provider:f.provider});
  assert.equal(f.sent.length,3);

  await f.subscribe('growth');
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'SUPERVISED');
  const assistant=require('../../src/assistant/postgres-service');
  const manual=await order();
  await refresh(manual);
  const [draft]=await effects(manual);
  assert(draft.proposalId);
  assert.equal(draft.effectId,undefined);
  const accepted=await assistant.executeProposal(db,ctx,draft.proposalId);
  await outbound.executeSendEffect(db,ctx.workspaceId,accepted.result.effectId,{provider:f.provider});
  assert.equal(f.sent.length,4);
  const outdated=await order();
  await refresh(outdated);
  const [outdatedDraft]=await effects(outdated);
  const approved=await assistant.executeProposal(db,ctx,outdatedDraft.proposalId);
  await assert.rejects(outbound.executeSendEffect(db,ctx.workspaceId,approved.result.effectId,{provider:f.provider,beforeSend:async()=>{
    await db.query('UPDATE purchase_orders SET expected_date=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,outdated.purchaseOrderId,offset(5)]);
  }}),/delivery date, receipt or supplier evidence changed/);
  assert.equal(f.sent.length,4);
});

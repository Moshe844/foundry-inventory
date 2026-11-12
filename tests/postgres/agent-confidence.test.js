'use strict';
process.env.NODE_ENV='test';
process.env.FOUNDRY_PUBLIC_URL='https://fixture.example.test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const confidence=require('../../src/autopilot/confidence');
const autonomy=require('../../src/autopilot/postgres-service');

// Job 199 on every plan: each purchase order, transfer, count posting and
// tracking email shows how sure StockChief is (high, medium or low) with the
// reasons drawn from the facts that action checks. Below the owner's chosen
// level an automatic action waits for a person; when it is unsure it always asks.
test('purchases, transfers, counts and tracking emails show how sure StockChief is and ask below the owner’s level',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:4}),{db,ctx,browser,subscribe,shipping,location}=f,ws=ctx.workspaceId,owner={role:'owner'};
  const catalog=require('../../src/domain/postgres-catalog-service'),commerce=require('../../src/operations/postgres-commerce');
  const counts=require('../../src/operations/postgres-count-reviews'),countRules=require('../../src/autopilot/count-rules');
  const audits=async action=>(await db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n;
  const needs=async()=>require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId);
  const setLevel=async(minimum,status=303)=>{const page=await browser.get('/autopilot').expect(200);
    return browser.post('/autopilot/confidence').type('form').send({_csrf:f.csrf(page.text),minimum}).expect(status);};
  await subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '720 hours')::text WHERE id=$1",[f.owner.accountId]);

  // Routine purchasing from the usual supplier, inside the owner's limits.
  await db.query("UPDATE suppliers SET email='orders@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ws]);
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,
    credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
    VALUES($1,$2,$1,'Office mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'office-mailbox',now(),now())`,
    [connector,ws,'connection_credentials:'+connector,ctx.actorId]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,connector,'provider',{accessToken:'test-token'}));
  await autonomy.configureRoutine(db,ctx,owner,{purchaseEnabled:true,supplierIds:['fixture-supplier'],maximumValue:100,weeklyValue:400});
  await autonomy.setCapability(db,ctx,owner,'supplier_emails',true);
  const target=(skuId,point,stock)=>db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'manual',now()::text,now()::text)`,[randomUUID(),ws,skuId,location.id,point,stock]);
  const link=(skuId,lastUnitCost)=>commerce.linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId,purchaseUnit:'unit',unitsPerPurchaseUnit:1,lastUnitCost,orderMultiple:1,minimumOrderQuantity:1,isPreferred:true});
  // The fixture item was ordered from this supplier at $1.00; the new item never was.
  const known=f.item.skuIds[0],fresh=(await catalog.createItem(db,ctx,{name:'Fresh item',baseCode:'FRESH-'+randomUUID().slice(0,6),trackingMode:'quantity',purchaseCost:'2'})).skuIds[0];
  await link(known,1);await target(known,5,11);await link(fresh,2);await target(fresh,5,10);
  const planned=(await autonomy.plan(db,ws,{onlySkuIds:[known,fresh]})).created;
  const repeat=planned.find(w=>w.recommendedAction.skuId===known),first=planned.find(w=>w.recommendedAction.skuId===fresh);
  assert.deepEqual(repeat.recommendedAction.history,{orders:1,lastUnitCost:1,lastCurrency:'USD'});
  assert.equal(repeat.confidence,'high');assert.equal(repeat.evidenceQuality.level,'high');
  assert.deepEqual(repeat.evidenceQuality.missing,[]);
  assert.ok(repeat.evidenceQuality.found.includes('You have ordered this item from Fixture parts before.'));
  assert.ok(repeat.evidenceQuality.found.includes('The price matches your last order.'));
  assert.equal(first.confidence,'medium');assert.deepEqual(first.evidenceQuality.missing,['This is the first order of this item from Fixture parts.']);
  // Fairly sure is enough by default: both may go ahead on their own inside the limits.
  assert.equal(repeat.approval_requirement,'NONE',repeat.policyEvaluation.reason);
  assert.equal(first.approval_requirement,'NONE',first.policyEvaluation.reason);
  assert.equal((await confidence.settings(db,ws)).minimum,'medium');

  // The owner asks for very sure only. The medium order now waits; the high one still goes ahead.
  await setLevel('high');
  assert.equal(await audits('Changed how sure StockChief must be to act on its own'),1);
  const state=await autonomy.getState(db,ws);
  const asked=await autonomy.evaluate(db,ws,first.recommendedAction,state);
  assert.equal(asked.decision,'needs_approval');
  assert.match(asked.reason,/^How sure: medium\. This is the first order of this item from Fixture parts\. You asked StockChief to act on its own only when it is very sure/);
  assert.equal((await autonomy.evaluate(db,ws,repeat.recommendedAction,state)).decision,'authorized');
  const held=await autonomy.execute(db,ctx,first.id,{worker:true});
  assert.deepEqual([held.execution_status,held.approval_requirement],['WAITING_FOR_APPROVAL','REQUIRED'],'already authorized work rechecks and asks');
  assert.equal((await db.query('SELECT purchase_order_id FROM work_items WHERE workspace_id=$1 AND id=$2',[ws,first.id])).rows[0].purchase_order_id,null,'nothing was ordered');
  // The review page and Needs you show the level and the reasons.
  const review=await browser.get('/autopilot/work/'+first.id).expect(200);
  assert.match(review.text,/data-confidence="medium"/);assert.match(review.text,/Confidence: medium\./);
  assert.match(review.text,/This is the first order of this item from Fixture parts\./);assert.match(review.text,/The supplier, its unit price and currency are recorded\./);
  const waiting=(await needs()).find(n=>n.sourceId===first.id);
  assert.deepEqual([waiting.confidence.level,waiting.confidence.reasons[0]],['medium','This is the first order of this item from Fixture parts.']);
  assert.match((await browser.get('/needs-you/all').expect(200)).text,/Fresh item/);
  // A missing supplier price is low on every level: it stops and asks, and sending stays blocked.
  const unpriced={...first.recommendedAction,unitCost:null,value:null};
  assert.equal(confidence.purchase(unpriced).level,'low');
  assert.match((await autonomy.evaluate(db,ws,unpriced,state)).reason,/Confirm the supplier, currency and unit cost/);
  // A changed price is a reason to ask too.
  assert.deepEqual(confidence.purchase({...repeat.recommendedAction,unitCost:1.5,value:10.5}).missing,['The price differs from your last order (USD 1 then, USD 1.5 now).']);

  // Transfers use the source's spare stock and the destination's need.
  const move={type:'transfer',skuId:known,quantity:3,sourceLocationId:'a',destinationLocationId:'b',sourceAvailable:'10',sourceSafety:'4',destinationAvailable:'1',reorderPoint:'2'};
  assert.equal(confidence.transfer(move).level,'high');
  assert.equal(confidence.transfer({...move,sourceSafety:'8'}).level,'low');
  assert.deepEqual(confidence.transfer({...move,destinationAvailable:'5'}).missing,['The destination is above its reorder point.']);

  // Count postings: a first count at a location is medium, so at "very sure" it waits for the owner.
  await countRules.configure(db,ctx,{mode:'automatic',limit:'50'});
  const count=async quantity=>{const r=await counts.prepare(db,ctx,{locationId:location.id,submissionKey:randomUUID(),lines:[{skuId:known,quantity}]});
    return (await db.query('SELECT id,status,agent_decision,integrity_hash FROM physical_count_reviews WHERE workspace_id=$1 AND id=$2',[ws,r.id])).rows[0];};
  const firstCount=await count('3');
  assert.deepEqual([firstCount.status,firstCount.agent_decision.action,firstCount.agent_decision.confidence.level],['PENDING','review','medium']);
  assert.match(firstCount.agent_decision.reason,/^How sure: medium\. This is the first approved count at Dispatch\./);
  const countPage=await browser.get('/warehouse/counts/reviews/'+firstCount.id).expect(200);
  assert.match(countPage.text,/Confidence: medium\./);assert.match(countPage.text,/This is the first approved count at Dispatch\./);
  await counts.approve(db,ctx,firstCount.id,firstCount.integrity_hash);
  // Counted before and a small difference: high, so it posts on its own even at "very sure".
  const secondCount=await count('2');
  assert.deepEqual([secondCount.status,secondCount.agent_decision.action,secondCount.agent_decision.confidence.level],['COMPLETED','post','high']);
  assert.equal(await audits('Count left for a person: StockChief was not sure enough'),1);
  // A large difference is medium: it waits at "very sure" and posts at "fairly sure".
  const large=await count('0');
  assert.deepEqual([large.status,large.agent_decision.action],['PENDING','review']);
  assert.match(large.agent_decision.confidence.missing[0],/^Counted 0 of .* where your records say 2\.$/);
  await setLevel('medium');
  assert.deepEqual([(await count('0')).status],['COMPLETED']);
  await setLevel('high');
  await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:known,locationId:location.id,quantity:6,unitCost:'1.00',idempotencyKey:randomUUID()});

  // Tracking emails: the first email to an address is medium, so at "very sure" it waits; the next one is high and sends alone.
  const page=await browser.get('/fulfilment').expect(200);
  await browser.post('/fulfilment/settings/notices').set('Accept','application/json').type('form').send({_csrf:f.csrf(page.text),shippingNotice:'send',connectorId:connector}).expect(303);
  const runtime=require('../../src/operations/postgres-runtime-handlers').create(),mail=require('../../src/connections/postgres-outbound-mail');
  const mailbox={send:async({message})=>({externalMessageId:'accept-'+message.id})};
  const notice=async id=>(await db.query(`SELECT n.*,e.id effect FROM customer_communications n LEFT JOIN stockchief_runtime.provider_effects e
    ON e.workspace_id=n.workspace_id AND e.kind='mail.outbound.send' AND e.aggregate_id=n.id WHERE n.workspace_id=$1 AND n.shipment_id=$2 ORDER BY e.created_at DESC NULLS LAST`,[ws,id])).rows[0];
  let seq=0;
  const leave=async()=>{const p=await f.parcel({quantity:1});await shipping.markPacked(db,ctx,p.shipmentId);
    await shipping.handoff(db,ctx,p.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'1Z999AA10123457'+String(100+(++seq))});
    const {rows:[job]}=await db.query("SELECT * FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='agent.shipment-notice' AND payload->>'shipmentId'=$2",[ws,p.shipmentId]);
    await db.transaction(c=>runtime['agent.shipment-notice']({workspaceId:ws,payload:job.payload},c));return {id:p.shipmentId,note:await notice(p.shipmentId)};};
  const one=await leave();
  assert.equal(one.note.status,'PREPARED','the first email to this address waits at "very sure"');
  assert.equal(await audits('Tracking email left for a person: StockChief was not sure enough'),1);
  const item=(await needs()).find(n=>n.sourceId==='shipment-notice:'+one.note.id);
  assert.deepEqual([item.confidence.level,item.confidence.reasons[0]],['medium','This is the first email to this address.']);
  const shipmentPage=await browser.get('/fulfilment/'+one.id).expect(200);
  assert.match(shipmentPage.text,/Confidence: medium\./);assert.match(shipmentPage.text,/This is the first email to this address\./);
  await browser.post('/fulfilment/'+one.id+'/notice').type('form').send({_csrf:f.csrf(shipmentPage.text),version:one.note.updated_at,messageId:one.note.id,
    subject:one.note.subject,body:one.note.body,connectorId:connector,action:'send'}).expect(303);
  assert.equal((await mail.executeSendEffect(db,ws,(await notice(one.id)).effect,{provider:mailbox})).message.status,'SENT');
  const two=await leave();
  assert.equal(two.note.status,'QUEUED','the next email to a delivered address is high and sends on its own');

  // Every plan shows the level on the purchase review and lets the owner set it; only the owner can.
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    assert.match((await browser.get('/autopilot/work/'+first.id).expect(200)).text,/Confidence: medium\./,tier);
    const settings=await browser.get('/autopilot').expect(200);
    assert.match(settings.text,/How sure StockChief must be/,tier);assert.match(settings.text,/name="minimum" value="high" checked/,tier);
    assert.ok((await needs()).find(n=>n.sourceId===first.id)?.confidence,tier);
    const ask=await require('../../src/autopilot/job-reviews').run(db,ctx,'confidence');
    assert.ok(ask.rows.some(r=>r['How sure']==='Medium'&&/first order of this item/.test(r.Why)),tier);
  }
  await subscribe('pro');
  await assert.rejects(confidence.configure(db,{...ctx,actorId:'someone-else'},{minimum:'medium'}),/Only the business owner/);
  await assert.rejects(confidence.configure(db,ctx,{minimum:'low'}),/Choose how sure/);
  await setLevel('high');
  assert.equal(await audits('Changed how sure StockChief must be to act on its own'),3,'saving the same level again changes nothing');

  // The review and settings read well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const view=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});view.setDefaultTimeout(15000);
    await view.goto(base+'/login');await view.getByLabel('Work email').fill(f.email);await view.locator('[name=password]').fill(f.password);
    await Promise.all([view.waitForNavigation(),view.getByRole('button',{name:'Sign in',exact:true}).click()]);
    for(const [path,file] of [['/autopilot/work/'+first.id,'work'],['/autopilot#confidence','settings'],['/warehouse/counts/reviews/'+large.id,'count']]){
      await view.goto(base+path);
      await view.waitForTimeout(400);
      assert(await view.locator('[data-confidence]').first().isVisible(),path+' '+name);
      assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),path+' must not scroll sideways on '+name);
      await view.screenshot({path:require('node:path').join(folder,'confidence-'+file+'-'+name+'.png'),fullPage:true});
    }
    await view.close();
  }
});

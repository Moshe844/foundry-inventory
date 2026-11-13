'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{randomUUID}=crypto,request=require('supertest');

// Job 175 is alone on every plan: approve from email or phone. Once the owner
// chooses how approvals reach people (email from a connected mailbox, text or
// push), each approval waiting in someone's Needs you is sent to them once
// with its own link. Opening a link approves nothing. After sign-in, one tap
// approves through the approval's own service, checked again at that moment:
// still in that person's Needs you, unchanged since they looked, inside their
// permission and limit. Each approval is audited and recorded once. Sending
// waits for the first 14 days, Watch only and Ask me first. The mailbox, SMS
// and push providers are fakes; every number is a fictional 555 number.

function environment(t){
  const names=['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM_NUMBER','WEB_PUSH_PUBLIC_KEY','WEB_PUSH_PRIVATE_KEY','FOUNDRY_PUBLIC_URL'];
  const prior=Object.fromEntries(names.map(n=>[n,process.env[n]]));
  t.after(()=>{for(const n of names)if(prior[n]===undefined)delete process.env[n];else process.env[n]=prior[n];});
  const keys=crypto.createECDH('prime256v1');keys.generateKeys();const d=keys.getPrivateKey();
  Object.assign(process.env,{TWILIO_ACCOUNT_SID:'AC-test-only',TWILIO_AUTH_TOKEN:'test-only',TWILIO_FROM_NUMBER:'+15005550006',
    WEB_PUSH_PUBLIC_KEY:keys.getPublicKey().toString('base64url'),WEB_PUSH_PRIVATE_KEY:Buffer.concat([Buffer.alloc(32-d.length),d]).toString('base64url'),
    FOUNDRY_PUBLIC_URL:'https://stockchief.example.test'});
}
function senders(db){
  const texts=[],pushes=[],runtime=require('../../src/operations/postgres-runtime-handlers'),queue=require('../../src/operations/postgres-job-queue');
  const handlers=runtime.create(undefined,{smsSender:async m=>{assert.match(m.to,/^\+1555555\d{4}$/);texts.push(m);return {reference:'SM'+texts.length};},
    pushSender:async m=>{pushes.push(m);return {reference:'push-'+pushes.length};}});
  const drain=async()=>{for(let job;(job=await queue.processOne(db,handlers,{owner:'approval-link-test',kinds:['agent.alert-message']}));){}};
  return {texts,pushes,drain};
}
async function member(f,name,grants,extra={}){
  const auth=require('../../src/domain/postgres-auth-service'),authz=require('../../src/actions/permissions');
  const email=randomUUID()+'@example.test',account=await auth.createBusiness(f.db,{name,businessName:name+' home '+randomUUID().slice(0,6),email,password:f.password});
  const id='member-'+randomUUID();
  await f.db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,po_approval_limit_minor,po_approval_currency,created_at)
    VALUES($1,$2,$3,$4,'staff',$5,$6,$7,now()::text)`,[id,f.ctx.workspaceId,account.accountId,name,authz.encodeGrant(grants.map(g=>authz[g])),extra.limit??null,extra.limit==null?null:'USD']);
  const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID()});f.cleanup(()=>app.locals.sessionStore.close());
  const browser=request.agent(app),login=await browser.get('/login');
  await browser.post('/login').type('form').send({_csrf:f.csrf(login.text),email,password:f.password});
  const page=await browser.get('/inventories');
  await browser.post('/inventories/switch').type('form').send({_csrf:f.csrf(page.text),workspaceId:f.ctx.workspaceId}).expect(303);
  return {id,browser,ctx:{workspaceId:f.ctx.workspaceId,actorId:id}};
}
const csrfOf=html=>/name="_csrf" value="([^"]+)"/.exec(html)[1];
const revisionOf=html=>/name="revision" value="([^"]+)"/.exec(html)?.[1];

test('approval links reach each person, open without approving, and one checked tap approves once on every plan',{timeout:900000},async t=>{
  environment(t);
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:12}),{db,ctx,browser,subscribe}=f,ws=ctx.workspaceId,locationId=f.location.id,supplierId='fixture-supplier';
  const catalog=require('../../src/domain/postgres-catalog-service'),inventory=require('../../src/domain/postgres-inventory-engine'),commerce=require('../../src/operations/postgres-commerce');
  const autonomy=require('../../src/autopilot/postgres-service'),links=require('../../src/autopilot/approval-links'),alerts=require('../../src/autopilot/agent-alerts');
  const phones=require('../../src/autopilot/alert-phones'),modes=require('../../src/autopilot/job-modes'),mail=require('../../src/connections/postgres-outbound-mail');
  const {texts,pushes,drain}=senders(db);
  const count=async(sql,args=[])=>Number((await db.query(sql,[ws,...args])).rows[0].count);
  const audits=action=>count('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[action]);
  const orders=()=>count("SELECT count(*) FROM purchase_orders WHERE workspace_id=$1 AND source='foundry_recommendation'");
  const linkFor=async(workId,userId=ctx.actorId)=>(await db.query('SELECT * FROM stockchief_runtime.agent_approval_links WHERE workspace_id=$1 AND user_id=$2 AND href=$3',
    [ws,userId,'/autopilot/work/'+workId])).rows[0];
  const page=async(path,agent=browser,status=200)=>(await agent.get(path).expect(status)).text;
  const tap=(id,revision,agent=browser,html)=>agent.post('/approve/'+id).type('form').send({_csrf:csrfOf(html),revision}).expect(303);
  await db.query("UPDATE suppliers SET email='reorders@example.test' WHERE id=$1",[supplierId]);
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
    VALUES($1,$2,$1,'Owner mail','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'owner-mail',$5,now(),now())`,[connector,ws,'connection_credentials:'+connector,ctx.actorId,f.email]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,connector,'provider',{accessToken:'test-token'}));
  const needing=async code=>{
    const sku=(await catalog.createItem(db,ctx,{name:'Reorder '+code,baseCode:code,trackingMode:'quantity',purchaseCost:'2'})).skuIds[0];
    await commerce.linkSupplierItem(db,ctx,{supplierId,skuId:sku,purchaseUnit:'unit',unitsPerPurchaseUnit:1,lastUnitCost:2,orderMultiple:1,minimumOrderQuantity:1,isPreferred:true});
    await inventory.receive(db,ctx,{skuId:sku,locationId,quantity:2,occurredAt:new Date(Date.now()-3*86400000).toISOString(),idempotencyKey:randomUUID()});
    await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at)
      VALUES($1,$2,$3,$4,5,11,0,'manual',now()::text,now()::text)`,[randomUUID(),ws,sku,locationId]);
    const planned=await autonomy.plan(db,ws,{onlySkuIds:[sku]}),work=planned.created.find(w=>w.recommendedAction.type==='purchase');
    assert.ok(work,JSON.stringify(planned.considered));assert.equal(work.execution_status,'WAITING_FOR_APPROVAL');
    return work.id;
  };
  const effect=async id=>(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='mail.outbound.send'",[ws,id])).rows[0].id;
  const emailed=[],provider={send:async({message})=>{emailed.push(message);return {externalMessageId:'accepted-'+message.id};}};

  // An account on its older terms sees the plan card.
  assert.match(await page(links.path),/data-agent-plan-locked/);
  await subscribe('starter');

  // The owner chooses email, text and push for approvals, on the approvals page.
  await db.query("INSERT INTO stockchief_runtime.agent_alert_phones(workspace_id,user_id,phone,verified_at) VALUES($1,$2,'+15555550142',now())",[ws,ctx.actorId]);
  const device=crypto.createECDH('prime256v1');device.generateKeys();
  await phones.addDevice(db,ctx,{endpoint:'https://fcm.googleapis.com/fcm/send/'+randomUUID(),p256dh:device.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')},'Safari/605 iPhone');
  let html=await page(links.path);
  assert.match(html,/How approvals reach people/);assert.match(html,/Text them/);
  await browser.post('/autopilot/alerts/175').type('form').send({_csrf:csrfOf(html),revision:'0',mailbox:connector,phoneChannels:'1',sms:'1',push:'1'}).expect(303);

  // In the first 14 days the link is made but nothing is sent.
  const A=await needing('LINK-A');
  let ran=await links.run(db,ws);assert.equal(ran.opened,1);
  const a=await linkFor(A);assert.ok(a,'the owner has a link for the purchase approval');
  assert.match((await alerts.panel(db,ctx,175)).stop,/first 14 days/);
  assert.equal(await count('SELECT count(*) FROM customer_communications WHERE workspace_id=$1'),0);
  assert.equal(await count('SELECT count(*) FROM stockchief_runtime.agent_alert_messages WHERE workspace_id=$1'),0);

  // Afterwards they go out once by email, text and push, each with its own
  // link. The end of the 14 days is a decision too, made on its own page.
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  ran=await links.run(db,ws);assert.deepEqual([ran.opened,ran.emailed,ran.texted,ran.pushed],[1,2,2,2]);
  const shadow=(await db.query("SELECT * FROM stockchief_runtime.agent_approval_links WHERE workspace_id=$1 AND source_id='shadow-report'",[ws])).rows[0];
  const url='https://stockchief.example.test/approve/'+a.id;
  const sent=(await db.query('SELECT id FROM customer_communications WHERE workspace_id=$1',[ws])).rows;assert.equal(sent.length,1,'one email lists both');
  await mail.executeSendEffect(db,ws,await effect(sent[0].id),{provider});
  assert.equal(emailed[0].recipient,f.email);assert.equal(emailed[0].subject,'2 approvals are waiting for you');
  assert.ok(emailed[0].body.includes(url));assert.ok(emailed[0].body.includes('/approve/'+shadow.id));
  assert.match(emailed[0].body,/Opening a link does not approve anything/);
  await drain();
  assert.equal(texts.length,2);assert.ok(texts.every(m=>m.to==='+15555550142'));
  assert.ok(texts.some(m=>m.body.endsWith(url)));assert.ok(pushes.some(m=>m.message.url===url));
  html=await page('/approve/'+shadow.id);assert.match(html,/You decide this on its own page/);assert.match(html,/See the report/);
  ran=await links.run(db,ws);await drain();
  assert.deepEqual([ran.opened,ran.emailed,ran.texted,ran.pushed],[0,0,0,0],'replays send nothing more');
  assert.equal(texts.length,2);assert.equal(pushes.length,2);

  // The older purchase approval email stands down once approvals have their own channels.
  const guard=require('../../src/autopilot/approval-email').stillWanted,job={workspaceId:ws,payload:{workIds:[A],accountId:f.owner.accountId}};
  const settings=await page('/settings?section=notifications');
  await browser.post('/settings/email-alerts').type('form').send({_csrf:csrfOf(settings),enabled:'1',minimumSeverity:'important',recipients:''}).expect(303);
  assert.equal(await guard(db,job,f.email),false);
  await alerts.configure(db,ctx,175,{mailbox:'',phoneChannels:'1'});assert.equal(await guard(db,job,f.email),true);
  await alerts.configure(db,ctx,175,{mailbox:connector,phoneChannels:'1',sms:'1',push:'1'});

  // Opening the link on every plan shows the approval and orders nothing.
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    html=await page('/approve/'+a.id);
    assert.match(html,/data-approval-link="waiting"/,tier);assert.match(html,/>Send to supplier</);assert.match(html,/Nothing happens until you tap/);
    assert.ok(html.includes('Order 9 units from Fixture parts for $18.00.'),tier);
    assert.match(await page(links.path),/Opened, not approved yet/);
  }
  await subscribe('starter');
  assert.equal(await orders(),0,'opening a link orders nothing');
  assert.ok((await linkFor(A)).opened_at);
  const firstRevision=revisionOf(html);

  // Someone else's account cannot open it, not even a team member.
  const clerk=await member(f,'Clerk',['VIEW','VIEW_PURCHASING']);
  await clerk.browser.get('/approve/'+a.id).expect(404);
  await browser.get('/approve/'+'x'.repeat(40)).expect(404);

  // The clerk sees the approval in their own Needs you and gets their own link,
  // but the tap checks their permission and their limit again.
  await links.run(db,ws);
  const mine=await linkFor(A,clerk.id);assert.ok(mine);
  html=await page('/approve/'+mine.id,clerk.browser);assert.match(html,/>Send to supplier</);
  await tap(mine.id,revisionOf(html),clerk.browser,html);
  assert.equal(await orders(),0,'without permission to operate, nothing is ordered');
  assert.equal((await linkFor(A,clerk.id)).decided_at,null);
  await db.query("UPDATE users SET permissions=$2,po_approval_limit_minor=1000,po_approval_currency='USD' WHERE id=$1",[clerk.id,require('../../src/actions/permissions').encodeGrant(['VIEW','OPERATE','VIEW_PURCHASING','CREATE_PO','APPROVE_PO'])]);
  html=await page('/approve/'+mine.id,clerk.browser);
  const refused=await clerk.browser.post('/approve/'+mine.id).type('form').send({_csrf:csrfOf(html),revision:revisionOf(html)}).expect(303);
  assert.equal(await orders(),0,'a purchase above the clerk’s limit is not ordered');
  assert.match(await page(refused.headers.location,clerk.browser),/above your/);
  await db.query("UPDATE users SET permissions=$2 WHERE id=$1",[clerk.id,require('../../src/actions/permissions').encodeGrant(['VIEW'])]);
  assert.match(await page('/approve/'+mine.id,clerk.browser),/data-approval-link="gone"/,'a lost permission ends the link');

  // A change since the person looked asks them to look again.
  await db.query(`UPDATE work_items SET recommended_action=jsonb_set(recommended_action::jsonb,'{summary}','"Order 9 units of LINK-A before the weekend."')::text WHERE workspace_id=$1 AND id=$2`,[ws,A]);
  html=await page('/approve/'+a.id);
  assert.match(html,/data-approval-changed/);assert.match(html,/before the weekend/);
  await tap(a.id,firstRevision,browser,html);
  assert.equal(await orders(),0);assert.match(await page('/approve/'+a.id),/changed since you opened it/);

  // One tap approves it, once, even when tapped twice at the same moment.
  const fresh=revisionOf(html);
  await Promise.all([tap(a.id,fresh,browser,html),tap(a.id,fresh,browser,html)]);
  assert.equal(await orders(),1);
  await tap(a.id,fresh,browser,html);
  assert.equal(await orders(),1);assert.equal(await audits('Approved from a link'),1);
  html=await page('/approve/'+a.id);assert.match(html,/data-approval-link="approved"/);assert.match(html,/sent to the supplier/);
  const decided=await linkFor(A);assert.equal(decided.decided_by,ctx.actorId);
  const audit=(await db.query("SELECT after_state FROM security_event_history WHERE workspace_id=$1 AND action='Approved from a link'",[ws])).rows[0].after_state;
  assert.deepEqual([audit.kind,audit.item,audit.sent],['work','/autopilot/work/'+A,['email','text','push']]);
  assert.equal((await db.query('SELECT execution_status FROM work_items WHERE workspace_id=$1 AND id=$2',[ws,A])).rows[0].execution_status,'EXECUTING');

  // An approval decided in the app ends its link; nothing more is sent for it.
  const B=await needing('LINK-B');await links.run(db,ws);const b=await linkFor(B);
  const work=await page('/autopilot/work/'+B);
  await browser.post('/autopilot/work/'+B+'/approve').type('form').send({_csrf:csrfOf(work)}).expect(303);
  assert.equal(await orders(),2);
  html=await page('/approve/'+b.id);assert.match(html,/data-approval-link="gone"/);
  await links.run(db,ws);assert.ok((await linkFor(B)).closed_at);

  // Ask me first holds the links until the owner sends them; Watch only holds them.
  await modes.save(db,ctx,175,{mode:'ask',revision:0});
  const C=await needing('LINK-C');await links.run(db,ws);
  let panel=await alerts.panel(db,ctx,175);assert.match(panel.phoneNote,/Ask me first/);assert.equal(panel.canSendNow,true);
  html=await page(links.path);assert.match(html,/Send the waiting links now/);
  await browser.post('/autopilot/alerts/175/send').type('form').send({_csrf:csrfOf(html)}).expect(303);
  await drain();const c=await linkFor(C);assert.ok(texts.at(-1).body.includes('/approve/'+c.id));
  await modes.save(db,ctx,175,{mode:'watch',revision:1});
  const D=await needing('LINK-D');await links.run(db,ws);
  panel=await alerts.panel(db,ctx,175);assert.match(panel.phoneNote,/Watch only/);assert.equal(panel.canSendNow,false);
  assert.equal((await linkFor(D)).sms_batch,null);
  await modes.save(db,ctx,175,{mode:'inherit',revision:2});

  // On a 390 px phone: open the text's link, sign in, check it, tap once.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),listener=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();listener.closeAllConnections();await new Promise(r=>listener.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+listener.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  const before=await orders();
  for(const [name,viewport,mobile] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:mobile,hasTouch:mobile});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/approve/'+c.id);
    await tab.locator('[name=email]').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    assert.equal(new URL(tab.url()).pathname,'/approve/'+c.id);
    assert(await tab.getByRole('button',{name:'Send to supplier'}).isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.waitForTimeout(800);await tab.screenshot({path:require('node:path').join(folder,'approval-link-'+name+'.png'),fullPage:true});
    if(mobile){
      assert.equal(await orders(),before);
      await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Send to supplier'}).click()]);
      assert(await tab.locator('[data-approval-link="approved"]').isVisible());
      assert.equal(await orders(),before+1);
      await tab.waitForTimeout(800);await tab.screenshot({path:require('node:path').join(folder,'approval-link-approved-'+name+'.png'),fullPage:true});
    }
    await tab.close();
  }

  // Pro: a transfer waiting for approval gets its own link and one tap approves it.
  await subscribe('pro');
  const destination=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Second warehouse',kind:'warehouse'});
  const move=(await catalog.createItem(db,ctx,{name:'Move LINK-T',baseCode:'LINK-T',trackingMode:'quantity',purchaseCost:'2'})).skuIds[0];
  await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:move,locationId,quantity:10,idempotencyKey:randomUUID()});
  for(const [place,point] of [[locationId,2],[destination.id,5]])await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$5,0,'manual',now()::text,now()::text)`,[randomUUID(),ws,move,place,point]);
  const planned=await autonomy.plan(db,ws,{onlySkuIds:[move]}),transfer=planned.created.find(w=>w.recommendedAction.type==='transfer');
  assert.ok(transfer,JSON.stringify(planned.considered));
  await links.run(db,ws);const tl=await linkFor(transfer.id);
  html=await page('/approve/'+tl.id);assert.match(html,/>Approve transfer</);
  assert.equal(await count('SELECT count(*) FROM inventory_transfers WHERE workspace_id=$1'),0);
  await tap(tl.id,revisionOf(html),browser,html);
  assert.equal(await count('SELECT count(*) FROM inventory_transfers WHERE workspace_id=$1'),1);
  assert.match(await page('/approve/'+tl.id),/Transfer approved/);
  assert.equal(await audits('Approved from a link'),3);
});

test('a second purchase signature can be given from a text, by the person it is routed to, after checking',{timeout:600000},async t=>{
  environment(t);
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,workflows,subscribe}=f,ws=ctx.workspaceId;
  const dual=require('../../src/purchasing/dual-approval'),links=require('../../src/autopilot/approval-links'),alerts=require('../../src/autopilot/agent-alerts');
  const {texts,drain}=senders(db);
  await subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const buyer=await member(f,'Buyer',['VIEW','VIEW_PURCHASING','APPROVE_PO'],{limit:2000});
  await db.query("INSERT INTO stockchief_runtime.agent_alert_phones(workspace_id,user_id,phone,verified_at) VALUES($1,$2,'+15555550177',now())",[ws,buyer.id]);
  await dual.configure(db,ctx,{revision:0,currency:'USD',amount:'10'});
  await alerts.configure(db,ctx,175,{phoneChannels:'1',sms:'1'});
  const order=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,currency:'USD',idempotencyKey:randomUUID(),
    lines:[{skuId:f.item.skuIds[0],quantityUnits:2,unitCost:6}]}),id=order.purchaseOrderId;
  await dual.sign(db,ctx,id,(await dual.view(db,ctx,id)).digest);
  const signatures=async()=>Number((await db.query('SELECT count(*) FROM stockchief_runtime.purchase_approval_signatures WHERE workspace_id=$1 AND purchase_order_id=$2',[ws,id])).rows[0].count);
  const status=async()=>(await db.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ws,id])).rows[0].status;

  await links.run(db,ws);await drain();
  const link=(await db.query("SELECT * FROM stockchief_runtime.agent_approval_links WHERE workspace_id=$1 AND source_id=$2",[ws,'po-signature-'+id])).rows;
  assert.deepEqual(link.map(l=>l.user_id),[buyer.id],'only the person it is routed to gets a link');
  assert.equal(texts.length,1);assert.equal(texts[0].to,'+15555550177');assert.ok(texts[0].body.endsWith('/approve/'+link[0].id));
  let html=(await buyer.browser.get('/approve/'+link[0].id).expect(200)).text;
  assert.match(html,/>Sign purchase order</);assert.match(html,/Total \$12\.00/);assert.match(html,/Signed so far by/);
  assert.equal(await signatures(),1,'opening the link signs nothing');

  // A limit lowered after the text was sent stops the tap.
  await db.query('UPDATE users SET po_approval_limit_minor=500 WHERE id=$1',[buyer.id]);
  await buyer.browser.post('/approve/'+link[0].id).type('form').send({_csrf:csrfOf(html),revision:revisionOf(html)}).expect(303);
  assert.equal(await signatures(),1);assert.notEqual(await status(),'APPROVED');
  assert.match((await buyer.browser.get('/approve/'+link[0].id).expect(200)).text,/no longer waiting for you/);

  await db.query('UPDATE users SET po_approval_limit_minor=2000 WHERE id=$1',[buyer.id]);
  html=(await buyer.browser.get('/approve/'+link[0].id).expect(200)).text;
  await buyer.browser.post('/approve/'+link[0].id).type('form').send({_csrf:csrfOf(html),revision:revisionOf(html)}).expect(303);
  assert.equal(await signatures(),2);assert.equal(await status(),'APPROVED');
  await buyer.browser.post('/approve/'+link[0].id).type('form').send({_csrf:csrfOf(html),revision:revisionOf(html)}).expect(303);
  assert.equal(await signatures(),2);
  assert.match((await buyer.browser.get('/approve/'+link[0].id).expect(200)).text,/Signed and approved/);
  assert.equal(Number((await db.query("SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action='Approved from a link'",[ws])).rows[0].count),1);
});

test('a suggested QC hold can be approved from a push notification with one tap',{timeout:600000},async t=>{
  environment(t);
  const f=await require('../helpers/agent-quality-fixture').fixture(t,'growth'),{db,ctx,quality,browser}=f,ws=ctx.workspaceId;
  const links=require('../../src/autopilot/approval-links'),alerts=require('../../src/autopilot/agent-alerts'),phones=require('../../src/autopilot/alert-phones');
  const {pushes,drain}=senders(db);
  const device=crypto.createECDH('prime256v1');device.generateKeys();
  await phones.addDevice(db,ctx,{endpoint:'https://updates.push.services.mozilla.com/wpush/v2/'+randomUUID(),p256dh:device.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')},'Firefox/131 Windows');
  await alerts.configure(db,ctx,175,{phoneChannels:'1',push:'1'});
  await quality.save(db,ctx,{supplierName:'Fixture parts',checklist:['Check seals'],maxUnits:20,confirmed:'yes'});
  const po=await f.order(10);
  const received=await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity:po.quantity,locationId:f.location.id}]});
  const suggestion=received.qualitySuggestionIds[0];assert.ok(suggestion);
  const free=async()=>Number((await f.available()).available);
  const before=await free();

  await links.run(db,ws);await drain();
  const link=(await db.query("SELECT * FROM stockchief_runtime.agent_approval_links WHERE workspace_id=$1 AND source_id=$2",[ws,'delivery-quality:'+suggestion])).rows[0];
  assert.ok(link);const push=pushes.find(m=>m.message.url.endsWith('/approve/'+link.id));
  assert.ok(push,'one push for the hold, with its own link');assert.match(push.message.title,/^Approve: Suggested QC hold/);
  let html=(await browser.get('/approve/'+link.id).expect(200)).text;
  assert.match(html,/>Hold the goods</);assert.equal((await f.hold(suggestion)).status,'PROPOSED','opening holds nothing');
  await browser.post('/approve/'+link.id).type('form').send({_csrf:csrfOf(html),revision:revisionOf(html)}).expect(303);
  assert.equal((await f.hold(suggestion)).status,'HELD');assert.equal(await free(),before-10);
  html=(await browser.get('/approve/'+link.id).expect(200)).text;assert.match(html,/held for inspection/);
  assert.equal(Number((await db.query("SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action='Approved from a link'",[ws])).rows[0].count),1);
});

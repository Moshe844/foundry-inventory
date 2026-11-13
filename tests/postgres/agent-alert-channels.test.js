'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{randomUUID}=crypto;

// Job 173 is alone on every plan: alerts go by text message and push as well
// as email, and the owner chooses the channels for each kind of alert. Each
// person confirms their own mobile number with a code and turns push on per
// browser. Texts and push wait, like email, for the first 14 days, pause,
// Watch only and Ask me first (the alert job's or job 173's own), are checked
// again just before they go out, and are never sent twice. Live delivery uses
// a Twilio account and the server's push keys; here fake senders stand in and
// every number is a fictional 555 number.

function decrypt(body,ua,auth){
  const hkdf=(ikm,salt,info,n)=>Buffer.from(crypto.hkdfSync('sha256',ikm,salt,Buffer.from(info),n));
  const salt=body.subarray(0,16),size=body[20],sender=body.subarray(21,21+size),data=body.subarray(21+size);
  const ikm=hkdf(ua.computeSecret(sender),Buffer.from(auth,'base64url'),Buffer.concat([Buffer.from('WebPush: info\0'),ua.getPublicKey(),sender]),32);
  const decipher=crypto.createDecipheriv('aes-128-gcm',hkdf(ikm,salt,'Content-Encoding: aes128gcm\0',16),hkdf(ikm,salt,'Content-Encoding: nonce\0',12));
  decipher.setAuthTag(data.subarray(data.length-16));
  const plain=Buffer.concat([decipher.update(data.subarray(0,data.length-16)),decipher.final()]);
  return plain.subarray(0,plain.lastIndexOf(2)).toString();
}

test('alerts go by text and push as well as email, chosen per alert, on every plan, only when StockChief may send',{timeout:900000},async t=>{
  const names=['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM_NUMBER','WEB_PUSH_PUBLIC_KEY','WEB_PUSH_PRIVATE_KEY','WEB_PUSH_SUBJECT','FOUNDRY_PUBLIC_URL'];
  const prior=Object.fromEntries(names.map(n=>[n,process.env[n]]));
  t.after(()=>{for(const n of names)if(prior[n]===undefined)delete process.env[n];else process.env[n]=prior[n];});
  const server=crypto.createECDH('prime256v1');server.generateKeys();const d=server.getPrivateKey();
  Object.assign(process.env,{TWILIO_ACCOUNT_SID:'AC-test-only',TWILIO_AUTH_TOKEN:'test-only',TWILIO_FROM_NUMBER:'+15005550006',
    WEB_PUSH_PUBLIC_KEY:server.getPublicKey().toString('base64url'),WEB_PUSH_PRIVATE_KEY:Buffer.concat([Buffer.alloc(32-d.length),d]).toString('base64url'),
    WEB_PUSH_SUBJECT:'mailto:alerts@example.test',FOUNDRY_PUBLIC_URL:'https://stockchief.example.test'});
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:10}),{db,ctx,browser,subscribe,location}=f,ws=ctx.workspaceId;
  const catalog=require('../../src/domain/postgres-catalog-service'),inventory=require('../../src/domain/postgres-inventory-engine');
  const alerts=require('../../src/autopilot/agent-alerts'),phones=require('../../src/autopilot/alert-phones'),stock=require('../../src/autopilot/stock-alerts');
  const providers=require('../../src/notifications/alert-providers'),policy=require('../../src/commercial/agent-plan');
  const modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
  const runtime=require('../../src/operations/postgres-runtime-handlers'),queue=require('../../src/operations/postgres-job-queue');
  const texts=[],pushes=[];let fail=null;
  const handlers=runtime.create(undefined,{
    smsSender:async m=>{if(fail?.sms){const e=fail.sms;fail=null;throw e;}assert.match(m.to,/^\+1555555\d{4}$/,'tests only text fictional numbers');texts.push(m);return {reference:'SM'+texts.length};},
    pushSender:async m=>{if(fail?.push){const e=fail.push;fail=null;throw e;}pushes.push(m);return {reference:'push-'+pushes.length};}});
  const drain=async()=>{const done=[];for(let job;(job=await queue.processOne(db,handlers,{owner:'alert-channel-test',kinds:['agent.alert-message']}));)done.push(job);return done;};
  const check=()=>db.transaction(c=>runtime.autopilotEvaluate({id:randomUUID(),workspaceId:ws,payload:{actorId:ctx.actorId,requestedByUser:true}},c));
  const count=async(sql,args=[])=>Number((await db.query(sql,[ws,...args])).rows[0].count);
  const audits=action=>count('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[action]);
  const messages=async(where='true')=>(await db.query(`SELECT * FROM stockchief_runtime.agent_alert_messages WHERE workspace_id=$1 AND ${where} ORDER BY created_at,id`,[ws])).rows;
  const fresh=async code=>{const sku=(await catalog.createItem(db,ctx,{name:'Channel '+code,baseCode:code,trackingMode:'quantity'})).skuIds[0];
    await inventory.receive(db,ctx,{skuId:sku,quantity:1,locationId:location.id,idempotencyKey:randomUUID()});
    await inventory.issue(db,ctx,{skuId:sku,quantity:1,locationId:location.id,reasonCode:'sold',idempotencyKey:randomUUID()});await check();return sku;};
  const page=async path=>(await browser.get(path).expect(200)).text;

  // Push messages are encrypted exactly as RFC 8291 shows, and the server's
  // VAPID token checks out against its public key.
  assert.equal(providers.encrypt('When I grow up, I want to be a watermelon','BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4','BTBZMqHH6r4Tts7J_aSIgg',
    {senderPrivateKey:'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',salt:'DGv6ra1nlYgDCS1FRnbzlw'}).toString('base64url'),
  'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  const token=/^vapid t=([^,]+), k=(.+)$/.exec(providers.vapid('https://fcm.googleapis.com/fcm/send/x',providers.pushSettings()));
  assert.equal(token[2],process.env.WEB_PUSH_PUBLIC_KEY);
  const [head,claims,signature]=token[1].split('.');
  assert.equal(JSON.parse(Buffer.from(claims,'base64url')).aud,'https://fcm.googleapis.com');
  const publicKey=crypto.createPublicKey({key:{kty:'EC',crv:'P-256',x:server.getPublicKey().subarray(1,33).toString('base64url'),y:server.getPublicKey().subarray(33).toString('base64url')},format:'jwk'});
  assert.ok(crypto.verify('sha256',Buffer.from(head+'.'+claims),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')));
  await assert.rejects(providers.sendSms({to:'+15555550100',body:'x'}),/off in tests/,'the live sender never runs in tests');

  // An account on its older terms sees the plan card; every plan has the page.
  assert.match(await page(phones.path),/data-agent-plan-locked/);
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);assert.ok(policy.permits(tier,173,'automatic'),tier);
    assert.match(await page(phones.path),/Your phone and devices/);
  }
  await subscribe('starter');

  // The owner adds a number and confirms it with the code texted to it.
  let html=await page(phones.path);
  await browser.post(phones.path+'/phone').type('form').send({_csrf:f.csrf(html),phone:'555 555 0123'}).expect(303);
  assert.equal((await messages()).length,0,'a number without its country code is refused');
  await browser.post(phones.path+'/phone').type('form').send({_csrf:f.csrf(html),phone:'+1 (555) 555-0123'}).expect(303);
  await drain();
  assert.equal(texts.length,1);assert.equal(texts[0].to,'+15555550123');
  const code=/code: (\d{6})/.exec(texts[0].body)[1];
  assert.doesNotMatch(JSON.stringify(await messages()),new RegExp(code),'the code is never stored');
  assert.match(await page(phones.path),/number ending <strong>0123/);
  await browser.post(phones.path+'/phone/confirm').type('form').send({_csrf:f.csrf(html),code:code==='000000'?'111111':'000000'}).expect(303);
  assert.equal((await db.query('SELECT verified_at,code_attempts FROM stockchief_runtime.agent_alert_phones WHERE workspace_id=$1',[ws])).rows[0].code_attempts,1);
  await browser.post(phones.path+'/phone/code').type('form').send({_csrf:f.csrf(html)}).expect(303);
  assert.equal((await messages("purpose='CODE'")).length,1,'a new code waits a minute');
  await browser.post(phones.path+'/phone/confirm').type('form').send({_csrf:f.csrf(html),code}).expect(303);
  assert.equal((await phones.confirmPhone(db,ctx,code)).replayed,true);
  assert.equal(await audits('Alert phone confirmed'),1);
  assert.match(await page(phones.path),/Texts go to your number ending/);

  // Push is turned on for a browser on a real push service only.
  const ua=crypto.createECDH('prime256v1');ua.generateKeys();const keys={p256dh:ua.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')};
  await assert.rejects(phones.addDevice(db,ctx,{endpoint:'https://internal.example.test/push',...keys}),/push service/);
  await assert.rejects(phones.addDevice(db,ctx,{endpoint:'https://fcm.googleapis.com/fcm/send/a',p256dh:'short',auth:keys.auth}),/valid push keys/);
  await browser.post(phones.path+'/push').set('User-Agent','Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36')
    .type('form').send({_csrf:f.csrf(html),endpoint:'https://fcm.googleapis.com/fcm/send/'+randomUUID(),...keys}).expect(303);
  assert.match(await page(phones.path),/Chrome on Android/);

  // The owner chooses text and push for stock alerts, on the alert page.
  html=await page(stock.path);
  assert.match(html,/Text me/);assert.match(html,/Push to my devices/);
  await browser.post('/autopilot/alerts/166').type('form').send({_csrf:f.csrf(html),revision:'0',mailbox:'',phoneChannels:'1',sms:'1',push:'1'}).expect(303);
  let panel=await alerts.panel(db,ctx,166);assert.equal(panel.sms,true);assert.equal(panel.push,true);
  assert.deepEqual((await alerts.kinds(db,ws,await policy.accountState(db,ws))).map(k=>[k.job,k.email,k.sms,k.push]),
    [[166,false,true,true],[167,false,false,false],[168,false,false,false],[175,false,false,false]],'Starter has no cost, unusual-activity or pass-on alerts');
  assert.match(await page(phones.path),/What reaches you/);

  // In the first 14 days the alert shows, but nothing is texted or pushed.
  await fresh('SMS-A');
  assert.equal((await messages("purpose='ALERT'")).length,0);
  panel=await alerts.panel(db,ctx,166);assert.match(panel.stop,/first 14 days/);assert.match(panel.phoneNote,/first 14 days/);assert.equal(panel.waiting,1);

  // Afterwards one text and one push go out, with a link to the alert page.
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await check();
  assert.deepEqual((await messages("purpose='ALERT'")).map(m=>m.channel).sort(),['PUSH','SMS']);
  await drain();
  const url='https://stockchief.example.test'+stock.path;
  assert.match(texts[1].body,/^StockChief: Out of stock: SMS-A/);assert.ok(texts[1].body.endsWith(url));
  assert.equal(pushes[0].message.title,'Out of stock: SMS-A');assert.equal(pushes[0].message.url,url);assert.match(pushes[0].device.endpoint,/^https:\/\/fcm\.googleapis\.com\//);
  assert.equal(JSON.parse(decrypt(providers.encrypt(JSON.stringify(pushes[0].message),pushes[0].device.p256dh,pushes[0].device.auth),ua,keys.auth)).url,url,'the device can read it');
  assert.equal(await audits('Alert text queued'),1);assert.equal(await audits('Alert push queued'),1);
  assert.equal((await alerts.panel(db,ctx,166)).waiting,0);

  // Replays send nothing more.
  await check();await check();assert.equal((await messages("purpose='ALERT'")).length,2);
  const sentJob=(await db.query("SELECT * FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='agent.alert-message' ORDER BY created_at LIMIT 1",[ws])).rows[0];
  assert.equal((await phones.process(db,{workspaceId:ws,payload:sentJob.payload})).replayed,true);

  // An alert that clears before the worker sends is not sent.
  const cleared=await fresh('SMS-B');
  await inventory.receive(db,ctx,{skuId:cleared,quantity:3,locationId:location.id,idempotencyKey:randomUUID()});await check();
  await drain();
  assert.deepEqual((await messages("purpose='ALERT' AND status='HELD'")).map(m=>m.error.includes('cleared')),[true,true]);
  assert.equal(texts.length,2);

  // Job 173's own Watch only holds them; Ask me first holds them until the owner sends.
  await modes.save(db,ctx,173,{mode:'watch',revision:0});
  await fresh('SMS-C');
  panel=await alerts.panel(db,ctx,166);assert.match(panel.phoneNote,/Watch only/);assert.equal(panel.canSendNow,false);
  await assert.rejects(alerts.sendNow(db,ctx,166),/Watch only/);
  await modes.save(db,ctx,173,{mode:'ask',revision:1});
  await check();panel=await alerts.panel(db,ctx,166);assert.match(panel.phoneNote,/Ask me first/);assert.equal(panel.canSendNow,true);
  html=await page(stock.path);assert.match(html,/Send the waiting alerts now/);
  await browser.post('/autopilot/alerts/166/send').type('form').send({_csrf:f.csrf(html)}).expect(303);
  await drain();assert.match(texts.at(-1).body,/SMS-C/);
  const owned=(await db.query("SELECT after_state FROM security_event_history WHERE workspace_id=$1 AND action='Alert text queued' ORDER BY created_at DESC LIMIT 1",[ws])).rows[0].after_state;
  assert.equal(owned.sentByOwner,true);
  await modes.save(db,ctx,173,{mode:'inherit',revision:2});

  // Pause holds them; they go out once StockChief may act again.
  await autopilot.pause(db,ctx,{role:'owner'},'Stock count');
  await fresh('SMS-D');assert.match((await alerts.panel(db,ctx,166)).phoneNote,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});await check();await drain();
  assert.match(texts.at(-1).body,/SMS-D/);

  // A browser that dropped push is switched off; an unclear answer is never resent; a refusal fails.
  fail={push:Object.assign(new Error('Gone'),{status:410,gone:true})};
  await fresh('SMS-E');await drain();
  assert.match((await db.query('SELECT disabled_reason FROM stockchief_runtime.agent_push_devices WHERE workspace_id=$1',[ws])).rows[0].disabled_reason,/turned push off/);
  fail={sms:new Error('socket hang up')};
  await fresh('SMS-F');await drain();
  const unclear=(await messages("channel='SMS' AND status='UNCERTAIN'"))[0];assert.ok(unclear);
  assert.equal((await phones.process(db,{workspaceId:ws,payload:{messageId:unclear.id}})).replayed,true);
  assert.equal(texts.filter(m=>/SMS-F/.test(m.body)).length,0);
  fail={sms:Object.assign(new Error('Invalid number'),{status:400})};
  await fresh('SMS-G');await drain();assert.equal((await messages("channel='SMS' AND status='FAILED'")).length,1);
  panel=await alerts.panel(db,ctx,166);assert.equal(panel.ownDevices,0);

  // Without a confirmed number nothing is texted, and the page says why.
  html=await page(phones.path);
  await browser.post(phones.path+'/phone/remove').type('form').send({_csrf:f.csrf(html)}).expect(303);
  await fresh('SMS-H');assert.match((await alerts.panel(db,ctx,166)).phoneNote,/no confirmed mobile number/);
  await assert.rejects(alerts.configure(db,ctx,167,{phoneChannels:'1',sms:'1'}),/confirm your mobile number/);

  // Pro: an alert passed on (job 172) is texted to the person who has it, on their own number.
  await subscribe('pro');
  const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Clerk',businessName:'Clerk home '+randomUUID().slice(0,8),email:randomUUID()+'@example.test',password:'Staff!'+randomUUID()});
  const clerk=randomUUID();
  await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,permissions,created_at) VALUES($1,$2,$3,'Stock clerk','staff',$4,now())",[clerk,ws,other.accountId,JSON.stringify(['VIEW','VIEW_PURCHASING'])]);
  await db.query("INSERT INTO stockchief_runtime.agent_alert_phones(workspace_id,user_id,phone,verified_at) VALUES($1,$2,'+15555550188',now())",[ws,clerk]);
  await db.query(`INSERT INTO stockchief_runtime.agent_escalations(workspace_id,id,item_key,source,job_id,title,href,permission,opened_at,step,holder_user_id,passed_to,passed_at)
    VALUES($1,'esc-1','alert:166:x','ALERT',166,'Out of stock: SMS-H. 0 units on hand.',$2,'VIEW_PURCHASING',now(),1,$3,to_jsonb(ARRAY[$3]),now())`,[ws,stock.path,clerk]);
  html=await page(require('../../src/autopilot/escalations').path);assert.match(html,/Text them/);
  await browser.post('/autopilot/alerts/172').type('form').send({_csrf:f.csrf(html),revision:'0',mailbox:'',escalationHours:'2',phoneChannels:'1',sms:'1'}).expect(303);
  await db.transaction(async c=>alerts.deliver(c,ws,await policy.accountState(c,ws),{only:172}));
  await drain();
  assert.equal(texts.at(-1).to,'+15555550188');assert.match(texts.at(-1).body,/^StockChief: Out of stock: SMS-H/);
  await db.transaction(async c=>alerts.deliver(c,ws,await policy.accountState(c,ws),{only:172}));
  assert.equal((await messages("job_id=172")).length,1,'passed-on items are texted once');
  assert.deepEqual((await alerts.kinds(db,ws,await policy.accountState(db,ws))).map(k=>k.job),[166,167,168,170,171,172,175]);

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),listener=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();listener.closeAllConnections();await new Promise(r=>listener.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+listener.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+phones.path);
    assert(await tab.getByRole('heading',{name:'Your phone and devices'}).isVisible());
    assert(await tab.getByRole('button',{name:'Send a code'}).isVisible());
    assert(await tab.getByRole('button',{name:'Turn on push on this device'}).isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'alert-devices-'+name+'.png'),fullPage:true});
    await tab.goto(base+stock.path);
    assert(await tab.getByRole('checkbox',{name:'Text me'}).isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' alert page must not scroll sideways');
    await tab.close();
  }
});

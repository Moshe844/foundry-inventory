'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const commerce=require('../../src/operations/postgres-commerce');
const mail=require('../../src/connections/postgres-mail');
const credentials=require('../../src/connections/postgres-credential-store');
const jobs=require('../../src/operations/postgres-job-queue');
const runtimeHandlers=require('../../src/operations/postgres-runtime-handlers');
const {newId,nowIso}=require('../../src/lib/util');

test('real Chromium qualifies PostgreSQL business-mail filtering, exact replies and uncertain-send safety',
  {timeout:180000},async(context)=>{
    const delivered=[];let providerCalls=0;
    const adapter={
      metadata(){return {type:'gmail',name:'Gmail',mark:'G',category:'email',authMode:'oauth',available:true,
        description:'Fixture business mailbox.',provides:['business mail']};},
      async send({credentials:providerCredentials,message}){
        providerCalls+=1;assert.equal(providerCredentials.accessToken,'encrypted-fixture-token');
        if(message.subject.includes('Ambiguous')){const error=new Error('Provider connection ended before delivery was confirmed.');
          error.status=503;throw error;}
        delivered.push(message);return {externalMessageId:`sent-${providerCalls}`,externalThreadId:message.externalThreadId};
      },
    };
    const providers={get(type){return type==='gmail'?adapter:null;},catalog(){return [adapter.metadata()];}};
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-mail-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-mail-secret',connectionProviders:providers});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Mailbox Business');
    await page.getByLabel('Your name').fill('Mailbox Owner');await page.getByLabel('Work email').fill('mail-pg@example.test');
    await page.getByLabel('Password').fill('mailbox-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='mail-pg@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    await commerce.createSupplier(database,ctx,{name:'Reliable Supply',email:'supplier@example.test'});
    await commerce.createCustomer(database,ctx,{name:'Ava Customer',email:'customer@example.test'});
    const connectorId=newId('con');const at=nowIso();
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,
       expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
      VALUES($1,$2,$3,'Business Gmail','gmail',$4,'{}','connected',$5,$6,5,'CONNECTED',$7,'mailbox-fixture',
        'business@example.test',$8,$8)`,[connectorId,ctx.workspaceId,`gmail:${connectorId}`,JSON.stringify(['business mail']),
      JSON.stringify(['mail:read','mail:send']),`connection_credentials:${connectorId}`,ctx.actorId,at]);
    await database.transaction((client)=>credentials.put(client,ctx.workspaceId,connectorId,'provider',
      {accessToken:'encrypted-fixture-token'}));
    const connection=(await database.query('SELECT * FROM workspace_connectors WHERE id=$1',[connectorId])).rows[0];
    const supplierMessage=await mail.capture(database,connection,{externalMessageId:'supplier-message-1',
      externalThreadId:'supplier-thread-1',sender:'supplier@example.test',recipients:['business@example.test'],
      subject:'Can we ship the balance Friday?',bodyText:'Please confirm whether Friday works.',receivedAt:'2026-09-23T13:00:00.000Z'});
    const customerMessage=await mail.capture(database,connection,{externalMessageId:'customer-message-1',
      sender:'customer@example.test',recipients:['business@example.test'],subject:'Order delivery question',
      bodyText:'Can my order arrive next week?',receivedAt:'2026-09-23T13:01:00.000Z'});
    const unrelated=await mail.capture(database,connection,{externalMessageId:'personal-message-1',sender:'newsletter@example.test',
      recipients:['business@example.test'],subject:'Weekend newsletter',bodyText:'This private body must not be stored.',
      receivedAt:'2026-09-23T13:02:00.000Z'});
    const unrelatedReplay=await mail.capture(database,connection,{externalMessageId:'personal-message-1',sender:'newsletter@example.test',
      subject:'Weekend newsletter',bodyText:'Different replay body also must not be stored.',receivedAt:'2026-09-23T13:02:00.000Z'});
    assert.equal(supplierMessage.accepted,true);assert.equal(customerMessage.accepted,true);
    assert.deepEqual({setAside:unrelated.setAside,replayed:unrelated.replayed},{setAside:true,replayed:false});
    assert.deepEqual({id:unrelatedReplay.id,replayed:unrelatedReplay.replayed},{id:unrelated.id,replayed:true});
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM connection_email_messages WHERE workspace_id=$1',
      [ctx.workspaceId])).rows[0].count,'2');
    const aside=(await database.query('SELECT * FROM connection_email_set_aside WHERE workspace_id=$1',[ctx.workspaceId])).rows;
    assert.equal(aside.length,1);assert.equal(Object.hasOwn(aside[0],'body_text'),false);
    assert.doesNotMatch(JSON.stringify(aside),/private body|Different replay body/);

    await page.goto(`${base}/mail`);
    assert.equal(await page.locator('a[href="/needs-you"] .nav-count').innerText(),'2');
    const inboxText=await page.locator('main').innerText();assert.match(inboxText,/Can we ship the balance Friday/);
    assert.match(inboxText,/Order delivery question/);assert.doesNotMatch(inboxText,/Weekend newsletter/);
    await page.goto(`${base}/needs-you`);const needsText=await page.locator('main').innerText();
    assert.match(needsText,/supplier@example\.test is waiting for a response/);
    assert.match(needsText,/customer@example\.test is waiting for a response/);
    await page.goto(`${base}/mail/${supplierMessage.messageId}`);
    assert.match(await page.locator('main').innerText(),/Please confirm whether Friday works/);
    await page.getByLabel('Subject').fill('Re: Friday shipment');
    await page.locator('textarea[name="body"]').fill('Friday works. Please send the remaining units and share tracking.');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save draft'}).click()]);
    let stored=(await database.query('SELECT * FROM connection_email_messages WHERE id=$1',[supplierMessage.messageId])).rows[0];
    assert.equal(stored.draft_subject,'Re: Friday shipment');
    assert.equal(stored.draft_body,'Friday works. Please send the remaining units and share tracking.');
    assert.equal(stored.reply_sent_at,null);assert.equal(providerCalls,0);
    await page.locator('textarea[name="body"]').fill('Friday works. Send the remaining units and email the tracking number.');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Send exact reply'}).click()]);
    assert.equal(providerCalls,0);assert.match(await page.locator('main').innerText(),/Reply queued securely/);
    assert.equal((await database.query(`SELECT status FROM stockchief_runtime.email_reply_outbox
      WHERE message_id=$1`,[supplierMessage.messageId])).rows[0].status,'PENDING');
    await jobs.processOne(database,runtimeHandlers.create(providers),{owner:'mail-provider-worker'});await page.reload();
    assert.equal(providerCalls,1);assert.equal(delivered.length,1);
    assert.deepEqual({recipient:delivered[0].recipient,subject:delivered[0].subject,body:delivered[0].body},
      {recipient:'supplier@example.test',subject:'Re: Friday shipment',
        body:'Friday works. Send the remaining units and email the tracking number.'});
    assert.match(await page.locator('main').innerText(),/Reply sent and verified/);
    stored=(await database.query('SELECT * FROM connection_email_messages WHERE id=$1',[supplierMessage.messageId])).rows[0];
    assert.equal(stored.reply_state,'WAITING');assert.ok(stored.reply_sent_at);
    const replay=await mail.queueSend(database,ctx,supplierMessage.messageId,{subject:'Re: Friday shipment',
      body:'Friday works. Send the remaining units and email the tracking number.'},{providers});
    assert.equal(replay.replayed,true);assert.equal(providerCalls,1);

    const uncertainMessage=await mail.capture(database,connection,{externalMessageId:'supplier-message-2',
      sender:'supplier@example.test',recipients:['business@example.test'],subject:'Second shipment question',
      bodyText:'Should we send the second carton?',receivedAt:'2026-09-23T13:03:00.000Z'});
    await page.goto(`${base}/mail/${uncertainMessage.messageId}`);
    await page.getByLabel('Subject').fill('Ambiguous provider outcome');
    await page.locator('textarea[name="body"]').fill('Please send the second carton.');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Send exact reply'}).click()]);
    assert.equal(providerCalls,1);assert.match(await page.locator('main').innerText(),/Reply queued securely/);
    await jobs.processOne(database,runtimeHandlers.create(providers),{owner:'mail-provider-worker'});await page.reload();
    assert.match(await page.locator('body').innerText(),/delivery could not be verified.*did not retry/is);
    let outbox=(await database.query(`SELECT * FROM stockchief_runtime.email_reply_outbox
      WHERE message_id=$1`,[uncertainMessage.messageId])).rows;
    assert.equal(outbox.length,1);assert.equal(outbox[0].status,'AMBIGUOUS');assert.equal(providerCalls,2);
    await assert.rejects(()=>mail.queueSend(database,ctx,uncertainMessage.messageId,{subject:'Ambiguous provider outcome',
      body:'Please send the second carton.'},{providers}),/will not send another reply/);
    await assert.rejects(()=>mail.queueSend(database,ctx,uncertainMessage.messageId,{subject:'Different wording',
      body:'This changed text must not bypass the uncertain outcome.'},{providers}),/will not send another reply/);
    assert.equal(providerCalls,2);
    outbox=(await database.query('SELECT * FROM stockchief_runtime.email_reply_outbox WHERE message_id=$1',
      [uncertainMessage.messageId])).rows;assert.equal(outbox.length,1);
    await page.goto(`${base}/needs-you`);assert.match(await page.locator('main').innerText(),/Email delivery could not be verified/);
    assert.deepEqual(errors,[]);
  });

'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const commerce=require('../../src/operations/postgres-commerce');
const credentials=require('../../src/connections/postgres-credential-store');
const mail=require('../../src/connections/postgres-mail');
const jobs=require('../../src/operations/postgres-job-queue');
const runtimeHandlers=require('../../src/operations/postgres-runtime-handlers');
const {newId,nowIso}=require('../../src/lib/util');

async function register(page,base,business,email){
  await page.goto(`${base}/register`);await page.getByLabel('Business name').fill(business);
  await page.getByLabel('Your name').fill(`${business} Owner`);await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('ask-mail-password');
  await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
}

test('real Chromium Ask StockChief prepares, approves, sends and verifies one grounded supplier email',
  {timeout:180000},async(context)=>{
    const delivered=[];
    const adapter={metadata(){return {type:'gmail',name:'Gmail',category:'email',authMode:'oauth',available:true};},
      async send({credentials:providerCredentials,message}){assert.equal(providerCredentials.accessToken,'ask-mail-token');
        delivered.push(message);return {externalMessageId:`provider-message-${delivered.length}`,
          externalThreadId:`provider-thread-${delivered.length}`};}};
    const providers={get(type){return type==='gmail'?adapter:null;},catalog(){return [adapter.metadata()];}};
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-ask-mail-ui'});
    await migratePostgres(database);const app=createPostgresApp({database,env:'test',sessionSecret:'ask-mail-secret',
      aiProvider:require('../helpers/postgres-model-fixture').fixture({async complete(input){
        if(input.schemaName==='stockchief_postgres_email_draft'){
          const ownerMessage=JSON.parse(input.prompt).ownerMessage;
          if(ownerMessage.includes('recieved seven gloves'))return {data:{subject:'Shipment update',
            body:'Thank you for the recent shipment of seven gloves.'}};
          return {data:{subject:'Order received',body:'We received the order and will confirm Friday.'}};
        }
        const message=JSON.parse(input.prompt).message;
        if(input.schemaName==='stockchief_postgres_action_review')return {data:{
          requestedAction:true,action:'send_email',evidenceQuote:JSON.parse(input.prompt).request}};
        if(input.schemaName==='stockchief_postgres_followup')return {data:{
          disposition:message==='new-supplier@example.test'?'answer':'new_request',
          value:message==='new-supplier@example.test'?message:'',currency:''}};
        const recipient=message.startsWith('Email New Supplier')?'New Supplier':
          message.startsWith('Email No Address Supply')?'No Address Supply':
          message.startsWith('Email New Customer')?'New Customer':'Solomon Supply';
        if(message==='Email Solomon Supply')return {data:{intent:'action',action:'send_email',recipient,
          recipientKind:'supplier',body:''}};
        return {data:{intent:'action',action:'send_email',recipient,
          recipientKind:recipient==='New Customer'?'customer':'supplier',
          body:message==='Email Solomon Supply'?'':message.includes('recieved seven gloves')
            ?'we recieved seven gloves.':'we received the order and will confirm Friday.'}};
      }}),
      connectionProviders:providers});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();const first=await browser.newContext();const second=await browser.newContext();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;const page=await first.newPage();const other=await second.newPage();
    await register(page,base,'Ask Mail One','ask-mail-one@example.test');
    await register(other,base,'Ask Mail Two','ask-mail-two@example.test');
    const identities=(await database.query(`SELECT w.name,w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id AND u.role='owner' WHERE w.name IN ('Ask Mail One','Ask Mail Two')`)).rows;
    const one=identities.find((row)=>row.name==='Ask Mail One');const two=identities.find((row)=>row.name==='Ask Mail Two');
    await commerce.createSupplier(database,{workspaceId:one.workspace_id,actorId:one.actor_id},
      {name:'Solomon Supply',email:'solomon@supplier.example'});
    await commerce.createSupplier(database,{workspaceId:two.workspace_id,actorId:two.actor_id},
      {name:'Solomon Supply',email:'wrong-tenant@supplier.example'});

    await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief').fill('Email Solomon Supply');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    assert.match(await page.locator('main').innerText(),/What would you like the email to Solomon Supply to say/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1`,[one.workspace_id])).rows[0].count,'0');

    const connectorId=newId('con');const at=nowIso();
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,
       expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
      VALUES($1,$2,$3,'Business Gmail','gmail',$4,'{}','connected',$5,$6,5,'CONNECTED',$7,'ask-mailbox',
        'business@example.test',$8,$8)`,[connectorId,one.workspace_id,`gmail:${connectorId}`,JSON.stringify(['business mail']),
      JSON.stringify(['mail:read','mail:send']),`connection_credentials:${connectorId}`,one.actor_id,at]);
    await database.transaction((client)=>credentials.put(client,one.workspace_id,connectorId,'provider',{accessToken:'ask-mail-token'}));

    await page.getByLabel('Ask StockChief').fill('Please email Solomon Supply that we received the order and will confirm Friday.');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    const askText=await page.locator('main').innerText();assert.match(askText,/Email Solomon Supply at solomon@supplier\.example from Business Gmail/);
    assert.match(askText,/Nothing has changed yet/);assert.equal(delivered.length,0);
    const proposal=(await database.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,[one.workspace_id])).rows[0];
    const review=await page.locator('main').innerText();
    assert.match(review,/solomon@supplier\.example/);assert.match(review,/we received the order and will confirm Friday\./);
    assert.doesNotMatch(review,/wrong-tenant@supplier\.example/);
    assert.match(review,/Order received/);assert.match(review,/Approve and send/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM supplier_communications WHERE workspace_id=$1`,
      [one.workspace_id])).rows[0].count,'0');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Approve and send'}).click()]);
    assert.equal(delivered.length,0);
    let message=(await database.query(`SELECT * FROM supplier_communications WHERE workspace_id=$1`,[one.workspace_id])).rows[0];
    assert.equal(message.status,'QUEUED');assert.equal(message.recipient,'solomon@supplier.example');
    assert.match(message.body,/We received the order and will confirm Friday\./);
    await jobs.processOne(database,runtimeHandlers.create(providers),{owner:'ask-mail-worker'});
    assert.equal(delivered.length,1);assert.deepEqual({recipient:delivered[0].recipient,body:delivered[0].body},
      {recipient:'solomon@supplier.example',body:'We received the order and will confirm Friday.'});
    await page.getByRole('link',{name:'Track this email'}).click();
    assert.match(await page.locator('main').innerText(),/The mailbox provider confirmed this message/);
    message=(await database.query(`SELECT * FROM supplier_communications WHERE workspace_id=$1`,[one.workspace_id])).rows[0];
    assert.equal(message.status,'SENT');assert.ok(message.sent_at);
    await page.goto(`${base}/ask`);
    const csrf=await page.locator('input[name="_csrf"]').first().getAttribute('value');
    const replay=await page.request.post(`${base}/actions/${proposal.id}/approve`,{form:{_csrf:csrf},maxRedirects:0});
    assert.equal(replay.status(),303);
    assert.equal(delivered.length,1);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM supplier_communications WHERE workspace_id=$1`,
      [one.workspace_id])).rows[0].count,'1');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM supplier_communications WHERE workspace_id=$1`,
      [two.workspace_id])).rows[0].count,'0');
    await page.getByLabel('Ask StockChief').fill('Email New Supplier that we received the order and will confirm Friday.');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    assert.match(await page.locator('main').innerText(),/Add the contact or send this email once/);
    if(process.env.STOCKCHIEF_UX_SHOTS)await page.screenshot({path:require('path').join(require('os').tmpdir(),
      'stockchief-ask-email-choice.png'),fullPage:true});
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 AND status='PENDING'`,[one.workspace_id])).rows[0].count,'0');
    await page.getByLabel('Email address').fill('new-supplier@example.test');
    await page.getByLabel('Send once without adding a contact').check();
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Prepare the email'}).click()]);
    assert.match(await page.locator('main').innerText(),/Email New Supplier at new-supplier@example\.test/);
    if(process.env.STOCKCHIEF_UX_SHOTS)await page.screenshot({path:require('path').join(require('os').tmpdir(),
      'stockchief-ask-email-preview.png'),fullPage:true});
    const oneOff=(await database.query(`SELECT payload,status FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,[one.workspace_id])).rows[0];
    assert.equal(oneOff.status,'PENDING');
    assert.equal(oneOff.payload.recipientKind,'address');
    assert.equal(oneOff.payload.recipientEmail,'new-supplier@example.test');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Approve and send'}).click()]);
    await jobs.processOne(database,runtimeHandlers.create(providers),{owner:'ask-one-off-mail-worker'});
    const sentOneOff=(await database.query(`SELECT * FROM customer_communications WHERE workspace_id=$1
      AND recipient='new-supplier@example.test'`,[one.workspace_id])).rows[0];
    assert.equal(sentOneOff.status,'SENT');
    const incoming=await mail.capture(database,{id:connectorId,workspace_id:one.workspace_id,provider_type:'gmail'},
      {externalMessageId:'new-supplier-reply-1',externalThreadId:sentOneOff.external_thread_id,
        sender:'new-supplier@example.test',subject:'Re: Message from Ask Mail One',
        bodyText:'Can you confirm the delivery date?',receivedAt:nowIso()});
    assert.equal(incoming.accepted,true,'a verified reply to a sent one-off email must not be set aside');
    assert.equal((await mail.get(database,one.workspace_id,incoming.messageId)).reply_state,'NEEDS_REPLY');
    const unrelatedThread=await mail.capture(database,{id:connectorId,workspace_id:one.workspace_id,provider_type:'gmail'},
      {externalMessageId:'new-supplier-unrelated-1',externalThreadId:'unrelated-thread',
        sender:'new-supplier@example.test',subject:'Unrelated',bodyText:'Private message',receivedAt:nowIso()});
    assert.equal(unrelatedThread.setAside,true,'a matching address alone is not permission to capture unrelated mail');

    await commerce.createSupplier(database,{workspaceId:one.workspace_id,actorId:one.actor_id},{name:'No Address Supply'});
    await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief').fill('Email No Address Supply that we received the order and will confirm Friday.');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    assert.match(await page.locator('main').innerText(),/no email address is recorded/i);
    await page.getByLabel('Email address').fill('no-address@supplier.example');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Prepare the email'}).click()]);
    let latest=(await database.query(`SELECT id,payload FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,[one.workspace_id])).rows[0];
    assert.equal(latest.payload.saveEmailToContact,true);
    assert.equal((await database.query(`SELECT email FROM suppliers WHERE workspace_id=$1 AND name='No Address Supply'`,
      [one.workspace_id])).rows[0].email,null,'contact changes wait for approval');
    await page.getByText('Edit this draft').click();
    await page.locator('.rm-email-preview__edit textarea[name="body"]').fill('Hello,\n\nWe received the order and will confirm Friday.\n\nRegards, StockChief');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Save draft'}).click()]);
    latest=(await database.query(`SELECT id,payload FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,[one.workspace_id])).rows[0];
    assert.match(latest.payload.body,/Regards, StockChief/);
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Approve and send'}).click()]);
    assert.equal((await database.query(`SELECT email FROM suppliers WHERE workspace_id=$1 AND name='No Address Supply'`,
      [one.workspace_id])).rows[0].email,'no-address@supplier.example');
    await jobs.processOne(database,runtimeHandlers.create(providers),{owner:'ask-known-missing-mail-worker'});

    for(const [kind,name,address] of [
      ['supplier','New Supplier','added-supplier@example.test'],
      ['customer','New Customer','added-customer@example.test'],
    ]){
      await page.goto(`${base}/ask`);
      await page.getByLabel('Ask StockChief').fill(`Email ${name} that we received the order and will confirm Friday.`);
      await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
      await page.getByLabel('Email address').fill(address);
      await page.getByLabel(`Add ${name} as a ${kind}`).check();
      await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Prepare the email'}).click()]);
      const prepared=(await database.query(`SELECT id,payload FROM stockchief_runtime.assistant_action_proposals
        WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,[one.workspace_id])).rows[0];
      assert.equal(prepared.payload.addContactKind,kind);
      const table=kind==='supplier'?'suppliers':'customers';
      assert.equal((await database.query(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id=$1 AND name=$2`,
        [one.workspace_id,name])).rows[0].count,'0','contact is not created before approval');
      await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Approve and send'}).click()]);
      assert.equal((await database.query(`SELECT email FROM ${table} WHERE workspace_id=$1 AND name=$2`,
        [one.workspace_id,name])).rows[0].email,address);
      await jobs.processOne(database,runtimeHandlers.create(providers),{owner:`ask-added-${kind}-mail-worker`});
    }
    await page.goto(`${base}/ask`);
    await page.getByLabel('Ask StockChief').fill('Email Solomon Supply and say we recieved seven gloves.');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    const unsafeDraft=(await database.query(`SELECT payload FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,[one.workspace_id])).rows[0].payload;
    assert.equal(unsafeDraft.draftPolished,false,'invented shipment facts must reject the model rewrite');
    assert.equal(unsafeDraft.body,'we recieved seven gloves.');
    assert.match(await page.locator('main').innerText(),/could not polish this wording automatically/i);
    assert.equal(delivered.length,5,'an unapproved draft must never send');
  });

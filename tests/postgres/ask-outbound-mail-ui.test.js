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
        delivered.push(message);return {externalMessageId:`provider-message-${delivered.length}`};}};
    const providers={get(type){return type==='gmail'?adapter:null;},catalog(){return [adapter.metadata()];}};
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-ask-mail-ui'});
    await migratePostgres(database);const app=createPostgresApp({database,env:'test',sessionSecret:'ask-mail-secret',
      aiProvider:{async complete(){return {data:{intent:'clarify'}};}},
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
    assert.match(await page.locator('main').innerText(),/What exactly should the email to Solomon Supply say/);
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
    const proposalHref=await page.locator('a',{hasText:'Review prepared change'}).last().getAttribute('href');
    await page.goto(`${base}${proposalHref}`);const review=await page.locator('main').innerText();
    assert.match(review,/solomon@supplier\.example/);assert.match(review,/we received the order and will confirm Friday\./);
    assert.doesNotMatch(review,/wrong-tenant@supplier\.example/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM supplier_communications WHERE workspace_id=$1`,
      [one.workspace_id])).rows[0].count,'0');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve and execute'}).click()]);
    assert.equal(delivered.length,0);
    let message=(await database.query(`SELECT * FROM supplier_communications WHERE workspace_id=$1`,[one.workspace_id])).rows[0];
    assert.equal(message.status,'QUEUED');assert.equal(message.recipient,'solomon@supplier.example');
    assert.equal(message.body,'we received the order and will confirm Friday.');
    await jobs.processOne(database,runtimeHandlers.create(providers),{owner:'ask-mail-worker'});
    assert.equal(delivered.length,1);assert.deepEqual({recipient:delivered[0].recipient,body:delivered[0].body},
      {recipient:'solomon@supplier.example',body:'we received the order and will confirm Friday.'});
    await page.getByRole('link',{name:'Track this email'}).click();
    assert.match(await page.locator('main').innerText(),/The mailbox provider confirmed this message/);
    message=(await database.query(`SELECT * FROM supplier_communications WHERE workspace_id=$1`,[one.workspace_id])).rows[0];
    assert.equal(message.status,'SENT');assert.ok(message.sent_at);
    await page.goto(`${base}/ask`);
    const csrf=await page.locator('input[name="_csrf"]').first().getAttribute('value');
    const replay=await page.request.post(`${base}${proposalHref}/approve`,{form:{_csrf:csrf},maxRedirects:0});
    assert.equal(replay.status(),303);
    assert.equal(delivered.length,1);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM supplier_communications WHERE workspace_id=$1`,
      [one.workspace_id])).rows[0].count,'1');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM supplier_communications WHERE workspace_id=$1`,
      [two.workspace_id])).rows[0].count,'0');
  });

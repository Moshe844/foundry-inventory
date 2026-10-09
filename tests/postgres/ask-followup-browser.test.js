'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');
const {newId,nowIso}=require('../../src/lib/util');

function step(capability,args={},continuesPending=false){return {capability,
  arguments:Object.entries(args).map(([name,value])=>({name,value:String(value)})),
  dependsOn:[],continuesPending};}

test('browser Ask retains contact details through a follow-up and does not route a new goal into that thread',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-ask-followup-browser'});
    await migratePostgres(database);
    let plans=0;
    const provider={name:'anthropic',model:PRICED_MODEL,async complete(input){
      if(input.schemaName==='stockchief_capability_plan'){
        const prompt=JSON.parse(input.prompt);plans++;
        if(plans===1)return {data:{steps:[step('communication.send_email',{
          recipient:'Ada Source',recipientKind:'supplier',recipientEmail:'ada@example.test',
          recipientMode:'add_supplier'})],clarifyingQuestion:''},usage:pricedUsage()};
        if(plans===2){assert.equal(prompt.pending?.capability,'communication.send_email');
          return {data:{steps:[step('read.inventory_summary')],clarifyingQuestion:''},usage:pricedUsage()};}
        if(plans===3)return {data:{steps:[step('contact.create',{recipient:'Delta Supply',recipientKind:'supplier',
          recipientEmail:'delta@example.test'})],clarifyingQuestion:''},usage:pricedUsage()};
        if(plans===4)return {data:{steps:[step('contact.create',{recipient:'Willow Client',recipientKind:'customer',
          recipientEmail:'willow@example.test'}),{...step('communication.send_email',
            {body:'We will send the revised details tomorrow.'}),dependsOn:[0]}],
          clarifyingQuestion:''},usage:pricedUsage()};
        return {data:{steps:[step('communication.send_email',{recipient:'Hendel Ekstein'})],
          clarifyingQuestion:''},usage:pricedUsage()};
      }
      if(input.schemaName==='stockchief_postgres_email_draft'){
        const request=JSON.parse(input.prompt);
        return {data:{subject:'Shipment next week',body:request.ownerMessage},usage:pricedUsage()};
      }
      if(input.schemaName==='stockchief_capability_answer'){
        const evidence=JSON.parse(input.prompt).evidence;
        return {data:{answer:evidence[0].recordedAnswer,supported:true,usedSteps:[0]},usage:pricedUsage()};
      }
      if(input.schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:'The current message asks for a stock summary.'},usage:pricedUsage()};
      throw new Error(`Unexpected model request ${input.schemaName}`);
    }};
    const app=createPostgresApp({database,env:'test',sessionSecret:'ask-followup-browser-secret',aiProvider:provider});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const page=await browser.newPage();
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Followup Business');
    await page.getByLabel('Your name').fill('Followup Owner');
    await page.getByLabel('Work email').fill('followup-owner@example.test');
    await page.getByLabel('Password').fill('followup-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const owner=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id WHERE w.name='Followup Business'`)).rows[0];
    const connectorId=newId('con');const at=nowIso();
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,
       credential_ref,expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,
       provider_account_name,created_at,updated_at)
      VALUES($1,$2,$3,'Business Gmail','gmail',$4,'{}','connected',$5,$6,5,'CONNECTED',$7,'mailbox-test',
        'owner@example.test',$8,$8)`,
    [connectorId,owner.workspace_id,`gmail:${connectorId}`,JSON.stringify(['business mail']),
      JSON.stringify(['mail:read','mail:send']),`connection_credentials:${connectorId}`,owner.actor_id,at]);
    await page.goto(`${base}/ask`);
    async function ask(message){await page.getByLabel('Ask StockChief').fill(message);
      await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);}
    await ask('Add Ada Source as a supplier at ada@example.test and email her. I will say what to write next.');
    assert.match(await page.locator('main').innerText(),/What would you like the email to Ada Source to say/);
    assert.match(await page.locator('main').innerText(),/Your next message becomes an editable draft/);
    await ask('Please prepare another shipment next week.');
    assert.equal(plans,1,'a pending email body follows the verified conversation state, not a new model plan');
    const prepared=(await database.query(`SELECT id,payload,status FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 AND action_type='communication.send_email'`,[owner.workspace_id])).rows[0];
    assert.equal(prepared.status,'PENDING');
    assert.equal(prepared.payload.recipientEmail,'ada@example.test');
    assert.equal(prepared.payload.addContactKind,'supplier');
    assert.equal(prepared.payload.body,'Please prepare another shipment next week.');
    assert.doesNotMatch(await page.locator('main').innerText(),/Please provide the subject line and message content/);
    assert.equal((await database.query('SELECT COUNT(*)::int AS total FROM suppliers WHERE workspace_id=$1',
      [owner.workspace_id])).rows[0].total,0);
    await ask('What is in stock right now?');
    assert.match(await page.locator('main').innerText(),/No products have ever been recorded/i);
    const latest=(await database.query(`SELECT intent FROM stockchief_runtime.assistant_interactions
      WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,[owner.workspace_id])).rows[0];
    assert.equal(latest.intent.controlPlane.capability,'read.inventory_summary');
    await page.goto(`${base}/actions/${prepared.id}`);
    await page.getByRole('button',{name:/approve/i}).click();
    assert.equal((await database.query(`SELECT COUNT(*)::int AS total FROM suppliers
      WHERE workspace_id=$1 AND name='Ada Source' AND email='ada@example.test'`,[owner.workspace_id])).rows[0].total,1);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS total FROM supplier_communications
      WHERE workspace_id=$1 AND recipient='ada@example.test' AND status='QUEUED'`,[owner.workspace_id])).rows[0].total,1);
    await page.goto(`${base}/ask`);
    await ask('Please put Delta Supply in my suppliers with delta@example.test as its email.');
    const supplierProposal=(await database.query(`SELECT id,payload,status FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 AND action_type='contact.create'`,[owner.workspace_id])).rows[0];
    assert.equal(supplierProposal.status,'PENDING');
    assert.deepEqual({kind:supplierProposal.payload.kind,name:supplierProposal.payload.name,
      email:supplierProposal.payload.email},{kind:'supplier',name:'Delta Supply',email:'delta@example.test'});
    assert.equal((await database.query(`SELECT COUNT(*)::int AS total FROM suppliers
      WHERE workspace_id=$1 AND name='Delta Supply'`,[owner.workspace_id])).rows[0].total,0);
    await page.goto(`${base}/actions/${supplierProposal.id}`);
    await page.getByRole('button',{name:/approve/i}).click();
    assert.equal((await database.query(`SELECT COUNT(*)::int AS total FROM suppliers
      WHERE workspace_id=$1 AND name='Delta Supply' AND email='delta@example.test'`,[owner.workspace_id])).rows[0].total,1);
    await page.goto(`${base}/ask`);
    await ask('Add Willow Client as a customer using willow@example.test, then draft an email saying we will send the revised details tomorrow.');
    const customerProposal=(await database.query(`SELECT id,status FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 AND action_type='contact.create' ORDER BY created_at DESC,id DESC LIMIT 1`,
    [owner.workspace_id])).rows[0];
    assert.equal(customerProposal.status,'PENDING');
    assert.equal((await database.query(`SELECT COUNT(*)::int AS total FROM customers
      WHERE workspace_id=$1 AND name='Willow Client'`,[owner.workspace_id])).rows[0].total,0);
    await page.goto(`${base}/actions/${customerProposal.id}`);
    await page.getByRole('button',{name:/approve/i}).click();
    assert.equal((await database.query(`SELECT COUNT(*)::int AS total FROM customers
      WHERE workspace_id=$1 AND name='Willow Client' AND email='willow@example.test'`,
    [owner.workspace_id])).rows[0].total,1);
    const next=(await database.query(`SELECT payload,status FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 AND action_type='communication.send_email' ORDER BY created_at DESC,id DESC LIMIT 1`,
    [owner.workspace_id])).rows[0];
    assert.equal(next.status,'PENDING');
    assert.equal(next.payload.recipientEmail,'willow@example.test');
    assert.equal((await database.query(`SELECT COUNT(*)::int AS total FROM customer_communications
      WHERE workspace_id=$1 AND recipient='willow@example.test'`,[owner.workspace_id])).rows[0].total,0);
    await page.goto(`${base}/ask`);
    await page.getByRole('button',{name:'New conversation'}).click();
    await ask('Prepare an email for Hendel Ekstein. I will provide the wording after the address.');
    assert.match(await page.locator('main').innerText(),/could not find (?:a customer or supplier|the contact) “Hendel Ekstein”/i);
    await page.getByLabel('Email address').fill('hendel@example.test');
    await page.getByRole('button',{name:/Prepare the email/}).click();
    assert.match(await page.locator('main').innerText(),/What would you like the email to Hendel Ekstein to say/);
    assert.match(await page.locator('main').innerText(),/Your next message becomes an editable draft/);
    assert.equal(await page.locator('.rm-chat > .rm-composer').evaluate((node)=>getComputedStyle(node).position),
      'relative','Ask’s composer must follow the conversation instead of covering messages');
    const continuationId=await page.locator('input[name="continueInteractionId"]').getAttribute('value');
    await ask('That I need to get more shoes ASAP.');
    assert.equal(plans,5,'the body reply must not become a new inventory question');
    const oneOff=(await database.query(`SELECT payload,status FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 AND action_type='communication.send_email'
        AND payload->>'recipientName'=$2`,[owner.workspace_id,'Hendel Ekstein'])).rows[0];
    assert.ok(oneOff,`the reply should prepare Hendel’s draft instead of another contact’s: ${await page.locator('main').innerText()}`);
    assert.equal(oneOff.status,'PENDING');
    assert.equal(oneOff.payload.recipientName,'Hendel Ekstein');
    assert.equal(oneOff.payload.recipientEmail,'hendel@example.test');
    assert.equal(oneOff.payload.body,'That I need to get more shoes ASAP.');
    assert.equal(oneOff.payload.addContactKind,null);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS total FROM supplier_communications
      WHERE workspace_id=$1 AND recipient='hendel@example.test'`,[owner.workspace_id])).rows[0].total,0);
    await assert.rejects(()=>require('../../src/assistant/postgres-service').ask(database,
      {workspaceId:owner.workspace_id,actorId:owner.actor_id},'A duplicate draft must not be created.',
      {provider,continueInteractionId:continuationId}),/no longer current/);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS total FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 AND action_type='communication.send_email'
        AND payload->>'recipientName'=$2`,[owner.workspace_id,'Hendel Ekstein'])).rows[0].total,1);
  });

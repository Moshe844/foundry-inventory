'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const auth=require('../../src/domain/postgres-auth-service');
const commerce=require('../../src/operations/postgres-commerce');
const credentials=require('../../src/connections/postgres-credential-store');
const jobs=require('../../src/operations/postgres-job-queue');
const handlers=require('../../src/operations/postgres-runtime-handlers');
const {AuthenticationError}=require('../../src/domain/errors');
const {newId}=require('../../src/lib/util');

test('PostgreSQL Gmail and Microsoft webhooks authenticate, deduplicate and wake isolated mailbox polls',
  {timeout:120000},async(context)=>{
    const priorToken=process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN;
    process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN='postgres-gmail-push-token';
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-mail-webhooks'});
    await migratePostgres(database);
    const business=await auth.createBusiness(database,{businessName:'Webhook Mail Business',name:'Webhook Owner',
      email:'webhook-mail@example.test',password:'webhook-password',now:'2026-09-23T09:00:00.000Z'});
    const ctx={workspaceId:business.workspaceId,actorId:business.userId};
    await commerce.createSupplier(database,ctx,{name:'Webhook Supplier',email:'supplier@example.test'});
    await commerce.createCustomer(database,ctx,{name:'Webhook Customer',email:'customer@example.test'});
    const insertConnection=async(type,accountName,providerAccountId,secret)=>{
      const id=newId('con');const at='2026-09-23T10:00:00.000Z';
      await database.query(`INSERT INTO workspace_connectors
        (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,
         expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,'{}','connected',$7,$8,5,'CONNECTED',$9,$10,$10,$11,$11)`,
      [id,ctx.workspaceId,`${type}:${id}`,accountName,type,JSON.stringify(['business mail']),
        JSON.stringify(['mail:read','mail:send']),`connection_credentials:${id}`,ctx.actorId,providerAccountId,at]);
      await database.transaction((client)=>credentials.put(client,ctx.workspaceId,id,'provider',secret));
      return id;
    };
    const gmailId=await insertConnection('gmail','Webhook Gmail','business@gmail.test',
      {accessToken:'gmail-token',mailbox:'business@gmail.test'});
    const microsoftId=await insertConnection('microsoft365','Webhook Microsoft','business@microsoft.test',
      {accessToken:'microsoft-token',mailbox:'business@microsoft.test',subscriptionId:'subscription-1',
        webhookClientState:'microsoft-client-state'});
    let gmailPolls=0;let microsoftPolls=0;
    const gmail={metadata(){return {type:'gmail',name:'Gmail',available:true,category:'email',authMode:'oauth',provides:['business mail']};},
      async poll(){gmailPolls+=1;return {messages:[{messageId:'gmail-known-1',sender:'supplier@example.test',
        subject:'Gmail supplier question',bodyText:'Can we send this Friday?',receivedAt:'2026-09-23T15:00:00.000Z'}]};}};
    const microsoft={metadata(){return {type:'microsoft365',name:'Microsoft 365',available:true,category:'email',authMode:'oauth',provides:['business mail']};},
      verifyWebhook({body,credentials:providerCredentials}){for(const notice of body.value||[]){
        if(notice.clientState!==providerCredentials.webhookClientState)throw new AuthenticationError('Microsoft webhook client state is invalid.');}},
      async poll(){microsoftPolls+=1;return {messages:[{messageId:'microsoft-known-1',sender:'customer@example.test',
        subject:'Microsoft customer question',bodyText:'Will my order arrive Friday?',receivedAt:'2026-09-23T15:01:00.000Z'}]};}};
    const providers={get(type){return type==='gmail'?gmail:type==='microsoft365'?microsoft:null;},
      catalog(){return [gmail.metadata(),microsoft.metadata()];}};
    const app=createPostgresApp({database,env:'test',sessionSecret:'mail-webhook-secret',connectionProviders:providers});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    context.after(async()=>{if(priorToken===undefined)delete process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN;
      else process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN=priorToken;
      await new Promise((resolve)=>server.close(resolve));await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const gmailBody={message:{messageId:'pubsub-message-1',data:Buffer.from(JSON.stringify({
      emailAddress:'business@gmail.test',historyId:'history-1'})).toString('base64')}};
    let response=await fetch(`${base}/api/v1/connections/gmail/webhooks?token=wrong`,{method:'POST',headers:{
      'content-type':'application/json'},body:JSON.stringify(gmailBody)});
    assert.equal(response.status,401);
    response=await fetch(`${base}/api/v1/connections/gmail/webhooks?token=postgres-gmail-push-token`,{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify(gmailBody)});
    assert.equal(response.status,202);assert.deepEqual(await response.json(),{received:true,mailboxes:1,scheduled:1});
    response=await fetch(`${base}/api/v1/connections/gmail/webhooks?token=postgres-gmail-push-token`,{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify(gmailBody)});
    assert.equal((await response.json()).scheduled,0);
    const runtimeHandlers=handlers.create(providers);
    let completed=await jobs.processOne(database,runtimeHandlers,{owner:'webhook-mail-worker',leaseMs:60000});
    assert.equal(completed.status,'COMPLETED');assert.equal(completed.result.accepted,1);assert.equal(gmailPolls,1);

    response=await fetch(`${base}/api/v1/connections/microsoft365/webhooks/${microsoftId}?validationToken=plain-validation`,
      {method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(response.status,200);assert.equal(await response.text(),'plain-validation');
    const wrongMicrosoft={value:[{id:'notice-1',subscriptionId:'subscription-1',clientState:'wrong'}]};
    response=await fetch(`${base}/api/v1/connections/microsoft365/webhooks/${microsoftId}`,{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify(wrongMicrosoft)});
    assert.equal(response.status,401);
    const validMicrosoft={value:[{id:'notice-1',subscriptionId:'subscription-1',clientState:'microsoft-client-state'}]};
    response=await fetch(`${base}/api/v1/connections/microsoft365/webhooks/${microsoftId}`,{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify(validMicrosoft)});
    assert.equal(response.status,202);assert.deepEqual(await response.json(),{received:true,mailboxes:1,scheduled:1});
    completed=await jobs.processOne(database,runtimeHandlers,{owner:'webhook-mail-worker',leaseMs:60000});
    assert.equal(completed.status,'COMPLETED');assert.equal(completed.result.accepted,1);assert.equal(microsoftPolls,1);
    const subjects=(await database.query(`SELECT subject FROM connection_email_messages WHERE workspace_id=$1
      ORDER BY subject`,[ctx.workspaceId])).rows.map((row)=>row.subject);
    assert.deepEqual(subjects,['Gmail supplier question','Microsoft customer question']);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.jobs WHERE workspace_id=$1
      AND kind='mailbox.poll'`,[ctx.workspaceId])).rows[0].count,'2');
    assert.equal(gmailId.length>0,true);
  });

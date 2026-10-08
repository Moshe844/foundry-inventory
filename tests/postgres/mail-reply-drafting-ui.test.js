'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const commerce=require('../../src/operations/postgres-commerce');
const mail=require('../../src/connections/postgres-mail');
const jobs=require('../../src/operations/postgres-job-queue');
const runtimeHandlers=require('../../src/operations/postgres-runtime-handlers');
const {newId,nowIso}=require('../../src/lib/util');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');

function csrf(html){return html.match(/name="_csrf" value="([^"]+)"/)?.[1];}

test('business mail gets a safe editable draft, with metered record-grounded improvement and no automatic send',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-mail-draft-ui'});
    await migratePostgres(database);
    let calls=0;
    const aiProvider={name:'anthropic',model:PRICED_MODEL,async complete(input){
      assert.equal(input.schemaName,'prepared_reply');calls+=1;
      assert.equal(Object.hasOwn(input,'onValidated'),false,'internal validation callbacks never reach providers');
      return {data:calls===1
        ?{subject:'Re: Stock availability',body:'Hello,\n\nI am checking the stock availability and will follow up with confirmed details.\n\nBest,\nThe team'}
        :{subject:'Re: Stock availability',body:'We guarantee 999 units will arrive tomorrow.'},usage:pricedUsage()};
    }};
    const app=createPostgresApp({database,env:'test',sessionSecret:'mail-draft-secret',aiProvider});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const agent=request.agent(app);const registration=await agent.get('/register');
    await agent.post('/register').type('form').send({_csrf:csrf(registration.text),name:'Owner',
      businessName:'Mail Draft Business',email:'mail-draft@example.test',password:'draft-test-password'});
    const ctx=(await database.query(`SELECT w.id AS "workspaceId",u.id AS "actorId",w.owner_account_id AS "accountId" FROM workspaces w
      JOIN users u ON u.workspace_id=w.id WHERE w.name='Mail Draft Business'`)).rows[0];
    await database.query("UPDATE account_subscriptions SET plan_id='growth',plan_version_id=NULL WHERE account_id=$1",
      [ctx.accountId]);
    const draftCapability=await require('../../src/entitlements/postgres-service').capabilityState(database,
      {accountId:ctx.accountId,workspaceId:ctx.workspaceId},'communications.ai_drafts');
    assert.equal(draftCapability.enabled,true,JSON.stringify(draftCapability));
    await commerce.createSupplier(database,ctx,{name:'Parts Supplier',email:'parts@example.test'});
    const connectorId=newId('con');const at=nowIso();
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,
       expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,'Test Mailbox','gmail','[]','{}','connected','[]',5,'CONNECTED',$4,$5,$5)`,
    [connectorId,ctx.workspaceId,`gmail:${connectorId}`,ctx.actorId,at]);
    const connection=(await database.query('SELECT * FROM workspace_connectors WHERE id=$1',[connectorId])).rows[0];
    const captured=await mail.capture(database,connection,{externalMessageId:'draft-1',sender:'parts@example.test',
      subject:'Stock availability',bodyText:'Can you confirm what is available?',receivedAt:at});
    assert.equal(captured.accepted,true);
    let row=await mail.get(database,ctx.workspaceId,captured.messageId);
    assert.equal(row.reply_state,'NEEDS_REPLY');assert.equal(row.draft_source,'records');
    assert.match(row.draft_body,/checking the details against our records/);
    const queued=(await database.query(`SELECT id FROM stockchief_runtime.jobs WHERE workspace_id=$1
      AND kind='mail.reply-draft' AND payload->>'messageId'=$2`,[ctx.workspaceId,row.id])).rows;
    assert.equal(queued.length,1,'one durable automatic draft job is queued');
    const auto=await jobs.processOne(database,runtimeHandlers.create(undefined,{aiProvider}),
      {owner:'reply-draft-test',kinds:['mail.reply-draft']});
    assert.equal(auto.status,'COMPLETED');assert.equal(calls,1);
    row=await mail.get(database,ctx.workspaceId,row.id);
    assert.equal(row.draft_source,'model');assert.match(row.draft_body,/checking the stock availability/);
    assert.equal(row.reply_sent_at,null);
    let page=await agent.get(`/mail/${row.id}`);
    assert.match(page.text,/Prepare from verified records/);
    const improved=await agent.post(`/mail/${row.id}/draft`).type('form').send({_csrf:csrf(page.text),action:'improve'});
    assert.ok(improved.status>=400||improved.status===303);assert.equal(calls,2);
    row=await mail.get(database,ctx.workspaceId,row.id);
    assert.equal(row.draft_source,'model');assert.match(row.draft_body,/checking the stock availability/);
    assert.equal(row.reply_sent_at,null);
    const costs=(await database.query(`SELECT COUNT(*)::int AS total FROM commercial_cost_events
      WHERE workspace_id=$1 AND model=$2 AND operation IN ('model_input','model_output')`,
    [ctx.workspaceId,PRICED_MODEL])).rows[0];
    assert.ok(costs.total>=2,'model attempts must have cost records');
    const usage=(await database.query(`SELECT status,units FROM commercial_usage_events
      WHERE workspace_id=$1 AND meter='ai_work_credits'
        AND idempotency_key LIKE $2 ORDER BY occurred_at,id`,
    [ctx.workspaceId,`${ctx.workspaceId}:mail-reply:${row.id}:%`])).rows;
    assert.deepEqual(usage.map((event)=>event.status).sort(),['COMMITTED','REVERSED'],
      'unsafe output costs StockChief but must not consume customer credits');
  });

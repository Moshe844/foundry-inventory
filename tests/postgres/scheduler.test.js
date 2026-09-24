'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const { startCluster }=require('../helpers/postgres-cluster');
const { openPostgres }=require('../../src/db/postgres');
const { migratePostgres }=require('../../src/db/migrate-postgres');
const { createPostgresApp }=require('../../src/postgres-app');
const connections=require('../../src/connections/postgres-service');
const imports=require('../../src/imports/postgres-service');
const scheduler=require('../../src/operations/postgres-scheduler');
const jobs=require('../../src/operations/postgres-job-queue');
const handlers=require('../../src/operations/postgres-runtime-handlers');
const commerce=require('../../src/operations/postgres-commerce');
const mail=require('../../src/connections/postgres-mail');

function csrf(html){return /name="_csrf" value="([^"]+)"/.exec(html)[1];}

test('PostgreSQL scheduler deduplicates sweeps and recovers stale sessions, connections and interrupted imports',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-scheduler'});
    await migratePostgres(database);const app=createPostgresApp({database,env:'test',sessionSecret:'scheduler-secret'});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const agent=request.agent(app);const page=await agent.get('/register');
    await agent.post('/register').type('form').send({_csrf:csrf(page.text),businessName:'Scheduler Business',name:'Owner',
      email:'scheduler@example.test',password:'scheduler-password'}).expect(302);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w JOIN users u ON u.workspace_id=w.id
      JOIN accounts a ON a.id=u.account_id WHERE a.email='scheduler@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};const feed=await connections.createFeed(database,ctx,{displayName:'Aging feed',expectedIntervalMinutes:60});
    const now=Date.parse('2026-09-23T16:00:00.000Z');const old='2026-09-23T12:00:00.000Z';
    await database.query(`UPDATE workspace_connectors SET created_at=$2,last_activity_at=NULL,last_synced_at=NULL WHERE id=$1`,[feed.connection.id,old]);
    await database.query(`INSERT INTO stockchief_runtime.sessions(sid,expires_at,data) VALUES('expired-test',$1,'{}'::jsonb)`,[now-1]);
    const plan=await imports.analyse(database,ctx,{text:'Product,SKU\nInterrupted,INT-1\n',filename:'interrupted.csv'});
    await database.query(`INSERT INTO import_executions(id,workspace_id,import_id,idempotency_key,executed_by_user_id,status,stage,started_at)
      VALUES('interrupted-execution',$1,$2,'interrupted-key',$3,'EXECUTING','catalog',$4)`,[ctx.workspaceId,plan.id,ctx.actorId,old]);
    await database.query(`UPDATE import_plans SET status='EXECUTING' WHERE id=$1`,[plan.id]);
    await database.query(`INSERT INTO stockchief_runtime.provider_effects
      (id,workspace_id,kind,provider,aggregate_type,aggregate_id,idempotency_key,status,claim_token,claimed_at,created_at,updated_at)
      VALUES('interrupted-provider-effect',$1,'qualification.external','fixture','record','record-1','interrupted-effect',
        'RUNNING','abandoned-claim','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z',
        '2000-01-01T00:00:00.000Z')`,[ctx.workspaceId]);
    await database.query(`INSERT INTO customers(id,workspace_id,name,email,created_by_user_id,created_at,updated_at)
      VALUES('recovery-customer',$1,'Recovery Customer','recovery-customer@example.test',$2,$3,$3)`,
    [ctx.workspaceId,ctx.actorId,old]);
    await database.query(`INSERT INTO sales_orders
      (id,workspace_id,customer_id,order_number,order_date,delivery_method,currency,status,created_by_user_id,created_at,updated_at)
      VALUES('recovery-order',$1,'recovery-customer','SO-RECOVERY','2026-09-23','PICKUP','USD','FULFILLED',$2,$3,$3)`,
    [ctx.workspaceId,ctx.actorId,old]);
    await database.query(`INSERT INTO accounting_customer_invoices
      (id,workspace_id,invoice_number,customer_id,sales_order_id,issue_date,status,currency,subtotal_minor,total_minor,
       balance_minor,source_key,created_at,updated_at)
      VALUES('recovery-invoice',$1,'INV-RECOVERY','recovery-customer','recovery-order','2026-09-23','OPEN','USD',1000,1000,
        1000,'recovery-invoice-source',$2,$2)`,[ctx.workspaceId,old]);
    await database.query(`INSERT INTO payment_requests
      (id,workspace_id,invoice_id,sales_order_id,customer_id,provider,purpose,amount_minor,currency,status,created_at,updated_at)
      VALUES('interrupted-payment-request',$1,'recovery-invoice','recovery-order','recovery-customer','stripe','BALANCE',1000,
        'USD','PENDING',$2,$2)`,[ctx.workspaceId,old]);
    await database.query(`INSERT INTO stockchief_runtime.provider_effects
      (id,workspace_id,kind,provider,aggregate_type,aggregate_id,payload,idempotency_key,status,claim_token,claimed_at,created_at,updated_at)
      VALUES('interrupted-payment-effect',$1,'payment.request.create','stripe','payment_request','interrupted-payment-request',$2::jsonb,
        'interrupted-payment-effect-key','RUNNING','abandoned-payment-claim','2000-01-01T00:00:00.000Z',
        '2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')`,
    [ctx.workspaceId,JSON.stringify({requestId:'interrupted-payment-request',orderId:'recovery-order',invoiceId:'recovery-invoice',actorId:ctx.actorId})]);
    await database.query(`INSERT INTO locations(id,workspace_id,name,kind,created_at)
      VALUES('recovery-quarantine',$1,'Recovery quarantine','staging',$2)`,[ctx.workspaceId,old]);
    await database.query(`INSERT INTO customer_returns
      (id,workspace_id,return_number,sales_order_id,status,resolution,quarantine_location_id,created_by_user_id,created_at)
      VALUES('recovery-return',$1,'RMA-RECOVERY','recovery-order','AWAITING_REFUND','REFUND','recovery-quarantine',$2,$3)`,
    [ctx.workspaceId,ctx.actorId,old]);
    await database.query(`INSERT INTO payment_refund_requests
      (id,workspace_id,customer_return_id,payment_request_id,provider,amount_minor,currency,external_payment_id,status,
       created_by_user_id,created_at,updated_at)
      VALUES('interrupted-refund-request',$1,'recovery-return','interrupted-payment-request','stripe',500,'USD',
        'pi_recovery','PENDING',$2,$3,$3)`,[ctx.workspaceId,ctx.actorId,old]);
    await database.query(`INSERT INTO stockchief_runtime.provider_effects
      (id,workspace_id,kind,provider,aggregate_type,aggregate_id,payload,idempotency_key,status,claim_token,claimed_at,created_at,updated_at)
      VALUES('interrupted-refund-effect',$1,'payment.refund.create','stripe','customer_return','recovery-return',$2::jsonb,
        'interrupted-refund-effect-key','RUNNING','abandoned-refund-claim','2000-01-01T00:00:00.000Z',
        '2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')`,
    [ctx.workspaceId,JSON.stringify({refundRequestId:'interrupted-refund-request',customerReturnId:'recovery-return',actorId:ctx.actorId})]);
    await commerce.createSupplier(database,ctx,{name:'Recovery Supplier',email:'recovery-supplier@example.test'});
    const rawFeed=(await database.query('SELECT * FROM workspace_connectors WHERE id=$1',[feed.connection.id])).rows[0];
    const captured=await mail.capture(database,rawFeed,{externalMessageId:'recovery-message',sender:'recovery-supplier@example.test',
      recipients:['business@example.test'],subject:'Recovery question',bodyText:'Did the reply send?',receivedAt:old});
    await database.query(`INSERT INTO stockchief_runtime.email_reply_outbox
      (id,workspace_id,message_id,connector_id,idempotency_key,recipient,subject,body,status,started_at)
      VALUES('interrupted-mail-outbox',$1,$2,$3,'interrupted-mail-key','recovery-supplier@example.test','Re: Recovery','Yes.','PENDING',$4)`,
    [ctx.workspaceId,captured.messageId,feed.connection.id,old]);
    await database.query(`INSERT INTO stockchief_runtime.provider_effects
      (id,workspace_id,kind,provider,aggregate_type,aggregate_id,payload,idempotency_key,status,claim_token,claimed_at,created_at,updated_at)
      VALUES('interrupted-mail-effect',$1,'mail.reply.send','gmail','email_message',$2,$3::jsonb,'interrupted-mail-effect-key',
        'RUNNING','abandoned-mail-claim','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')`,
    [ctx.workspaceId,captured.messageId,JSON.stringify({outboxId:'interrupted-mail-outbox',messageId:captured.messageId,
      connectorId:feed.connection.id,actorId:ctx.actorId})]);
    await database.query(`UPDATE workspace_connectors SET created_at=$2,last_activity_at=NULL,last_synced_at=NULL WHERE id=$1`,
      [feed.connection.id,old]);
    const first=await scheduler.scheduleOnce(database,{now});const duplicate=await scheduler.scheduleOnce(database,{now});
    assert.equal(first.created,true);assert.equal(duplicate.created,false);assert.equal(first.job.id,duplicate.job.id);
    const completed=await jobs.processOne(database,handlers.create(),{owner:'scheduler-test',now,leaseMs:60000});
    assert.equal(completed.status,'COMPLETED');assert.equal(completed.result.expiredSessions,1);
    assert.equal(completed.result.recoveredImports,1);assert.equal(completed.result.ambiguousProviderEffects,4);
    assert.equal(completed.result.staleConnectors,1);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.sessions WHERE sid='expired-test'`)).rows[0].count,'0');
    assert.equal((await database.query(`SELECT status FROM import_executions WHERE id='interrupted-execution'`)).rows[0].status,'FAILED');
    assert.equal((await database.query(`SELECT status FROM import_plans WHERE id=$1`,[plan.id])).rows[0].status,'READY');
    assert.equal((await database.query(`SELECT status FROM stockchief_runtime.provider_effects
      WHERE id='interrupted-provider-effect'`)).rows[0].status,'AMBIGUOUS');
    assert.equal((await database.query(`SELECT status FROM stockchief_runtime.email_reply_outbox
      WHERE id='interrupted-mail-outbox'`)).rows[0].status,'AMBIGUOUS');
    assert.equal((await database.query(`SELECT status FROM payment_requests
      WHERE id='interrupted-payment-request'`)).rows[0].status,'REVIEW');
    assert.equal((await database.query(`SELECT status FROM payment_refund_requests
      WHERE id='interrupted-refund-request'`)).rows[0].status,'REVIEW');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM connection_issues WHERE workspace_id=$1
      AND fingerprint='email-send:interrupted-mail-outbox' AND status='OPEN'`,[ctx.workspaceId])).rows[0].count,'1');
    const issue=(await database.query(`SELECT * FROM connection_issues WHERE workspace_id=$1 AND connector_id=$2
      AND fingerprint=$3`,[ctx.workspaceId,feed.connection.id,`connector-stale:${feed.connection.id}`])).rows[0];
    assert.equal(issue.status,'OPEN');assert.match(issue.detail,/no longer claims this source is current/);
    const eventTypes=(await database.query(`SELECT event_type FROM stockchief_runtime.job_events WHERE job_id=$1 ORDER BY seq`,
      [first.job.id])).rows.map((row)=>row.event_type);
    assert.deepEqual(eventTypes,['ENQUEUED','CLAIMED','COMPLETED']);
  });

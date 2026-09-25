'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const auth=require('../../src/domain/postgres-auth-service');
const recovery=require('../../src/domain/postgres-password-recovery');
const email=require('../../src/operations/email');
const jobs=require('../../src/operations/postgres-job-queue');
const monitoring=require('../../src/operations/postgres-monitoring');
const handlers=require('../../src/operations/postgres-runtime-handlers');
const checkpoints=require('../../src/operations/postgres-checkpoints');
const {chromium}=require('playwright');
const {createPostgresApp}=require('../../src/postgres-app');

test('PostgreSQL password recovery stays account-neutral, expires old links and invalidates sessions',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString);
    context.after(async()=>{await database.close();cluster.stop();});await migratePostgres(database);
    const business=await auth.createBusiness(database,{name:'Recovery Owner',businessName:'Recovery Business',
      email:'recovery@example.test',password:'old-password-123'});
    await database.query(`INSERT INTO stockchief_runtime.sessions(sid,expires_at,data) VALUES
      ('recovery-session',$1,$2::jsonb)`,[Date.now()+60000,JSON.stringify({accountId:business.accountId})]);
    assert.deepEqual(await recovery.request(database,'missing@example.test',{origin:'https://stockchief.example',now:1000}),
      {accepted:true,queued:false});
    const requested=await recovery.request(database,business.email,{origin:'https://stockchief.example',now:2000});
    assert.deepEqual(requested,{accepted:true,queued:true});
    const job=(await database.query(`SELECT * FROM stockchief_runtime.jobs WHERE kind='system.email-send'`)).rows[0];
    assert.ok(job);const message=email.unseal(job.payload);const token=new URL(message.text.match(/https:\/\/\S+/)[0]).searchParams.get('token');
    assert.ok(await recovery.inspect(database,token,{now:2500}));
    await recovery.consume(database,token,'new-password-456',{now:3000,nowIso:'2026-09-24T12:00:00.000Z'});
    assert.equal(await auth.authenticate(database,business.email,'old-password-123'),null);
    assert.equal((await auth.authenticate(database,business.email,'new-password-456')).id,business.accountId);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.sessions
      WHERE data->>'accountId'=$1`,[business.accountId])).rows[0].count,'0');
    await assert.rejects(recovery.consume(database,token,'another-password-789',{now:3500}),/invalid or has expired/i);
  });

test('PostgreSQL worker delivers operational alerts and recovery mail exactly through durable jobs',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString);
    context.after(async()=>{await database.close();cluster.stop();});await migratePostgres(database);
    const business=await auth.createBusiness(database,{name:'Alert Owner',businessName:'Alert Business',
      email:'alerts@example.test',password:'alerts-password-123'});
    const alert=await monitoring.raise(database,{workspaceId:business.workspaceId,severity:'ERROR',kind:'worker.failure',
      title:'Worker stopped',detail:'Certification alert',fingerprint:'worker-failure'});
    await database.transaction((client)=>handlers.runtimeSweep({payload:{now:10000}},client,
      {alertWebhookUrl:'https://alerts.example.test'}));
    const delivered=[];const runtimeHandlers=handlers.create(undefined,{alertWebhookUrl:'https://alerts.example.test',
      publicOrigin:'https://stockchief.example',alertWebhookToken:'alert-token',fetch:async(url,request)=>{
        delivered.push({url,request,body:JSON.parse(request.body)});return {ok:true,status:202};},
      emailSender:async(message)=>({provider:'test-mail',externalId:message.to})});
    const alertJob=await jobs.processOne(database,runtimeHandlers,{owner:'alert-worker',kinds:['system.alert-delivery']});
    assert.equal(alertJob.status,'COMPLETED');assert.equal(delivered.length,1);
    assert.equal(delivered[0].request.headers.authorization,'Bearer alert-token');
    assert.match(delivered[0].body.acknowledgeUrl,/\/api\/v1\/operations\/alerts\//);
    assert.equal((await database.query('SELECT status FROM operational_alerts WHERE id=$1',[alert.id])).rows[0].status,'DELIVERED');
    const reset=await recovery.request(database,business.email,{origin:'https://stockchief.example',now:20000});
    assert.equal(reset.queued,true);
    const emailJob=await jobs.processOne(database,runtimeHandlers,{owner:'email-worker',kinds:['system.email-send']});
    assert.equal(emailJob.status,'COMPLETED');
    assert.equal((await checkpoints.get(database,'alert.delivered')).status,'PASS');
    assert.equal((await checkpoints.get(database,'password_recovery.delivery')).status,'PASS');
  });

test('real Chromium completes PostgreSQL password recovery without revealing whether an account exists',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString);
    await migratePostgres(database);const business=await auth.createBusiness(database,{name:'Browser Recovery',
      businessName:'Browser Recovery Business',email:'browser-recovery@example.test',password:'old-browser-password'});
    const app=createPostgresApp({database,env:'test',sessionSecret:'browser-recovery-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();context.after(async()=>{await browser.close();
      await new Promise((resolve)=>server.close(resolve));await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage();const errors=[];page.on('pageerror',(error)=>errors.push(error.message));
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/forgot-password`);await page.getByLabel('Email').fill(business.email);
    await page.getByRole('button',{name:'Send reset link'}).click();
    assert.match(await page.locator('body').innerText(),/If an account uses that email, a reset link is on its way/i);
    const job=(await database.query(`SELECT payload FROM stockchief_runtime.jobs WHERE kind='system.email-send'`)).rows[0];
    const message=email.unseal(job.payload);const token=new URL(message.text.match(/https:\/\/\S+/)[0]).searchParams.get('token');
    await page.goto(`${base}/reset-password?token=${encodeURIComponent(token)}`);
    await page.getByLabel('New password').fill('new-browser-password');
    await Promise.all([page.waitForURL(`${base}/login`),page.getByRole('button',{name:'Change password'}).click()]);
    assert.match(await page.locator('body').innerText(),/password has been changed/i);
    await page.getByLabel('Email').fill(business.email);await page.getByLabel('Password').fill('new-browser-password');
    const [response]=await Promise.all([page.waitForResponse((candidate)=>candidate.url()===`${base}/`),
      page.waitForURL(`${base}/`),page.getByRole('button',{name:'Sign in'}).click()]);
    assert.equal(response.status(),200);assert.match(await page.locator('body').innerText(),/Your inventory is ready|Brief/i);
    assert.deepEqual(errors,[]);
  });

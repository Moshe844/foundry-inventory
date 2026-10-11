'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const jobs=require('../../src/operations/postgres-job-queue');
const monitoring=require('../../src/operations/postgres-monitoring');
const projections=require('../../src/projections/postgres-service');
const {newId}=require('../../src/lib/util');
const request=require('supertest');

async function register(page,base,business,email){
  await page.goto(`${base}/register`);await page.getByLabel('Business name').fill(business);
  await page.getByLabel('Your name').fill(`${business} Owner`);await page.getByLabel('Work email').fill(email);
  await page.locator('input[name="password"]').fill('operations-password');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('operations-password');
  await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
}

test('real Chromium operates tenant-scoped PostgreSQL release readiness and dead-letter recovery',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-operations-ui'});
    await migratePostgres(database);const app=createPostgresApp({database,env:'test',sessionSecret:'operations-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();const first=await browser.newContext();const second=await browser.newContext();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;const page=await first.newPage();const other=await second.newPage();
    await register(page,base,'Operations One','ops-one@example.test');
    const firstWorkspace=(await database.query(`SELECT id FROM workspaces WHERE name='Operations One'`)).rows[0].id;
    await register(other,base,'Operations Two','ops-two@example.test');
    const secondWorkspace=(await database.query(`SELECT id FROM workspaces WHERE name='Operations Two'`)).rows[0].id;
    const queued=await jobs.enqueue(database,{workspaceId:firstWorkspace,kind:'fixture.failure',idempotencyKey:'fixture-dead',payload:{}});
    const claimed=await jobs.claim(database,{owner:'fixture-worker'});
    assert.equal(claimed.id,queued.job.id);
    await jobs.fail(database,claimed.id,claimed.leaseToken,new Error('fixture stopped'),{retryable:false});
    const repeat=await jobs.enqueue(database,{workspaceId:firstWorkspace,kind:'fixture.failure',idempotencyKey:'fixture-dead-repeat',payload:{}});
    const repeatClaim=await jobs.claim(database,{owner:'fixture-worker'});
    assert.equal(repeatClaim.id,repeat.job.id);
    await jobs.fail(database,repeatClaim.id,repeatClaim.leaseToken,new Error('fixture stopped'),{retryable:false});
    await monitoring.raise(database,{workspaceId:firstWorkspace,severity:'ERROR',kind:'fixture.alert',
      title:'First inventory alert',detail:'Visible only in the first inventory.',fingerprint:'fixture:first'});
    await monitoring.raise(database,{workspaceId:secondWorkspace,severity:'ERROR',kind:'fixture.alert',
      title:'Second inventory alert',detail:'Must not cross inventories.',fingerprint:'fixture:second'});
    await page.goto(`${base}/settings/operations`);const text=await page.locator('main').innerText();
    assert.match(text,/Production gate is blocked/);assert.match(text,/fixture\.failure/);assert.match(text,/First inventory alert/);
    assert.match(text,/2 failed attempts from 1 distinct cause/);
    assert.doesNotMatch(text,/Second inventory alert/);assert.match(text,/Inventory identity and journals reconcile/);
    await page.goto(`${base}/needs-you`);
    assert.equal(await projections.needsCount(database,firstWorkspace),
      (await projections.needs(database,firstWorkspace)).length);
    assert.match(await page.locator('main').innerText(),/2 failed background attempts need operator review/);
    assert.doesNotMatch(await page.locator('main').innerText(),/Automatic work stopped|Decision 1 of 2/);
    assert.equal(await page.locator('main a.page-back').count(),0,'Needs You must not link back to another Needs You cursor');
    assert.equal(await page.locator('a[href="/needs-you"] .nav-count').count(),0,
      'failed internal jobs must not inflate the human-decision badge');
    await page.getByRole('link',{name:'Review the grouped failures and retry controls'}).click();
    await page.locator('#dead-letters details').first().evaluate((element)=>{element.open=true;});
    await Promise.all([page.waitForNavigation(),page.locator(`form[action="/settings/operations/jobs/${queued.job.id}/retry"] button`).click()]);
    assert.equal((await jobs.get(database,queued.job.id,firstWorkspace)).status,'RETRY');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Mark resolved'}).click()]);
    assert.equal((await database.query('SELECT status FROM operational_alerts WHERE workspace_id=$1',[firstWorkspace])).rows[0].status,'RESOLVED');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record this certification result'}).click()]);
    const run=(await database.query('SELECT * FROM production_certification_runs WHERE workspace_id=$1',[firstWorkspace])).rows[0];
    assert.equal(run.status,'FAILED');
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM production_certification_runs WHERE workspace_id=$1',[secondWorkspace])).rows[0].count,'0');
    const effectId=newId('peff');
    await database.query(`INSERT INTO stockchief_runtime.provider_effects
      (id,workspace_id,kind,provider,aggregate_type,aggregate_id,idempotency_key,status,error_message)
      VALUES($1,$2,'fixture.external','fixture','record','external-record-1',$3,'AMBIGUOUS','Provider response was interrupted.')`,
    [effectId,firstWorkspace,`fixture-review:${effectId}`]);
    await page.goto(`${base}/needs-you`);
    assert.equal(await projections.needsCount(database,firstWorkspace),
      (await projections.needs(database,firstWorkspace)).length);
    const reviewLink=page.getByRole('link',{name:'Verify provider outcome'}).first();
    assert.equal(await reviewLink.getAttribute('href'),`/settings/operations/provider-effects/${effectId}`);
    await reviewLink.click();
    assert.match(await page.locator('main').innerText(),/Provider response was interrupted/);
    assert.doesNotMatch(page.url(),/\/needs-you(?:$|\?)/);
  });

test('PostgreSQL responder API rejects invalid tokens and acknowledges an alert once',{timeout:120000},async(context)=>{
  const previous=process.env.FOUNDRY_ALERT_ACK_TOKEN;process.env.FOUNDRY_ALERT_ACK_TOKEN='postgres-ack-secret';
  const cluster=await startCluster();const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-operations-api'});
  await migratePostgres(database);const app=createPostgresApp({database,env:'test',sessionSecret:'operations-api-secret'});
  context.after(async()=>{if(previous===undefined)delete process.env.FOUNDRY_ALERT_ACK_TOKEN;
    else process.env.FOUNDRY_ALERT_ACK_TOKEN=previous;await app.locals.sessionStore.close();await database.close();cluster.stop();});
  const alert=await monitoring.raise(database,{severity:'WARNING',kind:'certification.injected',title:'Injected test',detail:'Expected.'});
  await request(app).post(`/api/v1/operations/alerts/${alert.id}/ack`).send({token:'wrong'}).expect(401);
  const accepted=await request(app).post(`/api/v1/operations/alerts/${alert.id}/ack`)
    .set('Authorization','Bearer postgres-ack-secret').send({responder:'monitor@example.test'}).expect(200);
  assert.equal(accepted.body.status,'ACKNOWLEDGED');
  await request(app).post(`/api/v1/operations/alerts/${alert.id}/ack`)
    .set('Authorization','Bearer postgres-ack-secret').send({responder:'monitor@example.test'}).expect(404);
  const checkpoint=(await database.query(`SELECT status,detail FROM runtime_checkpoints WHERE check_key='alert.acknowledged'`)).rows[0];
  const detail=typeof checkpoint.detail==='string'?JSON.parse(checkpoint.detail):checkpoint.detail;
  assert.equal(checkpoint.status,'PASS');assert.equal(detail.alertId,alert.id);
});

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{chromium}=require('playwright');
test('browser retries only an unchanged approved rolled-back import, preserves failures and saves stock once',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),imports=require('../../src/imports/postgres-service'),jobs=require('../../src/operations/postgres-job-queue'),password='Fixture!'+randomUUID(),owner=await auth.createBusiness(db,{name:'Owner',businessName:'Recovery fixture',email:randomUUID()+'@example.test',password}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await chromium.launch(),page=await browser.newPage(),base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();await db.close();await cluster.stop();});
 page.on('pageerror',e=>t.diagnostic('Browser error: '+e.message));
 const plan=await imports.analyse(db,ctx,{text:'Product,SKU,Location,Quantity,Unit cost\n'+Array.from({length:501},(_,i)=>'Recovery family,REC-'+i+',Recovery room,1,1.00').join('\n'),allowModel:false});await imports.approve(db,ctx,plan.id,plan.integrityHash);await imports.queueExecution(db,ctx,plan.id,plan.integrityHash);
 const native=require('../../src/operations/postgres-runtime-handlers').create({})['import.execute-approved'],execute=imports.execute;
 imports.execute=(database,context,id,options={})=>execute(database,context,id,{...options,beforeCommit:async()=>{await options.beforeCommit?.();throw new Error('fixture database timeout');}});
 let failed;try{failed=await jobs.processOne(db,{'import.execute-approved':native},{owner:'recovery-fixture'});}finally{imports.execute=execute;}
 assert.equal(failed.status,'DEAD');const run=await imports.report(db,ctx.workspaceId,plan.id);assert.equal(run.stage,'rolled_back');assert.equal((await db.query('SELECT count(*) AS n FROM skus WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 await assert.rejects(imports.retryExecution(db,ctx,plan.id,'changed',run.id),/current import preview/);await assert.rejects(imports.retryExecution(db,ctx,plan.id,plan.integrityHash,'another-execution'),/fully rolled-back/);
 const other=await auth.createBusiness(db,{name:'Other',businessName:'Other fixture',email:randomUUID()+'@example.test',password});await assert.rejects(imports.retryExecution(db,{workspaceId:other.workspaceId,actorId:other.userId},plan.id,plan.integrityHash,run.id),/could not be found/);
 await db.query("UPDATE import_executions SET stage='uncertain' WHERE id=$1",[run.id]);await assert.rejects(imports.retryExecution(db,ctx,plan.id,plan.integrityHash,run.id),/fully rolled-back/);await db.query("UPDATE import_executions SET stage='rolled_back' WHERE id=$1",[run.id]);
 await page.goto(base+'/login');await page.getByLabel('Work email').fill(owner.email);await page.locator('[name=password]').fill(password);await Promise.all([page.waitForURL(base+'/'),page.getByRole('button',{name:'Sign in',exact:true}).click()]);await page.goto(base+'/imports/'+plan.id);
 assert.match(await page.locator('main').innerText(),/No inventory from this attempt was added/);assert.doesNotMatch(await page.locator('main').innerText(),/fixture database timeout/);
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:900});await page.goto(base+'/imports/'+plan.id+'?review=current&width='+width+'#import-new-locations');
  const script=await page.request.get(base+'/import-progress.js?v=development');assert((await script.text()).includes('function nextStep()'),'The tested client asset must contain the current import navigation code');
  await page.waitForFunction(()=>document.activeElement?.id==='import-current-step');
  assert(await page.getByRole('button',{name:'Retry approved import',exact:true}).evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),'The current retry action must be visible without scrolling through obsolete questions');
  assert.equal(await page.getByText('Source details and saved choices',{exact:true}).evaluate(e=>e.parentElement.open),false);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 }
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Retry approved import',exact:true}).click()]);assert.match(await page.locator('main').innerText(),/Import queued/);assert.equal((await imports.retryExecution(db,ctx,plan.id,plan.integrityHash,run.id)).created,false);
 const completed=await jobs.processOne(db,{'import.execute-approved':native},{owner:'recovery-fixture',kinds:['import.execute-approved']});assert.equal(completed.status,'COMPLETED');assert(completed.result.verified);
 await page.waitForFunction(()=>document.querySelector('main').innerText.includes('501 opening units'));assert.equal(await page.getByRole('button',{name:'Retry approved import',exact:true}).count(),0);
 assert.equal((await db.query('SELECT sum(on_hand) AS n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'501');assert.equal((await db.query('SELECT sum(total_cost_minor) AS n FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'50100');
 const history=(await db.query('SELECT status,stage FROM import_executions WHERE workspace_id=$1 ORDER BY started_at',[ctx.workspaceId])).rows;assert.deepEqual(history.map(r=>r.status),['FAILED','SUCCEEDED']);assert.equal(history[0].stage,'rolled_back');assert((await imports.execute(db,ctx,plan.id)).duplicate);
 assert.deepEqual((await db.query("SELECT attempt_count,max_attempts FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='import.execute-approved' ORDER BY created_at",[ctx.workspaceId])).rows,[{attempt_count:1,max_attempts:1},{attempt_count:1,max_attempts:1}]);
});

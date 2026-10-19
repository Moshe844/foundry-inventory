'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{chromium}=require('playwright');
test('large browser imports hand approved scope to the durable worker, survive closing the page and verify PostgreSQL once',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),imports=require('../../src/imports/postgres-service'),jobs=require('../../src/operations/postgres-job-queue'),password='Test!'+randomUUID(),owner=await auth.createBusiness(db,{name:'Owner',businessName:'Large import',email:randomUUID()+'@example.test',password}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await chromium.launch(),context=await browser.newContext(),page=await context.newPage(),base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();await db.close();await cluster.stop();});
 const source='Product,SKU,Location,Quantity\n'+Array.from({length:501},(_,i)=>'Fixture '+i+',FX-'+i+',Rear stockroom,1').join('\n'),plan=await imports.analyse(db,ctx,{text:source,allowModel:false});
 await assert.rejects(imports.queueExecution(db,ctx,plan.id,plan.integrityHash),/approve/);await imports.approve(db,ctx,plan.id,plan.integrityHash);
 await page.goto(base+'/login');await page.getByLabel('Work email').fill(owner.email);await page.locator('[name=password]').fill(password);await Promise.all([page.waitForURL(base+'/'),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 await page.goto(base+'/imports/'+plan.id);const started=Date.now();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Import and verify'}).click()]);assert(Date.now()-started<5000);assert.match(await page.locator('main').innerText(),/Import queued/);assert.equal((await db.query('SELECT count(*) AS n FROM items WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 const queued=await imports.queueExecution(db,ctx,plan.id,plan.integrityHash);assert.equal(queued.created,false);await page.close();const reopened=await context.newPage();await reopened.goto(base+'/imports/'+plan.id);assert.match(await reopened.locator('main').innerText(),/Import queued/);
 const native=require('../../src/operations/postgres-runtime-handlers').create({})['import.execute-approved'],execute=imports.execute;let delayed=false,completed;
 imports.execute=(database,context,id,options={})=>execute(database,context,id,{...options,beforeRow:async payload=>{await options.beforeRow?.(payload);if(!delayed){delayed=true;await new Promise(resolve=>setTimeout(resolve,1500));}}});
 try{completed=await jobs.processOne(db,{'import.execute-approved':native},{owner:'fixture-worker',leaseMs:1000});}finally{imports.execute=execute;}
 assert.equal(completed.status,'COMPLETED');assert.equal(completed.result.verified,true);
 await reopened.waitForFunction(()=>document.querySelector('main').innerText.includes('501 opening units'));assert.match(await reopened.locator('main').innerText(),/Verified/);assert.equal((await imports.report(db,ctx.workspaceId,plan.id)).verified,true);
 assert.equal((await db.query('SELECT sum(on_hand) AS n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'501');assert((await imports.execute(db,ctx,plan.id)).duplicate);
 const other=await auth.createBusiness(db,{name:'Other',businessName:'Other',email:randomUUID()+'@example.test',password});await assert.rejects(imports.queueExecution(db,{workspaceId:other.workspaceId,actorId:other.userId},plan.id,plan.integrityHash),/could not be found/);
 const stopped=await imports.analyse(db,ctx,{text:'Product,SKU,Location,Quantity\nSeparate fixture,OTHER-1,Rear stockroom,1',allowModel:false});await imports.approve(db,ctx,stopped.id,stopped.integrityHash);await imports.queueExecution(db,ctx,stopped.id,stopped.integrityHash);
 imports.execute=async()=>({replayed:true,execution:{status:'FAILED'}});
 try{const failed=await jobs.processOne(db,{'import.execute-approved':native},{owner:'fixture-worker'});assert.equal(failed.status,'DEAD');}finally{imports.execute=execute;}
 await reopened.goto(base+'/imports/'+stopped.id);assert.match(await reopened.locator('main').innerText(),/Import paused before verification/);assert.equal(await reopened.getByRole('button',{name:'Import and verify',exact:true}).count(),0);
 assert.equal((await db.query('SELECT sum(on_hand) AS n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'501');
});

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('two actual browser tabs reject stale product details and mobile tables expose horizontal scrolling',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);await require('../../src/db/migrate-postgres').migratePostgres(db);
 const password='Test!'+randomUUID(),owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Edit safety',email:randomUUID()+'@example.test',password}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Safety fitting',baseCode:'FITTING-29',trackingMode:'quantity'});
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch(),context=await browser.newContext({viewport:{width:390,height:844}}),a=await context.newPage(),b=await context.newPage(),base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();await db.close();await cluster.stop();});
 await a.goto(base+'/login');await a.getByLabel('Work email').fill(owner.email);await a.locator('[name=password]').fill(password);await Promise.all([a.waitForNavigation(),a.getByRole('button',{name:'Sign in',exact:true}).click()]);
 await a.goto(base+'/inventory/'+item.itemId);await b.goto(base+'/inventory/'+item.itemId);
 const hint=a.locator('.table-overflow-hint').filter({hasText:'More columns to the right'});assert(await hint.count()>0);assert(await hint.first().isVisible());
 await a.getByRole('button',{name:'Edit details',exact:true}).click();await a.locator('#edit-name').fill('Saved by first tab');await Promise.all([a.waitForNavigation(),a.getByRole('button',{name:'Save details',exact:true}).click()]);
 await b.getByRole('button',{name:'Edit details',exact:true}).click();await b.locator('#edit-name').fill('Stale second tab');await Promise.all([b.waitForNavigation(),b.getByRole('button',{name:'Save details',exact:true}).click()]);assert.match(await b.locator('[role=alert]').innerText(),/changed after you opened/);assert.equal(await b.locator('[role=alert]').isVisible(),true);
 assert.equal((await db.query('SELECT name FROM items WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,item.itemId])).rows[0].name,'Saved by first tab');
 await a.setViewportSize({width:1600,height:1000});await a.reload();assert.equal(await a.locator('.table-overflow-hint:visible').count(),0);
});

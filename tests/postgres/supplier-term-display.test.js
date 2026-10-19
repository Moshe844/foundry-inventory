'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('real supplier screen distinguishes missing, zero, single-pack and larger purchasing constraints',{timeout:90000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString),cleanup=[];
 t.after(async()=>{for(const close of cleanup.reverse())await close();await db.close();cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Term display',businessName:'Unfamiliar supplier terms',email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId},commerce=require('../../src/operations/postgres-commerce'),catalog=require('../../src/domain/postgres-catalog-service');
 const supplier=await commerce.createSupplier(db,ctx,{name:'Independent terms',currency:'USD'});
 for(const [name,minimumOrderQuantity,orderMultiple] of [['No saved terms',null,null],['Single pack',0,1],['Larger pack',3,4]]){
  const item=await catalog.createItem(db,ctx,{name,baseCode:randomUUID(),trackingMode:'quantity'});
  await commerce.linkSupplierItem(db,ctx,{supplierId:supplier.id,skuId:item.skuIds[0],purchaseUnit:'case',unitsPerPurchaseUnit:12,minimumOrderQuantity,orderMultiple});
 }
 const secret=randomUUID(),app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:secret,aiProvider:{complete:async()=>{throw Error('NO_MODEL_CALLS');}}});cleanup.push(()=>app.locals.sessionStore.close());
 const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});cleanup.push(()=>new Promise(resolve=>server.close(resolve)));
 const account=(await db.query('SELECT account_id FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0],sid=randomUUID();
 await new Promise((resolve,reject)=>app.locals.sessionStore.set(sid,{accountId:account.account_id,workspaceId:ctx.workspaceId,cookie:{maxAge:300000}},e=>e?reject(e):resolve()));
 const browser=await require('playwright').chromium.launch({headless:true});cleanup.push(()=>browser.close());
 const context=await browser.newContext(),origin='http://127.0.0.1:'+server.address().port;
 await context.addCookies([{name:'foundry.sid',value:encodeURIComponent('s:'+require('cookie-signature').sign(sid,secret)),url:origin,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage();await page.goto(origin+'/suppliers/'+supplier.id,{waitUntil:'domcontentloaded'});
 const table=page.locator('table').filter({has:page.getByRole('columnheader',{name:'Order multiple',exact:true})});
 for(const [name,minimum,multiple] of [['No saved terms','Not recorded','Not recorded'],['Single pack','0 case(s)','1 case(s)'],['Larger pack','3 case(s)','4 case(s)']]){
  const cells=await table.getByRole('row').filter({hasText:name}).locator('td').allTextContents();
  assert.equal(cells[6].trim(),minimum);assert.equal(cells[7].trim(),multiple);
 }
 const saved=(await db.query('SELECT minimum_order_quantity,order_multiple FROM supplier_items WHERE workspace_id=$1 ORDER BY order_multiple NULLS FIRST',[ctx.workspaceId])).rows;
 assert.deepEqual(saved.map(r=>[r.minimum_order_quantity===null?null:Number(r.minimum_order_quantity),r.order_multiple===null?null:Number(r.order_multiple)]),[[null,null],[0,1],[3,4]]);
 assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls')).rows[0].n,'0');
});

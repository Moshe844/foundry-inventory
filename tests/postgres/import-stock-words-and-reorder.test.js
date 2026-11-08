'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{chromium}=require('playwright');
// A large file for a business with no location yet, then the same business after it has one:
// the review never calls rows broken while they only wait for a location, imported SKUs get a
// reorder point, What to order finds empty SKUs wherever they sit, and stock pages use real
// SKUs and say "Out of stock" when nothing is left.
test('large imports, reorder points and stock wording work the same for every business',{timeout:300000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),imports=require('../../src/imports/postgres-service'),password='Fixture!'+randomUUID(),owner=await auth.createBusiness(db,{name:'Owner',businessName:'Any shop',email:randomUUID()+'@example.test',password}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await chromium.launch(),base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();await db.close();await cluster.stop();});
 // 120 products x 5 sizes. Every 50th SKU is empty; one product carries the owner's own reorder point.
 const lines=['Name,SKU,Size,Quantity,Reorder point'];for(let i=0;i<600;i++){const style=Math.floor(i/5);lines.push(`Style ${style} Boot,BT${String(style).padStart(3,'0')}-${36+i%5},${36+i%5},${i%50===49?0:10+i%7},${style===3?4:''}`);}
 const text=lines.join('\n');
 const pages=async(width,email,paths)=>{const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/login');await page.getByLabel('Work email').fill(email);await page.locator('[name=password]').fill(password);await Promise.all([page.waitForURL(base+'/'),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  const out={};for(const p of paths){await page.goto(base+p);out[p]=(await page.locator('main').innerText()).replace(/\s+/g,' ');}assert.deepEqual(errors,[]);await page.close();return out;};
 // No location yet: every stocked row waits for one, and the page says so instead of "Needs attention".
 const waiting=await imports.analyse(db,ctx,{text,allowModel:false});assert.equal(waiting.defaultLocationId,null);assert(waiting.recordsInvalid>0);
 for(const width of [1440,390]){const seen=(await pages(width,owner.email,['/imports/'+waiting.id]))['/imports/'+waiting.id];
  assert.match(seen,/Where is this stock kept\?/);assert.match(seen,new RegExp('Waiting for a location '+waiting.recordsInvalid));assert.doesNotMatch(seen,/Needs attention \d/);}
 // Exactly one location: it is used without asking.
 await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Back room',kind:'store'});
 const plan=await imports.analyse(db,ctx,{text:text.replaceAll('BT','BX'),allowModel:false});assert.equal(plan.recordsInvalid,0);assert.equal(plan.recordsValid,600);assert(plan.defaultLocationId);
 await imports.approve(db,ctx,plan.id,plan.integrityHash);assert.equal((await imports.execute(db,ctx,plan.id)).verified,true);
 // Every imported SKU has a reorder point; the owner's own stays as given.
 const policies=(await db.query(`SELECT s.code,p.reorder_point::int AS point,p.target_stock::numeric AS target FROM reorder_policies p JOIN skus s ON s.id=p.sku_id WHERE p.workspace_id=$1`,[ctx.workspaceId])).rows,by=new Map(policies.map(p=>[p.code,p]));
 assert.equal(policies.length,600);assert.equal(by.get('BX003-36').point,4);assert.equal(by.get('BX000-36').point,0);assert.equal(Number(by.get('BX000-36').target),10);
 assert.equal(by.get('BX009-40').point,0);assert(Number(by.get('BX009-40').target)>0,'an empty SKU refills to its product’s usual quantity');
 // What to order finds all 12 empty SKUs on its first page, though most sit past the first 50 SKUs.
 const shortage=await require('../../src/purchasing/postgres-shortage-list').read(db,ctx.workspaceId,{});
 assert.equal(shortage.atOrBelowTotal,12);for(const code of ['BX009-40','BX119-40'])assert(shortage.rows.some(r=>r.sku_code===code||r.code===code||r.displayName.includes('Style '+code.slice(2,5).replace(/^0+(?=\d)/,'')+' Boot')),code);
 for(const width of [1440,390]){const seen=await pages(width,owner.email,['/','/inventory?view=flat&group=empty','/inventory','/purchasing']);
  assert.match(seen['/'],/Out of stock 12 of 600 SKUs/);
  assert.match(seen['/inventory?view=flat&group=empty'],/BX009-40 Out of stock/);assert.doesNotMatch(seen['/inventory?view=flat&group=empty'],/\bLow\b/);
  assert.doesNotMatch(seen['/inventory'],/PRODUCT-ITEM_/i);assert.match(seen['/inventory'],/BX000-36/);
  assert.match(seen['/purchasing'],/12 items at or below their reorder point/);}
});

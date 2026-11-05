'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
// One customer's name must never change how the product behaves for them.
test('no shipped code singles out a business by name',()=>{
 const found=[];const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory()){if(entry.name!=='vendor')walk(full);continue;}if(!/\.(js|ejs|sql)$/.test(entry.name))continue;if(/hendel/i.test(fs.readFileSync(full,'utf8')))found.push(full);}};
 walk(path.join(__dirname,'../../src'));assert.deepEqual(found,[]);
});
test('a business called Hendels sees all its own records on the order and Buy forms',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:5}),{db,ctx}=f;
 await db.query('UPDATE workspaces SET name=$2 WHERE id=$1',[ctx.workspaceId,'Hendels shoes']);
 const commerce=require('../../src/operations/postgres-commerce');
 await commerce.createCustomer(db,ctx,{name:'QA Supplies Ltd'});await commerce.createSupplier(db,ctx,{name:'RT-Parts Wholesale',currency:'USD'});
 await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Sweep Street Store',kind:'store'});
 await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'QA Tester Kit',baseCode:'QA-'+randomUUID().slice(0,6),trackingMode:'quantity'});
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s));}),origin='http://127.0.0.1:'+server.address().port,browser=await require('playwright').chromium.launch();
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));await app.locals.sessionStore.close();});
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(origin+'/orders/new');let html=await page.content();
  for(const name of ['QA Supplies Ltd','Sweep Street Store','QA Tester Kit'])assert.match(html,new RegExp(name),width+' order form lists '+name);
  await page.goto(origin+'/purchasing/orders/new');html=await page.content();
  for(const name of ['RT-Parts Wholesale','Sweep Street Store'])assert.match(html,new RegExp(name),width+' Buy form lists '+name);
  assert.deepEqual(errors,[]);await context.close();
 }
});

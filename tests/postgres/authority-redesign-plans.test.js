'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('redesigned authority controls save in Chromium while every plan, shadow period and revoked membership remains enforced',{timeout:300000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f,autonomy=require('../../src/autopilot/postgres-service');
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const browser=await require('playwright').chromium.launch(),base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'data','authority-redesign');require('node:fs').mkdirSync(folder,{recursive:true});
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 for(const plan of ['starter','growth','pro'])await t.test(plan,async()=>{
   await f.subscribe(plan);await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
   await page.goto(base+'/autopilot');assert(await page.locator('[name=mode][value=POLICY_AUTOMATED]').isDisabled(),'Fresh '+plan+' remains in the 14-day shadow period');
   await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
   await page.goto(base+'/autopilot');assert.equal(await page.locator('[name=mode][value=POLICY_AUTOMATED]').isDisabled(),plan==='starter','Starter must never unlock automatic routine work');
   const before=(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows;
   for(const mode of ['OBSERVE','SUPERVISED']){
     await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/autopilot/mode'),page.locator('[name=mode][value='+mode+']').check()]);
     await page.waitForLoadState('networkidle');assert.equal((await autonomy.getState(db,ctx.workspaceId)).mode,mode,'A selected level is actually saved');
   }
   if(plan==='starter'){
     const form=await f.browser.get('/autopilot');await f.browser.post('/autopilot/mode').type('form').send({_csrf:f.csrf(form.text),mode:'POLICY_AUTOMATED'});
     assert.equal((await autonomy.getState(db,ctx.workspaceId)).mode,'SUPERVISED','A forged Starter submit cannot grant automatic authority');
   }else{
     await Promise.all([page.waitForNavigation(),page.locator('[name=mode][value=POLICY_AUTOMATED]').check()]);assert.equal((await autonomy.getState(db,ctx.workspaceId)).mode,'POLICY_AUTOMATED');
   }
   const transfer=page.locator('.job').filter({hasText:'Move stock between locations'}),reorder=page.locator('.job').filter({hasText:'Reorder and place purchase orders'});
   assert.equal(await transfer.getByRole('button',{name:'Let StockChief do this',exact:true}).isDisabled(),plan!=='pro','Automatic transfers stay on the right plan');
   assert.equal(await reorder.getByRole('button',{name:'Let StockChief do this',exact:true}).isDisabled(),plan==='starter','Growth trusted purchasing remains available');
   for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),plan+' fits '+width);await page.screenshot({path:require('node:path').join(folder,plan+'-'+width+'.png'),fullPage:true});}
   await page.setViewportSize({width:1440,height:1000});
   assert.deepEqual((await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows,before,'Authority changes never change Stripe billing or the plan');
 });
 await db.query('UPDATE users SET revoked_at=now() WHERE id=$1',[ctx.actorId]);await assert.rejects(require('../../src/operations/postgres-warehouse-access').scope(db,ctx),/membership could not be verified/);
 assert.deepEqual(errors,[]);
});

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('every public connection opens a window with what it does and how to connect it; the address box keeps its words inside',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t);
 const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID()});
 const server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s));}),origin='http://127.0.0.1:'+server.address().port;
 const browser=await require('playwright').chromium.launch();
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));await app.locals.sessionStore.close();});
 const groups=require('../../src/web/presentation/public-integrations').groups(),providers=groups.flatMap(g=>g.providers);
 for(const [width,height] of [[1440,900],[390,844]]){
  const page=await (await browser.newContext({viewport:{width,height}})).newPage();
  await page.goto(origin+'/integrations');
  assert.equal(await page.locator('main a[href="/settings/connections"]').count(),0,width+': no connect links on the public page');
  for(const p of providers){
   await page.getByRole('button',{name:p.name,exact:true}).click();
   const dialog=page.locator('dialog#'+p.id);
   assert.ok(await dialog.evaluate(d=>d.open),width+': '+p.name+' opens');
   assert.equal(await dialog.locator('h2').innerText(),p.name);
   assert.equal(await dialog.locator('ol li').count(),p.steps.length,p.name+' lists every step');
   assert.match(await dialog.innerText(),/How to connect it/);
   const box=await dialog.boundingBox();
   assert.ok(box.x>=0&&box.x+box.width<=width+1,width+': '+p.name+' window fits the screen');
   await page.keyboard.press('Escape');
   assert.equal(await dialog.evaluate(d=>d.open),false,p.name+' closes with Escape');
  }
  // A click outside the window closes it too.
  await page.getByRole('button',{name:providers[0].name,exact:true}).click();
  await page.mouse.click(4,4);
  assert.equal(await page.locator('dialog#'+providers[0].id).evaluate(d=>d.open),false,'a click outside closes it');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,width+': no sideways scroll');
 }
 // Connections not yet open to businesses say so, and offer a question instead of a sign-up.
 const soon=providers.find(p=>p.status);
 if(soon){const page=await browser.newPage();await page.goto(origin+'/integrations');await page.getByRole('button',{name:soon.name,exact:true}).click();
  assert.match(await page.locator('dialog#'+soon.id+' footer').innerText(),/Ask about/);}

 // New customer: the delivery address heading and fields sit inside their box, not on its edge.
 const page=await browser.newPage();
 await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 await page.goto(origin+'/sales/customers/new');
 const gaps=await page.evaluate(()=>{const set=document.querySelector('fieldset.addr-set.rm-work'),box=set.getBoundingClientRect();
  return [set.querySelector('legend'),set.querySelector('.addr__f')].map(e=>{const r=e.getBoundingClientRect();return {left:Math.round(r.left-box.left),top:Math.round(r.top-box.top)};});});
 for(const gap of gaps)assert.ok(gap.left>=12&&gap.top>=10,'words keep off the box edge: '+JSON.stringify(gaps));
});

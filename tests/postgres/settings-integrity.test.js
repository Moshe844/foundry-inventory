'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('Settings separates full ledger audits from ordinary navigation',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,integrity=require('../../src/operations/postgres-integrity-check');let audits=0;
 const observed=Object.create(db);observed.query=async(sql,args)=>{if(sql.startsWith('WITH movement AS'))audits++;return db.query(sql,args);};
 const app=require('../../src/postgres-app').createPostgresApp({database:observed,env:'test',sessionSecret:'settings-integrity-fixture'}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const page=await browser.newPage(),origin='http://127.0.0.1:'+server.address().port;page.setDefaultTimeout(15000);await page.goto(origin+'/login');await page.locator('[name=email]').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 await t.test('opening Settings does not scan stock or journal history and never claims unchecked records balanced',async()=>{
  await page.goto(origin+'/settings');assert.equal(audits,0);assert.match(await page.locator('#integrity-check-result').innerText(),/Run a full check/);assert.doesNotMatch(await page.locator('#integrity-check-result').innerText(),/Every balance matches/);await page.getByRole('heading',{name:'AI spending protection',exact:true}).waitFor();
 });
 await t.test('an explicit browser check audits once and shows the dated real result',async()=>{
  await page.getByRole('button',{name:'Check inventory integrity',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#integrity-check-result').textContent.includes('Later changes are not included'));
  assert.equal(audits,1);assert.match(await page.locator('#integrity-check-result').innerText(),/balanced at this check/);assert.equal(await page.locator('#integrity-check-badge').innerText(),'balanced at last check');
  await page.reload();assert.equal(audits,1);assert.match(await page.locator('#integrity-check-result').innerText(),/Last checked/);
  await page.getByRole('button',{name:'Check inventory integrity',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#integrity-check-result').textContent.includes('Later changes are not included'));assert.equal(audits,1);
  assert.equal(integrity.current(observed,'another-inventory').status,'NOT_CHECKED');
 });
 await t.test('overlapping audits share work and respect a bounded concurrency limit',async()=>{
  const resolvers=[],fake={query:()=>new Promise(resolve=>resolvers.push(()=>resolve({rows:[{balance_differences:0,prohibited_negative:0,unbalanced_journals:0,serial_differences:0,lot_differences:0}]})))};
  const a=integrity.run(fake,'a'),again=integrity.run(fake,'a'),b=integrity.run(fake,'b');assert.equal(resolvers.length,2);
  await assert.rejects(integrity.run(fake,'c'),/Two inventory checks/);resolvers.forEach(resolve=>resolve());assert.deepEqual(await a,await again);assert.equal((await b).result.ok,true);assert.equal(integrity.current(fake,'c').status,'NOT_CHECKED');
 });
 await t.test('an audit error is retryable and is never presented as a verified result',async()=>{
  let fail=true;const fake={query:async()=>{if(fail)throw Error('fixture unavailable');return {rows:[{balance_differences:0}]};}};await assert.rejects(integrity.run(fake,'a'),/fixture unavailable/);assert.equal(integrity.current(fake,'a').status,'ERROR');assert.equal(integrity.current(fake,'a').checkedAt,null);fail=false;assert.equal((await integrity.run(fake,'a')).status,'READY');
 });
});

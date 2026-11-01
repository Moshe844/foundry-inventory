'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),path=require('path'),{chromium}=require('playwright');
test('pending report stays locked past the shared form timer and duplicate submits cannot start paid work',{timeout:30000},async t=>{
 const app=express();app.use(express.static(path.resolve(__dirname,'../../src/web/public')));let calls=0,respond;
 app.get('/',(req,res)=>res.send('<html><body><form data-report-describe method="post" action="/describe"><textarea aria-label="Report" name="q"></textarea><button type="submit">Build it for me</button><p data-report-build-status hidden></p></form><script defer src="/app.js"></script><script defer src="/reports.js"></script></body></html>'));
 app.post('/describe',(req,res)=>{calls++;respond=()=>res.status(422).json({ok:false,message:'Please choose a supported measure. No AI credits were used.'});});
 const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await chromium.launch(),page=await browser.newPage();
 t.after(async()=>{respond?.();await browser.close();await new Promise(r=>server.close(r));});
 await page.goto('http://127.0.0.1:'+server.address().port);await page.getByLabel('Report').fill('Stock and costs');await page.getByRole('button',{name:'Build it for me'}).click();
 await page.waitForTimeout(4200);assert.equal(await page.getByRole('button',{name:'Build it for me'}).isDisabled(),true);assert.equal(calls,1);
 await page.locator('form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.equal(calls,1);
 const complete=respond;respond=null;complete();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').textContent(),/No AI credits were used/);assert.equal(await page.getByRole('button',{name:'Build it for me'}).isEnabled(),true);assert.equal(await page.getByLabel('Report').inputValue(),'Stock and costs');
});

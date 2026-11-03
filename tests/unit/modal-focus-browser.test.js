'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),express=require('express'),{chromium}=require('playwright');
test('opening a dialog cannot steal focus from a field the person has already chosen',{timeout:20000},async t=>{
 const app=express();app.get('/app.js',(req,res)=>res.sendFile(path.resolve(__dirname,'../../src/web/public/app.js')));app.get('/',(req,res)=>res.send('<button data-modal-open="supplier">Add supplier</button><dialog id="supplier"><form><label>Name<input name="name"></label><label>Email<input name="email" type="email"></label><button type="button" data-modal-close>Cancel</button></form></dialog><script src="/app.js" defer></script>'));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),browser=await chromium.launch();t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 // Hold short focus callbacks until after the person moves to Email. This
 // recreates a busy browser frame without a timing-dependent sleep.
 await page.addInitScript(()=>{const original=window.setTimeout;window.modalFocusCallbacks=[];window.setTimeout=(callback,delay,...args)=>delay===30?(window.modalFocusCallbacks.push(()=>callback(...args)),987654):original(callback,delay,...args);});
 await page.goto('http://127.0.0.1:'+server.address().port+'/');
 await page.getByRole('button',{name:'Add supplier',exact:true}).click();
 assert.equal(await page.getByLabel('Name',{exact:true}).evaluate(e=>e===document.activeElement),true);
 await page.getByLabel('Name',{exact:true}).fill('Puma Trade');await page.getByLabel('Email',{exact:true}).focus();
 await page.evaluate(()=>window.modalFocusCallbacks.splice(0).forEach(callback=>callback()));
 assert.equal(await page.getByLabel('Email',{exact:true}).evaluate(e=>e===document.activeElement),true,'the dialog must not return focus to Name after the person chose Email');
 await page.keyboard.insertText('puma@example.test');assert.equal(await page.getByLabel('Name',{exact:true}).inputValue(),'Puma Trade');assert.equal(await page.getByLabel('Email',{exact:true}).inputValue(),'puma@example.test');assert.deepEqual(errors,[]);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
test('host browser verification fetches fresh same-page state and preserves screenshot envelope pointers',{timeout:30000},async t=>{
 let visits=0,units=5;
 const server=http.createServer((_req,res)=>{visits++;res.setHeader('content-type','text/html');res.setHeader('x-stockchief-page','1');res.end(`<html><head><title>Unexpected stock form</title></head><body><main><h1>Unknown stock</h1><p>Physical units: ${units}</p><form method="get"><label>Count<input name="new_field_${units}" value="${units}"></label></form></main></body></html>`);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await require('playwright').chromium.launch({headless:true});t.after(()=>browser.close());
 const tools=await require('../../scripts/environment-agent-demo/browser').createBrowserTools(browser,{origin});
 t.after(()=>tools.close());const before=await tools.act({action:'inspect',ref:null,value:null});assert.match(before.text,/5/);
 units=8;const prior=visits;
 const lazy=require('../../scripts/environment-agent-demo/lazy-browser').lazyBrowser(async()=>tools);
 const after=await lazy.verifyObservation(before.url);assert(visits>prior,'Same URL must make a new server request');assert.match(after.text,/8/);assert(after.controls.some(c=>c.name==='new_field_8'));
 const h={evidence:{}},entry=require('../../scripts/environment-agent-demo/observations').store(h,{id:'goal:1',name:'environment_browser',result:{screen:before,image:{mimeType:'image/png',base64:'NOT_USED'}},source:{version:1,name:'environment_browser',input:{action:'screenshot',ref:null,value:null}}});
 const fresh=await require('../../src/assistant/agent-evidence-verification').current({query:async()=>({rows:[]})},{},{checkpoint:{harness:h}},entry,{browser:lazy});
 assert.match(fresh.screen.text,/8/);assert.equal(fresh.image,undefined,'Verification does not copy an old screenshot into current evidence');
 await assert.rejects(lazy.verifyObservation('https://external.example.test/'),/ORIGIN/);
});

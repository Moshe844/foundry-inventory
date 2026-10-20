'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{randomUUID}=require('node:crypto');
test('authorized interface paths and empty read handoffs work without admitting guessed or external paths',async t=>{
 const paths=['/list-'+randomUUID(),'/empty-'+randomUUID()],requests=[];
 const server=http.createServer((req,res)=>{requests.push({method:req.method,url:req.url});res.setHeader('x-stockchief-page','1');res.setHeader('content-type','text/html');res.end('<title>Fixture</title><main><h1>Recorded list</h1><p>No records</p></main>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await require('playwright').chromium.launch();let tools;
 t.after(async()=>{await tools?.close();await browser.close();await new Promise(r=>server.close(r));});
 tools=await require('../../scripts/environment-agent-demo/browser').createBrowserTools(browser,{origin,startPath:paths[0],interfacePaths:[paths[0],'https://outside.example.test/private','//outside.example.test/private']});
 const opened=await tools.act({action:'open',value:paths[0],ref:null});assert.equal(opened.httpStatus,200);assert.equal(opened.applicationPage,true);assert.equal(new URL(opened.url).pathname,paths[0]);
 assert.equal(requests.filter(r=>r.url==='/').length,0,'A known first target does not need a homepage tour');
 const guessed='/unknown-'+randomUUID();assert.equal((await tools.act({action:'open',value:guessed,ref:null})).error.code,'UNOBSERVED_APPLICATION_PATH');assert(!requests.some(r=>r.url===guessed));
 tools.observeReadLinks([{capability:'read.customer_returns',result:{status:'ANSWERED',rows:[],handoff:{href:paths[1]}}}]);
 assert.equal(new URL((await tools.act({action:'open',value:paths[1],ref:null})).url).pathname,paths[1]);
 const unsafe='/private?token=not-transferable';tools.observeReadLinks([{capability:'read.customer_returns',result:{status:'ANSWERED',rows:[],handoff:{href:unsafe}}}]);
 assert.equal((await tools.act({action:'open',value:unsafe,ref:null})).error.code,'UNOBSERVED_APPLICATION_PATH');
 assert.equal((await tools.act({action:'open',value:'https://outside.example.test/private',ref:null})).error.code,'UNOBSERVED_APPLICATION_PATH');
 assert(requests.every(r=>r.method==='GET'));
});

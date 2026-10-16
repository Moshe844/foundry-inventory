'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {randomUUID}=require('node:crypto'),{chromium}=require('playwright');
const {createBrowserTools}=require('../../scripts/environment-agent-demo/browser');
// Mechanical recovery tests, never scored as an agent's business performance.
test('browser reports navigation failures, rejects old-session references and restores only its observed origin',async t=>{
 const target='/'+randomUUID();let reads=0,posts=0;
 const server=http.createServer((request,response)=>{
  if(request.method==='POST')posts++;
  response.setHeader('content-type','text/html');
  if(request.url===target&&++reads===1){response.statusCode=503;response.end('<body>Temporary record read failure</body>');return;}
  response.end(`<body><a href="${target}">Unfamiliar records</a><form method="post"><button>Commit</button></form><div>Current view</div></body>`);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true});
 t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
 const ui=await createBrowserTools(browser,{origin}),entry=await ui.inspect();
 const link=entry.controls.find(c=>c.label==='Unfamiliar records');
 const failed=await ui.act({action:'click',ref:link.ref});assert.equal(failed.httpStatus,503);assert.match(failed.text,/failure/);
 const fresh=await ui.act({action:'refresh'});assert.equal(fresh.httpStatus,200);assert.match(fresh.text,/Current view/);
 const newUi=await createBrowserTools(browser,{origin});
 const restored=await newUi.restore(fresh.url);assert.equal(restored.url,fresh.url);
 const stale=await newUi.act({action:'click',ref:fresh.controls[0].ref});assert.equal(stale.error.code,'STALE_BROWSER_REFERENCE');
 assert.notEqual(stale.screen.controls[0].ref,fresh.controls[0].ref);
 const denied=await newUi.restore('https://example.test/elsewhere');assert.equal(denied.error.code,'RESTORE_ORIGIN_CHANGED');
 assert.equal(newUi.page.url(),fresh.url);
 const dynamic='/'+randomUUID();
 assert.equal((await newUi.act({action:'open',value:dynamic})).error.code,'UNOBSERVED_APPLICATION_PATH');
 newUi.observeReadLinks([{capability:'read.purchase_orders',result:{status:'ANSWERED',rows:[{href:dynamic},{href:'https://outside.example/records'}]}}]);
 assert.equal((await newUi.act({action:'open',value:dynamic})).url,origin+dynamic);
 assert.equal((await newUi.act({action:'open',value:'https://outside.example/records'})).error.code,'UNOBSERVED_APPLICATION_PATH');
 const untrusted='/'+randomUUID();
 newUi.observeReadLinks([{capability:'supplier.create',result:{status:'ANSWERED',rows:[{href:untrusted}]}},{capability:'read.purchase_orders',result:{status:'FAILED',rows:[{href:untrusted}]}}]);
 assert.equal((await newUi.act({action:'open',value:untrusted})).error.code,'UNOBSERVED_APPLICATION_PATH');
 const reported='/'+randomUUID(),report={rows:[{href:reported},{href:'//outside.example/record'},{href:'https://outside.example/record'},{href:'javascript:alert(1)'}]};
 newUi.observeDatasetLinks(report);
 assert.equal((await newUi.act({action:'open',value:reported})).url,origin+reported,'Exact governed report link must be usable');
 assert.equal((await newUi.act({action:'open',value:reported+'/guessed'})).error.code,'UNOBSERVED_APPLICATION_PATH');
 assert.equal((await newUi.act({action:'open',value:'//outside.example/record'})).error.code,'UNOBSERVED_APPLICATION_PATH');
 const restarted=await createBrowserTools(browser,{origin});
 assert.equal((await restarted.act({action:'open',value:reported})).error.code,'UNOBSERVED_APPLICATION_PATH');
 require('../../scripts/environment-agent-demo/read-navigation').restoreReadLinks(restarted,{original:{name:'environment_dataset',text:JSON.stringify(report)}});
 assert.equal((await restarted.act({action:'open',value:reported})).url,origin+reported,'Durable report evidence restores the same guarded link after restart');
 await restarted.close();
 const current=await newUi.inspect();
 const commit=current.controls.find(c=>c.label==='Commit');
 const blocked=await newUi.act({action:'click',ref:commit.ref});assert.equal(blocked.httpStatus,403);assert.equal(posts,0);
 await ui.close();await newUi.close();
});

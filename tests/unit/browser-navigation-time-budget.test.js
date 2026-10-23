'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{randomUUID}=require('node:crypto'),{chromium}=require('playwright'),{createBrowserTools}=require('../../scripts/environment-agent-demo/browser');
test('slow application GETs do not inherit the shorter control-interaction timeout',{timeout:45000},async t=>{
 const paths=['/'+randomUUID(),'/'+randomUUID()],requests=[];
 const server=http.createServer((req,res)=>{requests.push({method:req.method,path:req.url});setTimeout(()=>{res.setHeader('content-type','text/html');res.end('<html><title>Records</title><body>Current records are available</body></html>');},5600);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch(),origin='http://127.0.0.1:'+server.address().port;let ui;t.after(async()=>{if(ui)await ui.close();await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 ui=await createBrowserTools(browser,{origin,startPath:paths[0],observedPaths:paths});assert.match((await ui.inspect()).text,/Current records are available/);
 const screen=await ui.act({action:'open',value:paths[1]});assert.equal(screen.httpStatus,200);assert.match(screen.text,/Current records are available/);
 const at=Date.now();await assert.rejects(ui.page.locator('#missing-control').click(),/Timeout 5000ms/);assert(Date.now()-at<8000,'Control lookup must keep its existing short bound');
 assert(requests.every(r=>r.method==='GET'));assert.equal(requests.filter(r=>paths.includes(r.path)).length,2,'A slow read must not be automatically resubmitted');
});

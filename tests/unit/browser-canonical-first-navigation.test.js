'use strict';const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{randomUUID,createHash}=require('node:crypto');
test('a canonical record link is available before browser startup without loading the home page',async t=>{
 const link='/record-'+randomUUID()+'?view=history',requests=[],entry=result=>{const text=JSON.stringify(result);return {name:'business_operations',text,sha256:createHash('sha256').update(text).digest('hex')};};
 const evidence={read:entry({outcomes:[{capability:'read.connections',result:{status:'ANSWERED',rows:[{href:link},{href:'/private?token=secret'}]}}]})};
 const navigation=require('../../scripts/environment-agent-demo/read-navigation'),paths=navigation.paths(evidence);assert.deepEqual(paths,[link]);
 const server=http.createServer((req,res)=>{requests.push(req.url);if(req.url==='/'){res.statusCode=503;return res.end('A homepage is not needed to read a discovered record.');}res.setHeader('content-type','text/html');res.setHeader('x-stockchief-page','1');res.end('<title>A record</title><main>Fresh record</main>');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await require('playwright').chromium.launch();let ui;t.after(async()=>{await ui?.close();await browser.close();await new Promise(resolve=>server.close(resolve));});
 const first={action:'open',value:link},startPath=navigation.initialPath(first,{evidence,fallback:'/'});assert.equal(startPath,link);
 ui=await require('../../scripts/environment-agent-demo/browser').createBrowserTools(browser,{origin:'http://127.0.0.1:'+server.address().port,startPath,observedPaths:paths});
 const opened=await ui.act(first);assert.equal(opened.httpStatus,200);assert.equal(requests.includes('/'),false);assert.equal(new URL(opened.url).pathname+new URL(opened.url).search,link);
 assert.equal((await ui.act({action:'open',value:'/guessed'})).error.code,'UNOBSERVED_APPLICATION_PATH');assert.equal(requests.includes('/guessed'),false);
 evidence.read.sha256='0'.repeat(64);assert.deepEqual(navigation.paths(evidence),[]);assert.equal(navigation.initialPath(first,{evidence,fallback:'/'}),'/');
});

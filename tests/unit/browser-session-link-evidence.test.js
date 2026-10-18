'use strict';const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const links=require('../../scripts/environment-agent-demo/browser-link-evidence');
test('session credentials are never transferable evidence while ordinary application destinations remain intact',()=>{
 for(const href of ['/page?ticket=private','/page?accessToken=private','/page?token[]=private','/page?token[0]=private','/page?%2574oken=private','/page#access_token=private','https://user:password@example.test/','javascript:alert(1)']){
  assert.equal(links.transferable(href),false,href);const row=links.control({tag:'a',label:'Review account',href});assert.equal(row.href,null);assert.equal(row.sessionBoundDestination,true);assert(!JSON.stringify(row).includes('private'));
 }
 for(const href of ['/page?search=example&page=2','/inventory?sku=UNFAMILIAR','/ask?goal=owned#focused-goal','mailto:buyer@example.test','tel:+15555550100'])assert.equal(links.control({href}).href,href);
 assert.deepEqual(links.control({form:{method:'get',action:'/review?csrfToken=private',label:'Review'}}).form,{method:'get',action:null,label:'Review',sessionBoundDestination:true});
});
test('the recorded changing authorization-ticket class stays private and stable across fresh browser verification',{timeout:30000},async t=>{
 let ticket=0;const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.setHeader('x-stockchief-page','1');res.end(`<html><head><title>Connection setup</title></head><body><main><h1>Connection setup</h1><a href="/authorize?ticket=PRIVATE-${++ticket}">Connect provider</a><a href="/settings">Stable settings</a><button type="button" onclick="document.getElementById('notice').textContent='Opened locally'">Details</button><p id="notice"></p></main></body></html>`);});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const origin='http://127.0.0.1:'+server.address().port,browser=await require('playwright').chromium.launch({headless:true});t.after(()=>browser.close());const tools=await require('../../scripts/environment-agent-demo/browser').createBrowserTools(browser,{origin});t.after(()=>tools.close());
 const prior=await tools.inspect(),index=prior.controls.findIndex(c=>c.label==='Connect provider');assert(index>=0);assert.equal(prior.controls[index].href,null);assert.equal(prior.controls[index].sessionBoundDestination,true);assert(prior.controls[index].ref);assert(!JSON.stringify(prior).includes('PRIVATE-'));
 const current=await tools.verifyObservation(prior.url,prior);assert(ticket>=2);assert.equal(require('../../src/assistant/browser-control-verification').unchangedControl(prior,current,'/controls/'+index+'/label').matched,true);
 assert.equal(current.controls.find(c=>c.label==='Stable settings').href,'/settings');const details=current.controls.find(c=>c.label==='Details');const after=await tools.act({action:'click',ref:details.ref,value:null});assert(after.text.includes('Opened locally'),'Opaque control interaction continues to work');
 const changed=structuredClone(current);changed.controls[index].disabled=true;assert.equal(require('../../src/assistant/browser-control-verification').unchangedControl(prior,changed,'/controls/'+index+'/label').matched,false,'Real control changes are still rejected');
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function worker(fetch,origin='https://stockchief-staging-web.onrender.com/'){const listeners={},self={location:new URL(origin),addEventListener:(name,fn)=>listeners[name]=fn};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../src/web/public/edge-error-worker.js'),'utf8'),{self,fetch,URL,Response});return async(request)=>{let result;listeners.fetch({request,respondWith:promise=>result=promise});return result;};}
test('gateway and connection failures show branded status without caching data or retrying a write',async()=>{
 for(const status of [502,503,504,0]){let calls=0;const run=worker(async()=>{calls++;if(!status)throw Error('offline');return new Response('Bad Gateway',{status});});const response=await run({mode:'navigate',url:'https://stockchief-staging-web.onrender.com/orders',method:'POST'});assert.equal(response.status,status||503);const text=await response.text();assert(text.includes('StockChief'));assert(text.includes('Your last action may have reached StockChief'));assert(text.includes('https://moshe844.github.io/stockchief-status/'));assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(calls,1);}
});
test('healthy pages, app permission errors, APIs and other origins remain authoritative',async()=>{
 const healthy=new Response('<title>StockChief</title>Saved',{status:200}),run=worker(async()=>healthy);assert.equal(await run({mode:'navigate',url:'https://stockchief-staging-web.onrender.com/',method:'GET'}),healthy);assert.equal(await run({mode:'cors',url:'https://stockchief-staging-web.onrender.com/api/search',method:'GET'}),undefined);assert.equal(await run({mode:'navigate',url:'https://example.test/',method:'GET'}),undefined);
 const denied=new Response('<title>Permission · StockChief</title>No access',{status:403,headers:{'Content-Type':'text/html'}});assert.equal(await worker(async()=>denied)({mode:'navigate',url:'https://stockchief-staging-web.onrender.com/settings',method:'GET'}),denied);
});

test('the qualification domain links directly to off-provider status when its origin is offline',async()=>{
 let calls=0;const run=worker(async()=>{calls++;throw Error('origin offline');},'https://qualify.stockchiefhq.com/');
 const response=await run({mode:'navigate',url:'https://qualify.stockchiefhq.com/inventory',method:'GET'}),html=await response.text();
 assert.equal(response.status,503);assert.match(html,/href="https:\/\/moshe844.github.io\/stockchief-status\/"/);assert.doesNotMatch(html,/href="\/status"/);assert.equal(calls,1);assert.equal(response.headers.get('cache-control'),'no-store');
});

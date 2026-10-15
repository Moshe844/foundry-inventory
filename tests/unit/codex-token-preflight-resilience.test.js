'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createTokenCounter,policy}=require('../../scripts/environment-agent-demo/codex-token-counter');
const ok=()=>Response.json({object:'response.input_tokens',input_tokens:40619});
const input={model:'gpt-6.1-sol',reasoning:{effort:'low'},input:[{role:'user',content:'Growing recorded browser context '.repeat(6000)}]};
test('recorded DOM timeout code 23 retries only the identical non-generating native count and never estimates',async()=>{
 const calls=[],counter=createTokenCounter({apiKey:'FAKE',fetchImpl:async(url,init)=>{calls.push({url,body:init.body,redirect:init.redirect});if(calls.length===1)throw new DOMException('The operation was aborted due to timeout','TimeoutError');return ok();}});
 assert.equal((await counter(input)).input_tokens,40619);assert.equal(calls.length,2);assert.equal(calls[0].body,calls[1].body);assert.deepEqual(JSON.parse(calls[0].body),input);assert(calls.every(c=>c.url==='https://api.openai.com/v1/responses/input_tokens'&&c.redirect==='error'));
});
test('a stalled count has one bounded alternate count and cancels the losing transport',async()=>{
 let calls=0,aborted=0;const counter=createTokenCounter({apiKey:'FAKE',afterDelay:fn=>setTimeout(fn,1),fetchImpl:async(_url,{signal})=>{calls++;if(calls===2)return ok();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(new DOMException('Cancelled','AbortError'));},{once:true}));}});
 assert.equal((await counter(input)).input_tokens,40619);assert.equal(calls,2);assert.equal(aborted,1);
});
test('authentication, rate limits, invalid count data and oversized replies remain fail closed without extra calls',async()=>{
 for(const response of [()=>new Response('',{status:401}),()=>new Response('',{status:429}),()=>new Response('',{status:503,headers:{'retry-after':'10'}}),()=>Response.json({object:'response.input_tokens',input_tokens:'40619'}),()=>new Response('x'.repeat(16001))]){
  let calls=0;const counter=createTokenCounter({apiKey:'FAKE',fetchImpl:async()=>{calls++;return response();}});await assert.rejects(counter(input));assert.equal(calls,1);
 }
 let calls=0;await assert.rejects(createTokenCounter({apiKey:'FAKE',fetchImpl:async()=>{calls++;return new Response('',{status:503});}})(input),e=>e.code==='CODEX_TOKEN_COUNT_UNAVAILABLE'&&e.upstreamAttempted===false&&e.preflightAttempts===2);assert.equal(calls,2);
});
test('both stalled transports stop inside the original 30-second preflight deadline with no fallback estimate',{timeout:35000},async t=>{
 const keepAlive=setTimeout(()=>{},34000);t.after(()=>clearTimeout(keepAlive));let calls=0;
 const counter=createTokenCounter({apiKey:'FAKE',afterDelay:fn=>setTimeout(fn,1),fetchImpl:async(_url,{signal})=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Timeout','TimeoutError')),{once:true}));}}),at=Date.now();
 await assert.rejects(counter(input),e=>e.code==='CODEX_TOKEN_COUNT_UNAVAILABLE'&&e.reason==='timeout'&&e.upstreamAttempted===false);assert.equal(calls,2);assert(Date.now()-at<=31000);assert.equal(policy.totalTimeoutMs,30000);
});

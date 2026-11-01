'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{rateLimit}=require('../../src/web/middleware');
test('request limits isolate clients, return retry guidance and cap active client memory',t=>{
 let now=10000;t.mock.method(Date,'now',()=>now);const limit=rateLimit({windowMs:1000,max:2,maxBuckets:2});
 function call(ip){const headers={};let status=200,next=false,body;const response={set:(k,v)=>{headers[k]=v;return response;},status:value=>{status=value;return response;},json:value=>{body=value;return response;}};limit({ip},response,()=>next=true);return {headers,status,next,body};}
 assert(call('first').next);assert(call('first').next);const blocked=call('first');assert.equal(blocked.status,429);assert.equal(blocked.headers['Retry-After'],'1');assert.equal(blocked.body.error.code,'rate_limited');assert(call('second').next);assert.equal(call('third').status,429,'A flood of distinct clients cannot allocate unlimited buckets');now+=1001;assert(call('third').next,'Expired buckets release capacity');
});

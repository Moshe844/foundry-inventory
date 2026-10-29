'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const {readResponseText}=require('../../src/connections/providers/common');
test('provider response size is measured in decoded bytes and cancels a chunked overflow',async()=>{
 let cancelled=false;
 const response=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(7));c.enqueue(new Uint8Array(7));},cancel(){cancelled=true;}}),{headers:{'content-length':'1'}});
 await assert.rejects(readResponseText(response,10),/too large/);assert.equal(cancelled,true);
 assert.equal(await readResponseText(new Response('é'),2),'é');await assert.rejects(readResponseText(new Response('é'),1),/too large/);
});
test('oversized declared responses are cancelled before consuming their body',async()=>{
 let cancelled=false;const response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':'100'}});
 await assert.rejects(readResponseText(response,10),/too large/);assert(cancelled);
});

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('Gmail transports exact resized photo bytes in multipart MIME and preserves its plain-message path',async t=>{
 const sent=[];t.mock.method(global,'fetch',async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({id:'gmail-accepted',threadId:'thread'}),{status:200,headers:{'content-type':'application/json'}});});
 const provider=require('../../src/connections/providers/gmail'),content=Buffer.from([255,216,255,1,2,3]),message={id:'test-claim',recipient:'supplier@example.test',subject:'Claim · damaged boxes',body:'Physically checked damage. No settlement approved.',attachments:[{filename:'damage-photo-test.jpg',contentType:'image/jpeg',content}]};
 assert.equal((await provider.send({credentials:{accessToken:'synthetic'},message})).externalMessageId,'gmail-accepted');
 const raw=Buffer.from(sent[0].body.raw,'base64url').toString();assert.match(raw,/multipart\/mixed/);assert.match(raw,/filename="damage-photo-test.jpg"/);assert.match(raw,new RegExp(content.toString('base64')));assert.match(raw,/Content-Transfer-Encoding: base64/);assert.match(raw,/X-StockChief-Message: test-claim/);
 const plain={...message,attachments:undefined};await provider.send({credentials:{accessToken:'synthetic'},message:plain});const text=Buffer.from(sent[1].body.raw,'base64url').toString();assert.doesNotMatch(text,/multipart/);assert.match(text,/Physically checked damage/);
 await assert.rejects(provider.send({credentials:{accessToken:'synthetic'},message:{...message,subject:'injected\r\nBcc: other@example.test'}}),/one line/);assert.equal(sent.length,2);
});
test('Microsoft 365 transports exact photo copies with Graph attachment fields and does not add empty attachments',async t=>{
 const sent=[];t.mock.method(global,'fetch',async(url,options)=>{sent.push(JSON.parse(options.body));return new Response(null,{status:202});});
 const provider=require('../../src/connections/providers/microsoft365'),content=Buffer.from([255,216,255,9,8,7]),message={id:'test-graph-claim',recipient:'supplier@example.test',subject:'Actual damaged goods',body:'Individual claim',attachments:[{filename:'damage-copy.jpg',contentType:'image/jpeg',content}]};
 await provider.send({credentials:{accessToken:'synthetic'},message});const p=sent[0].message.attachments[0];assert.equal(p['@odata.type'],'#microsoft.graph.fileAttachment');assert.equal(p.name,'damage-copy.jpg');assert.deepEqual(Buffer.from(p.contentBytes,'base64'),content);assert.equal(sent[0].saveToSentItems,true);
 await provider.send({credentials:{accessToken:'synthetic'},message:{...message,attachments:undefined}});assert(!Object.hasOwn(sent[1].message,'attachments'));
 await assert.rejects(provider.send({credentials:{accessToken:'synthetic'},message:{...message,attachments:[{...message.attachments[0],content:Buffer.alloc(614401)}]}}),/attachment needs review/);assert.equal(sent.length,2);
});
test('Photo preparation rejects non-photo, corrupt and oversized files before interpreting them',async()=>{
 const photos=require('../../src/operations/quality-photos');await assert.rejects(photos.emailCopy(Buffer.from('<svg><script>test</script></svg>')),/JPEG or PNG/);await assert.rejects(photos.emailCopy(Buffer.from([255,216,255,0])),/could not be read/);await assert.rejects(photos.emailCopy(Buffer.alloc(10485761)),/10 MB/);
});
test('Photo preparation bounds simultaneous decodes and releases capacity after completion',async()=>{
 const bytes=await require('sharp')({create:{width:128,height:128,channels:3,background:'#6a4b2a'}}).png().toBuffer(),photos=require('../../src/operations/quality-photos');
 const outcomes=await Promise.allSettled([photos.emailCopy(bytes),photos.emailCopy(bytes),photos.emailCopy(bytes)]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,2);assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);assert.match(outcomes.find(r=>r.status==='rejected').reason.message,/Two delivery photos/);assert((await photos.emailCopy(bytes)).bytes.length>0);
});

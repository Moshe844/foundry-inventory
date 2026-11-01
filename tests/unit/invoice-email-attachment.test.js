'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('invoice attachments use saved base64 bytes and never ask the email provider to fetch a URL',async()=>{
 const send=require('../../src/operations/email').sendResend,attachment={filename:'Invoice-100.pdf',content:Buffer.from('%PDF-test').toString('base64'),content_type:'application/pdf'};let calls=0;
 const options={apiKey:'fixture-key',from:'test@example.test',fetch:async(url,input)=>{calls++;assert.equal(url,'https://api.resend.com/emails');assert.deepEqual(JSON.parse(input.body).attachments,[attachment]);return {ok:true,json:async()=>({id:'simulated-email'})};}};
 await send({to:'customer@example.test',subject:'Invoice',text:'Invoice attached',attachments:[attachment]},options);assert.equal(calls,1);
 await assert.rejects(send({attachments:[{...attachment,path:'https://example.test/private'}]},options),/saved base64/);await assert.rejects(send({attachments:[{...attachment,filename:'../private.pdf'}]},options),/safe filename/);assert.equal(calls,1);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {verifyEvent}=require('../../src/payments/providers/stripe');
test('Stripe signing-key rotation accepts any valid v1 signature and retains timestamp/body validation',()=>{
 const key='whsec_fixture',raw=JSON.stringify({id:'evt_fixture',livemode:true}),t=String(Math.floor(Date.now()/1000));
 const signed=(time,body=raw)=>crypto.createHmac('sha256',key).update(time+'.'+body).digest('hex');
 const good=signed(t),other='a'.repeat(64),verify=(signature,body=raw)=>verifyEvent(body,{'stripe-signature':signature},{webhookSecret:key});
 for(const signature of [`t=${t},v1=${good},v1=${other}`,`t=${t},v1=${other},v1=${good}`])assert.equal(verify(signature).id,'evt_fixture');
 assert.throws(()=>verify(`t=${t},v1=${other}`),/did not come from Stripe/);
 assert.throws(()=>verify(`t=${t},v1=${good}`,raw+' '),/did not come from Stripe/);
 assert.throws(()=>verify(`t=${t},t=${t},v1=${good}`),/not in a form/);
 const old=String(Number(t)-301);assert.throws(()=>verify(`t=${old},v1=${signed(old)}`),/too old/);
});

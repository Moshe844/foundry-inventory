'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
for(const name of ['easypost','shippo'])test(name+' refuses unsigned events when no customer secret is configured',()=>{
 const adapter=require('../../src/shipping/providers/'+name);
 assert.throws(()=>adapter.verifyEvent(Buffer.from('{}'),{},{webhookSecret:null}),/secret|configured|signature/i);
});
test('Shippo verifies a documented URL token or fresh HMAC, never an absent token',()=>{
 const provider=require('../../src/shipping/providers/shippo'),raw=Buffer.from('{"event":"track_updated"}'),secret='customer-webhook-secret',timestamp=String(Math.floor(Date.now()/1000));
 assert.throws(()=>provider.verifyEvent(raw,{},{webhookSecret:secret}),/secret|signature/i);
 assert.equal(provider.verifyEvent(raw,{},{webhookSecret:secret,presentedToken:secret}).event,'track_updated');
 const signature=crypto.createHmac('sha256',secret).update(timestamp+'.').update(raw).digest('hex');
 assert.equal(provider.verifyEvent(raw,{'shippo-auth-signature':`t=${timestamp},v1=${signature}`},{webhookSecret:secret}).event,'track_updated');
 assert.throws(()=>provider.verifyEvent(raw,{'shippo-auth-signature':`t=1,v1=${signature}`},{webhookSecret:secret}),/old|signature|expired/i);
});
test('Shippo evolving tracking events do not reuse the tracker object identity',()=>{
 const provider=require('../../src/shipping/providers/shippo');
 assert.equal(provider.readEvent({event:'track_updated',data:{object_id:'same-tracker',tracking_number:'TN',tracking_status:{status:'TRANSIT'}}}).externalEventId,null);
});

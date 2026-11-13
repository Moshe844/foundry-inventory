'use strict';

// Job 173: the outside services that carry alerts by text message and push.
//
// Like the system email sender, these are StockChief's own accounts, set by
// the server's environment, not by each business:
//  - text messages: a Twilio account (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
//    TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID);
//  - push: standard Web Push with the server's VAPID key pair
//    (WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY, WEB_PUSH_SUBJECT), sent to the
//    push service each browser chose (Chrome, Edge, Firefox, Safari).
// A channel without its settings is not offered. The worker can be given a
// different sender (the tests use fakes); the live senders refuse to run under
// NODE_ENV=test, so a test can never text a real number or reach a device.
//
// Each sender throws an error with the provider's HTTP `status` when it
// answered, or `providerOutcomeUncertain` when the call failed before an
// answer, so the worker never repeats a message that may have gone out.

const crypto=require('node:crypto');

const PHONE=/^\+[1-9]\d{7,14}$/;
// Browsers only hand out endpoints on these push services. Anything else is
// refused, so a saved device can never make the server call an arbitrary address.
const PUSH_HOSTS=/(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
const b64=value=>Buffer.from(String(value||''),'base64url');

function smsSettings(env=process.env){
  const sid=env.TWILIO_ACCOUNT_SID,token=env.TWILIO_AUTH_TOKEN,from=env.TWILIO_FROM_NUMBER,service=env.TWILIO_MESSAGING_SERVICE_SID;
  return sid&&token&&(from||service)?{sid,token,from:from||null,service:service||null}:null;
}
// Job 188: WhatsApp questions and answers use the same Twilio account with a
// WhatsApp-enabled sender (TWILIO_WHATSAPP_FROM, an E.164 number).
function whatsappSettings(env=process.env){
  const sid=env.TWILIO_ACCOUNT_SID,token=env.TWILIO_AUTH_TOKEN,from=env.TWILIO_WHATSAPP_FROM;
  return sid&&token&&PHONE.test(String(from||''))?{sid,token,from}:null;
}
function pushSettings(env=process.env){
  const publicKey=env.WEB_PUSH_PUBLIC_KEY,privateKey=env.WEB_PUSH_PRIVATE_KEY,subject=env.WEB_PUSH_SUBJECT||'mailto:support@stockchiefhq.com';
  if(!publicKey||!privateKey)return null;
  if(b64(publicKey).length!==65||b64(privateKey).length!==32)return null;
  return {publicKey,privateKey,subject};
}
// Which channels this server can offer.
function available(env=process.env){return {sms:Boolean(smsSettings(env)),push:Boolean(pushSettings(env))};}
function publicKey(env=process.env){return pushSettings(env)?.publicKey||null;}

function validEndpoint(value){
  try{const url=new URL(String(value||''));return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&PUSH_HOSTS.test(url.hostname)&&String(value).length<=1000;}
  catch{return false;}
}

function refuseInTests(){
  if(process.env.NODE_ENV==='test')throw Object.assign(new Error('Live text messages and push are off in tests.'),{status:400,code:'live_delivery_disabled'});
}
async function post(url,options){
  let response;
  try{response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});}
  catch(error){throw Object.assign(new Error('The provider did not answer. StockChief did not send it again.'),{providerOutcomeUncertain:true,cause:error});}
  return response;
}

// Twilio's Messages API. Returns {reference}. `from` sends from one of the
// account's own numbers (job 83 replies from the business's number, with
// `whatsapp:` addresses for WhatsApp); otherwise the server's sender is used.
const ADDRESS=/^(?:whatsapp:)?\+[1-9]\d{7,14}$/;
async function sendMessage({to,body,from=null},settings=smsSettings()){
  refuseInTests();
  if(!settings)throw Object.assign(new Error('Text messages are not set up on this server.'),{status:400});
  if(!ADDRESS.test(String(to||''))||from!==null&&!ADDRESS.test(String(from)))throw Object.assign(new Error('That is not a mobile number StockChief can text.'),{status:400});
  const form=new URLSearchParams({To:to,Body:String(body).slice(0,1500)});
  if(from)form.set('From',from);else if(settings.service)form.set('MessagingServiceSid',settings.service);else form.set('From',settings.from);
  const response=await post('https://api.twilio.com/2010-04-01/Accounts/'+encodeURIComponent(settings.sid)+'/Messages.json',{method:'POST',
    headers:{authorization:'Basic '+Buffer.from(settings.sid+':'+settings.token).toString('base64'),'content-type':'application/x-www-form-urlencoded'},body:form});
  const answer=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(String(answer.message||'The text message provider refused the message.').slice(0,300)),{status:response.status});
  return {reference:String(answer.sid||'')};
}
async function sendSms({to,body},settings=smsSettings()){
  refuseInTests();
  if(!settings)throw Object.assign(new Error('Text messages are not set up on this server.'),{status:400});
  if(!PHONE.test(String(to||'')))throw Object.assign(new Error('That is not a mobile number StockChief can text.'),{status:400});
  return sendMessage({to,body},settings);
}

// Twilio signs every message it sends to a StockChief link with the account's
// auth token: HMAC-SHA1 over the exact link and each posted field in name order.
function twilioSignature(url,params,token){
  const data=Object.keys(params).sort().reduce((text,key)=>text+key+[].concat(params[key]).join(''),String(url));
  return crypto.createHmac('sha1',token).update(Buffer.from(data,'utf8')).digest('base64');
}
function validTwilioSignature(url,params,signature,token){
  if(typeof signature!=='string'||!signature||!token)return false;
  const expected=Buffer.from(twilioSignature(url,params,token)),given=Buffer.from(signature);
  return expected.length===given.length&&crypto.timingSafeEqual(expected,given);
}

// Twilio's Messages API on the WhatsApp channel. Twilio only delivers a
// free-form reply inside the 24 hours after the person last wrote. Returns {reference}.
async function sendWhatsApp({to,body},settings=whatsappSettings()){
  refuseInTests();
  if(!settings)throw Object.assign(new Error('WhatsApp is not set up on this server.'),{status:400});
  if(!PHONE.test(String(to||'')))throw Object.assign(new Error('That is not a WhatsApp number StockChief can answer.'),{status:400});
  const form=new URLSearchParams({To:'whatsapp:'+to,From:'whatsapp:'+settings.from,Body:String(body).slice(0,1500)});
  const response=await post('https://api.twilio.com/2010-04-01/Accounts/'+encodeURIComponent(settings.sid)+'/Messages.json',{method:'POST',
    headers:{authorization:'Basic '+Buffer.from(settings.sid+':'+settings.token).toString('base64'),'content-type':'application/x-www-form-urlencoded'},body:form});
  const answer=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(String(answer.message||'WhatsApp refused the message.').slice(0,300)),{status:response.status});
  return {reference:String(answer.sid||'')};
}

// RFC 8291: the message is encrypted for the browser's own keys. `fixed`
// (a sender private key and salt) is only for checking against the RFC's
// published example.
function encrypt(payload,p256dh,authSecret,fixed=null){
  const receiver=b64(p256dh),auth=b64(authSecret);
  if(receiver.length!==65||auth.length!==16)throw Object.assign(new Error('This device’s push keys are not valid.'),{status:400});
  const ecdh=crypto.createECDH('prime256v1');
  if(fixed)ecdh.setPrivateKey(b64(fixed.senderPrivateKey));else ecdh.generateKeys();
  const sender=ecdh.getPublicKey(),shared=ecdh.computeSecret(receiver);
  const ikm=Buffer.from(crypto.hkdfSync('sha256',shared,auth,Buffer.concat([Buffer.from('WebPush: info\0'),receiver,sender]),32));
  const salt=fixed?b64(fixed.salt):crypto.randomBytes(16);
  const key=Buffer.from(crypto.hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16));
  const nonce=Buffer.from(crypto.hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12));
  const cipher=crypto.createCipheriv('aes-128-gcm',key,nonce);
  const sealed=Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload),Buffer.from([2])])),cipher.final(),cipher.getAuthTag()]);
  const header=Buffer.alloc(21);salt.copy(header,0);header.writeUInt32BE(4096,16);header.writeUInt8(sender.length,20);
  return Buffer.concat([header,sender,sealed]);
}
// RFC 8292: the server proves which key pair it is with a signed token.
function vapid(endpoint,settings){
  const pub=b64(settings.publicKey);
  const key=crypto.createPrivateKey({key:{kty:'EC',crv:'P-256',d:settings.privateKey,x:pub.subarray(1,33).toString('base64url'),y:pub.subarray(33,65).toString('base64url')},format:'jwk'});
  const part=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned=part({typ:'JWT',alg:'ES256'})+'.'+part({aud:new URL(endpoint).origin,exp:Math.floor(Date.now()/1000)+12*3600,sub:settings.subject});
  const signature=crypto.sign('sha256',Buffer.from(unsigned),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
  return 'vapid t='+unsigned+'.'+signature+', k='+settings.publicKey;
}
// Sends one push message to one browser. Returns {reference}. A 404 or 410
// means the browser dropped the subscription (`gone`).
async function sendPush({device,message},settings=pushSettings()){
  refuseInTests();
  if(!settings)throw Object.assign(new Error('Push is not set up on this server.'),{status:400});
  if(!validEndpoint(device.endpoint))throw Object.assign(new Error('This device’s push address is not one StockChief sends to.'),{status:400,gone:true});
  const body=encrypt(JSON.stringify(message),device.p256dh,device.auth);
  const response=await post(device.endpoint,{method:'POST',body,headers:{authorization:vapid(device.endpoint,settings),
    'content-encoding':'aes128gcm','content-type':'application/octet-stream',ttl:'86400',urgency:'high'}});
  if(response.status===404||response.status===410)throw Object.assign(new Error('This device turned push off.'),{status:response.status,gone:true});
  if(!response.ok)throw Object.assign(new Error('The push service refused the message ('+response.status+').'),{status:response.status});
  return {reference:String(response.headers.get('location')||'').slice(0,300)};
}

module.exports={PHONE,available,publicKey,validEndpoint,sendSms,sendPush,sendWhatsApp,encrypt,vapid,smsSettings,pushSettings,whatsappSettings,sendMessage,twilioSignature,validTwilioSignature};

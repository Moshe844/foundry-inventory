'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const chat=require('../../src/connections/chat-providers');

// Job 188: each chat channel proves where a message came from before it is read.
const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'test-key',endorsements:['msteams']};
const app='11111111-2222-3333-4444-555555555555',service='https://smba.trafficmanager.net/amer/';
function token(claims,{kid='test-key',key=privateKey}={}){
 const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url'),head=enc({alg:'RS256',kid,typ:'JWT'}),body=enc(claims);
 return 'Bearer '+head+'.'+body+'.'+crypto.sign('RSA-SHA256',Buffer.from(head+'.'+body),key).toString('base64url');
}
const now=Math.floor(Date.now()/1000),good={iss:chat.BOT_ISSUER,aud:app,exp:now+600,nbf:now-10,serviceurl:service};

test('a Teams message needs a current Bot Framework token for this bot, endorsed for Teams, naming the same service',()=>{
 assert.equal(chat.verifyBotToken(token(good),{keys:[jwk],appId:app,service}).aud,app);
 const refused=(auth,options={})=>assert.throws(()=>chat.verifyBotToken(auth,{keys:[jwk],appId:app,service,...options}),/could not be verified/);
 refused(undefined);refused('Bearer nonsense');
 refused(token({...good,aud:'99999999-2222-3333-4444-555555555555'}));
 refused(token({...good,iss:'https://evil.example'}));
 refused(token({...good,exp:now-3600}));
 refused(token({...good,serviceurl:'https://smba.trafficmanager.net/emea/'}));
 refused(token({...good,serviceurl:undefined}));
 refused(token(good,{kid:'other'}));
 refused(token(good,{key:crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey}));
 refused(token(good),{keys:[{...jwk,endorsements:['skype']}]});
 assert.throws(()=>chat.serviceUrl('https://attacker.example/'),/could not be verified/);
 assert.equal(chat.serviceUrl('https://smba.trafficmanager.net/amer'),service);
});

test('a WhatsApp message needs Twilio’s signature over the exact address and fields, from the server’s own sender',()=>{
 const settings={sid:'AC0123456789',token:'twilio-test-token',from:'+15550001000'},channel=chat.fake('whatsapp',{settings});
 const url='https://stockchief.test/integrations/stockchief/whatsapp';
 const fields=new URLSearchParams({AccountSid:settings.sid,From:'whatsapp:+15550002222',To:'whatsapp:+15550001000',Body:'What is in stock?',MessageSid:'SM1'});
 const raw=Buffer.from(fields.toString()),signature=chat.twilioSignature(url,fields,settings.token);
 assert.deepEqual(channel.inbound({raw,url,headers:{'x-twilio-signature':signature}}),{user:'+15550002222',text:'What is in stock?',target:{to:'+15550002222'}});
 assert.throws(()=>channel.inbound({raw,url:url+'?x=1',headers:{'x-twilio-signature':signature}}),/could not be verified/);
 assert.throws(()=>channel.inbound({raw,url,headers:{'x-twilio-signature':chat.twilioSignature(url,fields,'another-token')}}),/could not be verified/);
 const other=new URLSearchParams({...Object.fromEntries(fields),To:'whatsapp:+15559999999'});
 assert.throws(()=>channel.inbound({raw:Buffer.from(other.toString()),url,headers:{'x-twilio-signature':chat.twilioSignature(url,other,settings.token)}}),/another sender/);
 assert.throws(()=>chat.fake('whatsapp').inbound({raw,url,headers:{'x-twilio-signature':signature}}),/not set up/);
});

test('live chat replies never leave a test run, and only tests may swap a channel',async()=>{
 await assert.rejects(chat.get('teams').deliver({connection:{tenant:app,app,secret:'x'},target:{service,conversation:'a',replyTo:'b'},text:'hi'}),/off in tests/);
 const restore=chat.use('teams',chat.fake('teams'));assert.equal(typeof chat.get('teams').sent.push,'function');restore();
 assert.equal(chat.get('teams').sent,undefined);
 assert.equal(chat.plain('<at>StockChief</at> What is&nbsp;on hand?'),'What is on hand?');
});

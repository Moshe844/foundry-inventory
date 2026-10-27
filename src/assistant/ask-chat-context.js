'use strict';
const crypto=require('node:crypto'),{ValidationError}=require('../domain/errors');
const key=secret=>crypto.createHmac('sha256',secret).update('stockchief:ask-chat-context:v1').digest();
const binding=(secret,id)=>crypto.createHmac('sha256',key(secret)).update(id).digest('base64url');
// A visible form must retain its chat even when another tab changes session
// preferences, or the previous response is still committing its session.
// This selects conversation context only; ordinary authorization still runs.
function issue(secret,scope,now=Date.now()){
 if(typeof secret!=='string'||!secret)throw Error('ASK_CONTEXT_SIGNING_NOT_CONFIGURED');
 const body=Buffer.from(JSON.stringify({...scope,sessionId:binding(secret,scope.sessionId),issuedAt:now})).toString('base64url');
 return body+'.'+crypto.createHmac('sha256',key(secret)).update(body).digest('base64url');
}
function verify(secret,token,expected,now=Date.now()){
 const invalid=()=>new ValidationError('This conversation form has changed or expired. Refresh Ask and send your message again. Nothing changed.');
 if(typeof token!=='string'||token.length>4096)throw invalid();
 const parts=token.split('.');if(parts.length!==2)throw invalid();
 const signature=crypto.createHmac('sha256',key(secret)).update(parts[0]).digest(),actual=Buffer.from(parts[1],'base64url');
 if(actual.length!==signature.length||!crypto.timingSafeEqual(actual,signature))throw invalid();
 let value;try{value=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));}catch{throw invalid();}
 for(const field of ['workspaceId','actorId','chatId'])if(value[field]!==expected[field])throw invalid();
 if(value.sessionId!==binding(secret,expected.sessionId))throw invalid();
 if(!Number.isFinite(value.issuedAt)||value.issuedAt>now+60000||now-value.issuedAt>86400000||value.startedAt!==null&&!Number.isFinite(Date.parse(value.startedAt)))throw invalid();
 return value;
}
module.exports={issue,verify};

'use strict';
// Job 188: the outside chat services StockChief answers in. Every channel has
// the same two parts:
//   inbound({raw,headers,url,connection,scope}) proves the request came from the
//     service (a signature or a signed token) and returns
//     {user,text,target}, or {ignore:true} for anything that is not a question;
//   deliver({connection,target,text}) sends one private reply.
// Slack checks its signing secret, Microsoft Teams the Bot Framework token, and
// WhatsApp (through the server's Twilio account, as for job 173's texts) the
// Twilio signature. Tests swap a channel for fake() with use(); the live
// senders never run under NODE_ENV=test.
const crypto=require('node:crypto');
const {AuthorizationError,ValidationError}=require('../domain/errors');
const slack=require('./slack-agent-command');
const alerts=require('../notifications/alert-providers');
const {providerFetch}=require('../lib/provider-http');

const refused=message=>new AuthorizationError(message);
const plain=value=>String(value||'').replace(/<at>[^<]{0,200}<\/at>/gi,' ').replace(/<[^>]{0,200}>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
function question(text){
  const value=plain(text);
  if(!value)return null;
  if(value.length>1200)throw new ValidationError('Ask a question of up to 1,200 characters.');
  return value;
}
function refuseInTests(){
  if(process.env.NODE_ENV==='test')throw Object.assign(new Error('Live chat replies are off in tests.'),{status:400,code:'live_delivery_disabled'});
}

// Slack: the existing signed /stockchief command and its private response URL.
function slackChannel(){
  return {name:'slack',label:'Slack',
    inbound({raw,headers,connection}){
      return slack.parse(raw,{secret:connection.secret,team:connection.team,app:connection.app},
        {timestamp:headers['x-slack-request-timestamp'],signature:headers['x-slack-signature']});
    },
    async deliver({connection,target,text}){
      const destination=slack.destination(target.callback,connection.team);
      const response=await providerFetch(destination,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(slack.reply(text))},{provider:'StockChief Slack',timeoutMs:8000,retries:0});
      if(!response.ok)throw new ValidationError('Slack did not confirm the private answer.');
    }};
}

// Microsoft Teams: a bot the owner registers in Azure (app ID, client secret,
// Microsoft tenant). Teams signs each message with a Bot Framework token; the
// bot answers only in a private chat with the person who asked.
const BOT_ISSUER='https://api.botframework.com';
const BOT_METADATA='https://login.botframework.com/v1/.well-known/openidconfiguration';
const SERVICE_HOSTS=/(^|\.)(trafficmanager\.net|botframework\.com|teams\.microsoft\.com|botframework\.azure\.us)$/i;
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const part=value=>{try{return JSON.parse(Buffer.from(String(value),'base64url').toString('utf8'));}catch{throw refused('This Teams message could not be verified.');}};
function serviceUrl(value){
  let url;try{url=new URL(String(value||''));}catch{throw refused('This Teams message could not be verified.');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!SERVICE_HOSTS.test(url.hostname))throw refused('This Teams message could not be verified.');
  return url.href.endsWith('/')?url.href:url.href+'/';
}
// Checks a Bot Framework token: RS256 signed by a current Bot Framework key
// endorsed for Teams, issued to this bot, in date, and naming the same Teams
// service the message came from.
function verifyBotToken(authorization,{keys,appId,service,now=Date.now()}){
  const token=/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(String(authorization||''))?.[1];
  if(!token)throw refused('This Teams message could not be verified.');
  const [head,body,signature]=token.split('.'),header=part(head),claims=part(body);
  const key=header.alg==='RS256'&&Array.isArray(keys)?keys.find(k=>k&&k.kid===header.kid&&k.kty==='RSA'):null;
  if(!key||Array.isArray(key.endorsements)&&!key.endorsements.includes('msteams'))throw refused('This Teams message could not be verified.');
  let valid=false;
  try{valid=crypto.verify('RSA-SHA256',Buffer.from(head+'.'+body),crypto.createPublicKey({key:{kty:'RSA',n:key.n,e:key.e},format:'jwk'}),Buffer.from(signature,'base64url'));}catch{valid=false;}
  const seconds=Math.floor(now/1000),claimed=claims.serviceurl??claims.serviceUrl;
  if(!valid||claims.iss!==BOT_ISSUER||claims.aud!==appId||!(Number(claims.exp)>seconds-300)||claims.nbf!=null&&Number(claims.nbf)>seconds+300||
    !claimed||serviceUrl(claimed)!==service)throw refused('This Teams message could not be verified.');
  return claims;
}
let keyCache={at:0,keys:null};
async function liveKeys(){
  if(keyCache.keys&&Date.now()-keyCache.at<3600000)return keyCache.keys;
  const read=async url=>{const response=await providerFetch(url,{method:'GET',redirect:'error'},{provider:'StockChief Teams',timeoutMs:8000});
    if(!response.ok)throw refused('Teams could not be checked right now.');return response.json();};
  const metadata=await read(BOT_METADATA),jwks=new URL(String(metadata.jwks_uri||''));
  if(jwks.protocol!=='https:'||!/(^|\.)botframework\.com$/i.test(jwks.hostname))throw refused('Teams could not be checked right now.');
  const keys=(await read(jwks.href)).keys;
  if(!Array.isArray(keys)||!keys.length)throw refused('Teams could not be checked right now.');
  keyCache={at:Date.now(),keys};return keys;
}
function teamsChannel({keys=liveKeys}={}){
  return {name:'teams',label:'Microsoft Teams',
    async inbound({raw,headers,connection}){
      let activity;try{activity=JSON.parse(Buffer.isBuffer(raw)?raw.toString('utf8'):String(raw));}catch{throw refused('This Teams message could not be verified.');}
      const service=serviceUrl(activity?.serviceUrl);
      verifyBotToken(headers.authorization,{keys:await keys(),appId:connection.app,service});
      if(activity.channelData?.tenant?.id!==connection.tenant)throw refused('This Teams message is outside the connected Microsoft tenant.');
      if(activity.type!=='message')return {ignore:true};
      const user=String(activity.from?.aadObjectId||''),conversation=String(activity.conversation?.id||''),replyTo=String(activity.id||'');
      if(!GUID.test(user)||!conversation||conversation.length>500||!replyTo||replyTo.length>200)throw refused('This Teams message could not be verified.');
      const target={service,conversation,replyTo};
      if(activity.conversation?.conversationType!=='personal')return {ignore:true,user,target,notice:'Ask StockChief in a private chat with the bot, so only you see the answer.'};
      return {user,text:question(activity.text),target};
    },
    async deliver({connection,target,text}){
      refuseInTests();
      const service=serviceUrl(target.service);
      const login=await providerFetch('https://login.microsoftonline.com/'+encodeURIComponent(connection.tenant)+'/oauth2/v2.0/token',{method:'POST',redirect:'error',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:connection.app,
          client_secret:connection.secret,scope:'https://api.botframework.com/.default'}).toString()},{provider:'StockChief Teams',timeoutMs:8000,retries:0});
      const grant=await login.json().catch(()=>({}));
      if(!login.ok||typeof grant.access_token!=='string')throw new ValidationError('Microsoft did not accept the Teams bot credentials.');
      const response=await providerFetch(service+'v3/conversations/'+encodeURIComponent(target.conversation)+'/activities/'+encodeURIComponent(target.replyTo),{method:'POST',redirect:'error',
        headers:{'Content-Type':'application/json',Authorization:'Bearer '+grant.access_token},
        body:JSON.stringify({type:'message',textFormat:'plain',text:String(text).slice(0,3900),replyToId:target.replyTo})},{provider:'StockChief Teams',timeoutMs:8000,retries:0});
      if(!response.ok)throw new ValidationError('Teams did not confirm the private answer.');
    }};
}

// WhatsApp: the server's Twilio WhatsApp sender. Twilio signs each message with
// the account's auth token over the exact web address and the sorted fields.
function twilioSignature(url,fields,token){
  const data=url+[...fields.entries()].sort(([a,x],[b,y])=>a<b?-1:a>b?1:x<y?-1:x>y?1:0).map(([k,v])=>k+v).join('');
  return crypto.createHmac('sha1',token).update(Buffer.from(data,'utf8')).digest('base64');
}
function whatsappChannel({settings=()=>alerts.whatsappSettings(),send=alerts.sendWhatsApp}={}){
  return {name:'whatsapp',label:'WhatsApp',
    configured:()=>Boolean(settings()),
    number:()=>settings()?.from||null,
    inbound({raw,headers,url}){
      const current=settings();
      if(!current)throw refused('WhatsApp is not set up on this server.');
      if(!Buffer.isBuffer(raw)||!raw.length||raw.length>16384)throw refused('This WhatsApp message could not be verified.');
      const fields=new URLSearchParams(raw.toString('utf8')),given=String(headers['x-twilio-signature']||''),expected=twilioSignature(url,fields,current.token);
      if(given.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(given),Buffer.from(expected)))throw refused('This WhatsApp message could not be verified.');
      if(fields.get('AccountSid')!==current.sid||fields.get('To')!=='whatsapp:'+current.from)throw refused('This WhatsApp message is for another sender.');
      const user=/^whatsapp:(\+[1-9]\d{7,14})$/.exec(String(fields.get('From')||''))?.[1];
      if(!user)throw refused('This WhatsApp message could not be verified.');
      return {user,text:question(fields.get('Body')),target:{to:user}};
    },
    async deliver({target,text}){await send({to:target.to,body:text});}};
}

const live={slack:slackChannel(),teams:teamsChannel(),whatsapp:whatsappChannel()};
const swapped=new Map();
function get(name){
  const channel=swapped.get(name)||live[name];
  if(!channel)throw new ValidationError('Choose Slack, Teams or WhatsApp.');
  return channel;
}
// Tests only: replace a channel; returns a function that puts the live one back.
function use(name,channel){
  if(process.env.NODE_ENV!=='test')throw new Error('Chat channels can only be replaced in tests.');
  swapped.set(name,channel);return ()=>swapped.delete(name);
}
// A test double that keeps each channel's real checks (signature, token,
// sender) with test keys or secrets, and records replies instead of sending.
function fake(name,options={}){
  const base=name==='teams'?teamsChannel({keys:async()=>options.keys||[]}):
    name==='whatsapp'?whatsappChannel({settings:()=>options.settings||null,send:async()=>{}}):slackChannel();
  const sent=[];
  return {...base,sent,fail:false,async deliver(args){if(this.fail)throw new ValidationError(base.label+' did not confirm the private answer.');sent.push({...args.target,text:args.text});}};
}
module.exports={get,use,fake,verifyBotToken,twilioSignature,GUID,BOT_ISSUER,serviceUrl,plain};

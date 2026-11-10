'use strict';

const {createHmac,timingSafeEqual}=require('node:crypto');
const {AuthorizationError,ValidationError}=require('../domain/errors');

const command='/stockchief';
const teamFormat=/^T[A-Z0-9]{5,30}$/;
const appFormat=/^A[A-Z0-9]{5,30}$/;
const userFormat=/^[UW][A-Z0-9]{5,30}$/;

function sign(raw,timestamp,secret){
  return 'v0='+createHmac('sha256',secret).update('v0:'+timestamp+':').update(raw).digest('hex');
}

function verify(raw,{timestamp,signature,secret,now=Date.now()}){
  if(!Buffer.isBuffer(raw)||!raw.length||raw.length>16384||typeof secret!=='string'||!/^[a-f0-9]{32,128}$/i.test(secret)||
    typeof timestamp!=='string'||!/^\d{10}$/.test(timestamp)||Math.abs(Math.floor(now/1000)-Number(timestamp))>300||
    typeof signature!=='string'||!/^v0=[a-f0-9]{64}$/.test(signature))
    throw new AuthorizationError('This Slack request could not be verified.');
  const expected=sign(raw,timestamp,secret);
  if(!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))
    throw new AuthorizationError('This Slack request could not be verified.');
}

function destination(raw,team){
  let url;
  try{url=new URL(raw);}catch{throw new AuthorizationError('The Slack response address could not be verified.');}
  const parts=url.pathname.split('/');
  if(url.origin!=='https://hooks.slack.com'||url.username||url.password||url.search||url.hash||parts.length!==5||
    parts[1]!=='commands'||parts[2]!==team||!/^\d{5,30}$/.test(parts[3])||!/^[-A-Za-z0-9_]{16,128}$/.test(parts[4]))
    throw new AuthorizationError('The Slack response address could not be verified.');
  return url.href;
}

function parse(raw,credentials,signature){
  verify(raw,{...signature,secret:credentials.secret});
  const fields=new URLSearchParams(raw.toString('utf8'));
  const names=['ssl_check','team_id','api_app_id','user_id','command','response_url','text'];
  if(names.some(name=>fields.getAll(name).length>1))throw new AuthorizationError('This Slack request could not be verified.');
  if(fields.get('ssl_check')==='1')return {sslCheck:true};
  const team=fields.get('team_id'),app=fields.get('api_app_id'),user=fields.get('user_id');
  if(!teamFormat.test(team||'')||team!==credentials.team||!appFormat.test(app||'')||app!==credentials.app||
    !userFormat.test(user||'')||fields.get('command')!==command)
    throw new AuthorizationError('This Slack command is outside the connected team.');
  const text=String(fields.get('text')||'').trim();
  if(!text||text.length>1200)throw new ValidationError('Enter a StockChief question of up to 1,200 characters.');
  return {team,app,user,text,callback:destination(fields.get('response_url'),team)};
}

function reply(text){
  const original=String(text||'').trim();
  const receipt=/\n\nAI credits used \d+\.$/.exec(original)?.[0]||'';
  const value=original.length>2900?original.slice(0,2600)+'\n\nThis answer is shortened. Ask a narrower question for more detail.'+receipt:original;
  return {response_type:'ephemeral',replace_original:false,unfurl_links:false,unfurl_media:false,
    blocks:[{type:'section',text:{type:'plain_text',text:value||'Open StockChief to review your question.'}}]};
}

module.exports={command,teamFormat,appFormat,userFormat,sign,verify,destination,parse,reply};

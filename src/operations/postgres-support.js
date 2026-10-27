'use strict';
const crypto=require('node:crypto'),config=require('../config'),{newId,requireText}=require('../lib/util');
const {ValidationError,NotFoundError}=require('../domain/errors');
const SUPPORT_EMAIL='support@stockchiefhq.com';
async function create(database,scope,input){
 const email=String(scope.email||input.email||'').trim().toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw new ValidationError('Enter a valid reply email address.');
 const subject=requireText(input.subject,'Subject',{max:180}),body=requireText(input.body,'What happened',{max:10000});
 const key=requireText(input.requestKey,'Request reference',{max:100});
 const source=typeof input.sourcePath==='string'&&input.sourcePath.startsWith('/')&&!input.sourcePath.startsWith('//')?input.sourcePath.split('?')[0].slice(0,240):null;
 const requesterHash=crypto.createHash('sha256').update(scope.accountId||String(scope.ip||'unknown')).digest('hex');
 return database.transaction(async client=>{
  const prior=(await client.query('SELECT * FROM support_requests WHERE request_key=$1',[key])).rows[0];
  if(prior){if(prior.requester_hash!==requesterHash||prior.contact_email!==email||prior.subject!==subject||prior.body!==body||prior.channel!==String(input.channel||'EMAIL').toUpperCase())
    throw new ValidationError('That request reference has already been used. Refresh the form.');return {...prior,replayed:true};}
  const n=(await client.query("SELECT count(*)::int AS n FROM support_requests WHERE requester_hash=$1 AND created_at>now()-interval '1 hour'",[requesterHash])).rows[0].n;
  if(n>=5)throw Object.assign(new ValidationError('Your requests are saved. Please wait before sending another, or reply to the confirmation email.'),{status:429});
  const id=newId('support');
  const row=(await client.query(`INSERT INTO support_requests(id,account_id,workspace_id,request_key,contact_email,subject,body,source_path,requester_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[id,scope.accountId||null,scope.workspaceId||null,key,email,subject,body,source,requesterHash])).rows[0];
  const routing=await require('./postgres-support-conversations').routeRequest(client,scope,id,input);
  const signature='StockChief Support\n'+SUPPORT_EMAIL+'\nhttps://stockchiefhq.com';
  const messages=[{to:SUPPORT_EMAIL,replyTo:email,subject:'['+id+'] '+subject,text:'Support request: '+id+'\nFrom: '+email+'\nPage: '+(source||'Not supplied')+'\n\n'+body+'\n\n'+signature},
    {to:email,replyTo:SUPPORT_EMAIL,subject:'StockChief received your request: '+subject,text:'We received your support request.\n\nReference: '+id+'\nSubject: '+subject+'\n\nYour message is saved in StockChief. We will reply to this email if we need more information. Please do not send passwords or connection secrets.\n\n'+signature}];
  const jobs=require('./postgres-job-queue'),seal=require('../connections/credentials').encrypt;
  for(const [index,message]of messages.entries())await jobs.enqueue({query:(...a)=>client.query(...a),transaction:fn=>fn(client)},
    {kind:'system.email-send',idempotencyKey:'support:'+id+':'+index,payload:{messageType:'support_request',accountId:scope.accountId||null,supportRequestId:id,sealed:seal(message)},priority:10+routing.priority,maxAttempts:8});
  return {...row,priority:routing.priority,channel:routing.channel,replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function list(database,accountId){if(!accountId)return [];return (await database.query('SELECT id,subject,status,channel,priority,created_at,updated_at FROM support_requests WHERE account_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50',[accountId])).rows;}
module.exports={SUPPORT_EMAIL,create,list};

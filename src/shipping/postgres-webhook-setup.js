'use strict';
const jobs=require('../operations/postgres-job-queue'),accounts=require('./postgres-accounts'),{nowIso}=require('../lib/util'),{ValidationError}=require('../domain/errors');
function origin(value){try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')return null;return url.origin;}catch{return null;}}
async function enqueue(database,ctx,connectorId,options={}){
 const publicOrigin=origin(options.publicOrigin||require('../config').connections.publicOrigin);if(!publicOrigin)return {skipped:'public_https_required'};
 const held=await accounts.forWorkspace(database,ctx.workspaceId,{connectorId});if(!held)return {skipped:'disconnected'};
 return database.transaction(async client=>{
  await client.query(`INSERT INTO shipping_webhook_setups(workspace_id,connector_id,status,updated_at) VALUES($1,$2,'PENDING',$3)
   ON CONFLICT(workspace_id,connector_id) DO NOTHING`,[ctx.workspaceId,connectorId,nowIso()]);
  return jobs.enqueue({query:(...args)=>client.query(...args),transaction:operation=>operation(client)},
   {workspaceId:ctx.workspaceId,kind:'shipping.webhook.setup',idempotencyKey:connectorId+':'+options.generation,
    payload:{connectorId,actorId:ctx.actorId,publicOrigin},priority:40,maxAttempts:4});
 });
}
async function schedule(client,options={}){
 const publicOrigin=origin(options.publicOrigin||require('../config').connections.publicOrigin);if(!publicOrigin)return {queued:0};
 const rows=(await client.query(`SELECT c.id,c.workspace_id,c.authorized_by_user_id FROM workspace_connectors c
   JOIN workspaces w ON w.id=c.workspace_id LEFT JOIN shipping_webhook_setups s ON s.workspace_id=c.workspace_id AND s.connector_id=c.id
   WHERE c.provider_type IN ('easypost','shipstation','shippo') AND c.status='connected' AND c.paused_at IS NULL
    AND w.deletion_requested_at IS NULL AND s.connector_id IS NULL ORDER BY c.id LIMIT 100 FOR UPDATE OF c SKIP LOCKED`)).rows;
 const database={query:(...args)=>client.query(...args),transaction:operation=>operation(client)};
 for(const row of rows){
  const store=require('../connections/postgres-credential-store'),held=await store.get(client,row.workspace_id,row.id,'provider');if(!held?.apiKey)continue;
  if(!held.webhookSecret)await store.put(client,row.workspace_id,row.id,'provider',{...held,webhookSecret:require('node:crypto').randomBytes(32).toString('hex')});
  await enqueue(database,{workspaceId:row.workspace_id,actorId:row.authorized_by_user_id},row.id,{publicOrigin,generation:'automatic-initial'});
 }return {queued:rows.length};
}
async function run(database,job,options={}){
 const held=await accounts.contextFor(database,{workspaceId:job.workspaceId,actorId:job.payload.actorId},{connectorId:job.payload.connectorId});if(!held)return {skipped:'disconnected'};
 const publicOrigin=origin(job.payload.publicOrigin);if(!publicOrigin)throw new ValidationError('A verified public HTTPS address is needed for carrier updates.');
 const provider=options.providerResolver?options.providerResolver(held.account.provider):require('./provider').get(held.account.provider);
 if(typeof provider.ensureWebhook!=='function')return {skipped:'not_supported'};
 try{
  const scope=await require('../commercial/entitlements').ownerScopeForWorkspace(database,job.workspaceId);
  const result=await require('../commercial/context').run({database,scope,system:true,requestId:'shipping-webhook-setup:'+job.id},()=>provider.ensureWebhook(held.ctx,
   {url:publicOrigin+'/webhooks/shipping/'+held.account.provider+'/'+job.workspaceId,webhookSecret:held.account.webhookSecret,testMode:held.account.testMode}));
  if(!['CONNECTED','POLLING'].includes(result.status))throw new ValidationError('Carrier updates have not been confirmed.');
  await database.query('UPDATE shipping_webhook_setups SET status=$3,provider_reference=$4,last_error=$5,updated_at=$6 WHERE workspace_id=$1 AND connector_id=$2',
   [job.workspaceId,job.payload.connectorId,result.status,result.id||null,result.reason||null,nowIso()]);return {status:result.status,provider:held.account.provider};
 }catch(error){
  await database.query("UPDATE shipping_webhook_setups SET status='REVIEW',last_error='The carrier has not confirmed automatic updates. StockChief continues scheduled tracking checks; reconnect to retry setup.',updated_at=$3 WHERE workspace_id=$1 AND connector_id=$2",[job.workspaceId,job.payload.connectorId,nowIso()]);
  // Do not persist raw registration errors: some providers echo callback tokens.
  throw Object.assign(new Error('The carrier webhook registration could not be confirmed.'),{retryable:![400,401,403,404,422].includes(Number(error.status))});
 }
}
module.exports={enqueue,run,schedule};

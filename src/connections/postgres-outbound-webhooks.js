'use strict';
const crypto=require('node:crypto'),{newId,nowIso,requireText}=require('../lib/util'),{ValidationError}=require('../domain/errors'),credentials=require('./credentials'),network=require('./providers/store-network'),entitlements=require('../entitlements/postgres-service');
async function send(request,url,options){
 const controller=new AbortController();let timer;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Webhook receiver timed out.'));},10000);timer.unref?.();});
 try{return await Promise.race([request(url,{...options,signal:controller.signal}),deadline]);}finally{clearTimeout(timer);}
}
const agent=require('./agent-review-api');
const TYPES=Object.freeze(['stock.changed','purchase_order.received','order.created']);
// Custom only: agent reviews and the agent jobs other systems start (job 189).
const AGENT_TYPES=Object.freeze([agent.eventType,'agent.job.completed','agent.job.held','agent.job.failed']);
async function create(db,ctx,input){
 const scope=await entitlements.ownerScopeForWorkspace(db,ctx.workspaceId);await entitlements.assertCapability(db,scope,'api.public');
 const name=requireText(input.name,'Webhook name',{max:100});let endpoint;try{endpoint=network.address(input.endpointUrl).toString();}catch{throw new ValidationError('Use a public HTTPS webhook address without credentials, a query or a fragment.');}
 const types=[...new Set((Array.isArray(input.eventTypes)?input.eventTypes:[input.eventTypes]).filter(Boolean))];if(!types.length||types.some(t=>!TYPES.includes(t)&&!AGENT_TYPES.includes(t)))throw new ValidationError('Choose a supported webhook event.');
 const secret='whsec_'+crypto.randomBytes(32).toString('base64url'),id=newId('whsub'),at=nowIso();
 await db.transaction(async c=>{await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[ctx.workspaceId]);if(Number((await c.query("SELECT count(*)::int n FROM outbound_webhook_subscriptions WHERE workspace_id=$1 AND status='ACTIVE'",[ctx.workspaceId])).rows[0].n)>=10)throw new ValidationError('This inventory already has 10 active webhook endpoints. Revoke one before adding another.');
 if(types.some(t=>AGENT_TYPES.includes(t)))await agent.issuer(c,ctx);
 await c.query('INSERT INTO outbound_webhook_subscriptions(id,workspace_id,name,endpoint_url,event_types,signing_secret_hash,signing_secret_encrypted,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)',[id,ctx.workspaceId,name,endpoint,JSON.stringify(types),crypto.createHash('sha256').update(secret).digest('hex'),JSON.stringify(credentials.encrypt({secret})),ctx.actorId,at]);});return {id,secret};
}
async function list(db,workspaceId){return (await db.query("SELECT id,name,endpoint_url,event_types,status,last_success_at,last_error FROM outbound_webhook_subscriptions WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",[workspaceId])).rows.map(r=>({...r,eventTypes:JSON.parse(r.event_types)}));}
async function revoke(db,workspaceId,id){if(!(await db.query("UPDATE outbound_webhook_subscriptions SET status='REVOKED',updated_at=$3 WHERE workspace_id=$1 AND id=$2 AND status<>'REVOKED'",[workspaceId,id,nowIso()])).rowCount)throw new ValidationError('That webhook is already revoked or does not exist.');}
async function deliver(db,job,options={}){
 const row=(await db.query('SELECT d.*,s.status AS subscription_status,s.endpoint_url,s.signing_secret_encrypted FROM outbound_webhook_deliveries d JOIN outbound_webhook_subscriptions s ON s.workspace_id=d.workspace_id AND s.id=d.subscription_id WHERE d.workspace_id=$1 AND d.id=$2',[job.workspaceId,job.payload?.deliveryId])).rows[0];
 if(!row||row.subscription_status!=='ACTIVE')return {skipped:'webhook_revoked_or_missing'};if(row.status==='DELIVERED')return {delivered:true,replayed:true};
 const body=JSON.stringify(row.payload),sealed=JSON.parse(row.signing_secret_encrypted),secret=credentials.decrypt({ciphertext:sealed.ciphertext,iv:sealed.iv,auth_tag:sealed.authTag}).secret,timestamp=String(Math.floor(Date.now()/1000)),signature=crypto.createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex');
 try{
  const scope=await entitlements.ownerScopeForWorkspace(db,job.workspaceId);await entitlements.assertCapability(db,scope,'api.public');
  const key='webhook:'+row.id;
  const result=await require('../commercial/operations').run(db,job.workspaceId,{key,retryReversed:true,capability:'api.public',category:'api_events',operation:'outbound_webhook',provider:'customer_webhook'},async()=>{
   if(AGENT_TYPES.includes(row.event_type))await agent.check(db,job.workspaceId);
   const response=await send(options.fetch||network.fetchStore,row.endpoint_url,{method:'POST',headers:{'content-type':'application/json','x-stockchief-event-id':row.domain_event_id,'x-stockchief-timestamp':timestamp,'x-stockchief-signature':'v1='+signature,'idempotency-key':row.domain_event_id},body});
   if(!response.ok)throw Object.assign(new Error('The receiver returned HTTP '+response.status+'.'),{responseStatus:response.status});return {status:response.status};});
  await db.transaction(async c=>{await c.query("UPDATE outbound_webhook_deliveries SET status='DELIVERED',attempt_count=attempt_count+1,response_status=$3,delivered_at=$4,last_error=NULL WHERE workspace_id=$1 AND id=$2",[job.workspaceId,row.id,result.status,nowIso()]);await c.query('UPDATE outbound_webhook_subscriptions SET last_success_at=$3,last_error=NULL,updated_at=$3 WHERE workspace_id=$1 AND id=$2',[job.workspaceId,row.subscription_id,nowIso()]);});return {delivered:true,eventId:row.domain_event_id};
 }catch(error){const exhausted=job.attemptCount>=job.maxAttempts;const message=error.responseStatus?'Receiver returned HTTP '+error.responseStatus+(exhausted?'. Automatic attempts have stopped. Contact support to retry after fixing the receiver.':'. Delivery will retry.'):error.code==='entitlement_required'?'Webhook delivery is paused by the current plan or usage limit.':'The receiver could not be reached safely. Check its public HTTPS address and availability.';
  await db.query("UPDATE outbound_webhook_deliveries SET status=$3,attempt_count=attempt_count+1,response_status=$4,last_error=$5 WHERE workspace_id=$1 AND id=$2",[job.workspaceId,row.id,job.attemptCount>=job.maxAttempts?'DEAD':'FAILED',error.responseStatus||null,message]);await db.query('UPDATE outbound_webhook_subscriptions SET last_error=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2',[job.workspaceId,row.subscription_id,message,nowIso()]);throw Object.assign(new Error(message),{code:error.code==='entitlement_required'?error.code:'webhook_delivery_failed',details:error.details,retryable:true});}
}
module.exports={create,list,revoke,deliver,TYPES,AGENT_TYPES};

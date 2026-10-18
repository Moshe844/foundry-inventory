'use strict';
const {newId}=require('../lib/util'),{ValidationError,InvariantError,DomainError}=require('../domain/errors');
const vault=require('./credentials'),jobs=require('../operations/postgres-job-queue'),providersDefault=require('./providers/registry'),ingestion=require('./postgres-event-ingestion'),providerService=require('./postgres-provider-service'),facts=require('./commerce-facts');
const headersAllowed=['x-shopify-topic','x-shopify-webhook-id','x-shopify-event-id','x-shopify-shop-domain','x-shopify-triggered-at','x-wc-webhook-topic','x-wc-webhook-resource','x-wc-webhook-event','x-wc-webhook-source','x-wc-webhook-delivery-id','x-wc-delivery-id'];
function scoped(client){return {query:(sql,values)=>client.query(sql,values),transaction:fn=>fn(client)};}
function deliveryId(provider,headers,body,rawBody){const id=String(headers['x-shopify-webhook-id']||headers['x-shopify-event-id']||headers['x-wc-webhook-delivery-id']||headers['x-wc-delivery-id']||body.event_id||body.id||facts.hash(rawBody.toString('base64')));return id.length<=160?id:provider+':'+facts.hash(id);}
async function receive(database,connection,input){
 const headers=Object.fromEntries(headersAllowed.filter(k=>input.headers[k]!=null).map(k=>[k,String(input.headers[k]).slice(0,1024)])),delivery=deliveryId(connection.provider_type,input.headers,input.body,input.rawBody),payloadHash=facts.hash({headers,body:input.body}),sealed=vault.encrypt({headers,rawBody:input.rawBody.toString('base64')});
 const outcome=await database.transaction(async c=>{
  if(!(await c.query('SELECT 1 FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 AND status=$3 AND paused_at IS NULL',[connection.workspace_id,connection.id,'connected'])).rows.length)throw new ValidationError('That connection is not active in this business.');
  const inserted=await c.query("INSERT INTO connection_webhook_receipts(id,workspace_id,connector_id,delivery_id,payload_hash,ciphertext,iv,auth_tag) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id",[newId('whreceipt'),connection.workspace_id,connection.id,delivery,payloadHash,sealed.ciphertext,sealed.iv,sealed.authTag]);
  const row=(await c.query('SELECT id,payload_hash,status,result FROM connection_webhook_receipts WHERE workspace_id=$1 AND connector_id=$2 AND delivery_id=$3',[connection.workspace_id,connection.id,delivery])).rows[0];
  if(row.payload_hash!==payloadHash){
   const reason='A signed webhook reused a delivery identity with different evidence. The original effect was not repeated.';
   await c.query("INSERT INTO connection_event_conflicts(id,workspace_id,connector_id,delivery_id,content_hash,evidence,reason) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(workspace_id,connector_id,delivery_id,content_hash) DO NOTHING",[newId('whconflict'),connection.workspace_id,connection.id,delivery,payloadHash,JSON.stringify({kind:'ENCRYPTED_WEBHOOK_CONFLICT',...sealed}),reason]);
   await c.query("INSERT INTO connection_issues(id,workspace_id,connector_id,external_event_id,issue_type,fingerprint,title,detail,resolution_hint,candidate_matches,status,created_at,updated_at) VALUES($1,$2,$3,$4,'EVENT_IDENTITY_CONFLICT',$5,'Conflicting webhook evidence needs reconciliation',$6,'Compare the retained provider records before authorizing any correction.','[]','OPEN',now(),now()) ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,updated_at=now()",[newId('conissue'),connection.workspace_id,connection.id,delivery,'webhook-delivery-conflict:'+connection.id+':'+delivery,reason]);
   return {integrityConflict:true};
  }
  if(inserted.rows.length)await jobs.enqueue(scoped(c),{workspaceId:connection.workspace_id,kind:'provider.webhook-process',idempotencyKey:'webhook-receipt:'+row.id,payload:{receiptId:row.id},priority:30,maxAttempts:8});
  return {receiptId:row.id,workspaceId:connection.workspace_id,replayed:!inserted.rows.length,status:row.status,result:row.result};
 },{isolation:'SERIALIZABLE',retrySafe:true});
 if(outcome.integrityConflict)throw new InvariantError('That webhook delivery identity conflicts with retained evidence.','webhook_delivery_conflict');
 return outcome;
}
async function processReceipt(database,workspaceId,receiptId,providers=providersDefault,{reviewRetry=false}={}){
 const claimed=await database.transaction(async c=>{
  const row=(await c.query('SELECT * FROM connection_webhook_receipts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,receiptId])).rows[0];
  if(!row)throw new ValidationError('That provider receipt was not found in this business.');
  if(row.status==='COMPLETED')return {done:true,result:row.result};
  if(row.status==='NEEDS_REVIEW'&&!reviewRetry)return {done:true,result:{processingStatus:row.status,requiresReview:true,accepted:0,replayed:0,needsMapping:0,results:[]}};
  if(row.status==='PROCESSING'&&new Date(row.lease_until).getTime()>Date.now())return {done:true,result:{processingStatus:'PROCESSING',accepted:0,replayed:0,needsMapping:0,results:[]}};
  const connection=(await c.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 AND status=$3 AND paused_at IS NULL',[workspaceId,row.connector_id,'connected'])).rows[0];
  if(!connection){
    await c.query("UPDATE connection_webhook_receipts SET status='RETRY_PENDING',claim_token=NULL,lease_until=NULL,error_code='connection_paused',error_message='Reconnect or resume this connection before processing its retained events.',updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspaceId,receiptId]);
    return {done:true,result:{processingStatus:'PAUSED',accepted:0,replayed:0,needsMapping:0,results:[]}};
  }
  const claimToken=newId('whclaim');
  await c.query("UPDATE connection_webhook_receipts SET status='PROCESSING',lease_until=now()+interval '2 minutes',claim_token=$3,attempt_count=attempt_count+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspaceId,receiptId,claimToken]);
  return {row,connection,claimToken};
 },{isolation:'SERIALIZABLE',retrySafe:true});
 if(claimed.done)return claimed.result;
 const {row,connection,claimToken}=claimed,adapter=providers.get(connection.provider_type);
 let applied=[];
 try{
  if(!adapter?.normalizeWebhook)throw new ValidationError('That provider has no verified event adapter.');
  const credentials=await providerService.loadProviderCredentials(database,connection,adapter),sealed=vault.decrypt(row),rawBody=Buffer.from(sealed.rawBody,'base64'),body=JSON.parse(rawBody.toString('utf8'));
  const scope=await require('../commercial/entitlements').ownerScopeForWorkspace(database,workspaceId);
  await require('../commercial/entitlements').assertCapability(database,scope,'connections.commerce');
  const events=await require('../commercial/context').run({database,scope,requestId:'webhook:'+receiptId},async()=>{
   const input={headers:sealed.headers,rawBody,body,credentials,connection:{...connection,config:typeof connection.config==='string'?JSON.parse(connection.config||'{}'):connection.config||{}}};
   if(adapter.hydrateWebhook)await adapter.hydrateWebhook(input);
   return adapter.normalizeWebhook(input);
  });
  const auth={workspaceId,connectorId:connection.id,actorId:connection.authorized_by_user_id,displayName:connection.display_name,providerType:connection.provider_type};
  for(const event of events)applied.push(await ingestion.ingest(database,auth,event,{retryMapped:true}));
  const needsMapping=applied.filter(r=>r.status==='NEEDS_MAPPING').length,status=needsMapping?'NEEDS_MAPPING':'COMPLETED',result={processingStatus:status,accepted:applied.filter(r=>r.accepted).length,replayed:applied.filter(r=>r.replayed).length,needsMapping,results:applied,receiptId};
  const finished=await database.query('UPDATE connection_webhook_receipts SET status=$3,result=$4::jsonb,lease_until=NULL,claim_token=NULL,error_code=NULL,error_message=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND claim_token=$5 RETURNING id',[workspaceId,receiptId,status,JSON.stringify(result),claimToken]);
  if(!finished.rows.length)return {processingStatus:'CLAIM_LOST',receiptId,accepted:0,replayed:0,needsMapping:0,results:[]};
  if(status==='COMPLETED'){
    await database.query("UPDATE connection_issues SET status='RESOLVED',resolved_at=$3,updated_at=$3 WHERE workspace_id=$1 AND fingerprint=$2 AND status='OPEN'",[workspaceId,'webhook-review:'+receiptId,new Date().toISOString()]);
    await database.transaction(c=>scheduleMappedInTransaction(c,workspaceId,connection.id),{isolation:'SERIALIZABLE',retrySafe:true});
  }
  return result;
 }catch(error){
  const transient=error.transient||error.retryable||Number(error.status)===429||Number(error.status)>=500,status=transient?'RETRY_PENDING':'NEEDS_REVIEW',result={processingStatus:status,accepted:applied.filter(r=>r.accepted).length,replayed:applied.filter(r=>r.replayed).length,needsMapping:0,requiresReview:!transient,results:applied,receiptId};
  await database.transaction(async c=>{
   const retained=await c.query('UPDATE connection_webhook_receipts SET status=$3,result=$4::jsonb,lease_until=NULL,claim_token=NULL,error_code=$5,error_message=$6,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND claim_token=$7 RETURNING id',[workspaceId,receiptId,status,JSON.stringify(result),String(error.code||'provider_event_processing').slice(0,100),String(error.message||'Provider event processing failed.').slice(0,500),claimToken]);
   if(!retained.rows.length)return;
   if(!transient){const at=new Date().toISOString();await c.query("INSERT INTO connection_issues(id,workspace_id,connector_id,external_event_id,issue_type,fingerprint,title,detail,resolution_hint,candidate_matches,status,created_at,updated_at) VALUES($1,$2,$3,$4,'PROVIDER_EVENT_REVIEW',$5,'A provider event needs reconciliation',$6,$7,'[]','OPEN',$8,$8) ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,detail=EXCLUDED.detail,updated_at=EXCLUDED.updated_at",[newId('conissue'),workspaceId,connection.id,row.delivery_id,'webhook-review:'+receiptId,error instanceof DomainError?error.message:'A safety check stopped the remaining provider operations. The original evidence and completed effects are retained.','Review the provider record and completed effects, resolve the discrepancy, then resume this retained receipt.',at]);}
  },{isolation:'SERIALIZABLE',retrySafe:true});
  if(transient)throw error;
  return result;
 }
}
async function job(job,database,providers){const result=await processReceipt(database,job.workspaceId,job.payload.receiptId,providers);if(['PROCESSING','PAUSED'].includes(result.processingStatus))throw Object.assign(new Error(result.processingStatus==='PAUSED'?'Resume the connection to continue its retained event.':'The retained provider receipt is still being processed.'),{code:result.processingStatus==='PAUSED'?'connection_paused':'provider_receipt_in_progress',retryable:true});return result;}
async function resume(database,ctx,connectorId,receiptId){
 const actor=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!actor||actor.role!=='owner')throw new (require('../domain/errors').AuthorizationError)('Only an owner can resume a retained provider event.');
 return database.transaction(async c=>{
  const row=(await c.query("SELECT * FROM connection_webhook_receipts WHERE workspace_id=$1 AND connector_id=$2 AND id=$3 FOR UPDATE",[ctx.workspaceId,connectorId,receiptId])).rows[0];
  if(!row)throw new ValidationError('That receipt was not found in this business.');
  const expired=row.status==='PROCESSING'&&new Date(row.lease_until||0).getTime()<=Date.now();
  if(!expired&&!['NEEDS_REVIEW','NEEDS_MAPPING','RETRY_PENDING'].includes(row.status))return {replayed:true,status:row.status};
  const connection=(await c.query("SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 AND status='connected' AND paused_at IS NULL",[ctx.workspaceId,connectorId])).rows[0];
  if(!connection)throw new ValidationError('Reconnect or resume this connection before continuing its retained event.');
  await c.query("UPDATE connection_webhook_receipts SET status='RECEIVED',claim_token=NULL,lease_until=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,receiptId]);
  return jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind:'provider.webhook-process',idempotencyKey:'webhook-resume:'+receiptId+':'+newId('resume'),payload:{receiptId},priority:30,maxAttempts:8});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function scheduleMappedInTransaction(c,workspaceId,connectorId){
 const rows=(await c.query(`SELECT r.id,r.attempt_count FROM connection_webhook_receipts r WHERE r.workspace_id=$1 AND r.connector_id=$2 AND r.status='NEEDS_MAPPING' AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.result->'results') entry WHERE entry->>'status'='NEEDS_MAPPING') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.result->'results') entry WHERE entry->>'status'='NEEDS_MAPPING' AND NOT EXISTS(SELECT 1 FROM connection_mappings m WHERE m.workspace_id=r.workspace_id AND m.connector_id=r.connector_id AND m.entity_type=entry->'mapping'->>'entityType' AND m.external_id=entry->'mapping'->>'externalId')) FOR UPDATE OF r`,[workspaceId,connectorId])).rows;
 for(const row of rows){await c.query("UPDATE connection_webhook_receipts SET status='RECEIVED',updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspaceId,row.id]);await jobs.enqueue(scoped(c),{workspaceId,kind:'provider.webhook-process',idempotencyKey:'webhook-mapped:'+row.id+':'+row.attempt_count,payload:{receiptId:row.id},priority:30,maxAttempts:8});}
 return {scheduled:rows.length};
}
async function reconcileCancellationObservations(database,connection,adapter){
 if(!adapter?.hydrateWebhook||!adapter?.normalizeWebhook)return {resolved:0};
 const rows=(await database.query(`SELECT r.* FROM connection_webhook_receipts r
 WHERE r.workspace_id=$1 AND r.connector_id=$2 AND r.status='COMPLETED' AND EXISTS(
  SELECT 1 FROM connection_issues i WHERE i.workspace_id=r.workspace_id AND i.connector_id=r.connector_id
  AND i.status='OPEN' AND i.issue_type='RETURN_REVIEW_REQUIRED'
  AND left(i.external_event_id,length(r.delivery_id)+1)=r.delivery_id||':') ORDER BY r.received_at DESC LIMIT 20`,[connection.workspace_id,connection.id])).rows;
 if(!rows.length)return {resolved:0};
 const credentials=await providerService.loadProviderCredentials(database,connection,adapter),auth={workspaceId:connection.workspace_id,connectorId:connection.id,actorId:connection.authorized_by_user_id};let resolved=0;
 for(const row of rows){
  const sealed=vault.decrypt(row),rawBody=Buffer.from(sealed.rawBody,'base64'),body=JSON.parse(rawBody.toString('utf8'));
  if(!Array.isArray(body.transactions)||body.transactions.length!==0)continue;
  const input={headers:sealed.headers,rawBody,body,credentials,connection};
  try{await adapter.hydrateWebhook(input);}catch{continue;}
  for(const event of adapter.normalizeWebhook(input))if(await ingestion.reconcileCancellationObservation(database,auth,event))resolved++;
 }
 return {resolved};
}
module.exports={receive,processReceipt,job,resume,scheduleMappedInTransaction,reconcileCancellationObservations};

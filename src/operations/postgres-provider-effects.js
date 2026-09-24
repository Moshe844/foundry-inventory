'use strict';

const { newId,nowIso }=require('../lib/util');
const jobs=require('./postgres-job-queue');
const { ValidationError,InvariantError,NotFoundError }=require('../domain/errors');

function scopedDatabase(client){return {query:(statement,values=[])=>client.query(statement,values),
  transaction:(operation)=>operation(client)};}

function hydrate(row){if(!row)return null;return {id:row.id,workspaceId:row.workspace_id,kind:row.kind,
  provider:row.provider,aggregateType:row.aggregate_type,aggregateId:row.aggregate_id,payload:row.payload||{},
  idempotencyKey:row.idempotency_key,status:row.status,requestedByUserId:row.requested_by_user_id,
  claimToken:row.claim_token,claimedAt:row.claimed_at,providerReference:row.provider_reference,
  result:row.result,errorCode:row.error_code,errorMessage:row.error_message,createdAt:row.created_at,
  completedAt:row.completed_at,updatedAt:row.updated_at};}

async function get(database,workspaceId,id){const row=(await database.query(`SELECT * FROM stockchief_runtime.provider_effects
  WHERE workspace_id=$1 AND id=$2`,[workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That provider operation was not found.');return hydrate(row);}

async function enqueueInTransaction(client,input){
  if(!input.workspaceId||!input.kind||!input.provider||!input.aggregateType||!input.aggregateId||!input.idempotencyKey)
    throw new TypeError('A provider effect needs tenant, kind, provider, aggregate and idempotency identity.');
  const id=input.id||newId('peff');const inserted=await client.query(`INSERT INTO stockchief_runtime.provider_effects
    (id,workspace_id,kind,provider,aggregate_type,aggregate_id,payload,idempotency_key,requested_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT(workspace_id,kind,idempotency_key) DO NOTHING RETURNING *`,
  [id,input.workspaceId,input.kind,input.provider,input.aggregateType,input.aggregateId,JSON.stringify(input.payload||{}),
    input.idempotencyKey,input.requestedByUserId||null]);
  const row=inserted.rows[0]||(await client.query(`SELECT * FROM stockchief_runtime.provider_effects
    WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3`,[input.workspaceId,input.kind,input.idempotencyKey])).rows[0];
  const queued=await jobs.enqueue(scopedDatabase(client),{workspaceId:input.workspaceId,kind:'provider.effect',
    idempotencyKey:`provider-effect:${row.id}`,payload:{effectId:row.id},priority:input.priority??20,maxAttempts:input.maxAttempts??12});
  return {effect:hydrate(row),created:Boolean(inserted.rows.length),job:queued.job,jobCreated:queued.created};
}

async function enqueue(database,input){return database.transaction((client)=>enqueueInTransaction(client,input),
  {isolation:'SERIALIZABLE',retrySafe:true});}

async function claim(database,workspaceId,id){return database.transaction(async(client)=>{
  const row=(await client.query(`SELECT * FROM stockchief_runtime.provider_effects
    WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That provider operation was not found.');
  if(row.status==='SUCCEEDED')return {effect:hydrate(row),replayed:true};
  if(row.status==='FAILED')throw Object.assign(new ValidationError(row.error_message||'The provider refused that operation.'),
    {code:row.error_code||'provider_effect_failed',retryable:false});
  if(row.status==='AMBIGUOUS')throw Object.assign(new InvariantError(
    'The provider outcome is uncertain. StockChief will not repeat this consequential operation automatically.',
    'provider_effect_ambiguous'),{retryable:false});
  if(row.status==='CANCELLED')throw Object.assign(new ValidationError('That provider operation was cancelled.'),
    {code:'provider_effect_cancelled',retryable:false});
  if(row.status==='RUNNING')throw Object.assign(new InvariantError(
    'That provider operation is already being verified.','provider_effect_in_progress'),{retryable:true});
  const token=newId('peclaim');const at=nowIso();const claimed=(await client.query(`UPDATE stockchief_runtime.provider_effects
    SET status='RUNNING',claim_token=$3,claimed_at=$4,updated_at=$4 WHERE workspace_id=$1 AND id=$2 AND status='PENDING'
    RETURNING *`,[workspaceId,id,token,at])).rows[0];
  if(!claimed)throw Object.assign(new InvariantError('That provider operation could not be claimed safely.',
    'provider_effect_claim_failed'),{retryable:true});
  return {effect:hydrate(claimed),replayed:false};
},{isolation:'SERIALIZABLE',retrySafe:true});}

async function succeed(database,workspaceId,id,token,input={}){return database.transaction(async(client)=>{
  const locked=(await client.query(`SELECT * FROM stockchief_runtime.provider_effects
    WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[workspaceId,id])).rows[0];
  if(!locked)throw new NotFoundError('That provider operation was not found.');
  if(locked.status==='SUCCEEDED')return hydrate(locked);
  if(locked.status!=='RUNNING'||locked.claim_token!==token)throw new InvariantError(
    'The provider result no longer belongs to the active operation.','provider_effect_claim_lost');
  if(input.apply)await input.apply(client,hydrate(locked));
  const at=nowIso();const row=(await client.query(`UPDATE stockchief_runtime.provider_effects SET status='SUCCEEDED',
    claim_token=NULL,claimed_at=NULL,provider_reference=$4::jsonb,result=$5::jsonb,error_code=NULL,error_message=NULL,
    completed_at=$6,updated_at=$6 WHERE workspace_id=$1 AND id=$2 AND claim_token=$3 RETURNING *`,
  [workspaceId,id,token,JSON.stringify(input.providerReference||null),JSON.stringify(input.result||{}),at])).rows[0];
  return hydrate(row);
},{isolation:'SERIALIZABLE',retrySafe:true});}

function definiteFailure(error){const status=Number(error?.status);return status>=400&&status<500&&status!==408&&status!==409&&status!==429;}

async function finishError(database,workspaceId,id,token,error,input={}){const ambiguous=input.ambiguous??!definiteFailure(error);
  return database.transaction(async(client)=>{const locked=(await client.query(`SELECT * FROM stockchief_runtime.provider_effects
    WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[workspaceId,id])).rows[0];
    if(!locked)throw new NotFoundError('That provider operation was not found.');
    if(locked.status==='SUCCEEDED')return hydrate(locked);
    if(locked.status!=='RUNNING'||locked.claim_token!==token)return hydrate(locked);
    if(input.apply)await input.apply(client,hydrate(locked),ambiguous);
    const at=nowIso();const row=(await client.query(`UPDATE stockchief_runtime.provider_effects SET status=$4,
      claim_token=NULL,claimed_at=NULL,error_code=$5,error_message=$6,completed_at=$7,updated_at=$7
      WHERE workspace_id=$1 AND id=$2 AND claim_token=$3 RETURNING *`,[workspaceId,id,token,
      ambiguous?'AMBIGUOUS':'FAILED',String(error?.code||'provider_error').slice(0,100),
      String(error?.message||'The provider operation failed.').slice(0,500),at])).rows[0];return hydrate(row);
  },{isolation:'SERIALIZABLE',retrySafe:true});}

async function markStaleAmbiguous(client,{olderThanMinutes=5}={}){const at=nowIso();return client.query(`UPDATE stockchief_runtime.provider_effects
  SET status='AMBIGUOUS',claim_token=NULL,claimed_at=NULL,error_code='worker_interrupted',
    error_message='The worker stopped before the provider outcome was verified. StockChief did not retry the operation.',
    completed_at=$2,updated_at=$2 WHERE status='RUNNING' AND claimed_at<now()-($1::integer*interval '1 minute') RETURNING *`,
  [olderThanMinutes,at]);}

module.exports={get,enqueue,enqueueInTransaction,claim,succeed,finishError,markStaleAmbiguous,definiteFailure,hydrate};

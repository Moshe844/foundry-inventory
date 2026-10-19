'use strict';
const crypto=require('node:crypto');
const {ValidationError,AuthorizationError,AuthenticationError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const providers=require('./providers/registry'),service=require('./postgres-provider-service');
const connections=require('./postgres-service'),jobs=require('../operations/postgres-job-queue');
const entitlements=require('../entitlements/postgres-service');
const scoped=client=>({query:(s,v)=>client.query(s,v),transaction:fn=>fn(client)});
const fingerprint=credentials=>crypto.createHash('sha256').update(credentials.consumerKey+'\0'+credentials.consumerSecret).digest('hex');
async function owner(db,ctx){const row=(await db.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];if(row?.role!=='owner')throw new AuthorizationError('Only an owner can authorize a store connection.');}
function adapterFor(type,options={}){const registry=options.providers||providers,adapter=registry.get(type);if(!adapter?.credentialsFromCallback||!adapter.verifyReadOnly)throw new ValidationError('This platform does not support application authorization.');return {registry,adapter};}
async function verified(db,ctx,type,adapter,credentials){await owner(db,ctx);return require('../commercial/operations').run(db,ctx.workspaceId,{key:'application-verify:'+newId('attempt'),capability:'connections.commerce',provider:type,operation:'authorization_exchange'},()=>adapter.verifyReadOnly({credentials}));}
async function deliveryCredentials(db,ctx,type,accountId,credentials){
 const existing=(await db.query('SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND provider_type=$2 AND provider_account_id=$3 ORDER BY updated_at DESC LIMIT 1',[ctx.workspaceId,type,accountId])).rows[0];
 const previous=existing&&await require('./postgres-credential-store').get(db,ctx.workspaceId,existing.id,'provider');
 return previous?.webhookSecret?{...credentials,webhookSecret:previous.webhookSecret}:credentials;
}
async function queueSetup(db,ctx,id,origin){for(const kind of ['provider.webhook-setup','provider.catalog-sync'])await jobs.enqueue(db,{workspaceId:ctx.workspaceId,kind,idempotencyKey:kind+':authorization:'+id+':'+nowIso(),payload:{connectorId:id,actorId:ctx.actorId,publicOrigin:origin},priority:25,maxAttempts:5});}
async function manual(db,ctx,input,requestOrigin,options={}){
 const type=String(input.providerType||''),{registry,adapter}=adapterFor(type,options);
 if(!adapter.credentialsFromInput||!adapter.metadata().authMethods?.includes('api_keys'))throw new ValidationError('This platform does not accept manual API keys.');
 if(registry===providers)await require('./launch-policy').assertWorkspaceConnection(db,type,ctx);
 const credentials=adapter.credentialsFromInput(input),fact=await verified(db,ctx,type,adapter,credentials);
 return db.transaction(async client=>{
  await owner(client,ctx);const cdb=scoped(client);
  const scope=await entitlements.ownerScopeForWorkspace(client,ctx.workspaceId);await entitlements.assertCapability(client,scope,'connections.commerce');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`application-connect:${ctx.workspaceId}:${type}:${fact.accountId}`]);
  let connection=input.connectorId?await connections.get(cdb,ctx.workspaceId,input.connectorId):
   (await client.query("SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND provider_type=$2 AND provider_account_id=$3 ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",[ctx.workspaceId,type,fact.accountId])).rows[0];
  if(connection&&(connection.provider_type!==type||connection.provider_account_id&&connection.provider_account_id!==fact.accountId))throw new ValidationError('Use a new connection for a different store. Existing matches belong to the original store.');
  if(!connection){await entitlements.assertMeterCapacity(client,scope,'connections',1);const id=newId('con'),at=nowIso();await client.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'disconnected','[]',$6,'{}',360,'AUTHORIZING',$7,$8,$8)`,[id,ctx.workspaceId,type+':'+id,adapter.metadata().name,type,JSON.stringify(adapter.metadata().provides||[]),ctx.actorId,at]);connection=await connections.get(cdb,ctx.workspaceId,id);}
  const id=await service.finishAuthorization(cdb,connection,ctx.actorId,{...fact,credentials:await deliveryCredentials(cdb,ctx,type,fact.accountId,credentials)});
  await queueSetup(cdb,ctx,id,options.publicOrigin||service.providerOrigin(requestOrigin));return connections.get(cdb,ctx.workspaceId,id);
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function findState(db,value,type){if(typeof value!=='string'||value.length<32||value.length>256)throw new AuthenticationError('This store authorization request is invalid or expired.');const row=(await db.query('SELECT * FROM connection_authorization_states WHERE state_hash=$1 AND provider_type=$2 AND expires_at>$3',[service.stateHash(value),type,nowIso()])).rows[0];if(!row)throw new AuthenticationError('This store authorization request is invalid or expired.');return {...row,metadata:connections.parseJson(row.metadata,{})};}
async function complete(db,type,body,requestOrigin,options={}){
 const {registry,adapter}=adapterFor(type,options),state=await findState(db,body.user_id,type),ctx={workspaceId:state.workspace_id,actorId:state.actor_id};
 if(registry===providers)await require('./launch-policy').assertWorkspaceConnection(db,type,ctx);
 const credentials=adapter.credentialsFromCallback(body,state.metadata),digest=fingerprint(credentials);
 if(state.used_at){if(state.metadata.credentialFingerprint!==digest)throw new AuthenticationError('This store authorization has already been used.');await owner(db,ctx);return connections.get(db,ctx.workspaceId,state.connector_id);}
 if(body.key_permissions!=='read_write')throw new ValidationError('Approve WooCommerce read/write access so StockChief can receive its events.');
 const fact=await verified(db,ctx,type,adapter,credentials);
 return db.transaction(async client=>{
  await owner(client,ctx);const cdb=scoped(client),current=await findState(client,body.user_id,type);
  await client.query('SELECT id FROM connection_authorization_states WHERE id=$1 FOR UPDATE',[current.id]);
  const locked=await findState(client,body.user_id,type);
  if(locked.used_at){if(locked.metadata.credentialFingerprint!==digest)throw new AuthenticationError('This store authorization has already been used.');return connections.get(cdb,ctx.workspaceId,locked.connector_id);}
  const connection=await connections.get(cdb,ctx.workspaceId,locked.connector_id);
  if(connection.provider_account_id&&connection.provider_account_id!==fact.accountId)throw new ValidationError('Use a new connection for a different store. Existing matches belong to the original store.');
  await service.readState(cdb,body.user_id,type,{consume:true});
  const id=await service.finishAuthorization(cdb,connection,ctx.actorId,{...fact,credentials:await deliveryCredentials(cdb,ctx,type,fact.accountId,credentials)});
  await client.query('UPDATE connection_authorization_states SET metadata=$2 WHERE id=$1',[locked.id,JSON.stringify({...locked.metadata,credentialFingerprint:digest})]);
  await queueSetup(cdb,ctx,id,options.publicOrigin||service.providerOrigin(requestOrigin));return connections.get(cdb,ctx.workspaceId,id);
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function returning(db,ctx,value,type,success){await owner(db,ctx);const state=await findState(db,value,type);if(state.workspace_id!==ctx.workspaceId||state.actor_id!==ctx.actorId)throw new AuthorizationError('Return to the business and account that started this connection.');const connection=await connections.get(db,ctx.workspaceId,state.connector_id);return {state,connection,pending:!state.used_at&&String(success)==='1',connected:Boolean(state.used_at&&connection.status==='connected'&&connection.credential_ref)};}
async function setupJob(job,db,registry=providers){if(!job.workspaceId||!job.payload?.connectorId||!job.payload.actorId)throw new ValidationError('The store setup job is missing its authorized business context.');const connection=await service.setupWebhookDelivery(db,{workspaceId:job.workspaceId,actorId:job.payload.actorId},job.payload.connectorId,job.payload.publicOrigin,{providers:registry,publicOrigin:job.payload.publicOrigin});return {connectorId:connection.id,configured:!connection.last_error};}
module.exports={manual,complete,returning,setupJob};

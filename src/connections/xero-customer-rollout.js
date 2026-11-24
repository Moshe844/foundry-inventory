'use strict';
const config=require('../config');
const {ValidationError,AuthenticationError}=require('../domain/errors');
const SOURCE='XERO_STARTER_CUSTOMERS_V1',MAX_ORGANIZATIONS=5,HOLD_MS=10*60_000;
const WRITE_SOURCE='XERO_CUSTOMER_GOVERNED_WRITES_V1';
const READ_CAPABILITIES=new Set(['connections.accounting','accounting.sync']);
const parse=value=>{if(value&&typeof value==='object')return value;try{return JSON.parse(value||'{}');}catch{return {};}};
function approvedClientId(){
 const id=process.env.STOCKCHIEF_XERO_STARTER_CLIENT_ID||'';
 return process.env.STOCKCHIEF_RUNTIME_ENV==='production'&&id&&id===config.connections.xero.clientId&&config.connections.xero.configured?id:'';
}
function enabled(){return Boolean(approvedClientId()&&process.env.STOCKCHIEF_XERO_STARTER_CUSTOMERS_APPROVED==='1');}
function writesEnabled(){return Boolean(approvedClientId()&&process.env.STOCKCHIEF_XERO_GOVERNED_WRITES_APPROVED==='1');}
function eligible(subscription){return Boolean(subscription&&['starter','growth','pro','enterprise'].includes(subscription.plan_id));}
function certified(connection){const proof=parse(connection?.config).xeroCustomerEvidence;return Boolean(approvedClientId()&&connection?.provider_type==='xero'&&
 ((proof?.source===SOURCE&&proof.readOnly===true)||(proof?.source===WRITE_SOURCE&&proof.readOnly===false&&proof.ownerPostingConsent===true&&proof.postingScopesVerified===true))&&proof.clientId===approvedClientId()&&proof.workspaceId===connection.workspace_id&&
 proof.providerAccountId===connection.provider_account_id&&proof.approvedByUserId===connection.authorized_by_user_id&&
 proof.providerPlan==='starter'&&proof.maxOrganizations===MAX_ORGANIZATIONS);}
function customer(connection){return connection?.provider_type==='xero'&&!require('./accounting-review-pilot').allowed('xero',connection.workspace_id);}
function readOnly(connection){return customer(connection)&&(certified(connection)||enabled())&&!(writesEnabled()&&certified(connection));}
function postingCertified(connection){const capabilities=parse(connection?.capabilities),proof=parse(connection?.config).xeroCustomerEvidence;
 return certified(connection)&&proof.source===WRITE_SOURCE&&Array.isArray(capabilities)&&capabilities.includes('accounting:post');}
function assertNoPosting(connection,options={}){
 if(readOnly(connection))throw new ValidationError('This Xero connection is read-only. No changes can be sent to Xero.');
 if(customer(connection)&&writesEnabled()&&(!certified(connection)||!options.configure&&!postingCertified(connection)))
  throw new ValidationError('Grant Xero posting permission for this company before sending entries. Your existing read access is preserved.');
}
async function permitsCapability(database,scope,subscription,capability){
 if(!READ_CAPABILITIES.has(capability)||!eligible(subscription)||!scope.workspaceId||!approvedClientId())return false;
 if(enabled())return true;
 // Stopping new signups must not disable an established, qualified grant.
 const rows=(await database.query("SELECT workspace_id,provider_type,provider_account_id,authorized_by_user_id,config FROM workspace_connectors WHERE workspace_id=$1 AND provider_type='xero' AND status<>'disconnected'",[scope.workspaceId])).rows;
 return rows.some(certified);
}
function evidence(connection,actorId,result){
 if(!enabled()||!actorId||!result.accountId||result.credentials?.tenantId!==result.accountId||result.verifiedFact?.externalId!==result.accountId||
  !Array.isArray(result.capabilities))throw new AuthenticationError('Xero did not confirm this company connection. Your saved connections are preserved.');
 const posting=result.capabilities.includes('accounting:post');
 if(posting){
  let scopes=[];try{const claims=JSON.parse(Buffer.from(result.credentials.accessToken.split('.')[1],'base64url').toString('utf8'));scopes=Array.isArray(claims.scope)?claims.scope:String(claims.scope||'').split(/\s+/);}catch{}
  if(!writesEnabled()||!scopes.includes('accounting.manualjournals')||!scopes.includes('accounting.invoices'))
   throw new AuthenticationError('Xero did not confirm the approved posting permissions. Your saved connection is preserved.');
 }
 return {source:posting?WRITE_SOURCE:SOURCE,clientId:approvedClientId(),workspaceId:connection.workspace_id,providerAccountId:result.accountId,
  approvedByUserId:actorId,readOnly:!posting,...(posting?{ownerPostingConsent:true,postingScopesVerified:true}:{}),providerPlan:'starter',maxOrganizations:MAX_ORGANIZATIONS};
}
function capacityError(){return new ValidationError('Xero connections are currently at capacity. Contact StockChief support for availability. Your subscription and existing connections are unchanged.',{kind:'xero_customer_capacity'});}
async function lock(database){await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['xero-starter-capacity:'+approvedClientId()]);}
async function population(database,excludeState=null){
 const occupied=(await database.query("SELECT DISTINCT COALESCE(NULLIF(provider_account_id,''),id) AS organization FROM workspace_connectors WHERE provider_type='xero' AND status<>'disconnected' AND NOT (setup_status IN ('AUTHORIZING','AUTHORIZATION_FAILED') AND credential_ref IS NULL AND provider_account_id IS NULL)")).rows;
 const pending=(await database.query(`SELECT count(*)::int n FROM connection_authorization_states WHERE provider_type='xero' AND expires_at>$1
  AND metadata::jsonb->>'xeroStarterSlot'='true' AND metadata::jsonb->>'xeroStarterClientId'=$2
  AND COALESCE(metadata::jsonb->>'xeroStarterReleased','false')<>'true' AND ($3::text IS NULL OR id<>$3)`,[new Date().toISOString(),approvedClientId(),excludeState])).rows[0].n;
 return {organizations:new Set(occupied.map(row=>row.organization)),pending};
}
async function reserve(database,connection){
 if(!approvedClientId())return {};
 await lock(database);const state=await population(database);
 // Reauthorizing a known organization does not consume another organization.
 const existing=connection?._pending?null:connection?.provider_account_id;
 const consumesSlot=!existing||!state.organizations.has(existing);
 if(consumesSlot&&state.organizations.size+state.pending>=MAX_ORGANIZATIONS)throw capacityError();
 return {xeroStarterSlot:consumesSlot,xeroStarterClientId:approvedClientId(),xeroStarterReleased:false};
}
async function admit(database,connection,result,stateId){
 if(!approvedClientId())return;
 await lock(database);const state=await population(database,stateId);
 if(!state.organizations.has(result.accountId)&&state.organizations.size+state.pending>=MAX_ORGANIZATIONS)throw capacityError();
 await release(database,stateId);
}
async function release(database,stateId){
 if(!stateId)return;
 await database.query(`UPDATE connection_authorization_states SET metadata=(metadata::jsonb||'{"xeroStarterReleased":true}'::jsonb)::text
  WHERE id=$1 AND provider_type='xero' AND metadata::jsonb ? 'xeroStarterSlot'`,[stateId]);
}
async function availability(database){
 if(!enabled())return null;
 const state=await population(database);return {maximum:MAX_ORGANIZATIONS,remaining:Math.max(0,MAX_ORGANIZATIONS-state.organizations.size-state.pending),governedWritesAvailable:writesEnabled()};
}
module.exports={SOURCE,WRITE_SOURCE,MAX_ORGANIZATIONS,HOLD_MS,READ_CAPABILITIES,approvedClientId,enabled,writesEnabled,eligible,certified,postingCertified,customer,readOnly,assertNoPosting,permitsCapability,evidence,reserve,admit,release,availability,capacityError};

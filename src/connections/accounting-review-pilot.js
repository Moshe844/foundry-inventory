'use strict';
const config=require('../config');
const {AuthenticationError}=require('../domain/errors');
const SOURCE='ACCOUNTING_PRIVATE_QUALIFICATION_V1';
const variables=Object.freeze({xero:'STOCKCHIEF_PRODUCTION_XERO_WORKSPACES',quickbooks:'STOCKCHIEF_PRODUCTION_QUICKBOOKS_WORKSPACES'});

// An explicit inventory grant permits qualification, never public availability,
// a paid provider plan, posting authority, or a StockChief entitlement upgrade.
function workspaces(provider){
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='production'||!Object.hasOwn(variables,provider))return [];
 if(provider==='quickbooks'&&process.env.QUICKBOOKS_ENVIRONMENT!=='production')return [];
 const values=String(process.env[variables[provider]]||'').split(',').map(value=>value.trim()).filter(Boolean);
 return values.every(value=>/^[A-Za-z0-9_-]{1,200}$/.test(value))?[...new Set(values)]:[];
}
function pilots(){return Object.fromEntries(Object.keys(variables).map(provider=>[provider,workspaces(provider)]));}
function allowed(provider,workspaceId){return workspaces(provider).includes(workspaceId);}
function clientIds(){return {xero:config.connections.xero.clientId||'',quickbooks:config.connections.quickbooks.clientId||''};}
function evidence(connection,actorId,result){
 const provider=connection.provider_type,accountId=result.accountId;
 const credentialAccount=provider==='xero'?result.credentials?.tenantId:result.credentials?.realmId;
 if(!allowed(provider,connection.workspace_id)||!actorId||!accountId||accountId!==credentialAccount||
  result.verifiedFact?.externalId!==accountId||!clientIds()[provider])
  throw new AuthenticationError('The accounting provider did not confirm the company for this private connection.');
 return {source:SOURCE,provider,workspaceId:connection.workspace_id,providerAccountId:accountId,
  clientId:clientIds()[provider],approvedByUserId:actorId,qualificationOnly:true};
}
module.exports={SOURCE,workspaces,pilots,allowed,clientIds,evidence};

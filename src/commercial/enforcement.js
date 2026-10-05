'use strict';
const entitlements=require('./entitlements');
const ROUTES=Object.freeze([
 [/^\/(?:inventory|items|skus|products)(?:\/|$)/,'inventory.core'],
 [/^\/locations(?:\/|$)/,'inventory.multi_location'],
 [/^\/(?:counts|stocktakes)(?:\/|$)/,'inventory.counts'],
 [/^\/transfers(?:\/|$)/,'inventory.transfers'],
 [/^\/(?:purchasing|purchase-orders)(?:\/|$)/,'purchasing.core'],
 [/^\/suppliers(?:\/|$)/,'purchasing.suppliers'],
 [/^\/receiving(?:\/|$)/,'receiving.core'],
 [/^\/(?:sales|sales-orders|customers)(?:\/|$)/,'sales_orders.core'],
 [/^\/returns(?:\/|$)/,'returns.core'],
 [/^\/fulfilment(?:\/|$)/,'shipping.workflow'],
 [/^\/accounting(?:\/|$)/,'accounting.core'],
 [/^\/imports(?:\/|$)/,'imports.spreadsheet'],
 [/^\/(?:ask|foundry\/tell|actions)(?:\/|$)/,'ask.lookup'],
 [/^\/warehouse(?:\/|$)/,'warehouse.advanced'],
 [/^\/planning(?:\/|$)/,'planning.basic'],
 [/^\/(?:mail|messages)(?:\/|$)/,'communications.email_ingestion'],
 [/^\/settings\/connections\/[^/]+\/accounting\/(?:enable|export)$/,'accounting.post_connected'],
]);
function middleware(database){return async(req,res,next)=>{try{
 if(!req.ctx)return next();
 if(['GET','HEAD','OPTIONS'].includes(req.method)&&!/\/(?:launch|callback|return)$/.test(req.path))return next();
 for(const [pattern,capability] of ROUTES){if(pattern.test(req.path))await entitlements.assertCapability(database,
  {accountId:req.workspace.owner_account_id,workspaceId:req.ctx.workspaceId},capability);}
 return next();}catch(error){return next(error);}};}
function contextMiddleware(database){return (req,res,next)=>require('./context').run({database,
 scope:req.ctx?{accountId:req.workspace.owner_account_id,workspaceId:req.ctx.workspaceId}:req.account?{accountId:req.account.id}:null,
 requestId:require('../lib/util').newId('request')},next);}
async function workspace(database,workspaceId,capability){const scope=await entitlements.ownerScopeForWorkspace(database,workspaceId);
 return entitlements.assertCapability(database,scope,capability);}
function guardExports(exports,databasePosition,scopePosition,rules){
 for(const [name,capability] of Object.entries(rules)){const original=exports[name];if(!original)throw new Error(`Missing enforced service operation: ${name}`);
  exports[name]=async function(...args){const value=args[scopePosition];const workspaceId=typeof value==='string'?value:value?.workspaceId||value?.workspace_id;
   await workspace(args[databasePosition],workspaceId,capability);
   const scope=await entitlements.ownerScopeForWorkspace(args[databasePosition],workspaceId);
   return require('./context').run({...require('./context').current(),database:args[databasePosition],scope,
    requestId:require('./context').current()?.requestId||require('../lib/util').newId('operation')},()=>original(...args));};}
 return exports;
}
module.exports={ROUTES,middleware,contextMiddleware,workspace,guardExports};

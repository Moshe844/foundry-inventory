'use strict';

const entitlements=require('../entitlements/postgres-service');

function commercialScope(req){return {accountId:req.workspace?.owner_account_id||req.account?.id||req.ctx?.accountId||null,
  workspaceId:req.ctx?.workspaceId||null};}

function requireCapability(database,capability){return async function entitlementGuard(req,res,next){try{
  const state=await entitlements.capabilityState(database,commercialScope(req),capability);if(state.enabled)return next();
  if(req.accepts('html'))return res.redirect(303,`/upgrade?capability=${encodeURIComponent(capability)}&return=${encodeURIComponent(req.originalUrl||'/')}`);
  return next(new entitlements.EntitlementError('Your current plan does not include this capability.',{capability}));
}catch(error){return next(error);}};}

const OPERATIONAL_BYPASSES=[
  /^\/billing(?:\/|$)/,
  /^\/commercial-admin(?:\/|$)/,
  /^\/commercial\/events$/,
  /^\/logout(?:-all)?$/,
  /^\/verify-email(?:\/|$)/,
  /^\/reset-password$/,
  /^\/settings\/connections\/[^/]+\/(?:disconnect|pause)$/,
  /^\/settings\/connections\/payments\/disconnect$/,
  /^\/settings\/connections\/api-clients\/[^/]+\/revoke$/,
  /^\/settings\/event-feed\/disconnect$/,
  /^\/settings\/shipping\/account\/disconnect$/,
];

function requireOperationalSubscription(req,res,next){
  if(['GET','HEAD','OPTIONS'].includes(req.method)||!req.ctx||res.locals.commercial?.access?.canOperate
      ||OPERATIONAL_BYPASSES.some((pattern)=>pattern.test(req.path)))return next();
  return next(new entitlements.EntitlementError(
    'StockChief is read-only because this subscription is not operational. Business records are preserved; update billing to resume changes.',
    {subscriptionStatus:res.locals.commercial?.subscription?.status||'UNSUBSCRIBED'}));
}

module.exports={commercialScope,requireCapability,requireOperationalSubscription};

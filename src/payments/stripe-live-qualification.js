'use strict';
const {ValidationError}=require('../domain/errors');
const SOURCE='STRIPE_STANDARD_DIRECT_V1';
function production(){return process.env.STOCKCHIEF_RUNTIME_ENV==='production';}
function configured(){const expected=process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID;
 return production()&&/^acct_[A-Za-z0-9]+$/.test(expected||'')&&process.env.STOCKCHIEF_STRIPE_CONNECT_PLATFORM_ACCOUNT_ID===expected&&
  /^ca_[A-Za-z0-9]+$/.test(process.env.STRIPE_CONNECT_CLIENT_ID||'')&&/^sk_live_/.test(process.env.STRIPE_SECRET_KEY||'')&&/^whsec_/.test(process.env.STRIPE_WEBHOOK_SECRET||'');}
function publicEnabled(){return configured()&&process.env.STOCKCHIEF_STRIPE_CONNECT_ENABLED==='1';}
function pilotWorkspaces(){if(!configured())return [];return String(process.env.STOCKCHIEF_STRIPE_CONNECT_PILOT_WORKSPACES||'').split(',').map(v=>v.trim()).filter(v=>/^[A-Za-z0-9_-]{1,200}$/.test(v));}
function allowed(workspaceId){return publicEnabled()||pilotWorkspaces().includes(workspaceId);}
function evidence(account,{accountId,liveMode,checkedAt=new Date().toISOString(),verifiedEvent=false}={}){
 const platformAccountId=verifiedEvent?process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID:process.env.STOCKCHIEF_STRIPE_CONNECT_PLATFORM_ACCOUNT_ID;
 if((!verifiedEvent&&!configured())||!/^acct_[A-Za-z0-9]+$/.test(platformAccountId||'')||liveMode!==true||!/^acct_[A-Za-z0-9]+$/.test(accountId||'')||account?.id!==accountId||accountId===platformAccountId||account?.livemode===false)
  throw new ValidationError('Stripe could not verify a separate live merchant account. Your existing connection is preserved.');
 // Standard accounts have the documented Stripe-owned pricing, loss handling
 // and full Dashboard defaults. Explicit contradictory controller properties
 // must never be treated as that same commercial arrangement.
 const controller=account.controller||{};
 if(account.type!=='standard'||controller.fees?.payer&&controller.fees.payer!=='account'||
  controller.losses?.payments&&controller.losses.payments!=='stripe'||
  controller.stripe_dashboard?.type&&controller.stripe_dashboard.type!=='full'||
  controller.requirement_collection&&controller.requirement_collection!=='stripe')
  throw new ValidationError('This Stripe connection requires a Standard account with Stripe handling merchant fees and verification. Your existing connection is preserved.');
 return {source:SOURCE,merchantAccountId:accountId,platformAccountId,
  live:true,feesPayer:'account',lossesPayer:'stripe',dashboard:'full',checkedAt};
}
function valid(value,accountId){return value?.source===SOURCE&&value.merchantAccountId===accountId&&value.platformAccountId===process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID&&value.live===true&&value.feesPayer==='account'&&value.lossesPayer==='stripe'&&value.dashboard==='full';}
module.exports={SOURCE,production,configured,publicEnabled,pilotWorkspaces,allowed,evidence,valid};

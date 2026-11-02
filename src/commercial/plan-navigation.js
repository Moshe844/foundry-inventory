'use strict';

// One destination policy for pricing, registration and billing. Choosing a plan
// never creates a second account or changes an existing subscription by GET.
function destination(plan,{account=null,subscription=null,interval='monthly',checkoutOpen=true}={}){
  const billing=interval==='annual'?'annual':'monthly';
  if(plan.sales_only)return '/contact?plan='+encodeURIComponent(plan.id);
  if(!account)return checkoutOpen?'/register?plan='+encodeURIComponent(plan.id)+'&interval='+billing:'/contact?plan='+encodeURIComponent(plan.id);
  if(subscription?.stripe_subscription_id&&!subscription.refunded_at){
    if(subscription.plan_id===plan.id&&String(subscription.billing_interval).toLowerCase()===billing)return '/settings/billing';
    return '/billing/change?plan='+encodeURIComponent(plan.id)+'&interval='+billing;
  }
  return '/complete-signup?plan='+encodeURIComponent(plan.id)+'&interval='+billing;
}
function state(plan,{account=null,subscription=null,selection=null,interval='monthly',checkoutOpen=true}={}){
 const billing=interval==='annual'?'annual':'monthly';
 const current=account&&subscription?.plan_id===plan.id&&!subscription.refunded_at&&
  require('./entitlements').operationalAccess(subscription).canOperate&&String(subscription.billing_interval).toLowerCase()===billing;
 if(current)return {disabled:true,label:'Current plan',kind:'current'};
 const chosen=selection?.planId||account?.pending_commercial_plan_id,chosenInterval=selection?.interval||account?.pending_billing_interval||'monthly';
 if(chosen===plan.id&&String(chosenInterval).toLowerCase()===billing)return {disabled:true,label:'Selected plan',kind:'selected'};
 return {disabled:false,label:plan.sales_only?'Email us about Custom':account?'Review '+plan.name:checkoutOpen?'Choose '+plan.name:'Email us about '+plan.name,href:destination(plan,{account,subscription,interval,checkoutOpen})};
}
module.exports={destination,state};

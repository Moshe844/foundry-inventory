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
module.exports={destination};

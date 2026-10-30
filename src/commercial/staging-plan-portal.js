'use strict';
const crypto=require('node:crypto');
const stripe=require('./stripe-billing');
// Explicit TEST configuration only. Never modify a default/live portal.
async function configure(plans,options={}){
 if(!/^sk_test_/.test(options.secretKey||''))throw Error('A Stripe TEST key is required.');
 const products=new Map();
 for(const plan of plans){
  if(!['starter','growth','pro'].includes(plan.id))throw Error('Only public self-service plans belong in this portal.');
  for(const interval of ['monthly','annual']){
   const id=plan[`stripe_${interval}_price_id`];if(!id)throw Error('Every plan needs monthly and annual test prices.');
   const price=await stripe.retrievePrice(id,options);
   if(price.livemode!==false||price.active!==true||price.type!=='recurring'||price.currency!==String(plan.currency).toLowerCase()
     ||price.unit_amount!==Number(plan[`${interval}_amount_minor`])||price.recurring?.interval!==(interval==='annual'?'year':'month')
     ||Number(price.recurring.interval_count||1)!==1)throw Error('The Stripe TEST price does not match the published plan.');
   const product=typeof price.product==='string'?price.product:price.product?.id;
   if(!product)throw Error('The Stripe price has no product.');
   products.set(product,[...(products.get(product)||[]),id]);
  }
 }
 if(new Set(plans.map(p=>p.id)).size!==3)throw Error('Starter, Growth and Pro are required.');
 const values={name:'StockChief staging plan changes',default_return_url:options.returnUrl,
  'features[payment_method_update][enabled]':'true','features[invoice_history][enabled]':'true',
  'features[subscription_cancel][enabled]':'true','features[subscription_cancel][mode]':'at_period_end',
  'features[subscription_update][enabled]':'true','features[subscription_update][default_allowed_updates][0]':'price',
  'features[subscription_update][proration_behavior]':'always_invoice',
  'features[subscription_update][schedule_at_period_end][conditions][0][type]':'decreasing_item_amount',
  'features[subscription_update][schedule_at_period_end][conditions][1][type]':'shortening_interval',
  'metadata[stockchief_environment]':'staging'};
 let i=0;for(const [product,prices] of products){values[`features[subscription_update][products][${i}][product]`]=product;
  values[`features[subscription_update][products][${i}][adjustable_quantity][enabled]`]='false';
  prices.forEach((price,j)=>{values[`features[subscription_update][products][${i}][prices][${j}]`]=price;});i++;}
 const fingerprint=crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
 const result=await stripe.__internal.call('/billing_portal/configurations',{...options,values,idempotencyKey:'stockchief-staging-portal:'+fingerprint});
 if(result.livemode!==false||!result.active||!result.features?.subscription_update?.enabled)throw Error('Stripe did not confirm the TEST plan-switching portal.');
 return {id:result.id,fingerprint};
}
async function scheduledChange(database,subscription,options={}){
 if(!require('./release').stagingTestCheckout()||!subscription?.stripe_subscription_id)return null;
 const provider=options.provider||stripe;if(!provider.retrieveSchedule)return null;
 const remote=await provider.retrieveSubscription(subscription.stripe_subscription_id,options.providerOptions||{});
 const customer=typeof remote.customer==='string'?remote.customer:remote.customer?.id;
 if(remote.id!==subscription.stripe_subscription_id||customer!==subscription.stripe_customer_id)throw Error('Stripe returned another billing account.');
 const scheduleId=typeof remote.schedule==='string'?remote.schedule:remote.schedule?.id;if(!scheduleId)return {checked:true,change:null};
 const schedule=await provider.retrieveSchedule(scheduleId,options.providerOptions||{});
 if(schedule.id!==scheduleId||(typeof schedule.customer==='string'?schedule.customer:schedule.customer?.id)!==customer
   ||(typeof schedule.subscription==='string'?schedule.subscription:schedule.subscription?.id)!==remote.id)throw Error('Stripe returned another subscription schedule.');
 if(!['active','not_started'].includes(schedule.status))return {checked:true,change:null};
 const next=(schedule.phases||[]).find(p=>Number(p.start_date)>Date.now()/1000);if(!next||next.items?.length!==1)return {checked:true,change:null};
 const price=typeof next.items[0].price==='string'?next.items[0].price:next.items[0].price?.id;
 const plan=(await database.query('SELECT public_name FROM commercial_plans WHERE stripe_monthly_price_id=$1 OR stripe_annual_price_id=$1',[price])).rows[0];
 if(!plan)throw Error('This scheduled price is not a StockChief plan.');
 return {checked:true,change:{id:scheduleId,target_plan_name:plan.public_name,effective_at:new Date(next.start_date*1000).toISOString(),fromPortal:true}};
}
module.exports={configure,scheduledChange};

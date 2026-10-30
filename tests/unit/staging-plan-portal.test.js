'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const stripe=require('../../src/commercial/stripe-billing'),portal=require('../../src/commercial/staging-plan-portal');
const response=value=>new Response(JSON.stringify(value),{status:200});
test('plan-switching portal is confined to explicitly enabled staging TEST billing',async t=>{
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_STAGING_SUBSCRIPTION_CHECKOUT','STOCKCHIEF_BILLING_STRIPE_SECRET_KEY'];
 const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));t.after(()=>{for(const k of keys)if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];});
 Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'staging',STOCKCHIEF_STAGING_SUBSCRIPTION_CHECKOUT:'1',STOCKCHIEF_BILLING_STRIPE_SECRET_KEY:'sk_test_round15'});
 const input={accountId:'a',requestId:'r',customerId:'cus_test',returnUrl:'https://stockchief.example.test/billing',planConfigurationId:'bpc_test'};
 let body;const options={fetch:async(url,o)=>{body=new URLSearchParams(o.body);return response({id:'bps_test'});}};
 await stripe.createPortal(input,options);assert.equal(body.get('configuration'),'bpc_test');assert.equal(body.has('flow_data[type]'),false);
 for(const [env,key] of [['production','sk_test_round15'],['staging','sk_live_refused']]){
  process.env.STOCKCHIEF_RUNTIME_ENV=env;process.env.STOCKCHIEF_BILLING_STRIPE_SECRET_KEY=key;
  await stripe.createPortal(input,options);assert.equal(body.has('configuration'),false);assert.equal(body.get('flow_data[type]'),'payment_method_update');
 }
});
test('TEST portal only offers exact approved monthly and annual prices with end-of-period downgrades',async()=>{
 const plans=['starter','growth','pro'].map((id,i)=>({id,currency:'USD',monthly_amount_minor:[19900,49900,99900][i],annual_amount_minor:[199000,499000,999000][i],stripe_monthly_price_id:`price_${id}_month`,stripe_annual_price_id:`price_${id}_year`}));
 let config,requests=0;const options={secretKey:'sk_test_portal',returnUrl:'https://stockchief.example.test/billing',fetch:async(url,o)=>{
  requests++;if(url.includes('/prices/')){const id=url.split('/').at(-1),p=plans.find(p=>[p.stripe_monthly_price_id,p.stripe_annual_price_id].includes(id)),year=id.endsWith('_year');return response({id,livemode:false,active:true,type:'recurring',currency:'usd',unit_amount:p[year?'annual_amount_minor':'monthly_amount_minor'],product:'prod_'+p.id,recurring:{interval:year?'year':'month',interval_count:1}});}
  config=new URLSearchParams(o.body);return response({id:'bpc_test',active:true,livemode:false,features:{subscription_update:{enabled:true}}});
 }};
 assert.equal((await portal.configure(plans,options)).id,'bpc_test');assert.equal(requests,7);
 assert.equal(config.get('features[subscription_update][products][0][prices][1]'),'price_starter_year');
 assert.equal(config.get('features[subscription_update][products][0][adjustable_quantity][enabled]'),'false');
 assert.equal(config.get('features[subscription_update][schedule_at_period_end][conditions][0][type]'),'decreasing_item_amount');
 assert.equal(config.get('features[subscription_update][proration_behavior]'),'always_invoice');
 await assert.rejects(()=>portal.configure(plans,{...options,secretKey:'sk_live_refused'}),/TEST key/);assert.equal(requests,7);
 await assert.rejects(()=>portal.configure(plans,{...options,fetch:async()=>response({livemode:true})}),/does not match/);
});
test('scheduled portal changes show the verified next date and reject another billing account',async t=>{
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_STAGING_SUBSCRIPTION_CHECKOUT','STOCKCHIEF_BILLING_STRIPE_SECRET_KEY'],prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));t.after(()=>{for(const k of keys)if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];});
 Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'staging',STOCKCHIEF_STAGING_SUBSCRIPTION_CHECKOUT:'1',STOCKCHIEF_BILLING_STRIPE_SECRET_KEY:'sk_test_round15'});
 const now=Math.floor(Date.now()/1000),sub={stripe_subscription_id:'sub_a',stripe_customer_id:'cus_a'},remote={id:'sub_a',customer:'cus_a',schedule:'sched_a'};
 const schedule={id:'sched_a',customer:'cus_a',subscription:'sub_a',status:'active',phases:[{start_date:now-100,items:[{price:'price_pro'}]},{start_date:now+3600,items:[{price:'price_starter'}]}]};
 const db={query:async(sql,args)=>{assert.deepEqual(args,['price_starter']);return {rows:[{public_name:'Starter'}]};}},provider={retrieveSubscription:async()=>remote,retrieveSchedule:async()=>schedule};
 const result=await portal.scheduledChange(db,sub,{provider});assert.equal(result.change.target_plan_name,'Starter');assert.equal(result.change.effective_at,new Date((now+3600)*1000).toISOString());
 schedule.customer='cus_other';await assert.rejects(()=>portal.scheduledChange(db,sub,{provider}),/another subscription/);
 remote.schedule=null;assert.deepEqual(await portal.scheduledChange(db,sub,{provider}),{checked:true,change:null});
});

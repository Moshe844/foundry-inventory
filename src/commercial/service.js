'use strict';

const config = require('../config');
const stripe = require('./stripe-billing');
const notifications = require('./notifications');
const entitlements = require('../entitlements/postgres-service');
const { newId } = require('../lib/util');
const { ValidationError,NotFoundError } = require('../domain/errors');

function normalizePlan(plan) {
  if (!plan) return plan;
  return {
    ...plan,
    is_public:Boolean(Number(plan.is_public)),
    is_recommended:Boolean(Number(plan.is_recommended)),
    sales_only:Boolean(Number(plan.sales_only)),
  };
}

async function listPlans(database, options = {}) {
  const filters = [options.includeDrafts ? 'status<>\'ARCHIVED\'' : "status='ACTIVE'"];
  if (!options.includePrivate) filters.push('is_public=1');
  const plans = (await database.query(`SELECT * FROM commercial_plans WHERE ${filters.join(' AND ')} ORDER BY display_order,id`)).rows.map(normalizePlan);
  for (const plan of plans) {
    plan.entitlements = (await database.query(`SELECT capability,enabled,configuration FROM commercial_plan_entitlements
      WHERE plan_id=$1 ORDER BY capability`,[plan.id])).rows;
    plan.meters = (await database.query(`SELECT * FROM commercial_plan_meters WHERE plan_id=$1 ORDER BY meter`,[plan.id])).rows;
  }
  return plans;
}

async function getPlan(database, planId) {
  const plan=normalizePlan((await database.query(`SELECT * FROM commercial_plans WHERE id=$1 AND status='ACTIVE'`,[planId])).rows[0]);
  if(!plan)throw new NotFoundError('That plan is not available.');
  return plan;
}

async function getSelfServicePlan(database,planId,options={}){
  const plan=normalizePlan((await database.query(`SELECT * FROM commercial_plans
    WHERE id=$1 AND status='ACTIVE' AND is_public=1 AND sales_only=0`,[planId])).rows[0]);
  if(!plan)throw new ValidationError('That plan is not available for self-service signup. Contact StockChief directly for a custom plan.');
  if(options.requireApproved!==false&&plan.packaging_status!=='APPROVED')throw new ValidationError(
    'Checkout is not open for this plan until its feature and pricing review is approved.');
  return plan;
}

async function validatePromotion(database,codeInput,planId,options={}){
  const code=String(codeInput||'').trim().toUpperCase();if(!code)return null;
  const promotion=(await database.query(`SELECT * FROM commercial_promo_codes WHERE code=$1 AND active=1
    AND (plan_id IS NULL OR plan_id=$2) AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())
    ${options.lock?'FOR UPDATE':''}`,[code,planId])).rows[0];
  if(!promotion||promotion.redemption_limit!==null&&Number(promotion.redeemed_count)>=Number(promotion.redemption_limit))
    throw new ValidationError('That promotion is invalid, expired, exhausted or not available for this plan.');
  return promotion;
}

async function beginCheckout(database, account, input, options = {}) {
  const plan=await getSelfServicePlan(database,input.planId);const interval=input.interval==='annual'?'ANNUAL':'MONTHLY';
  const priceId=interval==='ANNUAL'?plan.stripe_annual_price_id:plan.stripe_monthly_price_id;
  if(!priceId)throw new ValidationError('Checkout for this plan is not configured yet. Contact StockChief support.');
  const attemptId=newId('checkout');const promoCode=String(input.promoCode||'').trim().toUpperCase();let promotion=null;
  await database.transaction(async(client)=>{
    if(promoCode){promotion=await validatePromotion(client,promoCode,plan.id,{lock:true});
      await client.query('UPDATE commercial_promo_codes SET redeemed_count=redeemed_count+1 WHERE code=$1',[promoCode]);}
    await client.query(`INSERT INTO commercial_checkout_attempts
      (id,account_id,plan_id,billing_interval,status,return_path,promo_code,promo_status)
      VALUES($1,$2,$3,$4,'CREATED',$5,$6,$7)`,[attemptId,account.id,plan.id,interval,input.returnPath||'/onboarding',
      promotion?.code||null,promotion?'RESERVED':null]);
  },{isolation:'SERIALIZABLE'});
  const current=await entitlements.subscriptionFor(database,account.id);
  let session;try{session=await (options.provider||stripe).createCheckout({attemptId,accountId:account.id,planId:plan.id,
      email:account.email,customerId:current?.stripe_customer_id || null,priceId,
      trialDays:Math.max(Number(plan.trial_days||0),Number(promotion?.trial_days||0)),
      promotionCodeId:promotion?.stripe_promotion_code_id||null,
      successUrl:`${input.origin}/billing/checkout/complete?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:`${input.origin}/pricing?checkout=cancelled&plan=${encodeURIComponent(plan.id)}`},options.providerOptions||{});
  }catch(error){await releaseCheckoutAttempt(database,attemptId,'FAILED');throw error;}
  await database.query(`UPDATE commercial_checkout_attempts SET stripe_checkout_session_id=$2,status='OPEN',updated_at=now()
    WHERE id=$1`,[attemptId,session.id]);
  return {attemptId,url:session.url,sessionId:session.id};
}

async function completeCheckoutAttempt(database,sessionId){return database.transaction(async(client)=>{
  const attempt=(await client.query(`SELECT * FROM commercial_checkout_attempts WHERE stripe_checkout_session_id=$1 FOR UPDATE`,
    [sessionId])).rows[0];if(!attempt)return null;if(attempt.status!=='COMPLETED')await client.query(`UPDATE commercial_checkout_attempts
      SET status='COMPLETED',promo_status=CASE WHEN promo_status='RESERVED' THEN 'REDEEMED' ELSE promo_status END,updated_at=now()
      WHERE id=$1`,[attempt.id]);return attempt;},{isolation:'SERIALIZABLE'});}

async function releaseCheckoutAttempt(database,idOrSession,status='EXPIRED'){return database.transaction(async(client)=>{
  const attempt=(await client.query(`SELECT * FROM commercial_checkout_attempts
    WHERE id=$1 OR stripe_checkout_session_id=$1 FOR UPDATE`,[idOrSession])).rows[0];if(!attempt)return null;
  if(attempt.promo_code&&attempt.promo_status==='RESERVED'){await client.query(`UPDATE commercial_promo_codes
      SET redeemed_count=GREATEST(0,redeemed_count-1) WHERE code=$1`,[attempt.promo_code]);}
  await client.query(`UPDATE commercial_checkout_attempts SET status=$2,
    promo_status=CASE WHEN promo_status='RESERVED' THEN 'RELEASED' ELSE promo_status END,updated_at=now() WHERE id=$1`,
  [attempt.id,status]);return attempt;},{isolation:'SERIALIZABLE'});}

function statusFromStripe(subscription) {
  if(subscription.status==='trialing')return 'TRIALING';
  if(subscription.status==='active')return 'ACTIVE';
  if(subscription.status==='past_due'||subscription.status==='unpaid')return 'GRACE';
  if(subscription.status==='canceled'||subscription.status==='incomplete_expired')return 'CANCELLED';
  return 'PENDING';
}

async function upsertSubscription(client, data) {
  const item=data.items?.data?.[0]||{};const priceId=item.price?.id||item.plan?.id||null;
  const pricePlan=priceId?(await client.query(`SELECT id FROM commercial_plans
    WHERE stripe_monthly_price_id=$1 OR stripe_annual_price_id=$1`,[priceId])).rows[0]:null;
  const planId=pricePlan?.id||data.metadata?.stockchief_plan_id||data.planId;
  const accountId=data.metadata?.stockchief_account_id || data.accountId;
  if(!planId||!accountId)return null;
  const plan=(await client.query('SELECT grace_days FROM commercial_plans WHERE id=$1',[planId])).rows[0];
  if(!plan)return null;
  const status=statusFromStripe(data);const now=new Date();
  const graceEnds=status==='GRACE'?new Date(now.getTime()+Number(plan.grace_days||7)*86400000).toISOString():null;
  const result=await client.query(`INSERT INTO account_subscriptions
    (id,account_id,plan_id,status,billing_interval,stripe_customer_id,stripe_subscription_id,current_period_start,
     current_period_end,trial_ends_at,grace_ends_at,cancel_at_period_end,cancelled_at,source,provider_state,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),to_timestamp($9),to_timestamp($10),$11,$12,to_timestamp($13),
      'SELF_SERVICE',$14::jsonb,now())
    ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,status=EXCLUDED.status,
      billing_interval=EXCLUDED.billing_interval,stripe_customer_id=EXCLUDED.stripe_customer_id,
      stripe_subscription_id=EXCLUDED.stripe_subscription_id,current_period_start=EXCLUDED.current_period_start,
      current_period_end=EXCLUDED.current_period_end,trial_ends_at=EXCLUDED.trial_ends_at,
      grace_ends_at=CASE WHEN EXCLUDED.status='GRACE' THEN COALESCE(account_subscriptions.grace_ends_at,EXCLUDED.grace_ends_at)
        ELSE EXCLUDED.grace_ends_at END,cancel_at_period_end=EXCLUDED.cancel_at_period_end,
      cancelled_at=EXCLUDED.cancelled_at,provider_state=EXCLUDED.provider_state,updated_at=now() RETURNING *`,
  [newId('sub'),accountId,planId,status,(item.price?.recurring?.interval||item.plan?.interval)==='year'?'ANNUAL':'MONTHLY',
    typeof data.customer==='string'?data.customer:data.customer?.id, data.id,
    data.current_period_start || null,data.current_period_end || null,data.trial_end || null,graceEnds,
    data.cancel_at_period_end?1:0,data.canceled_at || null,JSON.stringify({stripeStatus:data.status})]);
  return result.rows[0];
}

async function handleBillingEvent(database,event) {
  try{return await database.transaction(async(client)=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`commercial-billing:${event.id}`]);
    const existing=(await client.query('SELECT status FROM commercial_billing_events WHERE provider_event_id=$1',[event.id])).rows[0];
    if(existing&&['PROCESSED','IGNORED'].includes(existing.status))return {duplicate:true};
    if(existing)await client.query(`UPDATE commercial_billing_events SET event_type=$2,status='RECEIVED',payload=$3::jsonb,
      error_message=NULL,processed_at=NULL WHERE provider_event_id=$1`,[event.id,event.type,JSON.stringify(event)]);
    else await client.query(`INSERT INTO commercial_billing_events(provider_event_id,event_type,status,payload)
      VALUES($1,$2,'RECEIVED',$3::jsonb)`,[event.id,event.type,JSON.stringify(event)]);
      const object=event.data?.object || {};let subscription=null;
      if(event.type==='checkout.session.completed'){
        const attempt=(await client.query(`SELECT * FROM commercial_checkout_attempts WHERE stripe_checkout_session_id=$1 FOR UPDATE`,[object.id])).rows[0];
        if(attempt&&attempt.status!=='COMPLETED')await client.query(`UPDATE commercial_checkout_attempts SET status='COMPLETED',
          promo_status=CASE WHEN promo_status='RESERVED' THEN 'REDEEMED' ELSE promo_status END,updated_at=now() WHERE id=$1`,[attempt.id]);
      } else if(event.type==='checkout.session.expired'){
        const attempt=(await client.query(`SELECT * FROM commercial_checkout_attempts WHERE stripe_checkout_session_id=$1 FOR UPDATE`,[object.id])).rows[0];
        if(attempt){if(attempt.promo_code&&attempt.promo_status==='RESERVED')await client.query(`UPDATE commercial_promo_codes
            SET redeemed_count=GREATEST(0,redeemed_count-1) WHERE code=$1`,[attempt.promo_code]);
          await client.query(`UPDATE commercial_checkout_attempts SET status='EXPIRED',
            promo_status=CASE WHEN promo_status='RESERVED' THEN 'RELEASED' ELSE promo_status END,updated_at=now() WHERE id=$1`,[attempt.id]);}
      } else if(event.type.startsWith('customer.subscription.')){const accountId=object.metadata?.stockchief_account_id;
        const previous=accountId?(await client.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[accountId])).rows[0]:null;
        subscription=await upsertSubscription(client,object);
        if(subscription&&!previous&&entitlements.operationalAccess(subscription).canOperate)await client.query(`INSERT INTO commercial_funnel_events
          (id,event_name,account_id,plan_id,source_path,detail) VALUES($1,'subscription_activated',$2,$3,'stripe_webhook',$4::jsonb)
          ON CONFLICT DO NOTHING`,[newId('funnel'),subscription.account_id,subscription.plan_id,
          JSON.stringify({stripeSubscriptionId:subscription.stripe_subscription_id})]);
        if(subscription&&previous&&previous.plan_id!==subscription.plan_id)await client.query(`INSERT INTO commercial_funnel_events
          (id,event_name,account_id,plan_id,source_path,detail) VALUES($1,'upgrade_completed',$2,$3,'stripe_webhook',$4::jsonb)`,
        [newId('funnel'),subscription.account_id,subscription.plan_id,JSON.stringify({fromPlan:previous.plan_id,toPlan:subscription.plan_id})]);
        if(subscription&&object.cancel_at_period_end&&!Number(previous?.cancel_at_period_end||0))await client.query(`INSERT INTO commercial_funnel_events
          (id,event_name,account_id,plan_id,source_path,detail) VALUES($1,'cancellation',$2,$3,'stripe_webhook',$4::jsonb)`,
        [newId('funnel'),subscription.account_id,subscription.plan_id,JSON.stringify({atPeriodEnd:true})]);
      }
      else if(event.type==='invoice.payment_failed'){
        const existing=(await client.query('SELECT * FROM account_subscriptions WHERE stripe_customer_id=$1 FOR UPDATE',
          [typeof object.customer==='string'?object.customer:object.customer?.id])).rows[0];
        if(existing){const plan=(await client.query('SELECT grace_days FROM commercial_plans WHERE id=$1',[existing.plan_id])).rows[0];
          const failed=(await client.query(`UPDATE account_subscriptions SET status='GRACE',
            grace_ends_at=COALESCE(grace_ends_at,now()+($2||' days')::interval),
            provider_state=provider_state||$3::jsonb,updated_at=now() WHERE id=$1 RETURNING account_id,grace_ends_at`,
          [existing.id,String(Number(plan?.grace_days||7)),JSON.stringify({latestFailedInvoice:object.id})])).rows[0];
          await notifications.queuePaymentFailed(client,{eventId:event.id,accountId:failed.account_id,
            graceEnds:failed.grace_ends_at});}
      } else if(event.type==='invoice.paid'){
        const customer=typeof object.customer==='string'?object.customer:object.customer?.id;
        await client.query(`UPDATE account_subscriptions SET status=CASE WHEN status='CANCELLED' THEN status ELSE 'ACTIVE' END,grace_ends_at=NULL,
          provider_state=provider_state||$2::jsonb,updated_at=now() WHERE stripe_customer_id=$1`,
        [customer,JSON.stringify({latestPaidInvoice:object.id})]);
        await client.query(`UPDATE commercial_overage_charges charge SET status='BILLED',updated_at=now()
          FROM account_subscriptions subscription WHERE charge.subscription_id=subscription.id
          AND subscription.stripe_customer_id=$1 AND charge.status='CHARGED'`,[customer]);
      }
      await client.query(`UPDATE commercial_billing_events SET status=$2,processed_at=now() WHERE provider_event_id=$1`,
        [event.id,subscription||event.type.startsWith('checkout.')||event.type.startsWith('invoice.')?'PROCESSED':'IGNORED']);
      return {duplicate:false,subscription};
  },{isolation:'SERIALIZABLE'});}catch(error){await database.query(`INSERT INTO commercial_billing_events
    (provider_event_id,event_type,status,payload,error_message,processed_at) VALUES($1,$2,'FAILED',$3::jsonb,$4,now())
    ON CONFLICT(provider_event_id) DO UPDATE SET status='FAILED',payload=EXCLUDED.payload,error_message=EXCLUDED.error_message,
      processed_at=now() WHERE commercial_billing_events.status NOT IN ('PROCESSED','IGNORED')`,
  [event.id,event.type,JSON.stringify(event),String(error.message||error).slice(0,1000)]);throw error;}
}

async function track(database,input={}) {
  if(!config.commercial.analyticsEnabled)return {recorded:false};
  await database.query(`INSERT INTO commercial_funnel_events(id,event_name,anonymous_id,account_id,plan_id,source_path,detail)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[newId('funnel'),input.eventName,input.anonymousId||null,input.accountId||null,
    input.planId||null,input.sourcePath||null,JSON.stringify(input.detail||{})]);
  return {recorded:true};
}

async function trackOnce(database,input={}){
  if(!config.commercial.analyticsEnabled)return {recorded:false};
  const result=await database.query(`INSERT INTO commercial_funnel_events
    (id,event_name,anonymous_id,account_id,plan_id,source_path,detail) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
    ON CONFLICT DO NOTHING RETURNING id`,[newId('funnel'),input.eventName,input.anonymousId||null,input.accountId||null,
    input.planId||null,input.sourcePath||null,JSON.stringify(input.detail||{})]);
  return {recorded:Boolean(result.rows.length)};
}

async function prepareOverageCharges(database,customerId){
  const subscription=(await database.query(`SELECT subscription.*,plan.currency FROM account_subscriptions subscription
    JOIN commercial_plans plan ON plan.id=subscription.plan_id WHERE subscription.stripe_customer_id=$1`,[customerId])).rows[0];
  if(!subscription||!subscription.current_period_start||!subscription.current_period_end)return [];
  const meters=(await database.query(`SELECT meter FROM commercial_plan_meters WHERE plan_id=$1
    AND overage_block_units IS NOT NULL AND overage_amount_minor IS NOT NULL`,[subscription.plan_id])).rows;
  const created=[];for(const row of meters){const state=await entitlements.meterState(database,
    {accountId:subscription.account_id,workspaceId:null},row.meter,{subscription,
      now:new Date(new Date(subscription.current_period_end).getTime()-1).toISOString()});
    if(state.overageAmountMinor<=0)continue;const result=await database.query(`INSERT INTO commercial_overage_charges
      (id,account_id,subscription_id,meter,period_start,period_end,overage_units,amount_minor,currency)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(account_id,meter,period_start,period_end) DO NOTHING RETURNING *`,
    [newId('overage'),subscription.account_id,subscription.id,row.meter,subscription.current_period_start,
      subscription.current_period_end,state.overageUnits,state.overageAmountMinor,subscription.currency]);if(result.rows[0])created.push(result.rows[0]);}
  return created;
}

async function deliverOverageCharges(database,customerId,provider=stripe,providerOptions={}){
  const rows=(await database.query(`SELECT charge.*,subscription.stripe_customer_id,subscription.stripe_subscription_id
    FROM commercial_overage_charges charge JOIN account_subscriptions subscription ON subscription.id=charge.subscription_id
    WHERE subscription.stripe_customer_id=$1 AND charge.status IN ('PENDING','CHARGING','FAILED') ORDER BY charge.created_at`,
  [customerId])).rows;const delivered=[];
  for(const charge of rows){await database.query(`UPDATE commercial_overage_charges SET status='CHARGING',error_message=NULL,updated_at=now()
      WHERE id=$1`,[charge.id]);try{const item=await provider.createInvoiceItem({chargeId:charge.id,customerId:charge.stripe_customer_id,
        subscriptionId:charge.stripe_subscription_id,amountMinor:Number(charge.amount_minor),currency:charge.currency,meter:charge.meter,
        description:`StockChief ${charge.meter.replaceAll('_',' ')} overage · ${charge.overage_units} units`},providerOptions);
      await database.query(`UPDATE commercial_overage_charges SET status='CHARGED',stripe_invoice_item_id=$2,
        error_message=NULL,updated_at=now() WHERE id=$1`,[charge.id,item.id]);delivered.push({...charge,stripe_invoice_item_id:item.id});
    }catch(error){await database.query(`UPDATE commercial_overage_charges SET status='FAILED',error_message=$2,updated_at=now()
        WHERE id=$1`,[charge.id,String(error.message||error).slice(0,500)]);throw error;}}
  return delivered;
}

module.exports={listPlans,getPlan,getSelfServicePlan,validatePromotion,beginCheckout,completeCheckoutAttempt,releaseCheckoutAttempt,statusFromStripe,
  upsertSubscription,handleBillingEvent,track,trackOnce,prepareOverageCharges,deliverOverageCharges};

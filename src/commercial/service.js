'use strict';

const config = require('../config');
const stripe = require('./stripe-billing');
const notifications = require('./notifications');
const entitlements = require('../entitlements/postgres-service');
const control = require('./control-service');
const release=require('./release');
const addons=require('./addons');
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
    plan.meters = (await database.query(`SELECT policy.*,definition.kind,definition.customer_visible,
      COALESCE(NULLIF(policy.label,''),definition.label) AS label
      FROM commercial_plan_meters policy JOIN commercial_meter_definitions definition ON definition.meter=policy.meter
      WHERE policy.plan_id=$1 ORDER BY definition.kind,policy.meter`,[plan.id])).rows;
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
  await release.assertCheckoutOpen(database,options);
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

function planPriceId(plan,interval){return interval==='ANNUAL'?plan.stripe_annual_price_id:plan.stripe_monthly_price_id;}
function prorationAmount(preview){return (preview?.lines?.data||[]).filter((line)=>line.proration===true
  ||line.parent?.subscription_item_details?.proration===true).reduce((sum,line)=>sum+Number(line.amount||0),0);}

async function subscriptionChangeQuote(database,accountId,input,options={}){
  await release.assertCheckoutOpen(database,options);
  const provider=options.provider||stripe;const current=await entitlements.subscriptionFor(database,accountId);
  if(!current?.stripe_subscription_id||!current.stripe_customer_id)throw new ValidationError(
    'This account does not have a Stripe subscription to change.');
  const target=await getSelfServicePlan(database,input.planId);const currentPlan=await getPlan(database,current.plan_id);
  const interval=input.interval==='annual'||input.interval==='ANNUAL'?'ANNUAL':'MONTHLY';const priceId=planPriceId(target,interval);
  if(!priceId)throw new ValidationError('That plan and billing interval are not configured for checkout.');
  if(target.id===current.plan_id&&interval===current.billing_interval)throw new ValidationError('That plan is already active.');
  const providerSubscription=await provider.retrieveSubscription(current.stripe_subscription_id,options.providerOptions||{});
  const item=providerSubscription.items?.data?.[0];if(!item?.id)throw new ValidationError(
    'Stripe did not return the subscription item required to change this plan.');
  const downgrade=Number(target.display_order)<Number(currentPlan.display_order);
  const excess=downgrade?await control.resourceExcess(database,{accountId,workspaceId:null},target.id):{};
  const prorationDate=Math.floor(Date.now()/1000);let preview=null;
  if(options.preview!==false&&provider.previewSubscriptionChange)preview=await provider.previewSubscriptionChange({
    customerId:current.stripe_customer_id,subscriptionId:current.stripe_subscription_id,itemId:item.id,priceId,
    prorationBehavior:downgrade?'none':'create_prorations',prorationDate},options.providerOptions||{});
  return {current,currentPlan,target,interval,priceId,itemId:item.id,downgrade,excess,preview,prorationDate,
    prorationAmountMinor:prorationAmount(preview),effectiveAt:downgrade?current.current_period_end:new Date().toISOString()};
}

async function requestSubscriptionChange(database,accountId,input,options={}){
  const provider=options.provider||stripe;const quote=await subscriptionChangeQuote(database,accountId,input,options);
  if(quote.downgrade&&Object.keys(quote.excess).length)throw new ValidationError(
    'Current usage exceeds the lower plan. Reduce the listed resources before scheduling this downgrade.');
  const requestKey=input.idempotencyKey||`${quote.current.stripe_subscription_id}:${quote.current.current_period_end}:${quote.target.id}:${quote.interval}`;
  const changeId=newId('subchange');const inserted=await database.query(`INSERT INTO commercial_subscription_changes
    (id,account_id,subscription_id,from_plan_id,to_plan_id,status,effective_at,resource_excess,requested_by_account_id,request_key,request_quote)
    VALUES($1,$2,$3,$4,$5,'PENDING',$6,$7::jsonb,$8,$9,$10::jsonb)
    ON CONFLICT(account_id,request_key) WHERE request_key IS NOT NULL DO NOTHING RETURNING id`,
    [changeId,accountId,quote.current.id,quote.current.plan_id,quote.target.id,quote.effectiveAt,JSON.stringify(quote.excess),
      input.requestedByAccountId||accountId,requestKey,JSON.stringify(quote)]);
  if(!inserted.rows.length){const prior=(await database.query(`SELECT * FROM commercial_subscription_changes
    WHERE account_id=$1 AND request_key=$2`,[accountId,requestKey])).rows[0];
    if(prior.to_plan_id!==quote.target.id||prior.request_quote?.interval!==quote.interval)
      throw new ValidationError('That plan-change key was already used for a different request.');
    if(prior.status==='BLOCKED')throw new ValidationError('This plan change needs billing reconciliation before it can be retried.');
    return {changeId:prior.id,quote:prior.request_quote,subscription:await entitlements.subscriptionFor(database,accountId),
      status:prior.status,replayed:true};}
  let updated;try{updated=quote.downgrade?await provider.scheduleDowngrade({changeId,
      subscriptionId:quote.current.stripe_subscription_id,currentPriceId:planPriceId(quote.currentPlan,quote.current.billing_interval),
      periodEnd:Math.floor(new Date(quote.current.current_period_end).getTime()/1000),priceId:quote.priceId,interval:quote.interval},options.providerOptions||{}):
    await provider.updateSubscription({changeId,accountId,planId:quote.target.id,
      subscriptionId:quote.current.stripe_subscription_id,itemId:quote.itemId,priceId:quote.priceId,
      prorationBehavior:quote.downgrade?'none':'always_invoice',paymentBehavior:'pending_if_incomplete',
      prorationDate:quote.downgrade?undefined:quote.prorationDate},options.providerOptions||{});
  }catch(error){await database.query(`UPDATE commercial_subscription_changes SET status='BLOCKED',updated_at=now()
      WHERE id=$1`,[changeId]);
    await database.query(`INSERT INTO commercial_critical_warnings(id,account_id,fingerprint,code,detail)
      VALUES($1,$2,$3,'SUBSCRIPTION_CHANGE_RECONCILIATION_REQUIRED',$4::jsonb)
      ON CONFLICT(fingerprint) DO NOTHING`,[newId('critical'),accountId,`subscription-change:${changeId}`,
      JSON.stringify({changeId,subscriptionId:quote.current.stripe_subscription_id,error:String(error.message).slice(0,500)})]);
    throw error;}
  const saved=await entitlements.subscriptionFor(database,accountId);
  const applied=false; // Entitlement changes are activated only by a verified webhook.
  const change=(await database.query(`UPDATE commercial_subscription_changes
    SET status=CASE WHEN status='APPLIED' THEN status ELSE $2 END,provider_reference=$3,
    proration_amount_minor=$4,updated_at=now() WHERE id=$1 RETURNING status`,[changeId,applied?'APPLIED':'PENDING',updated.id||null,
    quote.prorationAmountMinor])).rows[0];
  return {changeId,quote,subscription:saved,status:change.status};
}

async function setSubscriptionCancellation(database,accountId,cancelAtPeriodEnd,options={}){
  const provider=options.provider||stripe;const current=await entitlements.subscriptionFor(database,accountId);
  if(!current?.stripe_subscription_id)throw new ValidationError('This account does not have an active Stripe subscription.');
  const updated=await provider.setCancellation({accountId,planId:current.plan_id,requestId:options.requestId||newId('cancellation'),
    subscriptionId:current.stripe_subscription_id,cancelAtPeriodEnd:Boolean(cancelAtPeriodEnd)},options.providerOptions||{});
  const customer=typeof updated.customer==='string'?updated.customer:updated.customer?.id;
  if(updated.id!==current.stripe_subscription_id||customer!==current.stripe_customer_id)
    throw new ValidationError('Stripe cancellation response does not match this billing account.');
  // This response updates only the cancellation flag, never commercial access.
  // Plan, status and period entitlement changes require a signed webhook.
  return (await database.query(`UPDATE account_subscriptions SET cancel_at_period_end=$2,updated_at=now()
    WHERE account_id=$1 AND stripe_subscription_id=$3 RETURNING *`,
    [accountId,updated.cancel_at_period_end?1:0,current.stripe_subscription_id])).rows[0];
}

function statusFromStripe(subscription) {
  if(subscription.status==='trialing')return 'TRIALING';
  if(subscription.status==='active')return 'ACTIVE';
  if(subscription.status==='past_due'||subscription.status==='unpaid')return 'GRACE';
  if(subscription.status==='canceled'||subscription.status==='incomplete_expired')return 'CANCELLED';
  return 'PENDING';
}

async function upsertSubscription(client, data, options={}) {
  const item=data.items?.data?.[0]||{};const priceId=item.price?.id||item.plan?.id||null;
  const pricePlan=priceId?(await client.query(`SELECT id FROM commercial_plans
    WHERE stripe_monthly_price_id=$1 OR stripe_annual_price_id=$1`,[priceId])).rows[0]:null;
  const requestedPlanId=pricePlan?.id;
  const accountId=data.metadata?.stockchief_account_id || data.accountId;
  if(!requestedPlanId||!accountId)return null;
  const providerCreatedAt=options.providerCreatedAt||null;
  const existing=(await client.query('SELECT * FROM account_subscriptions WHERE account_id=$1 FOR UPDATE',[accountId])).rows[0];
  const customerId=typeof data.customer==='string'?data.customer:data.customer?.id;
  if(existing?.stripe_customer_id&&existing.stripe_customer_id!==customerId)
    throw new ValidationError('Stripe customer does not match the subscription owner.');
  if(existing?.stripe_subscription_id&&existing.stripe_subscription_id!==data.id
      &&!['PENDING','CANCELLED','SUSPENDED'].includes(existing.status))
    throw new ValidationError('An existing operational subscription cannot be replaced by another subscription.');
  if(!options.authoritative&&providerCreatedAt&&existing?.last_provider_event_created_at
      &&new Date(existing.last_provider_event_created_at)>new Date(providerCreatedAt))return {...existing,ignoredStaleEvent:true};
  const pending=existing?(await client.query(`SELECT change.*,
    (target.display_order<source.display_order) AS is_downgrade FROM commercial_subscription_changes change
    JOIN commercial_plans source ON source.id=change.from_plan_id JOIN commercial_plans target ON target.id=change.to_plan_id
    WHERE change.account_id=$1 AND change.to_plan_id=$2 AND change.status='PENDING'
    ORDER BY change.created_at DESC LIMIT 1 FOR UPDATE`,[accountId,requestedPlanId])).rows[0]:null;
  const periodStart=item.current_period_start||data.current_period_start;
  const periodEnd=item.current_period_end||data.current_period_end;
  const eventPeriodStart=periodStart?new Date(Number(periodStart)*1000):new Date();
  const deferPlan=Boolean(pending?.is_downgrade&&pending.effective_at&&eventPeriodStart<new Date(pending.effective_at));
  const planId=deferPlan?existing.plan_id:requestedPlanId;
  const plan=(await client.query('SELECT grace_days FROM commercial_plans WHERE id=$1',[planId])).rows[0];
  if(!plan)return null;
  const status=statusFromStripe(data);const now=new Date();
  const graceEnds=status==='GRACE'?new Date(now.getTime()+Number(plan.grace_days||7)*86400000).toISOString():null;
  const result=await client.query(`INSERT INTO account_subscriptions
    (id,account_id,plan_id,plan_version_id,status,billing_interval,stripe_customer_id,stripe_subscription_id,current_period_start,
     current_period_end,trial_ends_at,grace_ends_at,cancel_at_period_end,cancelled_at,source,provider_state,
     last_provider_event_created_at,updated_at)
    VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1),
      $4,$5,$6,$7,to_timestamp($8),to_timestamp($9),to_timestamp($10),$11,$12,to_timestamp($13),
      'SELF_SERVICE',$14::jsonb,$15::timestamptz,now())
    ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,status=EXCLUDED.status,
      plan_version_id=CASE WHEN account_subscriptions.plan_id=EXCLUDED.plan_id
        THEN COALESCE(account_subscriptions.plan_version_id,EXCLUDED.plan_version_id) ELSE EXCLUDED.plan_version_id END,
      billing_interval=EXCLUDED.billing_interval,stripe_customer_id=EXCLUDED.stripe_customer_id,
      stripe_subscription_id=EXCLUDED.stripe_subscription_id,current_period_start=EXCLUDED.current_period_start,
      current_period_end=EXCLUDED.current_period_end,trial_ends_at=EXCLUDED.trial_ends_at,
      grace_ends_at=CASE WHEN EXCLUDED.status='GRACE' THEN COALESCE(account_subscriptions.grace_ends_at,EXCLUDED.grace_ends_at)
        ELSE EXCLUDED.grace_ends_at END,cancel_at_period_end=EXCLUDED.cancel_at_period_end,
      cancelled_at=EXCLUDED.cancelled_at,provider_state=EXCLUDED.provider_state,
      last_provider_event_created_at=COALESCE(EXCLUDED.last_provider_event_created_at,account_subscriptions.last_provider_event_created_at),
      updated_at=now() RETURNING *`,
  [newId('sub'),accountId,planId,status,deferPlan?existing.billing_interval:
    (item.price?.recurring?.interval||item.plan?.interval)==='year'?'ANNUAL':'MONTHLY',
    typeof data.customer==='string'?data.customer:data.customer?.id, data.id,
    periodStart || null,periodEnd || null,data.trial_end || null,graceEnds,
    data.cancel_at_period_end?1:0,data.canceled_at || null,JSON.stringify({stripeStatus:data.status,stripePlanId:requestedPlanId,
      scheduledPlanId:deferPlan?requestedPlanId:null}),providerCreatedAt]);
  const saved={...result.rows[0],scheduledChange:deferPlan?pending:null};
  if(existing&&existing.plan_id!==saved.plan_id){const applied=await client.query(`UPDATE commercial_subscription_changes
      SET status='APPLIED',effective_at=COALESCE(effective_at,now()),provider_reference=COALESCE(provider_reference,$4),updated_at=now()
      WHERE account_id=$1 AND from_plan_id=$2 AND to_plan_id=$3 AND status='PENDING' RETURNING id`,
    [saved.account_id,existing.plan_id,saved.plan_id,data.id]);if(!applied.rows.length)await client.query(`INSERT INTO commercial_subscription_changes
    (id,account_id,subscription_id,from_plan_id,to_plan_id,status,effective_at,provider_reference,resource_excess)
    VALUES($1,$2,$3,$4,$5,'APPLIED',now(),$6,'{}'::jsonb)`,[newId('subchange'),saved.account_id,saved.id,
    existing.plan_id,saved.plan_id,data.id]);}
  return saved;
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
      const addonHandled=object.metadata?.stockchief_purchase_id&&
        ['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed',
         'payment_intent.succeeded','payment_intent.payment_failed'].includes(event.type)
        ?await addons.receivePayment(client,event):false;
      if(['refund.created','refund.updated','charge.succeeded','charge.updated','charge.dispute.created','charge.dispute.updated','charge.dispute.closed'].includes(event.type))
        await require('./stripe-financials').handle(client,event);
      if(addonHandled){} else if(event.type==='checkout.session.completed'){
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
        subscription=await upsertSubscription(client,object,{providerCreatedAt:event.created
          ?new Date(Number(event.created)*1000).toISOString():null});
        if(subscription&&!subscription.ignoredStaleEvent&&!previous&&entitlements.operationalAccess(subscription).canOperate)await client.query(`INSERT INTO commercial_funnel_events
          (id,event_name,account_id,plan_id,source_path,detail) VALUES($1,'subscription_activated',$2,$3,'stripe_webhook',$4::jsonb)
          ON CONFLICT DO NOTHING`,[newId('funnel'),subscription.account_id,subscription.plan_id,
          JSON.stringify({stripeSubscriptionId:subscription.stripe_subscription_id})]);
        if(subscription&&!subscription.ignoredStaleEvent&&previous&&previous.plan_id!==subscription.plan_id)await client.query(`INSERT INTO commercial_funnel_events
          (id,event_name,account_id,plan_id,source_path,detail) VALUES($1,'upgrade_completed',$2,$3,'stripe_webhook',$4::jsonb)`,
        [newId('funnel'),subscription.account_id,subscription.plan_id,JSON.stringify({fromPlan:previous.plan_id,toPlan:subscription.plan_id})]);
        if(subscription&&!subscription.ignoredStaleEvent&&object.cancel_at_period_end&&!Number(previous?.cancel_at_period_end||0))await client.query(`INSERT INTO commercial_funnel_events
          (id,event_name,account_id,plan_id,source_path,detail) VALUES($1,'cancellation',$2,$3,'stripe_webhook',$4::jsonb)`,
        [newId('funnel'),subscription.account_id,subscription.plan_id,JSON.stringify({atPeriodEnd:true})]);
      }
      else if(event.type==='invoice.payment_failed'){
        const invoiceSubscription=typeof object.subscription==='string'?object.subscription:object.subscription?.id||object.parent?.subscription_details?.subscription;
        const existing=(await client.query('SELECT * FROM account_subscriptions WHERE stripe_subscription_id=$1 FOR UPDATE',
          [invoiceSubscription||null])).rows[0];
        const invoiceCustomer=typeof object.customer==='string'?object.customer:object.customer?.id;
        if(existing&&existing.stripe_customer_id===invoiceCustomer&&existing.status!=='CANCELLED'){
          if(object.billing_reason==='subscription_update'){
            // A declined upgrade does not revoke the customer's already-paid tier.
            // Stripe's pending update and subsequent subscription webhook decide the upgrade.
            await client.query('UPDATE account_subscriptions SET provider_state=provider_state||$2::jsonb WHERE id=$1',
              [existing.id,JSON.stringify({latestFailedUpgradeInvoice:object.id})]);
          }else{
          const plan=(await client.query('SELECT grace_days FROM commercial_plans WHERE id=$1',[existing.plan_id])).rows[0];
          const providerCreatedAt=event.created?new Date(Number(event.created)*1000).toISOString():null;
          const failed=(await client.query(`UPDATE account_subscriptions SET status='GRACE',
            grace_ends_at=COALESCE(grace_ends_at,now()+($2||' days')::interval),
            provider_state=provider_state||$3::jsonb,last_provider_event_created_at=COALESCE($4::timestamptz,last_provider_event_created_at),
            updated_at=now() WHERE id=$1 AND ($4::timestamptz IS NULL OR last_provider_event_created_at IS NULL
              OR last_provider_event_created_at<=$4::timestamptz) RETURNING account_id,grace_ends_at`,
          [existing.id,String(Number(plan?.grace_days||7)),JSON.stringify({latestFailedInvoice:object.id}),providerCreatedAt])).rows[0];
          if(failed)await notifications.queuePaymentFailed(client,{eventId:event.id,accountId:failed.account_id,
            graceEnds:failed.grace_ends_at});}}
      } else if(event.type==='invoice.paid'){
        const customer=typeof object.customer==='string'?object.customer:object.customer?.id;
        const invoiceSubscription=typeof object.subscription==='string'?object.subscription:object.subscription?.id||object.parent?.subscription_details?.subscription;
        const providerCreatedAt=event.created?new Date(Number(event.created)*1000).toISOString():null;
        await client.query(`UPDATE account_subscriptions SET status=CASE WHEN status='CANCELLED' THEN status ELSE 'ACTIVE' END,grace_ends_at=NULL,
          provider_state=provider_state||$2::jsonb,last_provider_event_created_at=COALESCE($3::timestamptz,last_provider_event_created_at),
          updated_at=now() WHERE stripe_subscription_id=$1 AND stripe_customer_id=$4
            AND (status<>'GRACE' OR provider_state->>'latestFailedInvoice'=$5)
            AND ($3::timestamptz IS NULL OR last_provider_event_created_at IS NULL
            OR last_provider_event_created_at<=$3::timestamptz)`,
        [invoiceSubscription||null,JSON.stringify({latestPaidInvoice:object.id}),providerCreatedAt,customer,object.id]);
        const owner=(await client.query('SELECT account_id FROM account_subscriptions WHERE stripe_subscription_id=$1 AND stripe_customer_id=$2',
          [invoiceSubscription||null,customer])).rows[0];
        const legacyIntent=typeof object.payment_intent==='string'?object.payment_intent:object.payment_intent?.id;
        const paymentIntentIds=[...new Set([legacyIntent,...(object.payments?.data||[])
          .filter(payment=>payment.status==='paid'&&payment.payment?.type==='payment_intent')
          .map(payment=>typeof payment.payment.payment_intent==='string'?payment.payment.payment_intent:payment.payment.payment_intent?.id)].filter(Boolean))];
        if(!owner&&Number(object.amount_paid||0)>0)
          throw new ValidationError('This paid Stripe invoice is awaiting authoritative subscription ownership. Retry reconciliation after its subscription webhook.');
        if(owner)await client.query(`INSERT INTO commercial_revenue_events(id,account_id,source_id,kind,amount_minor,currency,period_start,period_end,occurred_at,detail)
          VALUES($1,$2,$3,'SUBSCRIPTION',$4,$5,to_timestamp($6),to_timestamp($7),to_timestamp($8),$9::jsonb) ON CONFLICT(source_id) DO NOTHING`,
          [newId('revenue'),owner.account_id,`invoice:${object.id}`,Number(object.amount_paid||0)-Number(object.total_taxes?.reduce((sum,t)=>sum+Number(t.amount||0),0)||object.tax||0),
            String(object.currency||'usd').toUpperCase(),object.period_start||null,object.period_end||null,event.created||Math.floor(Date.now()/1000),
            JSON.stringify({invoiceId:object.id,paymentIntentId:paymentIntentIds[0]||null,paymentIntentIds,
              amountPaid:object.amount_paid,taxes:object.total_taxes||null,discounts:object.total_discount_amounts||[]})]);
        if(owner&&Number(object.amount_paid)>0){
          const durable={query:client.query.bind(client),transaction:fn=>fn(client)};
          await require('../operations/postgres-job-queue').enqueue(durable,{kind:'commercial.stripe-invoice-sync',
            idempotencyKey:`stripe-invoice:${object.id}`,payload:{accountId:owner.account_id,invoiceId:object.id},maxAttempts:8});
          if(!paymentIntentIds.length||object.payments?.has_more)await client.query(`INSERT INTO commercial_critical_warnings
            (id,account_id,fingerprint,code,detail) VALUES($1,$2,$3,'MISSING_STRIPE_PAYMENT_BINDING',$4::jsonb)
            ON CONFLICT(fingerprint) DO UPDATE SET status='OPEN'`,[newId('critical'),owner.account_id,`invoice-payments:${object.id}`,
              JSON.stringify({invoiceId:object.id,paidInvoiceAmount:object.amount_paid,notVerifiedAsStripeCash:true})]);
          for(const intent of paymentIntentIds){await client.query(`INSERT INTO commercial_critical_warnings(id,account_id,fingerprint,code,detail)
            VALUES($1,$2,$3,'MISSING_STRIPE_FEE',$4::jsonb) ON CONFLICT(fingerprint) DO UPDATE SET status='OPEN'`,
            [newId('critical'),owner.account_id,`stripe-payment-fee:${intent}`,JSON.stringify({paymentIntentId:intent,invoiceId:object.id})]);
            await require('./stripe-financials').reconcileForPayment(client,intent);}
        }
      }
      await client.query(`UPDATE commercial_billing_events SET status=$2,processed_at=now() WHERE provider_event_id=$1`,
        [event.id,subscription||addonHandled||event.type.startsWith('checkout.')||event.type.startsWith('invoice.')
          ||event.type.startsWith('refund.')||event.type.startsWith('charge.')?'PROCESSED':'IGNORED']);
      await client.query("UPDATE commercial_critical_warnings SET status='RESOLVED' WHERE fingerprint=$1",[`billing-event:${event.id}`]);
      return {duplicate:false,subscription};
  },{isolation:'SERIALIZABLE',retrySafe:true});}catch(error){await database.query(`INSERT INTO commercial_billing_events
    (provider_event_id,event_type,status,payload,error_message,processed_at) VALUES($1,$2,'FAILED',$3::jsonb,$4,now())
    ON CONFLICT(provider_event_id) DO UPDATE SET status='FAILED',payload=EXCLUDED.payload,error_message=EXCLUDED.error_message,
      processed_at=now() WHERE commercial_billing_events.status NOT IN ('PROCESSED','IGNORED')`,
  [event.id,event.type,JSON.stringify(event),String(error.message||error).slice(0,1000)]);
    await database.query(`INSERT INTO commercial_critical_warnings(id,fingerprint,code,detail)
      VALUES($1,$2,'BILLING_EVENT_RECONCILIATION_REQUIRED',$3::jsonb)
      ON CONFLICT(fingerprint) DO UPDATE SET status='OPEN',detail=EXCLUDED.detail`,[newId('critical'),`billing-event:${event.id}`,
        JSON.stringify({eventId:event.id,eventType:event.type,error:String(error.message||error).slice(0,500)})]);
    throw error;}
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
  return []; // Compatibility only: implicit overage charging has been retired.
}

async function deliverOverageCharges(database,customerId,provider=stripe,providerOptions={}){
  return []; // Existing ledger history is retained, but must never initiate new charges.
}

module.exports={listPlans,getPlan,getSelfServicePlan,validatePromotion,beginCheckout,completeCheckoutAttempt,releaseCheckoutAttempt,
  subscriptionChangeQuote,requestSubscriptionChange,setSubscriptionCancellation,statusFromStripe,upsertSubscription,
  handleBillingEvent,track,trackOnce,prepareOverageCharges,deliverOverageCharges};

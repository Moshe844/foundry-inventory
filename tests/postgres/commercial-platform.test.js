'use strict';
process.env.NODE_ENV='test';
process.env.ANTHROPIC_API_KEY=''; // Regression fixtures never call a paid model; the cost simulation is a separate real run.

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const auth=require('../../src/domain/postgres-auth-service');
const entitlements=require('../../src/entitlements/postgres-service');
const commercial=require('../../src/commercial/service');
const stripeBilling=require('../../src/commercial/stripe-billing');
const assistant=require('../../src/assistant/postgres-service');
const lifecycle=require('../../src/domain/postgres-account-lifecycle');
const locations=require('../../src/domain/postgres-location-service');
const connections=require('../../src/connections/postgres-service');
const publicApi=require('../../src/connections/postgres-public-api');
const {commercialScope}=require('../../src/web/commercial-middleware');
const {newId}=require('../../src/lib/util');
const systemEmail=require('../../src/operations/email');
const runtimeHandlers=require('../../src/operations/postgres-runtime-handlers');
const commercialNotifications=require('../../src/commercial/notifications');

async function subscribe(database,accountId,planId,status='ACTIVE',input={}){
  const id=newId('sub');await database.query(`INSERT INTO account_subscriptions
    (id,account_id,plan_id,status,billing_interval,current_period_start,current_period_end,source)
    VALUES($1,$2,$3,$4,'MONTHLY',$5,$6,'TEST') ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,
    status=EXCLUDED.status,current_period_start=EXCLUDED.current_period_start,current_period_end=EXCLUDED.current_period_end,
    updated_at=now()`,[id,accountId,planId,status,input.start||'2026-09-01T00:00:00Z',input.end||'2026-10-01T00:00:00Z']);
}

test('commercial entitlement and subscription lifecycle acceptance', {timeout:180000},async(context)=>{
  const cluster=await startCluster();const database=openPostgres(cluster.connectionString,{applicationName:'commercial-acceptance'});
  await migratePostgres(database);context.after(async()=>{await database.close();cluster.stop();});
  const business=await auth.createBusiness(database,{name:'Commercial Owner',businessName:'Commercial Business',
    email:'commercial@example.test',password:'commercial-password',now:'2026-09-01T00:00:00Z'});
  const scope={accountId:business.accountId,workspaceId:business.workspaceId};await subscribe(database,business.accountId,'starter');
  const packaging=(await database.query('SELECT packaging_status,packaging_reviewed_at FROM commercial_plans ORDER BY display_order')).rows;
  assert.equal(packaging.length,4);assert.ok(packaging.every((plan)=>plan.packaging_status==='PROPOSED'&&plan.packaging_reviewed_at));

  await context.test('1 Starter cannot activate automatic email extraction',async()=>{
    await assert.rejects(()=>entitlements.assertCapability(database,scope,'email.auto_extract'),/does not include/i);
  });
  await context.test('2 upgrade Starter to Growth grants email extraction immediately',async()=>{
    await database.query("UPDATE account_subscriptions SET plan_id='growth',updated_at=now() WHERE account_id=$1",[business.accountId]);
    assert.equal((await entitlements.capabilityState(database,scope,'email.auto_extract')).enabled,true);
  });
  await context.test('3 Growth usage counts understandable processing units',async()=>{
    await entitlements.recordUsage(database,scope,{id:newId('usage'),meter:'processing_units',units:7,
      idempotencyKey:'document:one',occurredAt:'2026-09-10T12:00:00Z'});
    assert.equal((await entitlements.meterState(database,scope,'processing_units',{now:'2026-09-15T00:00:00Z'})).used,7);
  });
  await context.test('4 replayed processing does not double count usage',async()=>{
    const replay=await entitlements.recordUsage(database,scope,{id:newId('usage'),meter:'processing_units',units:7,
      idempotencyKey:'document:one',occurredAt:'2026-09-10T12:00:00Z'});
    assert.equal(replay.created,false);assert.equal(replay.state.used,7);
  });
  await context.test('5 usage resets at the next billing period',async()=>{
    await database.query(`UPDATE account_subscriptions SET current_period_start='2026-10-01T00:00:00Z',
      current_period_end='2026-11-01T00:00:00Z' WHERE account_id=$1`,[business.accountId]);
    assert.equal((await entitlements.meterState(database,scope,'processing_units',{now:'2026-10-02T00:00:00Z'})).used,0);
  });
  await context.test('6 included usage never creates implicit overage charges',async()=>{
    await entitlements.recordUsage(database,scope,{id:newId('usage'),meter:'processing_units',units:1001,
      idempotencyKey:'october-batch',occurredAt:'2026-10-03T00:00:00Z'});
    const state=await entitlements.meterState(database,scope,'processing_units',{now:'2026-10-04T00:00:00Z'});
    assert.equal(state.overageUnits,0);assert.equal(state.overageAmountMinor,0);
  });
  await context.test('7 enterprise-style override grants a plan-excluded capability',async()=>{
    await database.query(`INSERT INTO commercial_entitlement_overrides
      (id,account_id,capability,enabled,reason) VALUES($1,$2,'connections.custom_api',1,'Contract test')`,[newId('override'),business.accountId]);
    assert.equal((await entitlements.capabilityState(database,scope,'integrations.custom')).enabled,true);
    await database.query("DELETE FROM commercial_entitlement_overrides WHERE account_id=$1 AND capability='connections.custom_api'",[business.accountId]);
  });
  await context.test('8 downgrade preserves over-limit connection data',async()=>{
    const connectorId=newId('con');await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,provider_type,display_name,provides,config,status,capabilities,
       authorized_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,'custom','Preserved connector','[]','{}','connected','[]',$4,now(),now())`,
    [connectorId,business.workspaceId,`custom:${connectorId}`,business.userId]);
    await database.query("UPDATE account_subscriptions SET plan_id='starter' WHERE account_id=$1",[business.accountId]);
    assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM workspace_connectors WHERE workspace_id=$1',
      [business.workspaceId])).rows[0].count),1);
  });
  await context.test('9 failed billing enters grace without deleting business records',async()=>{
    await database.query("UPDATE account_subscriptions SET stripe_customer_id='cus_acceptance',stripe_subscription_id='sub_price_mapping' WHERE account_id=$1",[business.accountId]);
    await commercial.handleBillingEvent(database,{id:'evt_failed_once',type:'invoice.payment_failed',data:{object:{id:'in_failed',customer:'cus_acceptance',subscription:'sub_price_mapping'}}});
    const subscription=await entitlements.subscriptionFor(database,business.accountId);assert.equal(subscription.status,'GRACE');
    assert.equal((await entitlements.operationalAccess(subscription)).canOperate,true);
    assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM workspaces WHERE id=$1',[business.workspaceId])).rows[0].count),1);
  });
  await context.test('10 cancelled subscription remains active through term end',async()=>{
    await database.query(`UPDATE account_subscriptions SET status='CANCELLED',current_period_end='2099-01-01T00:00:00Z'
      WHERE account_id=$1`,[business.accountId]);
    assert.equal(entitlements.operationalAccess(await entitlements.subscriptionFor(database,business.accountId)).canOperate,true);
  });
  await context.test('11 expired cancelled term is read-only and preserves records',async()=>{
    await database.query(`UPDATE account_subscriptions SET current_period_end='2020-01-01T00:00:00Z' WHERE account_id=$1`,[business.accountId]);
    assert.equal(entitlements.operationalAccess(await entitlements.subscriptionFor(database,business.accountId)).canOperate,false);
    assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM workspaces WHERE id=$1',[business.workspaceId])).rows[0].count),1);
  });
  await context.test('12 a shared workspace uses the owner subscription, not the invited person account',async()=>{
    await subscribe(database,business.accountId,'growth','ACTIVE',{start:'2026-09-01T00:00:00Z',end:'2099-10-01T00:00:00Z'});
    const invitation=await lifecycle.createInvitation(database,{workspaceId:business.workspaceId,actorId:business.userId},
      {name:'Commercial Staff',email:'commercial-staff@example.test',role:'staff'},
      {origin:'https://stockchief.example',includeToken:true});
    await assert.rejects(lifecycle.acceptInvitation(database,invitation.token,{password:'12345677'}),/at least 12 characters/i);
    assert.equal((await lifecycle.inspectInvitation(database,invitation.token)).status,'PENDING');
    const accepted=await lifecycle.acceptInvitation(database,invitation.token,{password:'commercial-staff-password'});
    const scope=commercialScope({account:{id:accepted.accountId},workspace:{owner_account_id:business.accountId},
      ctx:{accountId:accepted.accountId,workspaceId:business.workspaceId}});
    assert.equal(scope.accountId,business.accountId);
    assert.equal((await entitlements.capabilityState(database,scope,'email.auto_extract')).enabled,true);
  });
  await context.test('13 Starter location limit is enforced before mutation',async()=>{
    await subscribe(database,business.accountId,'starter','ACTIVE',{start:'2026-09-01T00:00:00Z',end:'2099-10-01T00:00:00Z'});
    for(let index=1;index<=3;index++)await locations.createLocation(database,{workspaceId:business.workspaceId,actorId:business.userId},
      {name:`Warehouse ${index}`,kind:'warehouse'});
    await assert.rejects(()=>locations.createLocation(database,{workspaceId:business.workspaceId,actorId:business.userId},
      {name:'Warehouse 4',kind:'warehouse'}),/plan limit/i);
    assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM locations WHERE workspace_id=$1',
      [business.workspaceId])).rows[0].count),3);
  });
  await context.test('14 Starter workspace limit is enforced before mutation',async()=>{
    await assert.rejects(()=>auth.createWorkspace(database,business.accountId,{name:'Second inventory'}),/plan limit/i);
    assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM workspaces WHERE owner_account_id=$1',
      [business.accountId])).rows[0].count),1);
  });
  await context.test('15 Starter connection limit is enforced before credentials are created',async()=>{
    await assert.rejects(()=>connections.createFeed(database,{workspaceId:business.workspaceId,actorId:business.userId},
      {displayName:'Plan-excluded custom feed'}),/does not include/);
    await database.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,capability,enabled,reason)
      VALUES($1,$2,'connections.custom_api',1,'Structural capacity certification only')`,[newId('override'),business.accountId]);
    const first=await connections.createFeed(database,{workspaceId:business.workspaceId,actorId:business.userId},
      {displayName:'Second connection'});assert.ok(first.token.startsWith('fnd_live_'));
    await assert.rejects(()=>connections.createFeed(database,{workspaceId:business.workspaceId,actorId:business.userId},
      {displayName:'Third connection'}),/plan limit/i);
    assert.equal(Number((await database.query(`SELECT COUNT(*) AS count FROM workspace_connectors
      WHERE workspace_id=$1 AND status<>'disconnected'`,[business.workspaceId])).rows[0].count),2);
  });
  await context.test('16 Stripe Price ID, not stale metadata, determines the active plan',async()=>{
    await database.query("UPDATE account_subscriptions SET stripe_customer_id='cus_price_mapping' WHERE account_id=$1",[business.accountId]);
    await database.query("UPDATE commercial_plans SET stripe_monthly_price_id='price_growth_live' WHERE id='growth'");
    await commercial.upsertSubscription(database,{id:'sub_price_mapping',customer:'cus_price_mapping',status:'active',
      metadata:{stockchief_account_id:business.accountId,stockchief_plan_id:'starter'},current_period_start:1788220800,
      current_period_end:1790812800,items:{data:[{price:{id:'price_growth_live',recurring:{interval:'month'}}}]}});
    const subscription=await entitlements.subscriptionFor(database,business.accountId);assert.equal(subscription.plan_id,'growth');
    assert.equal(subscription.billing_interval,'MONTHLY');
  });
  await context.test('17 repeated failed-payment events do not extend the original grace deadline',async()=>{
    await commercial.handleBillingEvent(database,{id:'evt_failed_grace_one',type:'invoice.payment_failed',
      data:{object:{id:'in_failed_one',customer:'cus_price_mapping',subscription:'sub_price_mapping'}}});
    const fixed='2026-11-15T12:00:00Z';await database.query('UPDATE account_subscriptions SET grace_ends_at=$2 WHERE account_id=$1',
      [business.accountId,fixed]);
    await commercial.handleBillingEvent(database,{id:'evt_failed_grace_two',type:'invoice.payment_failed',
      data:{object:{id:'in_failed_two',customer:'cus_price_mapping',subscription:'sub_price_mapping'}}});
    assert.equal(new Date((await entitlements.subscriptionFor(database,business.accountId)).grace_ends_at).toISOString(),
      new Date(fixed).toISOString());
  });
  await context.test('18 retired implicit overage delivery cannot charge Stripe',async()=>{
    await database.query(`UPDATE account_subscriptions SET plan_id='growth',status='ACTIVE',
      current_period_start='2026-10-01T00:00:00Z',current_period_end='2026-11-01T00:00:00Z'
      WHERE account_id=$1`,[business.accountId]);const prepared=await commercial.prepareOverageCharges(database,'cus_price_mapping');
    assert.equal(prepared.length,0);let calls=0;
    const provider={createInvoiceItem:async(input)=>{calls+=1;assert.equal(input.amountMinor,7500);return {id:'ii_overage_once'};}};
    assert.equal((await commercial.deliverOverageCharges(database,'cus_price_mapping',provider)).length,0);
    assert.equal((await commercial.deliverOverageCharges(database,'cus_price_mapping',provider)).length,0);assert.equal(calls,0);
    await commercial.handleBillingEvent(database,{id:'evt_overage_paid',type:'invoice.paid',
      data:{object:{id:'in_overage_paid',customer:'cus_price_mapping'}}});
    assert.equal((await database.query('SELECT COUNT(*) AS n FROM commercial_overage_charges')).rows[0].n,'0');
  });
  await context.test('19 proposed packaging cannot open a real checkout',async()=>{
    const account=(await database.query('SELECT id,email FROM accounts WHERE id=$1',[business.accountId])).rows[0];
    await database.query("UPDATE commercial_plans SET packaging_status='PROPOSED',stripe_monthly_price_id='price_starter_test' WHERE id='starter'");
    await assert.rejects(()=>commercial.beginCheckout(database,account,{planId:'starter',interval:'monthly',origin:'https://stockchief.example'}),
      /pending approval of the Commercial Readiness Report/i);
  });
  await context.test('20 an expired grace period is read-only before the cleanup sweep runs',async()=>{
    await database.query(`UPDATE account_subscriptions SET status='GRACE',grace_ends_at='2026-08-31T00:00:00Z'
      WHERE account_id=$1`,[business.accountId]);
    assert.equal(entitlements.operationalAccess(await entitlements.subscriptionFor(database,business.accountId),
      new Date('2026-09-01T00:00:00Z')).canOperate,false);
  });
  await context.test('21 repeated Stripe past-due updates do not push the grace deadline forward',async()=>{
    const fixed='2026-09-07T00:00:00Z';await database.query(`UPDATE account_subscriptions SET status='GRACE',grace_ends_at=$2
      WHERE account_id=$1`,[business.accountId,fixed]);
    const payload={id:'sub_price_mapping',customer:'cus_price_mapping',status:'past_due',
      metadata:{stockchief_account_id:business.accountId,stockchief_plan_id:'growth'},current_period_start:1788220800,
      current_period_end:1790812800,items:{data:[{price:{id:'price_growth_live',recurring:{interval:'month'}}}]}};
    await commercial.upsertSubscription(database,payload);await commercial.upsertSubscription(database,payload);
    assert.equal(new Date((await entitlements.subscriptionFor(database,business.accountId)).grace_ends_at).toISOString(),
      new Date(fixed).toISOString());
  });
  await context.test('22 admin promotion and trial settings reach checkout exactly once',async()=>{
    await database.query(`UPDATE commercial_plans SET packaging_status='APPROVED',stripe_monthly_price_id='price_starter_promo',trial_days=0
      WHERE id='starter'`);await database.query(`INSERT INTO commercial_promo_codes
      (code,plan_id,trial_days,discount_percent,stripe_promotion_code_id,redemption_limit)
      VALUES('LAUNCHDAY','starter',1,20,'promo_launchday',1)`);
    const account=(await database.query('SELECT id,email FROM accounts WHERE id=$1',[business.accountId])).rows[0];let captured=null;
    const provider={createCheckout:async(input)=>{captured=input;return {id:'cs_promo_once',url:'https://checkout.example.test/promo'};}};
    await commercial.beginCheckout(database,account,{planId:'starter',interval:'monthly',promoCode:'launchday',
      origin:'https://stockchief.example'},{provider,testMode:true});assert.equal(captured.trialDays,1);
    assert.equal(captured.promotionCodeId,'promo_launchday');await commercial.completeCheckoutAttempt(database,'cs_promo_once');
    const attempt=(await database.query("SELECT * FROM commercial_checkout_attempts WHERE stripe_checkout_session_id='cs_promo_once'")).rows[0];
    assert.equal(attempt.status,'COMPLETED');assert.equal(attempt.promo_status,'REDEEMED');
    await assert.rejects(()=>commercial.beginCheckout(database,account,{planId:'starter',interval:'monthly',promoCode:'LAUNCHDAY',
      origin:'https://stockchief.example'},{provider,testMode:true}),/exhausted/i);
  });
  await context.test('23 an expired checkout releases its reserved promotion',async()=>{
    await database.query(`INSERT INTO commercial_promo_codes(code,plan_id,trial_days,discount_percent,redemption_limit)
      VALUES('TRYAGAIN','starter',1,0,1)`);const account=(await database.query('SELECT id,email FROM accounts WHERE id=$1',
      [business.accountId])).rows[0];let sequence=0;const provider={createCheckout:async()=>({id:`cs_retry_${++sequence}`,
      url:'https://checkout.example.test/retry'})};
    await commercial.beginCheckout(database,account,{planId:'starter',interval:'monthly',promoCode:'TRYAGAIN',
      origin:'https://stockchief.example'},{provider,testMode:true});await commercial.handleBillingEvent(database,{id:'evt_checkout_expired',
      type:'checkout.session.expired',data:{object:{id:'cs_retry_1'}}});
    const promotion=(await database.query("SELECT * FROM commercial_promo_codes WHERE code='TRYAGAIN'")).rows[0];
    assert.equal(Number(promotion.redeemed_count),0);const retry=await commercial.beginCheckout(database,account,
      {planId:'starter',interval:'monthly',promoCode:'TRYAGAIN',origin:'https://stockchief.example'},{provider,testMode:true});
    assert.equal(retry.sessionId,'cs_retry_2');
  });
  await context.test('24 Starter Ask does not bypass the connected-email entitlement',async()=>{
    await subscribe(database,business.accountId,'starter','ACTIVE',{start:new Date().toISOString(),end:'2099-10-01T00:00:00Z'});
    const result=await assistant.ask(database,{workspaceId:business.workspaceId,actorId:business.userId},
      'Email Acme Supply and say the delivery is approved.');
    assert.equal(result.status,'CLARIFY');assert.match(result.answer,/available on Growth/i);
    assert.match(result.handoff.href,/capability=connection.email/);
  });
  await context.test('25 Growth Ask passes the email entitlement and grounds the recipient',async()=>{
    await database.query("UPDATE account_subscriptions SET plan_id='growth' WHERE account_id=$1",[business.accountId]);
    const result=await assistant.ask(database,{workspaceId:business.workspaceId,actorId:business.userId},
      'Email Acme Supply and say the delivery is approved.');
    assert.equal(result.status,'CLARIFY');assert.doesNotMatch(result.answer,/available on Growth/i);
    assert.match(result.answer,/could not find.*Acme Supply/i);
  });
  await context.test('26 Starter receives a contextual upgrade for period-over-period profit explanation',async()=>{
    await database.query("UPDATE account_subscriptions SET plan_id='starter' WHERE account_id=$1",[business.accountId]);
    const result=await assistant.ask(database,{workspaceId:business.workspaceId,actorId:business.userId},'Why did profit fall?');
    assert.equal(result.status,'CLARIFY');assert.match(result.answer,/available on Growth/i);
    assert.match(result.handoff.href,/accounting.explanations/);
  });
  await context.test('27 Growth profit explanation uses deterministic period evidence',async()=>{
    await database.query("UPDATE account_subscriptions SET plan_id='growth' WHERE account_id=$1",[business.accountId]);
    const result=await assistant.ask(database,{workspaceId:business.workspaceId,actorId:business.userId},'Why did profit fall?');
    assert.equal(result.status,'ANSWERED');assert.match(result.answer,/Net income/i);assert.equal(result.rows.length,4);
    assert.deepEqual(result.columns,['measure','current','previous','profitImpact']);
  });
  await context.test('28 Stripe receives trial and promotion fields without exposing card data to StockChief',async()=>{
    let submitted=null;await stripeBilling.createCheckout({attemptId:'checkout_contract',accountId:business.accountId,
      planId:'growth',email:'commercial@example.test',priceId:'price_growth_contract',trialDays:1,
      promotionCodeId:'promo_growth_contract',successUrl:'https://stockchief.example/complete',
      cancelUrl:'https://stockchief.example/pricing'},{secretKey:'sk_test_contract',fetch:async(url,options)=>{
        submitted=options.body;return new Response(JSON.stringify({id:'cs_contract',url:'https://checkout.stripe.test/session'}),
          {status:200,headers:{'content-type':'application/json'}});}});
    assert.equal(submitted.get('subscription_data[trial_period_days]'),'1');
    assert.equal(submitted.get('discounts[0][promotion_code]'),'promo_growth_contract');
    assert.equal(submitted.get('allow_promotion_codes'),null);assert.equal(submitted.get('card'),null);
    assert.equal(submitted.get('automatic_tax[enabled]'),null,'automatic tax must remain off until the Stripe account is configured');
    await stripeBilling.createCheckout({attemptId:'checkout_tax_contract',accountId:business.accountId,
      planId:'growth',email:'commercial@example.test',priceId:'price_growth_contract',trialDays:0,
      successUrl:'https://stockchief.example/complete',cancelUrl:'https://stockchief.example/pricing'},
    {secretKey:'sk_test_contract',automaticTax:true,fetch:async(url,options)=>{submitted=options.body;
      return new Response(JSON.stringify({id:'cs_tax_contract',url:'https://checkout.stripe.test/session'}),
        {status:200,headers:{'content-type':'application/json'}});}});
    assert.equal(submitted.get('automatic_tax[enabled]'),'true');
  });
  await context.test('29 customer-specific structural limits change the enforced capacity',async()=>{
    await subscribe(database,business.accountId,'starter','ACTIVE',{start:'2026-09-01T00:00:00Z',end:'2099-10-01T00:00:00Z'});
    await database.query(`INSERT INTO commercial_entitlement_overrides
      (id,account_id,meter,limit_units,reason,source) VALUES($1,$2,'locations',5,'Contracted location allowance','TEST')`,
    [newId('override'),business.accountId]);const state=await entitlements.meterState(database,scope,'locations');
    assert.equal(state.hardLimit,5);await locations.createLocation(database,{workspaceId:business.workspaceId,actorId:business.userId},
      {name:'Warehouse 4',kind:'warehouse'});assert.equal((await entitlements.meterState(database,scope,'locations')).used,4);
  });
  await context.test('30 a failed subscription payment durably notifies the owner once',async()=>{
    const idempotencyKey='billing-payment-failed:evt_failed_once';
    const queued=(await database.query(`SELECT * FROM stockchief_runtime.jobs WHERE kind='system.email-send'
      AND idempotency_key=$1`,[idempotencyKey])).rows;assert.equal(queued.length,1);
    const message=systemEmail.unseal(queued[0].payload);assert.equal(message.to,'commercial@example.test');
    assert.match(message.subject,/update your StockChief payment method/i);assert.match(message.text,/remains available until/i);
    await commercial.handleBillingEvent(database,{id:'evt_failed_once',type:'invoice.payment_failed',
      data:{object:{id:'in_failed',customer:'cus_acceptance'}}});
    assert.equal(Number((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.jobs
      WHERE kind='system.email-send' AND idempotency_key=$1`,[idempotencyKey])).rows[0].count),1);
  });
  await context.test('31 an expired grace period suspends operations and durably notifies the owner',async()=>{
    await database.query(`UPDATE account_subscriptions SET status='GRACE',grace_ends_at='2026-08-30T00:00:00Z'
      WHERE account_id=$1`,[business.accountId]);
    await database.transaction((client)=>runtimeHandlers.runtimeSweep({payload:{now:Date.parse('2026-09-01T00:00:00Z')}},client));
    assert.equal((await entitlements.subscriptionFor(database,business.accountId)).status,'SUSPENDED');
    const queued=(await database.query(`SELECT payload FROM stockchief_runtime.jobs WHERE kind='system.email-send'
      AND idempotency_key LIKE 'billing-subscription-suspended:%' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    const message=systemEmail.unseal(queued.payload);assert.equal(message.to,'commercial@example.test');
    assert.match(message.subject,/now read-only/i);assert.match(message.text,/records remain available and unchanged/i);
  });
  await context.test('32 autopilot cannot run after grace expiry before a sweep',async()=>{
    const prior=process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE;process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE='true';
    try{await database.query(`UPDATE account_subscriptions SET status='GRACE',grace_ends_at='2020-01-01T00:00:00Z'
        WHERE account_id=$1`,[business.accountId]);
      const outcome=await database.transaction((client)=>runtimeHandlers.autopilotEvaluate({workspaceId:business.workspaceId,
        payload:{actorId:business.userId}},client));assert.deepEqual(outcome,{skipped:'subscription_read_only'});
    }finally{if(prior===undefined)delete process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE;
      else process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE=prior;}
  });
  await context.test('33 Stripe billing signatures reject tampering and stale delivery',()=>{
    const webhookSecret='whsec_contract';const body=JSON.stringify({id:'evt_signed',type:'invoice.paid',data:{object:{}}});
    const timestamp=Math.floor(Date.now()/1000);const signature=crypto.createHmac('sha256',webhookSecret)
      .update(`${timestamp}.${body}`).digest('hex');
    assert.equal(stripeBilling.verifyEvent(Buffer.from(body),{'stripe-signature':`t=${timestamp},v1=${signature}`},
      {webhookSecret}).id,'evt_signed');
    assert.throws(()=>stripeBilling.verifyEvent(Buffer.from(`${body} `),{'stripe-signature':`t=${timestamp},v1=${signature}`},
      {webhookSecret}),/did not come from Stripe/i);
    const old=timestamp-600;const oldSignature=crypto.createHmac('sha256',webhookSecret).update(`${old}.${body}`).digest('hex');
    assert.throws(()=>stripeBilling.verifyEvent(Buffer.from(body),{'stripe-signature':`t=${old},v1=${oldSignature}`},
      {webhookSecret}),/too old/i);
  });
  await context.test('34 a failed billing-event transaction is visible and recovers on provider retry',async()=>{
    await database.query(`UPDATE account_subscriptions SET status='ACTIVE',stripe_customer_id='cus_retry',grace_ends_at=NULL
      WHERE account_id=$1`,[business.accountId]);const original=commercialNotifications.queuePaymentFailed;
    commercialNotifications.queuePaymentFailed=async()=>{throw new Error('temporary queue outage');};
    const event={id:'evt_retry_after_failure',type:'invoice.payment_failed',data:{object:{id:'in_retry',customer:'cus_retry',subscription:'sub_price_mapping'}}};
    try{await assert.rejects(()=>commercial.handleBillingEvent(database,event),/temporary queue outage/);}
    finally{commercialNotifications.queuePaymentFailed=original;}
    assert.equal((await database.query(`SELECT status FROM commercial_billing_events WHERE provider_event_id=$1`,[event.id])).rows[0].status,'FAILED');
    assert.equal((await entitlements.subscriptionFor(database,business.accountId)).status,'ACTIVE');
    const recovered=await commercial.handleBillingEvent(database,event);assert.equal(recovered.duplicate,false);
    assert.equal((await entitlements.subscriptionFor(database,business.accountId)).status,'GRACE');
    assert.equal((await database.query(`SELECT status FROM commercial_billing_events WHERE provider_event_id=$1`,[event.id])).rows[0].status,'PROCESSED');
    assert.equal((await commercial.handleBillingEvent(database,event)).duplicate,true);
  });
});

test('public, auth and invitation journeys work in desktop and mobile Chromium',{timeout:180000},async(context)=>{
  const cluster=await startCluster();const database=openPostgres(cluster.connectionString,{applicationName:'commercial-browser'});
  await migratePostgres(database);const app=createPostgresApp({database,env:'test',sessionSecret:'commercial-browser-secret',
    assetVersion:'commercial-browser'});const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
  await database.query(`UPDATE commercial_plan_meters SET included_units=CASE plan_id
    WHEN 'starter' THEN 100 WHEN 'growth' THEN 1000 WHEN 'pro' THEN 5000 ELSE included_units END,
    overage_mode='PAUSE' WHERE meter='intelligent_operations' AND plan_id IN ('starter','growth','pro')`);
  const browser=await chromium.launch();context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
    await app.locals.sessionStore.close();await database.close();cluster.stop();});const base=`http://127.0.0.1:${server.address().port}`;
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){const page=await browser.newPage({viewport});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));await page.goto(base);const landing=await page.locator('body').innerText();
    assert.match(landing,/runs the work between the sale and the books/i);assert.match(landing,/routine work you authorize/i);
    assert.equal(await page.locator('[data-flow-node]').count(),6);await page.goto(`${base}/demo`);
    assert.doesNotMatch(landing,/talk to sales|sales team/i);
    assert.equal(await page.locator('[data-story-scene]').count(),5);
    assert.equal(await page.locator('.product-capture img').count(),5);
    await page.locator('[data-story-step="1"]').click();const decision=await page.locator('[data-story-scene="1"]').innerText();
    assert.match(decision,/checks transfer before buy/i);assert.match(decision,/moving three/i);
    assert.match(await page.locator('[data-story-scene="1"] img').getAttribute('src'),/planning\.png$/);
    for(const path of ['/how-stockchief-works','/capabilities','/integrations','/control','/switching']){
      await page.goto(`${base}${path}`);assert.equal(await page.locator('h1').count(),1);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
    }
    await page.goto(`${base}/pricing`);assert.equal(await page.locator('.plan-card').count(),4);
    assert.match(await page.locator('#growth .plan-card__usage').innerText(),/AI Work Credits/i);
    assert.equal(await page.getByText('View usage details',{exact:true}).count(),4);
    assert.doesNotMatch(await page.locator('.plan-ladder').innerText(),/document pages processed/i);
    assert.doesNotMatch(await page.locator('.plan-ladder').innerText(),/\b(?:kits|SSO|EDI)\b|document understanding|AI email drafting/i);
    await page.getByRole('button',{name:/Annual/}).click();
    assert.match(await page.locator('.plan-card').nth(1).innerText(),/billed annually/i);
    assert.match(await page.getByRole('link',{name:'Choose Growth'}).getAttribute('href'),/plan=growth.*interval=annual/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
    await page.goto(`${base}/contact`);assert.match(await page.locator('body').innerText(),/person building the product/i);
    assert.equal(await page.getByText(/Talk to sales/i).count(),0);
    await page.goto(`${base}/register?plan=growth`);assert.match(await page.locator('body').innerText(),/Create your business workspace/i);
    assert.equal(await page.evaluate(()=>window.scrollY),0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
    await page.goto(`${base}/forgot-password`);assert.match(await page.locator('body').innerText(),/Reset your password/i);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);await page.goto(`${base}/login`);
    await page.getByRole('button',{name:'Show'}).click();assert.equal(await page.getByLabel('Password').getAttribute('type'),'text');
    assert.deepEqual(errors,[]);await page.close();}
  const business=await auth.createBusiness(database,{name:'Invite Owner',businessName:'Invite Business',email:'invite-owner@example.test',
    password:'invite-password'});const invitation=await lifecycle.createInvitation(database,{workspaceId:business.workspaceId,actorId:business.userId},
    {name:'New Teammate',email:'new-team@example.test',role:'staff'},{origin:base,includeToken:true});
  const page=await browser.newPage();await page.goto(`${base}/invite?token=${encodeURIComponent(invitation.token)}`);
  assert.match(await page.locator('body').innerText(),/Join Invite Business/i);await page.getByLabel('Create a password').fill('teammate-password');
  await page.getByRole('button',{name:'Accept invitation'}).click();await page.waitForURL((url)=>!url.pathname.startsWith('/invite'));
  assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM users WHERE workspace_id=$1',[business.workspaceId])).rows[0].count),2);
  const reusedInvitation=await page.goto(`${base}/invite?token=${encodeURIComponent(invitation.token)}`);
  assert.equal(reusedInvitation.status(),400);assert.match(await page.locator('body').innerText(),/no longer available/i);
  const expiredInvitation=await lifecycle.createInvitation(database,{workspaceId:business.workspaceId,actorId:business.userId},
    {name:'Expired Teammate',email:'expired-team@example.test',role:'staff'},{origin:base,includeToken:true});
  await database.query("UPDATE workspace_invitations SET expires_at=now()-interval '1 minute' WHERE id=$1",[expiredInvitation.id]);
  const expiredResponse=await page.goto(`${base}/invite?token=${encodeURIComponent(expiredInvitation.token)}`);
  assert.equal(expiredResponse.status(),400);assert.match(await page.locator('body').innerText(),/expired/i);
  const gated=await auth.createBusiness(database,{name:'Starter Owner',businessName:'Starter Business',
    email:'starter-owner@example.test',password:'starter-password'});await subscribe(database,gated.accountId,'starter');
  const gatedContext=await browser.newContext();const gatedPage=await gatedContext.newPage();
  await gatedPage.goto(`${base}/login?next=${encodeURIComponent('//attacker.example/steal-session')}`);
  await gatedPage.getByLabel('Email').fill('starter-owner@example.test');await gatedPage.getByLabel('Password').fill('starter-password');
  await Promise.all([gatedPage.waitForURL(`${base}/`),gatedPage.getByRole('button',{name:'Sign in'}).click()]);
  await gatedPage.goto(`${base}/register?plan=pro`);await gatedPage.waitForURL(`${base}/settings`);
  // Redirect identity and durable account state are the security contract;
  // the transient informational flash may already have been dismissed.
  assert.match(await gatedPage.locator('body').innerText(),/starter-owner@example\.test/i);
  assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM accounts WHERE email=$1',
    ['starter-owner@example.test'])).rows[0].count),1);
  await gatedPage.goto(`${base}/settings/connections`);assert.match(await gatedPage.locator('body').innerText(),/Available on Growth/i);
  assert.ok(await gatedPage.getByRole('link',{name:'See Growth'}).count()>0);
  await gatedPage.goto(`${base}/planning`);assert.match(gatedPage.url(),/\/upgrade\?capability=forecasting.basic/);
  await database.query("UPDATE account_subscriptions SET plan_id='growth' WHERE account_id=$1",[gated.accountId]);
  await gatedPage.goto(`${base}/planning`);assert.match(await gatedPage.locator('body').innerText(),/What happens next/i);
  await gatedPage.goto(`${base}/settings`);const csrfToken=await gatedPage.locator('input[name="_csrf"]').first().inputValue();
  const originalName=(await database.query('SELECT name FROM workspaces WHERE id=$1',[gated.workspaceId])).rows[0].name;
  await database.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,capability,enabled,reason)
    VALUES($1,$2,'api.public',1,'Suspension bypass certification')`,[newId('override'),gated.accountId]);
  const apiClient=await publicApi.create(database,{workspaceId:gated.workspaceId,actorId:gated.userId},
    {name:'Suspension bypass test',scopes:['inventory:write']});
  await database.query("UPDATE account_subscriptions SET status='SUSPENDED' WHERE account_id=$1",[gated.accountId]);
  const blockedBrowserWrite=await gatedContext.request.post(`${base}/settings/workspace`,{
    form:{_csrf:csrfToken,name:'Should not be saved'},maxRedirects:0});
  assert.equal(blockedBrowserWrite.status(),303);assert.equal((await database.query('SELECT name FROM workspaces WHERE id=$1',
    [gated.workspaceId])).rows[0].name,originalName);
  const blockedApiWrite=await gatedContext.request.post(`${base}/api/v1/public/commands/inventory/receive`,{
    headers:{Authorization:`Bearer ${apiClient.token}`,'Idempotency-Key':'suspended-write'},data:{}});
  assert.equal(blockedApiWrite.status(),402);assert.match((await blockedApiWrite.json()).error.message,/read-only/i);
  await database.query("UPDATE account_subscriptions SET status='ACTIVE' WHERE account_id=$1",[gated.accountId]);
  await database.query(`INSERT INTO commercial_admin_accounts(account_id,granted_by) VALUES($1,'browser-test')`,[gated.accountId]);
  await gatedPage.setViewportSize({width:390,height:844});await gatedPage.goto(`${base}/billing`);
  const billingText=await gatedPage.locator('body').innerText();assert.match(billingText,/Plan & Usage/i);
  assert.doesNotMatch(billingText,/Cancellation is scheduled/i);
  assert.equal(await gatedPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
  await gatedPage.goto(`${base}/upgrade?capability=connection.email&return=/billing`);await gatedPage.waitForURL(`${base}/billing`);
  assert.match(await gatedPage.locator('body').innerText(),/already active on your current plan/i);
  await gatedPage.goto(`${base}/upgrade?capability=authority.advanced`);const upgradeText=await gatedPage.locator('body').innerText();
  assert.match(upgradeText,/advanced authority/i);assert.match(upgradeText,/Upgrade to Pro/i);
  assert.equal(await gatedPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
  await gatedPage.setViewportSize({width:1440,height:900});await gatedPage.goto(`${base}/commercial-admin#starter`);
  const starterForm=gatedPage.locator('section#starter form[action="/commercial-admin/plans/starter"]');
  await starterForm.locator('input[name="monthlyAmount"]').fill('249');
  await Promise.all([gatedPage.waitForURL(/\/commercial-admin#starter$/),starterForm.getByRole('button',{name:'Save Starter'}).click()]);
  assert.equal(Number((await database.query("SELECT monthly_amount_minor FROM commercial_plans WHERE id='starter'")).rows[0].monthly_amount_minor),24900);
  await gatedPage.goto(`${base}/billing`);await gatedPage.getByRole('button',{name:'Sign out all devices'}).click();
  const confirmation=gatedPage.locator('dialog[open]');await confirmation.waitFor();
  await Promise.all([gatedPage.waitForURL(/\/login$/),confirmation.getByRole('button',{name:'Sign out all devices'}).click()]);
  assert.equal(Number((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.sessions
    WHERE data->>'accountId'=$1`,[gated.accountId])).rows[0].count),0);
  await gatedPage.getByLabel('Email').fill('starter-owner@example.test');await gatedPage.getByLabel('Password').fill('starter-password');
  await Promise.all([gatedPage.waitForURL(`${base}/`),gatedPage.getByRole('button',{name:'Sign in'}).click()]);
  await database.query(`UPDATE stockchief_runtime.sessions SET expires_at=$2 WHERE data->>'accountId'=$1`,[gated.accountId,Date.now()-1000]);
  await gatedPage.goto(`${base}/billing`);assert.match(gatedPage.url(),/\/login\?next=%2Fbilling$/);
  await gatedContext.close();
});

test('paid-workspace signup verifies email before checkout and never provisions an unpaid workspace',
  {timeout:180000,concurrency:false},async(context)=>{
    const prior=process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE;process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE='true';
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString,{applicationName:'commercial-auth'});
    await migratePostgres(database);await database.query(`UPDATE commercial_plans SET stripe_annual_price_id='price_pro_annual_test',
      packaging_status='APPROVED'
      WHERE id='pro'`);let checkoutInput=null;const billingProvider={
      createCheckout:async(input)=>{checkoutInput=input;
        await commercial.handleBillingEvent(database,{id:'evt_contract_fixture',type:'customer.subscription.created',created:Math.floor(Date.now()/1000),
          data:{object:{id:'sub_contract_test',customer:'cus_contract_test',status:'active',
            current_period_start:Math.floor(Date.now()/1000),current_period_end:Math.floor(Date.now()/1000)+365*86400,
            metadata:{stockchief_account_id:input.accountId},items:{data:[{price:{id:'price_pro_annual_test',recurring:{interval:'year'}}}]}}}});
        return {id:'cs_contract_test',url:input.successUrl.replace('{CHECKOUT_SESSION_ID}','cs_contract_test')};},
      retrieveCheckout:async()=>({id:'cs_contract_test',status:'complete',payment_status:'paid',
        metadata:{stockchief_account_id:checkoutInput.accountId,stockchief_plan_id:checkoutInput.planId},subscription:{
          id:'sub_contract_test',customer:'cus_contract_test',status:'active',current_period_start:1788220800,current_period_end:1790812800,
          metadata:{stockchief_account_id:checkoutInput.accountId,stockchief_plan_id:checkoutInput.planId},
          items:{data:[{price:{id:'price_pro_annual_test',recurring:{interval:'year'}}}]}}}),
      listInvoices:async()=>({data:[]}),createPortal:async()=>({url:'https://billing.example.test/portal'}),
    };const app=createPostgresApp({database,env:'test',sessionSecret:'commercial-auth-secret',
      commercialOptions:{billingProvider,testMode:true,loadInvoices:false,publicOrigin:'request'}});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();context.after(async()=>{if(prior===undefined)delete process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE;
      else process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE=prior;await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});const base=`http://127.0.0.1:${server.address().port}`;
    const page=await browser.newPage();await page.goto(`${base}/login`);
    assert.equal(await page.getByRole('link',{name:'Create account'}).getAttribute('href'),'/register');
    await page.goto(`${base}/register`);assert.match(await page.locator('body').innerText(),/NO PLAN SELECTED/i);
    assert.equal(await page.locator('input[name="planId"]').inputValue(),'');
    const unselectedContext=await browser.newContext();const unselected=await unselectedContext.newPage();
    await unselected.goto(`${base}/register`);await unselected.getByLabel('Business name').fill('No Plan Business');
    await unselected.getByLabel('Your name').fill('No Plan Owner');await unselected.getByLabel('Work email').fill('no-plan-owner@example.test');
    await unselected.getByLabel('Password').fill('No-plan-password!');
    await Promise.all([unselected.waitForURL(`${base}/verify-email/pending`),unselected.getByRole('button',{name:'Create account'}).click()]);
    const unselectedAccount=(await database.query('SELECT pending_commercial_plan_id FROM accounts WHERE email=$1',
      ['no-plan-owner@example.test'])).rows[0];assert.equal(unselectedAccount.pending_commercial_plan_id,null);
    await unselectedContext.close();
    await page.goto(`${base}/register?plan=pro&interval=annual`);
    assert.equal(await page.locator('input[name="planId"]').inputValue(),'pro');assert.match(await page.locator('aside').innerText(),/YOUR SELECTION[\s\S]*Pro/i);
    await page.getByLabel('Business name').fill('Paid Workspace');await page.getByLabel('Your name').fill('Paid Owner');
    await page.getByLabel('Work email').fill('paid-owner@example.test');await page.getByLabel('Password').fill('paid-owner-password');
    await Promise.all([page.waitForURL(`${base}/verify-email/pending`),page.getByRole('button',{name:'Create account'}).click()]);
    const account=(await database.query('SELECT * FROM accounts WHERE email=$1',['paid-owner@example.test'])).rows[0];
    assert.equal(account.email_verified_at,null);assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM workspaces WHERE owner_account_id=$1',
      [account.id])).rows[0].count),0);
    const queued=(await database.query(`SELECT payload FROM stockchief_runtime.jobs WHERE kind='system.email-send'
      ORDER BY created_at DESC LIMIT 1`)).rows[0];const message=systemEmail.unseal(queued.payload);
    const token=new URL(message.text.match(/https:\/\/\S+/)[0]).searchParams.get('token');assert.ok(token);
    const beforeVerify=await browser.newPage();await beforeVerify.goto(`${base}/login`);await beforeVerify.getByLabel('Email').fill(account.email);
    await beforeVerify.getByLabel('Password').fill('paid-owner-password');await beforeVerify.getByLabel(/signed in for 30 days/i).check();
    await Promise.all([beforeVerify.waitForURL(`${base}/verify-email/pending`),beforeVerify.getByRole('button',{name:'Sign in'}).click()]);
    const remembered=(await beforeVerify.context().cookies(base)).find((cookie)=>cookie.name==='foundry.sid');assert.ok(remembered.expires>Date.now()/1000+20*86400);
    await page.goto(`${base}/verify-email?token=${encodeURIComponent(token)}`);assert.match(await page.locator('body').innerText(),/Verify your email/i);
    assert.equal((await database.query('SELECT email_verified_at FROM accounts WHERE id=$1',[account.id])).rows[0].email_verified_at,null,
      'Opening or scanning the link must not consume it');
    const scanner=await browser.newPage();await scanner.goto(`${base}/verify-email?token=${encodeURIComponent(token)}`);
    assert.match(await scanner.locator('body').innerText(),/Verify and continue/i);await scanner.close();
    await page.getByRole('button',{name:'Verify and continue'}).click();assert.match(await page.locator('body').innerText(),/Choose your plan/i);
    assert.equal(await page.getByLabel('Plan').inputValue(),'');assert.ok((await database.query('SELECT email_verified_at FROM accounts WHERE id=$1',
      [account.id])).rows[0].email_verified_at);
    await beforeVerify.reload();await beforeVerify.waitForURL(`${base}/complete-signup`);
    assert.match(await beforeVerify.locator('body').innerText(),/Choose your plan/i);assert.equal(await beforeVerify.getByLabel('Plan').inputValue(),'');await beforeVerify.close();
    const returningContext=await browser.newContext();const returning=await returningContext.newPage();await returning.goto(`${base}/login`);
    await returning.getByLabel('Email').fill(account.email);await returning.getByLabel('Password').fill('paid-owner-password');
    await Promise.all([returning.waitForURL(`${base}/complete-signup`),returning.getByRole('button',{name:'Sign in'}).click()]);
    assert.match(await returning.locator('body').innerText(),/Choose your plan/i);assert.equal(await returning.getByLabel('Plan').inputValue(),'');await returningContext.close();
    await page.getByLabel('Plan').selectOption('pro');await page.getByLabel('Billing').selectOption('annual');
    await commercial.trackOnce(database,{eventName:'subscription_activated',accountId:account.id,planId:'pro',sourcePath:'stripe_webhook'});
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:/Continue to secure checkout/i}).click()]);
    assert.equal(checkoutInput.planId,'pro');assert.equal(checkoutInput.priceId,'price_pro_annual_test');
    const activated=await entitlements.subscriptionFor(database,account.id);assert.equal(activated.status,'ACTIVE');
    assert.equal(activated.plan_id,'pro');assert.equal(activated.billing_interval,'ANNUAL');
    assert.equal(Number((await database.query(`SELECT COUNT(*) AS count FROM commercial_funnel_events
      WHERE account_id=$1 AND event_name='subscription_activated'`,[account.id])).rows[0].count),1);
    assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM workspaces WHERE owner_account_id=$1',
      [account.id])).rows[0].count),1);
    const replay=await page.goto(`${base}/verify-email?token=${encodeURIComponent(token)}`);assert.equal(replay.status(),400);
    assert.match(await page.locator('body').innerText(),/invalid or has expired/i);
    assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM workspaces WHERE owner_account_id=$1',
      [account.id])).rows[0].count),1);
  });

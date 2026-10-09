'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');const auth=require('../../src/domain/postgres-auth-service');
const addons=require('../../src/commercial/addons');const usage=require('../../src/commercial/entitlements');
const model=require('../../src/commercial/model');const budget=require('../../src/commercial/model-cost-budget');
const {newId}=require('../../src/lib/util');
const MODEL='claude-haiku-4-5-20251001';
test('candidate AI pack funds a bounded, grant-linked provider budget, including failures and funding reversals',{timeout:120000},async t=>{
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 const candidate=(await db.query(`SELECT p.id,p.monthly_amount_minor,
  (SELECT included_units FROM commercial_plan_meters WHERE plan_id=p.id AND meter='ai_work_credits') AS ai,
  (SELECT included_units FROM commercial_plan_meters WHERE plan_id=p.id AND meter='connected_operations') AS connected,
  v.status AS version_status FROM commercial_plans p JOIN commercial_plan_versions v
  ON v.id='launch-candidate-2026-10:'||p.id WHERE p.id IN ('starter','growth','pro') ORDER BY p.display_order`)).rows;
 assert.deepEqual(candidate.map(row=>[row.id,Number(row.monthly_amount_minor),Number(row.ai),Number(row.connected),row.version_status]),
  [['starter',19900,650,2000,'ACTIVE'],['growth',49900,2500,20000,'ACTIVE'],['pro',99900,8500,70000,'ACTIVE']]);
 assert.deepEqual((await db.query("SELECT operation,units FROM commercial_operation_policies WHERE operation IN ('ask','instruction','import_mapping') ORDER BY operation")).rows
  .map(row=>[row.operation,Number(row.units)]),[['ask',1],['import_mapping',5],['instruction',7]]);
 assert.equal((await db.query('SELECT checkout_enabled FROM commercial_release_control WHERE singleton=true')).rows[0].checkout_enabled,false);
 const owner=await auth.createBusiness(db,{name:'Paid Budget',businessName:'Paid Budget',
  email:'paid-budget@example.test',password:'Paid-budget-password!'});
 const scope={accountId:owner.accountId,workspaceId:owner.workspaceId};
 await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,
  stripe_customer_id,stripe_subscription_id,current_period_start,current_period_end,source)
  VALUES($1,$2,'starter','launch-candidate-2026-10:starter','ACTIVE','MONTHLY','cus_paid_budget',
   'sub_paid_budget',now()-interval '1 day',now()+interval '29 days','TEST')`,[newId('sub'),owner.accountId]);
 assert.equal((await usage.meterState(db,scope,'ai_work_credits')).included,650);
 await db.query("UPDATE commercial_usage_packs SET stripe_price_id='price_ai_500_test' WHERE id='ai-500-v2'");
 const provider={createAddonCheckout:async input=>({id:`cs_${input.purchaseId}`,url:'https://stripe.test/checkout'})};
 const options={provider,testMode:true};
 const pack=(await db.query("SELECT * FROM commercial_usage_packs WHERE id='ai-500-v2'")).rows[0];
 await db.query("UPDATE commercial_usage_packs SET provider_cost_budget_minor=100 WHERE id='ai-500-v2'");
 await assert.rejects(()=>addons.beginPurchase(db,scope,{packId:'ai-500-v2',idempotencyKey:'unsafe',origin:'http://local'},options),/not economically funded/);
 await db.query('UPDATE commercial_usage_packs SET provider_cost_budget_minor=$2 WHERE id=$1',['ai-500-v2',pack.provider_cost_budget_minor]);
 await db.query(`INSERT INTO commercial_cost_rates(id,provider,operation,unit,cost_per_unit_minor,currency,effective_from,
  source,model,provider_version,pricing_basis,confidence)
  SELECT 'test-higher-rate',provider,operation,unit,cost_per_unit_minor*2,currency,now(),
  'Disposable regression price shock',model,provider_version,'VERIFIED_PUBLIC','HIGH'
  FROM commercial_cost_rates WHERE provider='anthropic' AND model=$1 AND operation='model_input' LIMIT 1`,[MODEL]);
 await assert.rejects(()=>addons.beginPurchase(db,scope,{packId:'ai-500-v2',idempotencyKey:'repriced',origin:'http://local'},options),/unsafe under the current provider rate/);
 await db.query("DELETE FROM commercial_cost_rates WHERE id='test-higher-rate'");
 const previousModel=process.env.FOUNDRY_AI_MODEL_FAST;process.env.FOUNDRY_AI_MODEL_FAST='unapproved-new-model';
 await assert.rejects(()=>addons.beginPurchase(db,scope,{packId:'ai-500-v2',idempotencyKey:'new-model',origin:'http://local'},options),/no approved budget/);
 if(previousModel===undefined)delete process.env.FOUNDRY_AI_MODEL_FAST;else process.env.FOUNDRY_AI_MODEL_FAST=previousModel;
 await assert.rejects(()=>addons.beginPurchase(db,scope,{packId:'ai-500-v2',idempotencyKey:'mispriced',origin:'http://local'},
  {testMode:true,provider:{retrievePrice:async()=>({id:'price_ai_500_test',active:true,currency:'usd',
   unit_amount:100,type:'one_time',recurring:null}),createAddonCheckout:async()=>{throw Error('Checkout must not be created');}}}),
 /Stripe price does not match/);
 const purchase=(await addons.beginPurchase(db,scope,{packId:'ai-500-v2',idempotencyKey:'safe',origin:'http://local'},options)).purchase;
 assert.equal(Number(purchase.provider_cost_budget_minor),1470);
 await db.query("UPDATE commercial_usage_packs SET provider_cost_budget_minor=1200 WHERE id='ai-500-v2'");
 assert.equal((await usage.meterState(db,scope,'ai_work_credits')).purchasedRemaining,0);
 const paid={type:'checkout.session.completed',created:Math.floor(Date.now()/1000),data:{object:{
  id:`cs_${purchase.id}`,customer:'cus_paid_budget',payment_status:'paid',amount_subtotal:4900,currency:'usd',
  payment_intent:`pi_${purchase.id}`,metadata:{stockchief_purchase_id:purchase.id,stockchief_account_id:owner.accountId}}}};
 await db.transaction(client=>addons.receivePayment(client,paid));
 await db.transaction(client=>addons.receivePayment(client,paid));
 assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM commercial_model_grant_budgets WHERE purchase_id=$1',[purchase.id])).rows[0].n),1);
 assert.equal(Number((await db.query('SELECT budget_minor FROM commercial_model_grant_budgets WHERE purchase_id=$1',[purchase.id])).rows[0].budget_minor),1470);
 await usage.recordUsage(db,scope,{meter:'ai_work_credits',units:650,idempotencyKey:'included-consumed'});
 const request={system:'Answer inventory.',prompt:'How much stock?',schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false}};
 await usage.reserveUsage(db,scope,{meter:'ai_work_credits',units:7,idempotencyKey:'policy-funded'});
 await budget.reserve(db,scope,{name:'anthropic',model:'claude-sonnet-5'},request,model.POLICIES.instruction,
  'instruction','policy-funded');
 assert.equal((await db.query("SELECT count(*) AS n FROM commercial_critical_warnings WHERE code='PAID_AI_MODEL_CHANGED'")).rows[0].n,'0');
 await budget.release(db,scope,'policy-funded');
 await usage.reverseUsage(db,scope,{meter:'ai_work_credits',idempotencyKey:'policy-funded'});
 const providerUsage={provider:'anthropic',providerVersion:'2023-06-01',model:MODEL,inputTokens:100,outputTokens:50};
 let calls=0;const ai={name:'anthropic',model:MODEL,complete:async()=>{calls++;return {data:{answer:'100'},usage:providerUsage};}};
 const prior=process.env.STOCKCHIEF_AI_PERIOD_COST_CAP_USD_STARTER;
 process.env.STOCKCHIEF_AI_PERIOD_COST_CAP_USD_STARTER='.0001';
 t.after(()=>{if(prior===undefined)delete process.env.STOCKCHIEF_AI_PERIOD_COST_CAP_USD_STARTER;
  else process.env.STOCKCHIEF_AI_PERIOD_COST_CAP_USD_STARTER=prior;});
 await model.wrap(db,scope,ai,'ask','paid-success').complete(request);
 assert.equal(calls,1);
 const funded=(await db.query(`SELECT a.source,a.grant_id,a.actual_minor FROM commercial_model_cost_hold_allocations a
  JOIN commercial_model_cost_holds h ON h.id=a.hold_id WHERE h.idempotency_key=$1`,[`${scope.workspaceId}:paid-success`])).rows;
 assert.equal(funded.length,1);assert.equal(funded[0].source,'PURCHASED');assert.ok(Number(funded[0].actual_minor)>0);
 await model.wrap(db,scope,ai,'ask','paid-internal',
  {chargeCustomer:false,fundingKey:'paid-success'}).complete(request);
 assert.equal(calls,2);
 const internal=(await db.query(`SELECT a.source,a.grant_id,a.actual_minor FROM commercial_model_cost_hold_allocations a
  JOIN commercial_model_cost_holds h ON h.id=a.hold_id WHERE h.idempotency_key=$1`,
 [`${scope.workspaceId}:paid-internal`])).rows;
 assert.deepEqual(internal.map(row=>[row.source,row.grant_id]),[['PURCHASED',funded[0].grant_id]]);
 assert.ok(Number(internal[0].actual_minor)>0);
 assert.equal((await db.query(`SELECT COUNT(*)::int AS count FROM commercial_usage_events WHERE account_id=$1
  AND idempotency_key IN ($2,$3)`,[scope.accountId,`${scope.workspaceId}:paid-success`,
    `${scope.workspaceId}:paid-internal`])).rows[0].count,1,
 'A multi-call Ask request consumes one customer credit but records both provider costs.');
 const failedAi={...ai,complete:async()=>{calls++;throw Object.assign(Error('Provider failed'),{usage:providerUsage});}};
 await assert.rejects(()=>model.wrap(db,scope,failedAi,'ask','paid-failure').complete(request),/Provider failed/);
 assert.equal((await db.query('SELECT status FROM commercial_usage_events WHERE idempotency_key=$1',
  [`${scope.workspaceId}:paid-failure`])).rows[0].status,'REVERSED');
 assert.ok(Number((await db.query(`SELECT a.actual_minor FROM commercial_model_cost_hold_allocations a
  JOIN commercial_model_cost_holds h ON h.id=a.hold_id WHERE h.idempotency_key=$1`,
  [`${scope.workspaceId}:paid-failure`])).rows[0].actual_minor)>0);
 const invalidInstruction={...ai,complete:async()=>({data:{understood:false,changes:[],
  clarifyingQuestion:'Should I return an empty changes array?',unsupportedReason:''},usage:providerUsage})};
 await assert.rejects(()=>model.wrap(db,scope,invalidInstruction,'instruction','invalid-instruction')
   .complete({system:'Prepare a rule.',prompt:'Set reorder point to eight.',
     schemaName:'postgres_operating_instruction',schema:{type:'object',additionalProperties:false,
       required:['understood','changes','clarifyingQuestion','unsupportedReason'],properties:{
         understood:{type:'boolean'},changes:{type:'array',items:{type:'object'}},
         clarifyingQuestion:{type:'string'},unsupportedReason:{type:'string'}}}}),
 /did not produce a usable operating instruction/);
 assert.equal((await db.query('SELECT status FROM commercial_usage_events WHERE idempotency_key=$1',
   [`${scope.workspaceId}:invalid-instruction`])).rows[0].status,'REVERSED');
 assert.equal((await db.query(`SELECT detail->>'failed' AS failed FROM commercial_cost_events
   WHERE idempotency_key=$1 AND operation='model_input'`,
 [`${scope.workspaceId}:invalid-instruction:model_input`])).rows[0].failed,'true');
 const refund={id:'evt_refund_paid_budget',type:'refund.created',created:Math.floor(Date.now()/1000)+1,data:{object:{id:'re_paid_budget',
  status:'succeeded',payment_intent:`pi_${purchase.id}`,amount:4410,currency:'usd'}}};
 await db.transaction(client=>addons.receiveRefund(client,refund));
 await db.transaction(client=>addons.receiveRefund(client,refund));
 const grant=(await db.query('SELECT * FROM commercial_usage_grants WHERE purchase_id=$1',[purchase.id])).rows[0];
 assert.equal(Number(grant.revoked_units),450);
 const effective=Number((await db.query('SELECT budget_minor FROM commercial_model_grant_budgets WHERE grant_id=$1',[grant.id])).rows[0].budget_minor)*.1;
 assert.equal(effective,147);
 let accepted=0;for(let i=0;i<40;i++){
  const key=`paid-bound-${i}`;
  await usage.reserveUsage(db,scope,{meter:'ai_work_credits',units:1,idempotencyKey:key});
  try{await budget.reserve(db,scope,ai,{...request,prompt:'X'.repeat(15000)},model.POLICIES.ask,'ask',key);accepted++;}
  catch(error){await usage.reverseUsage(db,scope,{meter:'ai_work_credits',idempotencyKey:key});
   assert.match(error.message,/provider-cost safety budget/);break;}
 }
 assert.ok(accepted>0&&accepted<40,'funded holds must exhaust before unlimited provider attempts');
 const exposure=Number((await db.query(`SELECT COALESCE(SUM(a.maximum_minor),0) AS amount
  FROM commercial_model_cost_hold_allocations a JOIN commercial_model_cost_holds h ON h.id=a.hold_id
  WHERE a.grant_id=$1 AND h.status IN ('RESERVED','UNKNOWN')`,[grant.id])).rows[0].amount);
 assert.ok(exposure<=effective+1e-6);
 const dispute={id:'evt_dispute_paid_budget',type:'charge.dispute.created',created:Math.floor(Date.now()/1000)+2,data:{object:{
  id:'dp_paid_budget',payment_intent:`pi_${purchase.id}`,amount:490,currency:'usd',status:'needs_response'}}};
 await db.transaction(client=>addons.receiveDispute(client,dispute));
 assert.equal(Number((await db.query('SELECT dispute_hold_units FROM commercial_usage_grants WHERE id=$1',[grant.id])).rows[0].dispute_hold_units),50);
 await assert.rejects(()=>usage.reserveUsage(db,scope,{meter:'ai_work_credits',units:1,idempotencyKey:'disputed'}),/limit/);
 assert.equal(calls,3);
});

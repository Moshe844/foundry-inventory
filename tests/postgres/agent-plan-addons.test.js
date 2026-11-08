'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {startCluster}=require('../helpers/postgres-cluster');
const addons=require('../../src/commercial/capacity-addons'),ent=require('../../src/commercial/entitlements');
const policy=require('../../src/commercial/agent-plan');

test('approved monthly offers have plan-specific checkout, verified paid grants and retry-safe renewal', {timeout:180000},async t=>{
  const cluster=await startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
  t.after(async()=>{await db.close();await cluster.stop();});
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Monthly grants',email:randomUUID()+'@example.test',password:'Demo!'+randomUUID()});
  const scope={accountId:owner.accountId,workspaceId:owner.workspaceId},customer='cus_fixture';
  async function plan(id){await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,stripe_customer_id)
    VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE'),'ACTIVE',$4)
    ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id`,[randomUUID(),scope.accountId,id,customer]);}
  const current=Math.floor(Date.now()/1000),catalog=await addons.catalog(db,{agentOffer:true});
  assert.equal(catalog.length,4);
  const terms=(await db.query("SELECT * FROM commercial_plan_versions WHERE id LIKE 'agent-v3:%'")).rows;
  assert.equal(terms.length,3);
  for(const v of terms) assert.equal(Number(v.annual_amount_minor),10*Number(v.monthly_amount_minor));
  const products=new Map(catalog.map(p=>[p.id,p])),options={testMode:true,provider:{
    retrievePrice:async id=>({id,active:true,type:'recurring',currency:'usd',unit_amount:Number(products.get(id).monthly_amount_minor),recurring:{interval:'month'}}),
    createCapacityCheckout:async input=>({id:'cs_'+input.orderId,url:'https://billing.example.test/fixture'})}};
  for(const p of catalog) await db.query('UPDATE commercial_capacity_products SET stripe_price_id=id WHERE id=$1',[p.id]);
  function input(productId){return {productId,origin:'https://fixture.example.test',quantity:1,idempotencyKey:randomUUID()};}
  async function buy(productId,amount){
    const {order}=await addons.begin(db,scope,input(productId),options);
    assert.equal(Number(order.amount_minor),amount);
    const sub='sub_'+order.id;
    const send=(type,obj)=>db.transaction(client=>addons.receive(client,{id:'evt_'+randomUUID(),created:current,type,data:{object:obj}}));
    await send('checkout.session.completed',{id:'cs_'+order.id,mode:'subscription',customer,subscription:sub,metadata:{stockchief_capacity_order_id:order.id,stockchief_account_id:scope.accountId}});
    const invoice={id:'in_'+order.id,status:'paid',currency:'usd',total:amount,customer,subscription:sub,
      lines:{has_more:false,data:[{quantity:1,price:{id:productId},period:{start:current-5,end:current+86400}}]}};
    await assert.rejects(send('invoice.paid',{...invoice,total:amount-1}),/differs/);
    await send('invoice.paid',invoice);await send('invoice.paid',invoice);
    return order;
  }
  await plan('starter');
  assert.equal((await ent.meterState(db,scope,'ai_work_credits')).included,5000);
  await assert.rejects(addons.begin(db,scope,input('agent-pro-edi'),options),/current plan/);
  await assert.rejects(addons.begin(db,scope,input('agent-monthly-credits'),options),/actual usage costs/);
  // Synthetic reconciliation for exercising checkout and grants. No real customer usage.
  const review={providerInvoiceReference:'test-provider-invoice',usageLedgerReference:'test-usage-ledger',measuredCredits:5000,providerCostMinor:7500};
  const reviewCost=()=>db.query("UPDATE commercial_capacity_products SET ai_usage_review=$1 WHERE id='agent-monthly-credits'",[review]);
  await reviewCost();
  await assert.rejects(addons.begin(db,scope,input('agent-monthly-credits'),options),/funding margin/);
  review.providerCostMinor=2200;
  await reviewCost();
  const ceilings={model_input:0.003,cache_write_1h:0.004,model_output:0.01};
  for(const [op,rate] of Object.entries(ceilings)) await db.query(`INSERT INTO commercial_cost_rates
    (id,provider,model,provider_version,operation,unit,cost_per_unit_minor,currency,effective_from,source,pricing_basis,confidence)
    VALUES($1,'openai','fixture','fixture-version',$2,'token',$3,'USD',now(),'SYNTHETIC RATE ONLY','VERIFIED_PUBLIC','HIGH')`,[randomUUID(),op,rate]);
  await db.query("UPDATE commercial_usage_packs SET approved_model_rate_ceiling=approved_model_rate_ceiling||$1::jsonb WHERE id='ai-2500-v4'",[JSON.stringify({'openai/fixture/fixture-version':ceilings})]);
  await buy('agent-monthly-credits',4900);
  const budgets=await db.query('SELECT * FROM commercial_model_grant_budgets WHERE account_id=$1',[scope.accountId]);
  assert.equal(budgets.rowCount,1);
  assert.equal(Number(budgets.rows[0].budget_minor),2940);
  assert.equal((await ent.meterState(db,scope,'ai_work_credits')).purchasedRemaining,5000);
  await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'ai_work_credits',0,'Exercise purchased credits')",[randomUUID(),scope.accountId]);
  const fixture=require('../helpers/postgres-model-fixture');
  const model=require('../../src/commercial/model').wrap(db,{...scope,actorId:owner.userId},{
    name:'anthropic',model:fixture.PRICED_MODEL,complete:async()=>({data:{ok:true},usage:fixture.pricedUsage()})
  },'ask','paid-question');
  await model.complete({schemaName:'fixture',schema:{type:'object'},system:'Read only',prompt:'Count?',maxOutputTokens:64});
  const allocations=await db.query("SELECT a.source,a.actual_minor FROM commercial_model_cost_hold_allocations a JOIN commercial_model_cost_holds h ON h.id=a.hold_id WHERE h.account_id=$1",[scope.accountId]);
  assert.equal(allocations.rowCount,1);
  assert.equal(allocations.rows[0].source,'PURCHASED');
  assert.ok(Number(allocations.rows[0].actual_minor)>0);
  await buy('agent-monthly-documents',4900);
  assert.equal((await ent.meterState(db,scope,'agent_documents')).included,50);
  assert.equal((await ent.meterState(db,scope,'agent_documents')).remaining,550);
  await buy('agent-location-inventory',2900);
  assert.equal((await ent.meterState(db,{accountId:owner.accountId},'workspaces')).hardLimit,2);
  assert.equal((await ent.meterState(db,scope,'locations')).hardLimit,7);
  const later=new Date((current+86405)*1000);
  assert.equal((await ent.meterState(db,scope,'agent_documents',{now:later})).purchasedRemaining,0);
  await plan('growth');
  assert.equal((await ent.meterState(db,scope,'agent_documents')).included,500);
  await assert.rejects(policy.requireWorkspaceJob(db,scope.workspaceId,185,'automatic'),/Custom/);
  await plan('pro');
  assert.equal((await ent.meterState(db,scope,'locations')).hardLimit,null);
  assert.equal((await ent.meterState(db,scope,'agent_documents')).included,3000);
  await assert.rejects(addons.begin(db,scope,input('agent-location-inventory'),options),/current plan/);
  await assert.rejects(policy.requireWorkspaceJob(db,scope.workspaceId,185,'automatic'),/Custom/);
  await buy('agent-pro-edi',29900);
  await policy.requireWorkspaceJob(db,scope.workspaceId,185,'automatic');
  await plan('starter');
  await assert.rejects(policy.requireWorkspaceJob(db,scope.workspaceId,185,'automatic'));
  await plan('enterprise');
  await policy.requireWorkspaceJob(db,scope.workspaceId,185,'automatic');
});

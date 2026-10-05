'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');const auth=require('../../src/domain/postgres-auth-service');
const commercial=require('../../src/commercial/service');const refunds=require('../../src/commercial/refunds');
const {newId}=require('../../src/lib/util');
test('refund handler compensates once and never restores unfunded or foreign usage',{timeout:120000},async t=>{
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 const owner=await auth.createBusiness(db,{name:'Refund Owner',businessName:'Refunds',email:'refund-owner@example.test',password:'Refund-test-password!'});
 const other=await auth.createBusiness(db,{name:'Other Owner',businessName:'Other',email:'refund-other@example.test',password:'Refund-test-password!'});
 await t.test('additive refund migration rolls back cleanly and preserves existing accounts and checkout lock',async()=>{
  // Only this fresh, disposable fixture: restore its pre-028 schema to rehearse
  // application and rollback against pre-existing account records.
  const name='028-commercial-refund-states.sql';
  const sql=require('node:fs').readFileSync(require('node:path').join(__dirname,'../../src/db/postgres-migrations',name),'utf8');
  await db.query('DROP TABLE commercial_stripe_refunds');
  await db.query('DELETE FROM stockchief_postgres_migrations WHERE name=$1',[name]);
  const before=(await db.query('SELECT id,email FROM accounts ORDER BY id')).rows;
  await assert.rejects(()=>db.transaction(async client=>{await client.query(sql);
   assert.ok((await client.query("SELECT to_regclass('public.commercial_stripe_refunds') AS name")).rows[0].name);
   throw Error('Expected fixture migration rollback');}),/Expected fixture migration rollback/);
  assert.equal((await db.query("SELECT to_regclass('public.commercial_stripe_refunds') AS name")).rows[0].name,null);
  assert.deepEqual((await db.query('SELECT id,email FROM accounts ORDER BY id')).rows,before);
  assert.deepEqual(await migratePostgres(db),[name]);
  assert.deepEqual(await migratePostgres(db),[]);
  const release=(await db.query('SELECT * FROM commercial_release_control')).rows[0];
  assert.equal(release.checkout_enabled,false);assert.equal(release.economics_approved_at,null);assert.equal(release.readiness_approved_at,null);
 });
 let tick=Math.floor(Date.now()/1000);
 async function purchase(){const id=newId('purchase');await db.query(`INSERT INTO commercial_usage_purchases
  (id,account_id,workspace_id,pack_id,category,units,amount_minor,currency,kind,status,idempotency_key,stripe_payment_intent_id)
  VALUES($1,$2,$3,'ai-500-v1','ai_work_credits',10,100,'USD','MANUAL','PAID',$1,$4)`,[id,owner.accountId,owner.workspaceId,`pi_${id}`]);
  await db.query(`INSERT INTO commercial_usage_grants(id,account_id,workspace_id,category,purchase_id,units,expires_at)
   VALUES($1,$2,$3,'ai_work_credits',$4,10,now()+interval '1 year')`,[newId('grant'),owner.accountId,owner.workspaceId,id]);return id;}
 const event=(id,p,status,created=++tick)=>({id:newId('evt'),created,type:status==='failed'?'refund.failed':'refund.updated',
  data:{object:{id,status,payment_intent:`pi_${p}`,amount:100,currency:'usd'}}});
 const grant=async id=>(await db.query('SELECT * FROM commercial_usage_grants WHERE purchase_id=$1',[id])).rows[0];
 await t.test('success then failure appends one exact compensation despite parallel deliveries',async()=>{
  const p=await purchase();const success=event('re_success_fail',p,'succeeded');await commercial.handleBillingEvent(db,success);
  assert.equal(Number((await grant(p)).revoked_units),10);
  const failure=event('re_success_fail',p,'failed');await Promise.all([commercial.handleBillingEvent(db,failure),
    commercial.handleBillingEvent(db,{...failure,id:newId('evt')}),commercial.handleBillingEvent(db,failure)]);
  assert.equal(Number((await grant(p)).revoked_units),0);
  assert.equal((await db.query('SELECT status FROM commercial_usage_purchases WHERE id=$1',[p])).rows[0].status,'PAID');
  await commercial.handleBillingEvent(db,{...success,id:newId('evt'),created:++tick});
  const rows=(await db.query("SELECT amount_minor FROM commercial_revenue_events WHERE detail->>'refundId'='re_success_fail' ORDER BY amount_minor")).rows;
  assert.deepEqual(rows.map(x=>Number(x.amount_minor)),[-100,100]);assert.equal(Number((await grant(p)).revoked_units),0);
 });
 await t.test('failure-first tombstone prevents stale success from debiting or minting credit',async()=>{
  const p=await purchase();const success=event('re_failed_first',p,'succeeded');await commercial.handleBillingEvent(db,event('re_failed_first',p,'failed'));
  await commercial.handleBillingEvent(db,success);await commercial.handleBillingEvent(db,event('re_failed_first',p,'pending'));
  assert.equal(Number((await grant(p)).revoked_units),0);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM commercial_revenue_events WHERE detail->>'refundId'='re_failed_first'")).rows[0].n),0);
 });
 await t.test('failed refund does not release a separate lost dispute',async()=>{
  const p=await purchase();await commercial.handleBillingEvent(db,event('re_disputed',p,'succeeded'));
  await commercial.handleBillingEvent(db,{id:newId('evt'),created:++tick,type:'charge.dispute.closed',data:{object:{id:'dp_lost_refund',payment_intent:`pi_${p}`,amount:50,currency:'usd',status:'lost'}}});
  await commercial.handleBillingEvent(db,event('re_disputed',p,'failed'));
  assert.equal(Number((await grant(p)).revoked_units),5);
 });
 await t.test('partial refunds stay independent and invalid amounts or ownership fail closed',async()=>{
  const p=await purchase();const first=event('re_partial_a',p,'succeeded');first.data.object.amount=40;
  const second=event('re_partial_b',p,'succeeded');second.data.object.amount=60;
  await commercial.handleBillingEvent(db,first);await commercial.handleBillingEvent(db,second);
  const failure={...first,id:newId('evt'),created:++tick,type:'refund.failed',data:{object:{...first.data.object,status:'failed'}}};
  await commercial.handleBillingEvent(db,failure);assert.equal(Number((await grant(p)).revoked_units),6);
  await assert.rejects(()=>db.transaction(client=>refunds.reconcile(client,first,other.accountId)),/ownership/);
  for(const amount of [0,-1,101,null,'100']){const bad=event(newId('refund'),p,'succeeded');bad.data.object.amount=amount;
   await assert.rejects(()=>commercial.handleBillingEvent(db,bad),/amount/);}
 });
 await t.test('failed spent refund restores only original unspent balance and resolves its warning',async()=>{
  const p=await purchase();const g=await grant(p);const id=newId('usage');
  await db.query(`INSERT INTO commercial_usage_events(id,account_id,workspace_id,meter,units,idempotency_key,status)
   VALUES($1,$2,$3,'ai_work_credits',3,$1,'COMMITTED')`,[id,owner.accountId,owner.workspaceId]);
  await db.query('INSERT INTO commercial_usage_allocations(id,event_id,grant_id,units) VALUES($1,$2,$3,3)',[newId('allocation'),id,g.id]);
  await commercial.handleBillingEvent(db,event('re_spent_failure',p,'succeeded'));
  assert.equal((await db.query('SELECT status FROM commercial_critical_warnings WHERE fingerprint=$1',[`refund-spent:${p}`])).rows[0].status,'OPEN');
  await commercial.handleBillingEvent(db,event('re_spent_failure',p,'failed'));
  assert.equal((await db.query('SELECT status FROM commercial_critical_warnings WHERE fingerprint=$1',[`refund-spent:${p}`])).rows[0].status,'RESOLVED');
  const balances=await require('../../src/commercial/wallet').balances(db,{accountId:owner.accountId,workspaceId:owner.workspaceId},'ai_work_credits',
    {start:new Date(0),end:new Date('2100-01-01')});
  assert.equal(Number(balances.grants.find(row=>row.id===g.id).remaining),7);
  assert.equal(Number((await db.query('SELECT units FROM commercial_usage_events WHERE id=$1',[id])).rows[0].units),3);
 });
 await t.test('pending and canceled refunds neither debit cash nor revoke capacity',async()=>{
  const p=await purchase();await commercial.handleBillingEvent(db,event('re_canceled',p,'pending'));
  await commercial.handleBillingEvent(db,event('re_canceled',p,'canceled'));
  await commercial.handleBillingEvent(db,event('re_canceled',p,'succeeded'));
  assert.equal(Number((await grant(p)).revoked_units),0);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM commercial_revenue_events WHERE detail->>'refundId'='re_canceled'")).rows[0].n),0);
 });
 await t.test('subscription refund compensation also conserves cash and reconciles failure fees',async()=>{
  await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source,stripe_customer_id)
   VALUES('refund-sub',$1,'starter','ACTIVE','MONTHLY','TEST','cus_refund_test')`,[owner.accountId]);
  const initial=event('re_subscription','subscription','succeeded');initial.data.object.customer='cus_refund_test';
  await commercial.handleBillingEvent(db,initial);
  const failed={...initial,id:newId('evt'),created:++tick,type:'refund.failed',data:{object:{...initial.data.object,status:'failed',
   failure_balance_transaction:{id:'txn_refund_failure',created:tick,currency:'usd',amount:100,fee:3}}}};
  await commercial.handleBillingEvent(db,failed);await commercial.handleBillingEvent(db,{...failed,id:newId('evt')});
  const rows=(await db.query("SELECT amount_minor FROM commercial_revenue_events WHERE detail->>'refundId'='re_subscription'")).rows;
  assert.equal(rows.length,2);assert.equal(rows.reduce((sum,x)=>sum+Number(x.amount_minor),0),0);
  assert.equal(Number((await db.query("SELECT amount_minor FROM commercial_revenue_events WHERE source_id='stripe-fee:txn_refund_failure'")).rows[0].amount_minor),-3);
 });
});

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('mail preparation becomes an ordinary plan benefit without changing existing prices, meters or historical version contents',
  {timeout:120000},async t=>{
  const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,owner,ctx}=f;
  const versions=(await db.query('SELECT * FROM commercial_plan_versions ORDER BY plan_id,version_number')).rows;
  const original=versions.filter(v=>v.plan_id==='growth').at(-1);
  await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,source)
    VALUES('benefit-subscription',$1,'growth',$2,'COMP','CUSTOM','ISOLATED_PLAN_BENEFIT_TEST')`,[owner.accountId,original.id]);
  const balances=(await db.query('SELECT * FROM commercial_plan_meters ORDER BY plan_id,meter')).rows;
  const scope={accountId:owner.accountId,workspaceId:ctx.workspaceId},entitlements=require('../../src/commercial/entitlements');
  assert.equal((await entitlements.capabilityState(db,scope,'communications.ai_drafts')).enabled,false);
  const benefits=require('../../src/commercial/feature-benefits');
  const enabled=await benefits.set(db,{capability:'communications.ai_drafts',enabled:true,reason:'Verified isolated product acceptance'});
  assert(enabled.versionCount>0);
  assert.equal((await entitlements.capabilityState(db,scope,'communications.ai_drafts')).enabled,true);
  const selected=await entitlements.subscriptionFor(db,owner.accountId);
  const next=(await db.query('SELECT * FROM commercial_plan_versions WHERE id=$1',[selected.plan_version_id])).rows[0];
  for(const key of ['currency','monthly_amount_minor','annual_amount_minor','meters'])assert.deepEqual(next[key],original[key],key+' changed');
  assert.deepEqual((await db.query('SELECT entitlements FROM commercial_plan_versions WHERE id=$1',[original.id])).rows[0].entitlements,original.entitlements);
  assert.deepEqual((await db.query('SELECT * FROM commercial_plan_meters ORDER BY plan_id,meter')).rows,balances);
  assert.equal(Number((await db.query("SELECT enabled FROM commercial_plan_entitlements WHERE plan_id='starter' AND capability='communications.ai_drafts'")).rows[0]?.enabled||0),0);
  assert.equal((await benefits.set(db,{capability:'communications.ai_drafts',enabled:true,reason:'Idempotent replay'})).versionCount,0);
  await benefits.set(db,{capability:'communications.ai_drafts',enabled:false,reason:'Reversible feature availability test'});
  assert.equal((await entitlements.capabilityState(db,scope,'communications.ai_drafts')).enabled,false);
  assert.equal((await benefits.set(db,{capability:'communications.ai_drafts',enabled:false,reason:'Idempotent rollback'})).versionCount,0);
  assert.deepEqual((await db.query('SELECT entitlements FROM commercial_plan_versions WHERE id=$1',[next.id])).rows[0].entitlements,next.entitlements);
  assert.equal(await f.balance(),4);
});

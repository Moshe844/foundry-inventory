'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-buffer-fixture');
test('Pro and Custom automatically publish actual costed sellable stock minus their exact channel buffer without teaching',{timeout:300000},async t=>{
 for(const [plan,provider] of [['pro','shopify'],['enterprise','woocommerce']])await t.test(plan+' '+provider,async s=>{
  const f=await fixture(s,plan,provider),{db,ctx}=f,r=await f.configure();assert.equal((await f.service.rule(db,ctx,r.id)).automatic_enabled,true);assert.equal((await f.reconcile()).queued,1);assert.equal(f.remote.value,20);
  assert.equal(await require('../../src/operations/postgres-job-queue').claim(db,{owner:'old-commerce-worker',kinds:['provider.effect']}),null);assert.equal((await f.deliver()).length,1);assert.equal(f.remote.value,17);assert.equal(await f.balance(),20);assert.deepEqual(f.writes,[17]);
  await f.cache();await f.reconcile();assert.equal((await f.deliver()).length,0);assert.deepEqual(f.writes,[17]);
 });
});
test('Growth saves only individual-review buffers, while Starter cannot configure or deliver buffered stock',{timeout:240000},async t=>{
 const f=await fixture(t,'growth'),{db,ctx}=f;await assert.rejects(f.configure(),/Pro/);const r=await f.configure({automatic:''});const check=await f.reconcile();assert.equal(check.queued,0);assert.equal(f.remote.value,20);const needs=await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId),hold=needs.find(r=>r.href==='/autopilot/channel-buffers?position='+f.positionId);assert(hold,'Needs you links directly to the held stock buffer');assert.equal(hold.actionLabel,'Review stock buffer');assert.match(hold.recommendation,/exact channel quantity/);
 const review=await f.service.prepareReview(db,ctx,r.id,{providers:f.providers});assert.equal(review.snapshot.value,17);assert.equal(review.snapshot.providerValue,20);const hash=require('../../src/pricing/postgres-promotions').hash;
 await assert.rejects(f.service.publish(db,ctx,review.id,{confirmed:'yes',reviewHash:'different'}),/Confirm this exact/);await f.service.publish(db,ctx,review.id,{confirmed:'yes',reviewHash:hash(review.snapshot)});await f.service.publish(db,ctx,review.id,{confirmed:'yes',reviewHash:hash(review.snapshot)});await f.deliver();assert.deepEqual(f.writes,[17]);
 await f.subscribe('starter');await assert.rejects(f.configure({revision:1,automatic:''}),/Growth/);await f.service.configure(db,ctx,f.positionId,{revision:1,stop:'yes',confirmed:'yes'});assert.equal((await f.service.rule(db,ctx,r.id)).enabled,false);assert.equal(await f.balance(),20);
});

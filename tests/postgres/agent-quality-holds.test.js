'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/agent-quality-fixture');
test('Pro and Custom hold actual incoming stock, refuse early issue and release only after physical inspection',async t=>{
 for(const plan of ['pro','enterprise'])await t.test(plan,async t=>{
  const f=await fixture(t,plan),{db,ctx,quality}=f,p=await quality.save(db,ctx,f.scope);
  await quality.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});
  const po=await f.order(),receipt=await f.receive(po),id=receipt.qualityHoldIds[0];assert(id);assert.equal((await f.hold(id)).automatic,true);
  assert.equal(await f.balance(),18);assert.equal((await f.available()).available,8);
  await assert.rejects(f.inventory.issue(db,ctx,{idempotencyKey:randomUUID(),skuId:f.scope.skuId,locationId:f.location.id,quantity:9}),/delivery QC/);
  await assert.rejects(db.query('UPDATE balances SET on_hand=0 WHERE workspace_id=$1',[ctx.workspaceId]),/balances_quality_hold/);
  await assert.rejects(quality.inspect(db,ctx,id,{revision:1,decision:'PASS',checks:['0','1']}),/physically/);
  await assert.rejects(quality.inspect(db,ctx,id,{revision:1,decision:'PASS',physicallyChecked:'yes',checks:['0']}),/every/);
  const result=await quality.inspect(db,ctx,id,{revision:1,decision:'PASS',physicallyChecked:'yes',checks:['0','1']});assert.equal(result.released,true);
  assert.equal((await f.available()).available,18);assert.equal(await f.balance(),18);
  assert.equal((await quality.inspect(db,ctx,id,{revision:1})).replayed,true);assert.equal((await f.hold(id)).status,'PASSED');
 });
});
test('Growth learns only from an owner-completed manual example; Starter stays locked and stopped rules retain existing holds',async t=>{
 const f=await fixture(t,'growth'),{db,ctx,quality}=f,p=await quality.save(db,ctx,f.scope);
 await assert.rejects(quality.configure(db,ctx,p.id,{revision:1,confirmed:'yes'}),/example|teach|matching/i);
 const po=await f.order();await assert.rejects(f.receive(po),/owner|example|teach/i);assert.equal(await f.balance(),8);
 const receipt=await f.receive(po,{qcConfirmed:'yes'}),id=receipt.qualityHoldIds[0];assert.equal((await f.hold(id)).automatic,false);
 assert.equal((await quality.inspect(db,ctx,id,{revision:1,decision:'PASS',physicallyChecked:'yes',checks:['0','1']})).released,false);
 await quality.release(db,ctx,id,{revision:2,confirmed:'yes'});assert.equal((await f.available()).available,18);
 await quality.configure(db,ctx,p.id,{revision:1,confirmed:'yes',exampleId:id});
 const second=await f.receive(await f.order());assert.equal((await f.hold(second.qualityHoldIds[0])).automatic,true);
 await f.subscribe('starter');await assert.rejects(quality.inspect(db,ctx,second.qualityHoldIds[0],{revision:1,decision:'PASS',physicallyChecked:'yes',checks:['0','1']}),/Growth/);
 await assert.rejects(quality.save(db,ctx,f.scope),/Growth/);assert.equal((await f.available()).available,18);
 await quality.configure(db,ctx,p.id,{revision:2,stop:'yes'});assert.equal((await f.available()).available,18);
 await f.subscribe('growth');await quality.inspect(db,ctx,second.qualityHoldIds[0],{revision:1,decision:'PASS',physicallyChecked:'yes',checks:['0','1']});
 await quality.release(db,ctx,second.qualityHoldIds[0],{revision:2,confirmed:'yes'});assert.equal((await f.available()).available,28);
});
test('Failed QC stays held; current pause, shadow and downgrade prevent automatic release, without stock or money changes',async t=>{
 const f=await fixture(t),{db,ctx,quality}=f,p=await quality.save(db,ctx,f.scope);await quality.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});
 const receipt=await f.receive(await f.order()),id=receipt.qualityHoldIds[0];
 await quality.inspect(db,ctx,id,{revision:1,decision:'FAIL',physicallyChecked:'yes',note:'Broken packaging'});
 await assert.rejects(quality.release(db,ctx,id,{revision:2,confirmed:'yes'}),/Failed|passed/);assert.equal((await f.available()).available,8);
 await require('../../src/autopilot/postgres-service').pause(db,ctx,{role:'owner'},'Inspect damaged delivery');
 const pass=await quality.inspect(db,ctx,id,{revision:2,decision:'PASS',physicallyChecked:'yes',checks:['0','1']});assert.equal(pass.released,false);assert.match(pass.reason,/paused/);
 await quality.release(db,ctx,id,{revision:3,confirmed:'yes'});assert.equal((await f.available()).available,18);
});

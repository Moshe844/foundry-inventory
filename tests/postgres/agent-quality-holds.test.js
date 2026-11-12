'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/agent-quality-fixture');
test('Pro and Custom hold actual incoming stock, refuse early issue and release only after physical inspection',async t=>{
 for(const plan of ['pro','enterprise'])await t.test(plan,async t=>{
  const f=await fixture(t,plan),{db,ctx,quality}=f,p=await quality.save(db,ctx,f.scope);
  await quality.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});
  const po=await f.order(),receipt=await f.receive(po),id=receipt.qualityHoldIds[0];assert(id);assert.equal((await f.hold(id)).automatic,true);
  assert.equal(await f.balance(),18);assert.equal((await f.available()).available,8);
  await db.transaction(async c=>{
   await c.query('SET TRANSACTION READ ONLY');
   assert.equal((await quality.page(c,ctx,{id})).selected.id,id);
   assert.equal((await quality.inbox(c,ctx.workspaceId,ctx.actorId))[0].sourceId,'delivery-quality:'+id);
  });
  await assert.rejects(f.inventory.issue(db,ctx,{idempotencyKey:randomUUID(),skuId:f.scope.skuId,locationId:f.location.id,quantity:9}),/delivery QC/);
  await assert.rejects(db.query('UPDATE balances SET on_hand=0 WHERE workspace_id=$1',[ctx.workspaceId]),/balances_quality_hold/);
  await assert.rejects(quality.inspect(db,ctx,id,{revision:1,decision:'PASS',checks:['0','1']}),/physically/);
  await assert.rejects(quality.inspect(db,ctx,id,{revision:1,decision:'PASS',physicallyChecked:'yes',checks:['0']}),/every/);
  const result=await quality.inspect(db,ctx,id,{revision:1,decision:'PASS',physicallyChecked:'yes',checks:['0','1']});assert.equal(result.released,true);
  assert.equal((await f.available()).available,18);assert.equal(await f.balance(),18);
  assert.equal((await quality.inspect(db,ctx,id,{revision:1})).replayed,true);assert.equal((await f.hold(id)).status,'PASSED');
 });
});
const pass={decision:'PASS',physicallyChecked:'yes',checks:['0','1']};
test('Growth suggests each hold until taught; a stopped rule and a Starter downgrade keep existing holds finishable',async t=>{
 const f=await fixture(t,'growth'),{db,ctx,quality}=f,p=await quality.save(db,ctx,f.scope);
 const suggested=await f.receive(await f.order());assert.equal(suggested.qualityHoldIds,undefined);assert.equal(suggested.qualitySuggestionIds.length,1);assert.equal((await f.available()).available,18);
 const receipt=await f.receive(await f.order(),{qcConfirmed:'yes'}),id=receipt.qualityHoldIds[0];assert.equal((await f.hold(id)).automatic,false);assert.equal((await f.available()).available,18);
 assert.equal((await quality.inspect(db,ctx,id,{revision:1,...pass})).released,true);assert.equal((await f.available()).available,28);
 await quality.configure(db,ctx,p.id,{revision:1,confirmed:'yes',exampleId:id});
 const second=await f.receive(await f.order());assert.equal((await f.hold(second.qualityHoldIds[0])).automatic,true);assert.equal((await f.available()).available,28);
 await f.subscribe('starter');await assert.rejects(quality.save(db,ctx,{...f.scope,skuId:undefined}),/Growth/);
 await quality.configure(db,ctx,p.id,{revision:2,stop:'yes'});assert.equal((await f.available()).available,28);
 assert.equal((await quality.inspect(db,ctx,second.qualityHoldIds[0],{revision:1,...pass})).released,true);assert.equal((await f.available()).available,38);
});
test('Failed QC stays held; pause stops rule release but the inspector still releases a later pass, without money changes',async t=>{
 const f=await fixture(t),{db,ctx,quality}=f,p=await quality.save(db,ctx,f.scope);await quality.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});
 const receipt=await f.receive(await f.order()),id=receipt.qualityHoldIds[0];
 await quality.inspect(db,ctx,id,{revision:1,decision:'FAIL',physicallyChecked:'yes',note:'Broken packaging'});
 await assert.rejects(quality.release(db,ctx,id,{revision:2,confirmed:'yes'}),/Failed|passed/);assert.equal((await f.available()).available,8);
 const journals=async()=>(await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,before=await journals();
 await require('../../src/autopilot/postgres-service').pause(db,ctx,{role:'owner'},'Inspect damaged delivery');
 const later=await quality.inspect(db,ctx,id,{revision:2,...pass});assert.deepEqual([later.released,later.byRule],[true,false]);assert.match(later.reason,/paused/);
 assert.equal((await f.available()).available,18);assert.equal(await journals(),before);
});

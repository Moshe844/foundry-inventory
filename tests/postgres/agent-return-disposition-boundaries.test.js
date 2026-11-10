'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{fixture}=require('../helpers/agent-return-disposition-fixture');
test('Starter and Growth cannot record facts, save rules or apply queued paid decisions; stopping remains safe after downgrade',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f;await f.subscribe('enterprise');const r=await f.newRule();await s.configure(db,ctx,r.id,{revision:1,confirmed:'yes'});const id=await f.received(),a=await f.observe(id);await s.onObservation(db,ctx.workspaceId,a.id,ctx.actorId);
 for(const plan of ['starter','growth']){await f.subscribe(plan);await assert.rejects(f.newRule('DENIED-'+plan),/Pro/);const current=await s.facts(db,ctx,id);await assert.rejects(s.observe(db,ctx,{returnId:id,sourceHash:current.sourceHash,confirmed:'yes',lines:current.lines.map(l=>({lineId:l.id,conditionCode:'GOOD',note:'Observed'}))}),/Pro/);await assert.rejects(f.apply(a.id),/Pro/);const screen=await s.screen(db,ctx,{id:a.id});assert.equal(screen.allowed,false);assert.equal(screen.selected.status,'READY');}
 const current=await s.assessment(db,ctx,a.id);await s.stop(db,ctx,a.id,{revision:current.revision,confirmed:'yes'});await s.configure(db,ctx,r.id,{revision:2,stop:'yes'});assert.equal((await s.assessment(db,ctx,a.id)).status,'STOPPED');assert.equal((await f.returns.getCustomerReturn(db,ctx.workspaceId,id)).status,'RECEIVED');
});
test('current plan, global pause, per-job watch, 14-day watch, owner and exact condition and unit limit hold routine planning',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f;await f.subscribe('enterprise');const r=await f.newRule();await s.configure(db,ctx,r.id,{revision:1,confirmed:'yes'});const id=await f.received(),a=await f.observe(id),run=()=>s.onObservation(db,ctx.workspaceId,a.id,ctx.actorId),autonomy=require('../../src/autopilot/postgres-service');
 await autonomy.pause(db,ctx,{role:'owner'},'Synthetic owner pause');assert.equal((await run()).held,true);await autonomy.resume(db,ctx,{role:'owner'});
 await require('../../src/autopilot/job-modes').save(db,ctx,113,{mode:'watch',revision:0});assert.equal((await run()).held,true);await require('../../src/autopilot/job-modes').save(db,ctx,113,{mode:'routine',revision:1});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);assert.equal((await run()).held,true);await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await f.subscribe('growth');assert.equal((await run()).held,true);await f.subscribe('enterprise');assert.equal((await run()).automatic,true);
 const second=await f.received({quantity:2}),b=await f.observe(second);assert.match((await s.onObservation(db,ctx.workspaceId,b.id,ctx.actorId)).reason,/quantity/);const c=await f.observe(await f.received(),'UNKNOWN');assert.equal((await s.onObservation(db,ctx.workspaceId,c.id,ctx.actorId)).held,true);
 assert.equal((await s.onObservation(db,ctx.workspaceId,b.id,'missing-owner')).held,true);
 assert.equal((await f.returns.getCustomerReturn(db,ctx.workspaceId,id)).status,'RECEIVED');
});
test('changed source costs, stopped rules and stale review revisions prevent physical changes and duplicate observations replay',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f;await f.subscribe('enterprise');const r=await f.newRule(),id=await f.received(),a=await f.observe(id);assert.equal((await f.observe(id)).replayed,true);
 await s.prepare(db,ctx,a.id,{revision:1,byRules:'yes',confirmed:'yes'});let current=await s.assessment(db,ctx,a.id);await s.configure(db,ctx,r.id,{revision:1,stop:'yes'});await assert.rejects(f.apply(a.id),/rule changed or stopped/);
 await s.prepare(db,ctx,a.id,{revision:current.revision,confirmed:'yes',lines:current.observations.map(o=>({lineId:o.lineId,outcome:'RESTOCK',destinationId:f.location.id}))});current=await s.assessment(db,ctx,a.id);
 await assert.rejects(s.apply(db,ctx,a.id,{revision:current.revision-1,proposalHash:require('../../src/pricing/postgres-promotions').hash(current.proposal),confirmed:'yes'}),/current exact disposition/);
 await db.query('UPDATE accounting_inventory_cost_balances SET total_cost_minor=total_cost_minor+1 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,f.skuId,f.quarantine.id]);await assert.rejects(f.apply(a.id),/stock or cost changed/);assert.equal((await f.returns.getCustomerReturn(db,ctx.workspaceId,id)).status,'RECEIVED');
});
test('staff and another owner cannot read or alter facts and completed examples cannot teach another outcome or larger quantity',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f,id=await f.received(),a=await f.observe(id);await f.manual(a.id);await f.apply(a.id);
 const tooLarge=await f.newRule('UNOPENED_GOOD','RESTOCK',f.location.id,{maximumUnits:2});await assert.rejects(s.configure(db,ctx,tooLarge.id,{revision:1,exampleId:a.id,confirmed:'yes'}),/completed inspection/);
 const other=await f.newRule('OTHER','SCRAP',null);await assert.rejects(s.configure(db,ctx,other.id,{revision:1,exampleId:a.id,confirmed:'yes'}),/completed inspection/);
 const foreign=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other owner',businessName:'Separate inventory',email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()}),foreignCtx={workspaceId:foreign.workspaceId,actorId:foreign.userId};
 await assert.rejects(s.screen(db,foreignCtx,{id:a.id}),/not in this inventory/);await assert.rejects(s.apply(db,foreignCtx,a.id,{confirmed:'yes'}));
 const staffId=randomUUID();await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,permissions,created_at) VALUES($1,$2,$3,'Inspector','staff','[]',now()::text)",[staffId,ctx.workspaceId,foreign.accountId]);
 const staff={workspaceId:ctx.workspaceId,actorId:staffId};await assert.rejects(s.screen(db,staff),/current inventory owner/);await assert.rejects(s.prepare(db,staff,a.id,{confirmed:'yes'}),/current inventory owner/);
});

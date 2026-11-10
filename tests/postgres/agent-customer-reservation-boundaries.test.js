'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-reservation-fixture');
test('Two concurrent full reservations never leave a partial stock commitment behind',{timeout:240000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,assistant}=f,a=await f.order(10),b=await f.order(10),pa=await f.mission(a),pb=await f.mission(b),outcomes=await Promise.allSettled([assistant.executeMission(db,ctx,pa.proposal.id),assistant.executeMission(db,ctx,pb.proposal.id)]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.match(outcomes.find(r=>r.status==='rejected').reason.message,/insufficient|short|reserve|priority/i);assert.deepEqual([await f.reserved(a),await f.reserved(b)].sort((a,b)=>a-b),[0,10]);assert.equal(await f.balance(),20);
 assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND action_type='sales_order.reserve_all' AND status='EXECUTED'",[ctx.workspaceId])).rows[0].n,1);
});
test('Current modes, pause, shadow, new delivery addresses and changed source facts hold a pending reservation',{timeout:240000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,assistant}=f,p=await f.mission(await f.order()),modes=require('../../src/autopilot/job-modes'),autonomy=require('../../src/autopilot/postgres-service');
 await modes.save(db,ctx,12,{mode:'ask',revision:0});await assert.rejects(assistant.executeMission(db,ctx,p.proposal.id),/confirmation|Ask|approval/i);await modes.save(db,ctx,12,{mode:'inherit',revision:1});
 await autonomy.pause(db,ctx,{role:'owner'},'Review this reservation');await assert.rejects(assistant.executeMission(db,ctx,p.proposal.id),/paused/);await autonomy.resume(db,ctx,{role:'owner'});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);await assert.rejects(assistant.executeMission(db,ctx,p.proposal.id),/14|watch/i);await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await db.query("UPDATE customers SET email='changed-delivery@example.test' WHERE workspace_id=$1 AND id='fixture-customer'",[ctx.workspaceId]);await assert.rejects(assistant.executeMission(db,ctx,p.proposal.id),/changed after review/);
 const ship=await f.order(1,{deliveryMethod:'SHIP',shipToAddress:'25 New Delivery St, Albany, NY 12207'}),fresh=await f.mission(ship);await assert.rejects(assistant.executeMission(db,ctx,fresh.proposal.id),/first order.*address/i);assert.equal(await f.reserved(ship),0);
 await f.subscribe('starter');await assert.rejects(assistant.executeProposal(db,ctx,p.proposal.id),/Pro/);assert.equal(await f.balance(),20);
});
test('Automatic Custom work and empty manual reservations cannot train a later Pro routine',{timeout:240000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,assistant}=f,p=await f.mission(await f.order()),authority=require('../../src/autopilot/draft-authority');await assistant.executeMission(db,ctx,p.proposal.id);await f.subscribe('pro');assert.equal((await authority.settings(db,ctx,p.proposal.id)).canTeach,false);await assert.rejects(authority.save(db,ctx,p.proposal.id,{mode:'save',maximum:'20',revision:0}),/Complete a reviewed example/);
 const noop=await f.prepare(f.known);await assistant.executeProposal(db,ctx,noop.proposal.id);assert.equal((await authority.settings(db,ctx,noop.proposal.id)).canTeach,false);await assert.rejects(authority.save(db,ctx,noop.proposal.id,{mode:'save',maximum:'20',revision:0}),/Complete a reviewed example/);assert.equal(await f.balance(),20);
});

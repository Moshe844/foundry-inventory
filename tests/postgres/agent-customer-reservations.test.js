'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-reservation-fixture');
test('Pro teaches a completed native full reservation then reserves a matching customer order within that exact goods-value scope',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,assistant}=f,order=await f.order(),authority=require('../../src/autopilot/draft-authority');
 for(const plan of ['starter','growth']){await f.subscribe(plan);await assert.rejects(f.prepare(order),/Pro/);}await f.subscribe('pro');
 const first=await f.mission(order);await assert.rejects(assistant.executeMission(db,ctx,first.proposal.id),/teach|example/);assert.equal(await f.reserved(order),0);
 await assistant.executeProposal(db,ctx,first.proposal.id);assert.equal(await f.reserved(order),2);await authority.save(db,ctx,first.proposal.id,{mode:'save',maximum:'20.00',revision:0});
 const next=await f.order(),p=await f.mission(next);await assistant.executeMission(db,ctx,p.proposal.id);assert.equal(await f.reserved(next),2);await assistant.executeMission(db,ctx,p.proposal.id);assert.equal(await f.reserved(next),2);
 const large=await f.order(3),q=await f.mission(large);await assert.rejects(assistant.executeMission(db,ctx,q.proposal.id),/teach|scope|example/);assert.equal(await f.reserved(large),0);
 assert.equal(await f.balance(),20);assert.equal((await db.query('SELECT count(*)::int n FROM accounting_customer_invoices WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
});
test('Custom reserves an exact known-customer order without training, but not ahead of an earlier scarce-stock commitment',{timeout:240000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,assistant}=f,first=await f.order(30);await f.workflows.confirmSalesOrder(db,ctx,first.salesOrderId,{idempotencyKey:require('node:crypto').randomUUID()});assert.equal(await f.reserved(first),19);
 const next=await f.order(1),pending=await f.mission(next);await assert.rejects(assistant.executeMission(db,ctx,pending.proposal.id),/has priority/);assert.equal(await f.reserved(next),0);assert.equal(await f.reserved(first),19);
 await f.workflows.cancelSalesOrder(db,ctx,first.salesOrderId,{idempotencyKey:require('node:crypto').randomUUID(),reason:'Owner released this synthetic backlog'});await assistant.executeMission(db,ctx,pending.proposal.id);assert.equal(await f.reserved(next),1);assert.equal(await f.balance(),20);
});

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-rfq-fixture');
test('a mailbox or supplier change after queued preparation is caught at the last delivery check', {timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,p=await f.preview(),batch=await f.send(p);let calls=0;
 await assert.rejects(require('../../src/connections/postgres-outbound-mail').executeSendEffect(db,ctx.workspaceId,batch.deliveries[0].effectId,{provider:{send:async()=>{calls++;return {externalMessageId:'unexpected'};}},beforeSend:async()=>db.query("UPDATE workspace_connectors SET provider_account_id='reconnected-new-mailbox' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,f.connectorId])}),/mailbox|supplier|recipient/i);assert.equal(calls,0);
 await assert.rejects(f.service.request(db,{workspaceId:'another-inventory',actorId:ctx.actorId},p.id),/not in this inventory/);
});
test('new supplier requests need human approval even on Custom; completed manual RFQs establish that relationship', {timeout:240000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,service}=f;
 const orders=(await db.query("SELECT id FROM purchase_orders WHERE workspace_id=$1 AND supplier_id<> 'fixture-supplier' AND status='ORDERED'",[ctx.workspaceId])).rows;
 for(const order of orders)await f.workflows.cancelPurchaseOrder(db,ctx,order.id,{idempotencyKey:'rfq-known-partner-'+order.id});
 const p=await f.preview(),rule=await service.configure(db,ctx,p.id,{confirmed:'yes',maxRequestsPerWeek:2});await assert.rejects(service.sendAutomatic(db,ctx,p.id,rule.id),/first request.*individual/i);assert.equal(f.sent.length,0);
 await f.send(p);await f.deliver();assert.equal(f.sent.length,3);
 const next=await f.preview();await service.sendAutomatic(db,ctx,next.id,rule.id);await f.deliver();assert.equal(f.sent.length,6);
 await db.query("UPDATE users SET role='staff' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);await assert.rejects(service.sendAutomatic(db,ctx,next.id,rule.id),/Only the inventory owner/);
});
test('concurrent routine RFQs share one weekly allowance and repeating the winning pending request keeps one batch', {timeout:240000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,service}=f,a=await f.preview(),b=await f.preview(),rule=await service.configure(db,ctx,a.id,{confirmed:'yes',maxRequestsPerWeek:1});
 await assert.rejects(service.configure(db,ctx,b.id,{confirmed:'yes',maxRequestsPerWeek:1}),/active rule already covers/);
 const results=await Promise.allSettled([service.sendAutomatic(db,ctx,a.id,rule.id),service.sendAutomatic(db,ctx,b.id,rule.id)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/rolling seven-day/);
 const winner=results[0].status==='fulfilled'?a:b;await service.sendAutomatic(db,ctx,winner.id,rule.id);assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_rfq_deliveries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,3);await f.deliver();assert.equal(f.sent.length,3);
});

'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-partial-shipment-fixture');
const waves=f=>f.db.query('SELECT count(*)::int n FROM fulfillment_waves WHERE workspace_id=$1',[f.ctx.workspaceId]).then(r=>r.rows[0].n);
test('Pro cannot automatically prepare partial picks before a physically completed taught example',{timeout:240000},async t=>{
 const f=await fixture(t,'pro'),p=await f.mission(f.target);await assert.rejects(f.assistant.executeMission(f.db,f.ctx,p.proposal.id),/Pro|Custom|trained|teach|confirm|approval/i);assert.equal(await waves(f),0);assert.equal(await f.balance(),5);
});
test('Downgrade, per-job Watch and a changed source hold an already prepared partial release before picking records appear',{timeout:240000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx}=f,p=await f.mission(f.target);await f.subscribe('growth');await assert.rejects(f.assistant.executeMission(db,ctx,p.proposal.id),/Pro/);assert.equal(await waves(f),0);await f.subscribe('enterprise');await require('../../src/autopilot/job-modes').save(db,ctx,61,{mode:'watch',revision:0});await assert.rejects(f.assistant.executeMission(db,ctx,p.proposal.id),/Watch|watch/);await require('../../src/autopilot/job-modes').save(db,ctx,61,{mode:'inherit',revision:1});await db.query('UPDATE sales_orders SET allocation_priority=allocation_priority+1,version=version+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,f.target.salesOrderId]);await assert.rejects(f.assistant.executeMission(db,ctx,p.proposal.id),/changed|fresh/);assert.equal(await waves(f),0);assert.equal(await f.balance(),5);
});
test('A first delivery address still requires individual approval on Custom, and private reviews show names rather than fingerprints',{timeout:240000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx}=f;await db.query("UPDATE sales_orders SET ship_to_address='20 Market St, Albany, NY 12207',delivery_decision_required=0,version=version+1 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,f.target.salesOrderId]);const p=await f.mission(f.target),row=await f.assistant.getProposal(db,ctx.workspaceId,p.proposal.id),shown=require('../../src/web/proposal-presentation').present(row);assert(shown.fields.some(v=>v.label==='Units ready for picking'&&v.value==='4'));assert(!JSON.stringify(shown.fields).includes(row.payload.partialFingerprint));assert(!JSON.stringify(shown.fields).includes(f.target.salesOrderId));await assert.rejects(f.assistant.executeMission(db,ctx,p.proposal.id),/first order|individual|address/i);assert.equal(await waves(f),0);await f.assistant.executeProposal(db,ctx,p.proposal.id);assert.equal(await waves(f),1);assert.equal(await f.balance(),5);
});

test('Global pause, shadow mode and a newly frozen dispatch warehouse hold a prepared Custom partial shipment without stock or invoice effects',{timeout:240000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx}=f,p=await f.mission(f.target),autopilot=require('../../src/autopilot/postgres-service');
 await autopilot.pause(db,ctx,{role:'owner'},'Owner is reviewing dispatch');await assert.rejects(f.assistant.executeMission(db,ctx,p.proposal.id),/paused|pause/i);await autopilot.resume(db,ctx,{role:'owner'});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);await assert.rejects(f.assistant.executeMission(db,ctx,p.proposal.id),/14 days|shadow|watch/i);await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const annual=require('../../src/operations/agent-annual-stocktakes'),plan=await annual.create(db,ctx,{year:2026,title:'Physical dispatch count',locationIds:[f.location.id],counterIds:[ctx.actorId],requestKey:require('node:crypto').randomUUID()}),header=await annual.header(db,ctx,plan.id);
 await annual.freeze(db,ctx,plan.id,{revision:1,planHash:header.plan_hash,confirmed:'yes'});await assert.rejects(f.assistant.executeMission(db,ctx,p.proposal.id),/frozen|stocktake/i);
 assert.equal(await waves(f),0);assert.equal(await f.balance(),5);assert.equal((await db.query('SELECT count(*)::int n FROM accounting_customer_invoices WHERE sales_order_id=$1',[f.target.salesOrderId])).rows[0].n,0);
});

test('Concurrent individually approved partial releases create one physical picking path and never duplicate stock or billing',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,a=await f.prepare(f.target),b=await f.prepare(f.target);
 const results=await Promise.allSettled([a,b].map(p=>f.assistant.executeProposal(db,ctx,p.proposal.id)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(await waves(f),1);
 assert.equal((await db.query('SELECT count(*)::int n FROM sales_shipments WHERE sales_order_id=$1',[f.target.salesOrderId])).rows[0].n,1);
 assert.equal(await f.balance(),5);assert.equal((await db.query('SELECT count(*)::int n FROM accounting_customer_invoices WHERE sales_order_id=$1',[f.target.salesOrderId])).rows[0].n,0);
});

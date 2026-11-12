'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/agent-blanket-release-fixture');
test('Pro learns a real individually reviewed and approved release, then the typed worker prepares one due native draft without duplicate units, stock, journals or sending',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f,p=await f.contract(),before=await f.orders(),journals=(await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 assert.equal(p.slots.length,5);assert.equal(p.preview.goodsValueMinor,10000);
 // Pro may run the schedule before teaching; until then each release waits for approval.
 await s.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});
 const manual=await s.manual(db,ctx,p.slots[0].id,{confirmed:'yes'});
 assert.equal((await s.manual(db,ctx,p.slots[0].id,{confirmed:'yes'})).replayed,true);
 await assert.rejects(s.teach(db,ctx,p.slots[0].id,{confirmed:'yes'}),/approved yourself/);
 await f.workflows.approvePurchaseOrder(db,ctx,manual.purchaseOrderId,{idempotencyKey:randomUUID()});
 await s.teach(db,ctx,p.slots[0].id,{confirmed:'yes'});await f.workflows.placePurchaseOrder(db,ctx,manual.purchaseOrderId,{idempotencyKey:randomUUID()});assert.equal((await db.query('SELECT status FROM purchase_orders WHERE id=$1',[manual.purchaseOrderId])).rows[0].status,'ORDERED');await s.configure(db,ctx,p.id,{revision:3,confirmed:'yes'});
 assert.equal((await s.schedule(db,ctx.workspaceId)).queued,1);
 const q=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
 assert.equal(await q.claim(db,{owner:'old-contract-worker',kinds:['purchasing.blanket-release']}),null);
 const run=await q.processOne(db,{[s.kind]:handlers[s.kind]},{owner:'current-contract-worker'});
 assert.equal(run.status,'COMPLETED',JSON.stringify(run.lastError));assert(run.result.purchaseOrderId);
 const order=(await db.query('SELECT * FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,run.result.purchaseOrderId])).rows[0];
 assert.equal(order.status,'DRAFT');assert.equal(order.reference,p.input.reference+' / '+f.today);assert.equal(order.expected_date,f.add(f.today,3));
 const lines=(await db.query('SELECT quantity_units::text,unit_cost::text FROM purchase_order_lines WHERE purchase_order_id=$1',[order.id])).rows;
 assert.equal(Number(lines[0].quantity_units),20);assert.equal(Number(lines[0].unit_cost),1);
 assert.equal((await s.onContract(db,ctx.workspaceId,p.id)).notDue,true);assert.equal(await f.orders(),before+2);
 assert.equal(await f.balance(),20);assert.equal((await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,journals);
 assert.equal((await db.query("SELECT count(*)::int n FROM purchase_order_events e JOIN purchase_orders o ON o.id=e.purchase_order_id WHERE o.id=$1 AND e.event='placed'",[order.id])).rows[0].n,0);
});
test('Custom needs no teaching but still uses exact reviewed terms, handles concurrent workers once and holds missed releases for individual review',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f;await f.subscribe('enterprise');
 const p=await f.contract({firstRelease:f.today,lastRelease:f.add(f.today,14),lines:[{sku:f.sku,totalUnits:60,releaseUnits:20,unitPrice:'1.00'}]});
 await s.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});
 const before=await f.orders(),results=await Promise.all([s.onContract(db,ctx.workspaceId,p.id),s.onContract(db,ctx.workspaceId,p.id)]);
 assert.equal(results.filter(r=>r.purchaseOrderId).length,1);assert.equal(results.filter(r=>r.notDue).length,1);assert.equal(await f.orders(),before+1);
 const missed=await f.contract({reference:'MISSED-CONTRACT'});await s.configure(db,ctx,missed.id,{revision:1,confirmed:'yes'});
 const held=await s.onContract(db,ctx.workspaceId,missed.id);assert.equal(held.held,true);assert.match(held.reason,/missed/);
 await s.skip(db,ctx,missed.slots[0].id,{confirmed:'yes'});assert((await s.onContract(db,ctx.workspaceId,missed.id)).purchaseOrderId);
 assert.equal(await f.balance(),20);
});
test('changed linked native purchase quantities and cancelled examples stop later drafts instead of drawing extra contract units',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f;await f.subscribe('enterprise');
 const p=await f.contract(),first=await s.manual(db,ctx,p.slots[0].id,{confirmed:'yes'});await s.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});
 const line=(await db.query('SELECT id FROM purchase_order_lines WHERE purchase_order_id=$1',[first.purchaseOrderId])).rows[0];
 await f.workflows.reviseDraftPurchaseOrderLine(db,ctx,first.purchaseOrderId,{lineId:line.id,quantityUnits:40,idempotencyKey:randomUUID()});
 const before=await f.orders(),held=await s.onContract(db,ctx.workspaceId,p.id);
 assert.equal(held.held,true);assert.match(held.reason,/quantity|changed/);assert.equal(await f.orders(),before);
});

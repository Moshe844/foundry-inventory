'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/agent-blanket-release-fixture');
test('Starter and Growth cannot create or run contract releases, while stopping and ending existing unprepared work remain available',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f;await f.subscribe('enterprise');const p=await f.contract();await s.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});
 for(const tier of ['starter','growth']){
  await f.subscribe(tier);const page=await f.browser.get('/autopilot/blanket-releases/'+p.id);assert.equal(page.status,200);assert.match(page.text,/Pro or Custom required/);assert.doesNotMatch(page.text,/>Prepare this release draft<|>Enable scheduled release drafts</);
  await assert.rejects(f.contract({reference:'NO-'+tier}),/Pro|Custom|include/);await assert.rejects(s.manual(db,ctx,p.slots[0].id,{confirmed:'yes'}),/Pro|Custom|include/);assert.equal((await s.onContract(db,ctx.workspaceId,p.id)).held,true);
 }
 const before=await f.orders();await s.configure(db,ctx,p.id,{revision:2,stop:'yes'});await s.end(db,ctx,p.id,{revision:3,confirmed:'yes'});
 assert.equal((await s.get(db,ctx,p.id)).stopped,true);assert.equal((await s.screen(db,ctx,{id:p.id})).slots.every(r=>r.status==='SKIPPED'),true);assert.equal(await f.orders(),before);assert.equal(await f.balance(),20);
});
test('current shadow period, global pause, job Watch and Ask, changed prices and disabled owners hold all new routine drafts',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f;await f.subscribe('enterprise');const p=await f.contract({firstRelease:f.today,lastRelease:f.add(f.today,28)});await s.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});const before=await f.orders();
 await db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1',[ctx.workspaceId]);assert.equal((await s.onContract(db,ctx.workspaceId,p.id)).held,true);await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1',[ctx.workspaceId]);
 const modes=require('../../src/autopilot/job-modes');await modes.save(db,ctx,42,{mode:'watch',revision:0});assert.equal((await s.onContract(db,ctx.workspaceId,p.id)).held,true);await modes.save(db,ctx,42,{mode:'ask',revision:1});assert.equal((await s.onContract(db,ctx.workspaceId,p.id)).held,true);await modes.save(db,ctx,42,{mode:'routine',revision:2});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);assert.equal((await s.onContract(db,ctx.workspaceId,p.id)).held,true);await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await db.query("INSERT INTO platform_account_access(account_id,disabled_at,reason,changed_by) VALUES($1,now(),'Isolated supplier contract test',$1)",[f.owner.accountId]);assert.equal((await s.onContract(db,ctx.workspaceId,p.id)).held,true);await db.query('DELETE FROM platform_account_access WHERE account_id=$1',[f.owner.accountId]);
 await require('../../src/pricing/postgres-service').setPurchaseCost(db,ctx,{skuId:f.item.skuIds[0],amount:'1.10',currency:'USD'});const changed=await s.onContract(db,ctx.workspaceId,p.id);assert.equal(changed.held,true);assert.match(changed.reason,new RegExp(f.sku));assert.match(changed.reason,/\$1\.10/);assert.equal(await f.orders(),before);
});
test('actual supplier packs are preserved, cancelled linked POs stop future releases, and staff or foreign owners cannot act',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f;await f.subscribe('enterprise');
 await db.query("INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,purchase_unit,units_per_purchase_unit,last_unit_cost,minimum_order_quantity,order_multiple,created_at,updated_at) VALUES($1,$2,'fixture-supplier',$3,'case',10,1,2,1,now()::text,now()::text)",[randomUUID(),ctx.workspaceId,f.item.skuIds[0]]);
 await assert.rejects(f.contract({lines:[{sku:f.sku,totalUnits:60,releaseUnits:15,unitPrice:'1.00'}]}),/exact recorded supplier packs/);
 const p=await f.contract({lines:[{sku:f.sku,totalUnits:60,releaseUnits:20,unitPrice:'1.00'}]}),first=await s.manual(db,ctx,p.slots[0].id,{confirmed:'yes'}),line=(await db.query('SELECT quantity_purchase_units::text,units_per_purchase_unit::text,quantity_units::text FROM purchase_order_lines WHERE purchase_order_id=$1',[first.purchaseOrderId])).rows[0];
 assert.equal(Number(line.quantity_purchase_units),2);assert.equal(Number(line.units_per_purchase_unit),10);assert.equal(Number(line.quantity_units),20);
 await s.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});await f.workflows.cancelPurchaseOrder(db,ctx,first.purchaseOrderId,{idempotencyKey:randomUUID(),reason:'Owner cancelled this unplaced synthetic draft'});
 const before=await f.orders(),held=await s.onContract(db,ctx.workspaceId,p.id);assert.equal(held.held,true);assert.match(held.reason,/cancelled|changed/);assert.equal(await f.orders(),before);
 const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other owner',businessName:'Other contract account',email:randomUUID()+'@example.test',password:f.password});
 await assert.rejects(s.end(db,{workspaceId:other.workspaceId,actorId:other.userId},p.id,{revision:2,confirmed:'yes'}),/not in this inventory/);
 await db.query("UPDATE users SET role='staff' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);await assert.rejects(s.screen(db,ctx),/current inventory owner/);await assert.rejects(s.skip(db,ctx,p.slots[1].id,{confirmed:'yes'}),/current inventory owner/);
});

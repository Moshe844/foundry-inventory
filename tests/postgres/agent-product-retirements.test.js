'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const service=require('../../src/catalog/agent-product-retirements'),{hash}=require('../../src/pricing/postgres-promotions');

const {fixture}=require('../helpers/agent-product-retirement-fixture');

test('discontinued products respect every plan, native retirement, Pro teaching and lower limits after upgrade',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,first=await f.pair(),raw=f.input([first]);
 for(const plan of ['starter','growth']){await f.subscribe(plan);await assert.rejects(service.preview(db,ctx,raw),e=>e.code==='entitlement_required');const locked=await f.browser.get('/autopilot/discontinued-products');assert.equal(locked.status,200);assert.match(locked.text,/Upgrade/);assert(!locked.text.includes('Preview product retirements'));}
 await f.subscribe('pro');await assert.rejects(f.authority(0),/train|taught|approved/i);
 await f.subscribe('enterprise');await f.authority(0);const n=await f.record([first]),jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create(),before=(await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 assert.equal(await jobs.claim(db,{owner:'old-catalog-worker',kinds:['mail.customer-order']}),null);
 const work=await jobs.processOne(db,{[service.jobKind]:handlers[service.jobKind]},{owner:'retirement-current'});assert.equal(work.status,'COMPLETED',JSON.stringify(work));assert.equal(work.result.changedCount,1,JSON.stringify(work.result));assert.equal(work.result.replayed,false);
 assert.equal(Number((await db.query('SELECT is_active FROM items WHERE id=$1',[first.old.item_id])).rows[0].is_active),0);assert.equal(Number((await db.query('SELECT is_active FROM skus WHERE id=$1',[first.replacement.id])).rows[0].is_active),1);assert.equal((await service.guidance(db,ctx.workspaceId,first.old.item_id))[0].replacement_item_id,first.replacement.item_id);
 assert.equal((await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,before);assert.equal(await f.balance(),20);
 assert.equal((await service.record(db,ctx,{...n.raw,sourceChecked:'yes',sourceFingerprint:n.p.sourceFingerprint})).replayed,true);assert.equal((await service.onNotice(db,ctx.workspaceId,n.id)).replayed,true);
 const oldPage=await f.browser.get('/inventory/'+first.old.item_id);assert.equal(oldPage.status,200);assert(oldPage.text.includes(first.replacement.code));
 await f.subscribe('pro');const second=await f.pair(),secondNotice=await f.record([second]);assert.equal((await service.onNotice(db,ctx.workspaceId,secondNotice.id)).held,true,'Pro must learn an individually approved example');
 assert.equal((await service.apply(db,ctx,secondNotice.id,{confirmed:'yes',sourceFingerprint:secondNotice.p.sourceFingerprint})).changedCount,1);
 await f.authority(1,{maximumProducts:'1',exampleId:secondNotice.id});const third=await f.record([await f.pair()]);assert.equal((await service.onNotice(db,ctx.workspaceId,third.id)).changedCount,1);
 await f.subscribe('enterprise');await f.authority(2,{maximumProducts:'2'});const tooMany=await f.record([await f.pair(),await f.pair()]),held=await service.onNotice(db,ctx.workspaceId,tooMany.id);assert.equal(held.held,true);assert.match(held.reason,/lower taught limit/);
 await f.subscribe('growth');assert.equal((await service.onNotice(db,ctx.workspaceId,tooMany.id)).held,true);await service.configure(db,ctx,f.supplier.id,{revision:3,stop:'yes'});assert.equal((await service.list(db,ctx)).settings[0].enabled,false);
});

test('product retirement sells stock down and refuses open purchase orders, stale facts and shadow mode; audit failure rolls back the entire batch',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,a=await f.pair(),b=await f.pair(),source=f.input([a,b]),preview=await service.preview(db,ctx,source);
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_product_retirement_notices WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
 const stockCode=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:f.supplier.id,skuId:f.item.skuIds[0],purchaseUnit:'each',unitsPerPurchaseUnit:1,lastUnitCost:1});const stocked=await service.preview(db,ctx,{...source,products:'Discontinued SKU,Replacement SKU\n'+stockCode+','+a.replacement.code});assert.equal(Number(stocked.stock[f.item.skuIds[0]]),20,'stock left is sold down, not refused');
 const order=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:f.supplier.id,destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:a.old.id,quantityUnits:1,unitCost:1}]});await assert.rejects(service.preview(db,ctx,source),/unfinished order/);await db.query("UPDATE purchase_orders SET status='CANCELLED' WHERE id=$1",[order.purchaseOrderId]);
 const n=await service.record(db,ctx,{...source,sourceChecked:'yes',sourceFingerprint:preview.sourceFingerprint});
 await db.query('UPDATE items SET name=name||$2 WHERE id=$1',[a.replacement.item_id,' changed']);await assert.rejects(service.apply(db,ctx,n.id,{confirmed:'yes',sourceFingerprint:preview.sourceFingerprint}),/changed after this source/);await db.query('UPDATE items SET name=$2 WHERE id=$1',[a.replacement.item_id,preview.pairs[0].replacement.name]);
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);await assert.rejects(service.apply(db,ctx,n.id,{confirmed:'yes',sourceFingerprint:preview.sourceFingerprint}),/14 days/);await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const audit=require('../../src/operations/postgres-security-audit'),original=audit.record;audit.record=async()=>{throw Error('Controlled retirement audit failure');};try{await assert.rejects(service.apply(db,ctx,n.id,{confirmed:'yes',sourceFingerprint:preview.sourceFingerprint}),/Controlled retirement audit failure/);}finally{audit.record=original;}
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_product_replacements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);assert.equal(Number((await db.query('SELECT is_active FROM skus WHERE id=$1',[a.old.id])).rows[0].is_active),1);assert.equal((await service.page(db,ctx,n.id)).notice.applied_at,null);
 await service.apply(db,ctx,n.id,{confirmed:'yes',sourceFingerprint:preview.sourceFingerprint});await assert.rejects(service.preview(db,ctx,f.input([{old:a.replacement,replacement:b.replacement}])),/saved replacement/);
 await assert.rejects(service.page(db,{workspaceId:randomUUID(),actorId:ctx.actorId},n.id),e=>e.code==='forbidden');
});


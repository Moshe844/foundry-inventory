'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{fixture}=require('../helpers/agent-quality-fixture');
const pass={revision:1,decision:'PASS',physicallyChecked:'yes',checks:['0','1']};
test('a warehouse receiver can attest physical QC only within assigned locations and cannot grant authority or manually release goods', {timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,quality}=f,p=await quality.save(db,ctx,f.scope);await quality.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});const id=(await f.receive(await f.order())).qualityHoldIds[0];
 const outsider=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'QC staff sign in',businessName:'Other QC inventory',email:randomUUID()+'@example.test',password:'Staff!'+randomUUID()}),staffId=randomUUID();
 await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,permissions,warehouse_location_ids,created_at) VALUES($1,$2,$3,'QC receiver','staff',$4,$5,now())",[staffId,ctx.workspaceId,outsider.accountId,JSON.stringify(['VIEW','VIEW_PURCHASING','RECEIVE_PO']),JSON.stringify([])]);const staff={workspaceId:ctx.workspaceId,actorId:staffId};
 await assert.rejects(quality.inspect(db,staff,id,pass),/outside your assigned/);assert.equal((await quality.page(db,staff)).rows.length,0);
 await db.query('UPDATE users SET warehouse_location_ids=$2 WHERE id=$1',[staffId,JSON.stringify([f.location.id])]);assert.equal((await quality.page(db,staff)).rows.length,1);
 await assert.rejects(quality.configure(db,staff,p.id,{revision:2,stop:'yes'}),/Only the inventory owner/);await assert.rejects(quality.release(db,staff,id,{revision:1,confirmed:'yes'}),/Only the inventory owner/);
 assert.equal((await quality.inspect(db,staff,id,pass)).released,true);assert.equal((await f.available()).available,18);
});
test('receipt and physical inspection can complete concurrently without holding one another in opposite lock order', {timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,quality}=f,p=await quality.save(db,ctx,f.scope);await quality.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});const id=(await f.receive(await f.order())).qualityHoldIds[0],next=await f.order();
 const [inspection,receipt]=await Promise.all([quality.inspect(db,ctx,id,pass),f.receive(next)]);assert.equal(inspection.released,true);assert.equal(receipt.qualityHoldIds.length,1);assert.equal(await f.balance(),28);assert.equal((await f.available()).available,18);
 await quality.inspect(db,ctx,receipt.qualityHoldIds[0],pass);assert.equal((await f.available()).available,28);
});
test('a native customer shipment cannot allocate or dispatch QC-held incoming stock', {timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,quality}=f,p=await quality.save(db,ctx,f.scope);await quality.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});const id=(await f.receive(await f.order())).qualityHoldIds[0];
 const poCount=(await db.query('SELECT count(*)::int n FROM purchase_order_receipts WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 await assert.rejects(f.parcel({quantity:9}),/available|stock|short|allocat|supply/i);assert.equal(await f.balance(),18);assert.equal((await f.hold(id)).status,'HELD');
 assert.equal((await db.query('SELECT count(*)::int n FROM purchase_order_receipts WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,poCount);
});

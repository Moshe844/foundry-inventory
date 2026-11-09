'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('audit history shows recorded actors, stock and price before/after, filters safely and streams scoped CSV',{timeout:120000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser:agent}=f,audit=require('../../src/operations/postgres-audit'),prices=require('../../src/pricing/postgres-service'),skuId=f.item.skuIds[0];
 await db.transaction(c=>prices.setPurchaseCostsInTransaction(c,ctx,[{skuId,amountMinor:6500,currency:'USD'}]));await db.transaction(c=>prices.setPurchaseCostsInTransaction(c,ctx,[{skuId,amountMinor:7500,currency:'USD'}]));
 await require('../../src/domain/postgres-sku-maintenance').update(db,ctx,f.item.itemId,skuId,{barcode:'AUDIT-123',expectedBarcode:''});
 await db.query("INSERT INTO catalogue_change_history(id,workspace_id,actor_id,item_id,sku_id,action,before_state,after_state,created_at) SELECT 'micro-'||n,$1,$2,$3,$4,'barcode','{}','{}',timestamptz '2026-10-31T12:00:00.123100Z'+n*interval '1 microsecond' FROM generate_series(1,3)n",[ctx.workspaceId,ctx.actorId,f.item.itemId,skuId]);
 const page=await audit.page(db,ctx.workspaceId);assert(page.rows.some(r=>r.action==='Stock receive'&&r.before==='On hand: 0'&&r.after.includes('On hand: 4')));assert(page.rows.some(r=>r.action==='Purchase cost'&&r.before==='$65.00'&&r.after==='$75.00'&&r.who==='Owner'));assert(page.rows.some(r=>r.action==='barcode'&&r.after==='Barcode: AUDIT-123'));
 assert.equal((await audit.page(db,'unrelated-inventory')).rows.length,0);assert.equal((await audit.page(db,ctx.workspaceId,{user:'unrelated-user'})).rows.length,0);assert.equal((await audit.page(db,ctx.workspaceId,{q:'unmatched-product'})).rows.length,0);assert.equal((await audit.page(db,ctx.workspaceId,{to:'2000-01-01'})).rows.length,0);await assert.rejects(audit.page(db,ctx.workspaceId,{after:'invalid'}),/page link/);
 let after=null,seen=[];do{const result=await audit.page(db,ctx.workspaceId,{after},2);seen.push(...result.rows.map(r=>r.key));after=result.hasMore?result.next:null;}while(after);assert.equal(new Set(seen).size,seen.length);assert.equal(seen.length,page.rows.length);
 await agent.get('/audit/export?q=Parcel').expect(402);
 await f.subscribe('pro');
 const html=await agent.get('/audit');assert.equal(html.status,200);assert.match(html.text,/Audit trail/);assert.match(html.text,/\$65.00/);assert.doesNotMatch(html.text,/sourceSkuId/);
 const csv=await agent.get('/audit/export?q=Parcel');assert.equal(csv.status,200);assert.match(csv.headers['content-type'],/text\/csv/);assert.match(csv.headers['content-disposition'],/attachment/);assert.match(csv.text,/Before.*After/);assert.match(csv.text,/\$75.00/);assert.doesNotMatch(csv.text,/fixture-po/);
 const original=await f.balance();await db.query("UPDATE users SET role='viewer',permissions='[\"VIEW\"]' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);assert.equal((await agent.get('/audit')).status,403);assert.equal((await agent.get('/audit/export')).status,403);assert.equal(await f.balance(),original);
});

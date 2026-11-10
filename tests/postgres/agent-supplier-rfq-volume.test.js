'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('a native 100-product RFQ shares every requested product with each supplier without duplicating email or changing stock', {timeout:240000},async t=>{
 const f=await require('../helpers/agent-rfq-fixture').fixture(t,'enterprise'),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service'),skuIds=[f.item.skuIds[0]];
 for(let n=1;n<100;n++){const item=await catalog.createItem(db,ctx,{name:'RFQ volume product '+n,baseCode:'RFQ-VOLUME-'+n,trackingMode:'quantity'});skuIds.push(item.skuIds[0]);}
 await db.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,minimum_order_quantity,order_multiple,created_at,updated_at)
  SELECT 'rfq-volume-'||s.id||'-'||v.id,$1,v.id,s.id,1,1,now()::text,now()::text FROM skus s CROSS JOIN suppliers v
  WHERE s.workspace_id=$1 AND v.workspace_id=$1 AND s.id=ANY($2::text[]) AND v.id=ANY($3::text[]) ON CONFLICT(workspace_id,supplier_id,sku_id) DO NOTHING`,[ctx.workspaceId,skuIds,f.supplierIds]);
 const lines=skuIds.map(skuId=>({skuId,quantity:10})),p=await f.preview({lines}),before=await f.balance(),batch=await f.send(p);assert.equal(batch.deliveries.length,3);await f.deliver();assert.equal(f.sent.length,3);
 for(const message of f.sent){assert.equal((message.body.match(/Requested: 10 /g)||[]).length,100);for(let n=1;n<100;n++)assert(message.body.includes('RFQ-VOLUME-'+n+' · RFQ volume product '+n));}
 await f.send(p);await f.deliver();assert.equal(f.sent.length,3);assert.equal(await f.balance(),before);assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_rfq_requests WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
});
test('an RFQ asks suppliers for unconfirmed product and pack terms without inventing defaults or writing supplier links', {timeout:240000},async t=>{
 const f=await require('../helpers/agent-rfq-fixture').fixture(t,'enterprise'),{db,ctx}=f,item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'New quoted product',baseCode:'RFQ-UNKNOWN-TERMS',trackingMode:'quantity'});
 const p=await f.preview({lines:[{skuId:item.skuIds[0],quantity:7}]});assert(p.snapshot.links.every(l=>l.purchase_unit===null&&l.units_per_purchase_unit===null&&l.minimum_order_quantity===null));
 const rule=await f.service.configure(db,ctx,p.id,{confirmed:'yes',maxRequestsPerWeek:1});await f.service.sendAutomatic(db,ctx,p.id,rule.id);await f.deliver();assert.equal(f.sent.length,3);
 for(const message of f.sent){assert.match(message.body,/Requested: 7 /);assert.match(message.body,/Purchase pack not confirmed/);assert.match(message.body,/Minimum order quantity not confirmed/);assert.match(message.body,/confirm that you can supply this exact product/);assert.doesNotMatch(message.body,/NaN|Infinity|7 null|7 undefined/);}
 assert.equal((await db.query('SELECT count(*)::int n FROM supplier_items WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,item.skuIds[0]])).rows[0].n,0);
});

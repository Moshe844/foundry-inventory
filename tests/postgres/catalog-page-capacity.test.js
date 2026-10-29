'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('catalogue pages preserve stock truth, stable continuation and variant totals',{timeout:180000},async t=>{
 const {db,ctx,item,location}=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:7});
 const catalog=require('../../src/domain/postgres-catalog-service'),at=new Date().toISOString();
 await db.query(`INSERT INTO items(id,workspace_id,name,tracking_mode,is_active,created_at,updated_at)
  SELECT 'page-item-'||n,$1,'Duplicate name','quantity',1,$2,$2 FROM generate_series(1,1200)n`,[ctx.workspaceId,at]);
 await db.query(`INSERT INTO skus(id,workspace_id,item_id,code,position,is_active,created_at)
  SELECT 'page-sku-'||n,$1,'page-item-'||n,'PAGE-'||n,0,1,$2 FROM generate_series(1,1200)n`,[ctx.workspaceId,at]);
 const ids=new Set();let afterItemId,page=1;
 do {const result=await catalog.listItems(db,ctx.workspaceId,{q:'Duplicate name',pageSize:100,page,afterItemId});
  for(const row of result.items){assert(!ids.has(row.id),'Duplicate across cursor pages');ids.add(row.id);assert.equal(row.sku_count,1);assert.equal(row.on_hand,0);}
  afterItemId=result.nextAfterItemId;page++;
 } while(afterItemId);
 assert.equal(ids.size,1200);
 const newest=await catalog.listItems(db,ctx.workspaceId,{sort:'newest',pageSize:10}),next=await catalog.listItems(db,ctx.workspaceId,{sort:'newest',pageSize:10,afterItemId:newest.nextAfterItemId});
 assert(next.items.every(i=>!newest.items.some(p=>p.id===i.id)));
 const available=await catalog.listItems(db,ctx.workspaceId,{group:'healthy',sort:'stock_desc'});
 assert.equal(available.items.length,1);assert.equal(available.items[0].id,item.itemId);assert.equal(available.items[0].on_hand,7);
 assert.equal((await catalog.listItems(db,ctx.workspaceId,{group:'empty',pageSize:10})).items.length,10);
 const detail=await catalog.getItem(db,ctx.workspaceId,item.itemId);assert.equal(detail.total,7);assert.equal(detail.variantTotal,1);assert.equal(detail.skus[0].total,7);
 assert.equal((await catalog.listItems(db,ctx.workspaceId,{locationId:location.id,sort:'stock_desc'})).items[0].on_hand,7);
 await assert.rejects(()=>catalog.listItems(db,ctx.workspaceId,{afterItemId:'not-this-workspace'}),/first page/);
});

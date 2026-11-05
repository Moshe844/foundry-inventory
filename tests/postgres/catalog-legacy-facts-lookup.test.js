'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
test('bounded imported detail lookups preserve legacy field IDs, null locations and document updates',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,imports=require('../../src/imports/postgres-service'),facts=require('../../src/domain/postgres-catalog-facts'),skuId=f.item.skuIds[0];
 const plan=await imports.analyse(db,ctx,{text:'Product,SKU,Quantity\nParcel item,'+f.item.skuIds[0]+',0',allowModel:false});
 await db.query("INSERT INTO catalog_source_facts(id,workspace_id,sku_id,name,value,source_import_id,source_row,updated_at) VALUES('legacy-flavor',$1,$2,'Flavor','Original',$3,2,now())",[ctx.workspaceId,skuId,plan.id]);
 const save=inputs=>db.transaction(c=>facts.saveManyInTransaction(c,ctx,inputs.map(input=>({skuId,importId:plan.id,rowNumber:2,...input}))));
 await save([{name:'Flavor',value:'Vanilla'},{name:'Bag size',value:'1kg'}]);await save([{locationId:f.location.id,name:'Flavor',value:'Chocolate'}]);await save([{name:'Bag size',value:'250g'}]);
 const legacy=(await db.query("SELECT id,value FROM catalog_source_facts WHERE id='legacy-flavor'")).rows[0];assert.deepEqual(legacy,{id:'legacy-flavor',value:'Vanilla'});
 const rows=await facts.listForSkus(db,ctx.workspaceId,[skuId]);assert.equal(rows.filter(r=>r.name==='Flavor'&&r.location_id===null).length,1);assert.equal(rows.find(r=>r.name==='Bag size').value,'250g');assert.equal(rows.find(r=>r.name==='Flavor'&&r.location_id===f.location.id).value,'Chocolate');
 await assert.rejects(save([{locationId:'not-this-inventory',name:'Flavor',value:'Forbidden'}]),/must belong to this inventory/);assert.equal((await db.query("SELECT value FROM catalog_source_facts WHERE id='legacy-flavor'")).rows[0].value,'Vanilla');
});

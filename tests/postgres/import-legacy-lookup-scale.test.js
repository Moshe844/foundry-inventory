'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('legacy field updates stay bounded among 50,000 modern source documents under generic and custom plans',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,imports=require('../../src/imports/postgres-service'),facts=require('../../src/domain/postgres-catalog-facts');
 const skuId=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[skuId])).rows[0].code;
 const plan=await imports.analyse(db,ctx,{text:'Name,SKU,Source reference\nParcel item,'+code+',seed',allowModel:false});
 await db.query(`INSERT INTO catalog_source_facts(id,workspace_id,sku_id,location_id,attributes,source_import_id,source_row,updated_at)
  SELECT 'modern-source-'||n,$1,$2,$3,jsonb_build_object('Source reference','receipt-'||n),$4,n,now() FROM generate_series(1,50000)n`,[ctx.workspaceId,skuId,f.location.id,plan.id]);
 await db.query(`INSERT INTO catalog_source_facts(id,workspace_id,sku_id,location_id,name,value,source_import_id,source_row,updated_at)
  VALUES('legacy-source',$1,$2,$3,'Legacy note','Before',$4,1,now())`,[ctx.workspaceId,skuId,f.location.id,plan.id]);
 const filtered=node=>Number(node['Rows Removed by Filter']||0)*Number(node['Actual Loops']||1)+(node.Plans||[]).reduce((n,p)=>n+filtered(p),0);
 for(const mode of ['force_generic_plan','force_custom_plan'])await db.transaction(async c=>{
  await c.query('SET LOCAL plan_cache_mode='+mode);let measured=false;
  await facts.saveManyInTransaction({query:async(sql,args)=>{const result=await c.query(sql,args);
   if(sql.startsWith('SELECT f.id,f.sku_id')){const explained=(await c.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,args)).rows[0]['QUERY PLAN'][0];assert(filtered(explained.Plan)<1000,'Legacy lookup visited the modern document population: '+filtered(explained.Plan));measured=true;}
   return result;
  }},ctx,[{skuId,locationId:f.location.id,importId:plan.id,rowNumber:1,name:'Legacy note',value:mode},{skuId,locationId:f.location.id,importId:plan.id,rowNumber:1,name:'Source reference',value:'Exact updated receipt'}]);
  assert(measured);assert.equal((await c.query("SELECT value FROM catalog_source_facts WHERE id='legacy-source'")).rows[0].value,mode);
  assert.equal((await c.query("SELECT attributes->>'Source reference' value FROM catalog_source_facts WHERE id='modern-source-1'")).rows[0].value,'Exact updated receipt');
 },{isolation:'READ COMMITTED'});
 assert.equal((await db.query('SELECT count(*)::int n FROM catalog_source_facts WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,50001);
 await assert.rejects(db.transaction(c=>facts.saveManyInTransaction(c,{...ctx,workspaceId:'foreign-inventory'},[{skuId,locationId:f.location.id,importId:plan.id,rowNumber:1,name:'Legacy note',value:'Must not save'}])),/belong/);
 assert.equal((await db.query("SELECT value FROM catalog_source_facts WHERE id='legacy-source'")).rows[0].value,'force_custom_plan');
});

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('stock lanes persist parent ownership and consume an indexed source order without gaps or cross-lane replay',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service'),imports=require('../../src/imports/postgres-service'),rows=require('../../src/imports/postgres-row-store');
 const second=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Lane second warehouse',kind:'warehouse'}),definitions=Array.from({length:51},(_,i)=>({name:'Lane product '+i,trackingMode:'quantity',variants:[{key:'a',code:'LANE-'+i+'-A',options:[{name:'Flavor',value:'A'}]},{key:'b',code:'LANE-'+i+'-B',options:[{name:'Flavor',value:'B'}]}]}));
 await db.transaction(c=>catalog.createImportedItemsInTransaction(c,ctx,definitions),{isolation:'READ COMMITTED'});
 const csv=['Product,SKU,Location,Quantity,Unit cost',...definitions.flatMap(p=>p.variants.flatMap(v=>[f.location.name,second.name].map(l=>[p.name,v.code,l,1,'4.50'].join(','))))].join('\n');
 const plan=await imports.analyse(db,ctx,{text:csv,importMode:'add',allowModel:false});assert.equal(plan.recordsValid,204);await imports.approve(db,ctx,plan.id,plan.integrityHash);
 const eligibility=(await db.query('SELECT bool_and(parallel_stock) eligible,count(DISTINCT execution_lane)::int lanes FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2',[ctx.workspaceId,plan.id])).rows[0];assert(eligibility.eligible);assert(eligibility.lanes>1);
 assert.equal((await db.query('SELECT count(*)::int n FROM(SELECT existing_item_id FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2 GROUP BY existing_item_id HAVING count(DISTINCT execution_lane)>1)x',[ctx.workspaceId,plan.id])).rows[0].n,0);
 const all=new Set();
 for(let lane=0;lane<4;lane++){
  const expected=(await db.query(`SELECT row_id FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2 AND execution_lane=$3
   ORDER BY coalesce(existing_item_id,product_key),coalesce(existing_sku_id,product_key||':'||variant_key),row_number,row_id`,[ctx.workspaceId,plan.id,lane])).rows.map(r=>r.row_id),observed=[];
  let cursor;
  for await(const page of rows.executionPages(db,ctx.workspaceId,plan.id,{lane,orderByItem:true,batchSize:7,lock:false})){for(const r of page){assert(!all.has(r.id));all.add(r.id);observed.push(r.id);}cursor=page.at(-1).executionCursor;}
  assert.deepEqual(observed,expected);if(cursor){const next=await rows.executionPages(db,ctx.workspaceId,plan.id,{lane,orderByItem:true,batchSize:7,lock:false,cursor}).next();assert(next.done);}
 }
 assert.equal(all.size,204);await assert.rejects(rows.executionPages(db,ctx.workspaceId,plan.id,{lane:4,orderByItem:true}).next(),/saved stock lane/);
 await db.query("UPDATE import_plans SET apply_checkpoint=jsonb_build_object('stockLaneVersion',1) WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,plan.id]);
 await assert.rejects(db.query('UPDATE import_execution_identities SET execution_lane=(execution_lane+1)%4 WHERE workspace_id=$1 AND import_id=$2',[ctx.workspaceId,plan.id]),/execution order cannot change/);
});

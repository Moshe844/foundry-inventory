'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
test('stock execution uses primary-key source probes at 150,000 rows before statistics refresh',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,imports=require('../../src/imports/postgres-service'),store=require('../../src/imports/postgres-row-store'),sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
 await imports.analyse(db,ctx,{text:'Product,SKU,Quantity,Source reference\nParcel item,'+code+',0,old-source',allowModel:false});
 await db.query('ANALYZE import_rows;ANALYZE import_execution_identities');
 const plan=await imports.analyse(db,ctx,{text:'Product,SKU,Quantity\nParcel item,'+code+',0',allowModel:false});
 for(let start=100;start<150100;start+=5000){
  await db.query(`INSERT INTO import_rows(id,import_id,workspace_id,row_number,raw,parsed,status,problems,created_at)
   SELECT 'stale-stock-'||n,$2,$1,n,'{}','{"trackingMode":"quantity"}','VALID','[]',now() FROM generate_series($3::int,$4::int)n`,[ctx.workspaceId,plan.id,start,start+4999]);
  await db.query(`INSERT INTO import_execution_identities(workspace_id,import_id,row_id,row_number,product_key,variant_key,existing_sku_id)
   SELECT $1,$2,'stale-stock-'||n,n,'product','variant',$3 FROM generate_series($4::int,$5::int)n`,[ctx.workspaceId,plan.id,sku,start,start+4999]);
 }
 const timings=[];
 for(const mode of ['force_generic_plan','force_custom_plan'])await db.transaction(async c=>{
  await c.query('SET LOCAL plan_cache_mode='+mode);let measured=false;
  const reader={query:async(sql,values)=>{const explained=(await c.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+sql,values)).rows[0]['QUERY PLAN'][0],nodes=[];const walk=p=>{nodes.push(p);for(const child of p.Plans||[])walk(child);};walk(explained.Plan);
   const probes=nodes.filter(p=>p['Relation Name']==='import_rows');assert(probes.length);assert(probes.every(p=>p['Index Name']==='import_rows_pkey'),'Frozen source rows must use their unique row IDs regardless of scope statistics');assert(probes.every(p=>p['Actual Rows']<=1&&p['Actual Loops']<=2000));assert(explained['Execution Time']<1500);timings.push({mode,ms:explained['Execution Time']});measured=true;return c.query(sql,values);}};
  let page;for await(const rows of store.executionPages(reader,ctx.workspaceId,plan.id,{orderBySku:true,lock:false,batchSize:2000,cursor:{key:sku,rowNumber:99,rowId:''}})){page=rows;break;}
  assert(measured);assert.equal(page.length,2000);assert.equal(page[0].rowNumber,100);assert.equal(page.at(-1).rowNumber,2099);assert.equal(new Set(page.map(row=>row.id)).size,2000);
 },{readOnly:true,isolation:'REPEATABLE READ',statementTimeoutMs:10000,jit:false});
 t.diagnostic(JSON.stringify({staleSourceRows:150000,primaryKeySourceProbes:true,sourcePageBound:2000,timings,paidCalls:0}));
 });

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
// A business being imported is absent from PostgreSQL's last sample until it is
// analysed again, so the planner estimates it at about one SKU and one product.
// A join planned on that estimate read every product once per SKU: a 60 s search
// and a statement timeout in the parallel-saving check during a 150,000-row
// import. Both now read each product at most once, whatever the statistics say.
test('search, the stock table, the home stock total and the parallel-saving check read each product at most once while a new catalogue is unsampled',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Unsampled catalogue',email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source) VALUES($1,$2,'growth','COMP','CUSTOM','OFFLINE_TEST')",[randomUUID(),owner.accountId]);
 const template=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Template product',baseCode:'TEMPLATE-'+randomUUID().slice(0,6),trackingMode:'quantity'});
 // Sample the catalogue while this business has one product, then add 3,000
 // products with 3 SKUs each that the sample does not know about.
 const place=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Shelf',kind:'warehouse'});
 await db.query('ANALYZE items;ANALYZE skus;ANALYZE item_location_balances;ANALYZE import_execution_identities;ANALYZE import_catalogue_bindings');
 const products=3000,perProduct=3;
 await db.query(`INSERT INTO items SELECT (jsonb_populate_record(NULL::items,to_jsonb(i)||jsonb_build_object('id','unsampled-item-'||n,'name','Unsampled product '||n,'base_code','UNSAMPLED-'||n))).*
  FROM items i CROSS JOIN generate_series(1,$2::int) n WHERE i.id=(SELECT item_id FROM skus WHERE id=$1)`,[template.skuIds[0],products]);
 await db.query(`INSERT INTO skus SELECT (jsonb_populate_record(NULL::skus,to_jsonb(s)||jsonb_build_object('id','unsampled-sku-'||n||'-'||v,'item_id','unsampled-item-'||n,'code','UNSAMPLED-'||n||'-'||v,'barcode',NULL,'variant_label','Size '||v))).*
  FROM skus s CROSS JOIN generate_series(1,$2::int) n CROSS JOIN generate_series(1,$3::int) v WHERE s.id=$1`,[template.skuIds[0],products,perProduct]);
 await db.query(`INSERT INTO item_location_balances(workspace_id,item_id,location_id,on_hand,updated_at) SELECT $1,'unsampled-item-'||n,$2,n,now() FROM generate_series(1,$3::int) n`,[ctx.workspaceId,place.id,products]);
 const plan=await require('../../src/imports/postgres-service').analyse(db,ctx,{text:'Product,SKU,Quantity\nTemplate product,ANY-CODE,1',allowModel:false});
 // Only the synthetic rows below are staged for this import.
 await db.query('DELETE FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2',[ctx.workspaceId,plan.id]);
 await db.query(`INSERT INTO import_rows(id,import_id,workspace_id,row_number,raw,parsed,status,problems,created_at)
  SELECT 'unsampled-row-'||n||'-'||v,$2,$1,(n-1)*$4+v+1000,'{}','{"trackingMode":"quantity"}','VALID','[]',now() FROM generate_series(1,$3::int) n CROSS JOIN generate_series(1,$4::int) v`,[ctx.workspaceId,plan.id,products,perProduct]);
 await db.query(`INSERT INTO import_execution_identities(workspace_id,import_id,row_id,row_number,product_key,variant_key,existing_sku_id)
  SELECT $1,$2,'unsampled-row-'||n||'-'||v,(n-1)*$4+v+1000,'product-'||n,'variant-'||v,CASE WHEN n%2=1 THEN 'unsampled-sku-'||n||'-'||v END FROM generate_series(1,$3::int) n CROSS JOIN generate_series(1,$4::int) v`,[ctx.workspaceId,plan.id,products,perProduct]);
 // Half the SKUs are new to this import and are found through its catalogue bindings.
 await db.query(`INSERT INTO import_catalogue_bindings(workspace_id,import_id,product_key,variant_key,item_id,sku_id)
  SELECT $1,$2,'product-'||n,'variant-'||v,'unsampled-item-'||n,'unsampled-sku-'||n||'-'||v FROM generate_series(2,$3::int,2) n CROSS JOIN generate_series(1,$4::int) v`,[ctx.workspaceId,plan.id,products,perProduct]);
 // Every planned node over products or SKUs either runs once or reads one key per loop,
 // and products are looked up at most once per SKU of the business.
 const lookups=Number((await db.query('SELECT count(*) AS n FROM skus WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n)+Number((await db.query('SELECT count(*) AS n FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2',[ctx.workspaceId,plan.id])).rows[0].n);
 const shapes=[];
 function inspect(name,plan){const nodes=[];const walk=p=>{nodes.push(p);for(const child of p.Plans||[])walk(child);};walk(plan);
  for(const node of nodes.filter(p=>['items','skus','import_catalogue_bindings'].includes(p['Relation Name'])&&p['Actual Loops']>1)){
   const perLoop=Number(node['Actual Rows']),removed=Number(node['Rows Removed by Filter']||0);
   shapes.push({name,relation:node['Relation Name'],loops:node['Actual Loops'],perLoop,removed});
   assert(perLoop<=perProduct&&removed<=1,`${name}: ${node['Relation Name']} was scanned ${node['Actual Loops']} times, reading ${perLoop+removed} rows each`);}
  assert(nodes.filter(p=>p['Relation Name']==='items').every(p=>p['Actual Loops']<=lookups),name+': products read more than once per SKU '+JSON.stringify(nodes.filter(p=>p['Relation Name']==='items').map(p=>[p['Node Type'],p['Index Name'],p['Actual Loops'],p['Actual Rows']])));}
 const explaining=(name,client,match)=>{const reader={query:async(sql,values)=>{if(String(sql).includes(match)){const e=(await client.query('EXPLAIN(ANALYZE,FORMAT JSON) '+sql,values)).rows[0]['QUERY PLAN'][0];inspect(name,e.Plan);}return client.query(sql,values);},transaction:fn=>fn(reader)};return reader;};
 for(const mode of ['force_generic_plan','force_custom_plan'])await db.transaction(async c=>{
  await c.query('SET LOCAL plan_cache_mode='+mode);
  const reader=explaining('parallel-saving check '+mode,c,'existing_sku_id');
  assert.equal(await require('../../src/imports/postgres-stock-lanes').unsafeCatalogue(reader,ctx.workspaceId,plan.id),false);
  const search=require('../../src/domain/postgres-search-service');
  // The home page stock total and the stock table read every product of the business.
  const totals=await require('../../src/domain/stock-totals').forBusiness(explaining('home stock total '+mode,c,'item_location_balances r'),ctx.workspaceId);
  assert.equal(totals.units,products*(products+1)/2);
  const table=await require('../../src/domain/postgres-flat-catalog').list(explaining('stock table '+mode,c,'matching AS MATERIALIZED'),ctx.workspaceId,{page:1});
  assert.equal(table.totalCount,products*perProduct+1);assert.equal(table.items.length,25);
  for(const term of ['SKU','Unsampled product 12','UNSAMPLED-7-2']){
   const result=await search.search(explaining('search '+term+' '+mode,c,'ILIKE'),ctx.workspaceId,term,{limit:100});
   if(term==='SKU')assert.equal(result.results.filter(r=>r.type==='sku'||r.type==='variant').length,0);
   else assert(result.results.length>0,'search found '+term);
  }
 },{readOnly:true,isolation:'REPEATABLE READ',statementTimeoutMs:20000,jit:false});
 t.diagnostic(JSON.stringify({unsampledProducts:products,unsampledSkus:products*perProduct,repeatedNodes:shapes.length,shapes:shapes.slice(0,6)}));
});

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('report cards share exact complete totals without rereading current data',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,reports=require('../../src/reports/postgres-service'),actor={role:'owner'};
 const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Coffee totals',baseCode:'SHARED-TOTALS',trackingMode:'quantity',hasVariants:true,options:[{name:'Flavor',values:Array.from({length:18},(_,i)=>'Blend '+i).join(',')}],purchaseCost:'1.25'});
 await db.transaction(async c=>{for(const skuId of item.skuIds)await require('../../src/accounting/postgres-stock-receipt').receiveInTransaction(c,ctx,{skuId,locationId:f.location.id,quantity:1,idempotencyKey:'shared-'+skuId});});
 const queries=[],observed={query:db.query.bind(db),transaction:(fn,options)=>db.transaction(c=>fn(new Proxy(c,{get(target,key){if(key==='query')return(sql,values)=>{if(sql.startsWith('WITH source AS'))queries.push({sql,values});return target.query(sql,values);};return Reflect.get(target,key);}})),options)};
 await t.test('a top twelve stock chart includes every variant in its exact total',async()=>{
  const config={dataset:'inventory_valuation',groups:['sku'],aggregate:'sum',measure:'book_cost_minor',filters:[{field:'currency',operator:'equals',value:'USD'}],sort:'total',direction:'desc',topN:12};
  const result=await reports.run(observed,ctx,actor,config,{limit:13,includeOverall:true});
  assert.equal(result.rows.length,12);assert.equal(Number(result.overall.value),2650);assert.equal(result.overall.display,'$26.50');
  assert(result.rows.reduce((n,r)=>n+Number(r.total),0)<2650);assert(result.rows.every(r=>!Object.hasOwn(r,'__report_overall')));assert(!result.columns.includes('__report_overall'));
  const before=queries.length,total=await reports.totals(observed,ctx,actor,result.config,{currentResult:result});assert.equal(queries.length,before,'A comparison must reuse its native current result');assert.equal(total.metrics[0].value,2650);assert.equal(total.metrics[0].display,'$26.50');
  const narrowed={...result.config,filters:[...result.config.filters,{field:'sku',operator:'equals',value:result.rows[0].sku}]},fallback=await reports.totals(observed,ctx,actor,narrowed,{currentResult:result});assert(queries.length>before,'Different filters require their own exact read');assert.equal(fallback.metrics[0].value,400);
 });
 await t.test('a limited detail table counts the full population, including low-stock positions',async()=>{
  const at=new Date().toISOString();await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,lead_time_days,source,created_at,updated_at)
   SELECT 'shared-'||s.id,s.workspace_id,s.id,$2,2,5,0,0,'manual',$3,$3 FROM skus s WHERE s.workspace_id=$1 AND s.item_id=$4`,[ctx.workspaceId,f.location.id,at,item.itemId]);
  const result=await reports.run(observed,ctx,actor,{dataset:'low_stock',columns:['sku','on_hand']},{limit:13,includeOverall:true});assert.equal(result.rows.length,12);assert.equal(Number(result.overall.value),18);assert(result.hasMore);
 });
 await t.test('comparison reads only the previous window and preserves zero and fractional amounts',async()=>{
  const config={dataset:'movements',groups:['occurred_on'],aggregate:'sum',measure:'quantity_delta',filters:[{field:'occurred_on',operator:'after',value:'2026-01-01'},{field:'occurred_on',operator:'before',value:'2026-01-31'}]};
  await require('../../src/domain/postgres-inventory-engine').receive(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1,occurredAt:'2026-01-15T12:00:00Z',idempotencyKey:'shared-january'});
  await require('../../src/domain/postgres-inventory-engine').receive(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:2,occurredAt:'2025-12-15T12:00:00Z',idempotencyKey:'shared-december'});
  const before=queries.length,result=await reports.run(observed,ctx,actor,config,{includeOverall:true}),totals=await reports.totals(observed,ctx,actor,{...result.config,compare:'previous_period'},{currentResult:result});
  assert.equal(queries.length-before,2,'One chart read and one previous-period read, without a current summary scan');assert.equal(totals.metrics[0].value,1);assert.equal(totals.metrics[0].change,-50);
  const empty=await reports.run(observed,ctx,actor,{...config,filters:[{field:'occurred_on',operator:'equals',value:'1700-01-01'}]},{includeOverall:true});assert.equal(empty.overall.value,null);assert.deepEqual(empty.rows,[]);
 });
 await t.test('foreign totals and forged serialized results cannot replace scoped native reads',async()=>{
  const result=await reports.run(observed,ctx,actor,{dataset:'catalogue',columns:['sku']},{limit:3,includeOverall:true});assert.equal(Number(result.overall.value),19);
  const forged=JSON.parse(JSON.stringify(result));forged.overall.value='999999';const before=queries.length,total=await reports.totals(observed,ctx,actor,{...result.config,columns:[],summary:true},{currentResult:forged});assert(queries.length>before);assert.equal(total.metrics[0].value,19);
  const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other',businessName:'Empty other inventory',email:require('node:crypto').randomUUID()+'@example.test',password:require('node:crypto').randomUUID()+'!A'}),foreign={workspaceId:other.workspaceId,actorId:other.userId};
  const empty=await reports.totals(observed,foreign,actor,{...result.config,columns:[],summary:true},{currentResult:result});assert.equal(empty.metrics[0].value,0);
  await assert.rejects(reports.totals(observed,ctx,{role:'viewer',permissions:'[]'},{...result.config,columns:[],summary:true},{currentResult:result}));
 });
 await t.test('the complete report dashboard has two concurrent card reads and no duplicate current summaries',async()=>{
  let active=0,peak=0,reads=0;const bounded={query:db.query.bind(db),transaction:(fn,options)=>db.transaction(c=>fn(new Proxy(c,{get(target,key){if(key==='query')return async(sql,values)=>{if(!sql.startsWith('WITH source AS'))return target.query(sql,values);active++;reads++;peak=Math.max(peak,active);try{return await target.query(sql,values);}finally{active--;}};return Reflect.get(target,key);}})),options)};
  const cards=await require('../../src/reports/business-reports').cards(bounded,ctx,actor,{});
  assert.equal(cards.length,9);assert.equal(cards.find(c=>c.key==='stock-value').value,'$26.50');assert.equal(cards.find(c=>c.key==='low-stock').value,'18 items');assert(peak<=2);assert(reads<=16,'Nine charts and seven previous-period summaries need at most sixteen data reads');
 });
});

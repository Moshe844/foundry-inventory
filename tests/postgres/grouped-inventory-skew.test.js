'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest');
test('grouped and flat inventory stay bounded with 52,500 variants concentrated in 25 products',{timeout:300000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,source) VALUES('dense-plan',$1,'pro','approved-2026-11-02:pro','COMP','CUSTOM','ISOLATED_TEST')",[f.owner.accountId]);
 await db.query("INSERT INTO items(id,workspace_id,name,tracking_mode,unit_label,has_variants,created_at,updated_at) SELECT 'dense-item-'||n,$1,'Dense product '||lpad(n::text,2,'0'),'quantity','unit',1,now(),now() FROM generate_series(0,24)n",[ctx.workspaceId]);
 for(let first=0;first<52500;first+=1000)await db.query("INSERT INTO skus(id,workspace_id,item_id,code,position,created_at) SELECT 'dense-sku-'||n,$1,'dense-item-'||(n/2100),'DENSE-'||n,n%2100,now() FROM generate_series($2::int,$3::int)n",[ctx.workspaceId,first,Math.min(52499,first+999)]);
 for(let first=0;first<52500;first+=1000)await db.query("INSERT INTO reorder_policies(id,workspace_id,sku_id,reorder_point,target_stock,source,created_at,updated_at) SELECT 'dense-rule-'||n,$1,'dense-sku-'||n,1,2,'manual',now(),now() FROM generate_series($2::int,$3::int)n",[ctx.workspaceId,first,Math.min(52499,first+999)]);
 const ids=Array.from({length:25},(_,n)=>'dense-item-'+n),badges=require('../../src/reports/postgres-low-stock-badges');
 for(const mode of ['force_generic_plan','force_custom_plan']){const began=performance.now(),rows=await db.transaction(async c=>{await c.query('SET LOCAL plan_cache_mode='+mode);return badges.forItems(c,ctx.workspaceId,ids);},{readOnly:true,statementTimeoutMs:1500});assert.equal(rows.length,25);assert(performance.now()-began<1500);}
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'dense-catalogue-fixture'});f.cleanup(()=>app.locals.sessionStore.close());const agent=request.agent(app),login=await agent.get('/login'),csrf=/name="_csrf" value="([^"]+)"/.exec(login.text)[1];await agent.post('/login').type('form').send({_csrf:csrf,email:f.email,password:f.password});
 const timings={};for(const url of ['/inventory?q=Dense','/inventory/table?view=flat&q=Dense','/inventory?lowStock=1&q=Dense','/inventory/table?view=flat&lowStock=1&q=Dense']){const began=performance.now(),page=await agent.get(url);timings[url]=Math.round(performance.now()-began);assert.equal(page.status,200,url);assert.match(page.text,/Dense product/);assert.doesNotMatch(page.text,/Something went wrong|temporarily unavailable/);assert(timings[url]<5000,url+' must not scan an inventory-wide report for every parent');}
 // One healthy parent must lose its badge; 2,100 healthy variants remain exact.
 await db.query("INSERT INTO balances(workspace_id,sku_id,location_id,on_hand,updated_at) SELECT $1,id,$2,3,now() FROM skus WHERE workspace_id=$1 AND item_id='dense-item-0'",[ctx.workspaceId,f.location.id]);
 const now=await badges.forItems(db,ctx.workspaceId,['dense-item-0','dense-item-1']);assert.deepEqual(now,[{record_id:'dense-item-1'}]);assert.equal((await badges.forSkus(db,ctx.workspaceId,['dense-sku-0','dense-sku-2100'])).length,1);
 const flat=require('../../src/domain/postgres-flat-catalog'),catalog=require('../../src/domain/postgres-catalog-service');
 // Autovacuum can update these estimates between otherwise identical page
 // requests. Both states must remain bounded, including Linux's default JIT.
 for(const statistics of ['fresh-import','analyzed']){
  if(statistics==='analyzed')await db.query('ANALYZE skus,items,reorder_policies,balances');
  for(const mode of ['force_generic_plan','force_custom_plan'])await t.test(statistics+' low-stock pages under '+mode,async()=>{let failedQuery;try{await db.transaction(async c=>{
   await c.query('SET LOCAL plan_cache_mode='+mode);await c.query('SET LOCAL jit=on');
   const observed={query:(sql,values)=>{failedQuery={sql,values};return c.query(sql,values);}};
   assert.equal((await flat.list(observed,ctx.workspaceId,{lowStock:true})).totalCount,50400);
   assert.equal((await catalog.listItems(observed,ctx.workspaceId,{lowStock:true})).totalCount,24);
  },{readOnly:true,statementTimeoutMs:2000});}catch(error){
   t.diagnostic(JSON.stringify({failureCode:error.code,statistics,mode,sql:failedQuery?.sql,values:failedQuery?.values}));
   for(const jit of ['on','off'])try{await db.transaction(async c=>{
    await c.query('SET LOCAL plan_cache_mode='+mode);await c.query('SET LOCAL jit='+jit);
    const info=(await c.query("SELECT version(),pg_jit_available(),current_setting('work_mem') work_mem")).rows[0],plan=(await c.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+failedQuery.sql,failedQuery.values)).rows[0]['QUERY PLAN'][0],nodes=[];
    const visit=n=>{nodes.push({node:n['Node Type'],relation:n['Relation Name'],index:n['Index Name'],sub:n['Subplan Name'],rows:n['Actual Rows'],loops:n['Actual Loops'],cost:n['Total Cost'],estimatedRows:n['Plan Rows'],ms:n['Actual Total Time'],read:n['Shared Read Blocks'],temp:n['Temp Written Blocks'],filter:n.Filter});for(const child of n.Plans||[])visit(child);};visit(plan.Plan);
    t.diagnostic(JSON.stringify({statistics,mode,jit,info,ms:plan['Execution Time'],compilation:plan.JIT,nodes}));
   },{readOnly:true,statementTimeoutMs:10000});}catch(diagnosticError){t.diagnostic(JSON.stringify({statistics,mode,jit,diagnosticError:diagnosticError.code||diagnosticError.message}));}
   throw error;
  }});
 }
 assert.deepEqual(await badges.forItems(db,'foreign-inventory',ids),[]);
 t.diagnostic(JSON.stringify({products:25,variants:52500,zeroStockDoesNotScanVariantCrossProducts:true,timings,paidCalls:0}));
});

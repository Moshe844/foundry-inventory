'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const count=Number(process.env.STOCKCHIEF_STOCK_THROUGHPUT_ROWS||150000);
test('stock-count import preserves opening value and meets the 150k-row throughput target',{skip:process.env.STOCKCHIEF_RUN_STOCK_THROUGHPUT!=='1',timeout:30*60*1000},async t=>{
 assert(Number.isSafeInteger(count)&&count>=1000&&count<=150000);
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Scale owner',businessName:'Stock throughput',email:randomUUID()+'@example.test',password:randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('stock-throughput',$1,'enterprise','COMP','ISOLATED_TEST')",[owner.accountId]);
 await require('../../src/accounting/postgres-ledger').configure(db,ctx,{currency:'USD',startDate:'2026-01-01'});await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Main',kind:'warehouse'});
 const profile=new Map();if(process.env.STOCKCHIEF_PROFILE_STOCK==='1'){
  const wrap=q=>({query:async(sql,args)=>{const start=performance.now();try{return await q.query(sql,args);}finally{const key=String(sql).replace(/\s+/g,' ').slice(0,160),old=profile.get(key)||{calls:0,ms:0,maxMs:0};const ms=performance.now()-start;old.calls++;old.ms+=ms;old.maxMs=Math.max(old.maxMs,ms);profile.set(key,old);}}});
  const query=db.query.bind(db),transaction=db.transaction.bind(db),lock=db.withSessionLock.bind(db);db.query=wrap({query}).query;db.transaction=(fn,settings)=>transaction(c=>fn(wrap(c)),settings);db.withSessionLock=(key,fn)=>lock(key,scoped=>fn({...scoped,query:wrap(scoped).query,transaction:(callback,settings)=>scoped.transaction(c=>callback(wrap(c)),settings)}));
  t.after(()=>console.log(JSON.stringify({queryProfile:[...profile].sort((a,b)=>b[1].ms-a[1].ms).slice(0,20)})));
 }
 const seedCount=Number(process.env.STOCKCHIEF_STOCK_THROUGHPUT_CATALOGUE||count);assert(Number.isSafeInteger(seedCount)&&seedCount>=count&&seedCount<=150000);
 const at=new Date().toISOString();await db.query("INSERT INTO items(id,workspace_id,name,base_code,tracking_mode,is_active,created_at,updated_at) SELECT 'bench-item-'||n,$1,'Product '||n,'BENCH-'||n,'quantity',1,$2,$2 FROM generate_series(1,$3::int)n",[ctx.workspaceId,at,seedCount]);
 await db.query("INSERT INTO skus(id,workspace_id,item_id,code,is_default,is_active,created_at) SELECT 'bench-sku-'||n,$1,'bench-item-'||n,'BENCH-'||n,1,1,$2 FROM generate_series(1,$3::int)n",[ctx.workspaceId,at,seedCount]);
 const text='Name,SKU,Location,Quantity,Cost\n'+Array.from({length:count},(_,i)=>'Product '+(i+1)+',BENCH-'+(i+1)+',Main,10,95').join('\n');
 const imports=require('../../src/imports/postgres-service'),started=performance.now();let last=-1;
 const progress=p=>{const n=Number(p.processedRows||0),bucket=Math.floor(n/10000);if(bucket!==last){last=bucket;console.log(JSON.stringify({stage:p.stage,rows:n,total:count,elapsedMs:Math.round(performance.now()-started)}));}};
 let plan=await imports.analyse(db,ctx,{text,allowModel:false,onProgress:progress});assert.equal(plan.recordsValid,count);
 plan=await imports.revise(db,ctx,plan.id,{expectedHash:plan.integrityHash,importMode:'set'},{onProgress:progress});await imports.approve(db,ctx,plan.id,plan.integrityHash);
 const executionStarted=performance.now(),result=await imports.execute(db,ctx,plan.id,{onProgress:progress});assert(result.verified);assert.equal(result.rowsImported,count);assert.equal(result.units,count*10);
 const executionMs=Math.round(performance.now()-executionStarted),totalMs=Math.round(performance.now()-started);
 const row=(await db.query('SELECT sum(quantity_units)::text quantity,sum(total_cost_minor)::text value FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];assert.equal(row.quantity,String(count*10));assert.equal(row.value,String(count*95000));
 const pnl=await require('../../src/accounting/postgres-reports').profitAndLoss(db,ctx.workspaceId,{from:'2026-01-01',to:'2026-12-31'});assert.equal(pnl.netIncomeMinor,0);assert((await imports.execute(db,ctx,plan.id)).duplicate);
 console.log(JSON.stringify({rows:count,executionMs,totalMs,stockUnits:count*10,valueMinor:count*95000,profitMinor:0,replaySafe:true,paidCalls:0,underFiveMinutes:totalMs<300000}));
 if(count===150000)assert(totalMs<300000,'150,000 rows exceeded five minutes: '+totalMs+' ms including preview/review and execution');
});

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('native import workers reserve pool capacity for lease renewals and safely reduce parallelism in small pools',{timeout:180000},async t=>{
 const old=process.env.FOUNDRY_IMPORT_STOCK_WORKERS;process.env.FOUNDRY_IMPORT_STOCK_WORKERS='2';t.after(()=>{if(old===undefined)delete process.env.FOUNDRY_IMPORT_STOCK_WORKERS;else process.env.FOUNDRY_IMPORT_STOCK_WORKERS=old;});
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{ctx}=f;
 const definitions=Array.from({length:501},(_,i)=>({name:'Native lane '+i,trackingMode:'quantity',variants:Array.from({length:10},(_,v)=>({key:'v'+v,code:'NL-'+i+'-'+v,options:[{name:'Flavor',value:String(v)}]}))}));
 for(let n=0;n<definitions.length;n+=100)await f.db.transaction(c=>require('../../src/domain/postgres-catalog-service').createImportedItemsInTransaction(c,ctx,definitions.slice(n,n+100)),{isolation:'READ COMMITTED'});
 const imports=require('../../src/imports/postgres-service'),queue=require('../../src/operations/postgres-job-queue'),facts=require('../../src/domain/postgres-catalog-facts');let expected=0;
 for(const max of [2,3,5])await t.test('pool '+max,async()=>{
  const db=require('../../src/db/postgres').openPostgres(f.cluster.connectionString,{max});
  const original=facts.saveManyInTransaction;let held=0,release,timer;const gate=new Promise(r=>release=r),concurrent=max===2?1:2;
  try{
   const text=['Product,SKU,Location,Quantity,Unit cost,Source reference',...definitions.flatMap(p=>p.variants.map(v=>[p.name,v.code,'Dispatch',1,'4.50',v.code+'-pool-'+max].join(',')))].join('\n');
   const plan=await imports.analyse(db,ctx,{text,importMode:'add',allowModel:false});assert.equal(plan.recordsValid,5010);await imports.approve(db,ctx,plan.id,plan.integrityHash);const queued=await imports.queueExecution(db,ctx,plan.id,plan.integrityHash);
   facts.saveManyInTransaction=async(...args)=>{if(held<concurrent){held++;if(held===concurrent)timer=setTimeout(release,2500);await gate;}return original(...args);};
   const outcome=await queue.processOne(db,require('../../src/operations/postgres-runtime-handlers').create(),{owner:'native-stock-lane-pool-'+max,leaseMs:1500,kinds:['import.execute-approved']});
   assert.equal(held,concurrent);assert.equal(outcome.status,'COMPLETED');const saved=await queue.get(db,queued.job.id,ctx.workspaceId);assert(saved.result.verified);assert.equal(saved.result.stockLanes,4);assert.equal(saved.result.rowsImported,5010);
   expected+=5010;assert.equal((await db.query('SELECT sum(on_hand)::text units FROM balances WHERE workspace_id=$1 AND sku_id<>$2',[ctx.workspaceId,f.item.skuIds[0]])).rows[0].units,String(expected));
  }finally{clearTimeout(timer);release();facts.saveManyInTransaction=original;await db.close();}
 });
});

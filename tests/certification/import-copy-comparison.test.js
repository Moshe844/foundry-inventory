'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');

test('same 50,000-SKU / 150,000 mixed stock rows retain exact receipts through the selected staging path',{
 skip:process.env.STOCKCHIEF_COPY_BENCHMARK!=='1',timeout:900000,
},async t=>{
 const mode=process.env.STOCKCHIEF_COPY_BENCHMARK_MODE||(process.env.STOCKCHIEF_IMPORT_COPY==='true'?'copy':'baseline');
 assert(['baseline','copy'].includes(mode));
 const copy=require('../../src/db/postgres-copy'),original=copy.copyFrom;
 let phase='setup',calls=0,stockCalls=0,copyMs=0;
 copy.copyFrom=async(...args)=>{const started=performance.now();calls++;if(phase==='stock-analysis')stockCalls++;try{return await original(...args);}finally{copyMs+=performance.now()-started;}};
 t.after(()=>{copy.copyFrom=original;});
 let previous='';const started=performance.now();
 const diagnostics=process.env.STOCKCHIEF_COPY_DIAGNOSTICS==='1';
 let tracing;
 t.after(async()=>{await tracing?.cancel();});
 const f=await require('../helpers/round17-large-business').fixture(t,{
 trackFunctions:diagnostics?'all':'none',
 beforeStock:async db=>{
  if(!diagnostics)return;
  tracing=await require('../helpers/import-benchmark-diagnostics').start(db,process.env.STOCKCHIEF_COPY_BENCHMARK_OUTPUT,mode);
 },
 afterStock:async()=>{
  if(!diagnostics)return;
  console.log('COPY_DIAGNOSTICS '+JSON.stringify(await tracing.finish()));
 },
 onProgress:(next,p)=>{
  phase=next;
  const bucket=Math.floor(Number(p.processedRows||p.preparedRows||0)/25000),key=next+':'+p.stage+':'+bucket;
  if(key!==previous){previous=key;console.log(JSON.stringify({mode,phase:next,stage:p.stage,rows:p.processedRows||p.preparedRows||0,elapsedMs:Math.round(performance.now()-started)}));}
 }});
 assert.equal(f.stockPlan.recordsValid,150000);assert.equal(f.stockPlan.recordsInvalid,0);
 assert.deepEqual(f.actual,{suppliers:200,positions:150000,units:'1500000',value_minor:'300000000'});
 assert.equal(f.importBatchVerification.batchReconciliations,f.importBatchVerification.receiptBatches);
 assert.equal(f.importBatchVerification.finalCanonicalReconciliations,0);
 if(process.env.STOCKCHIEF_IMPORT_COPY==='true')assert(stockCalls>0,'The large stock analysis must actually use COPY; a wrapper cannot silently discard the transaction stream capability.');
 else assert.equal(calls,0);
 const reference=process[Symbol.for('stockchief.importCpuReference')];
 if(process.env.STOCKCHIEF_COPY_REFERENCE==='1'){
  if(mode==='baseline'){assert.equal(reference?.commit,'72cc228dd5e2e6c706f04bebc9c4285ff4fc54eb');assert.deepEqual([...reference.loadedFiles].sort(),['src/domain/exact-quantity.js','src/imports/postgres-service.js']);}
  else assert.equal(reference,undefined,'The optimized process must execute the current source.');
 }
 console.log('COPY_BENCHMARK '+JSON.stringify({mode,stockWorkers:Number(process.env.FOUNDRY_IMPORT_STOCK_WORKERS||0),products:5000,skus:50000,warehouses:5,openingStockRows:150000,
  catalogueSourceHash:f.plan.sourceHash,stockSourceHash:f.stockPlan.sourceHash,catalogueMs:Math.round(f.catalogueMs),stockImportMs:Math.round(f.stockImportMs),
  fixtureMs:Math.round(performance.now()-started),copyCalls:calls,stockCopyCalls:stockCalls,copyMs:Math.round(copyMs),
  actual:f.actual,verification:f.importBatchVerification,hosted:false,includesSourceTransfer:false,paidCalls:0}));
});

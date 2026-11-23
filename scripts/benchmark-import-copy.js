'use strict';
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),directory=path.resolve(process.env.STOCKCHIEF_COPY_BENCHMARK_OUTPUT||path.join(root,'output/aws-import-copy-comparison'));
fs.mkdirSync(directory,{recursive:true});

async function run(mode){
 const filename=path.join(directory,mode+'.log'),log=fs.createWriteStream(filename);
 const reference=process.env.STOCKCHIEF_COPY_REFERENCE==='1';
 const child=spawn(process.execPath,[...(reference&&mode==='baseline'?['--require','./tests/helpers/import-cpu-reference.cjs']:[]),'--max-old-space-size=1536','--test','--test-concurrency=1','tests/certification/import-copy-comparison.test.js'],{
  cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'test',FOUNDRY_SKIP_LOCAL_ENV:'1',
   STOCKCHIEF_COPY_BENCHMARK:'1',STOCKCHIEF_IMPORT_PROFILE:'1',STOCKCHIEF_COPY_BENCHMARK_MODE:mode,STOCKCHIEF_IMPORT_COPY:reference||mode==='copy'?'true':'false',
   STOCKCHIEF_COPY_BENCHMARK_OUTPUT:directory,FOUNDRY_IMPORT_STOCK_WORKERS:mode==='copy'?'4':reference?'3':'0'},
 });
 let pending='',result;
 const consume=chunk=>{
  log.write(chunk);process.stdout.write(chunk);pending+=chunk.toString('utf8');
  const lines=pending.split('\n');pending=lines.pop();
  for(const line of lines){const at=line.indexOf('COPY_BENCHMARK ');if(at>=0)result=JSON.parse(line.slice(at+'COPY_BENCHMARK '.length));}
 };
 child.stdout.on('data',consume);child.stderr.on('data',chunk=>{log.write(chunk);process.stderr.write(chunk);});
 try{
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(mode+' benchmark failed: '+(signal||code))));});
  if(!result)throw new Error(mode+' benchmark produced no verified result.');
  return result;
 }finally{await new Promise(resolve=>log.end(resolve));}
}

async function main(){
 // Fresh Node processes and freshly initialized databases on the same CI
 // machine prevent module warm-up or another runner from becoming the result.
 const baseline=await run('baseline'),copy=await run('copy');
 for(const key of ['catalogueSourceHash','stockSourceHash','products','skus','warehouses','openingStockRows'])assert.equal(copy[key],baseline[key],key+' must match before and after');
 assert.deepEqual(copy.actual,baseline.actual);
 for(const key of ['batchVerificationRows','finalCanonicalReconciliations','exactAtomicReceipts','paidCalls'])assert.deepEqual(copy.verification[key],baseline.verification[key],key);
 for(const value of [baseline,copy])assert.equal(value.verification.batchReconciliations,value.verification.receiptBatches,'Every committed receipt must retain its full batch reconciliation.');
 const result={baseline,copy,stockTimeSavedMs:baseline.stockImportMs-copy.stockImportMs,
  catalogueTimeSavedMs:baseline.catalogueMs-copy.catalogueMs,stockUnder60Seconds:copy.stockImportMs<60000,
  sameMachine:true,exactSameSources:true,integrityPassed:true,hostedCertification:false,
  ...(process.env.STOCKCHIEF_COPY_REFERENCE==='1'?{referenceCommit:'6f578146aefd1d6746eb25560ea264ef116af580',referenceFiles:['src/domain/exact-quantity.js','src/imports/postgres-service.js']}:{} )};
 fs.writeFileSync(path.join(directory,'comparison.json'),JSON.stringify(result,null,2)+'\n');
 console.log('COPY_COMPARISON '+JSON.stringify(result));
 if(process.env.STOCKCHIEF_COPY_REQUIRE_60S==='1'&&!result.stockUnder60Seconds)throw new Error('The 150,000-row COPY workload took '+copy.stockImportMs+' ms; the under-60-second target is not met.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});

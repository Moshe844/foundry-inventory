'use strict';
// Bounded, non-mutating staging probe. This is only an HTTP/DB-read smoke
// measurement; it cannot certify commerce, AI, provider, or worker capacity.
const {performance}=require('node:perf_hooks');
const args=Object.fromEntries(process.argv.slice(2).map((value,index,all)=>value.startsWith('--')?
 [value.slice(2),all[index+1]]:null).filter(Boolean));
const base=String(args.url||'').replace(/\/$/,'');
const rps=Number(args.rps||2),seconds=Number(args.seconds||20),concurrency=Number(args.concurrency||5);
if(!/^https:\/\/qualify\.stockchiefhq\.com$/.test(base)||!Number.isInteger(rps)||rps<1||rps>20||
 !Number.isInteger(seconds)||seconds<5||seconds>120||!Number.isInteger(concurrency)||concurrency<1||concurrency>20)
 throw Error('Use the known staging URL with rps 1-20, seconds 5-120, concurrency 1-20.');
const paths=['/readyz','/pricing','/healthz'];
const samples=[],statuses={},networkFailureCodes={};let active=0,maxActive=0;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function request(index){
 const path=paths[index%paths.length];const started=performance.now();active++;maxActive=Math.max(maxActive,active);
 try{const response=await fetch(base+path,{redirect:'manual',signal:AbortSignal.timeout(10000),
  headers:{'user-agent':'StockChiefCommercialReadOnlyCapacityProbe/1'}});
  await response.arrayBuffer();statuses[response.status]=(statuses[response.status]||0)+1;
  samples.push({path,status:response.status,ms:performance.now()-started});}
 catch(error){statuses.NETWORK_ERROR=(statuses.NETWORK_ERROR||0)+1;
  const code=String(error.cause?.code||error.code||error.name||'unknown');
  networkFailureCodes[code]=(networkFailureCodes[code]||0)+1;
  samples.push({path,status:'NETWORK_ERROR',ms:performance.now()-started});}
 finally{active--;}
}
async function main(){
 const count=rps*seconds,interval=1000/rps,start=performance.now();let next=0;const pending=new Set();
 for(let i=0;i<count;i++){
  const delay=start+i*interval-performance.now();if(delay>0)await pause(delay);
  while(pending.size>=concurrency)await Promise.race(pending);
  const promise=request(i).finally(()=>pending.delete(promise));pending.add(promise);next++;
 }
 await Promise.all(pending);
 const sorted=samples.map(x=>x.ms).sort((a,b)=>a-b),percentile=p=>Math.round(sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)]||0);
 const result={kind:'READ_ONLY_STAGING_HTTP_PROBE_NOT_REPRESENTATIVE_WORKFLOW_LOAD',url:base,
  rps,seconds,concurrency,scheduled:next,completed:samples.length,maxActive,statuses,networkFailureCodes,
  p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),maxMs:percentile(1),
  paths,mutatingRequests:0,providerCalls:0};
 process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
 if(Object.keys(statuses).some(code=>code==='NETWORK_ERROR'||Number(code)>=400))process.exitCode=1;
}
main().catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});

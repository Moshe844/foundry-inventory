'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');const {newId}=require('../lib/util');
const storage=new AsyncLocalStorage();let persistenceFailures=0;let lastFailureAt=null;
function create(input){return {id:input.id||newId('resource'),runtimeKind:input.runtimeKind,operation:input.operation,
 resourceId:process.env.RENDER_SERVICE_ID||process.env.STOCKCHIEF_RESOURCE_ID||`local:${input.runtimeKind}`,
 startedAt:new Date(),started:process.hrtime.bigint(),queries:0,databaseMicros:0,scope:null,mixed:false};}
function attribute(scope){const state=storage.getStore();if(!state||!scope?.accountId)return;
 if(state.scope&&state.scope.accountId!==scope.accountId){state.mixed=true;state.scope=null;return;}
 if(state.mixed)return;
 if(state.scope&&state.scope.workspaceId!==scope.workspaceId)state.scope={accountId:scope.accountId};
 else state.scope={accountId:scope.accountId,workspaceId:scope.workspaceId||null};
}
function queryFinished(start){const state=storage.getStore();if(!state)return;
 state.queries++;state.databaseMicros+=Number((process.hrtime.bigint()-start)/1000n);
}
async function persist(database,state,outcome){
 const finishedAt=new Date();const micros=Number((process.hrtime.bigint()-state.started)/1000n);
 // Exclude the measurement write itself; no recursive accounting queries.
 return storage.run(null,()=>database.query(`INSERT INTO commercial_resource_measurements
  (id,account_id,workspace_id,resource_id,runtime_kind,operation,started_at,finished_at,
    elapsed_microseconds,database_microseconds,database_queries,attribution,outcome)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING`,
 [state.id,state.scope?.accountId||null,state.scope?.workspaceId||null,state.resourceId,state.runtimeKind,state.operation,
  state.startedAt,finishedAt,micros,state.databaseMicros,state.queries,state.mixed?'MIXED':state.scope?'TENANT':'SHARED',outcome]));
}
function failure(error){persistenceFailures++;lastFailureAt=new Date().toISOString();
 console.error('COMMERCIAL_RESOURCE_MEASUREMENT_FAILED',error.code||error.name);}
async function measure(database,input,operation){const state=create(input);
 return storage.run(state,async()=>{attribute(input.scope);let outcome='FAILED';
  try{const result=await operation();outcome='COMPLETED';return result;}
  finally{try{await persist(database,state,outcome);}catch(error){failure(error);}}
 });
}
function middleware(database){return (req,res,next)=>{
 // Liveness/readiness probes are shared control-plane checks, not customer
 // workload. Persisting them would add DB writes to every probe and could
 // itself make readiness fail when the measurement sink is unavailable.
 if(req.path==='/healthz'||req.path==='/readyz')return next();
 const state=create({runtimeKind:'web',operation:req.method});let saved=false;
 storage.run(state,()=>{
  const done=()=>{if(saved)return;saved=true;
   attribute(req.workspace?.owner_account_id?{accountId:req.workspace.owner_account_id,workspaceId:req.ctx?.workspaceId}:
    req.account?.id?{accountId:req.account.id}:null);
   // Store route templates, never URLs, query strings, tokens or request bodies.
   state.operation=`${req.method} ${req.route?.path||'unmatched-or-static'}`;
   void persist(database,state,res.writableFinished?String(res.statusCode):'ABORTED').catch(failure);
  };
  res.once('finish',done);res.once('close',done);next();
 });
};}
function status(){return {persistenceFailures,lastFailureAt,allocationBasis:'SERVICE_OCCUPANCY_AND_DATABASE_LATENCY_NOT_CPU',
 completeCostCoverage:false};}
async function weights(database,{resourceId,periodStart,periodEnd,metric='elapsed_microseconds'}){
 if(!['elapsed_microseconds','database_microseconds','database_queries'].includes(metric))throw Error('Unknown resource allocation metric');
 const start=new Date(periodStart);const end=new Date(periodEnd);if(!resourceId||!(end>start))throw Error('A resource and valid service period are required');
 const rows=(await database.query(`SELECT account_id,attribution,SUM(${metric})::text AS weight,COUNT(*)::int AS samples
  FROM commercial_resource_measurements WHERE resource_id=$1 AND started_at>=$2 AND finished_at<=$3
  GROUP BY account_id,attribution ORDER BY account_id NULLS FIRST`,[resourceId,start,end])).rows;
 const boundary=(await database.query(`SELECT COUNT(*)::int AS n FROM commercial_resource_measurements
  WHERE resource_id=$1 AND started_at<$3 AND finished_at>$2 AND (started_at<$2 OR finished_at>$3)`,[resourceId,start,end])).rows[0].n;
 return {resourceId,metric,periodStart:start.toISOString(),periodEnd:end.toISOString(),rows,boundarySamples:boundary,
  readyForAutomaticAllocation:false,reason:'Measured workload weights require coverage and shared-overhead review; no invoice was allocated.'};
}
module.exports={attribute,queryFinished,measure,middleware,status,weights};

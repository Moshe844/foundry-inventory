'use strict';
// Host verification only. Never exposed as a tool and never invokes a model.
const {createHash}=require('node:crypto');
function source(entry){
 if(!entry?.sourceText||createHash('sha256').update(entry.sourceText).digest('hex')!==entry.sourceSha256)throw Error('CURRENT_EVIDENCE_REQUIRED');
 const value=JSON.parse(entry.sourceText);
 if(value.version!==1||value.name!==entry.name)throw Error('INVALID_EVIDENCE_SOURCE');
 return value;
}
async function current(database,ctx,goal,entry,{catalogue,browser}={}){
 // session.finish holds the goal in an existing transaction. Read engines
 // reuse that same client; they must not open a second transaction/connection.
 if(typeof database.transaction!=='function'){
  const client=database;
  database={query:(...args)=>client.query(...args),transaction:operation=>operation(client)};
 }
 if(entry.name==='canonical_execution_state')return require('../../scripts/environment-agent-demo/receipts').collect(database,ctx,goal,goal.checkpoint.harness,catalogue);
 const saved=source(entry);
 if(saved.name==='environment_browser'){
  if(!browser)throw Error('CURRENT_BROWSER_VERIFICATION_REQUIRED');
  const observation=JSON.parse(entry.text),screen=observation.screen||observation;
  if(!screen.applicationPage||screen.httpStatus!==200)throw Error('APPLICATION_EVIDENCE_REQUIRED');
  const fresh=await browser.verifyObservation(screen.url);
  if(!fresh.applicationPage||fresh.httpStatus!==200)throw Error('CURRENT_APPLICATION_EVIDENCE_REQUIRED');
  // Private renderer ports can change after a restart. The authenticated
  // application path is stable; never treat an ephemeral loopback port as a
  // business fact or force a second model turn merely to rewrite that URL.
  const priorUrl=new URL(screen.url),currentUrl=new URL(fresh.url);
  if(priorUrl.pathname!==currentUrl.pathname||priorUrl.search!==currentUrl.search)throw Error('CURRENT_APPLICATION_PATH_CHANGED');
  fresh.url=screen.url;
  return observation.screen?{screen:fresh}:fresh;
 }
 const actor=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!actor)throw Error('CURRENT_AUTHORITY_REQUIRED');
 if(saved.name==='environment_dataset'){
  const input=saved.input,spec=typeof input.specJson==='string'?JSON.parse(input.specJson):input.spec;
  require('../../scripts/environment-agent-demo/contracts').datasetSpec(spec,actor);
  return require('../reports/postgres-service').run(database,ctx,actor,spec,{limit:101,offset:input.offset||0});
 }
 if(saved.name!=='business_operations'||!catalogue)throw Error('PURE_READ_EVIDENCE_REQUIRED');
 const steps=saved.input.steps;
 if(!Array.isArray(steps)||!steps.length||steps.some(step=>!['read','navigation'].includes(catalogue.get(step.capability)?.kind)))throw Error('PURE_READ_EVIDENCE_REQUIRED');
 const parsed=require('./postgres-capability-planner').parseSteps({steps},catalogue);
 if(!parsed.steps?.length||parsed.clarifyingQuestion||parsed.steps.some(step=>!['read','navigation'].includes(step.contract.kind)))throw Error('PURE_READ_EVIDENCE_REQUIRED');
 const provider={name:'host-read-verification',model:'none',complete:async()=>{throw Error('VERIFICATION_NEEDS_MODEL');}};
 const outcomes=[];
 for(const step of parsed.steps){
  const result=await require('./postgres-control-plane').executeStep(require('./postgres-service').capabilityService(),database,ctx,step,
   {actor,provider,rawProvider:provider,sourceMessage:goal.original_request,usageKey:`verify:${entry.id}`,preparedContent:true});
  if(result.result.status!=='ANSWERED')throw Error('CURRENT_READ_UNVERIFIED');
  outcomes.push({capability:step.contract.name,result:result.result});
 }
 return {missionId:null,outcomes};
}
module.exports={source,current};

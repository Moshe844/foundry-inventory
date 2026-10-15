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
 if(entry.name==='authorized_environment'){
  const row=(await database.query(`SELECT w.name,u.role FROM users u JOIN workspaces w ON w.id=u.workspace_id
   WHERE u.workspace_id=$1 AND u.id=$2`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw Error('CURRENT_AUTHORITY_REQUIRED');
  return {business:{name:row.name},actor:{role:row.role},clock:{utc:new Date().toISOString()}};
 }
 let saved;
 if(entry.name==='environment_interfaces'&&!entry.sourceText){
  // Older journals already contain the host-generated exact-name selection.
  // That complete selection is reconstructible; an old paginated search is
  // not, because its offset was not saved. Never guess missing provenance.
  const observed=JSON.parse(entry.text),selection=observed.selection;
  if(selection?.kind!=='names'||!Array.isArray(selection.names)||!selection.names.length||selection.names.length>6||selection.names.some(name=>typeof name!=='string'))throw Error('CURRENT_EVIDENCE_REQUIRED');
  saved={version:1,name:entry.name,input:{search:'',offset:0,names:selection.names}};
 }else saved=source(entry);
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
 if(saved.name==='environment_interfaces'){
  if(!catalogue)throw Error('CURRENT_INTERFACE_CATALOGUE_REQUIRED');
  return require('../../scripts/environment-agent-demo/gateway').interfaceSnapshot(catalogue,actor,saved.input);
 }
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
 const observation=JSON.parse(entry.text),ids=(observation.outcomes||[]).map(o=>o.result?.interactionId).filter(id=>typeof id==='string');
 const metadata=ids.length?new Map((await database.query(`SELECT id,message,intent FROM stockchief_runtime.assistant_interactions
  WHERE workspace_id=$1 AND actor_user_id=$2 AND id=ANY($3::text[])`,[ctx.workspaceId,ctx.actorId,ids])).rows.map(row=>[row.id,row])):new Map();
 const outcomes=[];
 for(const [index,step]of parsed.steps.entries()){
  const result=await require('./postgres-control-plane').executeStep(require('./postgres-service').capabilityService(),database,ctx,step,
   {actor,provider,rawProvider:provider,sourceMessage:goal.original_request,usageKey:`verify:${entry.id}`,preparedContent:true});
  if(result.result.status!=='ANSWERED')throw Error('CURRENT_READ_UNVERIFIED');
  const original=observation.outcomes?.[index]?.result;
  if(original?.interactionId){
   const recorded=metadata.get(original.interactionId);
   if(!recorded||recorded.message!==goal.original_request||recorded.intent.controlPlane?.capability!==step.contract.name)throw Error('CURRENT_READ_SCOPE_UNVERIFIED');
   result.result=require('./capability-outcome-presentation').present(goal.original_request,{step,...result},{
    interactionId:recorded.id,batchId:recorded.intent.batchId||null,planId:recorded.intent.controlPlane?.planId||null,index,count:parsed.steps.length});
  }
  outcomes.push({capability:step.contract.name,result:result.result});
 }
 return {missionId:null,outcomes};
}
module.exports={source,current};

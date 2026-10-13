'use strict';

const control=require('../../src/assistant/postgres-control-plane');
const planner=require('../../src/assistant/postgres-capability-planner');
const plans=require('../../src/assistant/postgres-capability-plans');
const service=require('../../src/assistant/postgres-service');
const {FIELDS}=require('../../src/assistant/postgres-capability-registry');
const {randomUUID}=require('node:crypto');

function describe(c){return {name:c.name,kind:c.kind,description:c.description,required:c.required||[],
  fields:Object.fromEntries(c.fields.map(name=>[name,{type:FIELDS[name]?.type||'string',description:c.agentHints?.[name]||FIELDS[name]?.description||name,
   ...(c.argumentSchemas?.[name]?{jsonSchema:c.argumentSchemas[name]()}:{})}])),
  authority:c.authority,unavailable:c.commercialUnavailable||[]};}
function contractPage(entries,offset,details,summary){
 const page=[];let bytes=0;
 for(const entry of entries.slice(offset,offset+12)){
  let value=details(entry),size=Buffer.byteLength(JSON.stringify(value));
  if(size>18000){value={...summary(entry),detailsByName:true};size=Buffer.byteLength(JSON.stringify(value));}
  if(page.length&&bytes+size>18000)break;
  page.push(value);bytes+=size;
 }
 return {page,nextOffset:offset+page.length<entries.length?offset+page.length:null};
}

// ctx, original goal and database are host-bound. Models cannot supply tenant,
// actor, approval, SQL, provider credentials or an alternative source message.
function createGateway({database,ctx,goal,goalId,runToken,provider,rawProvider=provider,audit=()=>{}}){
  async function access({catalogue=true}={}){
    const state=(await database.query(`SELECT original_request,status,run_token,lease_until,expires_at,checkpoint->'messages' AS user_messages FROM stockchief_runtime.assistant_goals
      WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,goalId])).rows[0];
    if(!state||state.original_request!==goal||state.status!=='RUNNING'||state.run_token!==runToken||
      new Date(state.lease_until).getTime()<=Date.now()||new Date(state.expires_at).getTime()<=Date.now())throw new Error('Goal is not held by this agent run.');
    const actor=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,ctx.actorId])).rows[0];
    if(!actor)throw new Error('Actor no longer belongs to this business.');
    await require('../../src/commercial/enforcement').workspace(database,ctx.workspaceId,'ask.lookup');
    // Native checkpoint/transport bookkeeping needs current lease, membership,
    // permissions and Ask entitlement, not every business execution contract.
    // Actual interface discovery, operations and verification retain the full
    // fresh catalogue; this does not cache authority or commercial decisions.
    const clarifications=Array.isArray(state.user_messages)?state.user_messages.filter(m=>typeof m==='string'):[];
    let interfaces;
    if(catalogue){
      interfaces=await control.planningCatalogue(database,{...ctx,goalId},actor);
      if(require('../../src/commercial/relay-provider').ownsAccounting(provider)){
        const entries=interfaces.list().map(c=>c.agentFields?Object.freeze({...c,fields:[...c.fields,...c.agentFields]}):c);
        const byName=new Map(entries.map(c=>[c.name,c]));
        interfaces={list:(kind=null)=>entries.filter(c=>!kind||c.kind===kind),get:name=>byName.get(name)||null};
      }
    }
    return {actor,sourceMessage:[goal,...clarifications.map(m=>'User clarification: '+m)].join('\n'),
      ...(catalogue?{catalogue:interfaces}:{})};
  }
  return {
    authorize:access,
    async interfaces({search='',offset=0,names=[]}={}){const {actor,catalogue}=await access();
      const operationSearch=require('./interface-search').ranked(catalogue.list(),search);
      const all=operationSearch.items;
      const datasets=require('../../src/reports/postgres-registry').list(actor).map(d=>({...d,name:d.key}));
      if(require('../../src/reports/postgres-composed').dimensions(actor).length)datasets.push({name:'composed',label:'Combine governed measures across datasets'});
      const datasetSearch=require('./interface-search').ranked(datasets,search);
      const matchedDatasets=datasetSearch.items;
      // Relevant contracts arrive with their usable fields in the discovery
      // response. Bounded pagination avoids an obligatory detail-only model
      // round without injecting the whole catalogue into every prompt.
      const operationPage=contractPage(all,offset,describe,c=>({name:c.name,kind:c.kind,description:c.description}));
      const datasetDetails=d=>({...d,queryContract:require('../../src/reports/postgres-service').queryContract(d.name,actor)});
      const datasetPage=contractPage(matchedDatasets,offset,datasetDetails,d=>({name:d.name,label:d.label}));
      return {
      operations:names.length?catalogue.list().filter(c=>names.includes(c.name)).map(describe):
       operationPage.page,
      total:all.length,nextOffset:operationPage.nextOffset,
      datasets:names.length?matchedDatasets.filter(d=>names.includes(d.name)).map(datasetDetails):datasetPage.page,
      datasetTotal:matchedDatasets.length,datasetNextOffset:datasetPage.nextOffset,
      searchMatch:{operations:operationSearch.matchMode,datasets:datasetSearch.matchMode},
      coverage:'These are governed execution contracts and curated report projections, not exhaustive environment discovery. Unlisted application screens, forms and rendered records remain discoverable through the browser. A missing execution contract is a reported execution limitation, never authority to bypass the gateway.',
      policy:'Browser inspection cannot commit changes. Operations use canonical engines. Prepared means awaiting authority, never completed. No approval tool is available.'};},
    async operate({steps,callId=randomUUID()}){
      let effectsStarted=false;
      try{
      if(!Array.isArray(steps)||!steps.length||steps.length>8)throw new Error('Provide one to eight dependent canonical operations.');
      const {actor,catalogue}=await access();
      const parsed=planner.parseSteps({steps:require('./contracts').operationSteps(steps,catalogue)},catalogue);
      if(!parsed.steps?.length||parsed.clarifyingQuestion)throw new Error(parsed.clarifyingQuestion||'Invalid operation contract.');
      planner.sequenceApprovedMutations(parsed.steps);
      const outcomes=[];const call=callId;
      for(const [index,step]of parsed.steps.entries()){
        const current=await access();
        if(JSON.stringify(current.actor)!==JSON.stringify(actor))throw new Error('Authority changed during the operation.');
        if(step.dependsOn.some(i=>outcomes[i]?.result.status!=='ANSWERED')){
          outcomes.push({step,args:step.args,provenance:{},result:{status:'CLARIFY',reason:'dependency_waiting'}});continue;
        }
        let result;
        try{result=await control.executeStep(service.capabilityService(),database,{...ctx,goalId,
          planStepKey:`environment:${goalId}:${call}:${index}`},step,{actor,provider,rawProvider,
          sourceMessage:current.sourceMessage,usageKey:`environment:${goalId}:${call}:${index}`});}
        catch(error){effectsStarted||=step.contract.kind!=='read'&&error.effectMayHaveOccurred!==false;throw error;}
        effectsStarted||=step.contract.kind!=='read';
        outcomes.push({...result,step});
        audit({kind:'canonical_operation',capability:step.contract.name,status:result.result.status});
      }
      const mission=await plans.save(database,ctx,goal,goalId,parsed.steps,outcomes);
      if(mission)await database.query('UPDATE stockchief_runtime.assistant_capability_plans SET goal_id=$1 WHERE id=$2 AND workspace_id=$3',
        [goalId,mission.id,ctx.workspaceId]);
      for(const [index,outcome]of outcomes.entries())if(outcome.result.reason!=='dependency_waiting')
        await service.recordCapabilityOutcome(database,ctx,goal,outcome,{batchId:`${goalId}:${call}`,planId:mission?.id,index,count:outcomes.length});
      return {missionId:mission?.id||null,outcomes:outcomes.map(o=>({capability:o.step.contract.name,result:o.result}))};
      }catch(error){error.effectMayHaveOccurred=effectsStarted;throw error;}
    },
    async dataset({spec,offset=0}){
      const {actor}=await access({catalogue:false});
      if(spec?.filters!==undefined&&!Array.isArray(spec.filters))throw Object.assign(new Error('Dataset filters must be an array of field/operator/value conditions; discover the dataset contract before retrying.'),{code:'TOOL_CONTRACT_INVALID'});
      require('./contracts').datasetSpec(spec,actor);
      return require('../../src/reports/postgres-service').run(database,ctx,actor,spec,{limit:101,offset});
    }
  };
}
module.exports={createGateway};

'use strict';

const control=require('../../src/assistant/postgres-control-plane');
const planner=require('../../src/assistant/postgres-capability-planner');
const plans=require('../../src/assistant/postgres-capability-plans');
const service=require('../../src/assistant/postgres-service');
const {FIELDS}=require('../../src/assistant/postgres-capability-registry');
const {randomUUID}=require('node:crypto');
const {nativeFieldName}=require('./contracts');

function describe(c){return {name:c.name,kind:c.kind,description:c.description,required:(c.required||[]).map(name=>nativeFieldName(c,name)),
  ...(['mutation','policy'].includes(c.kind)&&c.authority?.mode==='explicit_approval'
    ?{invocation:{stage:'prepare_review',reviewRecord:'governed_proposal',
      execution:'separate_authenticated_approval',
      meaning:'Invoking this contract prepares or revisits a proposal for review. The described business effects require separate approval and canonical execution; the proposal is not a posted business record.'}}:{}),
  fields:Object.fromEntries(c.fields.map(name=>[nativeFieldName(c,name),{type:FIELDS[name]?.type||'string',...(FIELDS[name]?.type==='string'?{maxLength:FIELDS[name].maxLength||2000}:{}),description:c.agentHints?.[name]||FIELDS[nativeFieldName(c,name)]?.description||name,
   ...(c.argumentSchemas?.[name]?{jsonSchema:c.argumentSchemas[name]()}:{})}])),
  authority:c.authority,unavailable:c.commercialUnavailable||[],
  ...(c.recordKind&&require('../../src/web/postgres-record-destinations').RECORDS[c.recordKind]?.collection
    ?{collection:require('../../src/web/postgres-record-destinations').RECORDS[c.recordKind].collection}:{})};}
// Current authorized interface metadata, not record facts or new operations.
// Keep owning lists distinct from record navigators that require an identifier.
function collections(catalogue){return Object.fromEntries(catalogue.list().filter(c=>c.kind==='navigation'&&c.recordKind)
  .flatMap(c=>{const collection=require('../../src/web/postgres-record-destinations').RECORDS[c.recordKind]?.collection;
    return collection?[[c.name,{...collection,recordReferenceRequired:(c.required||[]).includes('recordReference')}]]:[];}));}
function navigationCollections(catalogue){return Object.fromEntries(Object.entries(collections(catalogue)).filter(([name,collection])=>
 !(catalogue.get(name)?.commercialUnavailable||[]).length&&require('../../src/assistant/agent-navigation-path').localPath(collection.href)===collection.href));}
function discoveryPage(entries,offset,summary){
 const page=[];let bytes=0;
 for(const entry of entries.slice(offset)){
  const value=summary(entry),size=Buffer.byteLength(JSON.stringify(value));
  if(page.length&&bytes+size>18000)break;
  page.push(value);bytes+=size;
 }
 return {page,nextOffset:offset+page.length<entries.length?offset+page.length:null};
}
// One pure representation for discovery and final CURRENT contract verification.
// The caller supplies a freshly authorized catalogue and current actor. This
// describes interfaces only; it cannot grant authority or execute an operation.
function interfaceSnapshot(catalogue,actor,{search='',offset=0,names=[]}={}){
 if(typeof search!=='string'||search.length>200||!Number.isSafeInteger(offset)||offset<0||offset>10000||
  !Array.isArray(names)||names.length>6||names.some(name=>typeof name!=='string'))throw Error('INVALID_INTERFACE_QUERY');
 const operationSearch=require('./interface-search').ranked(catalogue.list(),search),all=operationSearch.items;
 const datasets=require('../../src/reports/postgres-registry').list(actor).map(d=>({...d,name:d.key}));
 if(require('../../src/reports/postgres-composed').dimensions(actor).length)datasets.push({name:'composed',label:'Combine governed measures across datasets'});
 const datasetSearch=require('./interface-search').ranked(datasets,search),matchedDatasets=datasetSearch.items;
 const operationPage=discoveryPage(all,offset,c=>({name:c.name,kind:c.kind,description:c.description,
  required:(c.required||[]).map(name=>nativeFieldName(c,name)),detailsByName:true,unavailable:c.commercialUnavailable||[]}));
 const datasetDetails=d=>({...d,queryContract:require('../../src/reports/postgres-service').queryContract(d.name,actor)});
 const datasetPage=discoveryPage(matchedDatasets,offset,d=>({name:d.name,label:d.label,detailsByName:true}));
 const namedOperations=names.length?catalogue.list().filter(c=>names.includes(c.name)).map(describe):null;
 const namedDatasets=names.length?datasets.filter(d=>names.includes(d.name)).map(datasetDetails):null;
 return {operations:names.length?namedOperations:operationPage.page,
  total:names.length?namedOperations.length:all.length,nextOffset:names.length?null:operationPage.nextOffset,
  datasets:names.length?namedDatasets:datasetPage.page,
  datasetTotal:names.length?namedDatasets.length:matchedDatasets.length,datasetNextOffset:names.length?null:datasetPage.nextOffset,
  selection:{kind:names.length?'names':'search',...(names.length?{names}:{query:search})},
  searchMatch:{operations:operationSearch.matchMode,datasets:datasetSearch.matchMode},
  coverage:'These are governed execution contracts and curated report projections, not exhaustive environment discovery. Unlisted application screens, forms and rendered records remain discoverable through the browser. A missing execution contract is a reported execution limitation, never authority to bypass the gateway.',
  policy:'Browser inspection cannot commit changes. Operations use canonical engines. Prepared means awaiting authority, never completed. No approval tool is available.'};
}

// ctx, original goal and database are host-bound. Models cannot supply tenant,
// actor, approval, SQL, provider credentials or an alternative source message.
function createGateway({database,ctx,goal,goalId,runToken,provider,rawProvider=provider,audit=()=>{},accessGuard=null}){
  if(accessGuard!==null&&typeof accessGuard!=='function')throw new Error('INVALID_HOST_ACCESS_GUARD');
  async function access({catalogue=true}={}){
    // A native Staging guard checks pilot identity AND the Ask entitlement on
    // every boundary. Repeating the identical commercial check here adds
    // remote database round trips, not authority. No result is cached or
    // carried into another call; gateways without a guard retain their check.
    const [guard,stateResult]=await Promise.all([
     accessGuard?accessGuard():null,
     database.query(`SELECT original_request,status,run_token,lease_until,expires_at,checkpoint->'messages' AS user_messages FROM stockchief_runtime.assistant_goals
      WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,goalId])]);
    const state=stateResult.rows[0];
    if(!state||state.original_request!==goal||state.status!=='RUNNING'||state.run_token!==runToken||
      new Date(state.lease_until).getTime()<=Date.now()||new Date(state.expires_at).getTime()<=Date.now())throw new Error('Goal is not held by this agent run.');
    // A host guard may supply the membership/permissions it JUST checked in
    // this call. Reuse that snapshot only for this boundary and exact actor.
    const actor=guard?.actor?.id===ctx.actorId&&Object.hasOwn(guard.actor,'permissions')
      ?{role:guard.actor.role,permissions:guard.actor.permissions}
      :(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',
        [ctx.workspaceId,ctx.actorId])).rows[0];
    if(!actor)throw new Error('Actor no longer belongs to this business.');
    if(!accessGuard)await require('../../src/commercial/enforcement').workspace(database,ctx.workspaceId,'ask.lookup');
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
      ...(guard?.commercialAccess?{commercialAccess:guard.commercialAccess}:{}),
      ...(guard?.environment?{environment:guard.environment}:{}),
      ...(catalogue?{catalogue:interfaces}:{})};
  }
  return {
    authorize:access,
    async collections(){return collections((await access()).catalogue);},
    async initialContracts(){
      const {catalogue,actor}=await access(),operations=[];
      // Ordinary questions must be able to choose a governed read immediately,
      // not pay for a separate discovery turn or a browser tour first. This is
      // current authorized metadata, not a map limiting environment discovery.
      const contracts=catalogue.list().sort((a,b)=>Number(b.kind==='read')-Number(a.kind==='read'));
      // A complete name/kind index distinguishes an absent execution contract
      // from details merely omitted from the initial packet. This is generated
      // from fresh authorized contracts, never a page/route discovery boundary.
      const operationIndex=Object.fromEntries([...new Set(contracts.map(c=>c.kind))]
        .map(kind=>[kind,contracts.filter(c=>c.kind===kind).map(c=>c.name)]));
      // Navigation contracts share a few argument/authority signatures. Keep
      // every signature available without repeating forty page descriptions
      // or making the agent buy a discovery round for an argument-free page.
      const groupedNavigation=new Map();
      for(const contract of contracts.filter(c=>c.kind==='navigation')){
        const {required,fields,authority,unavailable}=describe(contract),signature={required,fields,authority,unavailable},key=JSON.stringify(signature);
        if(!groupedNavigation.has(key))groupedNavigation.set(key,{names:[],...signature});
        groupedNavigation.get(key).names.push(contract.name);
      }
      const navigationSignatures=[...groupedNavigation.values()],recordCollections=collections(catalogue),groupedReads=new Map();
      for(const contract of contracts.filter(c=>c.kind==='read')){
        const {required,fields,authority,unavailable}=describe(contract),signature={required,fields,authority,unavailable},key=JSON.stringify(signature);
        if(!groupedReads.has(key))groupedReads.set(key,{names:[],...signature});groupedReads.get(key).names.push(contract.name);
      }
      const readSignatures=[...groupedReads.values()];
      const datasets=require('../../src/reports/postgres-registry').list(actor);
      const datasetIndex=datasets.map(({key:name,label,filterValues})=>({name,label,detailsByName:true,
        ...(filterValues?{filterValues}:{})}));
      const packet=()=>({operations,operationIndex,navigationSignatures,recordCollections,readSignatures,readArgumentsComplete:true,readDescriptionsComplete:true,
        readAccess:'Every authorized read name has its complete input fields, required arguments and authority in readSignatures. Every read description is supplied in operations. Use a known complete read directly when it fits the goal; interface discovery remains available for missing execution details. No execution grant or business fact is implied.',
        navigationAccess:'Exact signatures apply to each grouped name. recordCollections are owning list paths for browser inspection, not individual record references. Navigation gives no record facts; authority and user arrival are rechecked.',datasetIndex,datasetFieldsComplete:datasetIndex.every(d=>d.fields),indexComplete:true,total:contracts.length,complete:operations.length===contracts.length,
        datasetAccess:'Scoped projections, not SQL/pages. Use known typed fields/filters; inspect missing metadata. Extent distinguishes rows/groups and complete first-page source totals. Reads recheck scope/permissions.',
        coverage:'All authorized names, bounded details. Browser discovers screens; environment_interfaces supplies omissions. Fresh canonical checks remain.'});
      const size=()=>Buffer.byteLength(JSON.stringify(require('./interface-presentation').compact(packet())));
      const details=datasets.map((dataset,index)=>({index,fields:dataset.fields,bytes:Buffer.byteLength(JSON.stringify(dataset.fields))})).sort((a,b)=>a.bytes-b.bytes);
      // Reserve a small part of the SAME packet budget for compact typed
      // datasets, so long operation descriptions cannot starve every schema.
      const indexBytes=size();
      for(const detail of details){
        datasetIndex[detail.index].fields=detail.fields;
        if(size()-indexBytes>3000)delete datasetIndex[detail.index].fields;
      }
      // All read inputs are already present in the seven or so shared
      // signatures. Include every authorized purpose before optional dataset details;
      // otherwise the longest, most complete readers disappear from the packet.
      // The initial packet has its own 28 KB ceiling; tool discovery pages retain
      // their existing 18 KB bound. Native token counting and money caps do not change.
      const readDetails=contracts.filter(c=>c.kind==='read').map(describe).sort((a,b)=>a.name.localeCompare(b.name));
      for(const complete of readDetails)operations.push({name:complete.name,kind:complete.kind,
        description:complete.description,fieldsBySignature:true,detailsByName:true,
        ...(complete.collection?{collection:complete.collection}:{})});
      // Include compact dataset schemas before oversized descriptions consume
      // the entire packet. Selection depends on metadata size only, never the
      // request, route or business domain. Every name remains discoverable.
      for(const detail of details.filter(d=>!datasetIndex[d.index].fields)){
        datasetIndex[detail.index].fields=detail.fields;
        // Bound the actual lossless delivered initial packet.
        if(Buffer.byteLength(JSON.stringify(require('./interface-presentation').compact(packet())))>28000)delete datasetIndex[detail.index].fields;
      }
      if(Buffer.byteLength(JSON.stringify(require('./interface-presentation').compact(packet())))>28000)
        throw Error('INITIAL_INTERFACE_INDEX_LIMIT');
      return packet();
    },
    async interfaces(input={}){const {actor,catalogue}=await access();return interfaceSnapshot(catalogue,actor,input);},
    async operate({steps,callId=randomUUID()}){
      let effectsStarted=false;
      try{
      if(!Array.isArray(steps)||!steps.length||steps.length>8)throw new Error('Provide one to eight dependent canonical operations.');
      const {actor,catalogue}=await access();
      const parsed=planner.parseSteps({steps:require('./contracts').operationSteps(steps,catalogue)},catalogue);
      if(!parsed.steps?.length||parsed.clarifyingQuestion)throw new Error(parsed.clarifyingQuestion||'Invalid operation contract.');
      // Preparing an independent proposal needs no earlier effect to commit.
      // Preserve the native agent's actual data dependencies separately from
      // the canonical mission's additional execution-order constraints.
      const preparationDependencies=parsed.steps.map(step=>[...step.dependsOn]);
      planner.sequenceApprovedMutations(parsed.steps);
      const outcomes=[];const call=callId;
      for(const [index,step]of parsed.steps.entries()){
        const current=await access();
        if(JSON.stringify(current.actor)!==JSON.stringify(actor))throw new Error('Authority changed during the operation.');
        const dependencies=step.contract.kind==='mutation'&&step.contract.authority?.mode==='explicit_approval'
          ?preparationDependencies[index]:step.dependsOn;
        if(dependencies.some(i=>outcomes[i]?.result.status!=='ANSWERED')){
          outcomes.push({step,args:step.args,provenance:{},result:{status:'CLARIFY',reason:'dependency_waiting'}});continue;
        }
        let result;
        try{result=await control.executeStep(service.capabilityService({nativeFacts:true}),database,{...ctx,goalId,
          planStepKey:`environment:${goalId}:${call}:${index}`},step,{actor,provider,rawProvider,
          sourceMessage:current.sourceMessage,usageKey:`environment:${goalId}:${call}:${index}`,preparedContent:true});}
        catch(error){effectsStarted||=step.contract.kind!=='read'&&error.effectMayHaveOccurred!==false;throw error;}
        effectsStarted||=step.contract.kind!=='read';
        outcomes.push({...result,step});
        audit({kind:'canonical_operation',capability:step.contract.name,status:result.result.status});
      }
      const mission=await plans.save(database,ctx,goal,goalId,parsed.steps,outcomes);
      if(mission)await database.query('UPDATE stockchief_runtime.assistant_capability_plans SET goal_id=$1 WHERE id=$2 AND workspace_id=$3',
        [goalId,mission.id,ctx.workspaceId]);
      for(const [index,outcome]of outcomes.entries())if(outcome.result.reason!=='dependency_waiting')
        await service.recordCapabilityOutcome(database,{...ctx,goalId},goal,outcome,{batchId:`${goalId}:${call}`,planId:mission?.id,index,count:outcomes.length});
      return {missionId:mission?.id||null,outcomes:outcomes.map(o=>({capability:o.step.contract.name,result:o.result}))};
      }catch(error){error.effectMayHaveOccurred=effectsStarted;throw error;}
    },
    async dataset({spec,offset=0}){
      const {actor}=await access({catalogue:false});
      if(spec?.filters!==undefined&&!Array.isArray(spec.filters))throw Object.assign(new Error('Dataset filters must be an array of field/operator/value conditions; discover the dataset contract before retrying.'),{code:'TOOL_CONTRACT_INVALID'});
      const original=spec;spec=require('../../src/reports/postgres-service').inspectionSpec(spec,actor);
      require('./contracts').datasetSpec(spec,actor);
      const result=await require('../../src/reports/postgres-service').run(database,ctx,actor,spec,{limit:101,offset});
      if(original!==spec)result.availableFields=require('../../src/reports/postgres-registry').get(spec.dataset).fields;
      return result;
    }
  };
}
module.exports={createGateway,interfaceSnapshot,navigationCollections};

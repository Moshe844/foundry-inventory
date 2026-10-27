'use strict';

const {newId}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const {registry}=require('./postgres-capability-registry');
const {executeStep,synthesizeReads}=require('./postgres-control-plane');
const memory=require('./postgres-business-memory');

function planShape(steps){return steps.map((step)=>({capability:step.capability||step.contract?.name,
  args:step.args||{},dependsOn:step.dependsOn||[],continuesPending:Boolean(step.continuesPending)}));}
function planHash(steps){return memory.digest(planShape(steps));}
function metric(metrics,key,amount=1){return {...(metrics||{}),[key]:Number(metrics?.[key]||0)+amount};}

function serialized(steps,outcomes){
  return steps.map((step,index)=>{
    const result=outcomes[index]?.result||{};
    const state=result.status==='ANSWERED'?'DONE':result.status==='PREPARED'?'WAITING':'BLOCKED';
    return {capability:step.contract.name,args:outcomes[index]?.args||step.args,
      dependsOn:step.dependsOn,continuesPending:step.continuesPending,state,
      reason:result.reason||null,proposalId:result.proposal?.id||null};
  });
}

async function save(database,ctx,message,batchId,steps,outcomes){
  if(!steps.some((step)=>step.dependsOn.length)||!outcomes.some((entry)=>entry.result?.status==='PREPARED'))return null;
  const records=serialized(steps,outcomes);const waiting=records.find((step)=>step.state==='WAITING');
  const id=newId('pgplan');const shape=planShape(records);const hash=planHash(shape);
  await database.query(`INSERT INTO stockchief_runtime.assistant_capability_plans
    (id,workspace_id,actor_user_id,batch_id,source_message,outcome,steps,approved_steps,plan_hash,
      status,waiting_proposal_id,approval_status,metrics)
    VALUES($1,$2,$3,$4,$5,$5,$6::jsonb,$7::jsonb,$8,$9,$10,'PENDING',$11::jsonb)`,
  [id,ctx.workspaceId,ctx.actorId,batchId||id,message,JSON.stringify(records),JSON.stringify(shape),hash,
    waiting?'WAITING':'BLOCKED',waiting?.proposalId||null,JSON.stringify({outcomeSpecifications:1,
      approvalInteractions:0,clarificationInteractions:0,automaticSteps:0,userInterventions:0,
      externalWaits:0,resumptions:0})]);
  return {id,batchId:batchId||id};
}

async function missionForProposal(database,workspaceId,actorId,proposalId,{lock=false,client=database}={}){
  const row=(await client.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
    WHERE workspace_id=$1 AND actor_user_id=$2 AND steps @> $3::jsonb
    ORDER BY created_at DESC LIMIT 1${lock?' FOR UPDATE':''}`,[workspaceId,actorId,
    JSON.stringify([{proposalId}])])).rows[0]||null;
  return row?{...row,planHash:row.plan_hash,approvalStatus:row.approval_status,
    authorizationMode:row.authorization_mode}:null;
}

async function authorize(database,ctx,proposalId,{expectedHash=null,expectedId=null}={}){return database.transaction(async(client)=>{
  const plan=await missionForProposal(client,ctx.workspaceId,ctx.actorId,proposalId,{lock:true,client});
  if(!plan)throw new Error('That prepared change is not part of a multi-step mission.');
  if(expectedHash&&plan.plan_hash!==expectedHash||expectedId&&plan.id!==expectedId)throw new Error('The reviewed mission changed. Review its current scope before approving.');
  if(plan.plan_hash!==planHash(plan.approved_steps||[]))throw new Error('The mission plan changed before approval. Ask again.');
  const actor=(await client.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,ctx.actorId])).rows[0];
  if(!actor)throw new Error('The mission owner no longer belongs to this inventory.');
  const permissions=require('../actions/permissions');
  for(const step of plan.approved_steps||[]){const contract=registry.get(step.capability);
    if(!contract)throw new Error(`Mission capability ${step.capability} is no longer registered.`);
    if(['mutation','policy'].includes(contract.kind))permissions.assertCan(actor,contract.permission,contract.name);
    if(contract.ownerOnly&&actor.role!=='owner')throw new Error('Only the inventory owner can approve this mission.');
  }
  if(plan.approval_status==='APPROVED'&&plan.authorization_mode==='MISSION')return plan;
  if(!['WAITING','ADVANCING'].includes(plan.status)||plan.waiting_proposal_id!==proposalId)
    throw new Error('That mission is no longer waiting on this exact step.');
  const metrics=metric(plan.metrics,'approvalInteractions');
  const changed=(await client.query(`UPDATE stockchief_runtime.assistant_capability_plans
    SET authorization_mode='MISSION',approval_status='APPROVED',approved_by_user_id=$3,approved_at=now(),
      metrics=$4::jsonb,updated_at=now()
    WHERE workspace_id=$1 AND id=$2 AND approval_status IN ('PENDING','APPROVED') RETURNING *`,
  [ctx.workspaceId,plan.id,ctx.actorId,JSON.stringify(metrics)])).rows[0];
  return changed;
},{isolation:'SERIALIZABLE',retrySafe:true});}

async function metricsSummary(database,workspaceId){const row=(await database.query(`SELECT
    COUNT(*)::int AS missions,
    COUNT(*) FILTER (WHERE status='DONE')::int AS completed,
    COUNT(*) FILTER (WHERE status IN ('WAITING_USER','BLOCKED'))::int AS interventions,
    COALESCE(SUM((metrics->>'outcomeSpecifications')::int),0)::int AS outcome_specifications,
    COALESCE(SUM((metrics->>'approvalInteractions')::int),0)::int AS approvals,
    COALESCE(SUM((metrics->>'clarificationInteractions')::int),0)::int AS clarifications,
    COALESCE(SUM((metrics->>'userInterventions')::int),0)::int AS user_interventions,
    COALESCE(SUM((metrics->>'automaticSteps')::int),0)::int AS automatic_steps,
    COALESCE(SUM((metrics->>'externalWaits')::int),0)::int AS external_waits,
    COALESCE(SUM((metrics->>'resumptions')::int),0)::int AS resumptions
  FROM stockchief_runtime.assistant_capability_plans WHERE workspace_id=$1`,[workspaceId])).rows[0];
  // These are completed, canonical outcomes, not merely proposed tools. An Ask
  // proposal already owned by a capability plan must not be counted twice.
  const standalone=(await database.query(`SELECT
      COUNT(*)::int AS outcomes,
      COUNT(*) FILTER (WHERE action.status='EXECUTED')::int AS completed
    FROM stockchief_runtime.assistant_action_proposals action
    WHERE action.workspace_id=$1
      AND EXISTS (SELECT 1 FROM stockchief_runtime.assistant_interactions interaction
        WHERE interaction.workspace_id=action.workspace_id AND interaction.intent->>'proposalId'=action.id)
      AND NOT EXISTS (SELECT 1 FROM stockchief_runtime.assistant_capability_plans plan
        WHERE plan.workspace_id=action.workspace_id
          AND plan.steps @> jsonb_build_array(jsonb_build_object('proposalId',action.id)))`,
  [workspaceId])).rows[0];
  const rules=(await database.query(`SELECT COUNT(*)::int AS outcomes,
      COUNT(*) FILTER (WHERE rule.approved_at IS NOT NULL)::int AS completed
    FROM operating_instruction_proposals rule WHERE rule.workspace_id=$1
      AND EXISTS (SELECT 1 FROM stockchief_runtime.assistant_interactions interaction
        WHERE interaction.workspace_id=rule.workspace_id AND interaction.intent->>'proposalId'=rule.id)
      AND NOT EXISTS (SELECT 1 FROM stockchief_runtime.assistant_capability_plans plan
        WHERE plan.workspace_id=rule.workspace_id
          AND plan.steps @> jsonb_build_array(jsonb_build_object('proposalId',rule.id)))`,
  [workspaceId])).rows[0];
  const autonomous=(await database.query(`SELECT COUNT(*)::int AS outcomes,
      COUNT(*) FILTER (WHERE execution_status='COMPLETED' AND verification_status='VERIFIED')::int AS completed
    FROM work_items WHERE workspace_id=$1 AND purchase_order_id IS NOT NULL`,[workspaceId])).rows[0];
  const clarificationReplies=(await database.query(`SELECT COUNT(DISTINCT COALESCE(intent->>'batchId',id))::int AS replies
    FROM stockchief_runtime.assistant_interactions WHERE workspace_id=$1
      AND intent #>> '{controlPlane,continuesPending}'='true'
      AND NULLIF(intent #>> '{controlPlane,originalMessage}','') IS DISTINCT FROM message
      AND status IN ('CLARIFY','PREPARED','ANSWERED')`,[workspaceId])).rows[0];
  const missions=Number(row.missions)+Number(standalone.outcomes)+Number(rules.outcomes)+Number(autonomous.outcomes);
  const completed=Number(row.completed)+Number(standalone.completed)+Number(rules.completed)+Number(autonomous.completed);
  // Asking a clarification or showing a Needs You item is not a human action.
  // Only owner messages and committed approvals contribute to the numerator.
  const specifications=Number(row.outcome_specifications)+Number(standalone.outcomes)+Number(rules.outcomes);
  const approvals=Number(row.approvals)+Number(standalone.completed)+Number(rules.completed);
  const replies=Number(clarificationReplies.replies);
  const human=specifications+approvals+replies;
  return {...row,missions,completed,outcome_specifications:specifications,approvals,
    clarifications:replies,user_interventions:0,humanInteractions:human,
    humanInteractionsPerCompleted:completed?Math.round((human/completed)*100)/100:null,
    completionRate:missions?Math.round((completed/missions)*1000)/10:null,
    breakdown:{multiStep:{outcomes:Number(row.missions),completed:Number(row.completed)},
      singleStep:{outcomes:Number(standalone.outcomes),completed:Number(standalone.completed)},
      standingRules:{outcomes:Number(rules.outcomes),completed:Number(rules.completed)},
      autonomousPurchases:{outcomes:Number(autonomous.outcomes),completed:Number(autonomous.completed)}}};}

function readyIndexes(steps,{retryPreparationFailures=false}={}){return steps.flatMap((step,index)=>step.state==='BLOCKED'
  &&(step.reason==='dependency_waiting'||retryPreparationFailures&&step.reason==='preparation_failed')
  &&step.dependsOn.every((dependency)=>steps[dependency]?.state==='DONE')
  ?[index]:[]);}

function ancestorIndexes(steps,index){
  const seen=new Set();const visit=(position)=>{for(const parent of steps[position]?.dependsOn||[]){
    if(seen.has(parent))continue;seen.add(parent);visit(parent);
  }};visit(index);return [...seen].sort((a,b)=>a-b);
}

function scopeReadToCompletedRecord(steps,index,contract,args){
  if(contract.kind!=='read'||!contract.recordKind||!steps[index].dependsOn.length)return args;
  const references=[...new Set(ancestorIndexes(steps,index).map(i=>steps[i]).filter((step)=>step.state==='DONE'
    &&registry.get(step.capability)?.kind==='mutation'
    &&(registry.get(step.capability)?.resultRecordKind||registry.get(step.capability)?.recordKind)===contract.recordKind
    &&step.args?.recordReference).map((step)=>step.args.recordReference))];
  const field=contract.fields.includes('recordReference')?'recordReference':
    contract.fields.includes('search')?'search':null;
  return references.length===1&&field?{...args,[field]:references[0]}:args;
}

async function scopeReadToRelatedParty(database,ctx,steps,index,contract,args){
  if(contract.kind!=='read'||contract.view!=='receivables'||args.search)return args;
  const references=[...new Set(steps.slice(0,index).filter((step)=>step.state==='DONE'
    &&registry.get(step.capability)?.kind==='mutation'
    &&(registry.get(step.capability)?.resultRecordKind||registry.get(step.capability)?.recordKind)==='sales_order'
    &&step.args?.recordReference).map((step)=>step.args.recordReference))];
  if(references.length!==1)return args;
  const rows=(await database.query(`SELECT c.name FROM sales_orders so JOIN customers c
    ON c.id=so.customer_id AND c.workspace_id=so.workspace_id
    WHERE so.workspace_id=$1 AND (so.order_number=$2 OR so.id=$2) LIMIT 2`,
  [ctx.workspaceId,references[0]])).rows;
  return rows.length===1?{...args,search:rows[0].name}:args;
}

async function externalState(database,workspaceId,result={},options={}){
  if(result.reportId&&result.deliveryId){
    const row=(await database.query(`SELECT d.status,d.provider_message_id,d.completed_at,d.error_message,
      e.provider_id,e.accepted_at,j.status AS email_status,j.last_error AS email_error,
      generation.status AS generation_status,generation.last_error AS generation_error
      FROM stockchief_runtime.report_deliveries d
      LEFT JOIN commercial_email_deliveries e ON e.job_id=d.email_job_id
      LEFT JOIN stockchief_runtime.jobs j ON j.workspace_id=d.workspace_id AND j.id=d.email_job_id
      LEFT JOIN stockchief_runtime.jobs generation ON generation.workspace_id=d.workspace_id
        AND generation.kind='report.generate-delivery' AND generation.payload->>'deliveryId'=d.id
      WHERE d.workspace_id=$1 AND d.template_id=$2 AND d.id=$3`,
    [workspaceId,result.reportId,result.deliveryId])).rows[0];
    if(!row)return {state:'BLOCKED',reason:'report_delivery_missing'};
    if(row.status==='SENT'&&row.provider_message_id&&row.completed_at&&row.provider_id===row.provider_message_id&&row.accepted_at)
      return {state:'DONE'};
    if(['FAILED','CANCELLED'].includes(row.status)||['DEAD','CANCELLED'].includes(row.email_status)||['DEAD','CANCELLED'].includes(row.generation_status))
      return {state:'BLOCKED',reason:'report_delivery_failed',detail:{status:row.status,error:row.error_message||row.email_error||row.generation_error}};
    return {state:'WAITING_EVENT',condition:{kind:'report_delivery',id:result.deliveryId,reportId:result.reportId,status:row.status}};
  }
  if(result.synchronizationHolds?.length)return {state:'BLOCKED',reason:'channel_synchronization_held',detail:result.synchronizationHolds};
  if(result.effectIds?.length){
    const pending=[];
    for(const id of new Set(result.effectIds)){
      const state=await externalState(database,workspaceId,{effectId:id},options);
      if(state.state==='BLOCKED')return state;
      if(state.state!=='DONE')pending.push(state.condition);
    }
    return pending.length?{state:'WAITING_EVENT',condition:{kind:'provider_effects',effects:pending}}:{state:'DONE'};
  }
  if(result.effectId){const row=(await database.query(`SELECT status,error_code,error_message,provider_reference
      FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND id=$2`,
    [workspaceId,result.effectId])).rows[0];
    if(!row)return {state:'BLOCKED',reason:'external_effect_missing'};
    if(row.status==='SUCCEEDED'){
      if(options.step?.capability==='communication.send_email'
        &&options.step.args?.supplierAcceptance==='required')
        return require('./postgres-supplier-acceptance').evaluate(database,workspaceId,result,
          options.steps,options.index,options.provider);
      return {state:'DONE'};
    }
    if(row.status==='AMBIGUOUS'&&row.provider_reference?.externalId){
      const verification=(await database.query(`SELECT id,status FROM stockchief_runtime.jobs WHERE workspace_id=$1
        AND payload->>'effectId'=$2 AND (payload->>'readOnlyVerification'='true' OR kind=ANY($3::text[]))
        AND status IN ('PENDING','RUNNING','RETRY') ORDER BY created_at DESC,id DESC LIMIT 1`,
        [workspaceId,result.effectId,['shipping.label.verify','shipping.void.verify']])).rows[0];
      if(verification)return {state:'WAITING_EVENT',condition:{kind:'provider_effect',id:result.effectId,status:'VERIFYING',verificationJobId:verification.id}};
    }
    if(['FAILED','AMBIGUOUS','CANCELLED'].includes(row.status))return {state:'BLOCKED',
      reason:row.status==='AMBIGUOUS'?'external_outcome_ambiguous':'external_effect_failed',detail:row};
    return {state:'WAITING_EVENT',condition:{kind:'provider_effect',id:result.effectId,status:row.status}};}
  if(result.jobId||result.job?.id){const id=result.jobId||result.job.id;const row=(await database.query(`SELECT status,last_error
      FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND id=$2`,[workspaceId,id])).rows[0];
    if(!row)return {state:'BLOCKED',reason:'external_job_missing'};
    if(row.status==='COMPLETED')return {state:'DONE'};
    if(['DEAD','CANCELLED'].includes(row.status))return {state:'BLOCKED',reason:'external_job_failed',detail:row};
    return {state:'WAITING_EVENT',condition:{kind:'job',id,status:row.status}};}
  return {state:'DONE'};
}

async function refreshApprovals(database,workspaceId,steps,provider=null){
  const ids=steps.filter((step)=>(['WAITING','WAITING_USER'].includes(step.state)||step.state==='DONE'&&registry.get(step.capability)?.resultReference)&&step.proposalId)
    .map((step)=>step.proposalId);
  const eventIds=steps.filter((step)=>step.state==='WAITING_EVENT'&&step.proposalId).map((step)=>step.proposalId);
  const allIds=[...new Set([...ids,...eventIds])];if(!allIds.length)return;
  const rows=(await database.query(`SELECT id,status,result FROM stockchief_runtime.assistant_action_proposals
    WHERE workspace_id=$1 AND id=ANY($2::text[])`,[workspaceId,allIds])).rows;
  const byId=new Map(rows.map((row)=>[row.id,row]));
  for(const [index,step] of steps.entries()){
    const completed=byId.get(step.proposalId);
    const contract=registry.get(step.capability),produced=contract?.resultReference&&completed?.status==='EXECUTED'?completed.result?.[contract.resultReference]:null;
    if(step.state==='DONE'&&typeof produced==='string'&&produced&&step.args?.recordReference!==produced){
      // Recover typed identifiers from already verified canonical receipts.
      // A schema/contract correction never repeats the creation or changes
      // the approved plan; downstream preparation rechecks current authority.
      step.args={...step.args,recordReference:produced};
      for(const descendant of steps){if(descendant.state==='BLOCKED'&&descendant.reason===null&&!descendant.proposalId&&registry.get(descendant.capability)?.recordKind===contract.resultRecordKind&&ancestorIndexes(steps,steps.indexOf(descendant)).includes(index))descendant.reason='dependency_waiting';}
    }
    if(['WAITING','WAITING_USER','WAITING_EVENT'].includes(step.state)&&completed?.status==='EXECUTED'){
      const external=await externalState(database,workspaceId,completed.result||{},
        {step,steps,index,provider});
      step.state=external.state;step.reason=external.reason||null;step.waitingCondition=external.condition||null;
      if(external.evidence)step.acceptanceEvidence=external.evidence;
      const resultReference=registry.get(step.capability)?.resultReference;
      if(resultReference&&completed.result?.[resultReference])
        step.args={...step.args,recordReference:completed.result[resultReference]};
    }
    if(['WAITING','WAITING_USER'].includes(step.state)&&completed?.status==='CANCELLED'){
      step.state='BLOCKED';step.reason='dependency_cancelled';
    }
  }
}

async function update(database,plan,token,steps,status){
  const waiting=steps.find((step)=>['WAITING','WAITING_USER'].includes(step.state));
  const waitingEvent=steps.find((step)=>step.state==='WAITING_EVENT');
  const verification=status==='DONE'?'VERIFIED':status==='BLOCKED'?'FAILED':'PENDING';
  await database.query(`UPDATE stockchief_runtime.assistant_capability_plans
    SET steps=$4::jsonb,status=$5,waiting_proposal_id=$6,waiting_condition=$7::jsonb,
      verification_status=$8,completed_at=CASE WHEN $5='DONE' THEN COALESCE(completed_at,now()) ELSE completed_at END,
      updated_at=now()
    WHERE workspace_id=$1 AND id=$2 AND run_token=$3`,[plan.workspace_id,plan.id,token,
    JSON.stringify(steps),status,waiting?.proposalId||null,JSON.stringify(waitingEvent?.waitingCondition||null),verification]);
}

const DEPENDENCY_FIELDS=new Set(['recordReference','sku','skuScope','supplier','customer','location',
  'fromLocation','toLocation','purchaseOrder','salesOrder','shipment','transfer']);
function present(value){return value!==null&&value!==undefined&&String(value).trim()!=='';}
function approvedStepSafe(plan,index,resolvedArgs,dependencyArgs){
  const approved=plan.approved_steps?.[index];const contract=registry.get(approved?.capability);
  if(!approved||!contract||contract.name!==plan.steps[index]?.capability)return false;
  for(const field of contract.required||[]){
    if(present(approved.args?.[field]))continue;
    if(DEPENDENCY_FIELDS.has(field)&&present(dependencyArgs?.[field]))continue;
    return false;
  }
  for(const [field,value] of Object.entries(approved.args||{})){
    if(!present(value)||DEPENDENCY_FIELDS.has(field))continue;
    if(present(resolvedArgs?.[field])&&String(resolvedArgs[field])!==String(value))return false;
  }
  return true;
}

/** Resume only the stored plan, never reinterpret the original wording after approval. */
async function resume(database,ctx,proposalId,{service,provider,rawProvider,record=async()=>{},executeAuthorizedProposal=null,
  missionId=null,nativeAnswerOwner=false}={}){
  const candidates=(await database.query(`SELECT id FROM stockchief_runtime.assistant_capability_plans
    WHERE workspace_id=$1 AND actor_user_id=$2 AND (status IN ('WAITING','ADVANCING','WAITING_EVENT','WAITING_USER') OR status='BLOCKED' AND authorization_mode='MISSION' AND approval_status='APPROVED')
      AND (($4::text IS NOT NULL AND id=$4) OR ($4::text IS NULL AND steps @> $3::jsonb)) ORDER BY created_at`,
  [ctx.workspaceId,ctx.actorId,JSON.stringify([{proposalId}]),missionId])).rows;
  const continued=[];
  for(const candidate of candidates){
    const token=newId('pgclaim');
    const claimed=(await database.query(`UPDATE stockchief_runtime.assistant_capability_plans
      SET run_token=$3,run_started_at=now(),status='ADVANCING',updated_at=now()
      WHERE workspace_id=$1 AND id=$2 AND (run_token IS NULL OR run_started_at<now()-interval '2 minutes')
      RETURNING *`,[ctx.workspaceId,candidate.id,token])).rows[0];
    if(!claimed)continue;
    const steps=claimed.steps;
    try{
      const beforeRefresh=steps.map((step)=>step.state);
      if(claimed.approval_status==='REVOKED'){
        for(const step of steps)if(step.state!=='DONE'){step.state='BLOCKED';step.reason='mission_authority_revoked';}
        await update(database,claimed,token,steps,'BLOCKED');continue;
      }
      await refreshApprovals(database,ctx.workspaceId,steps,provider);
      let metrics=claimed.metrics||{};
      if(steps.some((step,index)=>['WAITING_EVENT','WAITING_USER'].includes(beforeRefresh[index])
        &&step.state==='DONE'))
        metrics=metric(metrics,'resumptions');
      const actor=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',
        [ctx.workspaceId,ctx.actorId])).rows[0]||null;
      while(true){
        // Resume an approved prepared step after a transaction abort/restart.
        // The normal preparation path revalidates its current records and the
        // SAME idempotency key. createProposal rejects a changed payload; the
        // canonical executor still locks, authorizes and verifies every effect.
        const preparedIndex=claimed.authorization_mode==='MISSION'&&claimed.approval_status==='APPROVED'&&executeAuthorizedProposal
          ?steps.findIndex(step=>step.state==='WAITING'&&step.proposalId&&step.dependsOn.every(i=>steps[i]?.state==='DONE')):-1;
        const next=preparedIndex>=0?preparedIndex:readyIndexes(steps,{retryPreparationFailures:Boolean(missionId)})[0];if(next===undefined)break;
        const stored=steps[next];const contract=registry.get(stored.capability);
        if(!contract){stored.state='BLOCKED';stored.reason='capability_removed';break;}
        const satisfiedBy=stored.dependsOn.map((index)=>steps[index]).filter((parent)=>
          parent?.state==='DONE'&&parent.args?.recordReference&&
          registry.get(parent.capability)?.resultRecordKind===contract.recordKind&&
          registry.get(parent.capability)?.satisfiesCapabilities?.includes(contract.name));
        if(satisfiedBy.length===1){
          // Plans saved before a capability-subsumption fix can be resumed
          // without repeating an already-completed business transition.
          stored.args={...stored.args,recordReference:satisfiedBy[0].args.recordReference};
          stored.state='DONE';stored.reason=null;
          await update(database,claimed,token,steps,'ADVANCING');
          continue;
        }
        const ancestors=ancestorIndexes(steps,next);
        const dependencyArgs=Object.assign({},...ancestors.map((index)=>steps[index]?.args||{}));
        const produced=ancestors.map((index)=>steps[index]).filter((parent)=>
          parent?.args?.recordReference&&registry.get(parent.capability)?.resultRecordKind===contract.recordKind);
        // The identifier returned by an approved creation is authoritative.
        // A planner-supplied guess for the not-yet-existing record cannot override it.
        const mutationArgs=produced.length===1
          ?{...stored.args,recordReference:produced[0].args.recordReference}:stored.args;
        const executionArgs=await scopeReadToRelatedParty(database,ctx,steps,next,contract,
          scopeReadToCompletedRecord(steps,next,contract,mutationArgs));
        // A proposal may already have been prepared independently before an
        // earlier mission effect committed. Revalidate through the same
        // canonical preparation key, preserving its exact reviewed revision
        // instead of creating a second orphan proposal under a plan-only key.
        let preparationKey=`plan:${claimed.id}:${next}`;
        let preparationMessage=claimed.source_message;
        if(stored.proposalId){
          const prepared=(await database.query(`SELECT idempotency_key,source_message FROM stockchief_runtime.assistant_action_proposals
            WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,stored.proposalId])).rows[0];
          if(!prepared)throw Error('MISSION_PREPARED_SCOPE_CHANGED');
          preparationKey=prepared.idempotency_key;
          // Preserve the preparation's original authenticated clarifications.
          preparationMessage=prepared.source_message;
        }
        let outcome;
        try{
          outcome=await executeStep(service,database,{...ctx,planStepKey:preparationKey},
            {contract,args:executionArgs,dependsOn:stored.dependsOn,continuesPending:false},
            {actor,provider,rawProvider,sourceMessage:preparationMessage,pending:null,page:null,
              usageKey:`plan:${claimed.id}:${next}`,dependencyArgs});
        }catch(error){
          console.warn('[stockchief] Ask plan step failed',JSON.stringify({
            capability:stored.capability,code:error.code||error.name||'unknown',
          }));
          // Preparation has not executed this step. Keep earlier verified
          // effects, persist the business refusal, and stop claiming progress.
          // Only an explicit mission continuation retries a refused step.
          if(error instanceof ValidationError){
            stored.state='BLOCKED';stored.reason='preparation_failed';
            stored.failure={code:error.code,message:error.message};
            const refusal={status:'CLARIFY',reason:'preparation_failed',
              answer:`Earlier verified changes are preserved. This step could not be prepared: ${error.message}`};
            await update(database,claimed,token,steps,'BLOCKED');
            await record(claimed,next,{step:{contract,dependsOn:stored.dependsOn,continuesPending:false},args:executionArgs,result:refusal});
            // Existing callers use continuationError to show a failed mission.
            // Persist first, then preserve that error contract for the UI.
            throw error;
          }
          throw error;
        }
        // A read resumed after approval must answer the owner's original
        // question from its rows, just like a standalone Ask read. The raw
        // query's generic count is not an answer to requested measurements.
        // Native goals consume and independently verify these canonical rows in
        // their own continuation. A second legacy model cannot own their answer.
        if(!nativeAnswerOwner&&contract.kind==='read'&&outcome.result.status==='ANSWERED'
          &&contract.answerMode!=='executor'){
          const completedActions=steps.slice(0,next).filter((step)=>step.state==='DONE'
            &&registry.get(step.capability)?.kind==='mutation').map((step)=>({
              capability:step.capability,recordReference:step.args?.recordReference||null,
              status:'EXECUTED'}));
          const answered=await synthesizeReads(provider,claimed.source_message,
            [{step:{contract},...outcome}],{completedActions});
          outcome={...outcome,result:answered[0].result};
        }
        delete stored.failure;
        stored.args=outcome.args;stored.state=outcome.result.status==='ANSWERED'?'DONE':
          outcome.result.status==='PREPARED'?'WAITING':'BLOCKED';
        stored.reason=outcome.result.reason||null;stored.proposalId=outcome.result.proposal?.id||null;
        await update(database,claimed,token,steps,'ADVANCING');
        await record(claimed,next,{step:{contract,dependsOn:stored.dependsOn,continuesPending:false},...outcome});
        continued.push(outcome.result);
        if(stored.state==='WAITING'&&claimed.authorization_mode==='MISSION'
          &&claimed.approval_status==='APPROVED'&&executeAuthorizedProposal){
          if(!approvedStepSafe({...claimed,steps},next,outcome.args,dependencyArgs)){
            stored.state='WAITING_USER';stored.reason='mission_scope_incomplete';
            await update(database,claimed,token,steps,'WAITING_USER');
            break;
          }
          const executedProposal=await executeAuthorizedProposal(stored.proposalId,claimed.id);
          const external=await externalState(database,ctx.workspaceId,executedProposal.result||{},
            {step:stored,steps,index:next,provider});
          stored.state=external.state;stored.reason=external.reason||null;
          stored.waitingCondition=external.condition||null;
          if(external.evidence)stored.acceptanceEvidence=external.evidence;
          const resultReference=contract.resultReference;
          if(resultReference&&executedProposal.result?.[resultReference])
            stored.args={...stored.args,recordReference:executedProposal.result[resultReference]};
          metrics=metric(metrics,'automaticSteps');
          if(stored.state==='WAITING_EVENT')metrics=metric(metrics,'externalWaits');
          await database.query(`UPDATE stockchief_runtime.assistant_capability_plans SET metrics=$3::jsonb
            WHERE workspace_id=$1 AND id=$2 AND run_token=$4`,[ctx.workspaceId,claimed.id,JSON.stringify(metrics),token]);
          await update(database,claimed,token,steps,stored.state==='WAITING_EVENT'?'WAITING_EVENT':
            stored.state==='DONE'?'ADVANCING':'BLOCKED');
          if(stored.state==='DONE')continue;
          break;
        }
        if(stored.state!=='DONE')break;
      }
      const status=steps.some((step)=>step.state==='WAITING')?'WAITING':
        steps.some((step)=>step.state==='WAITING_USER')?'WAITING_USER':
        steps.some((step)=>step.state==='WAITING_EVENT')?'WAITING_EVENT':
        steps.every((step)=>step.state==='DONE')?'DONE':'BLOCKED';
      await update(database,claimed,token,steps,status);
      await database.query(`UPDATE stockchief_runtime.assistant_capability_plans SET metrics=$3::jsonb,
        result=$4::jsonb WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,claimed.id,JSON.stringify(metrics),
        JSON.stringify({completedSteps:steps.filter((step)=>step.state==='DONE').length,totalSteps:steps.length,
          outcome:claimed.outcome,status})]);
    }finally{
      await database.query(`UPDATE stockchief_runtime.assistant_capability_plans
        SET run_token=NULL,run_started_at=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND run_token=$3`,
      [ctx.workspaceId,claimed.id,token]);
    }
  }
  return continued;
}

module.exports={serialized,save,readyIndexes,scopeReadToCompletedRecord,
  scopeReadToRelatedParty,ancestorIndexes,resume,missionForProposal,authorize,planHash,externalState,approvedStepSafe,metricsSummary};

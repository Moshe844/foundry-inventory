'use strict';

const {newId}=require('../lib/util');
const {registry}=require('./postgres-capability-registry');
const {executeStep,synthesizeReads}=require('./postgres-control-plane');

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
  const id=newId('pgplan');
  await database.query(`INSERT INTO stockchief_runtime.assistant_capability_plans
    (id,workspace_id,actor_user_id,batch_id,source_message,steps,status,waiting_proposal_id)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,[id,ctx.workspaceId,ctx.actorId,batchId||id,message,
    JSON.stringify(records),waiting?'WAITING':'BLOCKED',waiting?.proposalId||null]);
  return {id,batchId:batchId||id};
}

function readyIndexes(steps){return steps.flatMap((step,index)=>step.state==='BLOCKED'
  &&step.reason==='dependency_waiting'&&step.dependsOn.every((dependency)=>steps[dependency]?.state==='DONE')
  ?[index]:[]);}

async function refreshApprovals(database,workspaceId,steps){
  const ids=steps.filter((step)=>step.state==='WAITING'&&step.proposalId).map((step)=>step.proposalId);
  if(!ids.length)return;
  const rows=(await database.query(`SELECT id,status,result FROM stockchief_runtime.assistant_action_proposals
    WHERE workspace_id=$1 AND id=ANY($2::text[])`,[workspaceId,ids])).rows;
  const byId=new Map(rows.map((row)=>[row.id,row]));
  for(const step of steps){
    const completed=byId.get(step.proposalId);
    if(step.state==='WAITING'&&completed?.status==='EXECUTED'){
      step.state='DONE';
      const resultReference=registry.get(step.capability)?.resultReference;
      if(resultReference&&completed.result?.[resultReference])
        step.args={...step.args,recordReference:completed.result[resultReference]};
    }
    if(step.state==='WAITING'&&completed?.status==='CANCELLED'){
      step.state='BLOCKED';step.reason='dependency_cancelled';
    }
  }
}

async function update(database,plan,token,steps,status){
  const waiting=steps.find((step)=>step.state==='WAITING');
  await database.query(`UPDATE stockchief_runtime.assistant_capability_plans
    SET steps=$4::jsonb,status=$5,waiting_proposal_id=$6,updated_at=now()
    WHERE workspace_id=$1 AND id=$2 AND run_token=$3`,[plan.workspace_id,plan.id,token,
    JSON.stringify(steps),status,waiting?.proposalId||null]);
}

/** Resume only the stored plan, never reinterpret the original wording after approval. */
async function resume(database,ctx,proposalId,{service,provider,rawProvider,record}){
  const candidates=(await database.query(`SELECT id FROM stockchief_runtime.assistant_capability_plans
    WHERE workspace_id=$1 AND actor_user_id=$2 AND status IN ('WAITING','ADVANCING')
      AND steps @> $3::jsonb ORDER BY created_at`,[ctx.workspaceId,ctx.actorId,
    JSON.stringify([{proposalId}])])).rows;
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
      await refreshApprovals(database,ctx.workspaceId,steps);
      const actor=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',
        [ctx.workspaceId,ctx.actorId])).rows[0]||null;
      while(true){
        const next=readyIndexes(steps)[0];if(next===undefined)break;
        const stored=steps[next];const contract=registry.get(stored.capability);
        if(!contract){stored.state='BLOCKED';stored.reason='capability_removed';break;}
        const dependencyArgs=Object.assign({},...stored.dependsOn.map((index)=>steps[index]?.args||{}));
        const produced=stored.dependsOn.map((index)=>steps[index]).filter((parent)=>
          parent?.args?.recordReference&&registry.get(parent.capability)?.resultRecordKind===contract.recordKind);
        // The identifier returned by an approved creation is authoritative.
        // A planner-supplied guess for the not-yet-existing record cannot override it.
        const executionArgs=produced.length===1
          ?{...stored.args,recordReference:produced[0].args.recordReference}:stored.args;
        let outcome=await executeStep(service,database,{...ctx,planStepKey:`plan:${claimed.id}:${next}`},
          {contract,args:executionArgs,dependsOn:stored.dependsOn,continuesPending:false},
          {actor,provider,rawProvider,sourceMessage:claimed.source_message,pending:null,page:null,
            usageKey:`plan:${claimed.id}:${next}`,dependencyArgs});
        // A read resumed after approval must answer the owner's original
        // question from its rows, just like a standalone Ask read. The raw
        // query's generic count is not an answer to requested measurements.
        if(contract.kind==='read'&&outcome.result.status==='ANSWERED'
          &&contract.answerMode!=='executor'){
          const answered=await synthesizeReads(provider,claimed.source_message,
            [{step:{contract},...outcome}]);
          outcome={...outcome,result:answered[0].result};
        }
        stored.args=outcome.args;stored.state=outcome.result.status==='ANSWERED'?'DONE':
          outcome.result.status==='PREPARED'?'WAITING':'BLOCKED';
        stored.reason=outcome.result.reason||null;stored.proposalId=outcome.result.proposal?.id||null;
        await update(database,claimed,token,steps,'ADVANCING');
        await record(claimed,next,{step:{contract,dependsOn:stored.dependsOn,continuesPending:false},...outcome});
        continued.push(outcome.result);
        if(stored.state!=='DONE')break;
      }
      const status=steps.some((step)=>step.state==='WAITING')?'WAITING':
        steps.every((step)=>step.state==='DONE')?'DONE':'BLOCKED';
      await update(database,claimed,token,steps,status);
    }finally{
      await database.query(`UPDATE stockchief_runtime.assistant_capability_plans
        SET run_token=NULL,run_started_at=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND run_token=$3`,
      [ctx.workspaceId,claimed.id,token]);
    }
  }
  return continued;
}

module.exports={serialized,save,readyIndexes,resume};

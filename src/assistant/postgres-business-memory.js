'use strict';

const crypto=require('node:crypto');
const {newId}=require('../lib/util');

function stable(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value??null);
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function digest(value){return crypto.createHash('sha256').update(stable(value)).digest('hex');}

function resultIdentity(result={}){
  // A canonical record ID takes precedence over related actor, location, or
  // approval IDs in a hydrated business result. Those other IDs are context,
  // not the record a follow-up should act on.
  if(typeof result.id==='string'&&result.id.trim())return {id:result.id,
    ...(typeof result.sourceName==='string'?{sourceName:result.sourceName}:{})};
  const entries=Object.entries(result).filter(([key,value])=>
    /(?:Id|Number)$/.test(key)&&!/(?:ByUserId|ActorId|LocationId|ConnectorId)$/.test(key)
      &&['string','number'].includes(typeof value));
  return entries.length?Object.fromEntries(entries):null;
}

async function remember(database,ctx,{type,key,value,provenance,confidence='VERIFIED',
  sourceRecordType=null,sourceRecordId=null}){
  const id=newId('memory');
  const row=(await database.query(`INSERT INTO stockchief_runtime.assistant_business_memory
    (id,workspace_id,memory_type,memory_key,value,provenance,confidence,source_actor_user_id,
      source_record_type,source_record_id)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10)
    ON CONFLICT(workspace_id,memory_type,memory_key) WHERE retired_at IS NULL
    DO UPDATE SET value=EXCLUDED.value,provenance=EXCLUDED.provenance,confidence=EXCLUDED.confidence,
      source_actor_user_id=EXCLUDED.source_actor_user_id,source_record_type=EXCLUDED.source_record_type,
      source_record_id=EXCLUDED.source_record_id,effective_at=now(),updated_at=now()
    RETURNING *`,[id,ctx.workspaceId,type,key,JSON.stringify(value),JSON.stringify(provenance),confidence,
    ctx.actorId||null,sourceRecordType,sourceRecordId])).rows[0];
  return row;
}

async function rememberProposal(database,ctx,proposal){
  if(!proposal||proposal.status!=='EXECUTED')return null;
  const identity=resultIdentity(proposal.result||{});
  const primaryId=proposal.payload?.recordId||proposal.result?.id||identity&&Object.values(identity)[0];
  const key=`action:${proposal.action_type}:${identity?digest(identity).slice(0,24):proposal.id}`;
  return remember(database,ctx,{type:'OUTCOME',key,value:{action:proposal.action_type,
    summary:proposal.summary,result:proposal.result,completedAt:proposal.executed_at},
  provenance:{kind:'assistant_action_proposal',proposalId:proposal.id,idempotencyKey:proposal.idempotency_key,
    verifiedBy:'capability_execution_verifier'},confidence:'VERIFIED',sourceRecordType:proposal.action_type,
  sourceRecordId:primaryId||proposal.id});
}

async function rememberPreference(database,ctx,{key,value,proposalId,ruleDomain}){
  return remember(database,ctx,{type:'PREFERENCE',key,value,
    provenance:{kind:'approved_operating_instruction',proposalId,ruleDomain},
    confidence:'OWNER_STATED',sourceRecordType:'operating_instruction',sourceRecordId:proposalId});
}

async function context(database,workspaceId,{limit=24}={}){
  const rows=(await database.query(`SELECT memory_type,memory_key,value,confidence,provenance,effective_at
    FROM stockchief_runtime.assistant_business_memory
    WHERE workspace_id=$1 AND retired_at IS NULL
    ORDER BY CASE memory_type WHEN 'PREFERENCE' THEN 0 WHEN 'VERIFIED_FACT' THEN 1 ELSE 2 END,
      updated_at DESC,id DESC LIMIT $2`,[workspaceId,Math.min(50,Math.max(1,limit))])).rows;
  return rows.map((row)=>({type:row.memory_type,key:row.memory_key,value:row.value,
    confidence:row.confidence,provenance:row.provenance,effectiveAt:row.effective_at}));
}

function bounded(value,depth=0){
  if(value===null||value===undefined||typeof value==='boolean'||typeof value==='number')return value;
  if(typeof value==='string')return value.slice(0,180);
  if(depth>=3)return Array.isArray(value)?[]:{};
  if(Array.isArray(value))return value.slice(0,6).map((entry)=>bounded(entry,depth+1));
  return Object.fromEntries(Object.entries(value).slice(0,16).map(([key,entry])=>[key,bounded(entry,depth+1)]));
}

// Planner memory is deliberately compact.  Full verified results remain in
// the durable memory table and canonical business records; re-sending those
// payloads on every Ask request would duplicate recent-change context and can
// consume the model cost budget before the owner receives an answer.
async function plannerContext(database,workspaceId,{limit=12}={}){
  const records=await context(database,workspaceId,{limit});
  let outcomes=0;
  return records.filter((record)=>record.type!=='OUTCOME'||outcomes++<3).map((record)=>{
    if(record.type==='OUTCOME')return {type:record.type,key:record.key,confidence:record.confidence,
      value:{action:record.value?.action,summary:String(record.value?.summary||'').slice(0,120),
        resultIdentity:resultIdentity(record.value?.result||{})},effectiveAt:record.effectiveAt};
    return {type:record.type,key:record.key,confidence:record.confidence,
      value:bounded(record.value),effectiveAt:record.effectiveAt};
  });
}

async function retire(database,ctx,type,key){
  return database.query(`UPDATE stockchief_runtime.assistant_business_memory SET retired_at=now(),updated_at=now()
    WHERE workspace_id=$1 AND memory_type=$2 AND memory_key=$3 AND retired_at IS NULL`,
  [ctx.workspaceId,type,key]);
}

module.exports={remember,rememberProposal,rememberPreference,context,plannerContext,retire,digest,stable};

'use strict';
const {randomUUID}=require('node:crypto');
function createBudget(db,ctx,goalId){
 async function status(client=db){
  // One database snapshot and round trip for approval + exposure. In
  // particular, do not combine an earlier approval with later ledger totals.
  // The reservation path still locks the pilot and repeats fresh authority.
  const row=(await client.query(`SELECT p.pilot,u.*
   FROM stockchief_runtime.codex_pilot_workspace_access p
   CROSS JOIN LATERAL (SELECT COALESCE(sum(CASE WHEN state='SETTLED' THEN charged ELSE reserved END),0) AS committed,
    count(*) AS calls,count(*) FILTER(WHERE state IN ('RESERVED','UNKNOWN')) AS unresolved
    FROM stockchief_runtime.codex_pilot_calls WHERE funding_workspace_id=p.funding_workspace_id) u
   WHERE p.workspace_id=$1`,[ctx.workspaceId])).rows[0]||{pilot:null,committed:0,calls:0,unresolved:0};
  const p=row.pilot,u=row;
  return {approval:p?.approval_reference,ceiling:Number(p?.ceiling_micro_usd||0),expires:p?new Date(p.period_ends_at).getTime():0,
   stopped:!p?.enabled||p.stopped,committed:Number(u.committed),calls:Number(u.calls),unresolved:Number(u.unresolved),
   remaining:Math.max(0,Number(p?.ceiling_micro_usd||0)-Number(u.committed))};
 }
 return {status,
  async reserve({candidate,task,upperBoundMicroUsd,detail={}}){
   if(candidate!=='codex'||task!==goalId||!Number.isSafeInteger(upperBoundMicroUsd)||upperBoundMicroUsd<=0||upperBoundMicroUsd>300000)throw Error('INVALID_PILOT_RESERVATION');
   return db.transaction(async client=>{
    const {pilot}=await require('./postgres-codex-pilot').access(client,ctx,{enabled:true});
    await client.query('SELECT workspace_id FROM stockchief_runtime.codex_pilots WHERE workspace_id=$1 FOR UPDATE',[pilot.funding_workspace_id]);
    await require('./postgres-codex-pilot').access(client,ctx,{enabled:true});const state=await status(client);
    if(!state.approval||state.stopped||state.expires<=Date.now())throw Error('PAID_TESTING_LOCKED');
    if(state.unresolved)throw Error('UNRESOLVED_MODEL_CALL');
    if(upperBoundMicroUsd>state.remaining)throw Error('SHARED_SPENDING_CEILING');
    const id=randomUUID();await client.query(`INSERT INTO stockchief_runtime.codex_pilot_calls(id,workspace_id,actor_id,goal_id,reserved,state,detail,funding_workspace_id)
     VALUES($1,$2,$3,$4,$5,'RESERVED',$6::jsonb,$7)`,[id,ctx.workspaceId,ctx.actorId,goalId,upperBoundMicroUsd,JSON.stringify(detail),pilot.funding_workspace_id]);return id;
   },{isolation:'SERIALIZABLE',retrySafe:true});
  },
  async settle(id,charged,detail={}){
   if(!Number.isSafeInteger(charged)||charged<0)throw Error('INVALID_PILOT_SETTLEMENT');
   const r=await db.query(`UPDATE stockchief_runtime.codex_pilot_calls SET state='SETTLED',charged=$5,detail=$6::jsonb
    WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND goal_id=$4 AND state='RESERVED' AND reserved>=$5 RETURNING id`,
    [id,ctx.workspaceId,ctx.actorId,goalId,charged,JSON.stringify(detail)]);if(!r.rowCount)throw Error('PILOT_SETTLEMENT_REQUIRES_RECONCILIATION');
  },
  async unknown(id,reason,detail={}){await db.query(`UPDATE stockchief_runtime.codex_pilot_calls SET state='UNKNOWN',detail=detail||$5::jsonb
   WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND goal_id=$4 AND state='RESERVED'`,[id,ctx.workspaceId,ctx.actorId,goalId,JSON.stringify({...detail,reason})]);},
  async stop(){const {pilot}=await require('./postgres-codex-pilot').access(db,ctx);
   await db.query('UPDATE stockchief_runtime.codex_pilots SET stopped=true WHERE workspace_id=$1',[pilot.funding_workspace_id]);}
 };
}
module.exports={createBudget};

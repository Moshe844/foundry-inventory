'use strict';
// Installation cost protection is separate from every customer's commercial
// credit wallet and business authority. Configuration never creates funding.
function fundingWorkspaceId(){
 const id=process.env.STOCKCHIEF_STAGING_CERTIFICATION_FUNDING_WORKSPACE||null;
 if(id&&process.env.STOCKCHIEF_RUNTIME_ENV!=='staging')throw Error('CERTIFICATION_STAGING_ONLY');
 return id;
}
async function exposure(db,id){
 const row=(await db.query(`SELECT
  coalesce((SELECT sum(CASE WHEN state='SETTLED' THEN charged ELSE reserved END)
   FROM stockchief_runtime.codex_pilot_calls WHERE funding_workspace_id=$1
    OR detail->>'certificationFundingWorkspaceId'=$1),0)
  +coalesce((SELECT sum(CASE WHEN status='SETTLED' THEN actual_minor
    WHEN status IN ('RESERVED','UNKNOWN') THEN maximum_minor ELSE 0 END)*10000
   FROM commercial_model_cost_holds WHERE detail->>'certificationFundingWorkspaceId'=$1),0) AS committed,
  (SELECT count(*) FROM stockchief_runtime.codex_pilot_calls WHERE
   (funding_workspace_id=$1 OR detail->>'certificationFundingWorkspaceId'=$1)
    AND state IN ('RESERVED','UNKNOWN'))
  +(SELECT count(*) FROM commercial_model_cost_holds WHERE detail->>'certificationFundingWorkspaceId'=$1
    AND status IN ('RESERVED','UNKNOWN')) AS unresolved`,[id])).rows[0];
 return {committed:Number(row.committed),unresolved:Number(row.unresolved)};
}
async function reserve(client,maximumMicroUsd,{fundingId=fundingWorkspaceId(),goalId=null}={}){
 if(!fundingId)return null;
 if(!Number.isSafeInteger(maximumMicroUsd)||maximumMicroUsd<=0||maximumMicroUsd>300000)throw Error('INVALID_CERTIFICATION_RESERVATION');
 const pilot=(await client.query("SELECT * FROM stockchief_runtime.codex_pilots WHERE workspace_id=$1 AND admission_kind='PILOT' FOR UPDATE",[fundingId])).rows[0];
 if(!pilot?.enabled||pilot.stopped||new Date(pilot.period_starts_at)>new Date()||new Date(pilot.period_ends_at)<=new Date())throw Error('CERTIFICATION_WINDOW_CLOSED');
 const used=await exposure(client,fundingId);
 if(used.unresolved)throw Error('CERTIFICATION_UNRESOLVED');
 if(used.committed+maximumMicroUsd>Number(pilot.ceiling_micro_usd))throw Error('CERTIFICATION_SPENDING_CEILING');
 if(goalId){const goal=(await client.query(`SELECT coalesce(sum(CASE WHEN state='SETTLED' THEN charged ELSE reserved END),0) AS amount
   FROM stockchief_runtime.codex_pilot_calls WHERE goal_id=$1
    AND (funding_workspace_id=$2 OR detail->>'certificationFundingWorkspaceId'=$2)`,[goalId,fundingId])).rows[0];
  if(Number(goal.amount)+maximumMicroUsd>1000000)throw Error('CERTIFICATION_GOAL_CEILING');}
 return fundingId;
}
function detail(value={},fundingId=null){
 const {certificationFundingWorkspaceId:ignored,...rest}=value;
 return {...rest,...(fundingId?{certificationFundingWorkspaceId:fundingId}:{})};
}
module.exports={fundingWorkspaceId,exposure,reserve,detail};

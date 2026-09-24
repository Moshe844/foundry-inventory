'use strict';

const paths=require('./paths');
const { ValidationError }=require('../domain/errors');
const { nowIso,trimOrNull }=require('../lib/util');

function hydrate(row){return paths.hydrate(row);}

async function get(database,workspaceId){
  const result=await database.query('SELECT * FROM workspace_onboarding WHERE workspace_id=$1',[workspaceId]);
  return hydrate(result.rows[0]);
}

async function ensure(database,workspaceId){
  const at=nowIso();
  await database.query(`INSERT INTO workspace_onboarding(workspace_id,path,status,started_at,updated_at)
    VALUES($1,'undecided','choosing',$2,$2) ON CONFLICT(workspace_id) DO NOTHING`,[workspaceId,at]);
  return get(database,workspaceId);
}

async function choose(database,workspaceId,path,options={}){
  if(!paths.PATH_IDS.includes(path))throw new ValidationError('That is not one of the onboarding paths.');
  await ensure(database,workspaceId);
  const at=nowIso();
  await database.query(`UPDATE workspace_onboarding SET path=$2,path_chosen_by=$3,path_reason=$4,
      described_as=COALESCE($5,described_as),status=$6,updated_at=$7 WHERE workspace_id=$1`,
  [workspaceId,path,options.chosenBy==='foundry'?'foundry':'customer',trimOrNull(options.reason),
    trimOrNull(options.describedAs),path==='fresh'?'understanding':'collecting',at]);
  return get(database,workspaceId);
}

async function setStatus(database,workspaceId,status){
  await ensure(database,workspaceId);
  const at=nowIso();
  await database.query(`UPDATE workspace_onboarding SET status=$2,
    completed_at=CASE WHEN $2='ready' THEN $3 ELSE completed_at END,updated_at=$3 WHERE workspace_id=$1`,
  [workspaceId,status,at]);
  return get(database,workspaceId);
}

async function reconcileWithInventoryTruth(database,workspaceId){
  const state=await get(database,workspaceId);
  if(!state || state.isComplete || state.path!=='fresh')return state;
  const result=await database.query('SELECT 1 FROM movements WHERE workspace_id=$1 LIMIT 1',[workspaceId]);
  return result.rows.length?setStatus(database,workspaceId,'ready'):state;
}

module.exports={...paths,get,ensure,choose,setStatus,reconcileWithInventoryTruth};

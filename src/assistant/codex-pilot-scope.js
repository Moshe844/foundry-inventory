'use strict';
const list=value=>String(value||'').split(',').map(s=>s.trim()).filter(Boolean);
const fundingWorkspaces=()=>list(process.env.STOCKCHIEF_CODEX_PILOT_WORKSPACES);
const accountAccess=()=>process.env.STOCKCHIEF_CODEX_PILOT_ACCOUNT_ACCESS==='1';
function configured(ctx){return process.env.STOCKCHIEF_RUNTIME_ENV==='staging'&&process.env.STOCKCHIEF_CODEX_PILOT==='1'&&
 fundingWorkspaces().length>0&&(fundingWorkspaces().includes(ctx.workspaceId)||accountAccess());}
// Configuration is only an admission hint. The database grant, current
// membership, approved login and commercial rights are checked separately.
async function availableWorkspace(db,workspaceId){
 if(!configured({workspaceId}))return false;
 return Boolean((await db.query(`SELECT 1 FROM stockchief_runtime.codex_pilot_workspace_access
  WHERE workspace_id=$1 AND funding_workspace_id=ANY($2::text[])`,[workspaceId,fundingWorkspaces()])).rows.length);
}
module.exports={list,fundingWorkspaces,accountAccess,configured,availableWorkspace};

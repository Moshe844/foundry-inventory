'use strict';
const list=value=>String(value||'').split(',').map(s=>s.trim()).filter(Boolean);
const fundingWorkspaces=()=>list(process.env.STOCKCHIEF_CODEX_PILOT_WORKSPACES);
const accountAccess=()=>process.env.STOCKCHIEF_CODEX_PILOT_ACCOUNT_ACCESS==='1';
const customerAccess=()=>process.env.STOCKCHIEF_CODEX_CUSTOMER_ACCESS==='1'&&['staging','production'].includes(process.env.STOCKCHIEF_RUNTIME_ENV);
function configured(ctx){return customerAccess()||process.env.STOCKCHIEF_RUNTIME_ENV==='staging'&&process.env.STOCKCHIEF_CODEX_PILOT==='1'&&
 fundingWorkspaces().length>0&&(fundingWorkspaces().includes(ctx.workspaceId)||accountAccess());}
// Configuration is only an admission hint. The database grant, current
// membership, approved login and commercial rights are checked separately.
async function availableWorkspace(db,workspaceId){
 if(!configured({workspaceId}))return false;
 return Boolean((await db.query(`SELECT 1 FROM stockchief_runtime.codex_pilot_workspace_access
  WHERE workspace_id=$1 AND (funding_workspace_id=ANY($2::text[]) OR $3 AND pilot->>'admission_kind'='COMMERCIAL')`,[workspaceId,fundingWorkspaces(),customerAccess()])).rows.length);
}
module.exports={list,fundingWorkspaces,accountAccess,customerAccess,configured,availableWorkspace};

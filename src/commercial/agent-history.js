'use strict';

const plan=require('./agent-plan');
const {EntitlementError}=require('./entitlements');
const {AuthorizationError}=require('../domain/errors');

async function access(db,workspaceId){
  const state=await plan.accountState(db,workspaceId);
  const legacy=Boolean(state.plan)&&!plan.usesAgentTerms(state);
  const tier=legacy?'legacy':(state.plan||'starter');
  const shorter=tier==='starter'||tier==='growth';
  const result={activityAfter:null,salesFrom:null,exportAllowed:legacy||tier==='pro'||tier==='enterprise',apiAllowed:tier==='enterprise'};
  if(!shorter)return result;
  const row=(await db.query(`SELECT now()-$2::interval AS cutoff,
    (((now() AT TIME ZONE coalesce(w.time_zone,a.time_zone,'UTC'))::date-$3::interval)::date)::text AS sales_from
    FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1`,
    [workspaceId,tier==='starter'?'90 days':'1 year',tier==='starter'?'12 months':'24 months'])).rows[0];
  if(!row)throw new AuthorizationError('Choose an inventory you can access.');
  return {...result,activityAfter:row.cutoff.toISOString(),salesFrom:row.sales_from};
}

function requireExport(history){
  if(!history.exportAllowed)throw new EntitlementError('Activity log export is included with Pro and Custom.',{minimum:'pro'});
}

async function requireApi(db,ctx){
  if(!(await access(db,ctx.workspaceId)).apiAllowed)throw new EntitlementError('The activity log API is included with Custom.',{minimum:'enterprise'});
  const owner=await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId]);
  if(!owner.rowCount)throw new AuthorizationError('Only the inventory owner can grant or use activity log API access.');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
}

module.exports={access,requireExport,requireApi};

'use strict';

const {ValidationError}=require('../domain/errors');

// Initial self-service provider set. These optional adapters remain in the
// repository for existing records and later qualified/contractual activation.
// In particular, having OAuth credentials must not silently turn one on.
const EXCLUDED=Object.freeze({
  quickbooks:'QuickBooks is not included in initial self-service launch. Existing accounting records remain available.',
  xero:'Xero is not included in initial self-service launch. Existing accounting records remain available.',
  shopify:'Shopify needs distribution and billing-term qualification before new self-service connections.',
  clover:'Clover needs App Market and developer-term qualification before new self-service connections.',
  microsoft365:'Microsoft 365 needs final live connector qualification before new self-service connections.',
  erp_future:'Custom ERP connections require a qualified contract and are not included in initial self-service launch.'
});

const accountPilot=Symbol('verified connection pilot owner');
const configured=name=>String(process.env[name]||'').split(',').map(value=>value.trim()).filter(Boolean);

// Workspace IDs in the deployment configuration anchor an approved account.
// Resolve ownership from PostgreSQL for every request and callback: another
// inventory owned by that account must not require another manual rollout.
// This grants provider availability only, never membership, plan capacity,
// credentials or authority to use another inventory's connections.
async function resolveWorkspaceContext(database,ctx={}){
 const seeds=configured('STOCKCHIEF_STAGING_CONNECTION_WORKSPACES');
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='staging'||!ctx.workspaceId||!seeds.length||seeds.includes(ctx.workspaceId))return ctx;
 const approved=await database.query(`SELECT 1 FROM workspaces target
  JOIN workspaces approved ON approved.owner_account_id=target.owner_account_id
  WHERE target.id=$1 AND approved.id=ANY($2::text[])
   AND target.deletion_requested_at IS NULL AND approved.deletion_requested_at IS NULL LIMIT 1`,[ctx.workspaceId,seeds]);
 if(!approved.rows.length)return ctx;
 const resolved={...ctx};
 Object.defineProperty(resolved,accountPilot,{value:Object.freeze({workspaceId:ctx.workspaceId,seeds:seeds.join('\0')})});
 return resolved;
}

function pilotAllowed(providerType,ctx={}){
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='staging'||!ctx.workspaceId)return false;
 const seeds=configured('STOCKCHIEF_STAGING_CONNECTION_WORKSPACES'),grant=ctx[accountPilot];
 const approved=seeds.includes(ctx.workspaceId)||grant?.workspaceId===ctx.workspaceId&&grant.seeds===seeds.join('\0');
 return approved&&configured('STOCKCHIEF_STAGING_CONNECTION_PROVIDERS').includes(String(providerType).toLowerCase())&&['shopify','clover','quickbooks','xero','microsoft365'].includes(String(providerType).toLowerCase());
}
function reason(providerType,ctx){return pilotAllowed(providerType,ctx)?null:EXCLUDED[String(providerType||'').toLowerCase()]||null;}
function assertNewConnection(providerType,ctx){const denied=reason(providerType,ctx);
 if(denied)throw new ValidationError(denied);}
async function assertWorkspaceConnection(database,providerType,ctx){
 if(!EXCLUDED[String(providerType||'').toLowerCase()])return;
 assertNewConnection(providerType,await resolveWorkspaceContext(database,ctx));
}
function metadata(meta,ctx){const denied=reason(meta.type,ctx);
 return denied?{...meta,available:false,unavailableReason:denied}:{...meta,pilot:pilotAllowed(meta.type,ctx)};}

module.exports={EXCLUDED,reason,assertNewConnection,assertWorkspaceConnection,resolveWorkspaceContext,metadata,pilotAllowed};

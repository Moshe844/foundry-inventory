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

function pilotAllowed(providerType,ctx={}){
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='staging'||!ctx.workspaceId)return false;
 const configured=name=>String(process.env[name]||'').split(',').map(value=>value.trim()).filter(Boolean);
 return configured('STOCKCHIEF_STAGING_CONNECTION_WORKSPACES').includes(ctx.workspaceId)&&configured('STOCKCHIEF_STAGING_CONNECTION_PROVIDERS').includes(String(providerType).toLowerCase())&&['shopify','clover','quickbooks','xero','microsoft365'].includes(String(providerType).toLowerCase());
}
function reason(providerType,ctx){return pilotAllowed(providerType,ctx)?null:EXCLUDED[String(providerType||'').toLowerCase()]||null;}
function assertNewConnection(providerType,ctx){const denied=reason(providerType,ctx);
 if(denied)throw new ValidationError(denied);}
function metadata(meta,ctx){const denied=reason(meta.type,ctx);
 return denied?{...meta,available:false,unavailableReason:denied}:{...meta,pilot:pilotAllowed(meta.type,ctx)};}

module.exports={EXCLUDED,reason,assertNewConnection,metadata,pilotAllowed};

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
  bigcommerce:'BigCommerce is undergoing test-store certification before new customer activation.',
  erp_future:'Custom ERP connections require a qualified contract and are not included in initial self-service launch.'
});

const accountPilot=Symbol('verified connection pilot owner');
const shopifyReview=Symbol('verified Shopify development billing owner');
const configured=name=>String(process.env[name]||'').split(',').map(value=>value.trim()).filter(Boolean);
function publicShopifyEnabled(){return process.env.STOCKCHIEF_RUNTIME_ENV==='production'&&process.env.STOCKCHIEF_SHOPIFY_PUBLIC_APPROVED==='1';}
function publicAppId(){const value=String(process.env.SHOPIFY_PUBLIC_APP_ID||'').replace(/^gid:\/\/shopify\/App\//,'');return /^\d+$/.test(value)?'gid://shopify/App/'+value:null;}

// Workspace IDs in the deployment configuration anchor an approved account.
// Resolve ownership from PostgreSQL for every request and callback: another
// inventory owned by that account must not require another manual rollout.
// This grants provider availability only, never membership, plan capacity,
// credentials or authority to use another inventory's connections.
async function resolveWorkspaceContext(database,ctx={}){
 if(process.env.STOCKCHIEF_RUNTIME_ENV==='production'&&ctx.workspaceId&&!Object.hasOwn(productionShopifyPilots(),ctx.workspaceId)&&publicAppId()&&process.env.SHOPIFY_PUBLIC_CLIENT_ID){
  const row=(await database.query(`SELECT b.shop,b.shop_id FROM workspaces w JOIN commercial_shopify_subscriptions b ON b.account_id=w.owner_account_id
   WHERE w.id=$1 AND w.deletion_requested_at IS NULL AND b.app_id=$2 AND b.development_store=true LIMIT 1`,[ctx.workspaceId,publicAppId()])).rows[0];
  if(row){const resolved={...ctx};Object.defineProperty(resolved,shopifyReview,{value:Object.freeze({workspaceId:ctx.workspaceId,shop:row.shop,appId:publicAppId(),clientId:process.env.SHOPIFY_PUBLIC_CLIENT_ID})});return resolved;}
 }
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

function productionOutlookWorkspaces(){
 return process.env.STOCKCHIEF_RUNTIME_ENV==='production'
  ?configured('STOCKCHIEF_PRODUCTION_MICROSOFT365_WORKSPACES'):[];
}
function productionShopifyPilots(){
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='production')return Object.create(null);
 try{
  const input=JSON.parse(process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS||'{}'),result=Object.create(null);
  if(!input||typeof input!=='object'||Array.isArray(input))return result;
  for(const [workspaceId,shops] of Object.entries(input)){
   if(!/^[A-Za-z0-9_-]{1,200}$/.test(workspaceId)||!Array.isArray(shops)||!shops.length||shops.some(shop=>
    typeof shop!=='string'||!/^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/.test(shop)))return Object.create(null);
   result[workspaceId]=[...new Set(shops)];
  }
  return result;
 }catch{return Object.create(null);}
}
function pilotAllowed(providerType,ctx={}){
 const type=String(providerType).toLowerCase();
 if(type==='bigcommerce'&&process.env.STOCKCHIEF_RUNTIME_ENV==='production')
  return require('./bigcommerce-review-pilot').allowed(ctx.workspaceId);
 if(['xero','quickbooks'].includes(type)&&process.env.STOCKCHIEF_RUNTIME_ENV==='production')
  return require('./accounting-review-pilot').allowed(type,ctx.workspaceId);
 if(type==='clover'&&process.env.STOCKCHIEF_RUNTIME_ENV==='production')
  return require('./clover-review-pilot').allowed(ctx.workspaceId);
 if(type==='shopify'&&process.env.STOCKCHIEF_RUNTIME_ENV==='production')
  return Object.hasOwn(productionShopifyPilots(),ctx.workspaceId||'');
 if(type==='microsoft365'&&process.env.STOCKCHIEF_RUNTIME_ENV==='production')
  return productionOutlookWorkspaces().includes(ctx.workspaceId);
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='staging'||!ctx.workspaceId)return false;
 const seeds=configured('STOCKCHIEF_STAGING_CONNECTION_WORKSPACES'),grant=ctx[accountPilot];
 const approved=seeds.includes(ctx.workspaceId)||grant?.workspaceId===ctx.workspaceId&&grant.seeds===seeds.join('\0');
 return approved&&configured('STOCKCHIEF_STAGING_CONNECTION_PROVIDERS').includes(type)&&['shopify','clover','quickbooks','xero','microsoft365','bigcommerce'].includes(type);
}
function reviewAllowed(ctx){const grant=ctx?.[shopifyReview];return grant?.workspaceId===ctx?.workspaceId&&grant?.appId===publicAppId()&&grant?.clientId===process.env.SHOPIFY_PUBLIC_CLIENT_ID;}
function reason(providerType,ctx){const type=String(providerType||'').toLowerCase();return type==='xero'&&require('./xero-customer-rollout').enabled()?null:type==='shopify'&&(publicShopifyEnabled()||reviewAllowed(ctx))?null:pilotAllowed(type,ctx)?null:EXCLUDED[type]||null;}
function assertNewConnection(providerType,ctx){const denied=reason(providerType,ctx);
 if(denied)throw new ValidationError(denied);}
function assertCallbackProvider(providerType){
 // Pilot callbacks resolve and recheck the inventory from stored OAuth state.
 if(process.env.STOCKCHIEF_RUNTIME_ENV==='staging'||(providerType==='xero'&&require('./xero-customer-rollout').enabled())||(providerType==='microsoft365'&&productionOutlookWorkspaces().length)||
  require('./accounting-review-pilot').workspaces(providerType).length||
  (providerType==='clover'&&Object.keys(require('./clover-review-pilot').pilots()).length)||
  (providerType==='bigcommerce'&&Object.keys(require('./bigcommerce-review-pilot').pilots()).length)||
  (providerType==='shopify'&&(Object.keys(productionShopifyPilots()).length||publicShopifyEnabled())))return;
 assertNewConnection(providerType);
}
async function assertWorkspaceConnection(database,providerType,ctx,input={}){
 if(!EXCLUDED[String(providerType||'').toLowerCase()])return;
 ctx=await resolveWorkspaceContext(database,ctx);assertNewConnection(providerType,ctx);
 if(providerType==='bigcommerce'&&process.env.STOCKCHIEF_RUNTIME_ENV==='production'){
  require('./bigcommerce-review-pilot').expected(ctx.workspaceId,input);
  const inventory=await database.query('SELECT id FROM workspaces WHERE id=$1 AND deletion_requested_at IS NULL FOR SHARE',[ctx.workspaceId]);
  if(!inventory.rows.length)throw new ValidationError('The approved BigCommerce test inventory is no longer available.');
 }
 if(['xero','quickbooks'].includes(providerType)&&process.env.STOCKCHIEF_RUNTIME_ENV==='production'){
  const inventory=await database.query('SELECT id FROM workspaces WHERE id=$1 AND deletion_requested_at IS NULL FOR SHARE',[ctx.workspaceId]);
  if(!inventory.rows.length)throw new ValidationError('The approved accounting test inventory is no longer available.');
 }
 if(providerType==='clover'&&process.env.STOCKCHIEF_RUNTIME_ENV==='production'){
  require('./clover-review-pilot').expected(ctx.workspaceId,input);
  const inventory=await database.query('SELECT id FROM workspaces WHERE id=$1 AND deletion_requested_at IS NULL FOR SHARE',[ctx.workspaceId]);
  if(!inventory.rows.length)throw new ValidationError('The approved Clover test inventory is no longer available.');
 }
 if(providerType==='shopify'&&process.env.STOCKCHIEF_RUNTIME_ENV==='production'){
  const shop=require('./providers/shopify').normalizeShop(input.shop);
  if(!publicShopifyEnabled()&&!(reviewAllowed(ctx)&&ctx[shopifyReview].shop===shop)&&!productionShopifyPilots()[ctx.workspaceId]?.includes(shop))throw new ValidationError(
   'This private Shopify test is approved only for the store assigned to this inventory. Check the store address or contact support.');
  const inventory=await database.query('SELECT id FROM workspaces WHERE id=$1 AND deletion_requested_at IS NULL FOR SHARE',[ctx.workspaceId]);
  if(!inventory.rows.length)throw new ValidationError('The approved Shopify test inventory is no longer available.');
 }
}
function metadata(meta,ctx){const denied=reason(meta.type,ctx);
 return denied?{...meta,available:false,launchRestricted:true,unavailableReason:denied}:{...meta,pilot:pilotAllowed(meta.type,ctx)};}

module.exports={EXCLUDED,reason,assertNewConnection,assertCallbackProvider,assertWorkspaceConnection,resolveWorkspaceContext,metadata,pilotAllowed,productionOutlookWorkspaces,productionShopifyPilots,publicShopifyEnabled};

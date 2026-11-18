'use strict';
const crypto=require('node:crypto');
const {AuthenticationError,AuthorizationError,ValidationError}=require('../domain/errors');
const {newId}=require('../lib/util');
const adapter=require('./providers/shopify');
const profiles=require('./shopify-app-profile');
const launch=require('./launch-policy');
const providerService=require('./postgres-provider-service');
const intents=require('./authorization-intent');
const credentials=require('./credentials');
const lifecycle=require('./shopify-token-lifecycle');
const TTL_MS=30*60*1000,PATH='/integrations/shopify';
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
function browser(value){
 const match=String(value||'').match(/^(sinstall_[a-z0-9]+)\.([A-Za-z0-9_-]{43})$/);
 if(!match)throw new AuthenticationError('This Shopify connection has expired. Open StockChief from Shopify again.');
 return {id:match[1],proof:hash(match[2])};
}
function pilotShop(shop){return Object.values(launch.productionShopifyPilots()).some(shops=>shops.includes(shop));}
const metadata=row=>typeof row.metadata==='string'?JSON.parse(row.metadata):row.metadata||{};
function approvedShop(shop,row){
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='production'||pilotShop(shop)||launch.publicShopifyEnabled())return;
 // A signed start may authorize first. No catalog, inventory or billing is
 // admitted until Shopify itself verifies the development store identity.
 if(row&&['AUTHORIZING','EXCHANGING'].includes(row.status))return;
 const proof=row&&metadata(row).shopifyInstallationIdentity;
 if(proof?.developmentStore===true&&proof.shop===shop&&proof.appId===require('../commercial/shopify-billing').configuration().appId)return;
 throw new AuthorizationError('This app is currently available to verified Shopify development stores for review. Public-store connections open after Shopify approval.');
}
async function existingReviewIdentity(database,existing,shop){
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='production'||pilotShop(shop)||launch.publicShopifyEnabled())return null;
 const b=(await database.query(`SELECT b.app_id,b.shop_id,b.shop,b.development_store FROM commercial_shopify_subscriptions b JOIN workspaces w ON w.owner_account_id=b.account_id
  WHERE w.id=$1 AND b.shop=$2 AND b.app_id=$3 AND b.development_store=true`,[existing.workspace_id,shop,require('../commercial/shopify-billing').configuration().appId])).rows[0];
 if(!b)throw new AuthorizationError('This store has no verified development-store installation. Your working connection is preserved.');
 return {appId:b.app_id,shopId:b.shop_id,shop:b.shop,developmentStore:true};
}
function requireReviewConfiguration(shop){
 if(process.env.STOCKCHIEF_RUNTIME_ENV==='production'&&!pilotShop(shop)&&!require('../commercial/shopify-billing').configured())
   throw new AuthorizationError('Shopify connections are being verified with approved test stores. Public connections will open after Shopify review and billing qualification.');
}
async function purge(database,{now=Date.now()}={}){
 return (await database.query('DELETE FROM shopify_public_installs WHERE expires_at<=$1',[new Date(now).toISOString()])).rowCount;
}
async function begin(database,query,origin){
 adapter.verifyOAuthQuery(query,'public',{fresh:true});
 return lifecycle.run(database,profiles.profile('public').clientId,query.shop,db=>beginLocked(db,query,origin));
}
async function beginLocked(database,query,origin){
 adapter.verifyOAuthQuery(query,'public',{fresh:true});
 if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(query.shop||''))throw new AuthenticationError('Shopify did not identify a valid store.');
 const shop=query.shop,app=profiles.profile('public');requireReviewConfiguration(shop);
 await purge(database);
 const id=newId('sinstall'),proof=crypto.randomBytes(32).toString('base64url'),state=crypto.randomBytes(32).toString('base64url');
 const auth=adapter.authorizationUrl({state,input:{shop,shopifyProfile:'public',redirectUri:origin+PATH+'/callback'}});
 // Reopening an already connected installation does not mint another offline
 // token and invalidate its working grant. Explicit reauthorization remains
 // available to its current owner through the existing connection screen.
 const existing=await database.transaction(async client=>{
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['shopify-public-install:'+app.clientId+':'+shop]);
 if((await client.query("SELECT 1 FROM shopify_public_installs WHERE client_id=$1 AND shop=$2 AND status='EXCHANGING' AND expires_at>now()",[app.clientId,shop])).rows.length)
   throw new ValidationError('Shopify authorization is finishing for this store. Please try again in a moment. Your working connection is unchanged.');
 const existing=(await client.query(`SELECT id,workspace_id FROM workspace_connectors WHERE provider_type='shopify'
   AND provider_account_id=$1 AND status='connected' AND config::jsonb->>'shopifyClientId'=$2
   AND config::jsonb->>'shopifyProfile'='public' ORDER BY updated_at DESC LIMIT 1`,[shop,app.clientId])).rows[0];
 if(existing){const review=await existingReviewIdentity(client,existing,shop);if(review)auth.metadata.shopifyInstallationIdentity=review;}
 // A new start supersedes only unclaimed authorizations. In-flight exchange
 // and owner claims share this store lock, so a second browser cannot retire
 // a token after it has become a working connection.
 await client.query("UPDATE shopify_public_installs SET status='FAILED',ciphertext=NULL,iv=NULL,auth_tag=NULL WHERE client_id=$1 AND shop=$2 AND status IN ('AUTHORIZING','AUTHORIZED')",[app.clientId,shop]);
 await client.query(`INSERT INTO shopify_public_installs
   (id,state_hash,browser_hash,shop,client_id,metadata,status,linked_workspace_id,linked_connector_id,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,hash(state),hash(proof),shop,app.clientId,JSON.stringify(auth.metadata),
   existing?'LINKED':'AUTHORIZING',existing?.workspace_id||null,existing?.id||null,new Date(Date.now()+TTL_MS).toISOString()]);
 return existing;
 },{isolation:'SERIALIZABLE',retrySafe:true});
 return {cookie:id+'.'+proof,redirectUrl:existing?PATH+'/connect':auth.url};
}
async function read(database,cookie){
 const value=browser(cookie);
 const row=(await database.query('SELECT * FROM shopify_public_installs WHERE id=$1 AND browser_hash=$2 AND expires_at>now()',[value.id,value.proof])).rows[0];
 if(!row)throw new AuthenticationError('This Shopify connection has expired. Open StockChief from Shopify again.');
 if(row.client_id!==profiles.profile('public').clientId)throw new AuthenticationError('The Shopify application changed. Start again from Shopify.');
 approvedShop(row.shop,row);return row;
}
async function complete(database,cookie,query){
 const row=await read(database,cookie);
 adapter.verifyOAuthQuery(query,'public',{fresh:true});
 return lifecycle.run(database,row.client_id,row.shop,db=>completeLocked(db,cookie,query));
}
async function completeLocked(database,cookie,query){
 const row=await read(database,cookie);
 adapter.verifyOAuthQuery(query,'public',{fresh:true});
 if(hash(query.state)!==row.state_hash||query.shop!==row.shop)throw new AuthenticationError('This Shopify response does not match the store and browser that started it.');
 if(query.error)throw new AuthorizationError('Shopify access was not approved. Your existing connections are unchanged.');
 if(!query.code||query.code.length>2048)throw new AuthenticationError('Shopify did not supply a valid authorization code.');
 const active=(await database.query("SELECT id,workspace_id FROM workspace_connectors WHERE provider_type='shopify' AND provider_account_id=$1 AND status='connected' AND config::jsonb->>'shopifyProfile'='public' AND config::jsonb->>'shopifyClientId'=$2 ORDER BY updated_at DESC LIMIT 1",[row.shop,row.client_id])).rows[0];
 if(active){
   const nextMetadata=metadata(row),review=await existingReviewIdentity(database,active,row.shop);if(review)nextMetadata.shopifyInstallationIdentity=review;
   const linked=await database.query("UPDATE shopify_public_installs SET status='LINKED',linked_workspace_id=$2,linked_connector_id=$3,ciphertext=NULL,iv=NULL,auth_tag=NULL,metadata=$4 WHERE id=$1 AND status='AUTHORIZING' RETURNING id",[row.id,active.workspace_id,active.id,JSON.stringify(nextMetadata)]);
   if(!linked.rowCount)throw new AuthenticationError('This Shopify response was already used. Open StockChief from Shopify again.');
   return PATH+'/connect';
 }
 const taken=await database.transaction(async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['shopify-public-install:'+row.client_id+':'+row.shop]);
   return client.query("UPDATE shopify_public_installs SET status='EXCHANGING' WHERE id=$1 AND status='AUTHORIZING' AND expires_at>now() RETURNING id",[row.id]);
 },{isolation:'SERIALIZABLE',retrySafe:true});
 if(!taken.rows.length)throw new AuthenticationError('This Shopify response was already used. Open StockChief from Shopify again.');
 try{
   const result=await require('./shopify-install-authorization').run(database,row,()=>adapter.exchangeAuthorization({query,metadata:metadata(row)})),nextMetadata=metadata(row);
   if(process.env.STOCKCHIEF_RUNTIME_ENV==='production'&&require('../commercial/shopify-billing').configured()){
    const identity=await require('../commercial/shopify-billing').readIdentity(result.credentials,row.shop);
    if(!pilotShop(row.shop)&&!identity.developmentStore&&!launch.publicShopifyEnabled())throw new AuthorizationError('Public-store connections open after Shopify approval. This store is not a development store.');
    nextMetadata.shopifyInstallationIdentity=identity;result.credentials.shopifyShopId=identity.shopId;
   }
   approvedShop(row.shop,{...row,status:'AUTHORIZED',metadata:nextMetadata});
   const sealed=credentials.encrypt(result);
   const saved=await database.query(`UPDATE shopify_public_installs SET status='AUTHORIZED',ciphertext=$2,iv=$3,auth_tag=$4,metadata=$5
     WHERE id=$1 AND status='EXCHANGING' AND expires_at>now() RETURNING id`,[row.id,sealed.ciphertext,sealed.iv,sealed.authTag,JSON.stringify(nextMetadata)]);
   if(!saved.rows.length)throw new AuthenticationError('This Shopify connection expired before authorization finished. Start again.');
 }catch(error){await database.query("UPDATE shopify_public_installs SET status='FAILED',ciphertext=NULL,iv=NULL,auth_tag=NULL WHERE id=$1",[row.id]);throw error;}
 return PATH+'/connect';
}
async function choices(database,account,row){
 if(!account?.email_verified_at)return [];
 return (await database.query(`SELECT w.id,w.name,u.id actor_id FROM workspaces w JOIN users u
   ON u.workspace_id=w.id AND u.account_id=$1 AND u.role='owner' AND u.revoked_at IS NULL
   WHERE w.owner_account_id=$1 AND w.deletion_requested_at IS NULL ORDER BY w.name,w.id`,[account.id])).rows;
}
async function attach(database,account,cookie,workspaceId,options={}){
 const row=await read(database,cookie);
 return lifecycle.run(database,row.client_id,row.shop,db=>attachLocked(db,account,cookie,workspaceId,options));
}
async function attachLocked(database,account,cookie,workspaceId,{requestOrigin}={}){
 if(!account?.email_verified_at)throw new AuthorizationError('Verify your StockChief email before connecting a store.');
 const row=await read(database,cookie),choice=(await choices(database,account,row)).find(w=>w.id===workspaceId);
 if(!choice)throw new AuthorizationError('Choose an inventory you own. Restricted team members cannot connect this store.');
 const ctx={workspaceId,actorId:choice.actor_id,accountId:account.id};
 const linked=await database.transaction(async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['shopify-public-install:'+row.client_id+':'+row.shop]);
   const current=(await client.query('SELECT * FROM shopify_public_installs WHERE id=$1 AND browser_hash=$2 AND expires_at>now() FOR UPDATE',[row.id,row.browser_hash])).rows[0];
   if(!current)throw new AuthenticationError('This Shopify connection has expired. Start again.');
   const owner=(await client.query("SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id WHERE u.id=$1 AND u.workspace_id=$2 AND u.account_id=$3 AND u.role='owner' AND u.revoked_at IS NULL AND w.owner_account_id=$3 AND w.deletion_requested_at IS NULL FOR UPDATE OF u",[choice.actor_id,workspaceId,account.id])).rows[0];
   if(!owner)throw new AuthorizationError('Only a current inventory owner can connect this store.');
   await launch.assertWorkspaceConnection(client,'shopify',ctx,{shop:row.shop});
   const active=(await client.query("SELECT id,config FROM workspace_connectors WHERE provider_type='shopify' AND provider_account_id=$1 AND status='connected' FOR UPDATE",[row.shop])).rows;
   if(current.status==='LINKED'){
     if(current.linked_workspace_id!==workspaceId)throw new AuthorizationError('This store is already linked to a different inventory. Its connection has been kept.');
     return {id:current.linked_connector_id,alreadyLinked:true};
   }
   if(current.status!=='AUTHORIZED'||!current.ciphertext)throw new AuthenticationError('Complete Shopify authorization before linking the inventory.');
   if(active.some(c=>{const config=typeof c.config==='string'?JSON.parse(c.config):c.config;return config?.shopifyProfile!=='public'||config?.shopifyClientId!==row.client_id;}))
     throw new ValidationError('This store already has a working connection with the older Shopify app. It has been kept. Contact StockChief support to arrange a reviewed migration.');
   if(active.length)throw new ValidationError('A Shopify connection was already completed for this store. Its working credentials have been kept. Open its connection page to reconnect if needed.');
   const other=(await client.query("SELECT id FROM workspace_connectors WHERE provider_type='shopify' AND provider_account_id=$1 AND status='connected' AND workspace_id<>$2",[row.shop,workspaceId])).rows;
   if(other.length)throw new AuthorizationError('This store is already connected to another inventory. Its existing connection has been kept.');
   const result=credentials.decrypt(current);
   if(result.accountId!==row.shop||result.credentials?.shopifyClientId!==row.client_id||result.credentials?.shopifyProfile!=='public')throw new AuthenticationError('The Shopify authorization does not match this installation.');
   // Serialize claims for this app/store, then let the canonical plan and
   // connection-capacity checks admit the connection in this same transaction.
   const pending=intents.draft(workspaceId,choice.actor_id,'shopify',{name:'Shopify',provides:adapter.metadata().provides,
     config:{shopifyProfile:'public',shopifyClientId:row.client_id,autoImportCatalog:false,autoImportOpeningStock:false}});
   const id=await providerService.finishAuthorization({query:client.query,transaction:fn=>fn(client)},pending,choice.actor_id,result,null,{enforceLaunchPolicy:true});
   await client.query("UPDATE shopify_public_installs SET status='LINKED',linked_workspace_id=$2,linked_connector_id=$3,ciphertext=NULL,iv=NULL,auth_tag=NULL WHERE id=$1",[row.id,workspaceId,id]);
   return {id,alreadyLinked:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
 const connectorId=linked.id;
 if(linked.alreadyLinked)return require('./postgres-service').get(database,workspaceId,connectorId);
 await providerService.setupWebhookDelivery(database,ctx,connectorId,requestOrigin||'',{});
 const connection=await require('./postgres-service').get(database,workspaceId,connectorId);
 await require('../operations/postgres-job-queue').enqueue(database,{workspaceId,kind:'provider.catalog-sync',idempotencyKey:`shopify-public-install:${row.id}`,payload:{connectorId,source:'authorization'},priority:25,maxAttempts:5});
 return connection;
}
module.exports={PATH,TTL_MS,begin,read,complete,choices,attach,purge};

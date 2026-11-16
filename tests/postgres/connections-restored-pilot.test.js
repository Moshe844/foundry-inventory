'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),request=require('supertest');
const csrf=html=>html.match(/name="_csrf" value="([^"]+)"/)?.[1];
test('restored real adapter authorization is Staging/workspace scoped, holds account consent and begins no external effect',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);await require('../../src/db/migrate-postgres').migratePostgres(db);const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_STAGING_CONNECTION_WORKSPACES','STOCKCHIEF_STAGING_CONNECTION_PROVIDERS','SHOPIFY_CLIENT_ID','SHOPIFY_CLIENT_SECRET','CLOVER_CLIENT_ID','CLOVER_CLIENT_SECRET','CLOVER_WEBHOOK_AUTH_CODE','XERO_CLIENT_ID','XERO_CLIENT_SECRET','QUICKBOOKS_CLIENT_ID','QUICKBOOKS_CLIENT_SECRET','MICROSOFT365_CLIENT_ID','MICROSOFT365_CLIENT_SECRET','STOCKCHIEF_PRIVATE_PRODUCTION_PILOT','STOCKCHIEF_PRODUCTION_MICROSOFT365_WORKSPACES'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 for(const key of keys.filter(k=>/_CLIENT_|WEBHOOK_AUTH_CODE/.test(k)))process.env[key]='offline-fixture-only';process.env.STOCKCHIEF_RUNTIME_ENV='staging';process.env.STOCKCHIEF_STAGING_CONNECTION_PROVIDERS='shopify,clover,xero,quickbooks';const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),connectionPublicOrigin:'request'});t.after(async()=>{await app.locals.sessionStore.close();await db.close();await cluster.stop();for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 const agent=request.agent(app),registration=await agent.get('/register'),email=randomUUID()+'@example.test';await agent.post('/register').type('form').send({_csrf:csrf(registration.text),name:'Connection owner',businessName:'Restored adapters',email,password:'Connections!'+randomUUID()});const owner=(await db.query("SELECT w.id AS workspace_id,w.owner_account_id FROM workspaces w WHERE w.name='Restored adapters'")).rows[0];await db.query("UPDATE account_subscriptions SET plan_id='growth',plan_version_id=NULL WHERE account_id=$1",[owner.owner_account_id]);process.env.STOCKCHIEF_STAGING_CONNECTION_WORKSPACES=owner.workspace_id;
 let page=await agent.get('/settings/connections');assert.equal(page.status,200);for(const name of ['Shopify','Clover','WooCommerce','QuickBooks','Xero'])assert.match(page.text,new RegExp(name));assert.match(page.text,/Staging pilot/);
 for(const[type,input,host]of [['shopify',{shop:'offline-fixture.myshopify.com'},'offline-fixture.myshopify.com'],['clover',{},null],['xero',{},'login.xero.com'],['quickbooks',{},'appcenter.intuit.com'],['woocommerce',{storeUrl:'https://fixture-shop.example.test'},'fixture-shop.example.test']]){
  page=await agent.get('/settings/connections');
  const started=await agent.post('/settings/connections/'+type+'/authorize').type('form').send({_csrf:csrf(page.text),...input});
  assert.equal(started.status,303,type+' must begin consent');
  const target=new URL(started.headers.location);assert.equal(target.protocol,'https:');if(host)assert.equal(target.hostname,host);
  if(type==='xero'){assert(!target.searchParams.get('scope').includes('accounting.manualjournals'),'Initial connection cannot grant posting authority');}
  const saved=await db.query('SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND provider_type=$2',[owner.workspace_id,type]);
  assert.equal(saved.rowCount,0,'Unfinished consent must not create a connector');
 }
 const before=Number((await db.query('SELECT count(*)::int AS n FROM connection_authorization_states WHERE workspace_id=$1',[owner.workspace_id])).rows[0].n);process.env.STOCKCHIEF_STAGING_CONNECTION_WORKSPACES='another-workspace';page=await agent.get('/settings/connections');const denied=await agent.post('/settings/connections/xero/authorize').set('Accept','application/json').type('form').send({_csrf:csrf(page.text)});assert.equal(denied.status,400);process.env.STOCKCHIEF_STAGING_CONNECTION_WORKSPACES=owner.workspace_id;process.env.STOCKCHIEF_RUNTIME_ENV='production';page=await agent.get('/settings/connections');assert.equal((await agent.post('/settings/connections/shopify/authorize').set('Accept','application/json').type('form').send({_csrf:csrf(page.text),shop:'offline-fixture.myshopify.com'})).status,400);assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM connection_authorization_states WHERE workspace_id=$1',[owner.workspace_id])).rows[0].n),before);
 process.env.STOCKCHIEF_PRIVATE_PRODUCTION_PILOT='1';
 process.env.STOCKCHIEF_PRODUCTION_MICROSOFT365_WORKSPACES='different-inventory';
 page=await agent.get('/settings/connections');
 const outlookRequest=()=>agent.post('/settings/connections/microsoft365/authorize').type('form').send({_csrf:csrf(page.text)});
 assert.equal((await outlookRequest().set('Accept','application/json')).status,400);
 process.env.STOCKCHIEF_PRODUCTION_MICROSOFT365_WORKSPACES=owner.workspace_id;
 page=await agent.get('/settings/connections');
 assert.match(page.text,/Connect Microsoft 365/);
 const outlook=await outlookRequest();
 assert.equal(outlook.status,303,'The approved production inventory can start Outlook consent');
 const outlookTarget=new URL(outlook.headers.location);
 assert.equal(outlookTarget.hostname,'login.microsoftonline.com');
 assert.match(outlookTarget.searchParams.get('redirect_uri'),/\/settings\/connections\/microsoft365\/callback$/);
 assert.deepEqual(outlookTarget.searchParams.get('scope').split(' '),['openid','profile','offline_access','User.Read','Mail.Read','Mail.Send']);
 const callback=(state)=>agent.get('/settings/connections/microsoft365/callback').query({state,
  error:'access_denied',error_description:'Outlook pilot consent declined'});
 const outlookState=outlookTarget.searchParams.get('state');
 process.env.STOCKCHIEF_PRIVATE_PRODUCTION_PILOT='0';
 assert.match((await callback(outlookState)).text,/needs final live connector qualification/);
 process.env.STOCKCHIEF_PRIVATE_PRODUCTION_PILOT='1';
 process.env.STOCKCHIEF_PRODUCTION_MICROSOFT365_WORKSPACES='different-inventory';
 assert.match((await callback(outlookState)).text,/needs final live connector qualification/);
 process.env.STOCKCHIEF_PRODUCTION_MICROSOFT365_WORKSPACES=owner.workspace_id;
 page=await agent.get('/settings/connections');
 const freshOutlook=await outlookRequest();
 assert.equal(freshOutlook.status,303);
 const freshState=new URL(freshOutlook.headers.location).searchParams.get('state');
 assert.match((await callback(freshState)).text,/Outlook pilot consent declined/);
 assert.match((await callback(freshState)).text,/expired or was already used/);
 for(const table of ['accounting_journal_entries','movements','connection_credentials'])assert.equal(Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE workspace_id=$1`,[owner.workspace_id])).rows[0].n),0);
});

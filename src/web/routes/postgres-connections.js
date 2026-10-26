'use strict';

const crypto=require('node:crypto');
const express=require('express');
const { requireAuth,requireOwner,asyncRoute }=require('../middleware');
const connections=require('../../connections/postgres-service');
const providerService=require('../../connections/postgres-provider-service');
const catalogue=require('../../connections/postgres-catalog-import');
const defaultProviders=require('../../connections/providers/registry');
const jobs=require('../../operations/postgres-job-queue');
const accountingSync=require('../../accounting/postgres-integration-sync');
const publicApi=require('../../connections/postgres-public-api');
const paymentConnect=require('../../payments/postgres-connect');
const shippingAccounts=require('../../shipping/postgres-accounts');
const {ValidationError}=require('../../domain/errors');
const entitlements=require('../../entitlements/postgres-service');
const {commercialScope}=require('../commercial-middleware');

function safeOrigin(value,fallback){
  try{return new URL(value).origin;}catch{return fallback;}
}

function oauthReturnPage(res,input){
  const returnOrigin=safeOrigin(input.returnOrigin,input.requestOrigin);
  const returnPath=input.returnPath||(input.connection?.id
    ? `/settings/connections/${encodeURIComponent(input.connection.id)}`:'/settings/connections');
  return res.status(input.connected?200:input.pending?202:400).page('connections/oauth-return',{
    title:`${input.providerName||'Connection'} · StockChief`,layout:false,outcome:{
      connected:Boolean(input.connected),pending:Boolean(input.pending),pollPath:input.pollPath||'',providerName:input.providerName||'Connection',message:input.message,
      workspaceId:input.workspaceId||input.connection?.workspace_id||null,returnUrl:`${returnOrigin}${returnPath}`,
      returnOrigin,returnPath,popup:Boolean(input.popup),
    },
  });
}

function createPostgresConnectionsRouter(database,options={}){
  const router=express.Router();
  const registry=options.providers||defaultProviders;
  const callbackProviders=new Set((registry.catalog?registry.catalog():[]).map((provider)=>provider.type));
  async function connectionAllowed(req,res,providerType){
    const type=String(providerType||'').toLowerCase();const capability={gmail:'connection.email',microsoft365:'connection.email',
      shopify:'connection.commerce',square:'connection.commerce',clover:'connection.commerce',woocommerce:'connection.commerce',bigcommerce:'connection.commerce',
      quickbooks:'connection.accounting',xero:'connection.accounting'}[type];
    if(!capability)return true;
    const state=await entitlements.capabilityState(database,commercialScope(req),capability);
    if(state.enabled)return true;
    res.redirect(303,`/upgrade?capability=${encodeURIComponent(capability)}&return=${encodeURIComponent('/settings/connections')}`);return false;
  }

  async function renderConnections(req,res,apiToken=null){
    const inventorySetup=req.query.setup==='inventory';
    const providerContext=await require('../../connections/launch-policy').resolveWorkspaceContext(database,req.ctx);
    const providerCatalog=inventorySetup?registry.inventorySources(providerContext,{oauthOnly:true}):registry.catalog(providerContext,{oauthOnly:true});
    const qualifiedTestConnect=require('../../payments/connect-availability').qualified(options);
    const launchTicket=crypto.randomBytes(24).toString('base64url');
    req.session.connectionLaunch={ticket:launchTicket,workspaceId:req.ctx.workspaceId,expiresAt:Date.now()+5*60000};
    const requestOrigin=`${req.protocol}://${req.get('host')}`;
    const requestPublicOrigin=options.publicOrigin==='request'?requestOrigin:(options.publicOrigin||requestOrigin);
    const connectionCapabilities=[['connection.email','communications.email_ingestion'],
      ['connection.commerce','connections.commerce'],['connection.accounting','connections.accounting']];
    const [connectionRows,clients,payment,shipping,capabilityStates]=await Promise.all([
      connections.list(database,req.ctx.workspaceId),publicApi.list(database,req.ctx.workspaceId),
      paymentConnect.describe(database,req.ctx.workspaceId),shippingAccounts.describe(database,req.ctx.workspaceId),
      entitlements.capabilityStates(database,commercialScope(req),connectionCapabilities.map(([,key])=>key)),
    ]);
    return res.page('connections/index',{
      title:inventorySetup?'Connect a platform':'Integrations',nav:'connections',room:true,backTo:inventorySetup?{href:'/onboarding',label:'Inventory setup'}:{href:'/settings',label:'Settings'},launchTicket,
      postgresMode:true,inventorySetup,connections:inventorySetup?connectionRows.filter(c=>providerCatalog.some(p=>p.type===c.provider_type)):connectionRows,
      providerCatalog,
      apiToken,apiClients:clients,
      // Preserve existing merchant account details, but do not advertise new
      // self-service Connect or StockChief-funded guided shipping at launch.
      paymentAccount:inventorySetup?null:{...payment,source:'connect',
        because:!payment.connected&&!qualifiedTestConnect
          ?'No Stripe account is connected to this inventory.'
          :payment.because},
      paymentConnect:{...payment,flow:'oauth',testMode:!payment.liveMode,
        available:payment.available&&(payment.connected||qualifiedTestConnect)},
      cardknoxAccount:inventorySetup?null:await require('../../payments/postgres-cardknox').describe(database,req.ctx.workspaceId),
      shippingAccount:inventorySetup?null:{...shipping,billingReady:shipping.connected},shippingPlatform:{available:false},
      connectionPublicOrigin:requestPublicOrigin,xeroRedirectOrigin:requestPublicOrigin,
      paymentReturnOrigin:requestOrigin,currentWorkspaceId:req.ctx.workspaceId,
      workspaceName:req.workspace?.name||'',webhookSecret:null,outboundWebhooks:[],
      paymentWebhookUrl:`${requestOrigin}/webhooks/payments/stripe`,
      // Render the same current entitlement decision used by authorization,
      // including scoped overrides, rather than the plan's static summary.
      commercialCapabilities:connectionCapabilities.filter(([,key])=>capabilityStates.get(key)?.enabled).map(([name])=>name),
      commercialDevelopment:false,
    });
  }

  router.get('/settings/connections/payments/return',asyncRoute(async(req,res)=>{
    const requestOrigin=`${req.protocol}://${req.get('host')}`;
    let context=null;
    try{
      context=await providerService.readState(database,req.query.state,paymentConnect.STATE_PROVIDER);
      const result=await paymentConnect.complete(database,req.query,options.paymentConnectOptions||{});
      return oauthReturnPage(res,{connected:result.connected,providerName:'Stripe',returnPath:'/settings/connections#payments',
        returnOrigin:result.returnOrigin,requestOrigin,workspaceId:result.workspaceId,popup:context?.metadata?.popup===true,
        message:result.connected?'This inventory now uses its own Stripe account for customer payments.':result.message});
    }catch(error){
      return oauthReturnPage(res,{connected:false,providerName:'Stripe',returnPath:'/settings/connections#payments',
        returnOrigin:context?.metadata?.returnOrigin,requestOrigin,workspaceId:context?.workspace_id,
        message:error.message||'The Stripe connection was not completed.'});
    }
  }));

  router.get('/settings/connections/:provider/callback',asyncRoute(async(req,res)=>{
    const providerType=String(req.params.provider||'').toLowerCase();
    if(!callbackProviders.has(providerType))return res.status(404).send('Connection provider not found.');
    const requestOrigin=`${req.protocol}://${req.get('host')}`;
    let context=null;
    let metadata=null;
    try{
      const sessionBound=registry.get(providerType)?.oauthSessionBound===true;
      if(sessionBound&&(req.query.handoff!=='1'||req.get('sec-fetch-dest')==='iframe')){
        // Installation callbacks may arrive in a third-party frame without
        // cookies or Fetch Metadata headers. Navigate to our own top-level
        // callback before resolving its original, session-bound tenant intent.
        const query=new URLSearchParams({handoff:'1'});for(const key of ['code','context','scope','account_uuid','external_install','error'])if(typeof req.query[key]==='string'&&req.query[key].length<=4096)query.set(key,req.query[key]);
        res.removeHeader('X-Frame-Options');res.set('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors https://*.mybigcommerce.com https://login.bigcommerce.com");res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');
        return res.page('connections/provider-handoff',{title:'Continue to StockChief',layout:false,continueUrl:'/settings/connections/'+encodeURIComponent(providerType)+'/callback?'+query});
      }
      const state=sessionBound?require('../../connections/oauth-session-intent').resolve(req.session,providerType):req.query.state;
      context=await providerService.callbackContext(database,state,providerType);
      metadata=registry.get(providerType)?.metadata();
      if(sessionBound)require('../../connections/oauth-session-intent').forget(req.session,providerType);
      const connection=await providerService.completeOAuth(database,providerType,{...req.query,state},requestOrigin,{providers:registry,
        publicOrigin:options.publicOrigin==='request'?requestOrigin:options.publicOrigin});
      // Finish on an authenticated, repeatable page backed by the saved
      // connection. Reloading completion must never reuse an OAuth code.
      return res.redirect(303,`${safeOrigin(context.returnOrigin,requestOrigin)}/settings/connections/${encodeURIComponent(connection.id)}/complete${context.popup?'?popup=1':''}`);
    }catch(error){
      return oauthReturnPage(res,{connected:false,providerName:metadata?.name||'Connection',
        connection:context?.connection,returnOrigin:context?.returnOrigin,requestOrigin,
        message:error.message||'The connection was not completed.'});
    }
  }));

  router.get('/settings/connections/bigcommerce/:callback(load|uninstall|remove_user)',asyncRoute(async(req,res)=>{
    const claims=registry.get('bigcommerce').verifySignedCallback(req.query.signed_payload_jwt);res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');
    if(req.params.callback!=='load')return res.json(await require('../../connections/postgres-install-callbacks').revokeBigCommerce(database,claims,req.params.callback));
    res.removeHeader('X-Frame-Options');res.set('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors https://*.mybigcommerce.com https://login.bigcommerce.com");
    return res.page('connections/provider-handoff',{title:'Open StockChief',layout:false,continueUrl:'/settings/connections'});
  }));

  router.use('/settings/connections',requireAuth);
  router.get('/settings/connections',asyncRoute(async(req,res)=>{
    const apiToken=req.session.newPublicApiToken||null;
    delete req.session.newPublicApiToken;
    return renderConnections(req,res,apiToken);
  }));
  router.get('/settings/connections/woocommerce/return',requireOwner,asyncRoute(async(req,res)=>{
    const requestOrigin=`${req.protocol}://${req.get('host')}`;
    try{
      const value=req.query.state||req.query.user_id;
      const result=await require('../../connections/postgres-application-authorization').returning(database,req.ctx,value,'woocommerce',req.query.success);
      const path=`/settings/connections/${encodeURIComponent(result.connection.id)}/complete${result.state.metadata.popup?'?popup=1':''}`;
      if(req.accepts(['html','json'])==='json')return res.json({status:result.connected?'connected':result.pending?'pending':'declined',path:result.connected?path:null});
      if(result.connected)return res.redirect(303,path);
      return oauthReturnPage(res,{connected:false,pending:result.pending,providerName:'WooCommerce',connection:result.connection,
        requestOrigin,returnOrigin:result.state.metadata.returnOrigin,popup:result.state.metadata.popup,
        pollPath:'/settings/connections/woocommerce/return?'+new URLSearchParams({state:String(value),success:'1'}),
        message:result.pending?'Waiting for the store to deliver its secure authorization. This page will return automatically.':'WooCommerce authorization was not approved. You can try again or use API keys.'});
    }catch(error){if(req.accepts(['html','json'])==='json')return res.status(error.status||400).json({status:'unavailable'});return oauthReturnPage(res,{connected:false,providerName:'WooCommerce',requestOrigin,message:'This authorization is unavailable in the selected business. Return to the business that started the connection, or try again.'});}
  }));
  router.post('/settings/connections/woocommerce/api-keys',requireOwner,asyncRoute(async(req,res)=>{
    if(!await connectionAllowed(req,res,'woocommerce'))return;
    const requestOrigin=`${req.protocol}://${req.get('host')}`;
    const connection=await require('../../connections/postgres-application-authorization').manual(database,req.ctx,
      {...req.body,providerType:'woocommerce'},requestOrigin,{providers:registry,publicOrigin:options.publicOrigin==='request'?requestOrigin:options.publicOrigin});
    req.flash('success','WooCommerce credentials verified and saved securely. Catalogue discovery and event setup are queued. Review matches before importing stock.');
    return res.redirect(303,`/settings/connections/${encodeURIComponent(connection.id)}`);
  }));
  router.post('/settings/connections/cardknox',requireOwner,asyncRoute(async(req,res)=>{
    await entitlements.assertCapability(database,commercialScope(req),'merchant_payments');
    await require('../../payments/postgres-cardknox').connect(database,req.ctx,req.body,options.cardknoxOptions||{});
    req.flash('success','This business’s Sola/Cardknox account was verified and saved encrypted. Customer payments remain subject to this installation’s payment activation.');
    return res.redirect(303,'/settings/connections#cardknox');
  }));
  router.post('/settings/connections/cardknox/disconnect',requireOwner,asyncRoute(async(req,res)=>{
    await require('../../payments/postgres-cardknox').disconnect(database,req.ctx);req.flash('success','Sola disconnected. Existing payment history is preserved.');return res.redirect(303,'/settings/connections#cardknox');
  }));
  router.get('/settings/connections/payments/launch',requireOwner,asyncRoute(async(req,res)=>{
    await entitlements.assertCapability(database,commercialScope(req),'merchant_payments');
    const current=await paymentConnect.describe(database,req.ctx.workspaceId);
    if(!current.connected&&!require('../../payments/connect-availability').qualified(options))
      return res.status(403).send('New Stripe connections are not enabled on this installation. Existing payment records remain available.');
    const launch=req.session.connectionLaunch;
    delete req.session.connectionLaunch;
    if(!launch||launch.workspaceId!==req.ctx.workspaceId||launch.expiresAt<Date.now()
        ||typeof req.query.ticket!=='string'||req.query.ticket.length!==launch.ticket.length
        ||!crypto.timingSafeEqual(Buffer.from(req.query.ticket),Buffer.from(launch.ticket))){
      req.flash('warn','That connection link expired. Choose Connect again to start a fresh authorization.');
      return res.redirect(303,'/settings/connections');
    }
    const requestOrigin=`${req.protocol}://${req.get('host')}`;
    const started=await paymentConnect.begin(database,req.ctx,{requestOrigin,popup:false,
      publicOrigin:options.publicOrigin==='request'?requestOrigin:options.publicOrigin,
      businessName:req.workspace?.name,email:req.account?.email,
      authorizeEndpoint:options.paymentConnectOptions?.authorizeEndpoint});
    return res.redirect(303,started.redirectUrl);
  }));
  router.post('/settings/connections/payments/refresh',requireOwner,asyncRoute(async(req,res)=>{
    const current=await paymentConnect.refresh(database,req.ctx.workspaceId,options.paymentConnectOptions||{});
    req.flash(current.chargesEnabled?'success':'warn',current.chargesEnabled
      ?'Stripe confirmed that this business can accept customer payments.'
      :'Stripe is connected, but it has not approved this business to accept charges yet.');
    return res.redirect(303,'/settings/connections#payments');
  }));
  router.post('/settings/connections/payments/disconnect',requireOwner,asyncRoute(async(req,res)=>{
    const result=await paymentConnect.disconnect(database,req.ctx,options.paymentConnectOptions||{});
    req.flash('success',result.releasedAtStripe
      ?'Stripe was disconnected here and the platform grant was released at Stripe.'
      :'Stripe was disconnected from this inventory. No payment credential remains in StockChief.');
    return res.redirect(303,'/settings/connections#payments');
  }));
  router.get('/settings/connections/:provider/launch',requireOwner,asyncRoute(async(req,res)=>{
    if(!await connectionAllowed(req,res,req.params.provider))return;
    if(registry.get(req.params.provider)?.oauthSessionBound)require('../../connections/oauth-session-intent').assertCanStart(req.session,req.params.provider);
    const launch=req.session.connectionLaunch;
    delete req.session.connectionLaunch;
    if(!launch||launch.workspaceId!==req.ctx.workspaceId||launch.expiresAt<Date.now()
        ||typeof req.query.ticket!=='string'||req.query.ticket.length!==launch.ticket.length
        ||!crypto.timingSafeEqual(Buffer.from(req.query.ticket),Buffer.from(launch.ticket))){
      req.flash('warn','That connection link expired. Choose Connect again to start a fresh authorization.');
      return res.redirect(303,'/settings/connections');
    }
    const requestOrigin=`${req.protocol}://${req.get('host')}`;
    const started=await providerService.beginAuthorization(database,req.ctx,{providerType:req.params.provider,
      popup:req.query.popup==='1'?'1':''},requestOrigin,{providers:registry,
      publicOrigin:options.publicOrigin==='request'?requestOrigin:options.publicOrigin});
    if(started.authorizationState)require('../../connections/oauth-session-intent').remember(req.session,req.params.provider,started.authorizationState);
    return res.redirect(303,started.redirectUrl);
  }));
  router.get('/settings/connections/:id/complete',requireOwner,asyncRoute(async(req,res)=>{
    const connection=await connections.get(database,req.ctx.workspaceId,req.params.id);
    // OAuth success and operational readiness are distinct. Accounting still
    // requires an explicit source-of-truth decision after authorization.
    const connected=connection.status==='connected'&&!connection.paused_at;
    const setupRequired=connected&&connection.setup_status!=='CONNECTED';
    const requestOrigin=`${req.protocol}://${req.get('host')}`;
    return oauthReturnPage(res,{connected,providerName:registry.get(connection.provider_type)?.metadata()?.name||connection.display_name,
      connection,returnOrigin:requestOrigin,requestOrigin,popup:req.query.popup==='1',
      message:setupRequired?`${connection.display_name} is connected. Returning you to StockChief to finish its setup.`:connected?`${connection.display_name} is connected to this inventory.`:'This connection still needs attention. Return to its settings to review the current state.'});
  }));
  router.get('/settings/connections/:id',asyncRoute(async(req,res)=>{
    const newConnectionToken=req.session.newConnectionToken||null;
    delete req.session.newConnectionToken;
    const connection=await connections.get(database,req.ctx.workspaceId,req.params.id);
    const adapter=registry.get(connection.provider_type);
    connection.synchronization=require('../../connections/synchronization-policy').describe(connection,adapter);
    const isMailbox=['gmail','microsoft365'].includes(connection.provider_type);
    let mailboxLastPollAt=null;
    if(isMailbox){
      const poll=(await database.query(`SELECT completed_at FROM stockchief_runtime.jobs
        WHERE workspace_id=$1 AND kind='mailbox.poll' AND payload->>'connectorId'=$2
          AND status='COMPLETED' ORDER BY completed_at DESC,id DESC LIMIT 1`,
      [req.ctx.workspaceId,connection.id])).rows[0];
      mailboxLastPollAt=poll?.completed_at||null;
    }
    if(adapter?.integrationClass==='accounting'){
      let current=await accountingSync.state(database,req.ctx.workspaceId,connection.id);
      if(!current&&connection.config?.verifiedFact){await accountingSync.initialize(database,connection,req.ctx.actorId,
        connection.config.verifiedFact);current=await accountingSync.state(database,req.ctx.workspaceId,connection.id);}
      connection.accounting=current;
      if(current&&adapter.listPostingParties){const missingTypes=[...new Set(current.pendingEntries
        .flatMap((entry)=>entry.missingParties).flatMap((line)=>[
          line.customer_id&&!line.external_customer_id?'customer':null,
          line.supplier_id&&!line.external_supplier_id?'supplier':null]).filter(Boolean))];
        if(missingTypes.length){connection.accounting.externalParties={};
          try{const providerCredentials=await providerService.loadProviderCredentials(database,connection,adapter);
            for(const partyType of missingTypes)connection.accounting.externalParties[partyType]=
              await adapter.listPostingParties({credentials:providerCredentials,partyType});
          }catch(error){connection.accounting.externalPartiesError=error.message;}}
      }
    }
    const pendingWebhooks=(await database.query("SELECT id,status,lease_until,received_at,updated_at,result FROM connection_webhook_receipts WHERE workspace_id=$1 AND connector_id=$2 AND status<>'COMPLETED' ORDER BY received_at DESC,id DESC LIMIT 20",[req.ctx.workspaceId,connection.id])).rows;
    const issueId=typeof req.query.issue==='string'&&req.query.issue.length<=100?req.query.issue:null;
    const issuePage=Math.max(1,Math.min(1000000,Number.parseInt(req.query.issuesPage,10)||1)),issueOffset=(issuePage-1)*10;
    const connectionIssues={focused:Boolean(issueId),page:issuePage,total:connection.openIssues,rows:(await database.query(`
      SELECT issue.id,issue.title,issue.detail,issue.resolution_hint,issue.updated_at,s.code,l.name AS location,p.field
      FROM connection_issues issue LEFT JOIN connection_commerce_positions p ON p.workspace_id=issue.workspace_id
        AND p.connector_id=issue.connector_id AND issue.fingerprint='commerce-position:'||p.id
      LEFT JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id
      LEFT JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
      WHERE issue.workspace_id=$1 AND issue.connector_id=$2 AND issue.status='OPEN' AND ($3::text IS NULL OR issue.id=$3)
      ORDER BY issue.updated_at DESC,issue.id LIMIT 10 OFFSET $4`,[req.ctx.workspaceId,connection.id,issueId,issueId?0:issueOffset])).rows};
    const catalogueReview=adapter?.discover&&!isMailbox
      ?await catalogue.describe(database,req.ctx,connection.id):null;
    const connectionProof=(await database.query(`SELECT
      (SELECT max(completed_at) FROM connection_sync_runs WHERE workspace_id=$1 AND connector_id=$2
        AND sync_kind='CATALOG_AND_LOCATIONS' AND status='COMPLETED') AS catalogue_at,
      (SELECT max(processed_at) FROM connector_feed_events WHERE workspace_id=$1 AND connector_id=$2
        AND status IN ('COMPLETED','IGNORED') AND error_message IS NULL) AS event_at,
      EXISTS(SELECT 1 FROM connection_issues WHERE workspace_id=$1 AND connector_id=$2
        AND issue_type='PUSH_SETUP_FAILED' AND status='OPEN') AS push_setup_failed`,
    [req.ctx.workspaceId,connection.id])).rows[0];
    return res.page('connections/postgres-detail',{
      title:'Connection',nav:'connections',room:true,backTo:{href:'/settings/connections',label:'Connections'},
      connection,newConnectionToken,provider:adapter?.metadata?.()||{name:connection.display_name},
      commercePositions:await require('../../connections/postgres-commerce-sync').list(database,req.ctx.workspaceId,connection.id),
      canDiscover:Boolean(adapter?.discover)&&!isMailbox,isMailbox,mailboxLastPollAt,pendingWebhooks,catalogueReview,connectionProof,connectionIssues,
    });
  }));
  router.post('/settings/connections/:id/retry-events',requireOwner,asyncRoute(async(req,res)=>{
    const connection=await providerService.setupWebhookDelivery(database,req.ctx,req.params.id,
      `${req.protocol}://${req.get('host')}`,{providers:registry,publicOrigin:options.publicOrigin==='request'?`${req.protocol}://${req.get('host')}`:options.publicOrigin});
    req.flash(connection.last_error?'warning':'success',connection.last_error||'Provider event delivery is configured. Business workflows are verified separately.');
    return res.redirect(303,`/settings/connections/${encodeURIComponent(connection.id)}`);
  }));
  router.post('/settings/connections/:id/map',requireOwner,asyncRoute(async(req,res)=>{
    await catalogue.mapExternal(database,req.ctx,req.params.id,req.body);
    req.flash('success','Match saved. Existing stock and prices were preserved. Retained provider events can now resume safely.');
    return res.redirect(303,`/settings/connections/${encodeURIComponent(req.params.id)}`);
  }));
  router.post('/settings/connections/:id/create-location-map',requireOwner,asyncRoute(async(req,res)=>{
    await catalogue.createLocation(database,req.ctx,req.params.id,req.body);
    req.flash('success','Provider location created and matched. No stock was moved.');
    return res.redirect(303,`/settings/connections/${encodeURIComponent(req.params.id)}`);
  }));
  router.post('/settings/connections/:id/create-products-map',requireOwner,asyncRoute(async(req,res)=>{
    const result=await catalogue.importProducts(database,req.ctx,req.params.id,req.body);
    req.flash('success',result.replayed?'These products were already imported. Nothing was duplicated.':
      `Imported ${result.mapped} variants with ${result.prices} prices and ${result.openingUnits} physical units. Inventory cost and supplier liabilities were not inferred.`);
    return res.redirect(303,`/settings/connections/${encodeURIComponent(req.params.id)}`);
  }));
  router.post('/settings/connections/:id/exclude-record',requireOwner,asyncRoute(async(req,res)=>{
    const result=await catalogue.ignore(database,req.ctx,req.params.id,req.body);
    req.flash('success',result.reason+' It remains visible as excluded.');
    return res.redirect(303,`/settings/connections/${encodeURIComponent(req.params.id)}`);
  }));
  router.post('/settings/connections/:id/receipts/:receiptId/resume',requireOwner,asyncRoute(async(req,res)=>{
    await require('../../connections/postgres-webhook-inbox').resume(database,req.ctx,req.params.id,req.params.receiptId);
    req.flash('success','The retained provider event is queued. Completed operations will not be repeated; remaining operations keep their existing permission and safety checks.');
    return res.redirect(303,`/settings/connections/${encodeURIComponent(req.params.id)}`);
  }));
  router.post('/settings/connections/:id/check-mail',requireOwner,asyncRoute(async(req,res)=>{
    const connection=await connections.get(database,req.ctx.workspaceId,req.params.id);
    if(!['gmail','microsoft365'].includes(connection.provider_type)||connection.status!=='connected'||connection.paused_at)
      throw new ValidationError('Connect and resume this mailbox before checking it.');
    await entitlements.assertCapability(database,commercialScope(req),'connection.email');
    const bucket=Math.floor(Date.now()/60000);
    await jobs.enqueue(database,{workspaceId:req.ctx.workspaceId,kind:'mailbox.poll',
      idempotencyKey:`mailbox-poll:${connection.id}:manual:${bucket}`,payload:{connectorId:connection.id},
      priority:20,maxAttempts:5});
    req.flash('success','Mailbox check queued. Open Mail to see messages after the check completes.');
    return res.redirect(303,`/settings/connections/${connection.id}`);
  }));
  router.post('/settings/connections/:id/mailbox-cadence',requireOwner,asyncRoute(async(req,res)=>{
    const connection=await connections.get(database,req.ctx.workspaceId,req.params.id);
    if(!['gmail','microsoft365'].includes(connection.provider_type))
      throw new ValidationError('This connection is not a mailbox.');
    const {minutes}=await require('../../connections/postgres-synchronization').configure(database,req.ctx,connection.id,
      {minutes:req.body.minutes},{providers:registry});
    req.flash('success',`Mailbox checks now run every ${minutes} minute${minutes===1?'':'s'}.`);
    return res.redirect(303,`/settings/connections/${connection.id}`);
  }));
  router.post('/settings/connections/:id/synchronization',requireOwner,asyncRoute(async(req,res)=>{
    const changed=await require('../../connections/postgres-synchronization').configure(database,req.ctx,req.params.id,
      {minutes:req.body.minutes,disabled:req.body.mode==='off',autoImportCatalog:req.body.autoImportCatalog==='1'},{providers:registry});
    req.flash('success',changed.disabled?'Automatic synchronization is off. Credentials and history are kept.':
      `Check timing saved: every ${changed.minutes} minute${changed.minutes===1?'':'s'}. Provider limits and any temporary pause still apply.`);
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.get('/settings/connections/:id/synchronization-state',asyncRoute(async(req,res)=>{
    res.set('Cache-Control','no-store');return res.json(await require('../../connections/postgres-synchronization')
      .state(database,req.ctx.workspaceId,req.params.id,{providers:registry}));
  }));
  router.post('/settings/connections/:id/accounting/authority',requireOwner,asyncRoute(async(req,res)=>{
    await entitlements.assertCapability(database,commercialScope(req),'connection.accounting');
    await accountingSync.chooseAuthority(database,req.ctx,req.params.id,req.body.authority);
    req.flash('success',req.body.authority==='POST'
      ?'Posting requested. Exact account mapping and a matching shadow comparison are still required.'
      :'This connection remains read-only.');
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:id/accounting/map-account',requireOwner,asyncRoute(async(req,res)=>{
    await entitlements.assertCapability(database,commercialScope(req),'connection.accounting');
    await accountingSync.mapAccount(database,req.ctx,req.params.id,req.body);
    req.flash('success','Exact posting account mapping saved. No journal was exported.');
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:id/accounting/map-party',requireOwner,asyncRoute(async(req,res)=>{
    await entitlements.assertCapability(database,commercialScope(req),'connection.accounting');
    const connection=await connections.get(database,req.ctx.workspaceId,req.params.id);
    const adapter=registry.get(connection.provider_type);const partyType=String(req.body.partyType||'').toLowerCase();
    if(!adapter?.listPostingParties)throw new Error('This accounting provider does not require posting-party mappings.');
    const providerCredentials=await providerService.loadProviderCredentials(database,connection,adapter);
    const choices=await adapter.listPostingParties({credentials:providerCredentials,partyType});
    const external=choices.find((row)=>String(row.externalId)===String(req.body.externalId));
    if(!external)throw new Error(`That ${partyType} is not present in the provider’s current list.`);
    await accountingSync.mapParty(database,req.ctx,req.params.id,{...req.body,partyType,external,
      version:external.version});
    req.flash('success',`Exact ${partyType} posting identity saved. No journal was exported.`);
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:id/accounting/shadow',requireOwner,asyncRoute(async(req,res)=>{
    await entitlements.assertCapability(database,commercialScope(req),'connection.accounting');
    const connection=await connections.get(database,req.ctx.workspaceId,req.params.id);
    const adapter=registry.get(connection.provider_type);
    const providerCredentials=await providerService.loadProviderCredentials(database,connection,adapter);
    const result=await accountingSync.shadow(database,req.ctx,req.params.id,adapter,providerCredentials,{asOf:req.body.asOf});
    req.flash(result.status==='MATCHED'?'success':'warn',result.status==='MATCHED'
      ?'Shadow comparison matched exactly. Posting still requires one explicit enable step.'
      :`${result.differences.length} accounting difference(s) remain. Nothing was exported.`);
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:id/accounting/enable',requireOwner,asyncRoute(async(req,res)=>{
    await entitlements.assertCapability(database,commercialScope(req),'connection.accounting');
    await accountingSync.enableWrites(database,req.ctx,req.params.id);
    req.flash('success','Governed journal posting enabled for this inventory and this provider account.');
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:id/accounting/import-opening',requireOwner,asyncRoute(async(req,res)=>{
    await entitlements.assertCapability(database,commercialScope(req),'connection.accounting');
    const result=await accountingSync.importOpeningBooks(database,req.ctx,req.params.id,{runId:req.body.runId,scopeHash:req.body.scopeHash});
    req.flash('success',result.replayed?'These starting balances were already recorded. No duplicate entry was created.':
      'The approved starting balances are recorded in StockChief. QuickBooks was not changed. Posting remains disabled; run a fresh comparison.');
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:id/accounting/export',requireOwner,asyncRoute(async(req,res)=>{
    await entitlements.assertCapability(database,commercialScope(req),'connection.accounting');
    const result=await accountingSync.queuePending(database,req.ctx,req.params.id,{});
    req.flash('success',result.queued
      ?`${result.queued} journal export${result.queued===1?'':'s'} queued. The worker—not this browser—will call the provider.`
      :'No ready journal needed export.');
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:provider/authorize',requireOwner,asyncRoute(async(req,res)=>{
    if(!await connectionAllowed(req,res,req.params.provider))return;
    if(registry.get(req.params.provider)?.oauthSessionBound)require('../../connections/oauth-session-intent').assertCanStart(req.session,req.params.provider);
    const requestOrigin=`${req.protocol}://${req.get('host')}`;
    const started=await providerService.beginAuthorization(database,req.ctx,{...req.body,
      providerType:req.params.provider},requestOrigin,{providers:registry,
      publicOrigin:options.publicOrigin==='request'?requestOrigin:options.publicOrigin});
    if(started.authorizationState)require('../../connections/oauth-session-intent').remember(req.session,req.params.provider,started.authorizationState);
    return res.redirect(303,started.redirectUrl);
  }));
  router.post('/settings/connections/custom',requireOwner,asyncRoute(async(req,res)=>{
    await entitlements.assertCapability(database,commercialScope(req),'integrations.custom');
    const created=await connections.createFeed(database,req.ctx,req.body);
    req.session.newConnectionToken=created.token;
    req.flash('success','Connection created. Copy its token now; StockChief will not show it again.');
    return res.redirect(303,`/settings/connections/${created.connection.id}`);
  }));
  router.post('/settings/connections/api-clients',requireOwner,asyncRoute(async(req,res)=>{
    await entitlements.assertCapability(database,commercialScope(req),'api.public');
    const apiToken=await publicApi.create(database,req.ctx,{name:req.body.name,scopes:req.body.scopes});
    res.locals.flash.push({type:'success',message:'API client created. Copy its token now; StockChief will not show it again.'});
    return renderConnections(req,res,apiToken);
  }));
  router.post('/settings/connections/api-clients/:id/revoke',requireOwner,asyncRoute(async(req,res)=>{
    await publicApi.revoke(database,req.ctx.workspaceId,req.params.id);
    req.flash('success','API client revoked immediately. Its token no longer works.');
    return res.redirect(303,'/settings/connections#developer-api');
  }));
  router.post('/settings/connections/:id/pause',requireOwner,asyncRoute(async(req,res)=>{
    await connections.pause(database,req.ctx.workspaceId,req.params.id);
    req.flash('success','Connection paused. StockChief will not process new work from it.');
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:id/resume',requireOwner,asyncRoute(async(req,res)=>{
    await connections.resume(database,req.ctx.workspaceId,req.params.id);
    req.flash('success','Connection resumed.');
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:id/refresh',requireOwner,asyncRoute(async(req,res)=>{
    const connection=await connections.get(database,req.ctx.workspaceId,req.params.id);
    if(!registry.get(connection.provider_type)?.discover)throw new Error('This connection does not expose provider catalogue discovery.');
    const bucket=Math.floor(Date.now()/60000);
    await jobs.enqueue(database,{workspaceId:req.ctx.workspaceId,kind:'provider.catalog-sync',
      idempotencyKey:`provider-catalog-sync:${connection.id}:manual:${bucket}`,
      payload:{connectorId:connection.id,source:'manual'},priority:25,maxAttempts:5});
    return res.redirect(303,`/settings/connections/${connection.id}?refresh=queued`);
  }));
  router.post('/settings/connections/:id/disconnect',requireOwner,asyncRoute(async(req,res)=>{
    await connections.disconnect(database,req.ctx.workspaceId,req.params.id);
    req.flash('success','Connection disconnected. Credentials were removed; mappings and audit history remain.');
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  return router;
}

module.exports={createPostgresConnectionsRouter};

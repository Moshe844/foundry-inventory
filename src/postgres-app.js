'use strict';

const path = require('node:path');
const express = require('express');
const session = require('express-session');
const config = require('./config');
const commonMiddleware = require('./web/middleware');
const { multipart } = require('./web/multipart');
const { PostgresSessionStore } = require('./web/postgres-session-store');
const authMiddleware = require('./web/postgres-auth-middleware');
const viewHelpers = require('./web/view-helpers');
const { postgresPageRenderer } = require('./web/postgres-page-renderer');
const { createPostgresAuthRouter } = require('./web/routes/postgres-auth');
const { createPostgresWorkspacesRouter } = require('./web/routes/postgres-workspaces');
const { createPostgresSettingsRouter } = require('./web/routes/postgres-settings');
const { createPostgresBusinessRouter } = require('./web/routes/postgres-business');
const { createPostgresOnboardingRouter } = require('./web/routes/postgres-onboarding');
const { createPostgresLocationsRouter } = require('./web/routes/postgres-locations');
const { createPostgresInventoryRouter } = require('./web/routes/postgres-inventory');
const { createPostgresAskRouter } = require('./web/routes/postgres-ask');
const { createPostgresReportsRouter } = require('./web/routes/postgres-reports');
const { createPostgresConnectionsRouter } = require('./web/routes/postgres-connections');
const { createPostgresShippingRouter } = require('./web/routes/postgres-shipping');
const { createPostgresShippingWebhooks } = require('./web/routes/postgres-shipping-webhooks');
const { createPostgresProviderWebhooks } = require('./web/routes/postgres-provider-webhooks');
const { createPostgresPaymentWebhooks } = require('./web/routes/postgres-payment-webhooks');
const { createPostgresCommercialWebhooks } = require('./web/routes/postgres-commercial-webhooks');
const { createPostgresCommercialRouter } = require('./web/routes/postgres-commercial');
const postgresEntitlements = require('./entitlements/postgres-service');
const { createPostgresImportsRouter } = require('./web/routes/postgres-imports');
const { createPostgresProjectionsRouter } = require('./web/routes/postgres-projections');
const { createPostgresCommerceRouter } = require('./web/routes/postgres-commerce');
const { createPostgresConnectionsApi } = require('./web/routes/postgres-connections-api');
const { createPostgresFeedApi } = require('./web/routes/postgres-feed-api');
const { createPostgresPublicApi } = require('./web/routes/postgres-public-api');
const { createPostgresMailRouter } = require('./web/routes/postgres-mail');
const { createPostgresMessagesRouter } = require('./web/routes/postgres-messages');
const { createPostgresAutopilotRouter } = require('./web/routes/postgres-autopilot');
const { createPostgresWarehouseRouter } = require('./web/routes/postgres-warehouse');
const { createPostgresTransfersRouter } = require('./web/routes/postgres-transfers');
const { createPostgresOperationsRouter } = require('./web/routes/postgres-operations');
const { createPostgresOperationsApi } = require('./web/routes/postgres-operations-api');
const { createPostgresPricingRouter } = require('./web/routes/postgres-pricing');
const { createPostgresSearchRouter } = require('./web/routes/postgres-search');
const { createPostgresPlanningRouter } = require('./web/routes/postgres-planning');
const { createPostgresRepairsRouter } = require('./web/routes/postgres-repairs');
const postgresProjections = require('./projections/postgres-service');
const postgresExploration = require('./onboarding/postgres-exploration');
const { requireOperationalSubscription } = require('./web/commercial-middleware');

function createPostgresApp({database,resourceDatabase=database,sessionStore,sessionSecret=config.sessionSecret,env=config.env,aiProvider=null,
  connectionProviders=null,connectionPublicOrigin=null,shippingOptions=null,paymentOptions=null,agentInspection=false,agentInspectionGuard=null,
  commercialOptions=null,ssoOptions=null,ownerConsoleOptions=null,probeCacheMs={health:5000,readiness:1000},probeNow=Date.now,
  assetVersion=process.env.FOUNDRY_ASSET_VERSION||config.operations.releaseRef}={}) {
  if(!database?.query)throw new TypeError('A PostgreSQL database is required.');
  const app=express();
  const store=sessionStore || new PostgresSessionStore(database);
  app.locals.database=database;
  app.locals.sessionStore=store;
  app.locals.aiProvider=aiProvider;
  app.locals.assetVersion=assetVersion;
  app.set('view engine','ejs');
  app.set('views',path.join(__dirname,'web','views'));
  app.set('trust proxy',1);
  app.disable('x-powered-by');
  // The private console is dispatched before ALL customer authentication,
  // tenant selection, subscription checks, API routes and application rendering.
  const ownerModule=require('./platform-owner/app');
  const ownerOrigin=ownerModule.origin(ownerConsoleOptions?.origin||process.env.STOCKCHIEF_OWNER_ORIGIN,{test:env==='test'});
  if(ownerOrigin){
    const ownerApp=ownerModule.createOwnerConsole({database,store,sessionSecret,env,
      customerOrigin:connectionPublicOrigin||config.connections.publicOrigin,
      ...(ownerConsoleOptions||{})});
    app.use((req,res,next)=>ownerModule.matchesHost(req,ownerOrigin)?ownerApp(req,res,next):next());
  }
  app.use((req,res,next)=>{
    if(req.path==='/commercial-admin'||req.path.startsWith('/commercial-admin/'))
      return res.status(404).type('html').send('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page unavailable · StockChief</title><link rel="stylesheet" href="/owner-console.css"></head><body><main class="owner-auth"><section class="auth-card"><h1>This page is unavailable in the customer app.</h1><p>Help and support stays with your own conversations.</p><a href="/support">Help and support</a></section></main></body></html>');
    next();
  });
  app.use(require('./commercial/resource-metrics').middleware(resourceDatabase));
  app.get('/app-system.css',(req,res)=>res.type('text/css').set('Cache-Control','public, max-age=86400').send(require('./web/presentation/stylesheets').stylesheet()));
  app.use(express.static(path.join(__dirname,'web','public'),{maxAge:env==='production'?'7d':0}));
  // The restricted agent renderer uses the same public asset boundary as the
  // actual website. Every application/API read after static files still crosses
  // its fresh host guard; public CSS/JS never requires a tenant database read.
  if(agentInspectionGuard!==null){
    if(!agentInspection||typeof agentInspectionGuard!=='function')throw new TypeError('An inspection guard requires the restricted agent renderer.');
    app.use(agentInspectionGuard);
  }
  app.use(require('./web/presentation/navigation').createAliasRouter());
  // Webhooks and token APIs run before cookie authentication, but still need a
  // database context so an unscoped external request cannot escape accounting.
  app.use(require('./commercial/enforcement').contextMiddleware(database));
  app.use(createPostgresCommercialWebhooks(database,commercialOptions?.billingProvider?{
    provider:commercialOptions.billingProvider,providerOptions:commercialOptions.providerOptions||{}}:{}));
  app.use(createPostgresShippingWebhooks(database,shippingOptions || {}));
  app.use(require('./web/routes/postgres-shipstation-custom').createShipStationCustomRouter(database));
  app.use(createPostgresPaymentWebhooks(database,paymentOptions || {}));
  app.use(require('./web/routes/postgres-cardknox').createCardknoxPublicRouter(database));
  app.use(createPostgresProviderWebhooks(database,{providers:connectionProviders || undefined,
    publicOrigin:connectionPublicOrigin || (env==='test'?'request':undefined)}));
  app.use(multipart({limit:config.uploads.maxBytes,maxFiles:config.uploads.maxFiles}));
  app.use(express.urlencoded({extended:true,limit:'256kb'}));
  app.use(express.json({limit:'256kb'}));
  app.use('/api/v1/feed',createPostgresFeedApi(database));
  app.use('/api/v1',createPostgresConnectionsApi(database,{providers:connectionProviders || undefined}));
  app.use('/api/v1/operations',createPostgresOperationsApi(database));
  app.use('/api/v1/public',createPostgresPublicApi(database));
  const probes=new Map();
  const probe=(key,ttl,run)=>{
    const prior=probes.get(key);
    if(prior&&(prior.pending||prior.expiresAt>probeNow()))return prior.promise;
    const state={pending:true,expiresAt:0,promise:null};
    state.promise=Promise.resolve().then(run).then((result)=>{
      state.pending=false;
      state.expiresAt=probeNow()+Math.max(0,Number(ttl)||0);
      return result;
    },(error)=>{
      if(probes.get(key)===state)probes.delete(key);
      throw error;
    });
    probes.set(key,state);
    return state.promise;
  };
  app.get('/healthz',async(req,res)=>{
    try {
      const result=await probe('health',probeCacheMs.health,()=>database.query(
        'SELECT COUNT(*) AS count FROM stockchief_postgres_migrations'));
      return res.json({ok:true,database:'postgresql',migrations:Number(result.rows[0].count),
        releaseRef:config.operations.releaseRef});
    } catch { return res.status(503).json({ok:false,database:'unavailable'}); }
  });
  app.get('/readyz',async(req,res)=>{
    try{
      const result=await probe('readiness',probeCacheMs.readiness,()=>database.query(`SELECT
        (SELECT COUNT(*) FROM stockchief_postgres_migrations) AS migrations,
        (SELECT COUNT(*) FROM stockchief_runtime.jobs WHERE status='DEAD') AS dead_jobs,
        (SELECT COUNT(*) FROM stockchief_runtime.jobs WHERE status IN ('PENDING','RETRY')
          AND available_at<floor(extract(epoch FROM now()-interval '5 minutes')*1000)) AS stale_jobs`));
      const state=result.rows[0];
      const commercialTelemetry=require('./commercial/resource-metrics').status();
      const ready=Number(state.stale_jobs)===0&&commercialTelemetry.persistenceFailures===0;
      return res.status(ready?200:503).json({ok:ready,commercialTelemetry,
        database:'postgresql',shared:true,multiWriter:true,migrations:Number(state.migrations),
        deadJobs:Number(state.dead_jobs),staleJobs:Number(state.stale_jobs)});
    }catch{return res.status(503).json({ok:false,database:'unavailable'});}
  });
  app.use(session({name:'foundry.sid',secret:sessionSecret,store,resave:false,saveUninitialized:false,rolling:true,
    cookie:{httpOnly:true,sameSite:'lax',secure:env==='production',maxAge:14*86400000}}));
  app.use((req,res,next)=>{
    req.db=database;
    res.locals.appName='StockChief';
    res.locals.origin=`${req.protocol}://${req.get('host')}`;
    res.locals.currentPath=req.path;
    res.locals.query=req.query || {};
    res.locals.assetVersion=app.locals.assetVersion;
    res.locals.helpers=viewHelpers;
    res.locals.attentionCount=0;
    next();
  });
  app.use(commonMiddleware.flash);
  app.use(commonMiddleware.csrf);
  app.use(authMiddleware.loadUser(database,{readonly:agentInspection}));
  app.use(require('./web/routes/postgres-company-sign-in').scopeProtection(database));
  app.use(require('./commercial/enforcement').contextMiddleware(database));
  app.use(async(req,res,next)=>{try{const commercialAccountId=req.workspace?.owner_account_id||req.account?.id;
    res.locals.commercial=req.account
      ?await postgresEntitlements.summary(database,{accountId:commercialAccountId,workspaceId:req.ctx?.workspaceId},{includePresentation:Boolean(req.accepts('html'))})
      :{subscription:null,access:postgresEntitlements.operationalAccess(null),capabilities:[],meters:[]};
    res.locals.planGates=req.ctx&&req.accepts('html')?await require('./web/presentation/plan-gates').read(database,{accountId:commercialAccountId,workspaceId:req.ctx.workspaceId}):{};
    return next();}catch(error){return next(error);}});
  app.use(requireOperationalSubscription);
  app.use(require('./commercial/enforcement').middleware(database));
  app.use(async(req,res,next)=>{
    // JSON endpoints retain authentication, subscription access and canonical
    // enforcement above. They do not render navigation, onboarding or banners.
    if(!req.ctx||!req.accepts('html'))return next();
    try {
      const [attentionCount,entry,importActivity,sourceUploads]=await Promise.all([
        postgresProjections.needsCount(database,req.ctx.workspaceId,req.ctx.actorId),
        postgresExploration.state(database,req.ctx.workspaceId,req.account.id),
        req.method==='GET'&&req.accepts('html')?require('./imports/postgres-progress').list(database,req.ctx.workspaceId,{activeOnly:true,limit:3}):Promise.resolve([]),
        req.method==='GET'&&req.accepts('html')?require('./imports/postgres-source-uploads').list(database,req.ctx.workspaceId,{activeOnly:true,limit:2}):Promise.resolve([]),
      ]);
      res.locals.attentionCount=attentionCount;res.locals.globalOnboardingEntry=entry;res.locals.globalImportActivity=importActivity;res.locals.globalSourceUploads=sourceUploads;return next();
    }
    catch(error){return next(error);}
  });
  app.use(postgresPageRenderer);
  app.use(require('./web/routes/postgres-company-sign-in').createCompanySignInRouter(database,{...ssoOptions,publicOrigin:connectionPublicOrigin||(env==='test'?'request':config.connections.publicOrigin)}));
  app.use(require('./web/routes/postgres-support-conversations').createSupportConversationsRouter(database));
  app.use(createPostgresCommercialRouter(database,{publicOrigin:connectionPublicOrigin || config.connections.publicOrigin,
    ...(commercialOptions||{})}));
  app.use(createPostgresAuthRouter(database,commercialOptions||{}));
  app.use(createPostgresWorkspacesRouter(database));
  app.use(createPostgresSettingsRouter(database,{provider:aiProvider}));
  app.use(createPostgresOnboardingRouter(database));
  app.use(createPostgresLocationsRouter(database));
  app.use(createPostgresInventoryRouter(database));
  app.use(createPostgresPricingRouter(database));
    app.use(require('./web/routes/postgres-promotions').createPostgresPromotionsRouter(database));
  app.use(createPostgresSearchRouter(database));
  app.use(createPostgresPlanningRouter(database));
  app.use(createPostgresRepairsRouter(database));
  app.use(createPostgresAskRouter(database,{provider:aiProvider,agentInspection,conversationSecret:sessionSecret}));
  app.use(createPostgresReportsRouter(database));
  app.use(createPostgresConnectionsRouter(database,{providers:connectionProviders || undefined,
    draftProviderConfigured:Boolean(aiProvider),
    publicOrigin:connectionPublicOrigin || (env==='test'?'request':undefined),
    paymentConnectOptions:paymentOptions?.connect||{},testMode:env==='test'}));
  app.use(createPostgresMailRouter(database,{providers:connectionProviders || undefined,aiProvider}));
  app.use(createPostgresMessagesRouter(database));
  app.use(createPostgresShippingRouter(database,shippingOptions || {}));
  app.use(createPostgresImportsRouter(database,{provider:aiProvider}));
  app.use(createPostgresCommerceRouter(database,{paymentOptions:paymentOptions||{}}));
  app.use(createPostgresAutopilotRouter(database));
  app.use(createPostgresWarehouseRouter(database));
  app.use(createPostgresTransfersRouter(database));
  app.use(require('./web/routes/postgres-manufacturing').createPostgresManufacturingRouter(database));
  app.use(require('./web/routes/postgres-custody').createPostgresCustodyRouter(database));
  app.use(createPostgresOperationsRouter(database));
  app.use(createPostgresProjectionsRouter(database));
  app.use('/api/v1/business',createPostgresBusinessRouter(database));
  app.get('/',async(req,res,next)=>{
    try {
    if(!req.account)return res.redirect('/login');
    if(!req.user)return res.redirect(req.account.plan==='commercial_pending'
      ?(req.account.email_verified_at?'/complete-signup':'/verify-email/pending'):'/inventories');
    const products=await database.query('SELECT 1 FROM items WHERE workspace_id=$1 AND is_active=1 LIMIT 1',
      [req.ctx.workspaceId]);
    return res.redirect(products.rows.length?'/inventory':'/onboarding');
    } catch(error) { return next(error); }
  });
  // Express's default final handler exposes an unbranded "Cannot GET" page.
  // Keep API errors machine readable and render the same recovery screen for
  // every unknown browser address, including a signed-out visitor's address.
  app.use((req,res)=>{
    if(req.path.startsWith('/api/')||!req.accepts('html'))
      return res.status(404).json({error:{code:'not_found',message:'That address was not found.'}});
    return res.status(404).page('error',{title:'Page not found',status:404,
      message:'That page may have moved, or the address may be incorrect. Your records have not changed.'});
  });
  app.use(commonMiddleware.errorHandler(env==='production'));
  return app;
}

module.exports = { createPostgresApp };

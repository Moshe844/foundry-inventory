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
const { createPostgresConnectionsRouter } = require('./web/routes/postgres-connections');
const { createPostgresShippingRouter } = require('./web/routes/postgres-shipping');
const { createPostgresShippingWebhooks } = require('./web/routes/postgres-shipping-webhooks');
const { createPostgresProviderWebhooks } = require('./web/routes/postgres-provider-webhooks');
const { createPostgresPaymentWebhooks } = require('./web/routes/postgres-payment-webhooks');
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

function createPostgresApp({database,sessionStore,sessionSecret=config.sessionSecret,env=config.env,aiProvider=null,
  connectionProviders=null,connectionPublicOrigin=null,shippingOptions=null,paymentOptions=null,
  probeCacheMs={health:5000,readiness:1000}}={}) {
  if(!database?.query)throw new TypeError('A PostgreSQL database is required.');
  const app=express();
  const store=sessionStore || new PostgresSessionStore(database);
  app.locals.database=database;
  app.locals.sessionStore=store;
  app.locals.aiProvider=aiProvider;
  app.set('view engine','ejs');
  app.set('views',path.join(__dirname,'web','views'));
  app.set('trust proxy',1);
  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname,'web','public'),{maxAge:env==='production'?'7d':0}));
  app.use(createPostgresShippingWebhooks(database,shippingOptions || {}));
  app.use(createPostgresPaymentWebhooks(database,paymentOptions || {}));
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
    const prior=probes.get(key);const now=Date.now();
    if(prior&&prior.expiresAt>now)return prior.promise;
    const promise=Promise.resolve().then(run).catch((error)=>{
      if(probes.get(key)?.promise===promise)probes.delete(key);
      throw error;
    });
    probes.set(key,{expiresAt:now+Math.max(0,Number(ttl)||0),promise});
    return promise;
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
      return res.status(Number(state.stale_jobs)>0?503:200).json({ok:Number(state.stale_jobs)===0,
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
    res.locals.assetVersion=process.env.FOUNDRY_ASSET_VERSION || 'postgres';
    res.locals.helpers=viewHelpers;
    res.locals.attentionCount=0;
    next();
  });
  app.use(commonMiddleware.flash);
  app.use(commonMiddleware.csrf);
  app.use(authMiddleware.loadUser(database));
  app.use(async(req,res,next)=>{
    if(!req.ctx)return next();
    try {
      const [attentionCount,entry]=await Promise.all([
        postgresProjections.needsCount(database,req.ctx.workspaceId),
        postgresExploration.state(database,req.ctx.workspaceId,req.account.id),
      ]);
      res.locals.attentionCount=attentionCount;res.locals.globalOnboardingEntry=entry;return next();
    }
    catch(error){return next(error);}
  });
  app.use(postgresPageRenderer);
  app.use(createPostgresAuthRouter(database));
  app.use(createPostgresWorkspacesRouter(database));
  app.use(createPostgresSettingsRouter(database,{provider:aiProvider}));
  app.use(createPostgresOnboardingRouter(database));
  app.use(createPostgresLocationsRouter(database));
  app.use(createPostgresInventoryRouter(database));
  app.use(createPostgresPricingRouter(database));
  app.use(createPostgresSearchRouter(database));
  app.use(createPostgresPlanningRouter(database));
  app.use(createPostgresRepairsRouter(database));
  app.use(createPostgresAskRouter(database,{provider:aiProvider}));
  app.use(createPostgresConnectionsRouter(database,{providers:connectionProviders || undefined,
    publicOrigin:connectionPublicOrigin || (env==='test'?'request':undefined)}));
  app.use(createPostgresMailRouter(database,{providers:connectionProviders || undefined}));
  app.use(createPostgresMessagesRouter(database));
  app.use(createPostgresShippingRouter(database,shippingOptions || {}));
  app.use(createPostgresImportsRouter(database,{provider:aiProvider}));
  app.use(createPostgresCommerceRouter(database,{paymentOptions:paymentOptions||{}}));
  app.use(createPostgresAutopilotRouter(database));
  app.use(createPostgresWarehouseRouter(database));
  app.use(createPostgresTransfersRouter(database));
  app.use(createPostgresOperationsRouter(database));
  app.use(createPostgresProjectionsRouter(database));
  app.use('/api/v1/business',createPostgresBusinessRouter(database));
  app.get('/',async(req,res,next)=>{
    try {
    if(!req.account)return res.redirect('/login');
    if(!req.user)return res.redirect('/inventories');
    const products=await database.query('SELECT 1 FROM items WHERE workspace_id=$1 AND is_active=1 LIMIT 1',
      [req.ctx.workspaceId]);
    return res.redirect(products.rows.length?'/inventory':'/onboarding');
    } catch(error) { return next(error); }
  });
  app.use(commonMiddleware.errorHandler(env==='production'));
  return app;
}

module.exports = { createPostgresApp };

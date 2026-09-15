'use strict';

const path = require('node:path');
const express = require('express');
const session = require('express-session');

const config = require('./config');
const { openDatabase } = require('./db');
const { createSessionStore } = require('./web/session-store');
const middleware = require('./web/middleware');
const { multipart } = require('./web/multipart');
const helpers = require('./web/view-helpers');

const authRoutes = require('./web/routes/auth');
const overviewRoutes = require('./web/routes/overview');
const inventoryRoutes = require('./web/routes/inventory');
const locationRoutes = require('./web/routes/locations');
const activityRoutes = require('./web/routes/activity');
const searchRoutes = require('./web/routes/search');
const settingsRoutes = require('./web/routes/settings');
const foundryRoutes = require('./web/routes/foundry');
const attentionRoutes = require('./web/routes/attention');
const workspaceRoutes = require('./web/routes/workspaces');
const actionRoutes = require('./web/routes/actions');
const importRoutes = require('./web/routes/imports');
const onboardingRoutes = require('./web/routes/onboarding');
const autopilotRoutes = require('./web/routes/autopilot');
const purchasingRoutes = require('./web/routes/purchasing');
const managerRoutes = require('./web/routes/manager');
const salesRoutes = require('./web/routes/sales');
const messageRoutes = require('./web/routes/messages');
const mailRoutes = require('./web/routes/mail');
const paymentRoutes = require('./web/routes/payments');
const shippingRoutes = require('./web/routes/shipping');
// Registers the payment providers this build ships with.
require('./payments');
require('./shipping');
require('./autonomous/domain-adapters').load();
const pricingRoutes = require('./web/routes/pricing');
const connectionRoutes = require('./web/routes/connections');
const accountingRoutes = require('./web/routes/accounting');
const planningRoutes = require('./web/routes/planning');
const repairRoutes = require('./web/routes/repairs');
const { createFeedApi } = require('./web/routes/feed-api');
const { createConnectionsApi } = require('./web/routes/connections-api');
const { createProviderWebhooks } = require('./web/routes/provider-webhooks');
const { createOperationsApi } = require('./web/routes/operations-api');
const { createPublicApi } = require('./web/routes/public-api');
const operationsRoutes = require('./web/routes/operations');
const warehouseRoutes = require('./web/routes/warehouse');
const transferRoutes = require('./web/routes/transfers');
const readiness = require('./operations/readiness');
const { ProductBrain } = require('./product-brain/registry');

/**
 * Builds the Express application around an already-open database handle.
 * Tests create one per case with their own database file.
 */
function createApp(options = {}) {
  const db = options.db || openDatabase(options.databasePath || config.databasePath);
  const isProduction = (options.env || config.env) === 'production';

  const app = express();
  const productBrain = new ProductBrain();
  app.locals.db = db;
  app.locals.productBrain = productBrain;
  const registered = (name, router, mountPath = '') =>
    productBrain.registerRouter(name, router, { mountPath });
  // Explicit provider override. Undefined means the configured provider is
  // built per request, so there is no accidental production fallback.
  app.locals.aiProvider = options.aiProvider || null;
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'web', 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Even malformed or oversized requests need the same monitored error path.
  // This must precede multipart parsing; otherwise an upload rejected before
  // routing has no database handle and the responder itself throws while
  // trying to record the incident.
  app.use((req, res, next) => { req.db = db; next(); });

  // Development-only request timing makes a slow route visible without
  // profiling the browser or logging cookies/body data. Production monitoring
  // owns this signal there.
  if (!isProduction) app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (elapsedMs >= 500) console.warn(`[slow] ${req.method} ${req.path} ${res.statusCode} ${elapsedMs.toFixed(1)}ms`);
    });
    next();
  });

  app.use(
    express.static(path.join(__dirname, 'web', 'public'), {
      maxAge: isProduction ? '7d' : 0,
    })
  );
  // Uploads are parsed before anything else reads the body, so a file arrives
  // as an ordinary form: same CSRF check, same flash messages, same everything.
  app.use(multipart({ limit: config.uploads.maxBytes, maxFiles:config.uploads.maxFiles }));
  /*
   * Before the body parsers on purpose: a payment webhook authenticates by a
   * signature over the exact bytes it sent, and a parser replaces them. After
   * the database handle, because it still has to write what it is told.
   *
   * Everything between the two — sessions, CSRF, the signed-in context — is
   * deliberately skipped: a provider arrives with no cookie and no token, and
   * its signature is the whole authentication.
  */
  // Orchestrator probes must never create browser sessions or CSRF state. At
  // production polling rates, even an empty session per probe becomes millions
  // of rows. Mount both probes before every session-aware middleware.
  app.get('/healthz', (req, res) => {
    try {
      db.prepare('SELECT 1 AS ok').get();
      const schemaVersion = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get()?.value || null;
      return res.json({ ok: true, database: 'available', uptimeSeconds: Math.floor(process.uptime()),
        releaseRef: config.operations.releaseRef, schemaVersion });
    } catch {
      return res.status(503).json({ ok: false, database: 'unavailable' });
    }
  });
  productBrain.registerRoute('health', '/healthz', 'GET');
  // A readiness snapshot validates every workspace's inventory/accounting
  // invariants. Orchestrators may poll this endpoint several times per second;
  // recomputing the same immutable snapshot for every concurrent probe starves
  // customer requests on the single-writer database. The owner Operations page
  // and certification runner still request fresh snapshots directly.
  let readinessCache = null;
  app.get('/readyz', (req, res) => {
    const now = Date.now();
    if (!readinessCache || now - readinessCache.createdAt >= config.operations.readinessCacheMs) {
      readinessCache = {
        createdAt: now,
        state: readiness.snapshot(db, { env: options.env || config.env }),
      };
    }
    const state = readinessCache.state;
    res.set('X-Foundry-Readiness-Age-Ms', String(Math.max(0, now - readinessCache.createdAt)));
    return res.status(state.ok ? 200 : 503).json({
      ok: state.ok, environment: state.environment,
      checks: state.checks.map((row) => ({ key: row.key, status: row.status, message: row.message })),
    });
  });
  productBrain.registerRoute('readiness', '/readyz', 'GET');

  app.use(registered('payment-webhooks', paymentRoutes.webhooks));
  // Same treatment, same reason: the carrier signs the raw bytes.
  app.use(registered('shipping-webhooks', shippingRoutes.webhooks));

  app.use(express.urlencoded({ extended: true, limit: '256kb' }));
  app.use(express.json({ limit: '256kb', verify(req, res, buffer) { req.rawBody = Buffer.from(buffer); } }));

  // External systems authenticate with a scoped bearer token, never a browser
  // session. Mount this before cookie sessions and CSRF so unattended feeds do
  // not depend on a person being signed in.
  app.use('/api/v1', middleware.rateLimit({ windowMs: 60_000, max: 300,
    key: (req) => req.ip || req.socket.remoteAddress || 'api' }));
  app.use('/api/v1/feed', registered('feed-api', createFeedApi(db), '/api/v1/feed'));
  app.use('/api/v1/connections', registered('provider-webhooks', createProviderWebhooks(db), '/api/v1/connections'));
  app.use('/api/v1', registered('connections-api', createConnectionsApi(db), '/api/v1'));
  app.use('/api/v1/operations', registered('operations-api', createOperationsApi(db), '/api/v1/operations'));
  app.use('/api/v1/public', registered('public-api', createPublicApi(db), '/api/v1/public'));

  // Refuse abusive login traffic before it can allocate a CSRF/browser session.
  app.use('/login', middleware.rateLimit({ windowMs: 15 * 60_000, max: 30 }));

  const store = createSessionStore(db, { anonymousMaxAgeMs: config.sessions.anonymousMaxAgeMs });
  app.locals.sessionStore = store;
  app.use(
    session({
      name: 'foundry.sid',
      secret: options.sessionSecret || config.sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
        maxAge: 14 * 24 * 60 * 60 * 1000,
      },
    })
  );

  app.use((req, res, next) => {
    req.db = db;
    res.locals.helpers = helpers;
    res.locals.appName = 'Foundry';
    res.locals.origin = `${req.protocol}://${req.get('host')}`;
    res.locals.currentPath = req.path;
    res.locals.query = req.query || {};
    next();
  });
  app.use(middleware.flash);
  app.use(middleware.csrf);
  app.use(middleware.loadUser(db));
  app.use(middleware.foundryContext(db));
  app.use(middleware.pageRenderer);

  app.use(registered('auth', authRoutes));
  app.use(registered('manager', managerRoutes));
  app.use(registered('repairs', repairRoutes));
  app.use(registered('sales', salesRoutes));
  app.use(registered('messages', messageRoutes));
  app.use(registered('mail', mailRoutes));
  app.use(registered('payment-actions', paymentRoutes.actions));
  app.use(registered('shipping', shippingRoutes.router));
  app.use(registered('pricing', pricingRoutes));
  app.use(registered('connections', connectionRoutes));
  app.use(registered('accounting', accountingRoutes));
  app.use(registered('foundry', foundryRoutes));
  app.use(registered('workspaces', workspaceRoutes));
  app.use(registered('actions', actionRoutes));
  app.use(registered('imports', importRoutes));
  app.use(registered('onboarding', onboardingRoutes));
  app.use(registered('autopilot', autopilotRoutes));
  app.use(registered('purchasing', purchasingRoutes));
  app.use(registered('warehouse', warehouseRoutes));
  app.use(registered('transfers', transferRoutes));
  // Reads everything above it, writes only replenishment levels.
  app.use(registered('planning', planningRoutes));
  app.use(registered('attention', attentionRoutes));
  app.use(registered('overview', overviewRoutes));
  app.use(registered('inventory', inventoryRoutes));
  app.use(registered('locations', locationRoutes));
  app.use(registered('activity', activityRoutes));
  app.use(registered('search', searchRoutes));
  app.use(registered('settings', settingsRoutes));
  app.use(registered('operations', operationsRoutes));

  // Fail startup and CI when a real route is outside the product contract.
  // This happens after every router is registered and before the 404 handler.
  app.locals.productBrainCoverage = productBrain.validate();

  app.use((req, res, next) => {
    res.status(404);
    if (req.accepts('html')) {
      return res.page('error', {
        title: 'Not found',
        status: 404,
        message: 'That page does not exist.',
      });
    }
    return res.json({ error: { code: 'not_found', message: 'Not found' } });
  });

  app.use(middleware.errorHandler(isProduction));

  return app;
}

module.exports = { createApp };

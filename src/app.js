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
const { createFeedApi } = require('./web/routes/feed-api');

/**
 * Builds the Express application around an already-open database handle.
 * Tests create one per case with their own database file.
 */
function createApp(options = {}) {
  const db = options.db || openDatabase(options.databasePath || config.databasePath);
  const isProduction = (options.env || config.env) === 'production';

  const app = express();
  app.locals.db = db;
  // Explicit provider override. Undefined means the configured provider is
  // built per request, so there is no accidental production fallback.
  app.locals.aiProvider = options.aiProvider || null;
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'web', 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    express.static(path.join(__dirname, 'web', 'public'), {
      maxAge: isProduction ? '7d' : 0,
    })
  );
  // Uploads are parsed before anything else reads the body, so a file arrives
  // as an ordinary form: same CSRF check, same flash messages, same everything.
  app.use(multipart({ limit: 32 * 1024 * 1024 }));
  app.use(express.urlencoded({ extended: true, limit: '256kb' }));
  app.use(express.json({ limit: '256kb' }));

  // External systems authenticate with a scoped bearer token, never a browser
  // session. Mount this before cookie sessions and CSRF so unattended feeds do
  // not depend on a person being signed in.
  app.use('/api/v1/feed', createFeedApi(db));

  const store = createSessionStore(db);
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
    res.locals.appName = 'Foundry Inventory';
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

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(authRoutes);
  app.use(managerRoutes);
  app.use(foundryRoutes);
  app.use(workspaceRoutes);
  app.use(actionRoutes);
  app.use(importRoutes);
  app.use(onboardingRoutes);
  app.use(autopilotRoutes);
  app.use(purchasingRoutes);
  app.use(attentionRoutes);
  app.use(overviewRoutes);
  app.use(inventoryRoutes);
  app.use(locationRoutes);
  app.use(activityRoutes);
  app.use(searchRoutes);
  app.use(settingsRoutes);

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

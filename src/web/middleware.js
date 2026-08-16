'use strict';

const crypto = require('node:crypto');
const authService = require('../domain/auth-service');
const workspaceService = require('../domain/workspace-service');
const { AuthenticationError, AuthorizationError, DomainError } = require('../domain/errors');

/** Adds req.flash()/res.locals.flash without pulling in another dependency. */
function flash(req, res, next) {
  req.flash = (type, message) => {
    if (!req.session) return;
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, message });
  };
  const messages = (req.session && req.session.flash) || [];
  if (req.session) req.session.flash = [];
  res.locals.flash = messages;
  next();
}

/** Synchroniser-token CSRF protection for every state-changing request. */
function csrf(req, res, next) {
  if (!req.session) return next();
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('base64url');
  }
  res.locals.csrfToken = req.session.csrfToken;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  // A form that accidentally carries the field twice arrives as an array.
  // Comparing that to the token would fail as "session expired", which is a
  // baffling thing to show someone who did nothing wrong.
  const field = req.body && req.body._csrf;
  const supplied = (Array.isArray(field) ? field[0] : field) || req.get('x-csrf-token');
  if (!supplied || supplied !== req.session.csrfToken) {
    const err = new DomainError('Your session expired. Please try that again.', {
      code: 'invalid_csrf',
      status: 403,
    });
    return next(err);
  }
  return next();
}

/**
 * Resolves who is signed in, and which of their inventories they are looking at.
 *
 * The session holds an account and a *chosen* workspace. Membership is verified
 * on every single request rather than trusted from the session, so a workspace
 * id that was valid yesterday — or that someone pasted in — still has to pass
 * the same check as any other record. A session pointing at a workspace the
 * account cannot reach silently falls back to one it can, rather than erroring:
 * losing access to a shared inventory should not lock you out of your own.
 */
function loadUser(db) {
  return (req, res, next) => {
    res.locals.currentUser = null;
    res.locals.workspace = null;
    res.locals.workspaces = [];
    res.locals.account = null;
    if (!req.session || !req.session.accountId) return next();

    const account = authService.getAccount(db, req.session.accountId);
    if (!account) {
      req.session.destroy(() => next());
      return;
    }
    req.account = account;
    res.locals.account = { id: account.id, name: account.name, email: account.email, plan: account.plan };

    const memberships = workspaceService.listForAccount(db, account.id);
    res.locals.workspaces = memberships;
    if (memberships.length === 0) return next();

    let workspaceId = req.session.workspaceId;
    let resolved = workspaceService.resolveForAccount(db, account.id, workspaceId);
    if (!resolved) {
      workspaceId = workspaceService.defaultWorkspaceFor(db, account.id);
      resolved = workspaceService.resolveForAccount(db, account.id, workspaceId);
      if (resolved) req.session.workspaceId = workspaceId;
    }
    if (!resolved) return next();
    if (account.last_workspace_id !== workspaceId) {
      workspaceService.rememberWorkspace(db, account.id, workspaceId);
    }

    const { workspace, membership } = resolved;
    req.user = { ...membership, email: account.email, plan: account.plan };
    req.workspace = workspace;
    // Both ids travel together: workspace_id scopes the data, actorId names the
    // membership that a movement will be attributed to.
    req.ctx = { workspaceId: workspace.id, actorId: membership.id, accountId: account.id };
    res.locals.currentUser = {
      id: membership.id,
      name: membership.name,
      email: account.email,
      role: membership.role,
    };
    res.locals.workspace = workspace;
    return next();
  };
}

/**
 * Makes the workspace's Foundry configuration and its customer-facing
 * vocabulary available to every view. Terminology is presentation only — the
 * domain layer never sees it.
 */
function foundryContext(db) {
  const planApplier = require('../foundry/plan-applier');
  const { createVocabulary } = require('../foundry/terminology');

  return (req, res, next) => {
    if (!req.user) {
      res.locals.foundry = { configured: false, vocabulary: createVocabulary({}) };
      res.locals.attentionCount = 0;
      return next();
    }
    const configuration = planApplier.getConfiguration(db, req.ctx.workspaceId);
    const vocabulary = createVocabulary(configuration ? configuration.terminology : {});
    res.locals.foundry = {
      configured: Boolean(configuration && configuration.configuredAt),
      configuration,
      vocabulary,
    };
    // The nav badge. A count, not a computation: detection already ran.
    // Deliberately defensive: this runs on every page, and a missing badge is a
    // cosmetic loss where a thrown error would be an outage of the whole app.
    try {
      res.locals.attentionCount = db
        .prepare(
          `SELECT COUNT(*) AS n FROM attention_items
            WHERE workspace_id = ? AND status IN ('OPEN', 'ACKNOWLEDGED')`
        )
        .get(req.ctx.workspaceId).n;
    } catch {
      res.locals.attentionCount = 0;
    }
    res.locals.term = vocabulary.term;
    req.foundry = res.locals.foundry;
    return next();
  };
}

/**
 * A brand-new workspace meets Foundry before it meets the console.
 *
 * Only a genuinely empty workspace is redirected. A workspace that already
 * has locations or items — anything set up before Foundry existed, or by hand —
 * keeps going straight to its console, because taking a working install to a
 * setup screen would be a regression, not an onboarding.
 */
function requireConfigured(db) {
  return (req, res, next) => {
    if (!req.foundry || req.foundry.configured || !req.accepts('html')) return next();
    const existing = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM locations WHERE workspace_id = @workspaceId) +
           (SELECT COUNT(*) FROM items WHERE workspace_id = @workspaceId) AS records`
      )
      .get({ workspaceId: req.ctx.workspaceId });
    if (existing.records > 0) return next();
    return res.redirect('/foundry');
  };
}

/**
 * Signed in *and* looking at an inventory they belong to. An account with no
 * workspace at all is sent to create one rather than shown an empty console.
 */
function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.account && req.accepts('html')) return res.redirect('/inventories');
    if (req.accepts('html')) {
      const target = encodeURIComponent(req.originalUrl || '/');
      return res.redirect(`/login?next=${target}`);
    }
    return next(new AuthenticationError());
  }
  return next();
}

/** Signed in as an account, with or without a workspace selected. */
function requireAccount(req, res, next) {
  if (!req.account) {
    if (req.accepts('html')) {
      const target = encodeURIComponent(req.originalUrl || '/');
      return res.redirect(`/login?next=${target}`);
    }
    return next(new AuthenticationError());
  }
  return next();
}

function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== 'owner') {
    return next(new AuthorizationError('Only an owner can do that.'));
  }
  return next();
}

/** Renders a view inside the application shell. */
function pageRenderer(req, res, next) {
  res.page = (view, data = {}) => {
    res.render(view, { ...data }, (err, html) => {
      if (err) return next(err);
      // A page may opt out of the application chrome — a purchase order printed
      // for a supplier should be the document and nothing else.
      if (data.layout === false) return res.send(html);
      return res.render('layout', {
        ...data,
        body: html,
        title: data.title || 'Foundry Inventory',
        nav: data.nav || null,
        // Absolute base for anything that cannot be a relative path — social
        // preview images are fetched by other people's servers, which have no
        // idea what "/og.png" means. Taken from the request rather than
        // configured, so it is right behind a proxy, on localhost, and on
        // whatever hostname this is actually being served from.
        origin: data.origin || `${req.protocol}://${req.get('host')}`,
      });
    });
  };
  next();
}

/** Wraps async route handlers so rejected promises reach the error handler. */
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Form posts come back to the page the user was on with a friendly message;
 * anything else gets a rendered error page. Nothing leaks a stack trace.
 */
function errorHandler(isProduction) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const status = err instanceof DomainError ? err.status : 500;
    const expected = err instanceof DomainError;
    if (!expected) {
      console.error('[foundry] unexpected error', err);
    }
    const message = expected ? err.message : 'Something went wrong on our side. Please try again.';

    if (req.accepts('html') && !req.xhr && req.path.startsWith('/api/') === false) {
      if (req.method === 'POST' && req.session) {
        req.flash('error', message);
        const back = req.get('referer') || '/';
        return res.redirect(303, back);
      }
      res.status(status);
      if (res.page) {
        return res.page('error', {
          title: status === 404 ? 'Not found' : 'Something went wrong',
          status,
          message,
          detail: !isProduction && !expected ? String(err.stack || err) : null,
        });
      }
      return res.type('text/plain').send(message);
    }

    return res.status(status).json({ error: { code: err.code || 'error', message } });
  };
}

module.exports = {
  flash,
  csrf,
  loadUser,
  foundryContext,
  requireConfigured,
  requireAuth,
  requireAccount,
  requireOwner,
  pageRenderer,
  asyncRoute,
  errorHandler,
};

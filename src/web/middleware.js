'use strict';

const crypto = require('node:crypto');
const authService = require('../domain/auth-service');
const workspaceService = require('../domain/workspace-service');
const { AuthenticationError, AuthorizationError, DomainError } = require('../domain/errors');

/**
 * Bounded, single-node request limiting. Keys are one-way digests so bearer
 * tokens and addresses are never retained in memory or logs.
 */
function rateLimit(options = {}) {
  const windowMs = Math.max(1000, Number(options.windowMs || 60_000));
  const max = Math.max(1, Number(options.max || 120));
  const buckets = new Map();
  let seen = 0;
  return (req, res, next) => {
    const raw = options.key ? options.key(req) : (req.ip || req.socket.remoteAddress || 'unknown');
    const key = crypto.createHash('sha256').update(String(raw)).digest('hex');
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    buckets.set(key, bucket);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.set('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ error: { code: 'rate_limited',
        message: 'Too many requests. Please wait a moment and try again.' } });
    }
    // Amortized cleanup prevents an unbounded map without a background timer.
    seen += 1;
    if (seen % 500 === 0) {
      for (const [candidate, value] of buckets) if (value.resetAt <= now) buckets.delete(candidate);
    }
    return next();
  };
}

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

    // Resolving the current tenant is on every request. Do not construct every
    // other tenant's complete Needs You inbox just to draw a closed switcher;
    // the inventories page loads those counts when somebody asks for them.
    const memberships = workspaceService.listForAccount(db, account.id, { includeAttention: false });
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
 * Makes the workspace's StockChief configuration and its customer-facing
 * vocabulary available to every view. Terminology is presentation only — the
 * domain layer never sees it.
 */
/** The session keys that carry unfinished assistant work; all scoped to one inventory. */
const PENDING_KEYS = ['askConversation', 'askTurns', 'assistantConversationId', 'assistantHandoff', 'assistantOpenGoal', 'assistantQueue', 'assistantTranscript',
  'pendingActionContinuation', 'pendingActionQuestion', 'pendingAskResult', 'pendingLocationTransfer', 'pendingPriceBatch',
  'pendingPriceContinuation', 'pendingPurchaseCostBatch', 'pendingRestrictionFlow', 'pendingSalesContinuation', 'pendingSupplierPayment', 'askTranscript'];

function clearPendingWork(session) {
  for (const key of PENDING_KEYS) delete session[key];
}

function foundryContext(db) {
  const planApplier = require('../foundry/plan-applier');
  const { createVocabulary } = require('../foundry/terminology');

  return (req, res, next) => {
    if (!req.user) {
      res.locals.foundry = { configured: false, vocabulary: createVocabulary({}) };
      res.locals.attentionCount = 0;
      return next();
    }
    /*
     * A question half-answered in one inventory must not be finished in
     * another. Everything the assistant keeps in the session between two
     * requests — a question waiting on the actions page, a continuation, a
     * price batch, the conversation itself — belongs to the inventory it
     * was made in, and is cleared the moment the person switches.
     */
    if (req.session) {
      if (req.session.assistantWorkspaceId && req.session.assistantWorkspaceId !== req.ctx.workspaceId) clearPendingWork(req.session);
      req.session.assistantWorkspaceId = req.ctx.workspaceId;
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
      res.locals.attentionCount = require('../attention/needs-you-count').countNeedsYou(
        db,
        req.ctx.workspaceId,
        req.user,
        { productBrain: req.app.locals.productBrain }
      );
    } catch {
      res.locals.attentionCount = 0;
    }
    res.locals.term = vocabulary.term;
    req.foundry = res.locals.foundry;
    return next();
  };
}

/**
 * A brand-new workspace meets StockChief before it meets the console.
 *
 * Only a genuinely empty workspace is redirected. A workspace that already
 * has locations or items — anything set up before StockChief existed, or by hand —
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

/**
 * A permission guard that also declares its contract to the product brain.
 * Express still enforces access at runtime; the metadata lets route validation,
 * navigation and help use the exact same requirement.
 */
function requirePermission(permission, what) {
  const guard = (req, res, next) => {
    try {
      require('../actions/permissions').assertCan(req.user, permission, what);
      return next();
    } catch (error) { return next(error); }
  };
  guard.productMetadata = { permission, what };
  return guard;
}

requireAuth.productMetadata = { authenticated: true };
requireAccount.productMetadata = { account: true };
requireOwner.productMetadata = { permission: 'ADMIN', role: 'owner' };

/*
 * The way back to the page you came from.
 *
 * A destination must always retain the real page that opened it. This cannot
 * be a list of special cases: inventory can open a supplier, a supplier can
 * open a connection, Ask can open any registered record, and future domains
 * must receive the same behaviour without being added here.
 *
 * The browser's same-origin referer is the source of truth. We retain its
 * path and query string, then remember that trail for redirects or reloads on
 * the destination. Cross-origin values are never accepted as return links.
 */
const productDestinations = require('../product-brain/registry').canonical;
const HUBS = [
  // The Brief presents the owner's current decisions as direct links. A
  // decision opened there belongs to that journey just as much as one opened
  // from the full Needs You queue.
  { path: productDestinations.destination('home').href, label: 'Brief' },
  { path: productDestinations.destination('settings').href, label: 'Settings' },
  { path: productDestinations.destination('planning').href, label: 'What happens next' },
  { path: productDestinations.destination('purchasing').href, label: 'Purchasing' },
  // Needs You is a task inbox. When it opens the exact decision screen, the
  // owner must be able to return to the queue they were working through.
  { path: productDestinations.destination('needs-you').href, label: 'Needs you' },
  { path: '/everything', label: 'Everything else' },
];

function entityOrigin(req, from) {
  const brain = req.app && req.app.locals && req.app.locals.productBrain;
  if (!brain || !req.user) return null;
  const href = `${from.pathname}${from.search || ''}${from.hash || ''}`;
  const matchedRoute = brain.routeForHref(href);
  for (const entity of brain.listEntities()) {
    if (!entity.route || !entity.route.includes(':')) continue;
    // An exact collection route such as /inventory/table must not be mistaken
    // for the dynamic /inventory/:id product route merely because both regexes
    // happen to match. The registered Express route settles that ambiguity.
    if (matchedRoute && matchedRoute.path !== entity.route) continue;
    const pattern = new RegExp(`^${entity.route.split('#')[0]
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:[A-Za-z0-9_]+/g, '[^/]+')}$`);
    if (!pattern.test(from.pathname)) continue;
    const access = brain.accessForHref(href, req.user);
    if (!access || !access.allowed) return null;
    return { href, label: entity.label };
  }
  return null;
}

function registeredAreaOrigin(req, from) {
  const brain = req.app && req.app.locals && req.app.locals.productBrain;
  if (!brain || !req.user) return null;
  const href = `${from.pathname}${from.search || ''}${from.hash || ''}`;
  const exactDestination = brain.listDestinations().find((entry) => {
    try { return new URL(entry.href, 'http://foundry.local').pathname === from.pathname; }
    catch { return false; }
  });
  if (exactDestination) return { href, label: exactDestination.label };
  const access = brain.accessForHref(href, req.user);
  const destinationId = access && access.allowed && access.route && access.route.destinationId;
  const destination = destinationId && brain.destination(destinationId);
  return destination ? { href, label: destination.label } : null;
}

function cameFrom(req) {
  const here = String(req.path || '');
  const hereUrl = (() => {
    try {
      const value = new URL(String(req.originalUrl || here), `http://${req.get('host')}`);
      return `${value.pathname}${value.search}`;
    } catch { return here; }
  })();
  const session = req.session;
  const remembered = session && session.backTo
    && (session.backTo.path === hereUrl || session.backTo.path === here)
    ? { href: session.backTo.href, label: session.backTo.label } : null;

  const referer = req.get('referer');
  let from = null;
  if (referer) { try { from = new URL(referer); } catch { from = null; } }
  if (!from || from.host !== req.get('host')) return remembered;

  const hub = HUBS.find((entry) => from.pathname === entry.path);
  if (hub) {
    if (here === hub.path) return null;
    const hubHref = `${from.pathname}${from.search || ''}${from.hash || ''}`;
    // Remembered, because saving something sends you back to this same page and
    // the referer is then the page itself. Losing the way out at the exact
    // moment somebody has finished a task is how a hub stops being a hub.
    if (session) session.backTo = { path: hereUrl, href: hubHref, label: hub.label };
    return { href: hubHref, label: hub.label };
  }

  // The same page again: a redirect after saving. The trail still holds.
  if (`${from.pathname}${from.search}` === hereUrl) return remembered;
  // The same page with a different filter or page number is still the same
  // page; offering "Back to <this page>" after a chip click is not a way out.
  if (from.pathname === here) return remembered;

  // The source page has already been rendered in this session, so its own
  // title is the most accurate generic label. This works for every present and
  // future page without deriving names from URL segments or maintaining a
  // second routing catalogue.
  const sourceHref = `${from.pathname}${from.search || ''}`;
  const renderedLabel = session && session.renderedPageLabels
    && session.renderedPageLabels[sourceHref];
  if (renderedLabel) {
    const origin = { href: `${sourceHref}${from.hash || ''}`, label: renderedLabel };
    if (session) session.backTo = { path: hereUrl, href: origin.href, label: origin.label };
    return origin;
  }

  // A record is also a real place in a journey. When an owner opens the exact
  // decision behind PO-1002, returning to that exact PO is more useful than a
  // generic Automatic work fallback. Entity routes come from the canonical
  // product brain, so this does not become another independent route list.
  const record = entityOrigin(req, from);
  if (record) {
    if (session) session.backTo = { path: hereUrl, href: record.href, label: record.label };
    return record;
  }

  // Registered route families supply their own product label. New domains get
  // a useful return trail simply by joining the canonical product registry.
  const area = registeredAreaOrigin(req, from);
  if (area) {
    if (session) session.backTo = { path: hereUrl, href: area.href, label: area.label };
    return area;
  }

  /*
   * Every other same-origin page is still a real origin. Keep the full URL so
   * returning from a record also restores the search, filter or page the owner
   * was using. The generic label is deliberate: it remains correct for a new
   * domain without adding another route-name table.
   */
  const href = `${from.pathname}${from.search || ''}${from.hash || ''}`;
  if (session) session.backTo = { path: hereUrl, href, label: 'previous page' };
  return { href, label: 'previous page' };
}

/** Renders a view inside the application shell. */
function pageRenderer(req, res, next) {
  res.page = (view, data = {}) => {
    let navigationArrival = null;
    try { navigationArrival = require('../product-brain/navigation').verifyArrival(req); } catch { navigationArrival = null; }
    let workspaceGuidance = null;
    let screenGuide = Object.prototype.hasOwnProperty.call(data, 'screenGuide')
      ? data.screenGuide
      : null;
    // A screen guide is optional presentation. Building the complete business
    // inbox here made every ordinary page (including Ask, inventory switching
    // and delete confirmation) run every accounting/inventory consistency
    // check before it could render. Only the sections that can actually show
    // an automatically derived guide ask for the lightweight screen context.
    const automaticGuideSections = new Set([
      'inventory', 'locations', 'sales', 'purchasing', 'connections', 'activity', 'settings',
    ]);
    const hasExplicitScreenGuide = Object.prototype.hasOwnProperty.call(data, 'screenGuide');
    if (req.ctx && !hasExplicitScreenGuide && automaticGuideSections.has(data.nav)) {
      try {
        const guidance = require('../manager/guidance');
        workspaceGuidance = guidance.buildForScreen(req.db, req.ctx.workspaceId, req.user, {
          productBrain: req.app.locals.productBrain,
        });
        // A page under a shared sidebar section can say what it actually is,
        // rather than inheriting the section's description.
        screenGuide = guidance.screenContextFor(workspaceGuidance, data.nav, data.screenDescription);
      } catch {
        // Guidance is presentation support. A partially migrated development
        // database must not make the underlying business screen unavailable.
      }
    }
    res.render(view, { ...data }, (err, html) => {
      if (err) return next(err);
      // A page may opt out of the application chrome — a purchase order printed
      // for a supplier should be the document and nothing else.
      if (data.layout === false) return res.send(html);
      const resolvedBackTo = (navigationArrival && navigationArrival.backTo)
        || cameFrom(req) || data.backTo || data.backToFallback || null;
      if (req.session && data.title) {
        const currentHref = (() => {
          try {
            const value = new URL(String(req.originalUrl || req.path || '/'), `http://${req.get('host')}`);
            return `${value.pathname}${value.search}`;
          } catch { return String(req.path || '/'); }
        })();
        const labels = req.session.renderedPageLabels || {};
        // Keep this navigation aid bounded; it is not browsing history.
        labels[currentHref] = String(data.title).replace(/\s+·\s+StockChief$/, '').slice(0, 100);
        const keys = Object.keys(labels);
        for (const key of keys.slice(0, Math.max(0, keys.length - 40))) delete labels[key];
        req.session.renderedPageLabels = labels;
      }
      return res.render('layout', {
        ...data,
        body: html,
        title: data.title || 'StockChief',
        nav: data.nav || null,
        /*
         * A page nobody can leave.
         *
         * The trail is read from where somebody came from, which is right when
         * there is one and leaves nothing at all when there is not — Activity,
         * opened from a bookmark or a full-history link, offered no way out but
         * the browser's own back button. A page that is always reached from
         * somewhere may name that somewhere as its fallback.
         */
        backTo: resolvedBackTo,
        navigationArrival,
        workspaceGuidance,
        // The rest of a message with several parts in it, offered on every
        // page until the person continues or leaves it undone on the record.
        assistantQueue: (() => { try { return require('../assistant/turns').queued(req); } catch { return null; } })(),
        currentHref: (() => { try { return `${req.path}${req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''}`; } catch { return '/'; } })(),
        screenGuide,
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
    // Body parsers and reverse-proxy guards fail before a domain service can
    // construct a DomainError. Their explicit 4xx status still means the
    // request was refused safely; reporting it as our 500 and raising an
    // incident hides the useful upload message and creates a false alarm.
    const declaredStatus = Number(err && err.status);
    const safeDeclaredStatus = Number.isInteger(declaredStatus) && declaredStatus >= 400 && declaredStatus < 500
      ? declaredStatus : null;
    const status = err instanceof DomainError ? err.status : safeDeclaredStatus || 500;
    const expected = err instanceof DomainError || Boolean(safeDeclaredStatus);
    if (!expected) {
      console.error('[foundry] unexpected error', err);
      // Record and enqueue external delivery without including request bodies,
      // cookies, tokens or stack traces in the alert payload.
      try {
        require('../operations/monitoring').raise(req.db, {
          severity: 'ERROR',
          kind: 'http.unexpected_error',
          title: 'StockChief returned an unexpected server error',
          detail: `${req.method} ${req.path} · ${err && err.code ? err.code : err && err.name ? err.name : 'Error'}`,
          fingerprint: `http.unexpected_error:${req.method}:${req.route && req.route.path || req.path}:${err && err.code || err && err.name || 'Error'}`,
        });
      } catch (monitoringError) {
        console.error('[foundry] could not record operational alert', monitoringError);
      }
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

module.exports = { clearPendingWork, PENDING_KEYS,
  rateLimit,
  flash,
  csrf,
  loadUser,
  foundryContext,
  requireConfigured,
  requireAuth,
  requireAccount,
  requireOwner,
  requirePermission,
  pageRenderer,
  asyncRoute,
  errorHandler,
};

'use strict';

const express = require('express');
const authService = require('../../domain/auth-service');
const locationService = require('../../domain/location-service');
const { inTransaction } = require('../../db');
const connections = require('../../connections/service');
const catalogImport = require('../../connections/catalog-import');
const ingestion = require('../../connections/event-ingestion');
const providerService = require('../../connections/provider-service');
const accountingSync = require('../../accounting/integration-sync');
const mailboxInventory = require('../../connections/mailbox-inventory');
const documentRestorations = require('../../manager/document-restorations');
const shopifyBootstrap = require('../../connections/shopify-bootstrap');
const providers = require('../../connections/providers/registry');
const supplierService = require('../../purchasing/supplier-service');
const repo = require('../../domain/repository');
const { ValidationError } = require('../../domain/errors');
const { requireAuth, requireOwner, asyncRoute } = require('../middleware');
const publicApi = require('../../connections/public-api');
const outboundWebhooks = require('../../connections/outbound-webhooks');

const router = express.Router();

/*
 * Stripe can return to a different registered local hostname than the one the
 * owner used to open StockChief (`127.0.0.1` versus `localhost`). Browser cookies
 * cannot cross that boundary. The OAuth return is still authenticated by its
 * random, single-use, fifteen-minute state; let that one endpoint reach the
 * state verifier without first demanding an unrelated browser cookie.
 */
function isStripeStateReturn(req) {
  const path = String(req.originalUrl || '').split('?')[0];
  return req.method === 'GET'
    && path === '/settings/connections/payments/return'
    && typeof req.query.state === 'string' && req.query.state.length > 0;
}

const OAUTH_CALLBACK_PROVIDERS = new Set([
  'shopify', 'square', 'clover', 'gmail', 'microsoft365', 'quickbooks', 'xero',
]);

function isProviderStateReturn(req) {
  if (req.method !== 'GET' || typeof req.query.state !== 'string' || !req.query.state) return false;
  const path = String(req.originalUrl || '').split('?')[0];
  const match = path.match(/^\/settings\/connections\/([^/]+)\/callback$/);
  return Boolean(match && OAUTH_CALLBACK_PROVIDERS.has(match[1]));
}

router.use('/settings/connections', (req, res, next) => (
  (isStripeStateReturn(req) || isProviderStateReturn(req)) ? next() : requireAuth(req, res, next)
));

function oauthReturnPage(res, input) {
  const returnOrigin = String(input.returnOrigin || '').replace(/\/$/, '');
  const connectionId = input.connection?.id || null;
  const returnPath = connectionId
    ? `/settings/connections/${encodeURIComponent(connectionId)}`
    : '/settings/connections';
  return res.status(input.connected ? 200 : 400).page('connections/oauth-return', {
    title: `${input.providerName || 'Connection'} · StockChief`,
    layout: false,
    outcome: {
      connected: Boolean(input.connected),
      providerName: input.providerName || 'Connection',
      message: input.message,
      workspaceId: input.connection?.workspace_id || null,
      returnUrl: `${returnOrigin}${returnPath}`,
      returnOrigin: returnOrigin || null,
      returnPath,
    },
  });
}

function existingShopifyConnector(db, workspaceId, shop) {
  const normalizedShop = String(shop || '').trim().toLowerCase();
  return connections.list(db, workspaceId)
    .filter((connection) => connection.provider_type === 'shopify'
      && String(connection.config.shop || '').toLowerCase() === normalizedShop)
    .sort((left, right) => {
      const leftMapped = Number(left.productsMapped || 0) + Number(left.locationsMapped || 0);
      const rightMapped = Number(right.productsMapped || 0) + Number(right.locationsMapped || 0);
      if (leftMapped !== rightMapped) return rightMapped - leftMapped;
      const leftBootstrapped = left.config.catalogBootstrap ? 1 : 0;
      const rightBootstrapped = right.config.catalogBootstrap ? 1 : 0;
      if (leftBootstrapped !== rightBootstrapped) return rightBootstrapped - leftBootstrapped;
      return String(left.created_at || '').localeCompare(String(right.created_at || ''));
    })[0] || null;
}

function configuredPublicOrigin() {
  if (!process.env.FOUNDRY_PUBLIC_URL) return '';
  try {
    return new URL(process.env.FOUNDRY_PUBLIC_URL).origin;
  } catch (_) {
    return '';
  }
}

function stripeConnectOrigin(req) {
  const requested = `${req.protocol}://${req.get('host')}`;
  if (process.env.STRIPE_CONNECT_REDIRECT_ORIGIN) {
    try {
      return new URL(process.env.STRIPE_CONNECT_REDIRECT_ORIGIN).origin;
    } catch (_) {
      // Fall through to the safe environment-specific default below.
    }
  }
  // Stripe explicitly permits localhost callbacks for a Sandbox client ID.
  // Keeping development on the origin already open in the browser removes a
  // tunnel from the interactive sign-in path. Production still returns only
  // through StockChief's configured public HTTPS origin.
  if ((process.env.NODE_ENV || 'development') !== 'production') return requested;
  return configuredPublicOrigin() || requested;
}

function mailboxStateSignature(db, workspaceId, connectorId) {
  const connection = db.prepare(`SELECT status, paused_at, last_error FROM workspace_connectors
    WHERE workspace_id = ? AND id = ?`).get(workspaceId, connectorId);
  const messages = db.prepare(`SELECT COUNT(*) AS total, COALESCE(MAX(rowid), 0) AS last,
      COALESCE(MAX(processed_at), '') AS processed,
      SUM(CASE WHEN processing_status = 'AWAITING_INVENTORY_REVIEW' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN processing_status = 'DUPLICATE_IGNORED' THEN 1 ELSE 0 END) AS duplicates
    FROM connection_email_messages WHERE workspace_id = ? AND connector_id = ?`)
    .get(workspaceId, connectorId);
  const issues = db.prepare(`SELECT COUNT(*) AS total, COALESCE(MAX(updated_at), '') AS updated
    FROM connection_issues WHERE workspace_id = ? AND connector_id = ? AND status = 'OPEN'`)
    .get(workspaceId, connectorId);
  return JSON.stringify({ connection, messages, issues });
}

router.get('/settings/connections', (req, res, next) => {
  // With Shopify's legacy install flow, the Dev Dashboard opens the configured
  // app URL with the shop in the query string. Continue that launch into the
  // authorization-code grant; merely rendering this page leaves the app in a
  // misleading "current install" state without an access token.
  if (req.query.shop) return requireOwner(req, res, next);
  return next();
}, asyncRoute(async (req, res) => {
  if (req.query.shop) {
    const existing = existingShopifyConnector(req.db, req.ctx.workspaceId, req.query.shop);
    const started = await providerService.beginAuthorization(req.db, req.ctx, {
      providerType: 'shopify',
      shop: req.query.shop,
      displayName: 'Shopify',
      connectorId: existing?.id,
      forceOAuth: true,
    }, `${req.protocol}://${req.get('host')}`);
    return res.redirect(303, started.redirectUrl);
  }
  const rows = connections.refreshHealth(req.db, req.ctx.workspaceId);
  const token = req.session.newConnectionToken || null;
  delete req.session.newConnectionToken;
  const apiToken = req.session.newPublicApiToken || null;
  const webhookSecret = req.session.newWebhookSecret || null;
  delete req.session.newPublicApiToken;
  delete req.session.newWebhookSecret;
  const requestOrigin = `${req.protocol}://${req.get('host')}`;
  res.page('connections/index', { title: 'Connections', nav: 'connections', connections: rows,
    room: true, backTo: { href: '/settings', label: 'Settings' },
    // Whose Stripe account this inventory takes money into. Shown here rather
    // than on Money, because it is a connection and not an accounting figure.
    paymentAccount: require('../../payments/accounts').describe(req.db, req.ctx.workspaceId),
    paymentConnect: require('../../payments/connect').describe(req.db, req.ctx.workspaceId),
    shippingAccount: require('../../shipping/accounts').describe(req.db, req.ctx.workspaceId),
    shippingPlatform: require('../../shipping/shipengine-platform').describe(req.db, req.ctx.workspaceId),
    connectionPublicOrigin: configuredPublicOrigin(),
    xeroRedirectOrigin: providerService.authorizationOrigin('xero', requestOrigin),
    paymentReturnOrigin: stripeConnectOrigin(req),
    currentWorkspaceId: req.ctx.workspaceId,
    workspaceName: req.workspace ? req.workspace.name : '',
    paymentWebhookUrl: `${process.env.FOUNDRY_PUBLIC_URL || ''}/webhooks/payments/stripe/${req.ctx.workspaceId}`,
    providerCatalog: providers.catalog(), newConnectionToken: token, apiToken, webhookSecret,
    apiClients: publicApi.list(req.db, req.ctx.workspaceId),
    outboundWebhooks: outboundWebhooks.list(req.db, req.ctx.workspaceId) });
}));

router.post('/settings/connections/api-clients', requireOwner, asyncRoute(async (req, res) => {
  const created = publicApi.create(req.db, req.ctx, { name: req.body.name, scopes: req.body.scopes });
  req.session.newPublicApiToken = created;
  req.flash('success', 'API client created. Copy its token now; StockChief will not show it again.');
  res.redirect(303, '/settings/connections#developer-api');
}));

router.post('/settings/connections/api-clients/:id/revoke', requireOwner, asyncRoute(async (req, res) => {
  publicApi.revoke(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', 'API client revoked immediately. Its token no longer works.');
  res.redirect(303, '/settings/connections#developer-api');
}));

router.post('/settings/connections/outbound-webhooks', requireOwner, asyncRoute(async (req, res) => {
  const created = outboundWebhooks.create(req.db, req.ctx, req.body);
  req.session.newWebhookSecret = created;
  req.flash('success', 'Signed webhook created. Copy its signing secret now; StockChief will not show it again.');
  res.redirect(303, '/settings/connections#developer-api');
}));

router.post('/settings/connections/outbound-webhooks/:id/revoke', requireOwner, asyncRoute(async (req, res) => {
  outboundWebhooks.revoke(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', 'Outbound webhook revoked. No new events will be queued for it.');
  res.redirect(303, '/settings/connections#developer-api');
}));

/*
 * Connecting this inventory's own Stripe account.
 *
 * Owner only, because it decides whose bank the money arrives in. The key goes
 * straight to the encrypted credential store and is never echoed back.
 */
router.post('/settings/connections/payments', requireOwner, asyncRoute(async (req, res) => {
  const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
  try {
    const account = require('../../payments/accounts').connect(req.db, req.ctx, membership, {
      secretKey: req.body.secretKey, webhookSecret: req.body.webhookSecret,
    });
    req.flash('success', `Connected. This inventory takes money into its own Stripe account`
      + `${account.liveMode ? '' : ', in test mode'}.`);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
  }
  res.redirect(303, '/settings/connections');
}));

/*
 * Give the browser something useful to paint before any Stripe API call.
 *
 * The old form posted into a newly-created popup. That window stayed white
 * while StockChief created/read the connected account and asked Stripe for the
 * next URL. Worse, Stripe's Google login then had to open a popup from inside
 * our popup. A normal top-level tab avoids that nested-window failure and this
 * tiny interstitial makes the wait explicit rather than looking frozen.
 */
router.get('/settings/connections/payments/start', requireOwner, (req, res) => {
  const resume = String(req.query.resume || '') === '1';
  return res.page('connections/payment-start', {
    title: 'Opening Stripe', layout: false,
    postPath: resume
      ? '/settings/connections/payments/refresh'
      : '/settings/connections/payments/connect',
  });
});

/*
 * Connecting without handing over a key.
 *
 * Sends the merchant to Stripe's own page. Installations with legacy Connect
 * OAuth let them select an existing account; current Stripe platforms create
 * or finish a Standard connected account owned by that business. Nothing of
 * theirs is typed into StockChief, and StockChief stores an account id rather
 * than a merchant credential.
 */
router.post('/settings/connections/payments/connect', requireOwner, asyncRoute(async (req, res) => {
  const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
  try {
    const origin = stripeConnectOrigin(req);
    const grant = require('../../payments/connect');
    const where = {
      returnUrl: `${origin}/settings/connections/payments/return`,
      refreshUrl: `${origin}/settings/connections/payments/refresh`,
      businessName: req.workspace ? req.workspace.name : undefined,
    };
    const flow = grant.preferredFlow();
    if (!flow) {
      throw new ValidationError('Stripe account setup is not configured on this StockChief installation.');
    }
    const begun = flow === 'oauth'
      ? grant.authorizeUrl(req.db, req.ctx, membership, { ...where, returnUri: where.returnUrl })
      : await grant.openOnboarding(req.db, req.ctx, membership, {
        ...where,
        email: req.account ? req.account.email : undefined,
      });
    return res.redirect(303, begun.url);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
    return res.redirect(303, '/settings/connections');
  }
}));

/*
 * Back from Stripe.
 *
 * A GET because Stripe redirects the browser here, so there is no form and no
 * CSRF token to carry. The state does that job instead: single-use, expiring,
 * and stored hashed — it is what says which inventory this belongs to, and a
 * code arriving without a valid one is not acted on at all.
 */
router.get('/settings/connections/payments/return', (req, res, next) => (
  isStripeStateReturn(req) ? next() : requireOwner(req, res, next)
), asyncRoute(async (req, res) => {
  let outcome = { connected: false, chargesEnabled: false,
    message: 'Stripe did not finish the connection.' };
  try {
    const grant = require('../../payments/connect');
    /*
     * Two roads, one doormat.
     *
     * OAuth comes back carrying a state and a code. Hosted onboarding comes
     * back carrying nothing at all — Stripe simply returns the browser — and
     * says nothing about whether the merchant finished. So that case is
     * settled by asking Stripe about the account rather than by believing the
     * redirect, which is the same rule as everywhere else here.
     */
    const done = req.query && (req.query.state || req.query.code)
      ? await grant.complete(req.db, req.query)
      : { ...await grant.refresh(req.db, req.ctx.workspaceId) };
    const connectedWorkspace = done.workspaceId
      ? req.db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get(done.workspaceId)
      : null;
    if (!done.connected) {
      outcome = { connected: false, chargesEnabled: false, workspaceId: done.workspaceId || null,
        inventoryName: connectedWorkspace ? connectedWorkspace.name : null, message: done.because };
      req.flash('warn', done.because);
    } else if (!done.chargesEnabled) {
      outcome = { connected: true, chargesEnabled: false, workspaceId: done.workspaceId || null,
        inventoryName: connectedWorkspace ? connectedWorkspace.name : null,
        message: `Stripe still needs information before ${done.displayName || 'this account'} can take payments.` };
      req.flash('warn', `Connected to ${done.displayName || 'Stripe'}, but Stripe is not accepting `
        + 'charges on that account yet — it usually wants more details from the business. '
        + 'Payment links will fail until it is satisfied.');
    } else {
      outcome = { connected: true, chargesEnabled: true, workspaceId: done.workspaceId || null,
        inventoryName: connectedWorkspace ? connectedWorkspace.name : null,
        message: `${done.displayName || 'Stripe'} is connected and ready to take payments.` };
      req.flash('success', `Connected. Money from this inventory arrives in `
        + `${done.displayName || 'this business'}'s own Stripe account`
        + `${done.liveMode ? '' : ', in test mode'}. StockChief holds no key for it.`);
      if (req.account) {
        require('../../operations/checkpoints').record(req.db, 'integration.oauth_popup', 'PASS', {
          popupReturned: true, sessionPreserved: true, provider: 'stripe',
          liveMode: Boolean(done.liveMode), workspaceId: done.workspaceId || req.ctx?.workspaceId || null,
          releaseRef: require('../../config').operations.releaseRef,
        });
      }
    }
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    outcome = { connected: false, chargesEnabled: false, message: err.message };
    req.flash('warn', err.message);
  }
  return res.page('connections/payment-return', {
    title: 'Stripe connection', layout: false, outcome,
  });
}));

/*
 * The popup message is a convenience, not the source of truth. Google and
 * Stripe can change popup relationships while authenticating, so the opener
 * also asks StockChief directly whether the grant has landed. This makes the
 * Connections page update without a manual refresh even when a browser drops
 * window.opener somewhere inside the third-party sign-in chain.
 */
router.get('/settings/connections/payments/state', requireOwner, asyncRoute(async (req, res) => {
  const grant = await require('../../payments/connect').refresh(req.db, req.ctx.workspaceId);
  return res.json({ connected: Boolean(grant.connected && !grant.unfinished),
    chargesEnabled: Boolean(grant.chargesEnabled) });
}));

/*
 * A session for Stripe's form, running inside this page.
 *
 * Answers a short-lived client secret and the publishable key, and nothing
 * else. Neither can act on the merchant's account; they only let Stripe's own
 * component render here instead of on a page of its own.
 */
router.post('/settings/connections/payments/session', requireOwner, asyncRoute(async (req, res) => {
  try {
    const made = await require('../../payments/connect').embeddedSession(req.db, req.ctx);
    return res.json({ ok: true, clientSecret: made.clientSecret, publishableKey: made.publishableKey });
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    return res.status(err.status).json({ ok: false, error: err.message });
  }
}));

/*
 * The merchant finished, or closed the form.
 *
 * Stripe's component says only that it is done, never whether the account can
 * take money — so this asks Stripe rather than believing the browser, which is
 * the same rule as every other way back in this file.
 */
router.post('/settings/connections/payments/settled', requireOwner, asyncRoute(async (req, res) => {
  try {
    const state = await require('../../payments/connect').refresh(req.db, req.ctx.workspaceId);
    return res.json({ ok: true, chargesEnabled: Boolean(state.chargesEnabled) });
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    return res.status(err.status).json({ ok: false, error: err.message });
  }
}));

/*
 * Stripe sends the merchant here when an onboarding link has expired.
 *
 * Making them a fresh one and sending them straight back is the entire reason
 * Stripe asks for this address. Showing an error instead would strand somebody
 * who did nothing wrong except take longer than the link lasted.
 */
const refreshStripeOnboarding = asyncRoute(async (req, res) => {
  try {
    const origin = process.env.FOUNDRY_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const again = await require('../../payments/connect').relink(req.db, req.ctx, {
      returnUrl: `${origin}/settings/connections/payments/return`,
      refreshUrl: `${origin}/settings/connections/payments/refresh`,
    });
    return res.redirect(303, again.url);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
    return res.redirect(303, '/settings/connections');
  }
});
router.get('/settings/connections/payments/refresh', requireOwner, refreshStripeOnboarding);
router.post('/settings/connections/payments/refresh', requireOwner, refreshStripeOnboarding);

router.post('/settings/connections/payments/remove', requireOwner, asyncRoute(async (req, res) => {
  const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
  try {
    // Said before the row is gone, because what to say depends on which it was.
    const granted = require('../../payments/connect').rowFor(req.db, req.ctx.workspaceId);
    await require('../../payments/accounts').disconnect(req.db, req.ctx, membership);
    req.flash('success', granted
      ? 'Disconnected, and the grant handed back to Stripe — the account itself, and every payment '
        + 'taken on it, still belongs to this business.'
      : 'Disconnected. StockChief will not make payment links for this inventory; '
        + 'payments reported by hand are recorded exactly as they always were.');
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
  }
  res.redirect(303, '/settings/connections');
}));

router.post('/settings/connections', requireOwner, asyncRoute(async (req, res) => {
  const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
  const created = connections.create(req.db, req.ctx, membership, {
    providerType: req.body.providerType,
    displayName: req.body.displayName,
    expectedIntervalMinutes: req.body.expectedIntervalMinutes,
  });
  req.session.newConnectionToken = { connectorId: created.connection.id, token: created.token };
  req.flash('success', `${created.connection.display_name} is ready. Copy its token now.`);
  res.redirect(303, `/settings/connections/${created.connection.id}`);
}));

router.post('/settings/connections/connect', requireOwner, asyncRoute(async (req, res) => {
  const requestOrigin = `${req.protocol}://${req.get('host')}`;
  let started;
  try {
    started = await providerService.beginAuthorization(req.db, req.ctx, req.body, requestOrigin);
  } catch (error) {
    if (String(req.body.popup || '') === '1' && error.status && error.status < 500) {
      const providerName = providers.get(String(req.body.providerType || '').toLowerCase())?.metadata()?.name
        || 'Connection';
      return oauthReturnPage(res, {
        connected: false,
        providerName,
        message: error.message,
        returnOrigin: requestOrigin,
      });
    }
    throw error;
  }
  if (started.connected) {
    req.flash('success', `${started.connection.display_name} is connected. StockChief discovered its products and locations.`);
    if (String(req.body.popup || '') === '1') {
      return oauthReturnPage(res, {
        connected: true,
        providerName: started.connection.display_name,
        message: `${started.connection.display_name} is connected. StockChief is ready to continue setup.`,
        connection: started.connection,
        returnOrigin: requestOrigin,
      });
    }
    return res.redirect(303, `/settings/connections/${started.connection.id}`);
  }
  res.redirect(303, started.redirectUrl);
}));

router.get('/settings/connections/:provider/callback', asyncRoute(async (req, res) => {
  if (!OAUTH_CALLBACK_PROVIDERS.has(req.params.provider)) return res.status(404).page('error', {
    title: 'Not found', status: 404, message: 'Provider not found.' });
  const context = providerService.callbackContext(req.db, req.query.state, req.params.provider);
  const providerName = context.connection.display_name
    || providers.get(req.params.provider)?.metadata()?.name
    || req.params.provider;
  try {
    const connection = await providerService.completeOAuth(req.db, req.params.provider, req.query,
      `${req.protocol}://${req.get('host')}`);
    if (req.session) req.session.workspaceId = connection.workspace_id;
    const message = ['gmail', 'microsoft365'].includes(req.params.provider)
      ? `${connection.display_name} is connected. Choose the supplier senders StockChief should watch.`
      : ['quickbooks', 'xero'].includes(req.params.provider)
        ? `${connection.display_name} is connected read-only. StockChief verified the company; choose what authority it may have.`
        : `${connection.display_name} is connected. StockChief discovered its products and locations.`;
    if (req.session) req.flash('success', message);
    if (context.popup || context.returnOrigin && context.returnOrigin !== `${req.protocol}://${req.get('host')}`) return oauthReturnPage(res, {
      connected: true, providerName, message, connection, returnOrigin: context.returnOrigin,
    });
    return res.redirect(303, `/settings/connections/${connection.id}`);
  } catch (error) {
    if (!context.popup && (!context.returnOrigin || context.returnOrigin === `${req.protocol}://${req.get('host')}`)) throw error;
    return oauthReturnPage(res, {
      connected: false,
      providerName,
      message: error.message || `${providerName} did not finish the connection.`,
      connection: context.connection,
      returnOrigin: context.returnOrigin,
    });
  }
}));

router.get('/settings/connections/woocommerce/return', requireOwner, asyncRoute(async (req, res) => {
  if (String(req.query.success) !== '1') {
    req.flash('error', 'WooCommerce authorization was not completed.');
    return res.redirect(303, '/settings/connections');
  }
  const connection = providerService.stateConnection(req.db, req.query.state || req.query.user_id, 'woocommerce');
  req.session.workspaceId = connection.workspace_id;
  req.flash('success', 'WooCommerce authorized the connection. StockChief is finishing catalog discovery.');
  return res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.get('/settings/connections/:id', asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const token = req.session.newConnectionToken && req.session.newConnectionToken.connectorId === connection.id
    ? req.session.newConnectionToken.token : null;
  delete req.session.newConnectionToken;
  const issues = req.db.prepare(`SELECT * FROM connection_issues WHERE workspace_id = ? AND connector_id = ?
    ORDER BY CASE status WHEN 'OPEN' THEN 0 ELSE 1 END, updated_at DESC LIMIT 100`)
    .all(req.ctx.workspaceId, connection.id).map((row) => ({ ...row,
      candidates: connections.parseJson(row.candidate_matches, []) }));
  const events = req.db.prepare(`SELECT * FROM connector_feed_events WHERE workspace_id = ? AND connector_id = ?
    ORDER BY received_at DESC, rowid DESC LIMIT 100`).all(req.ctx.workspaceId, connection.id);
  const mappings = req.db.prepare(`SELECT * FROM connection_mappings WHERE workspace_id = ? AND connector_id = ?
    ORDER BY entity_type, external_id COLLATE NOCASE`).all(req.ctx.workspaceId, connection.id);
  const reconciliations = req.db.prepare(`SELECT * FROM connection_reconciliations WHERE workspace_id = ? AND connector_id = ?
    ORDER BY created_at DESC LIMIT 20`).all(req.ctx.workspaceId, connection.id);
  const isMailbox = ['supplier_email', 'gmail', 'microsoft365'].includes(connection.provider_type);
  const messages = isMailbox ? req.db.prepare(`SELECT m.*,
    (SELECT s.name FROM suppliers s WHERE s.id = m.supplier_id) AS supplier_name,
    (SELECT COUNT(*) FROM connection_email_attachments a WHERE a.message_id = m.id) AS attachment_count,
    (SELECT d.status FROM supplier_documents d WHERE d.message_id = m.id ORDER BY d.processed_at DESC LIMIT 1)
      AS supplier_document_status,
    (SELECT d.document_type FROM supplier_documents d WHERE d.message_id = m.id ORDER BY d.processed_at DESC LIMIT 1)
      AS supplier_document_type,
    (SELECT d.facts FROM supplier_documents d WHERE d.message_id = m.id ORDER BY d.processed_at DESC LIMIT 1)
      AS supplier_document_facts,
    (SELECT d.discrepancies FROM supplier_documents d WHERE d.message_id = m.id ORDER BY d.processed_at DESC LIMIT 1)
      AS supplier_document_discrepancies,
    (SELECT d.purchase_order_id FROM supplier_documents d WHERE d.message_id = m.id ORDER BY d.processed_at DESC LIMIT 1)
      AS matched_po_id,
    (SELECT po.po_number FROM supplier_documents d JOIN purchase_orders po ON po.id = d.purchase_order_id
      WHERE d.message_id = m.id ORDER BY d.processed_at DESC LIMIT 1) AS matched_po_number
    ,(SELECT r.status FROM document_restore_reviews r WHERE r.message_id = m.id AND r.workspace_id = m.workspace_id
      ORDER BY r.created_at DESC LIMIT 1) AS restoration_status
    ,(SELECT r.result FROM document_restore_reviews r WHERE r.message_id = m.id AND r.workspace_id = m.workspace_id
      ORDER BY r.created_at DESC LIMIT 1) AS restoration_result
    ,(SELECT so.id FROM sales_orders so WHERE so.source_email_message_id = m.id AND so.workspace_id = m.workspace_id
      LIMIT 1) AS drafted_order_id
    ,(SELECT so.order_number FROM sales_orders so WHERE so.source_email_message_id = m.id AND so.workspace_id = m.workspace_id
      LIMIT 1) AS drafted_order_number
    ,(SELECT so.status FROM sales_orders so WHERE so.source_email_message_id = m.id AND so.workspace_id = m.workspace_id
      LIMIT 1) AS drafted_order_status
    FROM connection_email_messages m WHERE m.workspace_id = ? AND m.connector_id = ?
      AND ${require('../../connections/reply-inbox').KNOWN_COUNTERPARTY}
    ORDER BY received_at DESC LIMIT 50`).all(req.ctx.workspaceId, connection.id).map((row) => ({
      ...row,
      supplierDocumentFacts: connections.parseJson(row.supplier_document_facts, {}),
      supplierDocumentDiscrepancies: connections.parseJson(row.supplier_document_discrepancies, []),
      restorationResult: connections.parseJson(row.restoration_result, {}),
    })) : [];
  const messageAttachments = isMailbox ? req.db.prepare(`SELECT a.*,
      COALESCE(d.id, duplicate.id) AS document_id,
      COALESCE(d.understanding_id, duplicate.understanding_id) AS understanding_id,
      COALESCE(d.status, duplicate.status) AS document_status,
      COALESCE(d.source_name, duplicate.source_name) AS document_source_name,
      COALESCE(d.created_at, duplicate.created_at) AS document_created_at,
      COALESCE(d.applied_at, duplicate.applied_at) AS document_applied_at,
      COALESCE(d.purchase_order_id, duplicate.purchase_order_id) AS document_purchase_order_id,
      COALESCE(d.result, duplicate.result) AS document_result
    FROM connection_email_attachments a
    JOIN connection_email_messages m ON m.id = a.message_id AND m.workspace_id = a.workspace_id
    LEFT JOIN setup_documents d ON d.id = a.setup_document_id AND d.workspace_id = a.workspace_id
    LEFT JOIN setup_documents duplicate ON duplicate.id = (
      SELECT prior.id FROM setup_documents prior
      WHERE prior.workspace_id = a.workspace_id AND prior.content_hash = a.content_hash
        AND prior.status = 'APPLIED' ORDER BY prior.created_at LIMIT 1)
    WHERE a.workspace_id = ? AND m.connector_id = ?
      AND ${require('../../connections/reply-inbox').KNOWN_COUNTERPARTY}
    ORDER BY a.created_at, a.rowid`)
    .all(req.ctx.workspaceId, connection.id).map((row) => ({
      ...row, documentResult: connections.parseJson(row.document_result, {}),
    })) : [];
  const emailRules = isMailbox ? req.db.prepare(`SELECT r.*, s.name AS supplier_name
    FROM connection_email_rules r LEFT JOIN suppliers s ON s.id = r.supplier_id
    WHERE r.workspace_id = ? AND r.connector_id = ? ORDER BY r.sender_pattern COLLATE NOCASE`)
    .all(req.ctx.workspaceId, connection.id) : [];
  const externalRecords = req.db.prepare(`SELECT * FROM connection_external_records
    WHERE workspace_id = ? AND connector_id = ? ORDER BY entity_type, mapping_status DESC, display_name COLLATE NOCASE`)
    .all(req.ctx.workspaceId, connection.id);
  const syncRuns = req.db.prepare(`SELECT * FROM connection_sync_runs WHERE workspace_id = ? AND connector_id = ?
    ORDER BY started_at DESC LIMIT 20`).all(req.ctx.workspaceId, connection.id);
  const bootstrapCounts = req.db.prepare(`SELECT
    (SELECT COUNT(*) FROM items WHERE workspace_id = ?) AS items,
    (SELECT COUNT(*) FROM locations WHERE workspace_id = ?) AS locations,
    (SELECT COUNT(*) FROM movements WHERE workspace_id = ?) AS movements`)
    .get(req.ctx.workspaceId, req.ctx.workspaceId, req.ctx.workspaceId);
  const canBootstrapShopify = connection.provider_type === 'shopify' && !connection.config.catalogBootstrap
    && !bootstrapCounts.items && !bootstrapCounts.locations && !bootstrapCounts.movements;
  const providerAdapter = providers.get(connection.provider_type);
  const provider = providerAdapter?.metadata() || providers.generic;
  const accounting = provider.integrationClass === 'accounting'
    ? accountingSync.state(req.db, req.ctx.workspaceId, connection.id) : null;
  if (accounting && providerAdapter?.listPostingParties) {
    const missingTypes = [...new Set(accounting.pendingEntries.flatMap((entry) => entry.missingParties || [])
      .map((party) => party.partyType))];
    if (missingTypes.length) {
      try {
        const credentials = await providerService.loadProviderCredentials(req.db, connection, providerAdapter);
        accounting.externalParties = {};
        for (const partyType of missingTypes) {
          accounting.externalParties[partyType] = await providerAdapter.listPostingParties({ credentials, partyType });
        }
      } catch (error) {
        accounting.externalPartiesError = error.message;
      }
    }
  }
  const finishedSync = syncRuns.some((run) => run.status === 'COMPLETED');
  const completedEvent = events.some((event) => event.status === 'COMPLETED');
  const matchedHistory = completedEvent && reconciliations.some((row) => row.status === 'MATCHED');
  const hasOpenIssues = issues.some((issue) => issue.status === 'OPEN');
  const testInstruction = connection.provider_type === 'reference_webhook'
    ? 'Send one test event from the business system, then replay that exact event ID. StockChief must show one completed activity, never two.'
    : connection.provider_type === 'shopify'
      ? 'Place one controlled test order, then fulfill or cancel it. StockChief should show each provider event once and keep the exact SKU and location.'
      : ['square', 'clover'].includes(connection.provider_type)
        ? 'Run one sandbox or low-value test sale, then a refund. StockChief should record both once against the selected merchant location.'
        : connection.provider_type === 'woocommerce'
          ? 'Place one controlled test order, then change its state. StockChief should show the resulting order activity once.'
          : 'Send one controlled provider event and confirm StockChief records it once in this workspace.';
  const certification = !isMailbox && !accounting ? {
    connected: Boolean(connection.provider_account_id || connection.credential_ref),
    catalog: Boolean(finishedSync),
    event: Boolean(completedEvent),
    history: Boolean(matchedHistory),
    proven: Boolean(finishedSync && completedEvent && matchedHistory && !hasOpenIssues),
    testInstruction,
  } : null;
  const view = isMailbox ? 'connections/detail-mailbox'
    : connection.provider_type === 'square' && provider.sandboxMode
      ? 'connections/detail-square-sandbox' : 'connections/detail';
  res.page(view, { title: connection.display_name, nav: 'connections', connection, token,
    backTo: { href: '/settings/connections', label: 'Connections' },
    issues, events, mappings, reconciliations, messages, messageAttachments, emailRules, externalRecords, syncRuns, canBootstrapShopify,
    provider, accounting, certification, mailboxSignature: isMailbox
      ? mailboxStateSignature(req.db, req.ctx.workspaceId, connection.id) : null,
    skus: dbSkus(req.db, req.ctx.workspaceId), locations: repo.listLocations(req.db, req.ctx.workspaceId),
    customers: req.db.prepare('SELECT id, name FROM customers WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(req.ctx.workspaceId),
    suppliers: req.db.prepare('SELECT id, name FROM suppliers WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(req.ctx.workspaceId),
    accountingAccounts: accounting ? req.db.prepare(`SELECT id, code, name FROM accounting_accounts
      WHERE workspace_id = ? AND active = 1 ORDER BY code`).all(req.ctx.workspaceId) : [] });
}));

router.post('/settings/connections/:id/accounting-authority', requireOwner, asyncRoute(async (req, res) => {
  accountingSync.chooseAuthority(req.db, req.ctx, req.params.id, req.body);
  req.flash('success', req.body.authority === 'OBSERVE'
    ? 'Read-only authority saved. StockChief cannot post or change the external books.'
    : 'Authority saved. Run the shadow comparison before any posting can be enabled.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/accounting-shadow', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const adapter = providers.get(connection.provider_type);
  if (adapter?.integrationClass !== 'accounting') throw new ValidationError('This is not an accounting connection.');
  const credentials = await providerService.loadProviderCredentials(req.db, connection, adapter);
  const result = await accountingSync.shadow(req.db, req.ctx, connection.id, adapter, credentials, { asOf: req.body.asOf });
  req.flash(result.status === 'MATCHED' ? 'success' : 'warn', result.status === 'MATCHED'
    ? 'Shadow comparison matched exactly. No external record was changed.'
    : `StockChief found ${result.differences.length} difference${result.differences.length === 1 ? '' : 's'} and stopped. Nothing was posted.`);
  res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/accounting-map', requireOwner, asyncRoute(async (req, res) => {
  const result = accountingSync.mapAccount(req.db, req.ctx, req.params.id, req.body);
  req.flash('success', result.sharedReadIdentity
    ? 'Posting mapping saved. The imported account and its opening balance remain unchanged; nothing was posted.'
    : 'Exact posting mapping saved. Nothing has been posted.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/accounting-party-map', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const adapter = providers.get(connection.provider_type);
  if (!adapter?.listPostingParties) throw new ValidationError('This accounting provider does not expose posting parties.');
  const partyType = String(req.body.partyType || '').toLowerCase();
  const credentials = await providerService.loadProviderCredentials(req.db, connection, adapter);
  const choices = await adapter.listPostingParties({ credentials, partyType });
  const external = choices.find((row) => String(row.externalId) === String(req.body.externalId));
  if (!external) throw new ValidationError(`That ${partyType} is not present in the provider's current list.`);
  accountingSync.mapPostingParty(req.db, req.ctx, connection.id, { ...req.body, partyType, external });
  req.flash('success', `Exact ${partyType} posting identity saved. Nothing was posted.`);
  res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/accounting-party-create', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const adapter = providers.get(connection.provider_type);
  if (!adapter?.createPostingParty) throw new ValidationError('This accounting provider cannot create posting parties.');
  const partyType = String(req.body.partyType || '').toLowerCase();
  const party = accountingSync.postingParty(req.db, req.ctx.workspaceId, partyType, req.body.partyId);
  const credentials = await providerService.loadProviderCredentials(req.db, connection, adapter);
  const external = await adapter.createPostingParty({ credentials, partyType, party,
    idempotencyKey: `foundry-${req.ctx.workspaceId}-${partyType}-${party.id}` });
  accountingSync.mapPostingParty(req.db, req.ctx, connection.id, { partyType, partyId: party.id,
    externalId: external.externalId, external, direction: 'WRITE' });
  req.flash('success', `${party.name} was created in ${connection.display_name} and linked for exact posting. No journal was posted.`);
  res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/accounting-import-opening', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const adapter = providers.get(connection.provider_type);
  if (adapter?.integrationClass !== 'accounting') throw new ValidationError('This is not an accounting connection.');
  const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
  const credentials = await providerService.loadProviderCredentials(req.db, connection, adapter);
  const current = accountingSync.policy(req.db, req.ctx.workspaceId, connection.id);
  if (current.requested_authority === 'OBSERVE') {
    accountingSync.chooseAuthority(req.db, req.ctx, connection.id,
      { authority: 'SHADOW', accountingSource: 'EXTERNAL' });
  }
  // Approval always consumes a fresh provider snapshot. The preview may have
  // been open in a browser for minutes; it is evidence, not a write payload.
  await accountingSync.shadow(req.db, req.ctx, connection.id, adapter, credentials,
    { asOf: req.body.asOf || new Date().toISOString().slice(0, 10) });
  const imported = accountingSync.importOpeningBooks(req.db, req.ctx, membership, connection.id);
  const result = await accountingSync.shadow(req.db, req.ctx, connection.id, adapter, credentials,
    { asOf: imported.preview.asOf });
  req.flash(result.status === 'MATCHED' ? 'success' : 'warn', result.status === 'MATCHED'
    ? `${connection.provider_account_name || connection.display_name} is now related to this StockChief inventory. The imported opening books reconcile exactly. Nothing was posted back.`
    : `The opening books were saved in StockChief, but the fresh provider reread found ${result.differences.length} difference${result.differences.length === 1 ? '' : 's'}. Posting remains blocked.`);
  res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/accounting-enable', requireOwner, asyncRoute(async (req, res) => {
  accountingSync.enableWrites(req.db, req.ctx, req.params.id);
  req.flash('success', 'Posting authority is enabled. StockChief remains the source of truth and every external post is idempotent and auditable.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/accounting-post', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const adapter = providers.get(connection.provider_type);
  if (adapter?.integrationClass !== 'accounting') throw new ValidationError('This is not an accounting connection.');
  const credentials = await providerService.loadProviderCredentials(req.db, connection, adapter);
  const entryIds = (Array.isArray(req.body.entryIds) ? req.body.entryIds : [req.body.entryIds]).filter(Boolean);
  if (!entryIds.length) throw new ValidationError('Choose the exact verified entries to post from the preview.');
  const result = await accountingSync.syncPending(req.db, req.ctx, connection.id, adapter, credentials, { entryIds });
  req.flash(result.remaining ? 'warn' : 'success', result.remaining
    ? `${result.posted} verified entr${result.posted === 1 ? 'y was' : 'ies were'} posted; ${result.remaining} stopped before an uncertain mapping.`
    : `${result.posted} verified accounting entr${result.posted === 1 ? 'y was' : 'ies were'} posted. Provider identities were recorded.`);
  res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/accounting-sandbox-proof', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const adapter = providers.get(connection.provider_type);
  const provider = adapter?.metadata?.();
  if (adapter?.integrationClass !== 'accounting' || provider?.environment !== 'sandbox') {
    throw new ValidationError('The automatic $1 proof is available only for a provider sandbox.');
  }
  const proof = accountingSync.createSandboxProof(req.db, req.ctx, connection.id);
  const credentials = await providerService.loadProviderCredentials(req.db, connection, adapter);
  const result = await accountingSync.syncPending(req.db, req.ctx, connection.id, adapter, credentials,
    { entryIds: proof.entries.map((entry) => entry.id) });
  const shadow = await accountingSync.shadow(req.db, req.ctx, connection.id, adapter, credentials,
    { asOf: new Date().toISOString().slice(0, 10) });
  req.flash(shadow.status === 'MATCHED' && result.posted >= 2 ? 'success' : 'warn',
    shadow.status === 'MATCHED' && result.posted >= 2
      ? `$1 was posted to ${connection.provider_account_name || connection.display_name}, reversed, and reread successfully. The books still match exactly.`
      : `The sandbox proof stopped. ${result.posted} entr${result.posted === 1 ? 'y was' : 'ies were'} confirmed by the provider; review the comparison before relying on posting.`);
  res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.get('/settings/connections/:id/state', asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  if (!['supplier_email', 'gmail', 'microsoft365'].includes(connection.provider_type)) {
    return res.status(404).json({ error: 'This connection does not have mailbox state.' });
  }
  return res.json({ signature: mailboxStateSignature(req.db, req.ctx.workspaceId, connection.id) });
}));

router.post('/settings/connections/:id/sync', requireOwner, asyncRoute(async (req, res) => {
  const result = await providerService.sync(req.db, req.ctx.workspaceId, req.params.id, req.ctx.actorId);
  req.flash('success', `Sync complete: ${result.products} product${result.products === 1 ? '' : 's'}, ${result.locations} location${result.locations === 1 ? '' : 's'}; ${result.needsMapping} need your match.`);
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/refresh-mailbox-authorization',requireOwner,asyncRoute(async (req,res) => {
  try {
    const result = await providerService.refreshMailboxAuthorization(req.db,req.ctx.workspaceId,req.params.id);
    req.flash('success',`Mailbox authorization refreshed and verified for ${result.accountName}. No inbox messages were read and nothing was sent.`);
  } catch (error) {
    req.flash('warn','Mailbox authorization could not be refreshed and verified. No messages were read or sent. Retry if the provider is unavailable, or reconnect if access has expired or been revoked.');
  }
  res.redirect(303,`/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/sync-mailbox', requireOwner, asyncRoute(async (req, res) => {
  const result = await providerService.syncMailbox(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', result.messages
    ? `Mailbox checked. StockChief processed ${result.messages} message${result.messages === 1 ? '' : 's'} safely.`
    : 'Mailbox checked. No new supplier messages needed processing.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/mailbox-cadence', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  if (!['gmail', 'microsoft365'].includes(connection.provider_type)) throw new Error('This is not a connected mailbox.');
  const minutes = [1, 5, 10, 15, 30].includes(Number(req.body.minutes)) ? Number(req.body.minutes) : 5;
  const next = { ...connection.config, mailboxCheckMinutes: minutes };
  req.db.prepare(`UPDATE workspace_connectors SET config = ?, expected_interval_minutes = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(JSON.stringify(next), Math.max(15, minutes * 3),
      new Date().toISOString(), req.ctx.workspaceId, connection.id);
  req.flash('success', `StockChief will check this mailbox automatically every ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  res.redirect(303, `/settings/connections/${connection.id}`);
}));

/*
 * Whether StockChief reads mail from people the owner has not approved.
 *
 * On, a stranger's message is captured UNTRUSTED: it can be read and
 * answered, and an order in it becomes a draft. Nothing is extracted from it
 * and no purchasing record comes out of it — that still needs a rule.
 *
 * Off, StockChief sees only approved senders, which is what it used to do. That
 * is the more private setting and it is also why a customer writing for the
 * first time did not exist, so the choice is the owner's and it is here
 * rather than buried in a config file.
 */
router.post('/settings/connections/:id/unknown-senders', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  if (!['gmail', 'microsoft365'].includes(connection.provider_type)) throw new Error('This is not a connected mailbox.');
  const capture = req.body.captureUnknownSenders === 'on';
  const next = { ...connection.config, captureUnknownSenders: capture };
  req.db.prepare(`UPDATE workspace_connectors SET config = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ?`)
    .run(JSON.stringify(next), new Date().toISOString(), req.ctx.workspaceId, connection.id);
  req.flash('success', capture
    ? 'StockChief will read mail from senders you have not approved, and file them as untrusted.'
    : 'StockChief will only read mail from senders you have approved. A new customer writing in will not be seen.');
  res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/email-attachments/:attachmentId/inventory-preview', requireOwner,
  asyncRoute(async (req, res) => {
    const result = await mailboxInventory.prepare(req.db, req.ctx, req.user, req.params.id,
      req.params.attachmentId, { provider: req.app.locals.aiProvider || undefined });
    if (req.body.rememberFuture === '1') {
      const row = mailboxInventory.attachment(req.db, req.ctx.workspaceId, req.params.id, req.params.attachmentId);
      req.db.prepare(`UPDATE connection_email_rules SET document_mode = 'inventory_list'
        WHERE workspace_id = ? AND connector_id = ? AND sender_pattern = ? COLLATE NOCASE`)
        .run(req.ctx.workspaceId, req.params.id, row.sender);
    }
    if (result.alreadyApplied) {
      req.flash('warning', result.duplicate
        ? 'Duplicate ignored: this exact file was already imported. StockChief added no products or quantities.'
        : 'This file was already imported. StockChief added nothing again.');
      return res.redirect(303, `/settings/connections/${req.params.id}`);
    }
    req.flash('success', result.replayed
      ? 'This file is already waiting for review. StockChief did not create another copy.'
      : 'StockChief read the attachment as inventory. Review every match, new item, quantity, cost, and location before approving.');
    return res.redirect(303, `/foundry/proposal/${result.understandingId}`);
  }));

router.post('/settings/connections/:id/email-messages/:messageId/supplier-preview', requireOwner,
  asyncRoute(async (req, res) => {
    const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
    if (!['gmail', 'microsoft365', 'supplier_email'].includes(connection.provider_type)) {
      throw new ValidationError('Supplier-document review belongs to a supplier mailbox.');
    }
    const message = req.db.prepare(`SELECT * FROM connection_email_messages
      WHERE id = ? AND workspace_id = ? AND connector_id = ? AND trust_status = 'TRUSTED'`)
      .get(req.params.messageId, req.ctx.workspaceId, connection.id);
    if (!message) throw new ValidationError('That approved supplier email is no longer available.');
    const supplierEvidence = require('../../purchasing/supplier-evidence');
    const result = await supplierEvidence.interpretAndProcess(req.db, message.id, {
      provider: req.app.locals.aiProvider || undefined,
    });
    const current = req.db.prepare('SELECT processing_status FROM connection_email_messages WHERE id = ?')
      .get(message.id);
    if (!result && current?.processing_status === 'DUPLICATE_IGNORED') {
      req.flash('warning', 'Exact duplicate: this file was already imported earlier. StockChief did not add the same stock twice.');
    } else if (result?.status === 'NEEDS_REVIEW') {
      req.flash('warning', 'StockChief read the purchasing document and needs your decision on the unmatched or changed details.');
    } else {
      req.flash('success', 'StockChief processed the supplier document. Purchasing expectations may be updated; physical inventory was not received.');
    }
    return res.redirect(303, `/settings/connections/${connection.id}${result?.status === 'NEEDS_REVIEW' ? '#needs-you' : `#message-${message.id}`}`);
  }));

router.post('/settings/connections/:id/email-messages/:messageId/save-only', requireOwner,
  asyncRoute(async (req, res) => {
    const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
    const changed = req.db.prepare(`UPDATE connection_email_messages
      SET processing_status = 'SAVED_NO_ACTION', processed_at = ?
      WHERE id = ? AND workspace_id = ? AND connector_id = ? AND trust_status = 'TRUSTED'
        AND processing_status = 'CAPTURED'`)
      .run(new Date().toISOString(), req.params.messageId, req.ctx.workspaceId, connection.id).changes;
    if (!changed) throw new ValidationError('That email no longer needs a choice.');
    req.flash('success', 'Saved the email and attachment in history only. Purchasing and inventory were not changed.');
    return res.redirect(303, `/settings/connections/${connection.id}#message-${req.params.messageId}`);
  }));

router.get('/settings/connections/:id/email-messages/:messageId/restore-import', requireOwner,
  asyncRoute(async (req, res) => {
    const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
    if (!['gmail', 'microsoft365', 'supplier_email'].includes(connection.provider_type)) {
      throw new ValidationError('Import restoration belongs to a connected supplier mailbox.');
    }
    const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
    const review = documentRestorations.prepare(req.db, req.ctx, membership, connection.id, req.params.messageId);
    return res.page('connections/restore-import', {
      title: review.status === 'COMPLETED' ? 'Import restored' : 'Restore the removed import?',
      nav: 'connections', connection, provider: providers.get(connection.provider_type)?.metadata() || providers.generic,
      review,
    });
  }));

router.post('/settings/connections/:id/email-messages/:messageId/restore-import', requireOwner,
  asyncRoute(async (req, res) => {
    const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
    const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
    const review = documentRestorations.prepare(req.db, req.ctx, membership, connection.id, req.params.messageId);
    const completed = documentRestorations.approve(req.db, req.ctx, membership, review.id, req.body.integrityHash);
    req.flash('success', `Restored ${completed.result.productsRestored} products, ${completed.result.variantsRestored} variants, and ${completed.result.unitsRestored} ${completed.result.unitLabel}${completed.result.unitsRestored === 1 ? '' : 's'}. No duplicate products were created.`);
    return res.redirect(303, `/settings/connections/${connection.id}#message-${req.params.messageId}`);
  }));

router.post('/settings/connections/:id/email-messages/:messageId/keep-removed', requireOwner,
  asyncRoute(async (req, res) => {
    const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
    const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
    const review = documentRestorations.prepare(req.db, req.ctx, membership, connection.id, req.params.messageId);
    documentRestorations.decline(req.db, req.ctx.workspaceId, review.id);
    req.flash('success', 'Kept the earlier import removed. This email remains in message history and inventory was not changed.');
    return res.redirect(303, `/settings/connections/${connection.id}#message-${req.params.messageId}`);
  }));

router.post('/settings/connections/:id/bootstrap-shopify', requireOwner, asyncRoute(async (req, res) => {
  const result = await shopifyBootstrap.bootstrap(req.db, req.ctx, req.params.id);
  req.flash('success', result.replayed
    ? 'Shopify’s opening catalogue was already imported; nothing was duplicated.'
    : `Shopify setup complete: ${result.items} products, ${result.skus} variants, ${result.locations} locations, and ${result.openingUnits} opening units.`);
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/reconcile', requireOwner, asyncRoute(async (req, res) => {
  const result = await providerService.reviewHistory(req.db, req.ctx.workspaceId, req.params.id);
  req.flash(result.status === 'MATCHED' ? 'success' : 'warning', result.status === 'MATCHED'
    ? `Provider history matches the ${result.observed} operational records StockChief safely processed.`
    : `History mismatch: provider ${result.expected}, StockChief ${result.observed}. No inventory balance was overwritten.`);
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/square-sandbox-checkout', requireOwner, asyncRoute(async (req, res) => {
  const checkout = await providerService.createSandboxCheckout(req.db, req.ctx.workspaceId, req.params.id, req.body);
  res.redirect(303, checkout.url);
}));

router.post('/settings/connections/:id/locations', requireOwner, asyncRoute(async (req, res) => {
  providerService.setSelectedLocations(req.db, req.ctx.workspaceId, req.params.id, req.body.externalLocationIds || []);
  req.flash('success', 'Locations saved. StockChief will accept activity only for the selected provider locations.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/ignore', requireOwner, asyncRoute(async (req, res) => {
  providerService.ignoreExternal(req.db, req.ctx.workspaceId, req.params.id, req.body.entityType, req.body.externalId);
  req.flash('success', 'That external record will be ignored. It will not change StockChief.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

function dbSkus(db, workspaceId) {
  return db.prepare(`${repo.SKU_SELECT} WHERE s.workspace_id = ? ORDER BY i.name COLLATE NOCASE, s.variant_label COLLATE NOCASE`)
    .all(workspaceId);
}

router.post('/settings/connections/:id/map', requireOwner, asyncRoute(async (req, res) => {
  connections.mapExternal(req.db, req.ctx, req.params.id, req.body);
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const auth = { connectorId: connection.id, workspaceId: req.ctx.workspaceId, actorId: req.ctx.actorId,
    accountId: req.ctx.accountId, providerType: connection.provider_type, displayName: connection.display_name };
  const retried = ingestion.retryPending(req.db, auth);
  const completed = retried.filter((row) => row.accepted).length;
  req.flash('success', completed ? `Mapping saved. StockChief safely completed ${completed} waiting event${completed === 1 ? '' : 's'}.`
    : 'Mapping saved. StockChief will remember it for future events.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/supplier-sku-map', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  if (!['gmail', 'microsoft365', 'supplier_email'].includes(connection.provider_type)) {
    throw new Error('Supplier SKU matches belong to a supplier mailbox.');
  }
  const issue = req.db.prepare(`SELECT * FROM connection_issues
    WHERE id = ? AND workspace_id = ? AND connector_id = ? AND status = 'OPEN'
      AND issue_type = 'SUPPLIER_DOCUMENT_REVIEW'`)
    .get(req.body.issueId, req.ctx.workspaceId, connection.id);
  if (!issue) throw new Error('That supplier-document decision is no longer waiting.');
  const candidates = connections.parseJson(issue.candidate_matches, []);
  const candidate = candidates.find((entry) => entry.kind === 'supplier_sku'
    && entry.supplierSku === req.body.supplierSku);
  if (!candidate?.supplierId) throw new Error('That supplier SKU cannot be matched from this decision.');
  const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
  supplierService.linkItem(req.db, req.ctx, membership, {
    supplierId: candidate.supplierId, skuId: req.body.skuId, supplierSku: candidate.supplierSku,
    purchaseUnit: 'unit', unitsPerPurchaseUnit: 1,
  });
  const now = new Date().toISOString();
  req.db.prepare(`UPDATE connection_issues SET status = 'RESOLVED', resolved_at = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ?`).run(now, now, issue.id, req.ctx.workspaceId);
  req.flash('success', `Matched supplier SKU ${candidate.supplierSku}. Future documents will use this product automatically.`);
  return res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/supplier-document-decision', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  if (!['gmail', 'microsoft365', 'supplier_email'].includes(connection.provider_type)) {
    throw new Error('Supplier-document decisions belong to a supplier mailbox.');
  }
  const result = require('../../purchasing/supplier-evidence').decide(
    req.db, req.ctx, req.body.issueId, req.body.decision
  );
  req.flash('success', result.decision === 'accept'
    ? 'Accepted the supplier changes and updated the purchase order. Inventory was not received.'
    : 'Kept the original purchase order. The supplier document remains in the audit history.');
  return res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/supplier-document-ignore', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  if (!['gmail', 'microsoft365', 'supplier_email'].includes(connection.provider_type)) {
    throw new Error('Supplier-document decisions belong to a supplier mailbox.');
  }
  require('../../purchasing/supplier-evidence').ignoreReview(req.db, req.ctx, req.body.issueId);
  req.flash('success', 'Ignored this document as a purchasing update. The original email remains in message history and inventory was not changed.');
  return res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/create-location-map', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const externalId = String(req.body.externalId || '');
  const external = req.db.prepare(`SELECT * FROM connection_external_records
    WHERE workspace_id = ? AND connector_id = ? AND entity_type = 'location'
      AND external_id = ? COLLATE NOCASE AND mapping_status = 'UNMAPPED'`)
    .get(req.ctx.workspaceId, connection.id, externalId);
  if (!external) throw new Error('That external location no longer needs a match. Refresh the connection and try again.');
  const location = inTransaction(req.db, () => {
    const created = locationService.createLocation(req.db, req.ctx, {
      name: req.body.name,
      kind: req.body.kind,
      note: `Created while connecting ${connection.display_name}`,
    });
    connections.mapExternal(req.db, req.ctx, connection.id, {
      entityType: 'location', externalId: external.external_id, foundryRecordId: created.id,
    });
    return created;
  });
  const auth = { connectorId: connection.id, workspaceId: req.ctx.workspaceId, actorId: req.ctx.actorId,
    accountId: req.ctx.accountId, providerType: connection.provider_type, displayName: connection.display_name };
  const completed = ingestion.retryPending(req.db, auth).filter((row) => row.accepted).length;
  req.flash('success', `Created ${location.name} and matched it to ${external.display_name}. Future activity will use it automatically.${completed ? ` ${completed} waiting event${completed === 1 ? '' : 's'} completed safely.` : ''}`);
  res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/create-product-map', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const result = catalogImport.importProducts(req.db, req.ctx, connection, [req.body.externalId]);
  if (!result.mapped) throw new Error('That external product no longer needs a match. Refresh the connection and try again.');
  const auth = { connectorId: connection.id, workspaceId: req.ctx.workspaceId, actorId: req.ctx.actorId,
    accountId: req.ctx.accountId, providerType: connection.provider_type, displayName: connection.display_name };
  const completed = ingestion.retryPending(req.db, auth).filter((row) => row.accepted).length;
  req.flash('success', `Created ${result.mapped} product variant${result.mapped === 1 ? '' : 's'} from ${connection.display_name}, including ${result.priceCount} price${result.priceCount === 1 ? '' : 's'} and ${result.openingUnits} opening unit${result.openingUnits === 1 ? '' : 's'}. Future activity is mapped automatically.${completed ? ` ${completed} waiting event${completed === 1 ? '' : 's'} completed safely.` : ''}`);
  res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/create-products-map', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const result = catalogImport.importProducts(req.db, req.ctx, connection, req.body.externalIds);
  if (!result.mapped) {
    req.flash('success', 'Those products are already in StockChief. Nothing was added twice.');
    return res.redirect(303, `/settings/connections/${connection.id}`);
  }
  const auth = { connectorId: connection.id, workspaceId: req.ctx.workspaceId, actorId: req.ctx.actorId,
    accountId: req.ctx.accountId, providerType: connection.provider_type, displayName: connection.display_name };
  const completed = ingestion.retryPending(req.db, auth).filter((row) => row.accepted).length;
  req.flash('success', `Added ${result.items} product${result.items === 1 ? '' : 's'} (${result.mapped} variant${result.mapped === 1 ? '' : 's'}) from ${connection.display_name}, including ${result.priceCount} price${result.priceCount === 1 ? '' : 's'} and ${result.openingUnits} opening unit${result.openingUnits === 1 ? '' : 's'}. Future activity is mapped automatically.${completed ? ` ${completed} waiting event${completed === 1 ? '' : 's'} completed safely.` : ''}`);
  return res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/email-rules', requireOwner, asyncRoute(async (req, res) => {
  const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
  const senderPattern = String(req.body.senderPattern || '').trim();
  const supplierChoice = String(req.body.supplierChoice || '').trim();
  let supplierId = String(req.body.supplierId || '').trim() || null;
  const existingRule = senderPattern ? req.db.prepare(`SELECT supplier_id FROM connection_email_rules
    WHERE workspace_id = ? AND connector_id = ? AND sender_pattern = ? COLLATE NOCASE`)
    .get(req.ctx.workspaceId, req.params.id, senderPattern) : null;
  if (!supplierChoice && existingRule?.supplier_id && !supplierId) supplierId = existingRule.supplier_id;

  let supplier;
  if (supplierChoice === 'new') {
    if (supplierId) throw new ValidationError('Choose an existing supplier or create a new one, not both.');
    const supplierName = String(req.body.supplierName || '').trim();
    if (!supplierName) throw new ValidationError('Enter the new supplier name before creating it.');
    const duplicate = req.db.prepare(`SELECT id FROM suppliers
      WHERE workspace_id = ? AND name = ? COLLATE NOCASE`).get(req.ctx.workspaceId, supplierName);
    if (duplicate) {
      throw new ValidationError(`“${supplierName}” already exists. Select it from the existing-supplier list instead.`);
    }
    supplier = supplierService.createSupplier(req.db, req.ctx, membership, {
      name: supplierName,
      email: senderPattern.startsWith('@') ? null : senderPattern,
      watchedConnectorId: req.params.id,
    });
    supplierId = supplier.id;
  } else {
    if (supplierChoice && supplierChoice !== 'existing') {
      throw new ValidationError('Choose an existing supplier or explicitly create a new supplier.');
    }
    if (!supplierId) {
      throw new ValidationError('Choose which existing supplier sends from this address, or explicitly create a new supplier.');
    }
    supplier = supplierService.getSupplier(req.db, req.ctx.workspaceId, supplierId);
  }

  connections.addEmailRule(req.db, req.ctx, req.params.id, {
    senderPattern, supplierId, documentMode: req.body.documentMode,
  });
  supplierService.updateSupplier(req.db, req.ctx, membership, supplierId, {
    watchedConnectorId: req.params.id,
  });
  let found = 0;
  const mailboxConnection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  try {
    // The approved message may already be in the inbox. Looking back after the
    // rule is saved prevents the normal setup order (connect, approve sender)
    // from skipping the very file the owner connected Gmail to retrieve.
    if (['gmail', 'microsoft365'].includes(mailboxConnection.provider_type)) {
      const result = await providerService.syncMailbox(req.db, req.ctx.workspaceId, req.params.id, {
        since: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
      });
      found = result.messages || 0;
    }
  } catch (error) {
    req.flash('error', `The sender rule was saved, but the mailbox check could not finish: ${error.message}`);
  }
  req.flash('success', found
    ? `StockChief is watching ${senderPattern} and checked the mailbox now. Open Home to review what it found.`
    : `StockChief is watching ${senderPattern}. It will check automatically and put any required review on Home.`);
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/email-rules/:ruleId', requireOwner, asyncRoute(async (req, res) => {
  const rule = req.db.prepare(`SELECT * FROM connection_email_rules
    WHERE id = ? AND workspace_id = ? AND connector_id = ?`)
    .get(req.params.ruleId, req.ctx.workspaceId, req.params.id);
  if (!rule) throw new ValidationError('That watched supplier sender no longer exists.');

  const updated = connections.addEmailRule(req.db, req.ctx, req.params.id, {
    senderPattern: rule.sender_pattern,
    supplierId: rule.supplier_id,
    documentMode: req.body.documentMode,
  });

  let processed = 0;
  if (updated.document_mode === 'supplier_documents') {
    const pattern = String(updated.sender_pattern || '').toLowerCase();
    const domainRule = pattern.startsWith('@');
    const rows = req.db.prepare(`SELECT m.id, m.sender FROM connection_email_messages m
      WHERE m.workspace_id = ? AND m.connector_id = ?
        AND NOT EXISTS (SELECT 1 FROM supplier_documents d WHERE d.message_id = m.id)
      ORDER BY m.received_at DESC LIMIT 50`).all(req.ctx.workspaceId, req.params.id)
      .filter((message) => domainRule
        ? String(message.sender || '').toLowerCase().endsWith(pattern)
        : String(message.sender || '').toLowerCase() === pattern);
    const supplierEvidence = require('../../purchasing/supplier-evidence');
    for (const message of rows) {
      req.db.prepare(`UPDATE connection_email_messages SET trust_status = 'TRUSTED', supplier_id = ?
        WHERE id = ? AND workspace_id = ?`).run(updated.supplier_id, message.id, req.ctx.workspaceId);
      try {
        if (await supplierEvidence.interpretAndProcess(req.db, message.id)) processed += 1;
      } catch {
        // The original message remains visible and unchanged. A later manual
        // review can still process it without losing the supplier's evidence.
      }
    }
  }

  req.flash('success', processed
    ? `Updated how StockChief reads this supplier and processed ${processed} saved message${processed === 1 ? '' : 's'}.`
    : 'Updated how StockChief reads this supplier.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/pause', requireOwner, asyncRoute(async (req, res) => {
  connections.pause(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', 'StockChief has stopped trusting new events from this connection.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/resume', requireOwner, asyncRoute(async (req, res) => {
  connections.resume(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', 'StockChief is accepting trusted events from this connection again.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/disconnect', requireOwner, asyncRoute(async (req, res) => {
  connections.disconnect(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', 'Connection disconnected. Its mappings and audit history were kept.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/rotate', requireOwner, asyncRoute(async (req, res) => {
  const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
  const rotated = connections.rotateToken(req.db, req.ctx, membership, req.params.id);
  req.session.newConnectionToken = { connectorId: req.params.id, token: rotated.token };
  req.flash('success', 'Connection token rotated. The old token no longer works.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/checkout-token', requireOwner, asyncRoute(async (req, res) => {
  const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
  const issued = connections.issueCheckoutToken(req.db, req.ctx, membership, req.params.id);
  req.session.newConnectionToken = { connectorId: req.params.id, token: issued.token };
  req.flash('success', 'Checkout key created. Copy it now; StockChief will not show it again.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

module.exports = router;

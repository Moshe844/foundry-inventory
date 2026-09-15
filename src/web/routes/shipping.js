'use strict';

/*
 * Hearing from the carrier, and setting the rules it works under.
 *
 * The webhook is the second route in Foundry a stranger can reach without
 * signing in, and it is treated exactly like the first: the provider's
 * signature over the raw bytes is the whole authentication, so the body must
 * arrive unparsed and this router is mounted before the parsers and before
 * CSRF.
 *
 * Webhooks are how tracking is meant to work. A carrier knows the instant a
 * parcel is scanned; asking it every hour instead means being wrong for up to
 * an hour about every parcel, and asking about thousands that have not moved.
 * The scheduled sweep exists for what webhooks miss — an endpoint that was
 * unreachable, a number typed in by hand — and never as the main way of
 * knowing.
 */

const express = require('express');
const shipping = require('../../shipping');
const permissions = require('../../actions/permissions');
const { requireAuth, requirePermission, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const webhooks = express.Router();
const router = express.Router();

/**
 * Which inventory a carrier's message belongs to.
 *
 * The tracking number decides, because Foundry issued it and knows which
 * shipment it is on. The id in the address is only a fallback for a message
 * that names nothing Foundry recognises — the same reasoning as payments,
 * where an address that named a deleted workspace silently dropped every
 * event for days.
 */
function inventoryForEvent(db, providerName, event, hinted) {
  let read = null;
  try { read = shipping.provider.get(providerName).readEvent(event); } catch { /* unreadable */ }
  const number = read && read.trackingNumber;
  if (number) {
    const owned = db.prepare(`SELECT workspace_id FROM sales_shipments
      WHERE tracking_number = ? ORDER BY created_at DESC LIMIT 1`).get(number);
    if (owned) return owned.workspace_id;
    const returned = db.prepare(`SELECT workspace_id FROM customer_return_labels
      WHERE tracking_number = ? ORDER BY created_at DESC LIMIT 1`).get(number);
    if (returned) return returned.workspace_id;
  }
  if (read && read.providerShipmentId) {
    const owned = db.prepare(`SELECT workspace_id FROM sales_shipments
      WHERE provider_shipment_id LIKE ? ORDER BY created_at DESC LIMIT 1`)
      .get(`%${read.providerShipmentId}%`);
    if (owned) return owned.workspace_id;
  }
  if (!hinted) return null;
  const exists = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(hinted);
  return exists ? hinted : null;
}

webhooks.post('/webhooks/shipping/:provider/:workspaceId?',
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncRoute(async (req, res) => {
    const name = String(req.params.provider || '').toLowerCase();
    if (!shipping.provider.has(name)) return res.status(404).json({ error: 'No such shipping provider.' });

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');

    /*
     * Whose secret verifies this, found before anything is believed.
     *
     * Each workspace connects its own carrier account and sets its own webhook
     * secret, so there is no one secret that verifies every message. The
     * address carries the workspace id — which is why it is registered per
     * merchant — and that names the secret to check against. Falling back to
     * the server's own only for a single-tenant install with no id in the path.
     */
    const named = req.params.workspaceId
      ? shipping.accounts.forWorkspace(req.db, req.params.workspaceId) : null;
    const webhookSecret = (named && named.webhookSecret)
      || process.env[`${name.toUpperCase()}_WEBHOOK_SECRET`];

    let event;
    try {
      event = await shipping.provider.get(name).verifyEvent(raw, req.headers, { webhookSecret });
    } catch (error) {
      // Refused, not failed: a retry would be refused identically.
      return res.status([400, 401, 404].includes(error.status) ? error.status : 400)
        .json({ error: error.message });
    }

    const workspaceId = inventoryForEvent(req.db, name, event, req.params.workspaceId);
    if (!workspaceId) {
      /*
       * 200, for the same reason as payments. A signed message about a parcel
       * Foundry does not have is not a delivery failure, and an error makes
       * the provider retry it for days.
       */
      console.warn('[shipping] a verified event matched no inventory', { provider: name });
      return res.status(200).json({ ok: true, applied: false, outcome: 'No inventory owns that parcel.' });
    }

    try {
      const read = shipping.provider.get(name).readEvent(event);
      const returnLabel = read.trackingNumber ? req.db.prepare(`SELECT id FROM customer_return_labels
        WHERE workspace_id = ? AND tracking_number = ?`).get(workspaceId, read.trackingNumber) : null;
      const result = returnLabel
        ? shipping.returns.receiveEvent(req.db, { workspaceId, actorId: null }, name, event)
        : shipping.tracking.receiveEvent(req.db, { workspaceId, actorId: null }, name, event);
      return res.status(200).json({ ok: true, applied: Boolean(result.applied), outcome: result.outcome });
    } catch (error) {
      // Kept for a retry: this is Foundry failing, not the carrier.
      return res.status(500).json({ error: error.message });
    }
  }));

/* ------------------------------------------------------------------ rules */

router.use('/settings/shipping', requireAuth);

router.get('/settings/shipping', requirePermission(permissions.VIEW, 'view shipping rules'),
  asyncRoute(async (req, res) => {
    // Prefer the real location whose address can actually be prefilled. Seeded
    // and migrated locations can share a timestamp, so "first created" alone
    // was nondeterministic and occasionally selected an unaddressed store over
    // the configured dispatch location.
    const originLocation = req.db.prepare(`SELECT name, address FROM locations
      WHERE workspace_id = ? AND is_active = 1
      ORDER BY CASE WHEN TRIM(COALESCE(address, '')) <> '' THEN 0 ELSE 1 END,
        created_at, rowid LIMIT 1`)
      .get(req.ctx.workspaceId);
    const parsedOrigin = shipping.address.parse(originLocation?.address);
    res.page('shipping/rules', {
      title: 'Shipping rules', nav: 'settings',
      rules: shipping.rules.list(req.db, req.ctx.workspaceId, { activeOnly: false }),
      operationPolicy: shipping.operationPolicy.get(req.db, req.ctx.workspaceId),
      account: shipping.accounts.describe(req.db, req.ctx.workspaceId),
      referral: shipping.referral.describe(req.db, req.ctx.workspaceId),
      shipengine: shipping.shipenginePlatform.describe(req.db, req.ctx.workspaceId),
      openShipEngineSetup: req.query.setup === 'shipengine',
      shipFromAddress: {
        name: originLocation?.name || req.workspace?.name || '',
        company_name: req.workspace?.name || '',
        address_line1: parsedOrigin.line1 || '',
        address_line2: parsedOrigin.line2 || '',
        city_locality: parsedOrigin.city || '',
        state_province: parsedOrigin.state || '',
        postal_code: parsedOrigin.postalCode || '',
        country_code: parsedOrigin.country || 'US',
      },
      workspaceName: req.workspace ? req.workspace.name : '',
      providers: shipping.accounts.PROVIDERS,
      webhookUrl: `${process.env.FOUNDRY_PUBLIC_URL || ''}/webhooks/shipping/`
        + `<provider>/${req.ctx.workspaceId}`,
      carriers: require('../../sales/carriers').list(),
      backTo: { href: '/settings', label: 'Settings' },
    });
  }));

router.post('/settings/shipping', requirePermission(permissions.OPERATE, 'set shipping rules'),
  asyncRoute(async (req, res) => {
    try {
      shipping.rules.save(req.db, req.ctx, {
        id: trimOrNull(req.body.id),
        carrier: trimOrNull(req.body.carrier),
        service: trimOrNull(req.body.service),
        maxCostMinor: req.body.maxCost ? Math.round(Number(req.body.maxCost) * 100) : null,
        requireByPromised: req.body.requireByPromised !== undefined,
        maxDeliveryDays: trimOrNull(req.body.maxDeliveryDays),
      });
      req.flash('success', 'Saved. Foundry will use this when a parcel is ready and it fits.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
    }
    res.redirect(303, '/settings/shipping');
  }));

router.post('/settings/shipping/operation-mode',
  requirePermission(permissions.ADMIN, 'change shipping automation'),
  asyncRoute(async (req, res) => {
    try {
      const saved = shipping.operationPolicy.set(req.db, req.ctx, req.body.mode);
      req.flash('success', saved.mode === 'AUTOMATIC'
        ? 'Shipping is set to Automatic. Foundry will still buy only when the universal operator, label authority, and an exact shipping rule all allow it.'
        : saved.mode === 'RECOMMEND'
          ? 'Shipping is set to Recommend. Foundry compares rates, but you approve every purchase.'
          : 'Shipping is set to Manual. Foundry shows carrier facts and leaves every choice to you.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
    }
    res.redirect(303, '/settings/shipping#handling');
  }));

/*
 * Connecting a workspace's own carrier account.
 *
 * Admin only, because it is the thing that decides who is billed for postage.
 * The key goes straight to the encrypted credential store; nothing about it is
 * kept on the connector row, echoed back to the page, or written to a log.
 */
router.post('/settings/shipping/account', requirePermission(permissions.ADMIN, 'connect a shipping account'),
  asyncRoute(async (req, res) => {
    try {
      await shipping.accounts.verifyInput({
        provider: trimOrNull(req.body.provider), apiKey: req.body.apiKey,
      });
      const account = shipping.accounts.connect(req.db, req.ctx, req.user, {
        provider: trimOrNull(req.body.provider),
        apiKey: req.body.apiKey,
        webhookSecret: req.body.webhookSecret,
      });
      req.flash('success', `Connected. This inventory now ships on its own ${account.provider} account`
        + `${account.testMode ? ', in test mode' : ''}, and its labels are billed to it.`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
    }
    res.redirect(303, '/settings/shipping');
  }));

/*
 * Opening an account from inside Foundry, rather than sending them away.
 *
 * The same destination as the form above — a key this inventory ships on — and
 * the merchant never leaves. Admin only, for the same reason: it decides who
 * gets the bill.
 */
router.post('/settings/shipping/account/open', requirePermission(permissions.ADMIN, 'open a shipping account'),
  asyncRoute(async (req, res) => {
    try {
      const opened = await shipping.referral.enrol(req.db, req.ctx, req.user, {
        name: req.body.name,
        email: req.body.email,
        phone: req.body.phone,
      });
      req.flash('success', `Opened. ${opened.name} now has its own carrier account and its labels are `
        + 'billed to it. Add a payment method and it can buy real ones.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
    }
    res.redirect(303, '/settings/shipping#account');
  }));

/*
 * Start a workspace-owned ShipEngine seller. The platform credential creates
 * the isolated seller; the browser then opens ShipEngine's embedded onboarding
 * for this seller's carrier, warehouse and payment method.
 */
router.post('/settings/shipping/shipengine/start',
  requirePermission(permissions.ADMIN, 'set up shipping'),
  asyncRoute(async (req, res) => {
    try {
      await shipping.shipenginePlatform.enrol(req.db, req.ctx, req.user, {
        companyName: req.workspace?.name,
        ownerName: req.user?.name,
        email: req.user?.email,
        countryCode: trimOrNull(req.body.countryCode) || 'US',
      });
      return res.redirect(303, '/settings/shipping?setup=shipengine#account');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
      return res.redirect(303, '/settings/shipping#account');
    }
  }));

router.get('/settings/shipping/shipengine/token',
  requirePermission(permissions.ADMIN, 'set up shipping'),
  asyncRoute(async (req, res) => {
    try {
      res.type('text/plain').send(shipping.shipenginePlatform.tokenFor(req.db, req.ctx.workspaceId));
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      res.status(err.status).type('text/plain').send(err.message);
    }
  }));

router.post('/settings/shipping/shipengine/complete',
  requirePermission(permissions.ADMIN, 'finish shipping setup'),
  asyncRoute(async (req, res) => {
    try {
      await shipping.shipenginePlatform.completeOnboarding(req.db, req.ctx, req.user);
      return res.json({ ok: true, redirect: '/settings/shipping?connected=shipengine#account' });
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      return res.status(err.status).json({ ok: false, error: err.message });
    }
  }));

/*
 * Collecting a card, without the card passing through Foundry.
 *
 * This answers with a client secret and nothing else. The number is typed into
 * Stripe's own field in the merchant's browser and goes straight to Stripe;
 * what comes back here is a reference that is worthless to anybody who
 * intercepts it. JSON rather than a redirect because the field it feeds is on
 * the page already.
 */
router.post('/settings/shipping/account/billing/start',
  requirePermission(permissions.ADMIN, 'set up shipping billing'),
  asyncRoute(async (req, res) => {
    try {
      const setup = await shipping.referral.beginPaymentSetup(req.db, req.ctx, req.user,
        { kind: trimOrNull(req.body.kind) });
      return res.json({ ok: true, ...setup });
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      return res.status(err.status).json({ ok: false, error: err.message });
    }
  }));

router.post('/settings/shipping/account/billing/confirm',
  requirePermission(permissions.ADMIN, 'set up shipping billing'),
  asyncRoute(async (req, res) => {
    try {
      const state = await shipping.referral.recordPaymentMethod(req.db, req.ctx, req.user, {
        stripeCustomerId: req.body.stripeCustomerId,
        paymentMethodReference: req.body.paymentMethodReference,
      });
      req.flash(state.billingReady ? 'success' : 'warn', state.billingReady
        ? 'Payment method added. This account can buy real labels now, and rates are live rates.'
        : 'Stripe stored the payment method, but EasyPost is not reporting one yet. '
          + 'Foundry will keep checking rather than buy a label it cannot pay for.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
    }
    res.redirect(303, '/settings/shipping#account');
  }));

/*
 * "I added it somewhere else."
 *
 * A merchant may add a card on EasyPost's own page, or on a phone, or finish
 * the form tomorrow. Foundry asks the carrier rather than assuming, because a
 * payment method it was told about is not the same as one that will be billed.
 */
router.post('/settings/shipping/account/billing/recheck',
  requirePermission(permissions.ADMIN, 'set up shipping billing'),
  asyncRoute(async (req, res) => {
    try {
      const state = await shipping.referral.refreshBilling(req.db, req.ctx);
      req.flash(state.billingReady ? 'success' : 'warn', state.billingReady
        ? 'EasyPost has a payment method for this account. It can buy real labels now.'
        : 'EasyPost still has no payment method on this account, so it cannot buy a label yet.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
    }
    res.redirect(303, '/settings/shipping#account');
  }));

router.post('/settings/shipping/account/remove', requirePermission(permissions.ADMIN, 'disconnect a shipping account'),
  asyncRoute(async (req, res) => {
    try {
      // Said before the row is gone, because what to say depends on which
      // kind of account it was.
      const opened = shipping.referral.rowFor(req.db, req.ctx.workspaceId)
        || shipping.shipenginePlatform.rowFor(req.db, req.ctx.workspaceId);
      shipping.accounts.disconnect(req.db, req.ctx, req.user);
      req.flash('success', opened
        ? 'Disconnected. Foundry has forgotten the keys — the shipping account itself, and every '
          + 'label and tracking record on it, still exists and still belongs to this business.'
        : 'Disconnected. Foundry will not get rates or buy labels for this inventory, '
          + 'and parcels handed over by hand are recorded exactly as they always were.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
    }
    res.redirect(303, '/settings/shipping');
  }));

router.post('/settings/shipping/:id/remove', requirePermission(permissions.OPERATE, 'set shipping rules'),
  asyncRoute(async (req, res) => {
    shipping.rules.remove(req.db, req.ctx, req.params.id);
    req.flash('success', 'That rule is off. Foundry will ask about these parcels instead.');
    res.redirect(303, '/settings/shipping');
  }));

module.exports = { router, webhooks, inventoryForEvent };

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
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const webhooks = express.Router();
const router = express.Router();

function requirePermission(permission, what) {
  return (req, res, next) => {
    try { permissions.assertCan(req.user, permission, what); return next(); }
    catch (error) { return next(error); }
  };
}

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
      event = shipping.provider.get(name).verifyEvent(raw, req.headers, { webhookSecret });
    } catch (error) {
      // Refused, not failed: a retry would be refused identically.
      return res.status(400).json({ error: error.message });
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
      const result = shipping.tracking.receiveEvent(req.db, { workspaceId, actorId: null }, name, event);
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
    res.page('shipping/rules', {
      title: 'Shipping rules', nav: 'settings',
      rules: shipping.rules.list(req.db, req.ctx.workspaceId, { activeOnly: false }),
      account: shipping.accounts.describe(req.db, req.ctx.workspaceId),
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

router.post('/settings/shipping/account/remove', requirePermission(permissions.ADMIN, 'disconnect a shipping account'),
  asyncRoute(async (req, res) => {
    try {
      shipping.accounts.disconnect(req.db, req.ctx, req.user);
      req.flash('success', 'Disconnected. Foundry will not get rates or buy labels for this inventory, '
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

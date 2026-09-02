'use strict';

/*
 * Asking a customer to pay, and hearing back.
 *
 * The webhook is the only route in Foundry that a stranger can reach without
 * signing in, so it is the only one that has to prove who is talking before it
 * believes anything. Everything else here is behind the ordinary permissions.
 */

const express = require('express');
const collection = require('../../payments/collection');
const providers = require('../../payments/provider');
const permissions = require('../../actions/permissions');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

/*
 * Two routers, because they need different treatment from the app.
 *
 * The webhook must be mounted before the body parsers and before CSRF: its
 * whole authentication is a signature over the exact bytes that arrived, and a
 * parser rewrites them. Everything else is an ordinary signed-in action and is
 * mounted with the rest.
 */
const webhooks = express.Router();
const router = express.Router();

function requirePermission(permission, what) {
  return (req, res, next) => {
    try { permissions.assertCan(req.user, permission, what); return next(); }
    catch (error) { return next(error); }
  };
}

/*
 * The webhook.
 *
 * No session, no CSRF, and no trust: the provider's signature over the raw body
 * is the whole authentication, so the body has to arrive unparsed. A workspace
 * is named in the path because one Foundry instance serves many, and an event
 * has to land in the right books.
 *
 * It answers 200 to anything it has understood, including events it decided not
 * to act on, because a provider that receives an error retries — and retrying
 * an event Foundry has deliberately ignored achieves nothing but noise.
 */
webhooks.post('/webhooks/payments/:provider/:workspaceId',
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncRoute(async (req, res) => {
    const name = String(req.params.provider || '').toLowerCase();
    if (!providers.has(name)) return res.status(404).json({ error: 'No such payment provider.' });

    const workspace = req.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'No such inventory.' });

    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    let event;
    try {
      event = providers.get(name).verifyEvent(raw, req.headers, {
        webhookSecret: process.env[`${name.toUpperCase()}_WEBHOOK_SECRET`],
      });
    } catch (error) {
      // 400, not 500: the message was refused, and a provider should not retry
      // something Foundry will refuse identically next time.
      return res.status(400).json({ error: error.message });
    }

    const ctx = { workspaceId: workspace.id, actorId: null };
    try {
      const result = collection.receiveEvent(req.db, ctx, name, event);
      return res.status(200).json({ ok: true, applied: Boolean(result.applied), outcome: result.outcome });
    } catch (error) {
      // Kept for a retry: this is Foundry failing, not the provider.
      return res.status(500).json({ error: error.message });
    }
  }));

router.use('/sales/orders/:id/payment-request', requireAuth);

router.post('/sales/orders/:id/payment-request',
  requirePermission(permissions.OPERATE, 'ask customers to pay'),
  asyncRoute(async (req, res) => {
    try {
      if (trimOrNull(req.body.action) === 'void') {
        collection.voidRequest(req.db, req.ctx, trimOrNull(req.body.requestId), 'Cancelled by the owner.');
        req.flash('success', 'That payment link will not be accepted any more.');
      } else {
        const asked = await collection.request(req.db, req.ctx, req.params.id, {
          provider: trimOrNull(req.body.provider) || 'stripe',
          purpose: trimOrNull(req.body.purpose) || 'BALANCE',
        });
        const amount = require('../../sales/payment-terms').money(asked.amountMinor, asked.currency);
        req.flash('success', `Asked for ${amount} — the link is on this order, ready to send.`);
      }
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
    }
    res.redirect(303, `/orders/${req.params.id}#money`);
  }));

module.exports = { webhooks, actions: router };

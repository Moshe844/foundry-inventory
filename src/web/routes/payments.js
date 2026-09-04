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
const { ValidationError } = require('../../domain/errors');

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
/*
 * Which inventory an event belongs to.
 *
 * The address Stripe was given had a workspace id in it, and one Stripe
 * account serves every inventory an owner has. So the id was a guess made
 * once, at setup, about where money would arrive for ever after — and when
 * that inventory was deleted the endpoint went on pointing at it. Stripe
 * delivered every event to a URL naming a workspace that no longer existed,
 * Foundry answered 404, and an order sat saying "unpaid" beside a Stripe
 * account holding a declined charge. Not one event was ever recorded.
 *
 * The invoice already knows. Foundry created it, kept its id, and can look up
 * which inventory it was created for — so that is what decides, and the id in
 * the address is only a fallback for events that name no invoice.
 */
function inventoryForEvent(db, providerName, event, hintedWorkspaceId) {
  let read = null;
  try { read = providers.normalise(providers.get(providerName).readEvent(event)); } catch { /* unreadable */ }
  if (read?.externalInvoiceId) {
    const owned = db.prepare(`SELECT workspace_id FROM payment_requests
      WHERE provider = ? AND external_invoice_id = ?
      ORDER BY created_at DESC LIMIT 1`).get(providerName, read.externalInvoiceId);
    if (owned) return owned.workspace_id;
  }
  const hinted = hintedWorkspaceId
    ? db.prepare('SELECT id FROM workspaces WHERE id = ?').get(hintedWorkspaceId)
    : null;
  return hinted ? hinted.id : null;
}

webhooks.post('/webhooks/payments/:provider/:workspaceId?',
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncRoute(async (req, res) => {
    const name = String(req.params.provider || '').toLowerCase();
    if (!providers.has(name)) return res.status(404).json({ error: 'No such payment provider.' });

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

    const workspaceId = inventoryForEvent(req.db, name, event, req.params.workspaceId);
    if (!workspaceId) {
      /*
       * 200, not 404. A signed event Foundry cannot place is not a delivery
       * failure, and answering an error makes the provider retry it for days.
       * It is said out loud instead, because an event about money that landed
       * nowhere is worth a line in the log.
       */
      console.warn('[payments] a verified event matched no inventory', { provider: name, event: event?.id });
      return res.status(200).json({ ok: true, applied: false, outcome: 'No inventory owns that invoice.' });
    }

    const ctx = { workspaceId, actorId: null };
    try {
      const result = collection.receiveEvent(req.db, ctx, name, event);
      return res.status(200).json({ ok: true, applied: Boolean(result.applied), outcome: result.outcome });
    } catch (error) {
      // Kept for a retry: this is Foundry failing, not the provider.
      return res.status(500).json({ error: error.message });
    }
  }));

router.use('/sales/orders/:id/payment-request', requireAuth);

/*
 * Asking a customer for money, in the three shapes that actually happen.
 *
 *   then=open   the customer is here — make the link and go straight to it,
 *               so the merchant can charge a card with them in front of them.
 *   then=send   they are not here — make the link and email it.
 *   action=email  a link already exists; send it.
 *
 * None of this is tied to a shipment. What is due comes from the customer's
 * terms, so a deposit before anything is picked goes through exactly this.
 */
router.post('/sales/orders/:id/payment-request',
  requirePermission(permissions.OPERATE, 'ask customers to pay'),
  asyncRoute(async (req, res) => {
    const action = trimOrNull(req.body.action);
    const then = trimOrNull(req.body.then);
    let openRequestId = null;
    try {
      if (action === 'void') {
        collection.voidRequest(req.db, req.ctx, trimOrNull(req.body.requestId), 'Cancelled by the owner.');
        req.flash('success', 'That payment link will not be accepted any more.');
      } else if (action === 'email') {
        const sent = await emailTheLink(req, trimOrNull(req.body.requestId));
        req.flash('success', `Sent to ${sent.recipient}. Foundry records the payment itself when it arrives.`);
      } else {
        const asked = await collection.request(req.db, req.ctx, req.params.id, {
          provider: trimOrNull(req.body.provider) || 'stripe',
          purpose: trimOrNull(req.body.purpose) || 'BALANCE',
        });
        const amount = require('../../sales/payment-terms').money(asked.amountMinor, asked.currency);
        if (then === 'send') {
          const sent = await emailTheLink(req, asked.id);
          req.flash('success', `Asked for ${amount} and sent it to ${sent.recipient}. `
            + 'Foundry records the payment itself when it arrives.');
        } else if (then === 'open' && asked.hostedUrl) {
          /*
           * Straight to the page they pay on, because somebody is waiting at
           * the counter — but back to the order first, which opens that page
           * over it. Redirecting the browser to Stripe left the merchant on
           * Stripe, signed out of Foundry, with the customer watching.
           */
          openRequestId = asked.id;
        } else {
          req.flash('success', `Asked for ${amount} — the link is on this order.`);
        }
      }
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
    }
    return res.redirect(303, openRequestId
      ? `/orders/${req.params.id}?pay=${encodeURIComponent(openRequestId)}#money`
      : `/orders/${req.params.id}#money`);
  }));

/**
 * Prepare the message and send it through the watched mailbox.
 *
 * Preparing and sending are separate calls on purpose: the draft is a record
 * that survives a send failing, so a message that could not go out is still
 * sitting there to be looked at rather than lost with the error.
 */
async function emailTheLink(req, requestId) {
  const comms = require('../../sales/customer-communications');
  const draft = comms.preparePaymentLink(req.db, req.ctx, requestId);
  if (!draft.recipient) {
    throw new ValidationError('There is no email address for this customer, so the link cannot be sent. '
      + 'Add one on the customer, or copy the link and send it yourself.');
  }
  await comms.sendThroughMailbox(req.db, req.ctx.workspaceId, draft.id, req.ctx.actorId || null);
  return draft;
}

module.exports = { webhooks, actions: router };

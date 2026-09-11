'use strict';

/*
 * The mailbox, as a place to work rather than a place to configure.
 *
 * Inbound mail was only ever visible inside a connector's settings page, which
 * is where somebody goes to set a connection up — not where they go on a
 * Tuesday morning to see who is waiting on them. These routes give it its own
 * address, with the three drawers as the only navigation.
 */

const express = require('express');
const inbox = require('../../connections/reply-inbox');
const drafting = require('../../connections/reply-drafting');
const setAside = require('../../connections/mail-set-aside');
const providerService = require('../../connections/provider-service');
const permissions = require('../../actions/permissions');
const { requireAuth, requirePermission, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use('/mail', requireAuth);

/*
 * The fourth drawer is not a state a message can be in — it is the mail
 * Foundry never took. It lives here anyway, because the only place somebody
 * looks for an email they cannot find is where the email should have been.
 */
const DRAWERS = [
  { key: 'needs-reply', state: 'NEEDS_REPLY', label: 'Needs a reply' },
  { key: 'waiting', state: 'WAITING', label: 'Waiting on them' },
  { key: 'handled', state: 'HANDLED', label: 'Handled' },
  { key: 'not-foundry', state: 'SET_ASIDE', label: 'Not for Foundry' },
];

router.get('/mail', requirePermission(permissions.VIEW, 'read the mailbox'), asyncRoute(async (req, res) => {
  const drawer = DRAWERS.find((entry) => entry.key === trimOrNull(req.query.show)) || DRAWERS[0];
  const aside = drawer.state === 'SET_ASIDE';
  res.page('mail/inbox', {
    title: 'Mail', nav: 'mail',
    drawers: DRAWERS,
    drawer,
    counts: { ...inbox.counts(req.db, req.ctx.workspaceId),
      SET_ASIDE: setAside.count(req.db, req.ctx.workspaceId) },
    messages: aside ? [] : inbox.list(req.db, req.ctx.workspaceId, drawer.state),
    setAside: aside ? setAside.list(req.db, req.ctx.workspaceId) : [],
  });
}));

/*
 * Overruling the gate. A person saying "this one is ours" is the last word,
 * and Foundry goes back to the provider for the message it chose not to keep.
 */
router.post('/mail/set-aside/:id/bring-in', requirePermission(permissions.OPERATE, 'sort the mailbox'),
  asyncRoute(async (req, res) => {
    try {
      const result = await providerService.bringInSetAside(req.db, req.ctx, req.params.id);
      if (result.messageId) {
        req.flash('success', 'Brought in. Foundry has read it and prepared whatever it could.');
        return res.redirect(303, `/mail/${result.messageId}`);
      }
      req.flash('warn', 'Foundry could not read that message back from the mailbox.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
    }
    return res.redirect(303, '/mail?show=not-foundry');
  }));

/**
 * What Foundry made of this message before anybody opened it.
 *
 * A draft order, or the reason there is not one. Shown on the message itself
 * because "Foundry has already prepared this" is only reassuring next to the
 * email it was prepared from.
 */
function prepared(db, workspaceId, message) {
  const order = db.prepare(`SELECT so.id, so.order_number, so.status, c.name AS customer_name
    FROM sales_orders so JOIN customers c ON c.id = so.customer_id
    WHERE so.workspace_id = ? AND so.source_email_message_id = ?`).get(workspaceId, message.id);
  const reason = db.prepare(`SELECT order_draft_reason FROM connection_email_messages
    WHERE workspace_id = ? AND id = ?`).get(workspaceId, message.id);
  return { order, because: reason ? reason.order_draft_reason : null };
}

router.get('/mail/:id', requirePermission(permissions.VIEW, 'read the mailbox'), asyncRoute(async (req, res) => {
  const message = inbox.get(req.db, req.ctx.workspaceId, req.params.id);
  res.page('mail/message', {
    title: message.subject || 'Message', nav: 'mail',
    message,
    draft: drafting.getDraft(req.db, req.ctx.workspaceId, message.id),
    prepared: prepared(req.db, req.ctx.workspaceId, message),
    attachments: req.db.prepare(`SELECT * FROM connection_email_attachments
      WHERE message_id = ? AND workspace_id = ? ORDER BY filename`)
      .all(message.id, req.ctx.workspaceId),
    // Only the three a message can actually be moved between. "Not for
    // Foundry" is where mail Foundry never took is listed, not a drawer this
    // message could be dragged into.
    drawers: DRAWERS.filter((entry) => entry.state !== 'SET_ASIDE'),
  });
}));

/*
 * Read it as an order again.
 *
 * The sweep only retries messages that have neither an order nor a reason, so
 * a message that failed once keeps its reason forever — which is right while
 * the reason is true, and wrong the day Foundry gets better at reading. This
 * is the owner saying "try that again now", and it clears the old reason so
 * the attempt is a real one rather than a replay of the refusal.
 */
router.post('/mail/:id/reread', requirePermission(permissions.OPERATE, 'read orders from email'),
  asyncRoute(async (req, res) => {
    const orders = require('../../sales/order-from-email');
    try {
      orders.noteReason(req.db, req.ctx, req.params.id, null);
      const result = await orders.draft(req.db, req.ctx, req.params.id);
      if (result.order) req.flash('success', `Foundry read this as ${result.order.orderNumber || 'an order'}. Nothing is confirmed.`);
      else req.flash('warn', result.because || 'Foundry still could not read an order out of this.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
    }
    res.redirect(303, `/mail/${req.params.id}`);
  }));

router.post('/mail/:id/state', requirePermission(permissions.OPERATE, 'sort the mailbox'), asyncRoute(async (req, res) => {
  try {
    if (trimOrNull(req.body.state) === 'RETHINK') {
      inbox.rejudge(req.db, req.ctx, req.params.id);
    } else {
      inbox.setState(req.db, req.ctx, req.params.id, trimOrNull(req.body.state), req.body.reason);
    }
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
  }
  res.redirect(303, trimOrNull(req.body.returnTo) || `/mail/${req.params.id}`);
}));

/*
 * Drafting a reply. Three separate things somebody chose to do, because
 * writing, editing and sending a message to a customer are not one act.
 */

router.post('/mail/:id/draft', requirePermission(permissions.OPERATE, 'write replies'), asyncRoute(async (req, res) => {
  try {
    const action = trimOrNull(req.body.action);
    if (action === 'save') {
      drafting.saveDraft(req.db, req.ctx, req.params.id, { subject: req.body.subject, body: req.body.body });
      req.flash('success', 'Saved. Nothing has been sent.');
    } else if (action === 'send') {
      drafting.saveDraft(req.db, req.ctx, req.params.id, { subject: req.body.subject, body: req.body.body });
      const sent = await drafting.send(req.db, req.ctx, req.params.id);
      req.flash('success', sent ? 'Sent. This is now waiting on them.' : 'Nothing was sent.');
    } else {
      const written = await drafting.draft(req.db, req.ctx, req.params.id);
      req.flash(written.rejected ? 'warn' : 'success', written.rejected
        ? `Foundry wrote a reply and threw it away because ${written.rejected}. What is below is built from your records only.`
        : 'Foundry has written a reply. Nothing is sent until you send it.');
    }
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
  }
  res.redirect(303, `/mail/${req.params.id}`);
}));

module.exports = router;


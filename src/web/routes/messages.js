'use strict';

/**
 * One message, written by the owner, read before it goes.
 *
 * "Please email motty@… that we received the order" is typed into the Tell
 * Foundry box and lands here: the words as they were typed, who they go to,
 * which mailbox they leave from, and a Send button. The shipping notice and
 * the payment link already work this way; this is the same page for a message
 * a person started themselves.
 */

const express = require('express');
const notices = require('../../sales/customer-communications');
const connections = require('../../connections/service');
const permissions = require('../../actions/permissions');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use('/messages', requireAuth);

function requirePermission(permission, what) {
  return (req, res, next) => {
    try { permissions.assertCan(req.user, permission, what); return next(); }
    catch (error) { return next(error); }
  };
}

function mailboxes(req) {
  return connections.list(req.db, req.ctx.workspaceId)
    .filter((row) => ['gmail', 'microsoft365'].includes(row.provider_type));
}

router.get('/messages/:id', requirePermission(permissions.VIEW, 'read messages'), asyncRoute(async (req, res) => {
  const message = notices.get(req.db, req.ctx.workspaceId, req.params.id);
  if (!message) {
    req.flash('error', 'That message is not in this inventory.');
    return res.redirect(303, '/#tell-foundry');
  }
  res.page('messages/detail', {
    title: message.status === 'SENT' ? `Sent to ${message.recipient}` : `Message to ${message.recipient}`,
    nav: 'home',
    message,
    mailboxes: mailboxes(req),
    canSend: permissions.can(req.user, permissions.OPERATE),
  });
}));

router.post('/messages/:id', requirePermission(permissions.OPERATE, 'write to customers'), asyncRoute(async (req, res) => {
  const id = req.params.id;
  const action = trimOrNull(req.body.action);
  const edits = {
    subject: req.body.subject, body: req.body.body,
    recipient: req.body.recipient, connectorId: req.body.connectorId,
  };
  try {
    if (action === 'cancel') {
      notices.cancel(req.db, req.ctx.workspaceId, id, 'Not sent by the owner.');
      req.flash('success', 'That message will not be sent.');
    } else if (action === 'save') {
      notices.updateDraft(req.db, req.ctx.workspaceId, id, edits);
      req.flash('success', 'Saved. Nothing has been sent.');
    } else {
      // Save what is on screen first, so send always sends what was read.
      notices.updateDraft(req.db, req.ctx.workspaceId, id, edits);
      const sent = await notices.sendThroughMailbox(req.db, req.ctx.workspaceId, id, req.ctx.actorId);
      req.flash('success', `Sent to ${sent.recipient}.`);
    }
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
  }
  res.redirect(303, `/messages/${id}`);
}));

module.exports = router;

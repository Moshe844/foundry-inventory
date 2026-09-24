'use strict';

/**
 * One message, written by the owner, read before it goes.
 *
 * "Please email motty@… that we received the order" is typed into the Tell
 * StockChief box and lands here: the words as they were typed, who they go to,
 * which mailbox they leave from, and a Send button. The shipping notice and
 * the payment link already work this way; this is the same page for a message
 * a person started themselves.
 */

const express = require('express');
const notices = require('../../sales/customer-communications');
const connections = require('../../connections/service');
const permissions = require('../../actions/permissions');
const { requireAuth, requirePermission, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use('/messages', requireAuth);

function mailboxes(req) {
  return connections.list(req.db, req.ctx.workspaceId)
    .filter((row) => ['gmail', 'microsoft365'].includes(row.provider_type)
      && row.status === 'connected' && !row.paused_at);
}

router.get('/messages/:id', requirePermission(permissions.VIEW, 'read messages'), asyncRoute(async (req, res) => {
  const message = notices.get(req.db, req.ctx.workspaceId, req.params.id);
  if (!message) {
    req.flash('error', 'That message is not in this inventory.');
    return res.redirect(303, '/#tell-foundry');
  }
  // A draft StockChief wrote carries the facts it was written from.
  let draftFacts = null;
  try {
    const row = req.db.prepare('SELECT facts, facts_used, instruction FROM assistant_draft_facts WHERE message_id = ? AND workspace_id = ?').get(message.id, req.ctx.workspaceId);
    if (row) draftFacts = { facts: JSON.parse(row.facts || '[]'), used: JSON.parse(row.facts_used || '[]'), instruction: row.instruction };
  } catch { draftFacts = null; }
  res.page('messages/detail', {
    title: message.status === 'SENT' ? `Sent to ${message.recipient}` : `Message to ${message.recipient}`,
    nav: 'home',
    message,
    draftFacts,
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

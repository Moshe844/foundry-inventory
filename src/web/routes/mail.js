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
const permissions = require('../../actions/permissions');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use('/mail', requireAuth);

function requirePermission(permission, what) {
  return (req, res, next) => {
    try { permissions.assertCan(req.user, permission, what); return next(); }
    catch (error) { return next(error); }
  };
}

const DRAWERS = [
  { key: 'needs-reply', state: 'NEEDS_REPLY', label: 'Needs a reply' },
  { key: 'waiting', state: 'WAITING', label: 'Waiting on them' },
  { key: 'handled', state: 'HANDLED', label: 'Handled' },
];

router.get('/mail', requirePermission(permissions.VIEW, 'read the mailbox'), asyncRoute(async (req, res) => {
  const drawer = DRAWERS.find((entry) => entry.key === trimOrNull(req.query.show)) || DRAWERS[0];
  res.page('mail/inbox', {
    title: 'Mail', nav: 'mail',
    drawers: DRAWERS,
    drawer,
    counts: inbox.counts(req.db, req.ctx.workspaceId),
    messages: inbox.list(req.db, req.ctx.workspaceId, drawer.state),
  });
}));

router.get('/mail/:id', requirePermission(permissions.VIEW, 'read the mailbox'), asyncRoute(async (req, res) => {
  const message = inbox.get(req.db, req.ctx.workspaceId, req.params.id);
  res.page('mail/message', {
    title: message.subject || 'Message', nav: 'mail',
    message,
    attachments: req.db.prepare(`SELECT * FROM connection_email_attachments
      WHERE message_id = ? AND workspace_id = ? ORDER BY filename`)
      .all(message.id, req.ctx.workspaceId),
    drawers: DRAWERS,
  });
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

module.exports = router;

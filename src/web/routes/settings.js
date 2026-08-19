'use strict';

const express = require('express');
const authService = require('../../domain/auth-service');
const engine = require('../../domain/inventory-engine');
const entitlements = require('../../entitlements/service');
const eventFeed = require('../../connectors/event-feed');
const { requireAuth, requireOwner, asyncRoute } = require('../middleware');

const router = express.Router();
router.use('/settings', requireAuth);

router.get(
  '/settings',
  asyncRoute(async (req, res) => {
    const users = authService.listUsers(req.db, req.ctx.workspaceId);
    const integrity = engine.verifyIntegrity(req.db, req.ctx.workspaceId);
    const newFeedToken = req.session.newFeedToken || null;
    delete req.session.newFeedToken;
    res.page('settings', {
      title: 'Settings',
      nav: 'settings',
      users,
      integrity,
      eventFeed: eventFeed.state(req.db, req.ctx.workspaceId),
      newFeedToken,
      workspace: res.locals.workspace,
      // Where this account stands against its plan. Billing will change what
      // the numbers are; nothing on this page needs to know that happened.
      entitlements: entitlements.summarise(req.db, {
        accountId: req.ctx.accountId,
        workspaceId: req.ctx.workspaceId,
      }),
    });
  })
);

router.post(
  '/settings/event-feed/enable',
  requireOwner,
  asyncRoute(async (req, res) => {
    const enabled = eventFeed.enable(req.db, req.ctx, req.user);
    req.session.newFeedToken = enabled.token;
    req.flash('success', 'The live operating feed is connected. Copy the token now; Foundry will not show it again.');
    res.redirect(303, '/settings#live-event-feed');
  })
);

router.post(
  '/settings/event-feed/disconnect',
  requireOwner,
  asyncRoute(async (req, res) => {
    eventFeed.disconnect(req.db, req.ctx);
    req.flash('success', 'The live operating feed is disconnected and every active feed token was revoked.');
    res.redirect(303, '/settings#live-event-feed');
  })
);

router.post(
  '/settings/workspace',
  requireOwner,
  asyncRoute(async (req, res) => {
    authService.renameWorkspace(req.db, req.ctx, req.user, req.body.name);
    req.flash('success', 'Workspace name updated.');
    res.redirect(303, '/settings');
  })
);

router.post(
  '/settings/people',
  requireOwner,
  asyncRoute(async (req, res) => {
    const member = authService.createTeamMember(req.db, req.ctx, req.user, {
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
      role: req.body.role,
    });
    req.flash('success', `${member.name} can now sign in.`);
    res.redirect(303, '/settings');
  })
);

module.exports = router;

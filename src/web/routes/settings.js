'use strict';

const express = require('express');
const authService = require('../../domain/auth-service');
const engine = require('../../domain/inventory-engine');
const entitlements = require('../../entitlements/service');
const eventFeed = require('../../connectors/event-feed');
const operatingInstructions = require('../../manager/operating-instructions');
const operatingGuards = require('../../domain/operating-guards');
const workspaceExport = require('../../domain/workspace-export');
const config = require('../../config');
const { requireAuth, requireOwner, asyncRoute } = require('../middleware');

const router = express.Router();
router.use('/settings', requireAuth);

router.get('/support', requireAuth, asyncRoute(async (req, res) => res.page('support', {
  title: 'Help and support', nav: null, supportEmail: config.supportEmail,
})));

router.get(
  '/settings',
  asyncRoute(async (req, res) => {
    const users = authService.listUsers(req.db, req.ctx.workspaceId);
    const integrity = engine.verifyIntegrity(req.db, req.ctx.workspaceId);
    const learnedInstructions = operatingInstructions.list(req.db, req.ctx.workspaceId)
      .filter((instruction) => ['APPROVED', 'REMOVED', 'SUPERSEDED'].includes(instruction.status));
    const activeInstructionByRecordId = new Map();
    for (const instruction of learnedInstructions) {
      if (instruction.status !== 'APPROVED') continue;
      for (const record of instruction.appliedRecords) {
        if (record.id) activeInstructionByRecordId.set(record.id, instruction.id);
      }
    }
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
      learnedInstructions,
      stockGuards: operatingGuards.list(req.db, req.ctx.workspaceId, { activeOnly: true })
        .map((guard) => ({
          ...guard,
          boundary: operatingGuards.describeBoundary(guard),
          instructionId: activeInstructionByRecordId.get(guard.id) || null,
        })),
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

router.get('/settings/export', requireOwner, asyncRoute(async (req, res) => {
  const payload = workspaceExport.build(req.db, req.ctx.workspaceId);
  const safeName = String(req.workspace.name || 'keeper-workspace')
    .replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'keeper-workspace';
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${safeName}-${new Date().toISOString().slice(0, 10)}.json"`);
  return res.send(`${JSON.stringify(payload, null, 2)}\n`);
}));

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

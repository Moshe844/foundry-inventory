'use strict';

/**
 * Choosing, creating and switching between inventories.
 *
 * Everything here works at the account level, above any one workspace, so these
 * are the only routes mounted with `requireAccount` rather than `requireAuth`.
 * A workspace id arriving from a form is never trusted: it is resolved through
 * the membership check, so an id belonging to someone else is simply not found.
 */

const express = require('express');
const workspaceService = require('../../domain/workspace-service');
const workspaceDeletion = require('../../domain/workspace-deletion');
const entitlements = require('../../entitlements/service');
const { requireAccount, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use('/inventories', requireAccount);

function safeNext(value) {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

/** The list of inventories: the home above the console. */
router.get(
  '/inventories',
  asyncRoute(async (req, res) => {
    const workspaces = workspaceService.listForAccount(req.db, req.account.id);
    res.page('workspaces/list', {
      title: 'Your inventories',
      nav: 'inventories',
      workspaces,
      currentWorkspaceId: req.ctx ? req.ctx.workspaceId : null,
      allowance: entitlements.usage(req.db, { accountId: req.account.id }, 'workspaces'),
      error: null,
      form: {},
    });
  })
);

router.get(
  '/inventories/new',
  asyncRoute(async (req, res) => {
    res.page('workspaces/new', {
      title: 'New inventory',
      nav: 'inventories',
      allowance: entitlements.usage(req.db, { accountId: req.account.id }, 'workspaces'),
      error: null,
      form: {},
    });
  })
);

/**
 * Creating an inventory switches to it and hands straight to Foundry, so the
 * second inventory is set up exactly the way the first one was.
 */
router.post(
  '/inventories',
  asyncRoute(async (req, res) => {
    const name = trimOrNull(req.body.name) || '';
    let created;
    try {
      created = workspaceService.createWorkspace(req.db, req.account.id, name);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      return res.status(err.status).page('workspaces/new', {
        title: 'New inventory',
        nav: 'inventories',
        allowance: entitlements.usage(req.db, { accountId: req.account.id }, 'workspaces'),
        error: err.message,
        form: req.body,
      });
    }

    req.session.workspaceId = created.workspaceId;
    req.flash('success', `${created.name} is ready. Tell Foundry how you manage it today.`);
    return req.session.save(() => res.redirect(303, '/onboarding'));
  })
);

/** Switching is a POST: it changes what every other page will show. */
router.post(
  '/inventories/switch',
  asyncRoute(async (req, res) => {
    const target = trimOrNull(req.body.workspaceId);
    const resolved = workspaceService.resolveForAccount(req.db, req.account.id, target);
    if (!resolved) {
      req.flash('error', 'That inventory could not be found.');
      return res.redirect(303, '/inventories');
    }
    req.session.workspaceId = resolved.workspace.id;
    return req.session.save(() => res.redirect(303, safeNext(req.body.next)));
  })
);

router.post(
  '/inventories/:id/leave',
  asyncRoute(async (req, res) => {
    const resolved = workspaceService.resolveForAccount(req.db, req.account.id, req.params.id);
    if (!resolved) {
      req.flash('error', 'That inventory could not be found.');
      return res.redirect(303, '/inventories');
    }
    try {
      workspaceService.leaveWorkspace(req.db, resolved.workspace.id, req.account.id);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, '/inventories');
    }
    if (req.session.workspaceId === resolved.workspace.id) {
      const next = workspaceService.defaultWorkspaceFor(req.db, req.account.id);
      if (next) req.session.workspaceId = next;
      else delete req.session.workspaceId;
    }
    req.flash('info', `You have left ${resolved.workspace.name}.`);
    return req.session.save(() => res.redirect(303, '/inventories'));
  })
);

/**
 * The confirmation screen.
 *
 * Deliberately its own page rather than a dialog: it shows what is about to be
 * destroyed, counted from the records themselves, and asks the person to type
 * the name. Nobody should be able to delete a business's entire history with
 * one mis-aimed click.
 */
router.get(
  '/inventories/:id/delete',
  asyncRoute(async (req, res) => {
    const resolved = workspaceService.resolveForAccount(req.db, req.account.id, req.params.id);
    if (!resolved) {
      req.flash('error', 'That inventory could not be found.');
      return res.redirect(303, '/inventories');
    }
    if (resolved.membership.role !== 'owner') {
      req.flash('error', 'Only an owner can delete an inventory.');
      return res.redirect(303, '/inventories');
    }

    return res.page('workspaces/delete', {
      title: `Delete ${resolved.workspace.name}`,
      nav: 'inventories',
      workspace: resolved.workspace,
      summary: workspaceDeletion.describe(req.db, resolved.workspace.id),
      isLast: workspaceService.listForAccount(req.db, req.account.id).length === 1,
      error: null,
    });
  })
);

router.post(
  '/inventories/:id/delete',
  asyncRoute(async (req, res) => {
    const resolved = workspaceService.resolveForAccount(req.db, req.account.id, req.params.id);
    if (!resolved) {
      req.flash('error', 'That inventory could not be found.');
      return res.redirect(303, '/inventories');
    }

    // Checked here as well as on the confirmation screen: a non-owner posting
    // straight at this URL should be turned away the same way they would be
    // turned away from the page, not shown the delete screen with an error.
    if (resolved.membership.role !== 'owner') {
      req.flash('error', 'Only an owner can delete an inventory.');
      return res.redirect(303, '/inventories');
    }

    let summary;
    try {
      summary = workspaceDeletion.deleteWorkspace(req.db, req.account.id, resolved.workspace.id, {
        confirmName: req.body.confirmName,
      });
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      // A mistyped name comes back to the same screen with the reason, rather
      // than as a flash on a list where the context has gone.
      return res.status(err.status).page('workspaces/delete', {
        title: `Delete ${resolved.workspace.name}`,
        nav: 'inventories',
        workspace: resolved.workspace,
        summary: workspaceDeletion.describe(req.db, resolved.workspace.id),
        isLast: workspaceService.listForAccount(req.db, req.account.id).length === 1,
        error: err.message,
      });
    }

    if (req.session.workspaceId === resolved.workspace.id) {
      const next = workspaceService.defaultWorkspaceFor(req.db, req.account.id);
      if (next) req.session.workspaceId = next;
      else delete req.session.workspaceId;
    }

    req.flash(
      'info',
      `${summary.name} was deleted, with ${summary.items} product(s), ${summary.movements} movement(s) ` +
        `and everything else it held.`
    );
    return req.session.save(() => res.redirect(303, '/inventories'));
  })
);

module.exports = router;

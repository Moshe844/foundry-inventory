'use strict';

/**
 * The action surface.
 *
 * Every route here authorises on the server before doing anything, and the
 * approve/execute pair is deliberately two requests: a person approves what
 * they were shown, and the execution carries the idempotency key from that
 * approval so a retry cannot become a second movement.
 */

const express = require('express');
const config = require('../../config');
const actionService = require('../../actions/action-service');
const proposals = require('../../actions/proposal-service');
const execution = require('../../actions/execution-service');
const presenter = require('../../actions/presenter');
const permissions = require('../../actions/permissions');
const attention = require('../../attention/attention-engine');
const importPlans = require('../../imports/plan-service');
const { requireAuth, asyncRoute } = require('../middleware');
const repo = require('../../domain/repository');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use('/actions', requireAuth);

function membershipOf(req) {
  return req.user;
}

/** The pending work: what Foundry has proposed and is waiting on. */

/**
 * Example instructions, written with this inventory's own products and places.
 *
 * A new customer reading "Receive 100 Copper Elbows into Main Warehouse" in a
 * business that sells t-shirts learns nothing except that the screen was
 * written for somebody else. Examples are only worth showing when they are
 * things the reader could actually send.
 */
function exampleInstructions(db, workspaceId) {
  const item = db
    .prepare('SELECT name FROM items WHERE workspace_id = ? AND is_active = 1 ORDER BY created_at LIMIT 1')
    .get(workspaceId);
  const places = repo.listLocations(db, workspaceId).map((l) => l.name);
  if (!item || !places.length) return [];

  const here = places[0];
  const examples = [
    `Receive 20 ${item.name} into ${here}`,
    `We sold 3 ${item.name}`,
  ];
  if (places.length > 1) examples.push(`Move 5 ${item.name} from ${here} to ${places[1]}`);
  examples.push(`I counted ${item.name} at ${here}`);
  return examples;
}

router.get(
  '/actions',
  asyncRoute(async (req, res) => {
    // Read once and cleared: a question already answered should not reappear on
    // the next visit to this page.
    const handed = req.session.pendingActionQuestion || null;
    if (handed) delete req.session.pendingActionQuestion;

    const open = proposals.listOpen(req.db, req.ctx.workspaceId, { limit: 25 });
    const recent = req.db
      .prepare(
        `SELECT * FROM action_proposals
          WHERE workspace_id = ? AND status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'INVALIDATED')
          ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 15`
      )
      .all(req.ctx.workspaceId)
      .map(proposals.hydrate);

    res.page('actions/list', {
      title: 'Foundry actions',
      nav: 'actions',
      pending: open.map((p) => presenter.present(req.db, req.ctx.workspaceId, p)),
      recent: recent.map((p) => ({ ...p, oneLine: presenter.oneLine(req.db, req.ctx.workspaceId, p) })),
      canOperate: permissions.can(membershipOf(req), permissions.OPERATE),
      aiConfigured: config.ai.configured,
      // A question raised somewhere else — the Tell Foundry box on the home
      // page — is handed over rather than flashed. A toast disappears and
      // cannot be replied to, which leaves the person holding a question and
      // no way to answer it.
      // A chip fills the box rather than firing an instruction: the customer
      // still reads it and presses Continue themselves.
      instruction: (handed && handed.instruction) || trimOrNull(req.query.q) || '',
      examples: exampleInstructions(req.db, req.ctx.workspaceId),
      question: (handed && handed.question) || null,
      unsupported: (handed && handed.unsupported) || null,
      choices: (handed && handed.choices) || null,
    });
  })
);

/** A written instruction becomes a proposal, a question, or an honest refusal. */
router.post(
  '/actions/ask',
  asyncRoute(async (req, res) => {
    // A file handed to the ask box is data, not an instruction. Refusing it
    // because it arrived at the wrong text box would be Foundry making its own
    // layout the customer's problem, so it goes straight to the import preview
    // — which creates nothing until they approve it, exactly as if they had
    // uploaded it there.
    const attached = (req.files || []).find((entry) => entry.field === 'file' && entry.size > 0);
    if (attached) {
      const { plan } = await importPlans.analyse(req.db, req.ctx, membershipOf(req), {
        buffer: attached.buffer,
        filename: attached.filename,
      });
      req.flash('success', `Foundry read ${attached.filename}. Nothing has been created yet.`);
      return res.redirect(303, `/imports/${plan.id}`);
    }

    // An answer to a question carries the original instruction with it, so the
    // person replies with "3" rather than retyping the whole sentence.
    const original = trimOrNull(req.body.original) || '';
    const answer = trimOrNull(req.body.answer) || '';
    const instruction = answer
      ? `${original}${original ? ' — ' : ''}${answer}`
      : trimOrNull(req.body.instruction) || '';
    let result;
    try {
      result = await actionService.interpret(req.db, req.ctx, membershipOf(req), instruction, {
        provider: req.app.locals.aiProvider || undefined,
      });
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, '/actions');
    }

    if (result.kind === 'proposal') return res.redirect(303, `/actions/${result.proposal.proposalId}`);
    if (result.kind === 'existing') return res.redirect(303, `/actions/${result.proposal.proposalId}`);
    if (result.kind === 'plan') return res.redirect(303, `/actions/plan/${result.plan.planId}`);
    if (result.kind === 'missing_location') {
      req.session.pendingLocationTransfer = {
        locationName: result.locationName,
        instruction: result.instruction,
        line: result.line,
      };
      return res.redirect(303, '/actions/location-required');
    }

    const open = proposals.listOpen(req.db, req.ctx.workspaceId, { limit: 25 });
    return res.page('actions/list', {
      title: 'Foundry actions',
      nav: 'actions',
      pending: open.map((p) => presenter.present(req.db, req.ctx.workspaceId, p)),
      recent: [],
      canOperate: permissions.can(membershipOf(req), permissions.OPERATE),
      aiConfigured: config.ai.configured,
      instruction,
      examples: exampleInstructions(req.db, req.ctx.workspaceId),
      question: result.kind === 'question' ? result.question : null,
      unsupported: result.kind === 'unsupported' ? result.message : null,
      choices: result.choices || null,
    });
  })
);

/**
 * A transfer can name a destination that does not exist yet. That is not a
 * dead-end error and it is not permission to create one silently. This page
 * previews the missing configuration first; approval creates only the
 * location, then prepares the original transfer as a second preview.
 */
router.get(
  '/actions/location-required',
  asyncRoute(async (req, res) => {
    const pending = req.session.pendingLocationTransfer;
    if (!pending || !pending.locationName || !pending.line) {
      req.flash('info', 'There is no transfer waiting for a new location.');
      return res.redirect(303, '/#tell-foundry');
    }

    const locations = req.db
      .prepare('SELECT name FROM locations WHERE workspace_id = ? AND is_active = 1 ORDER BY name')
      .all(req.ctx.workspaceId)
      .map((row) => row.name);
    return res.page('actions/location-required', {
      title: `Create ${pending.locationName}?`,
      nav: 'actions',
      pending,
      locations,
      mayCreate: permissions.can(membershipOf(req), permissions.ADMIN),
      mayTransfer: permissions.can(membershipOf(req), permissions.OPERATE),
    });
  })
);

router.post(
  '/actions/location-required',
  asyncRoute(async (req, res) => {
    const pending = req.session.pendingLocationTransfer;
    if (!pending || !pending.locationName || !pending.line) {
      req.flash('info', 'That transfer setup is no longer waiting.');
      return res.redirect(303, '/#tell-foundry');
    }
    if (req.body.decision !== 'create') {
      delete req.session.pendingLocationTransfer;
      req.flash('info', 'Cancelled. No location was created and no stock moved.');
      return res.redirect(303, '/#tell-foundry');
    }

    try {
      permissions.assertCanPerform(membershipOf(req), 'add_location');
      permissions.assertCanPerform(membershipOf(req), 'transfer');

      const existing = req.db
        .prepare('SELECT id FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND is_active = 1')
        .get(req.ctx.workspaceId, pending.locationName);

      if (!existing) {
        const builtLocation = proposals.build(req.db, req.ctx, {
          actionType: 'add_location',
          destinationLocation: pending.locationName,
          locationKind: /warehouse/i.test(pending.locationName)
            ? 'warehouse'
            : /store|shop/i.test(pending.locationName) ? 'store' : 'other',
          assumptions: [],
        });
        if (!builtLocation.ok) {
          req.flash('info', builtLocation.question || builtLocation.unsupported || 'Foundry could not prepare that location.');
          return res.redirect(303, '/actions/location-required');
        }
        const locationProposal = proposals.persist(req.db, req.ctx, builtLocation.proposal, {
          sourceType: 'USER_REQUEST',
          instruction: `Create ${pending.locationName} so Foundry can continue: ${pending.instruction}`,
        });
        execution.approve(req.db, req.ctx, membershipOf(req), locationProposal.proposalId);
        execution.execute(req.db, req.ctx, membershipOf(req), locationProposal.proposalId, {
          idempotencyKey: `proposal:${locationProposal.proposalId}`,
        });
      }

      const builtTransfer = proposals.build(req.db, req.ctx, pending.line);
      if (!builtTransfer.ok) {
        delete req.session.pendingLocationTransfer;
        req.flash('info', `${pending.locationName} was created, but the transfer still needs attention: ${builtTransfer.question || builtTransfer.unsupported}`);
        return res.redirect(303, '/#tell-foundry');
      }
      const transfer = proposals.persist(req.db, req.ctx, builtTransfer.proposal, {
        sourceType: 'USER_REQUEST',
        instruction: pending.instruction,
      });
      delete req.session.pendingLocationTransfer;
      req.flash('success', `${pending.locationName} is ready. Now review the transfer; no stock has moved yet.`);
      return res.redirect(303, `/actions/${transfer.proposalId}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, '/actions/location-required');
    }
  })
);

/** The preview. Re-reads current truth every time it is shown. */
router.get(
  '/actions/:id',
  asyncRoute(async (req, res) => {
    const proposal = proposals.get(req.db, req.ctx.workspaceId, req.params.id);
    if (!proposal) {
      req.flash('error', 'That action could not be found.');
      return res.redirect(303, '/actions');
    }

    const check = proposals.revalidate(req.db, req.ctx, proposal);
    const executionRow = execution.findExecution(
      req.db,
      req.ctx.workspaceId,
      `proposal:${proposal.proposalId}`
    );
    const done = executionRow ? execution.replay(req.db, req.ctx.workspaceId, executionRow) : null;

    return res.page('actions/detail', {
      title: presenter.oneLine(req.db, req.ctx.workspaceId, proposal),
      nav: 'actions',
      action: presenter.present(req.db, req.ctx.workspaceId, proposal, {
        current: check.current && Object.keys(check.current).length ? check.current : null,
      }),
      check,
      stale: !check.ok,
      outcome: done ? presenter.outcome(req.db, req.ctx.workspaceId, proposal, done) : null,
      execution: done,
      history: proposals.events(req.db, req.ctx.workspaceId, proposal.proposalId),
      mayApprove: permissions.can(membershipOf(req), proposal.requiredPermission),
      permissionLabel: permissions.LABELS[proposal.requiredPermission],
    });
  })
);

/** Approve, then execute. Two steps so approval is auditable on its own. */
router.post(
  '/actions/:id/approve',
  asyncRoute(async (req, res) => {
    try {
      execution.approve(req.db, req.ctx, membershipOf(req), req.params.id);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, `/actions/${req.params.id}`);
    }
    return res.redirect(303, `/actions/${req.params.id}/run`);
  })
);

/**
 * Execution is its own GET-after-POST landing so a browser refresh re-reads the
 * result instead of re-posting it — and even if it did, the idempotency key
 * would return the same outcome rather than moving stock again.
 */
router.get(
  '/actions/:id/run',
  asyncRoute(async (req, res) => {
    const proposal = proposals.get(req.db, req.ctx.workspaceId, req.params.id);
    if (!proposal) {
      req.flash('error', 'That action could not be found.');
      return res.redirect(303, '/actions');
    }

    if (proposal.status === 'APPROVED') {
      try {
        execution.execute(req.db, req.ctx, membershipOf(req), proposal.proposalId, {
          idempotencyKey: `proposal:${proposal.proposalId}`,
        });
      } catch (err) {
        if (!err.status || err.status >= 500) throw err;
        req.flash('error', err.message);
        return res.redirect(303, `/actions/${proposal.proposalId}`);
      }
    }
    return res.redirect(303, `/actions/${proposal.proposalId}`);
  })
);

router.post(
  '/actions/:id/quantity',
  asyncRoute(async (req, res) => {
    let revised;
    try {
      revised = actionService.reviseQuantity(req.db, req.ctx, membershipOf(req), req.params.id, req.body.quantity);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, `/actions/${req.params.id}`);
    }
    req.flash('info', 'Foundry recalculated it. Have a look before approving.');
    return res.redirect(303, `/actions/${revised.proposalId}`);
  })
);

router.post(
  '/actions/:id/cancel',
  asyncRoute(async (req, res) => {
    proposals.cancel(req.db, req.ctx, req.params.id);
    req.flash('info', 'Cancelled. Nothing was changed.');
    return res.redirect(303, '/actions');
  })
);

/** Undo is a new proposal in the opposite direction, never a deletion. */
router.post(
  '/actions/:id/reverse',
  asyncRoute(async (req, res) => {
    let result;
    try {
      result = actionService.proposeCompensation(req.db, req.ctx, membershipOf(req), req.params.id);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, `/actions/${req.params.id}`);
    }
    if (result.kind !== 'proposal') {
      req.flash('info', result.message || result.question);
      return res.redirect(303, `/actions/${req.params.id}`);
    }
    req.flash('info', 'Foundry worked out the reverse. Approve it if that is what you want.');
    return res.redirect(303, `/actions/${result.proposal.proposalId}`);
  })
);

// --- multi-line plans --------------------------------------------------------

router.get(
  '/actions/plan/:planId',
  asyncRoute(async (req, res) => {
    const plan = actionService.getPlan(req.db, req.ctx.workspaceId, req.params.planId);
    if (!plan) {
      req.flash('error', 'That plan could not be found.');
      return res.redirect(303, '/actions');
    }
    const executionRow = execution.findExecution(req.db, req.ctx.workspaceId, `plan:${plan.planId}`);
    return res.page('actions/plan', {
      title: 'Foundry is ready to make several changes',
      nav: 'actions',
      plan,
      lines: plan.lines.map((line) => presenter.present(req.db, req.ctx.workspaceId, line)),
      done: executionRow ? execution.replay(req.db, req.ctx.workspaceId, executionRow) : null,
      mayApprove: plan.lines.every((l) => permissions.can(membershipOf(req), l.requiredPermission)),
    });
  })
);

router.post(
  '/actions/plan/:planId/approve',
  asyncRoute(async (req, res) => {
    try {
      execution.approvePlan(req.db, req.ctx, membershipOf(req), req.params.planId);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, `/actions/plan/${req.params.planId}`);
    }
    return res.redirect(303, `/actions/plan/${req.params.planId}/run`);
  })
);

router.get(
  '/actions/plan/:planId/run',
  asyncRoute(async (req, res) => {
    const plan = actionService.getPlan(req.db, req.ctx.workspaceId, req.params.planId);
    if (!plan) return res.redirect(303, '/actions');
    if (plan.status === 'APPROVED') {
      try {
        execution.executePlan(req.db, req.ctx, membershipOf(req), plan.planId, {
          idempotencyKey: `plan:${plan.planId}`,
        });
      } catch (err) {
        if (!err.status || err.status >= 500) throw err;
        req.flash('error', err.message);
      }
    }
    return res.redirect(303, `/actions/plan/${plan.planId}`);
  })
);

// --- from a Mission 3 finding ------------------------------------------------

router.post(
  '/attention/:id/action',
  requireAuth,
  asyncRoute(async (req, res) => {
    const item = attention.getAttention(req.db, req.ctx.workspaceId, req.params.id);
    if (!item) {
      req.flash('error', 'That item could not be found.');
      return res.redirect(303, '/attention');
    }
    let result;
    try {
      result = actionService.proposeFromAttention(req.db, req.ctx, membershipOf(req), req.params.id);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, `/attention/${req.params.id}`);
    }
    if (result.kind !== 'proposal') {
      req.flash('info', result.message || result.question);
      return res.redirect(303, `/attention/${req.params.id}`);
    }
    return res.redirect(303, `/actions/${result.proposal.proposalId}`);
  })
);

module.exports = router;

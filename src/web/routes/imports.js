'use strict';

/**
 * The import surface.
 *
 * Upload or paste, look at what Foundry made of it, correct anything it got
 * wrong, approve, and watch it run. Approval and execution are two requests for
 * the same reason as in Mission 4: the execution carries an idempotency key
 * derived from the approved plan, so a retried request cannot import twice.
 */

const express = require('express');
const planService = require('../../imports/plan-service');
const executor = require('../../imports/executor');
const verification = require('../../imports/verification');
const presenter = require('../../imports/presenter');
const permissions = require('../../actions/permissions');
const fields = require('../../imports/fields');
const config = require('../../config');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');
const { ValidationError } = require('../../domain/errors');

const router = express.Router();
router.use('/imports', requireAuth);

const ROW_PAGE = 50;

function locationsFor(db, workspaceId) {
  return db
    .prepare('SELECT id, name FROM locations WHERE workspace_id = ? AND is_active = 1 ORDER BY name')
    .all(workspaceId);
}

/** Where an import starts: a file, or something pasted out of a spreadsheet. */
router.get(
  '/imports',
  asyncRoute(async (req, res) => {
    res.page('imports/start', {
      title: 'Bring your data in',
      nav: 'imports',
      recent: planService.listFor(req.db, req.ctx.workspaceId, 10),
      locations: locationsFor(req.db, req.ctx.workspaceId),
      canOperate: permissions.can(req.user, permissions.OPERATE),
      aiConfigured: config.ai.configured,
    });
  })
);

router.post(
  '/imports',
  asyncRoute(async (req, res) => {
    const file = (req.files || []).find((entry) => entry.field === 'file') || null;
    const pasted = trimOrNull(req.body.pasted);
    if (!file && !pasted) {
      req.flash('error', 'Choose a file, or paste your data into the box.');
      return res.redirect('/imports');
    }

    const { plan } = await planService.analyse(req.db, req.ctx, req.user, {
      buffer: file ? file.buffer : null,
      text: file ? undefined : pasted,
      filename: file ? file.filename : null,
      defaultLocationId: trimOrNull(req.body.defaultLocationId),
    });
    return res.redirect(`/imports/${plan.id}`);
  })
);

/** The preview. Everything on it comes from the stored rows. */
router.get(
  '/imports/:id',
  asyncRoute(async (req, res) => {
    const plan = planService.get(req.db, req.ctx.workspaceId, req.params.id);
    const page = Math.max(1, Number(req.query.page) || 1);
    const filter = ['VALID', 'NEEDS_REVIEW', 'INVALID', 'IMPORTED', 'FAILED', 'EXCLUDED'].includes(req.query.rows)
      ? req.query.rows
      : null;

    const rows = planService.rowsFor(req.db, plan.id, {
      status: filter,
      limit: ROW_PAGE,
      offset: (page - 1) * ROW_PAGE,
    });
    const allRows = planService.rowsFor(req.db, plan.id, { limit: 100000 });
    const run = executor.latestExecution(req.db, req.ctx.workspaceId, plan.id);

    res.page('imports/preview', {
      title: `Import ${plan.sourceName}`,
      nav: 'imports',
      plan,
      rows,
      counts: planService.countsFor(req.db, plan.id),
      page,
      pageSize: ROW_PAGE,
      filter,
      mappingRows: presenter.mappingRows(plan),
      summary: presenter.summary(plan),
      preview: presenter.preview(req.db, req.ctx.workspaceId, plan, allRows),
      problems: presenter.problemSummary(allRows),
      fieldOptions: fields.FIELDS,
      locations: locationsFor(req.db, req.ctx.workspaceId),
      progress: run ? executor.progress(req.db, req.ctx.workspaceId, run.id) : null,
      report:
        run && run.status !== 'EXECUTING'
          ? presenter.report(
              plan,
              executor.progress(req.db, req.ctx.workspaceId, run.id),
              verification.latest(req.db, req.ctx.workspaceId, plan.id)
            )
          : null,
      canOperate: permissions.can(req.user, permissions.OPERATE),
    });
  })
);

/** Correcting the mapping, choosing a default location, naming a location. */
router.post(
  '/imports/:id/mapping',
  asyncRoute(async (req, res) => {
    const plan = planService.get(req.db, req.ctx.workspaceId, req.params.id);

    // The form is one row per column, so the same field being chosen twice is
    // something a person can do by accident. The first column wins and the
    // second is dropped rather than silently overwriting it.
    const mappings = {};
    for (const column of plan.sourceColumns) {
      const raw = req.body[`col_${column.index}`];
      const field = Array.isArray(raw) ? raw[0] : raw;
      if (!field || !fields.FIELD_IDS.includes(field)) continue;
      if (mappings[field] !== undefined) continue;
      mappings[field] = column.index;
    }

    const locationMappings = { ...plan.locationMappings };
    for (const [key, value] of Object.entries(req.body)) {
      if (!key.startsWith('location_')) continue;
      const text = key.slice('location_'.length);
      const id = Array.isArray(value) ? value[0] : value;
      if (id) locationMappings[text] = id;
      else delete locationMappings[text];
    }

    planService.revalidate(req.db, req.ctx, req.user, plan.id, {
      mappings,
      locationMappings,
      defaultLocationId: trimOrNull(req.body.defaultLocationId),
    });
    req.flash('success', 'Foundry re-read the file with your corrections.');
    return res.redirect(`/imports/${plan.id}`);
  })
);

router.post(
  '/imports/:id/rows/:rowId/exclude',
  asyncRoute(async (req, res) => {
    planService.excludeRow(
      req.db,
      req.ctx,
      req.user,
      req.params.id,
      req.params.rowId,
      req.body.include !== '1'
    );
    return res.redirect(`/imports/${req.params.id}${req.body.back || ''}`);
  })
);

/** Approve, then run. The run carries the hash of what was approved. */
router.post(
  '/imports/:id/approve',
  asyncRoute(async (req, res) => {
    const plan = planService.approve(req.db, req.ctx, req.user, req.params.id, {
      expectedHash: trimOrNull(req.body.integrityHash),
    });
    return res.redirect(`/imports/${plan.id}?approved=1`);
  })
);

router.post(
  '/imports/:id/run',
  asyncRoute(async (req, res) => {
    const plan = planService.get(req.db, req.ctx.workspaceId, req.params.id);
    if (plan.approvalStatus !== 'APPROVED') {
      throw new ValidationError('Approve the import before running it.');
    }

    // Two submits of the same approved plan carry the same key, so the second
    // one is answered with the first one's result instead of importing again.
    const run = executor.execute(req.db, req.ctx, req.user, plan.id, {
      idempotencyKey: `import:${plan.id}:${plan.integrityHash}`,
    });
    if (!run.replayed && run.status !== 'CANCELLED') {
      verification.verify(req.db, req.ctx.workspaceId, plan.id, run.executionId);
    }
    return res.redirect(`/imports/${plan.id}`);
  })
);

router.post(
  '/imports/:id/resume',
  asyncRoute(async (req, res) => {
    const run = executor.resume(req.db, req.ctx, req.user, req.params.id);
    if (!run.replayed && run.status !== 'CANCELLED') {
      verification.verify(req.db, req.ctx.workspaceId, req.params.id, run.executionId);
    }
    return res.redirect(`/imports/${req.params.id}`);
  })
);

router.post(
  '/imports/:id/cancel',
  asyncRoute(async (req, res) => {
    const run = executor.latestExecution(req.db, req.ctx.workspaceId, req.params.id);
    if (run && run.status === 'EXECUTING') {
      executor.requestCancel(req.db, req.ctx, req.user, run.id);
      req.flash('success', 'Foundry will stop after the product it is working on.');
    } else {
      planService.cancel(req.db, req.ctx, req.user, req.params.id);
      req.flash('success', 'That import was cancelled. Nothing was created.');
    }
    return res.redirect(`/imports/${req.params.id}`);
  })
);

/** Progress, for the page to poll while a large file is running. */
router.get(
  '/imports/:id/progress',
  asyncRoute(async (req, res) => {
    const run = executor.latestExecution(req.db, req.ctx.workspaceId, req.params.id);
    if (!run) return res.json({ status: 'NONE' });
    return res.json(executor.progress(req.db, req.ctx.workspaceId, run.id));
  })
);

module.exports = router;

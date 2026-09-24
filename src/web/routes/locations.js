'use strict';

const express = require('express');
const locationService = require('../../domain/location-service');
const tools = require('../../assistant/tools');
const { requireAuth, requireOwner, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use('/locations', requireAuth);

router.get(
  '/locations',
  asyncRoute(async (req, res) => {
    const locations = locationService.listHierarchy(req.db, req.ctx.workspaceId, { includeInactive: true });
    res.page('locations/list', {
      title: 'Locations',
      nav: 'locations',
      locations,
      editId: req.query.edit || null,
      // A rename said in the Ask box arrives with the new name typed in.
      renameTo: req.query.edit && req.query.name ? String(req.query.name).slice(0, 120) : null,
      resumeInstruction: trimOrNull(req.query.resume) || null,
    });
  })
);

router.post(
  '/locations',
  requireOwner,
  asyncRoute(async (req, res) => {
    const location = locationService.createLocation(req.db, req.ctx, {
      name: req.body.name,
      kind: req.body.kind,
      note: req.body.note,
      address: req.body.address,
      phone: req.body.phone,
      parentLocationId: req.body.parentLocationId,
      barcode: req.body.barcode,
      pickSequence: req.body.pickSequence,
    });
    req.flash('success', `${location.name} is ready to hold stock.`);
    const resumeInstruction = trimOrNull(req.body.resumeInstruction);
    if (resumeInstruction) {
      try {
        const result = await tools.use(req.db, req.ctx, req.user, 'action.prepare', {
          instruction: resumeInstruction,
        }, { provider: req.app.locals.aiProvider || undefined });
        if (['proposal', 'existing'].includes(result.kind) && result.proposal) {
          req.flash('success', `StockChief resumed “${resumeInstruction}”. Review the prepared change below.`);
          return res.redirect(303, `/actions/${result.proposal.proposalId}`);
        }
        if (result.kind === 'plan' && result.plan) {
          req.flash('success', `StockChief resumed “${resumeInstruction}”. Review the prepared changes below.`);
          return res.redirect(303, `/actions/plan/${result.plan.planId}`);
        }
        if (result.kind === 'question' && result.question) {
          req.session.pendingActionQuestion = {
            question: result.question,
            instruction: resumeInstruction,
            choices: result.choices || null,
          };
          return res.redirect(303, '/actions');
        }
        if (result.kind === 'unsupported' && result.message) {
          req.session.pendingActionQuestion = {
            unsupported: result.message,
            where: result.where || null,
            instruction: resumeInstruction,
          };
          return res.redirect(303, '/actions');
        }
      } catch (err) {
        req.flash('warn', `The location was added, but StockChief could not resume the original request: ${err.message}`);
      }
      return res.redirect(303, `/actions?q=${encodeURIComponent(resumeInstruction)}`);
    }
    res.redirect(303, '/locations');
  })
);

router.post(
  '/locations/:id',
  requireOwner,
  asyncRoute(async (req, res) => {
    locationService.updateLocation(req.db, req.ctx, req.params.id, {
      name: req.body.name,
      kind: req.body.kind,
      note: req.body.note,
      address: req.body.address,
      phone: req.body.phone,
      parentLocationId: req.body.parentLocationId,
      barcode: req.body.barcode,
      pickSequence: req.body.pickSequence,
    });
    req.flash('success', 'Location updated.');
    res.redirect(303, '/locations');
  })
);

router.post(
  '/locations/:id/archive',
  requireOwner,
  asyncRoute(async (req, res) => {
    const restore = req.body.restore === '1';
    const location = locationService.setLocationActive(req.db, req.ctx, req.params.id, restore);
    req.flash('success', restore ? `${location.name} restored.` : `${location.name} archived.`);
    res.redirect(303, '/locations');
  })
);

module.exports = router;

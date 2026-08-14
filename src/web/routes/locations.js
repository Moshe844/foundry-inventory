'use strict';

const express = require('express');
const locationService = require('../../domain/location-service');
const { requireAuth, requireOwner, asyncRoute } = require('../middleware');

const router = express.Router();
router.use('/locations', requireAuth);

router.get(
  '/locations',
  asyncRoute(async (req, res) => {
    const locations = locationService.listLocationsWithStock(req.db, req.ctx.workspaceId);
    res.page('locations/list', {
      title: 'Locations',
      nav: 'locations',
      locations,
      editId: req.query.edit || null,
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
    });
    req.flash('success', `${location.name} is ready to hold stock.`);
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

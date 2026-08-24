'use strict';

const express = require('express');
const activityService = require('../../domain/activity-service');
const operationsLog = require('../../domain/operations-log');
const authService = require('../../domain/auth-service');
const repo = require('../../domain/repository');
const inventoryQuery = require('../../domain/inventory-query');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();

router.get(
  '/activity',
  requireAuth,
  asyncRoute(async (req, res) => {
    const limit = 25;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const filters = {
      itemId: trimOrNull(req.query.item) || '',
      locationId: trimOrNull(req.query.location) || '',
      operation: trimOrNull(req.query.operation) || '',
      actorId: trimOrNull(req.query.user) || '',
      dateFrom: trimOrNull(req.query.from) || '',
      dateTo: trimOrNull(req.query.to) || '',
      limit,
      offset: (page - 1) * limit,
    };
    const { groups, hasMore } = activityService.listActivity(req.db, req.ctx.workspaceId, filters);
    const total = activityService.countActivity(req.db, req.ctx.workspaceId, filters);

    // One operational timeline, and which slice of it is being read. The
    // movement groups are still passed through for anything that wants the raw
    // ledger view; the page leads with what happened to the business.
    const stream = operationsLog.STREAMS.includes(String(req.query.stream))
      ? String(req.query.stream)
      : 'all';
    const query = trimOrNull(req.query.q) || '';
    const log = operationsLog.timeline(req.db, req.ctx.workspaceId, {
      stream, query, limit: 100, filters,
    });

    res.page('activity/list', {
      title: 'Activity',
      nav: 'activity',
      groups,
      hasMore,
      page,
      total,
      filters,
      log,
      stream,
      query,
      streamLabels: operationsLog.STREAM_LABEL,
      streams: operationsLog.STREAMS,
      locations: repo.listLocations(req.db, req.ctx.workspaceId, { includeInactive: true }),
      users: authService.listUsers(req.db, req.ctx.workspaceId),
      items: inventoryQuery.listItems(req.db, req.ctx.workspaceId, { limit: 200, includeArchived: true }).items,
    });
  })
);

module.exports = router;

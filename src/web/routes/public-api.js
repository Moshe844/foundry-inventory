'use strict';

const express = require('express');
const publicApi = require('../../connections/public-api');
const inventory = require('../../domain/inventory-engine');
const repo = require('../../domain/repository');
const events = require('../../manager/events');
const { DomainError } = require('../../domain/errors');

function createPublicApi(db) {
  const router = express.Router();
  const handle = (scope, fn) => (req, res) => {
    try { return fn(publicApi.authenticate(db, req.get('authorization'), scope), req, res); }
    catch (error) { return res.status(error instanceof DomainError ? error.status : 500).json({ error: {
      code: error.code || 'error', message: error instanceof DomainError ? error.message : 'The command could not be completed.' } }); }
  };

  router.get('/inventory', handle('inventory:read', (auth, req, res) => {
    const rows = db.prepare(`SELECT s.id AS skuId, s.code, i.name, l.id AS locationId, l.name AS location,
      COALESCE(b.on_hand, 0) AS onHand FROM skus s JOIN items i ON i.id = s.item_id
      CROSS JOIN locations l LEFT JOIN balances b ON b.sku_id = s.id AND b.location_id = l.id
      WHERE s.workspace_id = ? AND l.workspace_id = ? AND i.is_active = 1 AND l.is_active = 1
      ORDER BY i.name, s.code, l.name`).all(auth.workspaceId, auth.workspaceId);
    return res.json({ data: rows, sourceOfTruth: 'Foundry canonical inventory engine' });
  }));

  router.get('/events', handle('events:read', (auth, req, res) => res.json({ data: events.list(db, auth.workspaceId,
    { limit: Math.min(100, Math.max(1, Number(req.query.limit) || 50)) }) })));

  router.post('/commands/inventory/receive', handle('inventory:write', (auth, req, res) => {
    const execution = publicApi.executeCommand(db, auth, { idempotencyKey: req.get('idempotency-key'),
      commandType: 'inventory.receive', body: req.body }, () => inventory.receive(db, auth,
      { ...req.body, reference: req.body.reference || `api:${auth.clientId}` }));
    return res.status(execution.replayed ? 200 : 201).json({ ...execution,
      verifiedOnHand: repo.getBalance(db, auth.workspaceId, req.body.skuId, req.body.locationId) });
  }));

  router.post('/commands/inventory/adjust', handle('inventory:write', (auth, req, res) => {
    const execution = publicApi.executeCommand(db, auth, { idempotencyKey: req.get('idempotency-key'),
      commandType: 'inventory.adjust', body: req.body }, () => inventory.adjust(db, auth,
      { ...req.body, reference: req.body.reference || `api:${auth.clientId}` }));
    return res.status(execution.replayed ? 200 : 201).json({ ...execution,
      verifiedOnHand: repo.getBalance(db, auth.workspaceId, req.body.skuId, req.body.locationId) });
  }));
  return router;
}

module.exports = { createPublicApi };

'use strict';

const express = require('express');
const publicApi = require('../../connections/public-api');
const inventory = require('../../domain/inventory-engine');
const repo = require('../../domain/repository');
const events = require('../../manager/events');
const { DomainError } = require('../../domain/errors');
const migrations = require('../../onboarding/canonical-migration');
const migrationMappings = require('../../onboarding/canonical-mapping');

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

  const membershipFor = (auth) => db.prepare('SELECT * FROM users WHERE workspace_id = ? AND id = ?')
    .get(auth.workspaceId, auth.actorId);

  router.get('/migrations/:id', handle('migration:read', (auth, req, res) =>
    res.json({ data: migrations.report(db, auth.workspaceId, req.params.id) })));

  router.post('/migrations', handle('migration:write', (auth, req, res) => {
    const execution = publicApi.executeCommand(db, auth, { idempotencyKey: req.get('idempotency-key'),
      commandType: 'migration.create', body: req.body }, () => migrations.createPackage(db, auth,
      membershipFor(auth), req.body));
    return res.status(execution.replayed ? 200 : 201).json(execution);
  }));

  router.post('/migrations/:id/records', handle('migration:write', (auth, req, res) => {
    const execution = publicApi.executeCommand(db, auth, { idempotencyKey: req.get('idempotency-key'),
      commandType: 'migration.stage-page', body: req.body }, () => migrations.stagePage(db, auth,
      membershipFor(auth), req.params.id, req.body.records, { startOrdinal: req.body.startOrdinal }));
    return res.status(execution.replayed ? 200 : 201).json(execution);
  }));

  router.post('/migrations/:id/validate', handle('migration:write', (auth, req, res) => {
    const execution = publicApi.executeCommand(db, auth, { idempotencyKey: req.get('idempotency-key'),
      commandType: 'migration.validate', body: req.body }, () => migrations.validate(db, auth,
      membershipFor(auth), req.params.id));
    return res.json(execution);
  }));

  router.post('/migrations/:id/mappings', handle('migration:write', (auth, req, res) => {
    const execution = publicApi.executeCommand(db,auth,{ idempotencyKey:req.get('idempotency-key'),
      commandType:'migration.mapping.propose',body:req.body },() => migrationMappings.createProfile(db,auth,
      membershipFor(auth),req.params.id,req.body));
    return res.status(execution.replayed ? 200 : 201).json(execution);
  }));

  router.post('/migrations/mappings/:profileId/rows', handle('migration:write', (auth, req, res) => {
    const execution = publicApi.executeCommand(db,auth,{ idempotencyKey:req.get('idempotency-key'),
      commandType:'migration.mapping.stage-rows',body:req.body },() => migrationMappings.stageRows(db,auth,
      membershipFor(auth),req.params.profileId,req.body.rows,{ startOrdinal:req.body.startOrdinal }));
    return res.status(execution.replayed ? 200 : 201).json(execution);
  }));

  router.post('/migrations/:id/delta/start', handle('migration:write', (auth, req, res) => {
    const execution = publicApi.executeCommand(db,auth,{ idempotencyKey:req.get('idempotency-key'),
      commandType:'migration.delta.start',body:req.body },() => migrations.beginDeltaCapture(db,auth,
      membershipFor(auth),req.params.id,req.body));
    return res.json(execution);
  }));

  router.post('/migrations/:id/delta/records', handle('migration:write', (auth, req, res) => {
    const execution = publicApi.executeCommand(db,auth,{ idempotencyKey:req.get('idempotency-key'),
      commandType:'migration.delta.records',body:req.body },() => migrations.stageDeltaPage(db,auth,
      membershipFor(auth),req.params.id,req.body.sourceCursor,req.body.changes,{ startOrdinal:req.body.startOrdinal }));
    return res.status(execution.replayed ? 200 : 201).json(execution);
  }));

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

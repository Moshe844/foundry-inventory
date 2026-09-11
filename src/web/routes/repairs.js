'use strict';

const express = require('express');
const repairs = require('../../repairs/service');
const permissions = require('../../actions/permissions');
const repo = require('../../domain/repository');
const { ValidationError } = require('../../domain/errors');
const { requireAuth, requirePermission, asyncRoute } = require('../middleware');

const router = express.Router();
router.use('/repairs', requireAuth);

router.get('/repairs', requirePermission(permissions.VIEW, 'view repair cases'), asyncRoute(async (req, res) => {
  res.page('repairs/index', { title: 'Repair cases', nav: 'attention',
    repairCases: repairs.list(req.db, req.ctx.workspaceId, { limit: 100 }) });
}));

function reportableSkuMappings(db, workspaceId) {
  return db.prepare(`SELECT cm.id, cm.connector_id, cm.external_id, cm.foundry_record_id,
      cm.updated_at, wc.display_name AS connection_name, i.name AS item_name,
      s.variant_label, s.code
    FROM connection_mappings cm
    JOIN workspace_connectors wc ON wc.id = cm.connector_id
      AND wc.workspace_id = cm.workspace_id
    JOIN skus s ON s.id = cm.foundry_record_id AND s.workspace_id = cm.workspace_id
    JOIN items i ON i.id = s.item_id AND i.workspace_id = s.workspace_id
    WHERE cm.workspace_id = ? AND cm.entity_type = 'sku'
    ORDER BY wc.display_name COLLATE NOCASE, cm.external_id COLLATE NOCASE`)
    .all(workspaceId);
}

router.get('/repairs/report', requirePermission(permissions.ADMIN, 'report an incorrect external match'),
  asyncRoute(async (req, res) => {
    const selectedConnectorId = String(req.query.connectorId || '');
    const allMappings = reportableSkuMappings(req.db, req.ctx.workspaceId);
    const mappings = selectedConnectorId
      ? allMappings.filter((row) => row.connector_id === selectedConnectorId) : allMappings;
    const skus = req.db.prepare(`${repo.SKU_SELECT} WHERE s.workspace_id = ? AND s.is_active = 1
      ORDER BY i.name COLLATE NOCASE, s.variant_label COLLATE NOCASE, s.code COLLATE NOCASE`)
      .all(req.ctx.workspaceId);
    res.page('repairs/report', { title: 'Report something wrong', nav: 'attention', mappings, skus });
  }));

router.post('/repairs/report/wrong-mapping',
  requirePermission(permissions.ADMIN, 'report an incorrect external match'),
  asyncRoute(async (req, res) => {
    const mapping = req.db.prepare(`SELECT cm.*, wc.display_name AS connection_name
      FROM connection_mappings cm
      JOIN workspace_connectors wc ON wc.id = cm.connector_id
        AND wc.workspace_id = cm.workspace_id
      WHERE cm.id = ? AND cm.workspace_id = ? AND cm.entity_type = 'sku'`)
      .get(String(req.body.mappingId || ''), req.ctx.workspaceId);
    if (!mapping) throw new ValidationError('Choose a current external product match from this inventory.');
    const correctSku = repo.getSku(req.db, req.ctx.workspaceId, String(req.body.correctSkuId || ''));
    if (!correctSku) throw new ValidationError('Choose the Foundry product this external item should use.');
    if (correctSku.id === mapping.foundry_record_id) {
      throw new ValidationError('That external item already uses the product you selected. Nothing needs repairing.');
    }
    const note = String(req.body.note || '').trim().slice(0, 1000);
    const result = repairs.openAndAssess(req.db, req.ctx, {
      kind: 'wrong_mapping',
      symptom: `${mapping.external_id} is connected to the wrong Foundry product`,
      failedInvariant: `External product ${mapping.external_id} must resolve to the owner-approved Foundry SKU`,
      affectedRecords: { connectorId: mapping.connector_id, entityType: 'sku',
        externalId: mapping.external_id, foundryRecordId: correctSku.id },
      evidence: [{ source: 'owner_report', connectionId: mapping.connector_id,
        connectionName: mapping.connection_name, mappingId: mapping.id,
        currentFoundryRecordId: mapping.foundry_record_id,
        expectedSkuId: correctSku.id, note: note || null }],
      idempotencyKey: `owner-report:wrong-mapping:${mapping.id}:${correctSku.id}:${mapping.updated_at}`,
    });
    req.flash('success', result.created
      ? 'Foundry diagnosed the reported mismatch and added one decision to Needs You. Nothing has changed yet.'
      : 'That mismatch is already being handled. Foundry did not create a duplicate case.');
    res.redirect(303, `/repairs/${result.repairCase.id}`);
  }));

router.get('/repairs/:id', requirePermission(permissions.VIEW, 'view repair cases'), asyncRoute(async (req, res) => {
  const repairCase = repairs.get(req.db, req.ctx.workspaceId, req.params.id);
  res.page('repairs/detail', { title: 'Repair case', nav: 'attention', repairCase,
    events: repairs.events(req.db, req.ctx.workspaceId, req.params.id) });
}));

router.post('/repairs/:id/approve', requirePermission(permissions.OPERATE, 'approve repairs'), asyncRoute(async (req, res) => {
  repairs.approve(req.db, req.ctx, req.user, req.params.id);
  req.flash('success', 'Repair approved. Nothing has changed yet; Foundry will now execute the simulated correction.');
  res.redirect(303, `/repairs/${req.params.id}`);
}));

router.post('/repairs/:id/execute', requirePermission(permissions.OPERATE, 'execute repairs'), asyncRoute(async (req, res) => {
  const result = repairs.execute(req.db, req.ctx, req.user, req.params.id);
  if (result.repairCase.status === 'RESOLVED') {
    req.flash('success', result.replayed
      ? 'Foundry verified the earlier repair. No action was repeated.'
      : 'Repair completed and every post-repair check passed.');
  } else req.flash('error', 'The repair is not complete because its verification checks did not all pass.');
  res.redirect(303, `/repairs/${req.params.id}`);
}));

router.post('/repairs/:id/verify', requirePermission(permissions.OPERATE, 'verify repairs'), asyncRoute(async (req, res) => {
  const repairCase = repairs.verify(req.db, req.ctx.workspaceId, req.params.id, req.ctx.actorId);
  req.flash(repairCase.status === 'RESOLVED' ? 'success' : 'error', repairCase.status === 'RESOLVED'
    ? 'The business records now agree. Foundry verified the repair.'
    : 'The records still do not agree, so Foundry has kept the case open.');
  res.redirect(303, `/repairs/${req.params.id}`);
}));

module.exports = router;

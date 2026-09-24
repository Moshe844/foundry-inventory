'use strict';

const express = require('express');
const transfers = require('../../transfers/postgres-transfer-service');
const permissions = require('../../actions/permissions');
const { requireAuth, asyncRoute } = require('../middleware');
const { newId, trimOrNull } = require('../../lib/util');

function access(user) {
  return {
    canRequest: permissions.can(user, permissions.REQUEST_TRANSFER),
    canApprove: permissions.can(user, permissions.APPROVE_TRANSFER),
    canPick: permissions.can(user, permissions.PICK_TRANSFER),
    canDispatch: permissions.can(user, permissions.DISPATCH_TRANSFER),
    canReceive: permissions.can(user, permissions.RECEIVE_TRANSFER),
    canAdjust: permissions.can(user, permissions.ADJUST),
  };
}

function values(raw) {
  return raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]).map(String).filter(Boolean);
}

function createPostgresTransfersRouter(database) {
  const router = express.Router();
  router.use('/transfers', requireAuth);
  router.get('/transfers', asyncRoute(async (req, res) => {
    permissions.assertCan(req.user, permissions.VIEW_TRANSFERS, 'view inventory transfers');
    return res.page('transfers/index', { title: 'Transfers', nav: 'transfers', room: true,
      transfers: await transfers.list(database, req.ctx.workspaceId), ...access(req.user) });
  }));
  router.get('/transfers/new', asyncRoute(async (req, res) => {
    permissions.assertCan(req.user, permissions.REQUEST_TRANSFER, 'request an inventory transfer');
    const [locations, skus] = await Promise.all([
      database.query(`SELECT * FROM locations WHERE workspace_id=$1 AND is_active=1 ORDER BY lower(name),id`,
        [req.ctx.workspaceId]),
      database.query(`SELECT s.*,i.name AS item_name,i.tracking_mode FROM skus s JOIN items i ON i.id=s.item_id
        WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 ORDER BY lower(i.name),s.position,s.code`,
      [req.ctx.workspaceId]),
    ]);
    return res.page('transfers/new', { title: 'Request transfer', nav: 'transfers', room: true,
      locations: locations.rows, skus: skus.rows });
  }));
  router.post('/transfers', asyncRoute(async (req, res) => {
    const transfer = await transfers.request(database, req.ctx, {
      idempotencyKey: trimOrNull(req.body.idempotencyKey) || newId('transfer-request'),
      fromLocationId: req.body.fromLocationId, toLocationId: req.body.toLocationId,
      expectedArrivalDate: trimOrNull(req.body.expectedArrivalDate), reason: req.body.reason,
      notes: req.body.notes, reference: req.body.reference,
      lines: [{ skuId: req.body.skuId, quantity: req.body.quantity,
        lotId: trimOrNull(req.body.lotId), serialUnitIds: values(req.body.serialUnitIds) }],
    });
    req.flash('success', `${transfer.transfer_number} was requested. No stock moved yet.`);
    return res.redirect(303, `/transfers/${transfer.id}`);
  }));
  router.get('/transfers/:id', asyncRoute(async (req, res) => {
    permissions.assertCan(req.user, permissions.VIEW_TRANSFERS, 'view inventory transfers');
    const transfer = await transfers.get(database, req.ctx.workspaceId, req.params.id);
    return res.page('transfers/detail', { title: transfer.transfer_number, nav: 'transfers', room: true,
      transfer, receiptToken: newId('receipt'), dispatchToken: newId('dispatch'), ...access(req.user) });
  }));
  router.post('/transfers/:id/approve', asyncRoute(async (req, res) => {
    const transfer = await transfers.approve(database, req.ctx, req.params.id, req.body);
    req.flash('success', `${transfer.transfer_number} is approved. Stock is reserved but still at ${transfer.source_name}.`);
    return res.redirect(303, `/transfers/${transfer.id}`);
  }));
  router.post('/transfers/:id/pick', asyncRoute(async (req, res) => {
    const transfer = await transfers.pick(database, req.ctx, req.params.id, req.body);
    req.flash('success', `${transfer.transfer_number} is picked. Stock has not left yet.`);
    return res.redirect(303, `/transfers/${transfer.id}`);
  }));
  router.post('/transfers/:id/dispatch', asyncRoute(async (req, res) => {
    const transfer = await transfers.dispatch(database, req.ctx, req.params.id, req.body);
    req.flash('success', `${transfer.transfer_number} left ${transfer.source_name}; ${transfer.totals.inTransit} units are now in transit.`);
    return res.redirect(303, `/transfers/${transfer.id}`);
  }));
  router.post('/transfers/:id/in-transit', asyncRoute(async (req, res) => {
    const transfer = await transfers.markInTransit(database, req.ctx, req.params.id, req.body);
    req.flash('success', `${transfer.transfer_number} is in transit to ${transfer.destination_name}.`);
    return res.redirect(303, `/transfers/${transfer.id}`);
  }));
  router.post('/transfers/:id/pick-and-dispatch', asyncRoute(async (req, res) => {
    const baseKey = trimOrNull(req.body.idempotencyKey) || newId('transfer-run');
    let transfer = await transfers.get(database, req.ctx.workspaceId, req.params.id);
    if (transfer.status === 'APPROVED') transfer = await transfers.pick(database, req.ctx, req.params.id,
      { idempotencyKey: `${baseKey}:pick` });
    if (transfer.status === 'PICKED') transfer = await transfers.dispatch(database, req.ctx, req.params.id,
      { idempotencyKey: `${baseKey}:dispatch` });
    if (transfer.status === 'SHIPPED') transfer = await transfers.markInTransit(database, req.ctx, req.params.id,
      { idempotencyKey: `${baseKey}:in-transit` });
    req.flash('success', `${transfer.transfer_number} left ${transfer.source_name}; ${transfer.totals.inTransit} units are now in transit.`);
    return res.redirect(303, `/transfers/${transfer.id}`);
  }));
  router.post('/transfers/:id/receive', asyncRoute(async (req, res) => {
    const current = await transfers.get(database, req.ctx.workspaceId, req.params.id);
    const line = current.lines.find((candidate) => candidate.id === req.body.lineId);
    const serialOutcomes = { RECEIVED: [], LOST: [], DAMAGED: [] };
    if (line?.tracking_mode === 'serial') {
      for (const serial of line.serials.filter((row) => row.state === 'IN_TRANSIT')) {
        const outcome = String(req.body[`serialOutcome_${serial.serial_unit_id}`] || '').toUpperCase();
        if (serialOutcomes[outcome]) serialOutcomes[outcome].push(serial.serial_unit_id);
      }
    }
    const transfer = await transfers.receive(database, req.ctx, req.params.id, {
      idempotencyKey: req.body.idempotencyKey,
      lines: [{ lineId: req.body.lineId,
        received: line?.tracking_mode === 'serial' ? serialOutcomes.RECEIVED.length : req.body.received,
        lost: line?.tracking_mode === 'serial' ? serialOutcomes.LOST.length : req.body.lost,
        damaged: line?.tracking_mode === 'serial' ? serialOutcomes.DAMAGED.length : req.body.damaged,
        receivedSerialUnitIds: serialOutcomes.RECEIVED, lostSerialUnitIds: serialOutcomes.LOST,
        damagedSerialUnitIds: serialOutcomes.DAMAGED }],
    });
    req.flash('success', transfer.status === 'RECEIVED'
      ? `${transfer.transfer_number} is fully settled and received.`
      : `${transfer.transfer_number} was partially received; ${transfer.totals.inTransit} units remain in transit.`);
    return res.redirect(303, `/transfers/${transfer.id}`);
  }));
  router.post('/transfers/:id/cancel', asyncRoute(async (req, res) => {
    const transfer = await transfers.cancel(database, req.ctx, req.params.id, req.body);
    req.flash('success', `${transfer.transfer_number} was cancelled. No in-transit stock was erased.`);
    return res.redirect(303, `/transfers/${transfer.id}`);
  }));
  return router;
}

module.exports = { createPostgresTransfersRouter };

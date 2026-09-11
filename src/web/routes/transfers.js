'use strict';

const express = require('express');
const transfers = require('../../transfers/transfer-service');
const permissions = require('../../actions/permissions');
const repo = require('../../domain/repository');
const { requireAuth, asyncRoute } = require('../middleware');
const { newId, trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use('/transfers', requireAuth);

function catalogue(db, workspaceId) {
  return db.prepare(`${repo.SKU_SELECT} WHERE s.workspace_id = ? AND s.is_active = 1
    ORDER BY i.name, s.position, s.code`).all(workspaceId);
}
function locations(db, workspaceId) {
  return db.prepare(`SELECT * FROM locations WHERE workspace_id = ? AND is_active = 1
    ORDER BY name COLLATE NOCASE`).all(workspaceId);
}
function membershipAccess(user) {
  return {
    canRequest: permissions.can(user, permissions.REQUEST_TRANSFER),
    canApprove: permissions.can(user, permissions.APPROVE_TRANSFER),
    canPick: permissions.can(user, permissions.PICK_TRANSFER),
    canDispatch: permissions.can(user, permissions.DISPATCH_TRANSFER),
    canReceive: permissions.can(user, permissions.RECEIVE_TRANSFER),
    canAdjust: permissions.can(user, permissions.ADJUST),
  };
}

router.get('/transfers', asyncRoute(async (req, res) => {
  permissions.assertCan(req.user, permissions.VIEW_TRANSFERS, 'view inventory transfers');
  res.page('transfers/index', { title: 'Transfers', nav: 'transfers', room: true,
    transfers: transfers.list(req.db, req.ctx.workspaceId), ...membershipAccess(req.user) });
}));

router.get('/transfers/new', asyncRoute(async (req, res) => {
  permissions.assertCan(req.user, permissions.REQUEST_TRANSFER, 'request an inventory transfer');
  res.page('transfers/new', { title: 'Request transfer', nav: 'transfers', room: true,
    locations: locations(req.db, req.ctx.workspaceId), skus: catalogue(req.db, req.ctx.workspaceId) });
}));

router.post('/transfers', asyncRoute(async (req, res) => {
  const transfer = transfers.request(req.db, req.ctx, req.user, {
    fromLocationId: req.body.fromLocationId, toLocationId: req.body.toLocationId,
    expectedArrivalDate: trimOrNull(req.body.expectedArrivalDate), reason: req.body.reason,
    notes: req.body.notes, reference: req.body.reference,
    lines: [{ skuId: req.body.skuId, quantity: req.body.quantity,
      lotId: trimOrNull(req.body.lotId), serialUnitIds: [].concat(req.body.serialUnitIds || []).filter(Boolean) }],
  });
  req.flash('success', `${transfer.transfer_number} was requested. No stock moved yet.`);
  res.redirect(303, `/transfers/${transfer.id}`);
}));

router.get('/transfers/:id', asyncRoute(async (req, res) => {
  permissions.assertCan(req.user, permissions.VIEW_TRANSFERS, 'view inventory transfers');
  const transfer = transfers.get(req.db, req.ctx.workspaceId, req.params.id);
  res.page('transfers/detail', { title: transfer.transfer_number, nav: 'transfers', room: true,
    transfer, receiptToken: newId('receipt'), dispatchToken: newId('dispatch'), ...membershipAccess(req.user) });
}));

function transition(path, permission, action, success) {
  router.post(path, asyncRoute(async (req, res) => {
    permissions.assertCan(req.user, permission, action);
    const transfer = action === 'approve an inventory transfer'
      ? transfers.approve(req.db, req.ctx, req.user, req.params.id, req.body)
      : action === 'pick an inventory transfer'
        ? transfers.pick(req.db, req.ctx, req.user, req.params.id, req.body)
        : action === 'dispatch an inventory transfer'
          ? transfers.dispatch(req.db, req.ctx, req.user, req.params.id, req.body)
          : transfers.markInTransit(req.db, req.ctx, req.user, req.params.id, req.body);
    req.flash('success', success(transfer));
    res.redirect(303, `/transfers/${transfer.id}`);
  }));
}
transition('/transfers/:id/approve', permissions.APPROVE_TRANSFER, 'approve an inventory transfer',
  (t) => `${t.transfer_number} is approved. Stock is reserved but still at ${t.source_name}.`);
transition('/transfers/:id/pick', permissions.PICK_TRANSFER, 'pick an inventory transfer',
  (t) => `${t.transfer_number} is picked. Stock has not left yet.`);
transition('/transfers/:id/dispatch', permissions.DISPATCH_TRANSFER, 'dispatch an inventory transfer',
  (t) => `${t.transfer_number} left ${t.source_name}; ${t.totals.inTransit} units are now in transit.`);
transition('/transfers/:id/in-transit', permissions.DISPATCH_TRANSFER, 'mark an inventory transfer in transit',
  (t) => `${t.transfer_number} is in transit to ${t.destination_name}.`);

/* A warehouse worker commonly learns the two physical facts together: the
 * picked units have left the source. Keep both immutable lifecycle events,
 * but do not force them through two nearly-identical screens. If either part
 * fails, the durable state remains at the completed part and this route can
 * safely be resumed. */
router.post('/transfers/:id/pick-and-dispatch', asyncRoute(async (req, res) => {
  permissions.assertCan(req.user, permissions.PICK_TRANSFER, 'pick an inventory transfer');
  permissions.assertCan(req.user, permissions.DISPATCH_TRANSFER, 'dispatch an inventory transfer');
  const baseKey = trimOrNull(req.body.idempotencyKey) || newId('transfer-run');
  let transfer = transfers.get(req.db, req.ctx.workspaceId, req.params.id);
  if (transfer.status === 'APPROVED') {
    transfer = transfers.pick(req.db, req.ctx, req.user, req.params.id, { idempotencyKey: `${baseKey}:pick` });
  }
  if (transfer.status === 'PICKED') {
    transfer = transfers.dispatch(req.db, req.ctx, req.user, req.params.id, { idempotencyKey: `${baseKey}:dispatch` });
  }
  if (transfer.status === 'SHIPPED') {
    transfer = transfers.markInTransit(req.db, req.ctx, req.user, req.params.id, { idempotencyKey: `${baseKey}:in-transit` });
  }
  req.flash('success', `${transfer.transfer_number} left ${transfer.source_name}; ${transfer.totals.inTransit} units are now in transit.`);
  res.redirect(303, `/transfers/${transfer.id}`);
}));

router.post('/transfers/:id/receive', asyncRoute(async (req, res) => {
  const current = transfers.get(req.db, req.ctx.workspaceId, req.params.id);
  const currentLine = current.lines.find((line) => line.id === req.body.lineId);
  const serialOutcomes = { RECEIVED: [], LOST: [], DAMAGED: [] };
  if (currentLine?.tracking_mode === 'serial') {
    for (const serial of currentLine.serials.filter((row) => row.state === 'IN_TRANSIT')) {
      const outcome = String(req.body[`serialOutcome_${serial.serial_unit_id}`] || '').toUpperCase();
      if (serialOutcomes[outcome]) serialOutcomes[outcome].push(serial.serial_unit_id);
    }
  }
  const transfer = transfers.receive(req.db, req.ctx, req.user, req.params.id, {
    idempotencyKey: req.body.idempotencyKey,
    lines: [{ lineId: req.body.lineId,
      received: currentLine?.tracking_mode === 'serial' ? serialOutcomes.RECEIVED.length : Number(req.body.received || 0),
      lost: currentLine?.tracking_mode === 'serial' ? serialOutcomes.LOST.length : Number(req.body.lost || 0),
      damaged: currentLine?.tracking_mode === 'serial' ? serialOutcomes.DAMAGED.length : Number(req.body.damaged || 0),
      receivedSerialUnitIds: serialOutcomes.RECEIVED,
      lostSerialUnitIds: serialOutcomes.LOST,
      damagedSerialUnitIds: serialOutcomes.DAMAGED }],
  });
  req.flash('success', transfer.status === 'RECEIVED'
    ? `${transfer.transfer_number} is fully settled and received.`
    : `${transfer.transfer_number} was partially received; ${transfer.totals.inTransit} units remain in transit.`);
  res.redirect(303, `/transfers/${transfer.id}`);
}));

router.post('/transfers/:id/cancel', asyncRoute(async (req, res) => {
  const transfer = transfers.cancel(req.db, req.ctx, req.user, req.params.id, req.body);
  req.flash('success', `${transfer.transfer_number} was cancelled. No in-transit stock was erased.`);
  res.redirect(303, `/transfers/${transfer.id}`);
}));

module.exports = router;

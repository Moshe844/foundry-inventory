'use strict';

/**
 * The purchasing surface.
 *
 * Shaped around the job rather than around the tables: the first screen is
 * "what should I order", already worked out and grouped into the orders it
 * would become, because the point of Mission 6 is that a person reviews
 * prepared work instead of typing it in. Suppliers and orders are there
 * underneath for when they are needed.
 *
 * Every route authorises on the server before doing anything, and approval and
 * receiving both carry idempotency keys so a retried request cannot commit to
 * a second order or book a delivery in twice.
 */

const express = require('express');
const config = require('../../config');
const supplierService = require('../../purchasing/supplier-service');
const policyService = require('../../purchasing/policy-service');
const setupService = require('../../purchasing/setup-service');
const replenishment = require('../../purchasing/replenishment');
const position = require('../../purchasing/position');
const poService = require('../../purchasing/po-service');
const receiving = require('../../purchasing/receiving-service');
const permissions = require('../../actions/permissions');
const repo = require('../../domain/repository');
const reevaluate = require('../../attention/reevaluate');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');
const { ValidationError } = require('../../domain/errors');

const router = express.Router();
router.use('/purchasing', requireAuth);
router.use('/suppliers', requireAuth);

function guard(req, permission, what) {
  permissions.assertCan(req.user, permission, what);
}

function locations(db, workspaceId) {
  return repo.listLocations(db, workspaceId).filter((l) => l.is_active);
}

const can = (req) => ({
  view: permissions.can(req.user, permissions.VIEW_PURCHASING),
  create: permissions.can(req.user, permissions.CREATE_PO),
  approve: permissions.can(req.user, permissions.APPROVE_PO),
  receive: permissions.can(req.user, permissions.RECEIVE_PO),
  suppliers: permissions.can(req.user, permissions.MANAGE_SUPPLIERS),
  replenishment: permissions.can(req.user, permissions.MANAGE_REPLENISHMENT),
});

// ---------------------------------------------------------------------------
// What should I order?
// ---------------------------------------------------------------------------

router.get(
  '/purchasing',
  asyncRoute(async (req, res) => {
    guard(req, permissions.VIEW_PURCHASING, 'see purchasing');
    const plan = replenishment.evaluateWorkspace(req.db, req.ctx.workspaceId);

    res.page('purchasing/plan', {
      title: 'What to order',
      nav: 'purchasing',
      plan,
      open: position.openOrders(req.db, req.ctx.workspaceId),
      late: position.lateOrders(req.db, req.ctx.workspaceId),
      arriving: position.arrivingSoon(req.db, req.ctx.workspaceId, { days: 7 }),
      suppliers: supplierService.listWithCounts(req.db, req.ctx.workspaceId),
      // Whether this inventory has purchasing set up at all. Without it the
      // replenishment engine has nothing to go on, and a silent screen reads
      // as broken rather than unconfigured.
      setup: setupService.assess(req.db, req.ctx.workspaceId).summary,
      permissions: can(req),
      aiConfigured: config.ai.configured,
    });
  })
);

/** The evidence behind one recommendation — "why are you recommending 48?" */
router.get(
  '/purchasing/why/:skuId',
  asyncRoute(async (req, res) => {
    guard(req, permissions.VIEW_PURCHASING, 'see purchasing');
    const line = replenishment.evaluateOne(req.db, req.ctx.workspaceId, req.params.skuId);
    if (!line) {
      req.flash('error', 'That product is not in this inventory.');
      return res.redirect('/purchasing');
    }
    return res.page('purchasing/why', {
      title: `Why ${line.displayName}`,
      nav: 'purchasing',
      line,
      policy: policyService.effectivePolicy(req.db, req.ctx.workspaceId, req.params.skuId),
      proposal: policyService.proposePolicy(req.db, req.ctx.workspaceId, req.params.skuId),
      history: poService.costHistory(req.db, req.ctx.workspaceId, req.params.skuId, { limit: 6 }),
      permissions: can(req),
    });
  })
);

/** Turns one supplier's recommended lines into a draft order to review. */
router.post(
  '/purchasing/prepare/:supplierId',
  asyncRoute(async (req, res) => {
    guard(req, permissions.CREATE_PO, 'prepare purchase orders');
    const plan = replenishment.evaluateWorkspace(req.db, req.ctx.workspaceId);
    const group = plan.bySupplier.find((entry) => entry.supplierId === req.params.supplierId);
    if (!group || group.lines.length === 0) {
      req.flash('error', 'There is nothing to order from that supplier right now.');
      return res.redirect('/purchasing');
    }

    const order = poService.createOrder(req.db, req.ctx, req.user, {
      supplierId: group.supplierId,
      source: 'foundry_recommendation',
      sourceDetail: {
        preparedAt: plan.evaluatedAt,
        lines: group.lines.map((line) => ({
          skuId: line.skuId,
          shortfall: line.shortfall,
          reorderPoint: line.reorderPoint,
          target: line.target,
        })),
      },
      lines: group.lines.map((line) => ({
        skuId: line.skuId,
        quantityPurchaseUnits: line.quantityPurchaseUnits,
        unitCost: line.unitCost,
      })),
    });
    return res.redirect(`/purchasing/orders/${order.id}`);
  })
);

router.post(
  '/purchasing/policies/:skuId',
  asyncRoute(async (req, res) => {
    guard(req, permissions.MANAGE_REPLENISHMENT, 'set reorder policies');
    if (req.body.clear === '1') {
      policyService.clearPolicy(req.db, req.ctx, req.user, req.params.skuId);
      req.flash('success', 'Foundry will work this line out from usage again.');
    } else {
      policyService.setPolicy(req.db, req.ctx, req.user, req.params.skuId, req.body);
      req.flash('success', 'Saved.');
    }
    return res.redirect(`/purchasing/why/${req.params.skuId}`);
  })
);

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

router.get(
  '/purchasing/orders',
  asyncRoute(async (req, res) => {
    guard(req, permissions.VIEW_PURCHASING, 'see purchasing');
    const status = req.query.status && poService.STATUS[req.query.status] ? req.query.status : null;
    res.page('purchasing/orders', {
      title: 'Purchase orders',
      nav: 'purchasing',
      orders: poService.list(req.db, req.ctx.workspaceId, { status }),
      status,
      statuses: Object.keys(poService.STATUS),
      permissions: can(req),
    });
  })
);

router.get(
  '/purchasing/orders/new',
  asyncRoute(async (req, res) => {
    guard(req, permissions.CREATE_PO, 'prepare purchase orders');
    const supplierId = trimOrNull(req.query.supplier);
    res.page('purchasing/order-new', {
      title: 'New purchase order',
      nav: 'purchasing',
      suppliers: supplierService.listSuppliers(req.db, req.ctx.workspaceId),
      supplierId,
      supplierItems: supplierId
        ? supplierService.itemsForSupplier(req.db, req.ctx.workspaceId, supplierId)
        : [],
      locations: locations(req.db, req.ctx.workspaceId),
      permissions: can(req),
    });
  })
);

router.post(
  '/purchasing/orders',
  asyncRoute(async (req, res) => {
    guard(req, permissions.CREATE_PO, 'prepare purchase orders');
    const quantities = req.body.quantity || {};
    const lines = Object.entries(quantities)
      .map(([skuId, value]) => ({ skuId, quantityPurchaseUnits: Number(value) }))
      .filter((line) => Number.isFinite(line.quantityPurchaseUnits) && line.quantityPurchaseUnits > 0);

    if (lines.length === 0) throw new ValidationError('Put a quantity against at least one product.');

    const order = poService.createOrder(req.db, req.ctx, req.user, {
      supplierId: req.body.supplierId,
      destinationLocationId: trimOrNull(req.body.destinationLocationId),
      expectedDate: trimOrNull(req.body.expectedDate),
      notes: trimOrNull(req.body.notes),
      lines,
    });
    return res.redirect(`/purchasing/orders/${order.id}`);
  })
);

router.get(
  '/purchasing/orders/:id',
  asyncRoute(async (req, res) => {
    guard(req, permissions.VIEW_PURCHASING, 'see purchasing');
    const order = poService.get(req.db, req.ctx.workspaceId, req.params.id);
    res.page('purchasing/order', {
      title: `${order.poNumber} · ${order.supplierName}`,
      nav: 'purchasing',
      order,
      events: poService.eventsFor(req.db, req.ctx.workspaceId, order.id),
      receipts: receiving.receiptsFor(req.db, req.ctx.workspaceId, order.id),
      locations: locations(req.db, req.ctx.workspaceId),
      permissions: can(req),
    });
  })
);

router.post(
  '/purchasing/orders/:id/approve',
  asyncRoute(async (req, res) => {
    guard(req, permissions.APPROVE_PO, 'approve purchase orders');
    const order = poService.approve(req.db, req.ctx, req.user, req.params.id, {
      expectedHash: trimOrNull(req.body.integrityHash),
    });
    req.flash('success', `${order.poNumber} is approved and marked as ordered.`);
    // Incoming stock changes what needs attention, so the layer is told at once
    // rather than waiting for the next sweep to notice.
    reevaluate.refresh(req.db, req.ctx.workspaceId, 'purchase-order-approved');
    return res.redirect(`/purchasing/orders/${order.id}`);
  })
);

router.post(
  '/purchasing/orders/:id/cancel',
  asyncRoute(async (req, res) => {
    guard(req, permissions.APPROVE_PO, 'cancel purchase orders');
    const order = poService.cancel(req.db, req.ctx, req.user, req.params.id, { reason: req.body.reason });
    req.flash('success', `${order.poNumber} was cancelled. Anything already received stays received.`);
    reevaluate.refresh(req.db, req.ctx.workspaceId, 'purchase-order-cancelled');
    return res.redirect(`/purchasing/orders/${order.id}`);
  })
);

/** The printable order. Plain HTML styled for paper — no fake transmission. */
router.get(
  '/purchasing/orders/:id/document',
  asyncRoute(async (req, res) => {
    guard(req, permissions.VIEW_PURCHASING, 'see purchasing');
    const order = poService.get(req.db, req.ctx.workspaceId, req.params.id);
    const workspace = req.db
      .prepare('SELECT name FROM workspaces WHERE id = ?')
      .get(req.ctx.workspaceId);
    res.page('purchasing/document', {
      title: `${order.poNumber}`,
      nav: 'purchasing',
      layout: false,
      order,
      supplier: supplierService.getSupplier(req.db, req.ctx.workspaceId, order.supplierId),
      businessName: workspace ? workspace.name : 'Inventory',
      permissions: can(req),
    });
  })
);

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

router.get(
  '/purchasing/receive',
  asyncRoute(async (req, res) => {
    guard(req, permissions.RECEIVE_PO, 'book in deliveries');
    const supplierName = trimOrNull(req.query.supplier);
    const all = position.openOrders(req.db, req.ctx.workspaceId);
    const matched = supplierName
      ? all.filter((po) => po.supplier_name.toLowerCase().includes(supplierName.toLowerCase()))
      : all;

    res.page('purchasing/receive-pick', {
      title: 'Book in a delivery',
      nav: 'purchasing',
      orders: matched.length ? matched : all,
      supplierName,
      noMatch: Boolean(supplierName) && matched.length === 0,
      permissions: can(req),
    });
  })
);

router.get(
  '/purchasing/orders/:id/receive',
  asyncRoute(async (req, res) => {
    guard(req, permissions.RECEIVE_PO, 'book in deliveries');
    const { order, lines } = receiving.outstandingLines(req.db, req.ctx.workspaceId, req.params.id);
    if (!lines.length) {
      req.flash('error', 'There is nothing outstanding on that order.');
      return res.redirect(`/purchasing/orders/${order.id}`);
    }
    return res.page('purchasing/receive', {
      title: `Receive ${order.poNumber}`,
      nav: 'purchasing',
      order,
      lines,
      locations: locations(req.db, req.ctx.workspaceId),
      warnings: [],
      // Always supplied, so the template never has to guard for a local that
      // only exists on the over-receipt re-render.
      overReceipt: null,
      submitted: null,
      permissions: can(req),
    });
  })
);

router.post(
  '/purchasing/orders/:id/receive',
  asyncRoute(async (req, res) => {
    guard(req, permissions.RECEIVE_PO, 'book in deliveries');
    const order = poService.get(req.db, req.ctx.workspaceId, req.params.id);

    const lines = order.lines
      .map((line) => ({
        lineId: line.id,
        quantityUnits: req.body[`qty_${line.id}`],
        lotCode: req.body[`lot_${line.id}`],
        expiresAt: req.body[`expires_${line.id}`],
        serials: req.body[`serials_${line.id}`],
        locationId: req.body[`location_${line.id}`] || line.destinationLocationId,
      }))
      .filter((line) => String(line.quantityUnits || '').trim() !== '' && Number(line.quantityUnits) > 0);

    if (lines.length === 0) throw new ValidationError('Say how much of the order arrived.');

    try {
      const done = receiving.receive(req.db, req.ctx, req.user, order.id, {
        // Keyed on what is being received, so a double-submitted form is the
        // same delivery and a genuinely separate one is not.
        idempotencyKey:
          trimOrNull(req.body.idempotencyKey) ||
          `po-receipt:${order.id}:${lines.map((l) => `${l.lineId}=${l.quantityUnits}`).join('|')}`,
        approveOverReceipt: req.body.approveOverReceipt === '1',
        reference: trimOrNull(req.body.reference),
        note: trimOrNull(req.body.note),
        lines,
      });

      req.flash(
        'success',
        done.replayed
          ? 'That delivery was already booked in.'
          : `${done.result.unitsReceived} unit(s) received against ${order.poNumber}.`
      );
      reevaluate.refresh(req.db, req.ctx.workspaceId, 'purchase-order-received');
      return res.redirect(`/purchasing/orders/${order.id}`);
    } catch (error) {
      // An over-receipt is not a failure — it is a question. The form comes
      // back with the numbers kept and a confirmation to tick.
      if (!error.overReceipt) throw error;
      const { lines: outstanding } = receiving.outstandingLines(req.db, req.ctx.workspaceId, order.id);
      return res.page('purchasing/receive', {
        title: `Receive ${order.poNumber}`,
        nav: 'purchasing',
        order,
        lines: outstanding,
        locations: locations(req.db, req.ctx.workspaceId),
        warnings: [error.message],
        overReceipt: error.overReceipt,
        submitted: req.body,
        permissions: can(req),
      });
    }
  })
);

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

router.get(
  '/suppliers',
  asyncRoute(async (req, res) => {
    guard(req, permissions.VIEW_PURCHASING, 'see purchasing');
    res.page('purchasing/suppliers', {
      title: 'Suppliers',
      nav: 'purchasing',
      suppliers: supplierService.listWithCounts(req.db, req.ctx.workspaceId, { includeInactive: true }),
      permissions: can(req),
    });
  })
);

router.post(
  '/suppliers',
  asyncRoute(async (req, res) => {
    guard(req, permissions.MANAGE_SUPPLIERS, 'manage suppliers');
    const supplier = supplierService.createSupplier(req.db, req.ctx, req.user, req.body);
    req.flash('success', `${supplier.name} added.`);
    return res.redirect(`/suppliers/${supplier.id}`);
  })
);

router.get(
  '/suppliers/:id',
  asyncRoute(async (req, res) => {
    guard(req, permissions.VIEW_PURCHASING, 'see purchasing');
    const supplier = supplierService.getSupplier(req.db, req.ctx.workspaceId, req.params.id);
    res.page('purchasing/supplier', {
      title: supplier.name,
      nav: 'purchasing',
      supplier,
      items: supplierService.itemsForSupplier(req.db, req.ctx.workspaceId, supplier.id, { includeInactive: true }),
      orders: poService.list(req.db, req.ctx.workspaceId, { supplierId: supplier.id, limit: 10 }),
      catalogue: req.db
        .prepare(
          `SELECT s.id, s.code, s.variant_label, i.name AS item_name, i.unit_label
             FROM skus s JOIN items i ON i.id = s.item_id
            WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
            ORDER BY i.name COLLATE NOCASE, s.position
            LIMIT 500`
        )
        .all(req.ctx.workspaceId),
      permissions: can(req),
    });
  })
);

router.post(
  '/suppliers/:id',
  asyncRoute(async (req, res) => {
    guard(req, permissions.MANAGE_SUPPLIERS, 'manage suppliers');
    supplierService.updateSupplier(req.db, req.ctx, req.user, req.params.id, req.body);
    req.flash('success', 'Saved.');
    return res.redirect(`/suppliers/${req.params.id}`);
  })
);

router.post(
  '/suppliers/:id/items',
  asyncRoute(async (req, res) => {
    guard(req, permissions.MANAGE_SUPPLIERS, 'manage suppliers');
    supplierService.linkItem(req.db, req.ctx, req.user, { ...req.body, supplierId: req.params.id });
    req.flash('success', 'Product linked to this supplier.');
    return res.redirect(`/suppliers/${req.params.id}`);
  })
);

router.post(
  '/suppliers/:id/items/:supplierItemId/remove',
  asyncRoute(async (req, res) => {
    guard(req, permissions.MANAGE_SUPPLIERS, 'manage suppliers');
    supplierService.unlinkItem(req.db, req.ctx, req.user, req.params.supplierItemId);
    req.flash('success', 'Removed from this supplier.');
    return res.redirect(`/suppliers/${req.params.id}`);
  })
);

/**
 * Turning purchasing on for an inventory that already exists.
 *
 * Everything on this screen is derived from real outbound history and shown
 * with the arithmetic, so switching it on is a decision with a visible
 * consequence rather than an act of faith.
 */
router.get(
  '/purchasing/setup',
  asyncRoute(async (req, res) => {
    guard(req, permissions.VIEW_PURCHASING, 'see purchasing');
    const assessment = setupService.preview(req.db, req.ctx.workspaceId);

    return res.page('purchasing/setup', {
      title: 'Set up purchasing',
      nav: 'purchasing',
      assessment,
      suppliers: supplierService.listSuppliers(req.db, req.ctx.workspaceId),
      canManage: permissions.can(req.user, permissions.MANAGE_REPLENISHMENT),
      canManageSuppliers: permissions.can(req.user, permissions.MANAGE_SUPPLIERS),
    });
  })
);

router.post(
  '/purchasing/setup/policies',
  asyncRoute(async (req, res) => {
    guard(req, permissions.MANAGE_REPLENISHMENT, 'set reorder policies');
    const raw = req.body.skuIds;
    const skuIds = Array.isArray(raw) ? raw : raw ? [raw] : [];
    try {
      const result = setupService.applyPolicies(req.db, req.ctx, req.user, skuIds);
      req.flash('success', `Reorder points set for ${result.count} line(s), derived from what actually sold.`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, '/purchasing/setup');
  })
);

router.post(
  '/purchasing/setup/supplier',
  asyncRoute(async (req, res) => {
    guard(req, permissions.MANAGE_SUPPLIERS, 'manage suppliers');
    const raw = req.body.skuIds;
    const skuIds = Array.isArray(raw) ? raw : raw ? [raw] : [];

    try {
      // A supplier named here is created if it is new, so setting a vendor up
      // and attaching a whole range to it is one step rather than two screens.
      let supplierId = trimOrNull(req.body.supplierId);
      if (!supplierId) {
        const created = supplierService.createSupplier(req.db, req.ctx, req.user, {
          name: req.body.newSupplierName,
          defaultLeadTimeDays: req.body.leadTimeDays,
        });
        supplierId = created.id;
      }

      const result = setupService.linkSupplierToMany(req.db, req.ctx, req.user, {
        supplierId,
        skuIds,
        purchaseUnit: req.body.purchaseUnit,
        unitsPerPurchaseUnit: req.body.unitsPerPurchaseUnit,
        minimumOrderQuantity: req.body.minimumOrderQuantity,
        orderMultiple: req.body.orderMultiple,
        leadTimeDays: req.body.leadTimeDays,
        lastUnitCost: req.body.lastUnitCost,
        isPreferred: true,
      });
      req.flash('success', `${result.supplier.name} now supplies ${result.linked} product(s).`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, '/purchasing/setup');
  })
);

module.exports = router;

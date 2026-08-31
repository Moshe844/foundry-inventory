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
const supplierCommunications = require('../../purchasing/supplier-communications');
const supplierCodeMappings = require('../../purchasing/supplier-code-mappings');
const policyService = require('../../purchasing/policy-service');
const setupService = require('../../purchasing/setup-service');
const replenishment = require('../../purchasing/replenishment');
const position = require('../../purchasing/position');
const poService = require('../../purchasing/po-service');
const receiving = require('../../purchasing/receiving-service');
const physicalEvents = require('../../manager/physical-events');
const permissions = require('../../actions/permissions');
const repo = require('../../domain/repository');
const managerEvents = require('../../manager/events');
const reactions = require('../../manager/reactions');
const autopilotPresenter = require('../../autopilot/presenter');
const { requireAuth, asyncRoute } = require('../middleware');
const { unitCount } = require('../../lib/units');
const { localDateKey } = require('../../lib/calendar');
const { trimOrNull } = require('../../lib/util');
const { ValidationError } = require('../../domain/errors');

const router = express.Router();
router.use('/purchasing', requireAuth);
router.use('/suppliers', requireAuth);
router.use('/supplier-code-mappings', requireAuth);

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

function react(req, type, payload, options = {}) {
  return reactions.publishAndReact(req.db, req.ctx.workspaceId, type, payload, options);
}

// ---------------------------------------------------------------------------
// What should I order?
// ---------------------------------------------------------------------------

router.get(
  '/purchasing',
  asyncRoute(async (req, res) => {
    guard(req, permissions.VIEW_PURCHASING, 'see purchasing');
    const plan = replenishment.evaluateWorkspace(req.db, req.ctx.workspaceId);

    res.page('purchasing/plan', {
      title: 'Purchasing',
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
    const currentSku = repo.requireSku(req.db, req.ctx.workspaceId, req.params.skuId);
    const itemSkus = repo.listSkusForItem(req.db, req.ctx.workspaceId, currentSku.item_id)
      .filter((sku) => sku.is_active);
    const pendingRule = req.session.pendingInventoryRule;
    const rulePreview = pendingRule && pendingRule.skuId === req.params.skuId ? pendingRule : null;
    if (rulePreview) delete req.session.pendingInventoryRule;
    return res.page('purchasing/why', {
      title: `Why ${line.displayName}`,
      nav: 'purchasing',
      line,
      policy: policyService.effectivePolicy(req.db, req.ctx.workspaceId, req.params.skuId),
      proposal: policyService.proposePolicy(req.db, req.ctx.workspaceId, req.params.skuId),
      rulePreview,
      locationPolicies: policyService.locationPolicies(req.db, req.ctx.workspaceId, req.params.skuId),
      locations: locations(req.db, req.ctx.workspaceId),
      history: poService.costHistory(req.db, req.ctx.workspaceId, req.params.skuId, { limit: 6 }),
      itemSkus,
      permissions: can(req),
    });
  })
);

/**
 * The way out of "no supplier on file".
 *
 * Replenishment can work out that a line is short and still be unable to do
 * anything about it, and it says so plainly. But the only link on that line
 * went to the arithmetic — reorder point, order-up-to, safety stock — which is
 * the one thing that was not missing. Somebody new was told exactly what was
 * wrong and given nowhere to fix it, with suppliers living on a screen they had
 * no reason to have found.
 *
 * This is that screen, scoped to the product that is blocked, using the same
 * linking the setup page uses. Afterwards it goes back to what to order, where
 * the same line is recalculated with the supplier's pack size, cost and lead
 * time and is ready to become an order.
 */
router.get(
  '/purchasing/supplier-for/:skuId',
  asyncRoute(async (req, res) => {
    guard(req, permissions.VIEW_PURCHASING, 'see purchasing');
    const line = replenishment.evaluateOne(req.db, req.ctx.workspaceId, req.params.skuId);
    if (!line) {
      req.flash('error', 'That product is not in this inventory.');
      return res.redirect('/purchasing');
    }
    const currentSku = repo.requireSku(req.db, req.ctx.workspaceId, req.params.skuId);
    const itemSkus = repo.listSkusForItem(req.db, req.ctx.workspaceId, currentSku.item_id)
      .filter((sku) => sku.is_active);
    return res.page('purchasing/supplier-for', {
      title: `Who do you buy ${line.displayName} from?`,
      nav: 'purchasing',
      line,
      itemName: currentSku.item_name,
      itemSkus,
      suppliers: supplierService.listSuppliers(req.db, req.ctx.workspaceId),
      canManageSuppliers: permissions.can(req.user, permissions.MANAGE_SUPPLIERS),
    });
  })
);

router.post(
  '/purchasing/supplier-for/:skuId',
  asyncRoute(async (req, res) => {
    guard(req, permissions.MANAGE_SUPPLIERS, 'manage suppliers');
    try {
      let supplierId = trimOrNull(req.body.supplierId);
      if (!supplierId) {
        const created = supplierService.createSupplier(req.db, req.ctx, req.user, {
          name: req.body.newSupplierName,
          defaultLeadTimeDays: req.body.leadTimeDays,
        });
        supplierId = created.id;
      }
      // The same linking the setup screen performs, so there is one way a
      // supplier gets attached to a product rather than two that can diverge.
      const currentSku = repo.requireSku(req.db, req.ctx.workspaceId, req.params.skuId);
      const itemSkus = repo.listSkusForItem(req.db, req.ctx.workspaceId, currentSku.item_id)
        .filter((sku) => sku.is_active);
      const skuIds = req.body.applyToItem === '1'
        ? itemSkus.map((sku) => sku.id)
        : [req.params.skuId];
      const result = setupService.linkSupplierToMany(req.db, req.ctx, req.user, {
        supplierId,
        skuIds,
        purchaseUnit: req.body.purchaseUnit,
        unitsPerPurchaseUnit: req.body.unitsPerPurchaseUnit,
        minimumOrderQuantity: req.body.minimumOrderQuantity,
        leadTimeDays: req.body.leadTimeDays,
        lastUnitCost: req.body.lastUnitCost,
        isPreferred: true,
      });
      react(req, managerEvents.TYPES.SUPPLIER_UPDATED, {
        supplierId, skuIds, change: 'product_linked',
      });

      // Recalculated immediately, so the answer to "what now?" is the number
      // rather than another screen.
      const line = replenishment.evaluateOne(req.db, req.ctx.workspaceId, req.params.skuId);
      req.flash(
        'success',
        line && line.recommend
          ? `${result.supplier.name} now supplies ${line.displayName}. ${line.headline} — review it below.`
          : skuIds.length > 1
            ? `${result.supplier.name} now supplies all ${skuIds.length} variants of ${currentSku.item_name}.`
            : `${result.supplier.name} now supplies that product.`
      );
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, `/purchasing/supplier-for/${req.params.skuId}`);
    }
    return res.redirect(303, '/purchasing');
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
      // Say what was removed. A line that silently reverts to "not enough
      // history" afterwards looks like Foundry lost the settings rather than
      // like something the person asked for.
      const had = policyService.effectivePolicy(req.db, req.ctx.workspaceId, req.params.skuId);
      policyService.clearPolicy(req.db, req.ctx, req.user, req.params.skuId);
      react(req, managerEvents.TYPES.REORDER_POLICY_UPDATED, {
        skuId: req.params.skuId, change: 'cleared',
      });
      req.flash(
        'success',
        had && had.isSet
          ? `Your settings for this line are gone (reorder at ${had.reorderPoint}, up to ${had.targetStock}). `
            + 'Foundry works it out from usage again, and will say so if it has not seen enough selling.'
          : 'Foundry will work this line out from usage again.'
      );
    } else {
      const currentSku = repo.requireSku(req.db, req.ctx.workspaceId, req.params.skuId);
      const itemSkus = repo.listSkusForItem(req.db, req.ctx.workspaceId, currentSku.item_id)
        .filter((sku) => sku.is_active);
      const skuIds = req.body.applyToItem === '1'
        ? itemSkus.map((sku) => sku.id)
        : [req.params.skuId];
      const savedPolicies = [];
      for (const skuId of skuIds) {
        const saved = policyService.setPolicy(req.db, req.ctx, req.user, skuId, req.body);
        savedPolicies.push(saved);
        react(req, managerEvents.TYPES.REORDER_POLICY_UPDATED, {
          skuId, policyId: saved.id, updatedAt: saved.updatedAt,
        });
      }
      req.flash(
        'success',
        skuIds.length > 1
          ? `Saved these reorder settings for all ${skuIds.length} variants of ${currentSku.item_name}.`
          : 'Saved reorder settings.'
      );
    }
    return res.redirect(`/purchasing/why/${req.params.skuId}`);
  })
);

router.post(
  '/purchasing/location-minimums/:skuId',
  asyncRoute(async (req, res) => {
    guard(req, permissions.MANAGE_REPLENISHMENT, 'set location minimums');
    try {
      const result = policyService.setLocationMinimum(
        req.db, req.ctx, req.user, req.params.skuId, trimOrNull(req.body.locationId), req.body.minimum
      );
      react(req, managerEvents.TYPES.REORDER_POLICY_UPDATED, {
        skuId: req.params.skuId, locationId: result.locationId, change: 'location_minimum',
      });
      const location = repo.requireLocation(req.db, req.ctx.workspaceId, result.locationId);
      req.flash('success', result.minimum === null
        ? `Removed the keep-back level at ${location.name}.`
        : `Foundry will keep at least ${result.minimum} at ${location.name} when planning transfers.`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, `/purchasing/why/${req.params.skuId}#location-minimums`);
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
      expectedInFuture: Boolean(order.expectedDate && order.expectedDate > localDateKey()),
      communications: supplierCommunications.forOrder(req.db, req.ctx.workspaceId, order.id),
      supplierDocuments: require('../../purchasing/supplier-evidence').forOrder(req.db, req.ctx.workspaceId, order.id),
    });
  })
);

router.post(
  '/purchasing/orders/:id/approve',
  asyncRoute(async (req, res) => {
    guard(req, permissions.APPROVE_PO, 'approve purchase orders');
    // An order a replenishment plan contains is approved through that plan.
    // Hiding the button is not enough: the route is the thing that spends the
    // money, and a stale page or a typed URL would otherwise still place it —
    // beside the plan that also intends to.
    const owner = autopilotPresenter.ordersOwnedByAPlan(req.db, req.ctx.workspaceId).get(req.params.id);
    if (owner) {
      req.flash(
        'error',
        'This order is part of a replenishment plan. Approve the plan and Foundry will place it, ' +
          'so the same stock is not ordered twice.'
      );
      return res.redirect(303, `/autopilot/work/${owner.id}`);
    }
    const order = poService.approve(req.db, req.ctx, req.user, req.params.id, {
      expectedHash: trimOrNull(req.body.integrityHash),
    });
    try { await supplierCommunications.dispatchAutomaticForOrder(req.db, req.ctx.workspaceId, order.id); }
    catch (error) { req.flash('error', `The order was approved, but the supplier message was not sent: ${error.message}`); }
    req.flash('success', `${order.poNumber} is approved and marked as ordered.`);
    // Incoming stock changes what needs attention, so the layer is told at once
    // rather than waiting for the next sweep to notice.
    react(req, managerEvents.TYPES.PURCHASE_ORDER_PLACED, {
      purchaseOrderId: order.id,
      poNumber: order.poNumber,
      skuIds: order.lines.map((line) => line.skuId),
      outstandingUnits: order.outstandingUnits,
    }, { sourceRecordType: 'purchase_order', sourceRecordId: `${order.id}:${order.updatedAt}` });
    return res.redirect(`/purchasing/orders/${order.id}`);
  })
);

router.post(
  '/purchasing/orders/:id/cancel',
  asyncRoute(async (req, res) => {
    guard(req, permissions.APPROVE_PO, 'cancel purchase orders');
    const order = poService.cancel(req.db, req.ctx, req.user, req.params.id, { reason: req.body.reason });
    req.flash('success', `${order.poNumber} was cancelled. Anything already received stays received.`);
    react(req, managerEvents.TYPES.PURCHASE_ORDER_CANCELLED, {
      purchaseOrderId: order.id, skuIds: order.lines.map((line) => line.skuId),
    }, { sourceRecordType: 'purchase_order', sourceRecordId: `${order.id}:${order.updatedAt}` });
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

/**
 * "It arrived, all of it, as ordered."
 *
 * The overwhelmingly common delivery: the boxes match the order. Foundry
 * already knows the products, the quantities outstanding and where they go, so
 * making somebody navigate to the order, open a form and retype numbers it
 * holds is work it should be doing for them.
 *
 * What it will not do is decide by itself that the delivery came. Nobody has
 * told Foundry the boxes are on the floor, and booking in ninety pairs of shoes
 * that are still on a lorry — or arrived short, or damaged — puts stock in the
 * ledger that does not exist. That is the one mistake an inventory system must
 * never make on its own.
 *
 * So the labour is automatic and the assertion stays with the person: one
 * button, one click, everything filled in from the order.
 */
router.post(
  '/purchasing/orders/:id/receive-all',
  asyncRoute(async (req, res) => {
    guard(req, permissions.RECEIVE_PO, 'book in deliveries');
    const { order, lines } = receiving.outstandingLines(req.db, req.ctx.workspaceId, req.params.id);
    if (!lines.length) {
      req.flash('info', `${order.poNumber} is already fully received.`);
      return res.redirect(303, `/purchasing/orders/${order.id}`);
    }
    try {
      const result = receiving.receive(req.db, req.ctx, req.user, order.id, {
        lines: lines.map((line) => ({ lineId: line.id, quantityUnits: line.outstandingUnits })),
        reference: trimOrNull(req.body.reference) || null,
        notes: 'Booked in as ordered',
        // A double-clicked button is one delivery, not two.
        idempotencyKey: `po-receipt-all:${order.id}:${lines.reduce((n, l) => n + l.outstandingUnits, 0)}`,
      });
      const current = poService.get(req.db, req.ctx.workspaceId, order.id);
      react(req,
        current.status === poService.STATUS.RECEIVED
          ? managerEvents.TYPES.PURCHASE_ORDER_COMPLETED
          : managerEvents.TYPES.PURCHASE_ORDER_PARTIALLY_RECEIVED,
        {
          purchaseOrderId: current.id,
          poNumber: current.poNumber,
          skuIds: current.lines.map((line) => line.skuId),
          outstandingUnits: current.outstandingUnits,
        },
        { sourceRecordType: 'purchase_order_receipt', sourceRecordId: result.receipt.id }
      );
      const units = (result.result || {}).unitsReceived || 0;
      req.flash(
        'success',
        result.replayed
          ? `${order.poNumber} was already booked in.`
          : `Booked in ${unitCount(units, 'unit')} against ${order.poNumber}. Stock is live.`
      );
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, `/purchasing/orders/${order.id}`);
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
    const sourceEvent = trimOrNull(req.query.event)
      ? physicalEvents.get(req.db, req.ctx.workspaceId, trimOrNull(req.query.event)) : null;
    const eventMatchesOrder = sourceEvent && sourceEvent.status === 'ROUTED' &&
      sourceEvent.matchedEntities.purchaseOrderId === order.id;
    const submitted = eventMatchesOrder ? {
      reference: sourceEvent.matchedEntities.documentNumber || sourceEvent.attachmentName || '',
      note: `Prepared by Foundry from ${sourceEvent.attachmentName || 'the attached receiving document'}`,
      physicalEventId: sourceEvent.id,
      ...Object.fromEntries((sourceEvent.matchedEntities.receiptLines || []).flatMap((line) => [
        [`qty_${line.lineId}`, line.quantityUnits],
        [`location_${line.lineId}`, line.locationId || ''],
      ])),
    } : null;
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
      submitted,
      sourceEvent: eventMatchesOrder ? sourceEvent : null,
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

      const physicalEventId = trimOrNull(req.body.physicalEventId);
      if (physicalEventId) physicalEvents.complete(req.db, req.ctx.workspaceId, physicalEventId);

      req.flash(
        'success',
        done.replayed
          ? 'That delivery was already booked in.'
          // "40 unit(s)" is the parenthetical plural the rest of the product
          // avoids; the value is known here, so the word can simply be right.
          : `${done.result.unitsReceived} ${done.result.unitsReceived === 1 ? 'unit' : 'units'} received against ${order.poNumber}.`
      );
      const current = poService.get(req.db, req.ctx.workspaceId, order.id);
      react(req,
        current.status === poService.STATUS.RECEIVED
          ? managerEvents.TYPES.PURCHASE_ORDER_COMPLETED
          : managerEvents.TYPES.PURCHASE_ORDER_PARTIALLY_RECEIVED,
        {
          purchaseOrderId: current.id,
          poNumber: current.poNumber,
          skuIds: current.lines.map((line) => line.skuId),
          outstandingUnits: current.outstandingUnits,
        },
        { sourceRecordType: 'purchase_order_receipt', sourceRecordId: done.receipt.id }
      );
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
        sourceEvent: trimOrNull(req.body.physicalEventId)
          ? physicalEvents.get(req.db, req.ctx.workspaceId, trimOrNull(req.body.physicalEventId)) : null,
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
    react(req, managerEvents.TYPES.SUPPLIER_UPDATED, { supplierId: supplier.id, change: 'created' });
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
      mailboxConnections: req.db.prepare(`SELECT id, display_name, provider_type, status, last_synced_at
        FROM workspace_connectors WHERE workspace_id = ? AND provider_type IN ('gmail','microsoft365','supplier_email')
        ORDER BY display_name COLLATE NOCASE`).all(req.ctx.workspaceId),
      senderRules: req.db.prepare(`SELECT r.*, wc.display_name AS connection_name FROM connection_email_rules r
        JOIN workspace_connectors wc ON wc.id = r.connector_id
        WHERE r.workspace_id = ? AND r.supplier_id = ? AND r.is_active = 1 ORDER BY r.sender_pattern COLLATE NOCASE`)
        .all(req.ctx.workspaceId, supplier.id),
      priceHistory: req.db.prepare(`SELECT h.*, s.code AS sku_code, i.name AS item_name
        FROM supplier_price_history h JOIN skus s ON s.id = h.sku_id JOIN items i ON i.id = s.item_id
        WHERE h.workspace_id = ? AND h.supplier_id = ? ORDER BY h.observed_at DESC LIMIT 20`)
        .all(req.ctx.workspaceId, supplier.id),
      codeMappings: supplierCodeMappings.listForSupplier(req.db, req.ctx.workspaceId, supplier.id),
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
    react(req, managerEvents.TYPES.SUPPLIER_UPDATED, { supplierId: req.params.id, change: 'terms_updated' });
    req.flash('success', 'Saved.');
    return res.redirect(`/suppliers/${req.params.id}`);
  })
);

router.post(
  '/suppliers/:id/senders',
  asyncRoute(async (req, res) => {
    guard(req, permissions.MANAGE_SUPPLIERS, 'manage suppliers');
    const supplier = supplierService.getSupplier(req.db, req.ctx.workspaceId, req.params.id);
    const connectorId = req.body.connectorId || supplier.watchedConnectorId;
    if (!connectorId) {
      req.flash('error', 'Connect Gmail or Microsoft 365 first, then choose that mailbox here.');
      return res.redirect(303, `/suppliers/${supplier.id}`);
    }
    require('../../connections/service').addEmailRule(req.db, req.ctx, connectorId, {
      senderPattern: req.body.senderPattern, supplierId: supplier.id, documentMode: 'supplier_documents',
    });
    supplierService.updateSupplier(req.db, req.ctx, req.user, supplier.id, { watchedConnectorId: connectorId });
    req.flash('success', `Foundry will treat messages from ${req.body.senderPattern} as trusted evidence for ${supplier.name}.`);
    return res.redirect(303, `/suppliers/${supplier.id}`);
  })
);

router.post(
  '/purchasing/orders/:id/send',
  asyncRoute(async (req, res) => {
    guard(req, permissions.APPROVE_PO, 'send purchase orders');
    const order = poService.get(req.db, req.ctx.workspaceId, req.params.id);
    if (['DRAFT', 'AWAITING_APPROVAL'].includes(order.status)) {
      throw new ValidationError('Approve this purchase order before sending it to the supplier.');
    }
    if (['CANCELLED', 'RECEIVED'].includes(order.status)) {
      throw new ValidationError(`A ${order.status.toLowerCase()} purchase order cannot be sent.`);
    }
    const communication = supplierCommunications.forOrder(req.db, req.ctx.workspaceId, order.id)[0];
    if (!communication) throw new ValidationError('This purchase order has no prepared supplier message.');
    try {
      await supplierCommunications.sendThroughMailbox(req.db, req.ctx.workspaceId, communication.id, req.ctx.actorId);
      req.flash('success', `${order.poNumber} was sent to ${order.supplierName}.`);
    } catch (error) {
      req.flash('error', error.message);
    }
    return res.redirect(303, `/purchasing/orders/${order.id}`);
  })
);

router.post(
  '/suppliers/:id/items',
  asyncRoute(async (req, res) => {
    guard(req, permissions.MANAGE_SUPPLIERS, 'manage suppliers');
    const linked = supplierService.linkItem(req.db, req.ctx, req.user, { ...req.body, supplierId: req.params.id });
    react(req, managerEvents.TYPES.SUPPLIER_UPDATED, {
      supplierId: req.params.id, skuIds: [req.body.skuId].filter(Boolean), change: 'product_linked',
    });
    req.flash('success', 'Product linked to this supplier.');
    return res.redirect(`/suppliers/${req.params.id}`);
  })
);

router.post(
  '/suppliers/:id/items/:supplierItemId/remove',
  asyncRoute(async (req, res) => {
    guard(req, permissions.MANAGE_SUPPLIERS, 'manage suppliers');
    supplierService.unlinkItem(req.db, req.ctx, req.user, req.params.supplierItemId);
    react(req, managerEvents.TYPES.SUPPLIER_UPDATED, { supplierId: req.params.id, change: 'product_unlinked' });
    req.flash('success', 'Removed from this supplier.');
    return res.redirect(`/suppliers/${req.params.id}`);
  })
);

router.post(
  '/suppliers/:id/code-mappings',
  asyncRoute(async (req, res) => {
    guard(req, permissions.MANAGE_SUPPLIERS, 'manage supplier code mappings');
    try {
      const proposal = supplierCodeMappings.preview(req.db, req.ctx, req.user, {
        supplierId: req.params.id,
        vendorCode: req.body.vendorCode,
        internalBaseCode: req.body.internalBaseCode,
      });
      return res.redirect(303, `/supplier-code-mappings/${proposal.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, `/suppliers/${req.params.id}#code-mappings`);
    }
  })
);

router.get(
  '/supplier-code-mappings/:id',
  asyncRoute(async (req, res) => {
    guard(req, permissions.VIEW_PURCHASING, 'review supplier code mappings');
    const proposal = supplierCodeMappings.getProposal(req.db, req.ctx.workspaceId, req.params.id);
    res.page('purchasing/code-mapping', {
      title: `Change ${proposal.vendorCode}`,
      nav: 'purchasing',
      proposal,
      canApply: permissions.can(req.user, permissions.MANAGE_SUPPLIERS),
    });
  })
);

router.post(
  '/supplier-code-mappings/:id/apply',
  asyncRoute(async (req, res) => {
    guard(req, permissions.MANAGE_SUPPLIERS, 'approve supplier code mappings');
    try {
      const applied = supplierCodeMappings.apply(req.db, req.ctx, req.user, req.params.id);
      req.flash('success', `${applied.vendorCode} will stay the vendor code. Foundry now uses ${applied.internalBaseCode} as your code and will remember that mapping.`);
      return res.redirect(303, `/suppliers/${applied.supplierId}#code-mappings`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, `/supplier-code-mappings/${req.params.id}`);
    }
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
      react(req, managerEvents.TYPES.REORDER_POLICY_UPDATED, { skuIds, change: 'bulk_setup' });
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
      react(req, managerEvents.TYPES.SUPPLIER_UPDATED, {
        supplierId, skuIds, change: 'bulk_product_link',
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

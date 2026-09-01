'use strict';

const express = require('express');
const engine = require('../../domain/inventory-engine');
const itemService = require('../../domain/item-service');
const inventoryQuery = require('../../domain/inventory-query');
const repo = require('../../domain/repository');
const { ValidationError } = require('../../domain/errors');
const reevaluate = require('../../attention/reevaluate');
const planApplier = require('../../foundry/plan-applier');
const attention = require('../../attention/attention-engine');
const presenter = require('../../attention/presenter');
const purchasingPolicy = require('../../purchasing/policy-service');
const supplierService = require('../../purchasing/supplier-service');
const replenishmentPlan = require('../../purchasing/replenishment-plan');
const signalEngine = require('../../signals/signal-engine');
const permissions = require('../../actions/permissions');
const salesOrders = require('../../sales/sales-order-service');
const purchasingPosition = require('../../purchasing/position');
const prices = require('../../pricing/price-service');
const operatingInstructions = require('../../manager/operating-instructions');
const { requireAuth, asyncRoute } = require('../middleware');
const { toArray, trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use('/inventory', requireAuth);

function currentReplenishmentPlan(db, workspaceId, finding) {
  if (finding.category !== 'replenishment_needed' && !finding.relatedCategories.includes('replenishment_needed')) return null;
  const skuId = (finding.affectedEntityIds || [])[0];
  if (!skuId) return null;
  try {
    const sku = signalEngine.skuSignals(db, workspaceId, { skuIds: [skuId] })[0];
    return sku ? replenishmentPlan.buildPlan(db, workspaceId, sku) : null;
  } catch {
    return null;
  }
}

function presentItemFindings(db, workspaceId, findings) {
  return presenter.presentAll(db, workspaceId, findings).map((shown, index) => {
    const plan = currentReplenishmentPlan(db, workspaceId, findings[index]);
    if (!plan?.prepared?.orders?.length || plan.purchase || plan.transfers.length) return shown;
    const order = plan.prepared.orders[0];
    const numbers = plan.prepared.orders.map((entry) => entry.poNumber).join(', ');
    return {
      ...shown,
      title: `${plan.displayName}: ${plan.prepared.units} ${plan.unitLabel}(s) ready to order`,
      conciseSummary: `${plan.onHandTotal} on hand. ${numbers} is still a draft; nothing has been ordered yet.`,
      actionHref: `/purchasing/orders/${order.poId}`,
      actionLabel: plan.prepared.orders.length === 1 ? `Review ${order.poNumber}` : 'Review orders',
    };
  });
}

/**
 * The console authorises exactly like everything else.
 *
 * permissions.js states the rule it exists to keep — "every action authorises
 * here, on the server, before anything is validated or executed; hiding a
 * button is presentation, not security" — and the actions pipeline and
 * purchasing both honour it. These routes did not check at all, so the manual
 * screens were a way round the whole scheme: a staff member could correct a
 * count, which is the one operation that changes a balance without stock
 * moving, and is deliberately withheld from them.
 *
 * The permission is the one the action already declares in ACTION_PERMISSION,
 * so the console and Tell Foundry can never drift apart on who may do what.
 */
const may = (actionType) => (req, res, next) => {
  try {
    permissions.assertCanPerform(req.user, actionType);
    return next();
  } catch (error) {
    return next(error);
  }
};

/** Serial numbers are entered one per line; blank lines are ignored. */
function parseSerialLines(raw, condition) {
  const lines = String(raw || '')
    .split(/[\r\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new ValidationError('Enter at least one serial number, one per line.', { field: 'serials' });
  }
  return lines.map((serial) => ({ serial, condition: condition || 'good' }));
}

function normaliseOptionInput(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : Object.keys(raw).sort().map((key) => raw[key]);
  return list.filter(Boolean).map((entry) => ({ name: entry.name, values: entry.values }));
}

router.get(
  '/inventory',
  asyncRoute(async (req, res) => {
    const limit = 25;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const sourceDocument = /^sdoc_[a-z0-9]+$/i.test(String(req.query.sourceDocument || ''))
      ? String(req.query.sourceDocument) : null;
    let sourceLabel = null;
    let sourceItemIds = [];
    if (sourceDocument) {
      const document = req.db.prepare('SELECT source_name, result FROM setup_documents WHERE workspace_id = ? AND id = ?')
        .get(req.ctx.workspaceId, sourceDocument);
      if (document) {
        try { sourceItemIds = JSON.parse(document.result || '{}').createdItemIds || []; } catch { sourceItemIds = []; }
        if (sourceItemIds.length) sourceLabel = document.source_name;
      }
    }
    const filters = {
      q: trimOrNull(req.query.q) || '',
      trackingMode: trimOrNull(req.query.tracking) || '',
      locationId: trimOrNull(req.query.location) || '',
      sort: trimOrNull(req.query.sort) || 'name',
      includeArchived: Boolean(sourceLabel) || req.query.archived === '1' || req.query.archived === 'only',
      archivedOnly: req.query.archived === 'only',
      itemIds: sourceItemIds,
      limit,
      offset: (page - 1) * limit,
    };
    const result = inventoryQuery.listItems(req.db, req.ctx.workspaceId, filters);
    const locations = repo.listLocations(req.db, req.ctx.workspaceId);
    let returnTo = null;
    let returnLabel = null;
    const fromConnection = /^con_[a-z0-9]+$/i.test(String(req.query.fromConnection || ''))
      ? String(req.query.fromConnection) : null;
    const fromMessage = /^(?:emsg|emailmsg)_[a-z0-9]+$/i.test(String(req.query.fromMessage || ''))
      ? String(req.query.fromMessage) : null;
    if (fromConnection) {
      const source = req.db.prepare(`SELECT id, display_name, provider_type FROM workspace_connectors
        WHERE workspace_id = ? AND id = ?`).get(req.ctx.workspaceId, fromConnection);
      if (source) {
        returnTo = `/settings/connections/${source.id}${fromMessage ? `#message-${fromMessage}` : ''}`;
        returnLabel = source.provider_type === 'microsoft365' ? 'Microsoft 365'
          : source.provider_type === 'gmail' ? 'Gmail' : source.display_name;
      }
    }

    /*
     * What a person actually needs to read off this list.
     *
     * The table showed on hand and how it is tracked, so the two numbers that
     * decide anything — how much is genuinely free to sell, and how much is
     * already on its way — were not on the page. Somebody looking at "19 on
     * hand" could not tell whether all nineteen were promised to a customer.
     *
     * Composed here from the read-only helpers that already exist, so this adds
     * no query and no rule of its own: committedByPosition is what Sales has
     * already promised, onOrderBySku is what Purchasing has already placed.
     */
    const skuIdsByItem = new Map();
    for (const item of result.items) {
      const skus = repo.listSkusForItem(req.db, req.ctx.workspaceId, item.id) || [];
      skuIdsByItem.set(item.id, skus.map((sku) => sku.id));
    }
    const allSkuIds = [...skuIdsByItem.values()].flat();

    const committedBySku = new Map();
    const onOrderBySku = new Map();
    if (allSkuIds.length) {
      for (const row of salesOrders.committedByPosition(req.db, req.ctx.workspaceId, { skuIds: allSkuIds })) {
        // Committed is per position; the list is per product, so it sums.
        committedBySku.set(row.sku_id, (committedBySku.get(row.sku_id) || 0) + (row.committed || 0));
      }
      // A Map of skuId to an entry, not a plain object of numbers.
      const onOrder = purchasingPosition.onOrderBySku(req.db, req.ctx.workspaceId, { skuIds: allSkuIds });
      for (const [skuId, entry] of onOrder) {
        onOrderBySku.set(skuId, Number(entry && entry.onOrder) || 0);
      }
    }

    const items = result.items.map((item) => {
      const skuIds = skuIdsByItem.get(item.id) || [];
      const committed = skuIds.reduce((total, id) => total + (committedBySku.get(id) || 0), 0);
      const onOrder = skuIds.reduce((total, id) => total + (onOrderBySku.get(id) || 0), 0);
      return {
        ...item,
        committed,
        onOrder,
        // Never below zero: a promise beyond what is held is a shortfall to
        // explain elsewhere, not a negative number to print in a column.
        available: Math.max(0, (item.on_hand || 0) - committed),
      };
    });

    res.page('inventory/list', {
      title: 'Inventory',
      nav: 'inventory',
      items,
      hasMore: result.hasMore,
      page,
      filters,
      locations,
      returnTo,
      returnLabel,
      fromConnection,
      fromMessage,
      sourceDocument: sourceLabel ? sourceDocument : null,
      sourceLabel,
    });
  })
);

router.get(
  '/inventory/new',
  asyncRoute(async (req, res) => {
    // Somebody who described "size: 0-6 months, 6-12 months / colour: white,
    // red, blue" during setup has already told Foundry their option axes, and
    // Foundry wrote them down. Presenting an empty form here asks them to type
    // it all again and makes the configuration look like it did nothing.
    //
    // This is a starting point, not a decision: every field is editable and
    // clearing them is one keystroke. Nothing is created until they submit.
    const configuration = planApplier.getConfiguration(req.db, req.ctx.workspaceId);
    const model = (configuration && configuration.inventoryModel) || {};
    const dimensions = Array.isArray(model.variantDimensions) ? model.variantDimensions : [];

    const form = {};
    const requestedName = trimOrNull(req.query.name);
    if (requestedName) form.name = requestedName;
    const resumeInstructionId = /^oin_[a-z0-9]+$/i.test(String(req.query.resumeInstructionId || ''))
      ? String(req.query.resumeInstructionId)
      : null;
    if (model.usesVariants && dimensions.length) {
      form.hasVariants = true;
      form.options = dimensions.slice(0, 3).map((dimension) => ({
        name: dimension.name || '',
        values: (dimension.exampleValues || []).join(', '),
      }));
    }

    res.page('inventory/new', {
      title: 'Add an item',
      nav: 'inventory',
      form,
      resumeInstructionId,
      // So the page can say where the suggestion came from rather than having
      // values appear from nowhere.
      fromConfiguration: Boolean(form.options),
    });
  })
);

router.post(
  '/inventory',
  may('create_item'),
  asyncRoute(async (req, res) => {
    const hasVariants = req.body.hasVariants === '1' || req.body.hasVariants === 'on';
    let created;
    try {
      created = itemService.createItem(req.db, req.ctx, {
        name: req.body.name,
        baseCode: req.body.baseCode,
        description: req.body.description,
        unitLabel: req.body.unitLabel,
        trackingMode: req.body.trackingMode,
        hasVariants,
        options: hasVariants ? normaliseOptionInput(req.body.options) : [],
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).page('inventory/new', {
          title: 'Add an item',
          nav: 'inventory',
          form: req.body,
          resumeInstructionId: /^oin_[a-z0-9]+$/i.test(String(req.body.resumeInstructionId || ''))
            ? String(req.body.resumeInstructionId)
            : null,
          error: err.message,
        });
      }
      throw err;
    }
    const resumeInstructionId = /^oin_[a-z0-9]+$/i.test(String(req.body.resumeInstructionId || ''))
      ? String(req.body.resumeInstructionId)
      : null;
    if (resumeInstructionId) {
      const continued = operatingInstructions.selectProduct(
        req.db, req.ctx, req.user, resumeInstructionId, created.skuIds[0]
      );
      return res.redirect(303, `/operating-instructions/${continued.id}`);
    }
    req.flash('success', 'Item created. Receive some stock to get started.');
    return res.redirect(303, `/inventory/${created.itemId}`);
  })
);

router.get(
  '/inventory/:id',
  asyncRoute(async (req, res) => {
    const detail = itemService.getItemDetail(req.db, req.ctx.workspaceId, req.params.id);
    const commitments = [];
    for (const sku of detail.skus) {
      const position = salesOrders.availabilityForSku(req.db, req.ctx.workspaceId, sku.id);
      sku.committed = position.committed;
      sku.available = position.available;
      sku.onOrder = purchasingPosition.onOrderForSku(req.db, req.ctx.workspaceId, sku.id).onOrder;
      sku.sellingPrice = prices.currentForSku(req.db, req.ctx.workspaceId, sku.id);
      sku.purchaseCost = prices.purchaseCostForSku(req.db, req.ctx.workspaceId, sku.id);
      const byLocation = new Map(position.positions.map((row) => [row.location_id, row]));
      sku.perLocation = sku.perLocation.map((row) => ({ ...row,
        committed: byLocation.get(row.locationId)?.committed || 0,
        available: byLocation.get(row.locationId)?.available ?? row.onHand }));
      commitments.push(...salesOrders.commitmentsForSku(req.db, req.ctx.workspaceId, sku.id)
        .map((entry) => ({ ...entry, skuId: sku.id, displayName: sku.variant_label || detail.item.name })));
    }
    detail.committed = detail.skus.reduce((sum, sku) => sum + sku.committed, 0);
    detail.available = detail.total - detail.committed;
    detail.onOrder = detail.skus.reduce((sum, sku) => sum + Number(sku.onOrder || 0), 0);
    // What Foundry has noticed about this record, on the record itself.
    const findings = attention.listAttentionForItem(req.db, req.ctx.workspaceId, req.params.id);
    const purchasingLines = detail.skus.map((sku) => ({
      skuId: sku.id,
      label: sku.variant_label || detail.item.name,
      total: sku.total,
      policy: purchasingPolicy.effectivePolicy(req.db, req.ctx.workspaceId, sku.id),
      suppliers: supplierService.suppliersForSku(req.db, req.ctx.workspaceId, sku.id),
    }));
    res.page('inventory/item', {
      title: detail.item.name,
      nav: 'inventory',
      ...detail,
      attention: presentItemFindings(req.db, req.ctx.workspaceId, findings),
      purchasingLines,
      commitments,
    });
  })
);

router.post(
  '/inventory/:id/details',
  may('create_item'),
  asyncRoute(async (req, res) => {
    itemService.updateItem(req.db, req.ctx, req.params.id, {
      name: req.body.name,
      baseCode: req.body.baseCode,
      description: req.body.description,
      unitLabel: req.body.unitLabel,
      allowNegative: req.body.allowNegative,
    });
    req.flash('success', 'Item details saved.');
    res.redirect(303, `/inventory/${req.params.id}`);
  })
);

router.post(
  '/inventory/:id/variants',
  may('create_item'),
  asyncRoute(async (req, res) => {
    const values = req.body.optionValues || {};
    const result = itemService.addVariant(req.db, req.ctx, req.params.id, values);
    req.flash('success', `Added variant ${result.label}.`);
    res.redirect(303, `/inventory/${req.params.id}`);
  })
);

router.post(
  '/inventory/:id/archive',
  may('create_item'),
  asyncRoute(async (req, res) => {
    const archived = req.body.restore !== '1';
    itemService.setItemActive(req.db, req.ctx, req.params.id, !archived);
    req.flash('success', archived ? 'Item archived.' : 'Item restored.');
    res.redirect(303, `/inventory/${req.params.id}`);
  })
);

router.post(
  '/inventory/:id/receive',
  may('receive'),
  asyncRoute(async (req, res) => {
    const item = repo.requireItem(req.db, req.ctx.workspaceId, req.params.id);
    const input = {
      skuId: req.body.skuId,
      locationId: req.body.locationId,
      quantity: req.body.quantity,
      notes: req.body.notes,
      reference: req.body.reference,
    };
    if (item.tracking_mode === 'serial') {
      input.serials = parseSerialLines(req.body.serials, req.body.condition);
    }
    if (item.tracking_mode === 'lot') {
      input.lotCode = req.body.lotCode;
      input.expiresAt = req.body.expiresAt;
      input.lotReceivedAt = req.body.lotReceivedAt;
    }
    const result = engine.receive(req.db, req.ctx, input);
    // After the movement has committed, never inside it. See attention/reevaluate.
    reevaluate.afterMovement(req.db, req.ctx.workspaceId, [input.skuId], 'receive');
    const into = repo.requireLocation(req.db, req.ctx.workspaceId, input.locationId);
    req.flash('success', `Received ${result.quantity} into ${into.name}.`);
    res.redirect(303, `/inventory/${req.params.id}`);
  })
);

router.post(
  '/inventory/:id/issue',
  may('issue'),
  asyncRoute(async (req, res) => {
    const item = repo.requireItem(req.db, req.ctx.workspaceId, req.params.id);
    const input = {
      skuId: req.body.skuId,
      locationId: req.body.locationId,
      quantity: req.body.quantity,
      reasonCode: req.body.reasonCode,
      notes: req.body.notes,
      reference: req.body.reference,
      // Stock rarely leaves on the day somebody gets around to typing it in.
      // Foundry works out what to reorder from when things actually went, so a
      // week of sales entered on Friday must not read as a Friday spike.
      occurredAt: trimOrNull(req.body.occurredAt),
    };
    if (item.tracking_mode === 'serial') input.serialUnitIds = toArray(req.body.serialUnitIds);
    if (item.tracking_mode === 'lot') input.lotId = req.body.lotId;
    const result = engine.issue(req.db, req.ctx, input);
    reevaluate.afterMovement(req.db, req.ctx.workspaceId, [input.skuId], 'issue');
    const from = repo.requireLocation(req.db, req.ctx.workspaceId, input.locationId);
    req.flash('success', `Issued ${result.quantity} from ${from.name}.`);
    res.redirect(303, `/inventory/${req.params.id}`);
  })
);

router.post(
  '/inventory/:id/transfer',
  may('transfer'),
  asyncRoute(async (req, res) => {
    const item = repo.requireItem(req.db, req.ctx.workspaceId, req.params.id);
    const input = {
      skuId: req.body.skuId,
      fromLocationId: req.body.fromLocationId,
      toLocationId: req.body.toLocationId,
      quantity: req.body.quantity,
      notes: req.body.notes,
      reference: req.body.reference,
    };
    if (item.tracking_mode === 'serial') input.serialUnitIds = toArray(req.body.serialUnitIds);
    if (item.tracking_mode === 'lot') input.lotId = req.body.lotId;
    const result = engine.transfer(req.db, req.ctx, input);
    reevaluate.afterMovement(req.db, req.ctx.workspaceId, [input.skuId], 'transfer');
    const from = repo.requireLocation(req.db, req.ctx.workspaceId, input.fromLocationId);
    const to = repo.requireLocation(req.db, req.ctx.workspaceId, input.toLocationId);
    req.flash('success', `Transferred ${result.quantity} from ${from.name} to ${to.name}.`);
    res.redirect(303, `/inventory/${req.params.id}`);
  })
);

router.post(
  '/inventory/:id/adjust',
  may('adjust'),
  asyncRoute(async (req, res) => {
    const item = repo.requireItem(req.db, req.ctx.workspaceId, req.params.id);
    const input = {
      skuId: req.body.skuId,
      locationId: req.body.locationId,
      countedQty: req.body.countedQty,
      reasonCode: req.body.reasonCode,
      notes: req.body.notes,
      reference: req.body.reference,
    };
    if (item.tracking_mode === 'serial') input.serialUnitIds = toArray(req.body.serialUnitIds);
    if (item.tracking_mode === 'lot') input.lotId = req.body.lotId;
    const result = engine.adjust(req.db, req.ctx, input);
    reevaluate.afterMovement(req.db, req.ctx.workspaceId, [input.skuId], 'adjust');
    const message =
      item.tracking_mode === 'serial'
        ? `Wrote off ${Math.abs(result.quantity)} ${Math.abs(result.quantity) === 1 ? 'unit' : 'units'}.`
        : `Adjusted from ${result.expected} to ${result.counted}.`;
    req.flash('success', message);
    res.redirect(303, `/inventory/${req.params.id}`);
  })
);

module.exports = router;

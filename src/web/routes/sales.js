'use strict';

const express = require('express');
const sales = require('../../sales/sales-order-service');
const salesIntent = require('../../sales/sales-intent');
const repo = require('../../domain/repository');
const permissions = require('../../actions/permissions');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');
const prices = require('../../pricing/price-service');

const router = express.Router();
router.use('/sales', requireAuth);

function requirePermission(permission, what) {
  return (req, res, next) => {
    try { permissions.assertCan(req.user, permission, what); return next(); }
    catch (error) { return next(error); }
  };
}

function catalogue(db, workspaceId) {
  return db.prepare(`SELECT s.id, s.code, s.variant_label, i.id AS item_id, i.name AS item_name,
      CASE WHEN s.variant_label IS NULL OR s.variant_label = '' THEN i.name
           ELSE i.name || ' / ' || s.variant_label END AS display_name
    FROM skus s JOIN items i ON i.id = s.item_id
    WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
    ORDER BY i.name COLLATE NOCASE, s.position`).all(workspaceId)
    .map((sku) => ({ ...sku, price: prices.currentForSku(db, workspaceId, sku.id) }));
}

router.get('/sales', requirePermission(permissions.VIEW, 'view sales orders'), asyncRoute(async (req, res) => {
  const status = trimOrNull(req.query.status);
  const sellingConnectionCount = req.db.prepare(
    "SELECT COUNT(*) AS n FROM workspace_connectors WHERE workspace_id = ? AND status = 'connected' AND provider_type IN ('shopify','square','clover','woocommerce','reference_webhook')"
  ).get(req.ctx.workspaceId).n;
  res.page('sales/orders', {
    title: 'Sales', nav: 'sales', status,
    sellingConnectionCount,
    orders: sales.listOrders(req.db, req.ctx.workspaceId, { status, limit: 200 }),
    completedSales: sales.listCompletedSales(req.db, req.ctx.workspaceId, { limit: 200 }),
    customers: sales.listCustomers(req.db, req.ctx.workspaceId),
  });
}));

router.get('/sales/new', requirePermission(permissions.OPERATE, 'create sales orders'), asyncRoute(async (req, res) => {
  const skus = catalogue(req.db, req.ctx.workspaceId);
  res.page('sales/order-new', {
    title: 'New sales order', nav: 'sales', customers: sales.listCustomers(req.db, req.ctx.workspaceId),
    skus, locations: repo.listLocations(req.db, req.ctx.workspaceId), form: {}, formError: null,
    unpricedCount: skus.filter((sku) => !sku.price.isSet).length,
  });
}));

router.get('/sales/customers/:id', requirePermission(permissions.VIEW, 'view customers'), asyncRoute(async (req, res) => {
  res.page('sales/customer', {
    title: 'Customer', nav: 'sales', customer: sales.getCustomer(req.db, req.ctx.workspaceId, req.params.id),
  });
}));

router.post('/sales/customers/:id', requirePermission(permissions.OPERATE, 'change customers'), asyncRoute(async (req, res) => {
  const customer = sales.updateCustomer(req.db, req.ctx, req.params.id, {
    name: req.body.name, company: req.body.company, email: req.body.email, phone: req.body.phone,
    shippingAddress: req.body.shippingAddress, notes: req.body.notes,
  });
  req.flash('success', `${customer.name} was updated.`);
  res.redirect(303, `/sales/customers/${customer.id}`);
}));

router.post('/sales/orders', requirePermission(permissions.OPERATE, 'create sales orders'), asyncRoute(async (req, res) => {
  const skuIds = Array.isArray(req.body.skuId) ? req.body.skuId : [req.body.skuId];
  const quantities = Array.isArray(req.body.quantity) ? req.body.quantity : [req.body.quantity];
  let order;
  try {
    const enteredPrice = prices.toMinor(trimOrNull(req.body.unitPrice), 'Selling price');
    order = sales.createOrder(req.db, req.ctx, {
      customerId: trimOrNull(req.body.customerId), customerName: trimOrNull(req.body.customerName),
      orderNumber: trimOrNull(req.body.orderNumber), orderDate: trimOrNull(req.body.orderDate),
      neededBy: trimOrNull(req.body.neededBy), fulfillmentLocationId: trimOrNull(req.body.fulfillmentLocationId),
      notes: trimOrNull(req.body.notes), reference: trimOrNull(req.body.reference),
      currency: trimOrNull(req.body.currency), discount: trimOrNull(req.body.discount), tax: trimOrNull(req.body.tax),
      requirePrices: true,
      lines: skuIds.map((skuId, index) => ({ skuId, quantity: quantities[index],
        unitPriceMinor: enteredPrice })).filter((line) => line.skuId),
    });
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    const skus = catalogue(req.db, req.ctx.workspaceId);
    return res.status(err.status).page('sales/order-new', {
      title: 'New sales order', nav: 'sales', customers: sales.listCustomers(req.db, req.ctx.workspaceId),
      skus, locations: repo.listLocations(req.db, req.ctx.workspaceId), form: req.body,
      formError: err.message, unpricedCount: skus.filter((sku) => !sku.price.isSet).length,
    });
  }
  req.flash('success', `${order.order_number} is a draft. Confirm it when the customer has committed.`);
  res.redirect(303, `/sales/orders/${order.id}`);
}));

router.get('/sales/orders/:id', requirePermission(permissions.VIEW, 'view sales orders'), asyncRoute(async (req, res) => {
  const order = sales.getOrder(req.db, req.ctx.workspaceId, req.params.id);

  /*
   * How much of what this order is short is actually on the shelf right now.
   *
   * Stock is allocated when an order is confirmed, and not again. So a delivery
   * can arrive against the very shortfall an order is waiting for, and the
   * order goes on saying "the rest is not in stock yet" with sixty units in the
   * store room. Read from the same helper Sales already uses, so the page can
   * describe the situation truthfully instead of repeating what was true when
   * it was confirmed.
   */
  let shortButAvailable = 0;
  if (order && order.totals.backordered) {
    for (const line of order.lines) {
      if (!line.backordered) continue;
      const free = sales.availabilityForSku(req.db, req.ctx.workspaceId, line.sku_id).available || 0;
      shortButAvailable += Math.min(Number(line.backordered), Math.max(0, free));
    }
  }

  res.page('sales/order', {
    title: 'Sales order', nav: 'sales', order,
    shortButAvailable,
    skus: catalogue(req.db, req.ctx.workspaceId),
  });
}));

router.post('/sales/orders/:id/confirm', requirePermission(permissions.OPERATE, 'confirm sales orders'), asyncRoute(async (req, res) => {
  let order;
  try {
    order = sales.confirm(req.db, req.ctx, req.params.id, { idempotencyKey: `web-confirm:${req.params.id}` });
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
    return res.redirect(303, `/sales/orders/${req.params.id}`);
  }
  req.flash(order.totals.backordered ? 'warn' : 'success', order.totals.backordered
    ? `${order.order_number} is confirmed. ${order.totals.allocated} allocated; ${order.totals.backordered} waiting for stock.`
    : `${order.order_number} is confirmed and ${order.totals.allocated} unit(s) are committed.`);
  res.redirect(303, `/sales/orders/${order.id}`);
}));

router.post('/sales/orders/:id/lines', requirePermission(permissions.OPERATE, 'change sales orders'), asyncRoute(async (req, res) => {
  const unitPriceMinor = prices.toMinor(trimOrNull(req.body.unitPrice), 'Selling price');
  const order = sales.addLine(req.db, req.ctx, req.params.id, { skuId: req.body.skuId,
    quantity: req.body.quantity, unitPriceMinor },
    { idempotencyKey: trimOrNull(req.body.idempotencyKey) });
  req.flash('success', `${order.order_number} was updated. Current allocation has been recalculated.`);
  res.redirect(303, `/sales/orders/${order.id}`);
}));

router.post('/sales/clarify', requirePermission(permissions.OPERATE, 'create or change sales orders'), asyncRoute(async (req, res) => {
  const continuation = req.session.pendingSalesContinuation;
  if (!continuation) {
    req.flash('info', 'That customer-order question is no longer waiting. Please send the order again.');
    return res.redirect(303, '/#tell-foundry');
  }
  let result;
  try {
    result = salesIntent.continueApply(req.db, req.ctx, continuation, trimOrNull(req.body.answer), {
      idempotencyKey: `tell-sales-continuation:${req.sessionID}`,
    });
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.session.pendingActionQuestion = {
      question: err.message, instruction: trimOrNull(req.body.original) || '', choices: null,
      answerAction: '/sales/clarify',
    };
    return res.redirect(303, '/actions');
  }
  if (result.kind === 'question') {
    req.session.pendingSalesContinuation = result.continuation;
    req.session.pendingActionQuestion = {
      question: result.question, instruction: trimOrNull(req.body.original) || '',
      choices: result.choices || null, answerAction: '/sales/clarify',
    };
    return res.redirect(303, '/actions');
  }
  delete req.session.pendingSalesContinuation;
  if (result.kind === 'list') return res.redirect(303, '/sales?status=BACKORDERED');
  req.flash(result.order.totals.backordered ? 'warn' : 'success',
    `${result.order.order_number} is ${result.order.status.toLowerCase().replace(/_/g, ' ')}. `
    + `${result.order.totals.allocated} committed and ${result.order.totals.backordered} waiting for stock.`);
  return res.redirect(303, `/sales/orders/${result.order.id}`);
}));

router.post('/sales/orders/:id/fulfill', requirePermission(permissions.OPERATE, 'fulfill sales orders'), asyncRoute(async (req, res) => {
  const lineIds = Array.isArray(req.body.lineId) ? req.body.lineId : [req.body.lineId];
  const locationIds = Array.isArray(req.body.locationId) ? req.body.locationId : [req.body.locationId];
  const quantities = Array.isArray(req.body.quantity) ? req.body.quantity : [req.body.quantity];
  const lines = lineIds.map((lineId, index) => ({ lineId, locationId: locationIds[index], quantity: quantities[index] }))
    .filter((line) => line.lineId && Number(line.quantity) > 0);
  const order = sales.fulfill(req.db, req.ctx, req.params.id, { lines },
    { idempotencyKey: trimOrNull(req.body.idempotencyKey) });
  req.flash('success', order.status === 'FULFILLED'
    ? `${order.order_number} is fulfilled. Physical stock and commitments were both updated.`
    : `${order.order_number} was partly fulfilled. ${order.totals.allocated} remain committed and ${order.totals.backordered} are waiting for stock.`);
  res.redirect(303, `/sales/orders/${order.id}`);
}));

router.post('/sales/orders/:id/cancel', requirePermission(permissions.OPERATE, 'cancel sales orders'), asyncRoute(async (req, res) => {
  const order = sales.cancel(req.db, req.ctx, req.params.id, trimOrNull(req.body.reason));
  req.flash('success', `${order.order_number} was cancelled. Its remaining commitments were released immediately.`);
  res.redirect(303, `/sales/orders/${order.id}`);
}));

module.exports = router;

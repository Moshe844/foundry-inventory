'use strict';

const express = require('express');
const sales = require('../../sales/sales-order-service');
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
  return db.prepare(`SELECT s.id, s.code, s.variant_label, i.name AS item_name,
      CASE WHEN s.variant_label IS NULL OR s.variant_label = '' THEN i.name
           ELSE i.name || ' / ' || s.variant_label END AS display_name
    FROM skus s JOIN items i ON i.id = s.item_id
    WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
    ORDER BY i.name COLLATE NOCASE, s.position`).all(workspaceId)
    .map((sku) => ({ ...sku, price: prices.currentForSku(db, workspaceId, sku.id) }));
}

router.get('/sales', requirePermission(permissions.VIEW, 'view sales orders'), asyncRoute(async (req, res) => {
  const status = trimOrNull(req.query.status);
  res.page('sales/orders', {
    title: 'Sales', nav: 'sales', status,
    orders: sales.listOrders(req.db, req.ctx.workspaceId, { status, limit: 200 }),
    completedSales: sales.listCompletedSales(req.db, req.ctx.workspaceId, { limit: 200 }),
    customers: sales.listCustomers(req.db, req.ctx.workspaceId),
  });
}));

router.get('/sales/new', requirePermission(permissions.OPERATE, 'create sales orders'), asyncRoute(async (req, res) => {
  res.page('sales/order-new', {
    title: 'New sales order', nav: 'sales', customers: sales.listCustomers(req.db, req.ctx.workspaceId),
    skus: catalogue(req.db, req.ctx.workspaceId), locations: repo.listLocations(req.db, req.ctx.workspaceId),
    form: {},
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
  const order = sales.createOrder(req.db, req.ctx, {
    customerId: trimOrNull(req.body.customerId), customerName: trimOrNull(req.body.customerName),
    orderNumber: trimOrNull(req.body.orderNumber), orderDate: trimOrNull(req.body.orderDate),
    neededBy: trimOrNull(req.body.neededBy), fulfillmentLocationId: trimOrNull(req.body.fulfillmentLocationId),
    notes: trimOrNull(req.body.notes), reference: trimOrNull(req.body.reference),
    currency: trimOrNull(req.body.currency), discount: trimOrNull(req.body.discount), tax: trimOrNull(req.body.tax),
    lines: skuIds.map((skuId, index) => ({ skuId, quantity: quantities[index] })).filter((line) => line.skuId),
  });
  req.flash('success', `${order.order_number} is a draft. Confirm it when the customer has committed.`);
  res.redirect(303, `/sales/orders/${order.id}`);
}));

router.get('/sales/orders/:id', requirePermission(permissions.VIEW, 'view sales orders'), asyncRoute(async (req, res) => {
  res.page('sales/order', {
    title: 'Sales order', nav: 'sales', order: sales.getOrder(req.db, req.ctx.workspaceId, req.params.id),
    skus: catalogue(req.db, req.ctx.workspaceId),
  });
}));

router.post('/sales/orders/:id/confirm', requirePermission(permissions.OPERATE, 'confirm sales orders'), asyncRoute(async (req, res) => {
  const order = sales.confirm(req.db, req.ctx, req.params.id, { idempotencyKey: `web-confirm:${req.params.id}` });
  req.flash(order.totals.backordered ? 'warn' : 'success', order.totals.backordered
    ? `${order.order_number} is confirmed. ${order.totals.allocated} allocated; ${order.totals.backordered} waiting for stock.`
    : `${order.order_number} is confirmed and ${order.totals.allocated} unit(s) are committed.`);
  res.redirect(303, `/sales/orders/${order.id}`);
}));

router.post('/sales/orders/:id/lines', requirePermission(permissions.OPERATE, 'change sales orders'), asyncRoute(async (req, res) => {
  const order = sales.addLine(req.db, req.ctx, req.params.id, { skuId: req.body.skuId, quantity: req.body.quantity },
    { idempotencyKey: trimOrNull(req.body.idempotencyKey) });
  req.flash('success', `${order.order_number} was updated. Current allocation has been recalculated.`);
  res.redirect(303, `/sales/orders/${order.id}`);
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

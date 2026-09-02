'use strict';

const express = require('express');
const sales = require('../../sales/sales-order-service');
const salesIntent = require('../../sales/sales-intent');
const shipments = require('../../sales/shipment-service');
const carriers = require('../../sales/carriers');
const notices = require('../../sales/customer-communications');
const paymentTerms = require('../../sales/payment-terms');
const orderStatus = require('../../sales/order-status');
const connections = require('../../connections/service');
const repo = require('../../domain/repository');
const permissions = require('../../actions/permissions');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');
const { ValidationError } = require('../../domain/errors');
const prices = require('../../pricing/price-service');

/*
 * Two addresses, one page, on purpose.
 *
 * The nav now says Orders and Money, so those are the addresses it uses. The
 * older paths keep serving the same handler rather than redirecting, because
 * they are in bookmarks, in links across the app and in a year of tests, and a
 * redirect would still be two addresses with a round trip added. Nothing here
 * renders differently depending on which one you arrive by.
 */
const router = express.Router();
router.use(['/sales', '/orders'], requireAuth);
// Fulfilment lives on its own path because it is its own job, so it needs
// the same guard stated separately rather than inherited from /sales.
router.use('/fulfilment', requireAuth);

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

/**
 * What this order is worth, what has been paid, what is still owed — and what
 * that permits.
 *
 * This used to compute paid and outstanding here, alongside a second copy of
 * the same arithmetic in the payment-terms engine. Two functions answering "how
 * much does this customer owe" is one too many: they cannot disagree today and
 * they certainly will eventually. The engine is the answer, and this shapes it
 * for the page.
 */
function moneyForOrder(db, workspaceId, order) {
  const paymentTerms = require('../../sales/payment-terms');
  const position = paymentTerms.positionForOrder(db, workspaceId, order);
  return {
    ...position,
    /*
     * The panel appears once an order is a commitment, not once it has an
     * invoice — Foundry raises the invoice at shipment, so waiting for it left
     * an order silent about money until after the goods had gone.
     *
     * A draft is still silent, because nothing has been promised to anybody
     * and a figure there reads as a debt that does not exist.
     */
    invoiced: position.invoiced || (order.status !== 'DRAFT' && position.totalMinor > 0),
    hasInvoice: position.invoiced,
    // The page's older name for the same figure, kept so its markup reads
    // the way the panel reads.
    outstandingMinor: position.remainingMinor,
    state: position.status,
  };
}

function accountingForOrder(db, workspaceId, orderId) {
  const configured = db.prepare('SELECT enabled FROM accounting_settings WHERE workspace_id = ?').get(workspaceId);
  if (!configured?.enabled) return { status: 'DISABLED' };
  const row = db.prepare(`SELECT aei.*, aje.entry_number
    FROM sales_order_events soe
    JOIN domain_events de ON de.workspace_id = soe.workspace_id
      AND de.source_record_type = 'sales_order_event' AND de.source_record_id = soe.id
    JOIN accounting_event_inbox aei ON aei.domain_event_id = de.id AND aei.workspace_id = soe.workspace_id
    LEFT JOIN accounting_journal_entries aje ON aje.id = aei.journal_entry_id
    WHERE soe.workspace_id = ? AND soe.sales_order_id = ?
      AND soe.event_type IN ('PARTIALLY_FULFILLED','FULFILLED')
    ORDER BY soe.created_at DESC, soe.rowid DESC LIMIT 1`).get(workspaceId, orderId);
  if (!row) return { status: 'WAITING' };
  let outcome = {};
  try { outcome = JSON.parse(row.outcome || '{}'); } catch { outcome = {}; }
  return { ...row, outcome };
}

router.get(['/orders', '/sales'], requirePermission(permissions.VIEW, 'view sales orders'), asyncRoute(async (req, res) => {
  const status = trimOrNull(req.query.status);
  const sellingConnectionCount = req.db.prepare(
    "SELECT COUNT(*) AS n FROM workspace_connectors WHERE workspace_id = ? AND status = 'connected' AND provider_type IN ('shopify','square','clover','woocommerce','reference_webhook')"
  ).get(req.ctx.workspaceId).n;
  /*
   * The list arrives already knowing what each order is waiting for, and in
   * the order somebody should deal with them. Sorting in the view would put
   * the judgement in a template, where it cannot be tested.
   */
  const ranked = orderStatus.decorate(req.db, req.ctx.workspaceId,
    sales.listOrders(req.db, req.ctx.workspaceId, { status, limit: 200 }));
  res.page('sales/orders', {
    title: 'Orders', nav: 'sales', status,
    sellingConnectionCount,
    orders: ranked,
    summary: orderStatus.summarise(ranked),
    completedSales: sales.listCompletedSales(req.db, req.ctx.workspaceId, { limit: 200 }),
    customers: sales.listCustomers(req.db, req.ctx.workspaceId),
  });
}));

router.get(['/orders/new', '/sales/new'], requirePermission(permissions.OPERATE, 'create sales orders'), asyncRoute(async (req, res) => {
  const skus = catalogue(req.db, req.ctx.workspaceId);
  res.page('sales/order-new', {
    title: 'New sales order', nav: 'sales', customers: sales.listCustomers(req.db, req.ctx.workspaceId),
    skus, locations: repo.listLocations(req.db, req.ctx.workspaceId), form: {}, formError: null,
    unpricedCount: skus.filter((sku) => !sku.price.isSet).length,
  });
}));

router.get('/sales/customers/:id', requirePermission(permissions.VIEW, 'view customers'), asyncRoute(async (req, res) => {
  const customer = sales.getCustomer(req.db, req.ctx.workspaceId, req.params.id);
  /*
   * The same sentence per order that the Orders list shows.
   *
   * This page had its own vocabulary — raw statuses, "confirmed" and
   * "fulfilled" in lower case — so the same order read one way in the list and
   * another here. One order, one description of it.
   */
  const history = orderStatus.decorate(req.db, req.ctx.workspaceId, customer.orders);
  const owed = req.db.prepare(`SELECT COALESCE(SUM(balance_minor), 0) AS owed,
      COUNT(*) AS invoices, MIN(due_date) AS soonest
    FROM accounting_customer_invoices
    WHERE workspace_id = ? AND customer_id = ? AND status IN ('OPEN','PARTIALLY_PAID')`)
    .get(req.ctx.workspaceId, req.params.id);
  res.page('sales/customer', {
    title: 'Customer', nav: 'sales', customer: { ...customer, orders: history },
    customerOwes: { minor: Number(owed.owed), invoices: Number(owed.invoices), soonest: owed.soonest },
    terms: paymentTerms.forCustomer(req.db, req.ctx.workspaceId, req.params.id),
    // The same sentence the order page shows, from the same place.
    termsDescription: paymentTerms.describe(paymentTerms.forCustomer(req.db, req.ctx.workspaceId, req.params.id)),
    houseTerms: paymentTerms.forCustomer(req.db, req.ctx.workspaceId, null),
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
      customerEmail: trimOrNull(req.body.customerEmail),
      customerShippingAddress: trimOrNull(req.body.customerShippingAddress),
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
  const nextStep = ['confirm', 'fulfill'].includes(req.body.nextStep) ? req.body.nextStep : 'draft';
  if (nextStep !== 'draft') {
    order = sales.confirm(req.db, req.ctx, order.id, { idempotencyKey: `web-create-confirm:${order.id}` });
  }
  if (nextStep === 'fulfill' && !order.totals.backordered) {
    order = sales.fulfill(req.db, req.ctx, order.id, {}, { idempotencyKey: `web-create-fulfill:${order.id}` });
  }
  if (nextStep === 'fulfill' && order.status === 'FULFILLED') {
    const financial = accountingForOrder(req.db, req.ctx.workspaceId, order.id);
    req.flash(financial.status === 'POSTED' ? 'success' : 'warn', financial.status === 'POSTED'
      ? `${order.order_number} is complete. Stock and Accounting were updated automatically.`
      : `${order.order_number} is complete and stock was updated. Accounting needs one evidence decision; the sale will not be posted with guessed amounts.`);
  } else if (nextStep === 'fulfill' && order.totals.backordered) {
    req.flash('warn', `${order.order_number} could not be completed because ${order.totals.backordered} unit(s) are not available. ${order.totals.allocated} available unit(s) are held; nothing shipped.`);
  } else if (nextStep === 'confirm') {
    req.flash(order.totals.backordered ? 'warn' : 'success', order.totals.backordered
      ? `${order.order_number} is confirmed. ${order.totals.allocated} held; ${order.totals.backordered} waiting for stock.`
      : `${order.order_number} is confirmed and ${order.totals.allocated} unit(s) are held for the customer.`);
  } else {
    req.flash('success', `${order.order_number} was saved as a draft. No stock is held yet.`);
  }
  res.redirect(303, `/sales/orders/${order.id}`);
}));

router.get(['/orders/:id', '/sales/orders/:id'], requirePermission(permissions.VIEW, 'view sales orders'), asyncRoute(async (req, res) => {
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
  if (order && order.status !== 'DRAFT' && order.totals.backordered) {
    for (const line of order.lines) {
      if (!line.backordered) continue;
      const free = sales.availabilityForSku(req.db, req.ctx.workspaceId, line.sku_id).available || 0;
      shortButAvailable += Math.min(Number(line.backordered), Math.max(0, free));
    }
  }

  res.page('sales/order', {
    title: 'Order', nav: 'sales', order,
    shortButAvailable,
    accounting: accountingForOrder(req.db, req.ctx.workspaceId, order.id),
    money: moneyForOrder(req.db, req.ctx.workspaceId, order),
    shipments: shipments.listForOrder(req.db, req.ctx.workspaceId, order.id),
    pickable: order.status === 'DRAFT' ? [] : shipments.pickable(req.db, req.ctx.workspaceId, order.id),
    fulfilment: shipments.fulfilmentState(req.db, req.ctx.workspaceId, order),
    /*
     * What this customer has been told, on the same page as the thing they
     * were told about. Bouncing between the order, the shipment and a mailbox
     * to answer "does she know it shipped?" is the failure this page exists to
     * avoid.
     */
    customerNotices: notices.forOrder(req.db, req.ctx.workspaceId, order.id),
    paymentRequests: require('../../payments/collection').forOrder(req.db, req.ctx.workspaceId, order.id),
    paymentProviders: require('../../payments/provider').list(),
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

/*
 * Commit stock that arrived after the order was confirmed.
 *
 * Deliberately a person's decision rather than something Foundry does on its
 * own: holding stock for one customer takes it from the next one who asks.
 */
router.post('/sales/orders/:id/allocate', requirePermission(permissions.OPERATE, 'commit stock to sales orders'), asyncRoute(async (req, res) => {
  let result;
  try {
    result = sales.allocateAvailable(req.db, req.ctx, req.params.id, {
      idempotencyKey: trimOrNull(req.body.idempotencyKey) || undefined,
    });
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
    return res.redirect(303, `/sales/orders/${req.params.id}`);
  }
  const order = result.order;
  if (!result.committed) {
    req.flash('warn', `Nothing free to commit to ${order.order_number} right now.`);
  } else {
    const still = order.totals.backordered;
    req.flash('success', still
      ? `${result.committed} ${result.committed === 1 ? 'unit' : 'units'} committed to ${order.order_number}. ${still} still short.`
      : `${result.committed} ${result.committed === 1 ? 'unit' : 'units'} committed. ${order.order_number} is fully covered.`);
  }
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

  /*
   * Refuse when a box is already open on this order.
   *
   * Both this and shipping a box issue the same allocated stock. Doing it here
   * would leave the box holding a claim on units that had already gone, and it
   * would never be shippable again. Hiding the form is not enough on its own:
   * the button can still be sitting on a page somebody left open.
   */
  const openBox = shipments.listForOrder(req.db, req.ctx.workspaceId, req.params.id)
    .find((box) => shipments.OPEN_SHIPMENT.includes(box.status));
  if (openBox) {
    req.flash('warn', `${openBox.shipment_number} is already open on this order. Ship it from there, so what leaves stock is exactly what went in the box.`);
    return res.redirect(303, `/fulfilment/${openBox.id}`);
  }

  /*
   * Still one click, and now it leaves a record of where the goods went.
   *
   * This called the sales order's fulfil directly, which moved stock and made
   * no shipment — so the page said "7 shipped" and "0 shipments" at once, with
   * no address and nothing to tell the customer.
   */
  let order;
  try {
    const shipped = shipments.shipInOneStep(req.db, req.ctx, req.params.id, {
      lines,
      trackingNumber: trimOrNull(req.body.trackingNumber),
      carrier: trimOrNull(req.body.carrier),
    });
    order = sales.getOrder(req.db, req.ctx.workspaceId, shipped.sales_order_id);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
    return res.redirect(303, `/orders/${req.params.id}`);
  }
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

/*
 * Fulfilment.
 *
 * Every one of these is a step a person takes with their hands, so each is a
 * single POST that says what happened rather than a form that asks the person
 * to restate what Foundry already knows.
 */

router.get('/fulfilment', requirePermission(permissions.VIEW, 'view fulfilment'), asyncRoute(async (req, res) => {
  const queue = shipments.workQueue(req.db, req.ctx.workspaceId);
  res.page('sales/fulfilment', {
    title: 'Fulfilment', nav: 'fulfilment', queue,
    noticePolicy: notices.policy(req.db, req.ctx.workspaceId),
    waitingNotices: notices.waiting(req.db, req.ctx.workspaceId),
    mailboxes: connections.list(req.db, req.ctx.workspaceId)
      .filter((row) => ['gmail', 'microsoft365'].includes(row.provider_type)),
  });
}));

router.get('/fulfilment/:id', requirePermission(permissions.VIEW, 'view fulfilment'), asyncRoute(async (req, res) => {
  const list = shipments.pickList(req.db, req.ctx.workspaceId, req.params.id);
  res.page('sales/shipment', {
    title: list.shipment.shipment_number, nav: 'fulfilment',
    shipment: shipments.getShipment(req.db, req.ctx.workspaceId, req.params.id),
    pickList: list, carriers: carriers.list(),
    notices: notices.forShipment(req.db, req.ctx.workspaceId, req.params.id),
    noticePolicy: notices.policy(req.db, req.ctx.workspaceId),
    mailboxes: connections.list(req.db, req.ctx.workspaceId)
      .filter((row) => ['gmail', 'microsoft365'].includes(row.provider_type)),
  });
}));

router.post('/sales/orders/:id/pick', requirePermission(permissions.OPERATE, 'fulfill sales orders'), asyncRoute(async (req, res) => {
  let shipment;
  try {
    shipment = shipments.startPicking(req.db, req.ctx, req.params.id, {});
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
    return res.redirect(303, `/sales/orders/${req.params.id}`);
  }
  req.flash('success', `${shipment.shipment_number} is ready to pick — ${shipment.units} to collect. Nothing has left stock yet.`);
  res.redirect(303, `/fulfilment/${shipment.id}`);
}));

router.post('/fulfilment/:id/line', requirePermission(permissions.OPERATE, 'fulfill sales orders'), asyncRoute(async (req, res) => {
  try {
    shipments.setLineQuantity(req.db, req.ctx, req.params.id,
      req.body.lineId, req.body.locationId, req.body.quantity);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
  }
  res.redirect(303, `/fulfilment/${req.params.id}`);
}));

router.post('/fulfilment/:id/packed', requirePermission(permissions.OPERATE, 'fulfill sales orders'), asyncRoute(async (req, res) => {
  let shipment;
  try {
    shipment = shipments.markPacked(req.db, req.ctx, req.params.id, {
      packageCount: req.body.packageCount || null,
      weightGrams: req.body.weightGrams || null,
      notes: trimOrNull(req.body.notes),
    });
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
    return res.redirect(303, `/fulfilment/${req.params.id}`);
  }
  req.flash('success', `${shipment.shipment_number} is packed. Stock still shows as here until you mark it shipped.`);
  res.redirect(303, `/fulfilment/${shipment.id}`);
}));

router.post('/fulfilment/:id/ship', requirePermission(permissions.OPERATE, 'fulfill sales orders'), asyncRoute(async (req, res) => {
  let shipment;
  try {
    shipment = shipments.ship(req.db, req.ctx, req.params.id, {
      carrier: trimOrNull(req.body.carrier),
      service: trimOrNull(req.body.service),
      trackingNumber: trimOrNull(req.body.trackingNumber),
      shippedAt: trimOrNull(req.body.shippedAt),
      expectedDeliveryDate: trimOrNull(req.body.expectedDeliveryDate),
      shippingCostMinor: req.body.shippingCost ? Math.round(Number(req.body.shippingCost) * 100) : null,
    });
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
    return res.redirect(303, `/fulfilment/${req.params.id}`);
  }
  /*
   * One sentence covering the parcel and the person waiting for it.
   *
   * Sending is attempted here rather than inside the engine because it is slow,
   * it can fail halfway, and the outcome is something a person needs told in
   * words. The box shipped either way; only the last clause changes.
   */
  let told = '';
  if (shipment.customerNotice) {
    const outcome = await notices.autoSend(req.db, req.ctx, shipment.customerNotice);
    if (outcome.sent) told = ' The customer has been told.';
    else if (outcome.reason) told = ` The customer has not been told yet — ${outcome.reason}`;
    else told = ' A note to the customer is written below, ready when you are.';
  }
  req.flash('success', `${shipment.shipment_number} has gone. ${shipment.units} left stock and the sale is on the books.${told}`);
  res.redirect(303, `/fulfilment/${shipment.id}`);
}));

router.post('/fulfilment/:id/delivered', requirePermission(permissions.OPERATE, 'fulfill sales orders'), asyncRoute(async (req, res) => {
  try {
    shipments.markDelivered(req.db, req.ctx, req.params.id, { deliveredAt: trimOrNull(req.body.deliveredAt) });
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
  }
  res.redirect(303, `/fulfilment/${req.params.id}`);
}));

router.post('/fulfilment/:id/cancel', requirePermission(permissions.OPERATE, 'fulfill sales orders'), asyncRoute(async (req, res) => {
  let shipment;
  try {
    shipment = shipments.cancelShipment(req.db, req.ctx, req.params.id, trimOrNull(req.body.reason));
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
    return res.redirect(303, `/fulfilment/${req.params.id}`);
  }
  req.flash('success', `${shipment.shipment_number} was cancelled. What it was holding is free to pick again.`);
  res.redirect(303, `/sales/orders/${shipment.sales_order_id}`);
}));

/*
 * Telling the customer. Preparing is not sending, so each of these is a
 * separate thing somebody chose to do.
 */

router.post('/fulfilment/:id/notice', requirePermission(permissions.OPERATE, 'write to customers'), asyncRoute(async (req, res) => {
  const action = trimOrNull(req.body.action);
  const messageId = trimOrNull(req.body.messageId);
  try {
    if (action === 'save') {
      notices.updateDraft(req.db, req.ctx.workspaceId, messageId, {
        subject: req.body.subject, body: req.body.body, connectorId: req.body.connectorId,
      });
      req.flash('success', 'Saved. Nothing has been sent.');
    } else if (action === 'cancel') {
      notices.cancel(req.db, req.ctx.workspaceId, messageId, 'Not sent by the owner.');
      req.flash('success', 'That note will not be sent.');
    } else if (action === 'rewrite') {
      notices.prepareShippingNotice(req.db, req.ctx, req.params.id);
      req.flash('success', 'Written again from what Foundry has on record.');
    } else {
      // Save whatever is on screen first, so send always sends what was read.
      notices.updateDraft(req.db, req.ctx.workspaceId, messageId, {
        subject: req.body.subject, body: req.body.body, connectorId: req.body.connectorId,
      });
      const sent = await notices.sendThroughMailbox(req.db, req.ctx.workspaceId, messageId, req.ctx.actorId);
      req.flash('success', `Sent to ${sent.recipient}.`);
    }
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
  }
  res.redirect(303, `/fulfilment/${req.params.id}`);
}));

router.post('/fulfilment/settings/notices', requirePermission(permissions.OPERATE, 'change communication settings'), asyncRoute(async (req, res) => {
  try {
    notices.setPolicy(req.db, req.ctx, {
      shippingNotice: req.body.shippingNotice,
      connectorId: req.body.connectorId,
      businessName: req.body.businessName,
      replyTo: req.body.replyTo,
      signature: req.body.signature,
    });
    req.flash('success', 'Saved how Foundry handles shipping notices.');
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
  }
  res.redirect(303, req.body.returnTo || '/fulfilment');
}));

/*
 * Payment terms and the holds they create.
 *
 * Terms sit on the customer because that is what they are about. The override
 * sits on the order because that is what it is about — one parcel, once, on the
 * record.
 */

router.post('/sales/customers/:id/terms', requirePermission(permissions.OPERATE, 'agree payment terms'), asyncRoute(async (req, res) => {
  try {
    if (trimOrNull(req.body.action) === 'clear') {
      paymentTerms.clearTerms(req.db, req.ctx, req.params.id);
      req.flash('success', 'Removed. This customer follows your rule for everybody.');
    } else {
      /*
       * The form asks for money in money. The engine stores minor units, so
       * the conversion happens here rather than asking an owner to think in
       * cents.
       */
      const saved = paymentTerms.setTerms(req.db, req.ctx, {
        ...req.body,
        depositMinor: req.body.depositAmount ? Math.round(Number(req.body.depositAmount) * 100) : null,
        customerId: req.params.id,
      });
      req.flash('success', `Saved. ${paymentTerms.describe(saved)}`);
    }
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
  }
  res.redirect(303, `/sales/customers/${req.params.id}#terms`);
}));

router.post('/sales/terms', requirePermission(permissions.OPERATE, 'agree payment terms'), asyncRoute(async (req, res) => {
  try {
    const saved = paymentTerms.setTerms(req.db, req.ctx, { ...req.body, customerId: null });
    req.flash('success', `Saved for every customer without their own terms. ${paymentTerms.describe(saved)}`);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
  }
  res.redirect(303, trimOrNull(req.body.returnTo) || '/orders');
}));

router.post('/sales/orders/:id/payment-hold', requirePermission(permissions.OPERATE, 'release payment holds'), asyncRoute(async (req, res) => {
  try {
    if (trimOrNull(req.body.action) === 'restore') {
      paymentTerms.clearOverride(req.db, req.ctx, req.params.id);
      req.flash('success', 'The hold is back on. This order will not ship until it is paid.');
    } else {
      paymentTerms.overrideHold(req.db, req.ctx, req.params.id, req.body.reason);
      req.flash('success', 'Approved. This order can go out unpaid, and Foundry has kept a note that you allowed it.');
    }
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
  }
  res.redirect(303, `/orders/${req.params.id}#payment-hold`);
}));

/*
 * Money that arrived without a payment link.
 *
 * Cash, a cheque, a transfer, the card machine on the counter. It goes through
 * the same engine and produces the same receipt as a payment collected online,
 * because "paid" has to mean one thing.
 */
router.post('/sales/orders/:id/payment', requirePermission(permissions.OPERATE, 'record payments'), asyncRoute(async (req, res) => {
  try {
    const order = req.db.prepare('SELECT * FROM sales_orders WHERE id = ? AND workspace_id = ?')
      .get(req.params.id, req.ctx.workspaceId);
    if (!order) throw new ValidationError('That sales order is not in this inventory.');
    const position = paymentTerms.positionForOrder(req.db, req.ctx.workspaceId, order);
    if (!position.totalMinor) throw new ValidationError('This order is not worth anything yet, so there is nothing to pay.');

    const amountMinor = Math.round(Number(req.body.amount) * 100);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new ValidationError('Enter how much they paid.');
    }
    if (amountMinor > position.remainingMinor) {
      throw new ValidationError(`That is more than the ${paymentTerms.money(position.remainingMinor, position.currency)} still owed on this order.`);
    }

    /*
     * Spread across the open invoices oldest first, which is what a customer
     * paying "off the account" means and what an accountant would do by hand.
     */
    /*
     * Against the open invoices, oldest first — and when there is no invoice
     * yet, against nothing, which the payment engine records as money held on
     * the customer's behalf rather than as revenue. A deposit taken before the
     * goods ship is a liability until they do.
     */
    let left = amountMinor;
    const allocations = [];
    for (const invoice of position.invoices) {
      if (left <= 0) break;
      const take = Math.min(left, Number(invoice.balance_minor));
      if (take > 0) { allocations.push({ invoiceId: invoice.id, amountMinor: take }); left -= take; }
    }

    const payments = require('../../accounting/payments');
    payments.record(req.db, req.ctx, req.user, {
      direction: 'CUSTOMER_RECEIPT',
      customerId: (position.invoices[0] || order).customer_id,
      paymentDate: trimOrNull(req.body.paymentDate) || undefined,
      amountMinor,
      method: trimOrNull(req.body.method) || 'other',
      reference: trimOrNull(req.body.reference),
      /*
       * Where this came from, which is what source_key is used for elsewhere
       * too ("stripe:evt_x", "sales-order:..."). The first attempt put the
       * order number in `reference` and silently overwrote the note somebody
       * had typed there — a link does not belong in a field a person writes in.
       */
      sourceKey: `order-payment:${order.id}:${Date.now()}`,
      allocations,
    });
    req.flash('success', `Recorded ${paymentTerms.money(amountMinor, position.currency)}. The balance and the books both moved.`);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
  }
  res.redirect(303, `/orders/${req.params.id}#money`);
}));

module.exports = router;





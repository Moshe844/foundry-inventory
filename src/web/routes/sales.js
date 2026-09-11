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
const { requireAuth, requirePermission, asyncRoute } = require('../middleware');
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

function catalogue(db, workspaceId) {
  return db.prepare(`SELECT s.id, s.code, s.variant_label, i.id AS item_id, i.name AS item_name,
      CASE WHEN s.variant_label IS NULL OR s.variant_label = '' THEN i.name
           ELSE i.name || ' / ' || s.variant_label END AS display_name
    FROM skus s JOIN items i ON i.id = s.item_id
    WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
    ORDER BY i.name COLLATE NOCASE, s.position`).all(workspaceId)
    .map((sku) => ({
      ...sku,
      price: prices.currentForSku(db, workspaceId, sku.id),
      // The order form must reveal the promise it is about to make. "On
      // hand" alone is misleading because some of it may already belong to
      // another customer; available is the amount this order can reserve.
      stock: sales.availabilityForSku(db, workspaceId, sku.id),
    }));
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

/*
 * The email this order was read out of, when it was read out of one.
 *
 * An order the owner did not type has to say where it came from, or it is
 * indistinguishable from one Foundry invented. The sender, the subject and
 * the message itself are all one click away, so "approve" is a decision made
 * against the customer's own words rather than against a form.
 */
function cameFromEmail(db, workspaceId, order) {
  if (!order.source_email_message_id) return null;
  return db.prepare(`SELECT id, sender, subject, body_text, received_at,
      draft_subject, draft_body, draft_at, reply_sent_at
    FROM connection_email_messages WHERE workspace_id = ? AND id = ?`)
    .get(workspaceId, order.source_email_message_id) || null;
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
    sales.listOrders(req.db, req.ctx.workspaceId, { status, limit: 200 }))
    .map((order) => {
      if (order.status !== 'FULFILLED') return order;
      const fulfilment = shipments.fulfilmentState(req.db, req.ctx.workspaceId, order);
      return { ...order, fulfilmentLabel: fulfilment.label || fulfilment.state || 'Gone' };
    });
  res.page('sales/orders', {
    title: 'Orders', nav: 'sales', room: true, status,
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
    // A focused form explains its own missing fields in context. A global
    // setup task above it creates two unrelated "next" actions.
    screenGuide: null,
  });
}));

router.get('/sales/customers/new', requirePermission(permissions.OPERATE, 'create customers'), asyncRoute(async (req, res) => {
  res.page('sales/customer-new', {
    title: 'New customer', nav: 'sales', form: {}, formError: null, screenGuide: null,
  });
}));

router.post('/sales/customers', requirePermission(permissions.OPERATE, 'create customers'), asyncRoute(async (req, res) => {
  try {
    const customer = sales.createCustomer(req.db, req.ctx, {
      name: req.body.name, company: req.body.company, email: req.body.email,
      phone: req.body.phone, shippingAddress: req.body.shippingAddress, notes: req.body.notes,
    });
    req.flash('success', `${customer.name} is ready. You can create an order now or leave the customer with no order.`);
    return res.redirect(303, `/sales/customers/${customer.id}`);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    return res.status(err.status).page('sales/customer-new', {
      title: 'New customer', nav: 'sales', form: req.body, formError: err.message,
    });
  }
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
    usage: sales.customerUsage(req.db, req.ctx.workspaceId, req.params.id),
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

/*
 * Retiring a customer, and bringing one back.
 *
 * Archive rather than delete: orders, invoices and payments reference this
 * record. The service refuses while an order of theirs is still live.
 */
router.post('/sales/customers/:id/archive', requirePermission(permissions.OPERATE, 'change customers'), asyncRoute(async (req, res) => {
  const restore = req.body.restore === '1';
  try {
    if (restore) {
      const customer = sales.setCustomerActive(req.db, req.ctx, req.params.id, true);
      req.flash('success', `${customer.name} is active again.`);
      return res.redirect(303, `/sales/customers/${req.params.id}`);
    }
    const result = sales.removeCustomer(req.db, req.ctx, req.params.id);
    if (result.deleted) {
      req.flash('success', `${result.customer.name} was deleted. Nothing referred to them.`);
      return res.redirect(303, '/orders');
    }
    const kept = result.usage.used.map((u) => `${u.count} ${u.label}`).join(', ');
    req.flash('success',
      `${result.customer.name} was archived rather than deleted, because ${kept} still refer to them. `
      + 'They will not appear when you write an order.');
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
  }
  res.redirect(303, `/sales/customers/${req.params.id}`);
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
      saveCustomerAddress: req.body.saveCustomerAddress === '1',
      deliveryMethod: trimOrNull(req.body.deliveryMethod) || 'SHIP',
      requireDeliveryDecision: true,
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
  if (nextStep !== 'draft' && !order.delivery_decision_required) {
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
  } else if (order.delivery_decision_required) {
    req.flash('warn', `${order.order_number} is saved, but nothing is reserved or shipped yet. Choose customer pickup or enter the full delivery address.`);
  } else if (nextStep === 'confirm') {
    req.flash(order.totals.backordered ? 'warn' : 'success', order.totals.backordered
      ? `${order.order_number} is confirmed. ${order.totals.allocated} held; ${order.totals.backordered} waiting for stock.`
      : `${order.order_number} is confirmed and ${order.totals.allocated} unit(s) are held for the customer.`);
  } else {
    req.flash('success', `${order.order_number} was saved as a draft. No stock is held yet.`);
  }
  res.redirect(303, `/sales/orders/${order.id}`);
}));

router.post('/sales/orders/:id/resolve-customer',
  requirePermission(permissions.OPERATE, 'resolve customers from email'), asyncRoute(async (req, res) => {
    try {
      const order = sales.resolveEmailCustomer(req.db, req.ctx, req.params.id, {
        action: trimOrNull(req.body.action) || 'create', customerId: trimOrNull(req.body.customerId),
      });
      req.flash('success', order.delivery_decision_required
        ? `${order.customer.name} is now the customer. Next, confirm shipping or pickup.`
        : `${order.customer.name} is now the customer. The order is ready for your approval.`);
    } catch (err) {
      req.flash('warn', err.message);
    }
    res.redirect(303, `/orders/${req.params.id}`);
  }));

router.post('/sales/orders/:id/resolve-delivery',
  requirePermission(permissions.OPERATE, 'resolve delivery details'), asyncRoute(async (req, res) => {
    try {
      const order = sales.resolveDelivery(req.db, req.ctx, req.params.id, {
        deliveryMethod: req.body.deliveryMethod, shippingAddress: req.body.shippingAddress,
        saveCustomerAddress: req.body.saveCustomerAddress === '1',
      });
      req.flash('success', order.delivery_method === 'PICKUP'
        ? 'Customer pickup confirmed. The order is ready for the next step.'
        : 'Delivery address confirmed. The order is ready for the next step.');
    } catch (err) {
      req.flash('warn', err.message);
    }
    res.redirect(303, `/orders/${req.params.id}`);
  }));

router.get(['/orders/:id', '/sales/orders/:id', '/orders/:id/detail', '/sales/orders/:id/detail'],
  requirePermission(permissions.VIEW, 'view sales orders'), asyncRoute(async (req, res) => {
  /*
   * One address tells the story; the same address with /detail on the end is
   * the working page it was before. Nothing was removed — the operational
   * forms are where somebody who wants to work on the order will look, and the
   * story is what everybody else opens.
   */
  const wantsDetail = req.path.endsWith('/detail');
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
  const shortageDetails = [];
  if (order && order.status !== 'DRAFT' && order.totals.backordered) {
    for (const line of order.lines) {
      if (!line.backordered) continue;
      const availability = sales.availabilityForSku(req.db, req.ctx.workspaceId, line.sku_id);
      const free = availability.available || 0;
      shortButAvailable += Math.min(Number(line.backordered), Math.max(0, free));
      const suppliers = require('../../purchasing/supplier-service')
        .suppliersForSku(req.db, req.ctx.workspaceId, line.sku_id);
      const preparedReplenishment = require('../../autopilot/work-items')
        .awaitingReplenishmentForSku(req.db, req.ctx.workspaceId, line.sku_id);
      shortageDetails.push({
        skuId: line.sku_id,
        displayName: line.displayName,
        missing: Number(line.backordered),
        availableNow: Math.min(Number(line.backordered), Math.max(0, free)),
        actionHref: preparedReplenishment
          ? `/autopilot/work/${preparedReplenishment.id}`
          : suppliers.length
            ? `/purchasing/why/${line.sku_id}`
            : `/purchasing/supplier-for/${line.sku_id}`,
        actionLabel: preparedReplenishment
          ? 'Review the prepared replenishment plan'
          : suppliers.length ? 'Review replenishment for this product' : 'Add a supplier for this product',
      });
    }
  }

  /*
   * Before showing what is owed, ask the provider what has happened.
   *
   * A webhook needs a public address the provider can reach, and on a laptop
   * that address is a tunnel which is sometimes not running. Waiting to be
   * told meant an order could sit saying "unpaid" while Stripe had already
   * recorded the payment — or the decline. Asking is bounded to once a minute
   * per request and never blocks the page from rendering.
   */
  try { await require('../../payments/collection').refreshForOrder(req.db, req.ctx, order.id); }
  catch { /* The page shows what is recorded; being unable to ask is not news about the customer. */ }
  const askedFor = require('../../payments/collection').forOrder(req.db, req.ctx.workspaceId, order.id);
  const orderShipments = shipments.listForOrder(req.db, req.ctx.workspaceId, order.id);
  const orderNotices = notices.forOrder(req.db, req.ctx.workspaceId, order.id);
  const orderMoney = moneyForOrder(req.db, req.ctx.workspaceId, order);
  const orderFulfilment = shipments.fulfilmentState(req.db, req.ctx.workspaceId, order);
  const orderNext = orderStatus.nextStep(req.db, req.ctx.workspaceId, order, {
    payment: orderMoney,
    fulfilment: orderFulfilment,
  });
  const openSection = wantsDetail && ['fulfilment', 'money'].includes(String(req.query.open || ''))
    ? String(req.query.open) : null;
  const orderReceipts = req.db.prepare(`SELECT DISTINCT p.id, p.payment_number, p.amount_minor,
        p.payment_date, p.method,
        COALESCE((SELECT SUM(apa2.amount_minor)
          FROM accounting_payment_allocations apa2
          JOIN accounting_customer_invoices aci2 ON aci2.id = apa2.customer_invoice_id
          WHERE apa2.workspace_id = p.workspace_id AND apa2.payment_id = p.id
            AND aci2.sales_order_id = ?), p.amount_minor) AS order_amount_minor
      FROM accounting_payments p
      WHERE p.workspace_id = ? AND p.direction = 'CUSTOMER_RECEIPT' AND p.status = 'POSTED'
        AND (p.sales_order_id = ? OR EXISTS (
          SELECT 1 FROM accounting_payment_allocations apa
          JOIN accounting_customer_invoices aci ON aci.id = apa.customer_invoice_id
          WHERE apa.workspace_id = p.workspace_id AND apa.payment_id = p.id
            AND aci.sales_order_id = ?))
      ORDER BY p.payment_date, p.created_at`).all(order.id, req.ctx.workspaceId, order.id, order.id);
  res.page(wantsDetail ? 'sales/order' : 'sales/story', {
    title: wantsDetail ? 'Order' : `${(order.customer && order.customer.name) || order.order_number}`,
    nav: 'sales', order,
    room: !wantsDetail,
    /*
     * The order as one story: what was promised, what Foundry committed, what
     * the customer was told, what shipped, what is owed, and what happens
     * next. Composed here from what this page already gathered rather than
     * from a second set of queries, so the story and the detail can never
     * disagree about the same order.
     */
    story: wantsDetail ? null : require('../story').salesOrder(req.db, req.ctx.workspaceId, order, {
      shipments: orderShipments,
      customerNotices: orderNotices,
      customerReceipts: orderReceipts,
      money: orderMoney,
      shortageDetails,
      accounting: accountingForOrder(req.db, req.ctx.workspaceId, order.id),
      fulfilment: orderFulfilment,
    }),
    evidenceTrace: wantsDetail ? null : require('../../provenance/presenter').salesOrderStory(
      req.db, req.ctx.workspaceId, order, {
        shipments: orderShipments,
        customerReceipts: orderReceipts,
        money: orderMoney,
        accounting: accountingForOrder(req.db, req.ctx.workspaceId, order.id),
      }, { membership: req.user }),
    // A focused order already has one state-derived next action. The generic
    // Sales strip can point at an unrelated product price or connector and
    // make the page appear to have two competing instructions.
    screenGuide: null,
    shortButAvailable,
    shortageDetails,
    cameFromEmail: cameFromEmail(req.db, req.ctx.workspaceId, order),
    goneWord: shipments.wordForOrder(req.db, req.ctx.workspaceId, order.id),
    accounting: accountingForOrder(req.db, req.ctx.workspaceId, order.id),
    money: orderMoney,
    orderNext,
    openSection,
    shipments: orderShipments,
    pickable: order.status === 'DRAFT' ? [] : shipments.pickable(req.db, req.ctx.workspaceId, order.id),
    fulfilment: orderFulfilment,
    /*
     * What this customer has been told, on the same page as the thing they
     * were told about. Bouncing between the order, the shipment and a mailbox
     * to answer "does she know it shipped?" is the failure this page exists to
     * avoid.
     */
    customerNotices: orderNotices,
    customerReceipts: orderReceipts,
    paymentRequests: askedFor,
    paymentCompleted: req.query.payment === 'paid',
    /*
     * A payment to open the moment the page arrives. Asking for money and
     * taking it are one motion when the customer is at the counter, so the
     * request that was just made opens its own payment panel here rather than
     * leaving somebody to find the button they only just pressed.
     */
    openPaymentUrl: (function () {
      const wanted = trimOrNull(req.query.pay);
      if (!wanted) return null;
      const found = askedFor.find((row) => row.id === wanted && row.hostedUrl && row.status === 'OPEN');
      return found ? found.hostedUrl : null;
    }()),
    paymentProviders: require('../../payments/provider').list(),
    paymentAccount: require('../../payments/accounts').describe(req.db, req.ctx.workspaceId),
    canManagePaymentAccount: req.user && req.user.role === 'owner',
    customers: sales.listCustomers(req.db, req.ctx.workspaceId),
    skus: catalogue(req.db, req.ctx.workspaceId),
  });
}));

/**
 * What to add to the flash when Foundry has been at the money by itself.
 *
 * Silence would be the wrong answer either way. If it asked and sent, the
 * owner needs to know a customer of theirs has just been emailed. If it got
 * everything ready and stopped, they need to know why, or the prepared link
 * looks like something they forgot to do rather than something waiting on a
 * permission they never gave.
 */
async function moneyChased(req, orderId, customerName) {
  const outcome = await require('../../sales/payment-automation').onMoneyDue(req.db, req.ctx, orderId);
  if (outcome.sent) {
    const amount = require('../../sales/payment-terms').money(outcome.request.amountMinor, outcome.request.currency);
    return ` Foundry asked ${customerName} for ${amount} and emailed the link.`;
  }
  if (outcome.asked) {
    const amount = require('../../sales/payment-terms').money(outcome.request.amountMinor, outcome.request.currency);
    return ` Foundry made a ${amount} payment link and wrote the email — ${outcome.because} It is on the order, ready to send.`;
  }
  // A shipment confirmation is about the parcel that just left. When Foundry
  // could not prepare or send a payment request, the order's Money section is
  // the right place to explain why. Appending a payment-account prerequisite
  // here makes a successful shipment read like a failed, unrelated task.
  return '';
}

/**
 * Whether the money has arrived, for a page that is waiting on it.
 *
 * Answered by asking the provider, not by hoping a webhook turned up — the
 * merchant is standing at the counter with the customer, and "we will know
 * shortly" is not an answer. Bounded to one question a second per order so a
 * page that polls cannot become a way to hammer Stripe.
 */
router.get('/sales/orders/:id/payment-state',
  requirePermission(permissions.VIEW, 'view sales orders'),
  asyncRoute(async (req, res) => {
    const collection = require('../../payments/collection');
    try {
      // This endpoint is called only while a person is actively taking a
      // payment. Always ask Stripe: the customer can pay and close its window
      // between two polls, and a one-second cache was enough to preserve the
      // stale "Unpaid" state at exactly that moment.
      await collection.refreshForOrder(req.db, req.ctx, req.params.id, { staleAfterMs: 0 });
    } catch { /* answered from what is recorded */ }

    const order = sales.getOrder(req.db, req.ctx.workspaceId, req.params.id);
    if (!order) return res.status(404).json({ error: 'No such order.' });
    const money = moneyForOrder(req.db, req.ctx.workspaceId, order);
    const requests = collection.forOrder(req.db, req.ctx.workspaceId, order.id);
    const open = requests.find((request) => request.status === 'OPEN');
    const settled = requests.filter((request) => request.status === 'PAID')
      .sort((a, b) => String(b.paidAt || '').localeCompare(String(a.paidAt || '')))[0];

    /*
     * The receipt for the money that just arrived, so the page can offer to
     * print it the moment it does rather than sending somebody to find it.
     */
    const receipt = req.db.prepare(`SELECT DISTINCT p.id, p.payment_number, p.amount_minor
      FROM accounting_payments p
      WHERE p.workspace_id = ? AND p.direction = 'CUSTOMER_RECEIPT' AND p.status = 'POSTED'
        AND (p.sales_order_id = ? OR EXISTS (
          SELECT 1 FROM accounting_payment_allocations apa
          JOIN accounting_customer_invoices aci ON aci.id = apa.customer_invoice_id
          WHERE apa.workspace_id = p.workspace_id AND apa.payment_id = p.id
            AND aci.sales_order_id = ?))
      ORDER BY p.created_at DESC LIMIT 1`).get(req.ctx.workspaceId, order.id, order.id);

    return res.json({
      paid: Number(money.outstandingMinor) <= 0,
      paidMinor: Number(money.paidMinor || 0),
      outstandingMinor: Number(money.outstandingMinor || 0),
      currency: money.currency,
      lastError: open ? open.lastError : (settled ? null : null),
      justPaidMinor: settled ? Number(settled.paidMinor || 0) : 0,
      receipt: receipt
        ? { id: receipt.id, number: receipt.payment_number, href: `/orders/${order.id}/receipt/${receipt.id}` }
        : null,
      invoice: settled && settled.hostedUrl
        ? { href: settled.hostedUrl }
        : null,
    });
  }));

/**
 * A receipt somebody can hand to a customer.
 *
 * Every figure on it is read from the payment and the order it belongs to.
 * Nothing is restated, rounded or summarised differently from the order page,
 * because a receipt that disagrees with the record it came from is worse than
 * no receipt at all.
 */
router.get('/orders/:id/receipt/:paymentId',
  requirePermission(permissions.VIEW, 'view sales orders'),
  asyncRoute(async (req, res) => {
    const order = sales.getOrder(req.db, req.ctx.workspaceId, req.params.id);
    if (!order) {
      req.flash('error', 'That order is not in this inventory.');
      return res.redirect(303, '/orders');
    }
    const payment = require('../../accounting/payments')
      .hydrate(req.db, req.ctx.workspaceId, req.params.paymentId);
    const allocatedToOrder = payment && payment.allocations.some((allocation) => {
      if (!allocation.customer_invoice_id) return false;
      return Boolean(req.db.prepare(`SELECT 1 FROM accounting_customer_invoices
        WHERE id = ? AND workspace_id = ? AND sales_order_id = ?`)
        .get(allocation.customer_invoice_id, req.ctx.workspaceId, order.id));
    });
    if (!payment || (payment.sales_order_id !== order.id && !allocatedToOrder)) {
      req.flash('error', 'That receipt does not belong to this order.');
      return res.redirect(303, `/orders/${order.id}`);
    }
    const linkedPayments = req.db.prepare(`SELECT DISTINCT p.id, p.amount_minor, p.status, p.created_at,
        COALESCE((SELECT SUM(apa2.amount_minor)
          FROM accounting_payment_allocations apa2
          JOIN accounting_customer_invoices aci2 ON aci2.id = apa2.customer_invoice_id
          WHERE apa2.workspace_id = p.workspace_id AND apa2.payment_id = p.id
            AND aci2.sales_order_id = ?), p.amount_minor) AS order_amount_minor
      FROM accounting_payments p
      WHERE p.workspace_id = ? AND p.direction = 'CUSTOMER_RECEIPT'
        AND (p.sales_order_id = ? OR EXISTS (
          SELECT 1 FROM accounting_payment_allocations apa
          JOIN accounting_customer_invoices aci ON aci.id = apa.customer_invoice_id
          WHERE apa.workspace_id = p.workspace_id AND apa.payment_id = p.id
            AND aci.sales_order_id = ?))
      ORDER BY p.created_at, p.id`).all(order.id, req.ctx.workspaceId, order.id, order.id);
    let paidAfterReceiptMinor = 0;
    let receiptAmountMinor = Number(payment.amount_minor || 0);
    for (const linked of linkedPayments) {
      const amount = Number(linked.order_amount_minor || 0);
      if (linked.status === 'POSTED') paidAfterReceiptMinor += amount;
      if (linked.id === payment.id) {
        receiptAmountMinor = amount;
        break;
      }
    }
    const outstandingAfterReceiptMinor = Math.max(0,
      Number(order.pricing.totalMinor || 0) - paidAfterReceiptMinor);
    const workspace = req.db.prepare('SELECT name FROM workspaces WHERE id = ?').get(req.ctx.workspaceId);
    return res.page('sales/receipt', {
      title: `Receipt ${payment.payment_number}`,
      nav: 'sales',
      screenGuide: null,
      order,
      payment,
      receiptAmountMinor,
      paidAfterReceiptMinor,
      outstandingAfterReceiptMinor,
      businessName: require('../../sales/customer-communications')
        .policy(req.db, req.ctx.workspaceId).businessName || (workspace ? workspace.name : 'Us'),
    });
  }));

router.post('/sales/orders/:id/confirm', requirePermission(permissions.OPERATE, 'confirm sales orders'), asyncRoute(async (req, res) => {
  let order;
  try {
    /*
     * A price given with the approval. It is the owner's number, recorded on
     * the product like any other selling price, and the draft's blank lines
     * pick it up before the order is confirmed. Foundry never fills a blank
     * price itself; it only carries the one it was just given.
     */
    const given = req.body.price && typeof req.body.price === 'object' ? req.body.price : {};
    const draft = sales.getOrder(req.db, req.ctx.workspaceId, req.params.id);
    for (const [skuId, amount] of Object.entries(given)) {
      if (String(amount || '').trim() === '') continue;
      prices.setPrice(req.db, req.ctx, { skuId, amount, currency: draft.currency,
        source: 'owner', sourceDetail: { givenWhileConfirming: draft.id } });
    }
    order = sales.confirm(req.db, req.ctx, req.params.id, { idempotencyKey: `web-confirm:${req.params.id}` });
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
    return res.redirect(303, `/sales/orders/${req.params.id}`);
  }
  const chased = await moneyChased(req, order.id, order.customer.name);
  req.flash(order.totals.backordered ? 'warn' : 'success', (order.totals.backordered
    ? `${order.order_number} is confirmed. ${order.totals.allocated} allocated; ${order.totals.backordered} waiting for stock.`
    : `${order.order_number} is confirmed and ${order.totals.allocated} unit(s) are committed.`) + chased);
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
      handover: trimOrNull(req.body.handover),
    });
    order = sales.getOrder(req.db, req.ctx.workspaceId, shipped.sales_order_id);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('warn', err.message);
    return res.redirect(303, `/orders/${req.params.id}`);
  }
  const chasedFast = await moneyChased(req, order.id, order.customer.name);
  req.flash('success', (order.status === 'FULFILLED'
    ? `${order.order_number} is fulfilled. Physical stock and commitments were both updated.`
    : `${order.order_number} was partly fulfilled. ${order.totals.allocated} remain committed and ${order.totals.backordered} are waiting for stock.`) + chasedFast);
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
  const shipment = shipments.getShipment(req.db, req.ctx.workspaceId, req.params.id);
  /*
   * What a carrier would do with this box, if there is one connected.
   *
   * Rates already quoted are shown rather than re-fetched: asking a carrier is
   * a network call and a page load is not a reason to make one. The button
   * asks for fresh ones.
   */
  const shipping = require('../../shipping');
  const state = shipment.delivery_method === 'PICKUP' ? null
    : shipping.service.readiness(req.db, req.ctx.workspaceId, req.params.id);
  const rates = state ? shipping.service.ratesFor(req.db, req.ctx.workspaceId, req.params.id) : [];
  const promised = state ? shipping.service.promisedDate(req.db, req.ctx.workspaceId, state.shipment) : null;
  const ruled = rates.length ? shipping.rules.decide(req.db, req.ctx.workspaceId, rates, { promisedDate: promised }) : null;

  res.page('sales/shipment', {
    title: list.shipment.shipment_number, nav: 'fulfilment',
    shipment,
    shipping: state ? {
      ready: state.ready,
      blocked: state.blocked,
      provider: state.provider,
      to: state.to,
      from: state.from,
      boxes: state.boxes,
      rates,
      promised,
      ruled,
      recommended: rates.length ? shipping.rules.recommend(rates, promised) : null,
      rules: shipping.rules.list(req.db, req.ctx.workspaceId),
      events: shipping.tracking.eventsFor(req.db, req.ctx.workspaceId, req.params.id),
    } : null,
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

/* ------------------------------------------------------ shipping by carrier */

router.post('/fulfilment/:id/packages', requirePermission(permissions.OPERATE, 'fulfill sales orders'),
  asyncRoute(async (req, res) => {
    const shipping = require('../../shipping');
    const weights = [].concat(req.body.weightGrams || []);
    try {
      shipping.service.setPackages(req.db, req.ctx, req.params.id,
        weights.filter((value) => String(value).trim()).map((value) => ({ weightGrams: value })));
      req.flash('success', 'Saved. Get rates to see what the carriers would charge.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
    }
    res.redirect(303, `/fulfilment/${req.params.id}`);
  }));

router.post('/fulfilment/:id/rates', requirePermission(permissions.OPERATE, 'fulfill sales orders'),
  asyncRoute(async (req, res) => {
    const shipping = require('../../shipping');
    try {
      const quoted = await shipping.service.quote(req.db, req.ctx, req.params.id);
      if (quoted.blocked.length) req.flash('warn', quoted.blocked[0].what);
      else if (!quoted.rates.length) req.flash('warn', 'No carrier quoted a rate for this parcel.');
      else req.flash('success', `${quoted.rates.length} rates. Nothing has been bought.`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
    }
    res.redirect(303, `/fulfilment/${req.params.id}`);
  }));

/*
 * Buying the label. The one click here that spends money, so it is the one
 * the permission is about.
 */
router.post('/fulfilment/:id/label', requirePermission(permissions.OPERATE, 'fulfill sales orders'),
  asyncRoute(async (req, res) => {
    const shipping = require('../../shipping');
    try {
      const bought = await shipping.service.buyLabel(req.db, req.ctx, req.params.id,
        trimOrNull(req.body.rateId));
      req.flash('success', bought.replayed
        ? 'That label was already bought.'
        : `Label bought — ${carriers.displayName(bought.carrier) || bought.carrier} ${bought.service || ''}`
          + `, tracking ${bought.trackingNumber}. Print it now; stock remains on hand until the parcel is handed to the carrier.`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
    }
    res.redirect(303, `/fulfilment/${req.params.id}`);
  }));

router.post('/fulfilment/:id/ship', requirePermission(permissions.OPERATE, 'fulfill sales orders'), asyncRoute(async (req, res) => {
  let shipment;
  try {
    shipment = shipments.ship(req.db, req.ctx, req.params.id, {
      handover: trimOrNull(req.body.handover),
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
  /*
   * The balance falls due the moment the goods go, so this is where Foundry
   * asks for it — after the shipment is a fact, never before, and never in a
   * way that could undo it.
   */
  const chasedBox = await moneyChased(req, shipment.sales_order_id, shipment.customer_name || 'the customer');
  const completedAs = shipment.handover === 'COLLECTED' ? 'collected by the customer'
    : shipment.handover === 'DELIVERED_BY_US' ? 'delivered by you' : 'handed to the carrier';
  req.flash('success', `${shipment.shipment_number} is recorded as ${completedAs}. ${shipment.units} left stock, and the sale is now in Accounting.${told}${chasedBox}`);
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
        autoRequestLimitMinor: req.body.autoRequestLimit
          ? Math.round(Number(req.body.autoRequestLimit) * 100) : null,
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
      salesOrderId: order.id,
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
  res.redirect(303, `/orders/${req.params.id}?payment=paid#money`);
}));

module.exports = router;





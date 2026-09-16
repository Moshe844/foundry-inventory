'use strict';

/*
 * Asking a customer for money without being told to.
 *
 * The owner's complaint was that all of this was manual: an order shipped, and
 * then somebody had to remember to go and ask for the money, find the button,
 * press it, find the link, and send it. That is a job, and it is the job
 * StockChief is supposed to be doing.
 *
 * What it may do is not decided here. Three things have to agree:
 *
 *   1. Workspace authority. `autopilot/modes` already answers "may StockChief act
 *      on its own", and OBSERVE means it may not do anything at all — not even
 *      prepare, because preparing a Stripe invoice is a real object in a real
 *      account.
 *   2. This customer's terms. A per-customer switch, off by default, with a
 *      limit. Both are required: a switch with no limit is an open cheque.
 *   3. A mailbox to send from.
 *
 * When all three agree, StockChief asks and sends and says it did. When authority
 * is short of that, it still gets everything ready — the link and the written
 * email — and leaves it for a person, which is one press instead of five. That
 * split is the owner's instruction, not a default chosen here: automatic when
 * the business has granted the authority, prepared-and-waiting when it has not.
 *
 * Nothing in here decides an amount. What is due comes from the customer's
 * terms via the payment position, exactly as it does when a person clicks the
 * button, and it is deliberately not tied to shipping: a deposit before
 * anything is picked runs through this same path.
 */

const { nowIso } = require('../lib/util');

/** The three questions, answered separately so the reason can be reported. */
function whatStockChiefMay(db, workspaceId, terms, amountMinor) {
  const state = require('../autopilot/modes').get(db, workspaceId);
  const accountingSuspended = state.suspended && (!state.suspendedScope
    || ['accounting','finance','payments'].includes(state.suspendedScope));
  if (state.paused || accountingSuspended || state.mode === 'OBSERVE') {
    return { prepare: false, send: false,
      because: state.paused ? 'StockChief is paused.'
        : accountingSuspended ? 'StockChief has stopped payment work and is waiting to be looked at.'
          : 'StockChief is set to watch only, so it prepares nothing on its own.' };
  }

  const sending = require('./customer-communications').sendingMailbox(db, workspaceId);
  if (!terms || !terms.autoRequestEnabled) {
    return { prepare: true, send: false,
      because: 'Nobody has agreed that StockChief may ask this customer for money on its own.' };
  }
  if (terms.autoRequestLimitMinor === null || terms.autoRequestLimitMinor === undefined) {
    return { prepare: true, send: false,
      because: 'There is no limit on what StockChief may ask this customer for, so it did not ask.' };
  }
  if (amountMinor > Number(terms.autoRequestLimitMinor)) {
    return { prepare: true, send: false,
      because: `${(amountMinor / 100).toFixed(2)} is over the `
        + `${(Number(terms.autoRequestLimitMinor) / 100).toFixed(2)} StockChief may ask for on its own.` };
  }
  /*
   * Authorised for this job specifically. Being allowed to chase an invoice
   * is not being allowed to spend money, and the mode alone used to grant
   * both at once.
   */
  const permitted = require('../autopilot/capabilities').may(db, workspaceId, 'payment_requests');
  if (!permitted.allowed) {
    return { prepare: true, send: false, because: permitted.because };
  }
  if (!sending.connectorId) {
    return { prepare: true, send: false,
      because: sending.options.length
        ? 'More than one mailbox is connected and none is set for customer messages.'
        : 'No mailbox is connected, so there was nothing to send it from.' };
  }
  return { prepare: true, send: true, because: null };
}

/**
 * Money has become due on this order. Act on it as far as authority allows.
 *
 * Called after confirming and after shipping, because those are the two
 * moments the position changes — but the trigger is the position, not the
 * event. An order with a deposit due the moment it is confirmed is asked for
 * then; an order with terms that only bite at shipment is asked for then.
 *
 * Never throws into its caller. A payment that could not be asked for is not
 * a reason to fail a shipment that physically happened, or to unconfirm an
 * order the customer has committed to.
 */
async function onMoneyDue(db, ctx, orderId) {
  try {
    return await attempt(db, ctx, orderId);
  } catch (error) {
    return { asked: false, sent: false, because: String(error.message || error) };
  }
}

async function attempt(db, ctx, orderId) {
  const workspaceId = ctx.workspaceId;
  const collection = require('../payments/collection');
  const paymentTerms = require('./payment-terms');

  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ? AND workspace_id = ?')
    .get(orderId, workspaceId);
  if (!order || order.status === 'CANCELLED' || order.status === 'DRAFT') {
    return { asked: false, sent: false, because: null };
  }

  // Somebody already asked. Two links for one debt is worse than none.
  if (collection.openLinkForOrder(db, workspaceId, orderId)) {
    return { asked: false, sent: false, because: null };
  }

  const position = paymentTerms.positionForOrder(db, workspaceId, order);
  const dueNow = Number(position.dueNowMinor || 0);
  const remaining = Number(position.remainingMinor || 0);
  const purpose = dueNow > 0 && dueNow < remaining ? 'DEPOSIT' : 'BALANCE';
  const amountMinor = purpose === 'DEPOSIT' ? dueNow : remaining;
  if (amountMinor <= 0) return { asked: false, sent: false, because: null };

  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND workspace_id = ?')
    .get(order.customer_id, workspaceId);
  const terms = paymentTerms.forCustomer(db, workspaceId, order.customer_id);
  const may = whatStockChiefMay(db, workspaceId, terms, amountMinor);
  if (!may.prepare) return { asked: false, sent: false, because: may.because };

  // A link has to be able to reach somebody, however it is going to be sent.
  if (!customer || !customer.email) {
    return { asked: false, sent: false,
      because: `There is no email address for ${customer ? customer.name : 'this customer'}.` };
  }
  if (!require('../payments/provider').list().length) {
    return { asked: false, sent: false, because: 'No payment provider is connected.' };
  }

  if (!may.send) {
    const asked = await collection.request(db, ctx, orderId, { purpose });
    const comms = require('./customer-communications');
    const draft = comms.preparePaymentLink(db, ctx, asked.id);
    return { asked: true, sent: false, request: asked, message: draft, because: may.because };
  }

  const autonomous = require('../autonomous/service');
  const operation = autonomous.create(db, ctx, {
    operationType:'finance.collect', idempotencyKey:`collect:${orderId}:${purpose}`,
    sourceKind:'sales_order', sourceId:orderId,
    title:`Ask ${customer.name} to pay`,
    summary:`The recorded terms say ${purpose.toLowerCase()} payment is due now.`,
    link:`/orders/${orderId}/detail?open=money#money`,
    evidence:[{ label:'Amount due', value:(amountMinor / 100).toFixed(2) },
      { label:'Payment stage', value:purpose }, { label:'Customer', value:customer.name }],
    decision:{ orderId, purpose, customerId:customer.id },
    affectedEntities:{ salesOrderId:orderId, customerId:customer.id },
    authorityDimensions:{ valueMinor:amountMinor, customerId:customer.id,
      confidence:'high', risk:'high' },
    expectedOutcome:{ paymentRequestCreated:true, customerMessageStatus:'SENT' },
  });
  const governed = await autonomous.run(db, ctx, null, operation.id);
  if (governed.operation.status !== 'COMPLETED') {
    const actual = governed.operation.actualOutcome || {};
    return { asked:Boolean(actual.request), sent:false, request:actual.request || null,
      message:actual.message || null,
      because:governed.operation.errorMessage || (governed.authority?.checks || [])
        .filter((check) => !check.passed).map((check) => check.reason).join(' '),
      operation:governed.operation };
  }
  return { ...governed.operation.actualOutcome, operation:governed.operation };
}

async function collectAndSend(db, ctx, orderId, purpose) {
  const collection = require('../payments/collection');
  const comms = require('./customer-communications');
  const asked = await collection.request(db, ctx, orderId, { purpose });
  const draft = comms.preparePaymentLink(db, ctx, asked.id);
  try {
    await comms.sendThroughMailbox(db, ctx.workspaceId, draft.id, null);
  } catch (error) {
    return { asked:true, sent:false, request:asked,
      message:comms.get(db, ctx.workspaceId, draft.id),
      because:`The link was made but could not be sent: ${error.message || error}` };
  }
  return { asked:true, sent:true, request:asked,
    message:comms.get(db, ctx.workspaceId, draft.id), because:null, at:nowIso() };
}

require('../autonomous/service').registerAdapter('finance.collect', {
  owner:'sales.payment-automation',
  authorize:({ db, ctx, operation, execution }) => {
    const order = db.prepare('SELECT * FROM sales_orders WHERE id = ? AND workspace_id = ?')
      .get(operation.decision.orderId, ctx.workspaceId);
    const terms = order && require('./payment-terms').forCustomer(db, ctx.workspaceId,
      order.customer_id);
    const current = whatStockChiefMay(db, ctx.workspaceId, terms,
      Number(operation.authorityDimensions.valueMinor || 0));
    const checks = [
      { name:'executionState', passed:execution.allowed,
        reason:execution.because || 'Collection automation is active.' },
      { name:'customerTerms', passed:current.send,
        reason:current.because || 'The customer terms and collection limit allow this request.' },
    ];
    return { allowed:checks.every((check) => check.passed), checks };
  },
  execute:({ db, ctx, operation }) => collectAndSend(db, ctx,
    operation.decision.orderId, operation.decision.purpose),
  verify:({ db, ctx, operation, actualOutcome }) => {
    const request = actualOutcome?.request?.id
      ? require('../payments/collection').get(db, ctx.workspaceId, actualOutcome.request.id) : null;
    const message = actualOutcome?.message?.id
      ? require('./customer-communications').get(db, ctx.workspaceId, actualOutcome.message.id) : null;
    const passed = Boolean(request && message?.status === 'SENT');
    return { passed, reason:passed
      ? 'The payment request exists once and the connected mailbox confirms the customer message was sent.'
      : (actualOutcome?.because || 'The payment request and sent message did not both verify.'),
    paymentRequestId:request?.id || null, communicationId:message?.id || null };
  },
});

module.exports = { onMoneyDue, whatStockChiefMay };

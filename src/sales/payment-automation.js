'use strict';

/*
 * Asking a customer for money without being told to.
 *
 * The owner's complaint was that all of this was manual: an order shipped, and
 * then somebody had to remember to go and ask for the money, find the button,
 * press it, find the link, and send it. That is a job, and it is the job
 * Foundry is supposed to be doing.
 *
 * What it may do is not decided here. Three things have to agree:
 *
 *   1. Workspace authority. `autopilot/modes` already answers "may Foundry act
 *      on its own", and OBSERVE means it may not do anything at all — not even
 *      prepare, because preparing a Stripe invoice is a real object in a real
 *      account.
 *   2. This customer's terms. A per-customer switch, off by default, with a
 *      limit. Both are required: a switch with no limit is an open cheque.
 *   3. A mailbox to send from.
 *
 * When all three agree, Foundry asks and sends and says it did. When authority
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
function whatFoundryMay(db, workspaceId, terms, amountMinor) {
  const state = require('../autopilot/modes').get(db, workspaceId);
  if (state.paused || state.suspended || state.mode === 'OBSERVE') {
    return { prepare: false, send: false,
      because: state.paused ? 'Foundry is paused.'
        : state.suspended ? 'Foundry has stopped itself and is waiting to be looked at.'
          : 'Foundry is set to watch only, so it prepares nothing on its own.' };
  }

  const sending = require('./customer-communications').sendingMailbox(db, workspaceId);
  if (!terms || !terms.autoRequestEnabled) {
    return { prepare: true, send: false,
      because: 'Nobody has agreed that Foundry may ask this customer for money on its own.' };
  }
  if (terms.autoRequestLimitMinor === null || terms.autoRequestLimitMinor === undefined) {
    return { prepare: true, send: false,
      because: 'There is no limit on what Foundry may ask this customer for, so it did not ask.' };
  }
  if (amountMinor > Number(terms.autoRequestLimitMinor)) {
    return { prepare: true, send: false,
      because: `${(amountMinor / 100).toFixed(2)} is over the `
        + `${(Number(terms.autoRequestLimitMinor) / 100).toFixed(2)} Foundry may ask for on its own.` };
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
  const may = whatFoundryMay(db, workspaceId, terms, amountMinor);
  if (!may.prepare) return { asked: false, sent: false, because: may.because };

  // A link has to be able to reach somebody, however it is going to be sent.
  if (!customer || !customer.email) {
    return { asked: false, sent: false,
      because: `There is no email address for ${customer ? customer.name : 'this customer'}.` };
  }
  if (!require('../payments/provider').list().length) {
    return { asked: false, sent: false, because: 'No payment provider is connected.' };
  }

  const asked = await collection.request(db, ctx, orderId, { purpose });
  const comms = require('./customer-communications');
  const draft = comms.preparePaymentLink(db, ctx, asked.id);

  if (!may.send) {
    return { asked: true, sent: false, request: asked, message: draft, because: may.because };
  }

  /*
   * The send is caught separately from everything above it, because by this
   * point the money HAS been asked for: there is a live invoice at the
   * provider with the customer's name on it. Letting a mailbox failure report
   * "nothing was asked for" would tell the owner the opposite of the truth and
   * invite them to ask a second time.
   */
  try {
    await comms.sendThroughMailbox(db, workspaceId, draft.id, null);
  } catch (error) {
    return { asked: true, sent: false, request: asked,
      message: comms.get(db, workspaceId, draft.id),
      because: `The link was made but could not be sent: ${error.message || error}` };
  }
  return { asked: true, sent: true, request: asked,
    message: comms.get(db, workspaceId, draft.id), because: null, at: nowIso() };
}

module.exports = { onMoneyDue, whatFoundryMay };

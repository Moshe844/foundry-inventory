'use strict';

/**
 * Where an understood instruction goes next.
 *
 * The reader can come back with more than a proposal or a question: a
 * message to send, a supplier payment to confirm. Both were being read
 * correctly and then dropped, because the two routes that call the reader
 * only knew where proposals and questions go. "Please email motty@… that we
 * received the order" produced a perfectly good draft, and what the person
 * saw was "StockChief needs more detail" over the home page.
 *
 * Both routes call this first. It returns where to send the person, having
 * done whatever is needed for that page to exist, or null when the result is
 * one the caller shows itself.
 */

const outbound = require('../actions/outbound-message');

function handOff(req, result) {
  if (!result) return null;

  if (result.kind === 'message_draft') {
    // Written down so there is a page to read it on. Nothing is sent.
    const message = outbound.record(req.db, req.ctx, result);
    return { target: `/messages/${message.id}`, related: message.id, routedTo: 'message' };
  }

  if (result.kind === 'supplier_payment') {
    req.session.pendingSupplierPayment = {
      billId: result.bill.id,
      billNumber: result.bill.bill_number,
      supplierName: result.supplier.name,
      currency: result.bill.currency,
      amountMinor: result.amountMinor,
      balanceMinor: Number(result.bill.balance_minor),
      remainingAfterMinor: result.remainingAfterMinor,
      instruction: result.instruction || null,
    };
    return { target: '/actions/supplier-payment', related: result.bill.id, routedTo: 'supplier_payment' };
  }

  return null;
}

module.exports = { handOff };

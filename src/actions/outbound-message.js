'use strict';

/**
 * Somebody asks StockChief to write to a customer or a supplier.
 *
 * StockChief has sent mail for a while — shipping notices, payment links,
 * purchase orders, replies to customers — but only ever as a consequence of
 * something else happening. Asked outright to email somebody, it said it could
 * not: the operation simply was not in the list of things it could choose to
 * do, so the reader picked "unsupported" and wrote a limitation that was not
 * true.
 *
 * Nothing here sends. A message goes out in the owner's name, so it is
 * written, shown, and sent only when they say so — the same rule the shipping
 * notice and the payment link already follow. The difference between those and
 * this is only who started it.
 */

const { ValidationError } = require('../domain/errors');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const compare = (value) => String(value || '').trim().toLowerCase();

/**
 * Who this is going to.
 *
 * An address is taken as written. A name is looked up among the people the
 * business already deals with — and never guessed at, because a message sent
 * to the wrong customer cannot be recalled.
 */
function findRecipient(db, workspaceId, text) {
  const wanted = compare(text);
  if (!wanted) return null;
  if (EMAIL.test(wanted)) return { kind: 'address', name: text.trim(), email: text.trim() };

  const customer = db.prepare(`SELECT id, name, email FROM customers
    WHERE workspace_id = ? AND name = ? COLLATE NOCASE`).get(workspaceId, text.trim());
  if (customer) return { kind: 'customer', id: customer.id, name: customer.name, email: customer.email };

  const supplier = db.prepare(`SELECT id, name, email FROM suppliers
    WHERE workspace_id = ? AND name = ? COLLATE NOCASE`).get(workspaceId, text.trim());
  if (supplier) return { kind: 'supplier', id: supplier.id, name: supplier.name, email: supplier.email };

  return null;
}

/**
 * Write it down and show it.
 *
 * The words are the owner's. StockChief does not compose, improve or expand
 * them: a message that says more than the person asked it to say is a message
 * they did not write, going out over their name.
 */
function prepare(db, ctx, { recipientText, body, instruction }) {
  const recipient = findRecipient(db, ctx.workspaceId, recipientText);
  if (!recipientText) {
    return { kind: 'question', question: 'Who should StockChief send that to?' };
  }
  if (!recipient) {
    return { kind: 'question',
      question: `StockChief has no customer or supplier called “${recipientText}”, `
        + 'and that is not an email address. Who should this go to?' };
  }
  if (!recipient.email) {
    return { kind: 'question',
      question: `There is no email address on file for ${recipient.name}, so there is nowhere to send this.` };
  }
  if (!String(body || '').trim()) {
    return { kind: 'question', question: `What should StockChief say to ${recipient.name}?` };
  }

  /*
   * A mailbox has to exist to send from. Saying so now is better than writing
   * the message, showing it, and failing at the moment they press send.
   */
  const sending = require('../sales/customer-communications').sendingMailbox(db, ctx.workspaceId);
  if (!sending.connectorId) {
    return { kind: 'question',
      question: sending.options.length
        ? 'More than one mailbox is connected and none is set for customer messages. '
          + 'Choose which one StockChief should send from in Settings.'
        : 'No mailbox is connected, so StockChief has nothing to send this from. '
          + 'Connect one in Settings and this will go out from your own address.' };
  }

  return {
    kind: 'message_draft',
    recipient,
    body: String(body).trim(),
    instruction,
    /*
     * Deliberately not a subject StockChief invented. The owner said what they
     * wanted said; inventing a heading for it is the first step towards
     * inventing the rest.
     */
    subject: null,
  };
}

/**
 * Write it down, so there is a page to read it on and a button to send it.
 *
 * It goes into the same record every other customer message uses, with the
 * same PREPARED status. A draft that lived only in memory was a draft the
 * person could not find again — and, as it turned out, never saw at all.
 */
function record(db, ctx, draft) {
  if (!draft || draft.kind !== 'message_draft') {
    throw new ValidationError('There is no prepared message to record.');
  }
  const comms = require('../sales/customer-communications');
  const sending = comms.sendingMailbox(db, ctx.workspaceId);
  return comms.prepareOwnerMessage(db, ctx, {
    recipient: draft.recipient.email,
    customerId: draft.recipient.kind === 'customer' ? draft.recipient.id : null,
    subject: draft.subject,
    body: draft.body,
    connectorId: sending.connectorId,
  });
}

/** Send what was approved, through the mailbox everything else goes through. */
async function send(db, ctx, membership, draft, options = {}) {
  const comms = require('../sales/customer-communications');
  const message = draft && draft.id ? draft : record(db, ctx, draft);
  if (options.subject) {
    comms.updateDraft(db, ctx.workspaceId, message.id, { subject: options.subject });
  }
  return comms.sendThroughMailbox(db, ctx.workspaceId, message.id, ctx.actorId || null);
}

module.exports = { prepare, record, send, findRecipient };

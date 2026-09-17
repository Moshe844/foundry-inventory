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

  /*
   * "Acme" is Acme Trade Supply when nobody else is called Acme. A short
   * name is taken only when it fits exactly one customer or supplier — a
   * message to the wrong one cannot be recalled, so two fits is a question.
   */
  const like = `%${text.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const customers = db.prepare(`SELECT id, name, email FROM customers WHERE workspace_id = ? AND name LIKE ? ESCAPE '\\'
    AND (record_state IS NULL OR record_state <> 'ARCHIVED')`).all(workspaceId, like);
  const suppliers = db.prepare(`SELECT id, name, email FROM suppliers WHERE workspace_id = ? AND name LIKE ? ESCAPE '\\'
    AND status = 'active'`).all(workspaceId, like);
  if (customers.length + suppliers.length === 1) {
    const one = customers[0] || suppliers[0];
    return { kind: customers[0] ? 'customer' : 'supplier', id: one.id, name: one.name, email: one.email };
  }
  if (customers.length + suppliers.length > 1) {
    return { kind: 'several', candidates: [...customers.map((c) => c.name), ...suppliers.map((s) => s.name)] };
  }
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
  if (recipient.kind === 'several') {
    return { kind: 'question',
      question: `“${recipientText}” could be ${recipient.candidates.join(' or ')}. Which one?`,
      choices: recipient.candidates.map((name) => ({ label: name, value: name })) };
  }
  if (!recipient.email) {
    // A dead end with the way out attached: the record that needs the address.
    return { kind: 'question',
      question: `There is no email address on file for ${recipient.name}, so there is nowhere to send this. Add one on their record and send this again.`,
      where: recipient.id ? { label: `Add an email for ${recipient.name}`, href: recipient.kind === 'supplier' ? `/suppliers/${recipient.id}` : `/sales/customers/${recipient.id}` } : null };
  }
  if (!String(body || '').trim()) {
    return { kind: 'question', question: `What should StockChief say to ${recipient.name}?` };
  }

  /*
   * No mailbox is not no draft. The draft is written and shown either way;
   * its page says there is nothing to send it from and offers the words to
   * copy, or the settings to connect one. Refusing to write it left the
   * person with nothing at all.
   */
  const sending = require('../sales/customer-communications').sendingMailbox(db, ctx.workspaceId);

  return {
    kind: 'message_draft',
    recipient,
    body: String(body).trim(),
    instruction,
    mailbox: sending.connectorId ? 'ready' : sending.options.length ? 'unchosen' : 'none',
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
  const message = comms.prepareOwnerMessage(db, ctx, {
    recipient: draft.recipient.email,
    customerId: draft.recipient.kind === 'customer' ? draft.recipient.id : null,
    subject: draft.subject,
    body: draft.body,
    connectorId: sending.connectorId,
    messageKind: draft.composed ? 'assistant_draft' : 'owner_message',
  });
  // The facts a composed draft was written from, kept beside it for its page.
  if (draft.composed && Array.isArray(draft.facts)) {
    try {
      db.prepare(`INSERT INTO assistant_draft_facts (message_id, workspace_id, facts, facts_used, instruction, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(message.id, ctx.workspaceId, JSON.stringify(draft.facts), JSON.stringify(draft.factsUsed || []), String(draft.instruction || '').slice(0, 2000), new Date().toISOString());
    } catch (err) { console.error('[foundry] could not keep the draft facts', err); }
  }
  return message;
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

/*
 * Words dictated are kept exactly; a purpose stated is written up from the
 * recipient's own records, checked, and shown as a draft with the facts it
 * used. "Email Lakeside and ask for a price list" is the second kind.
 */
async function prepareOrCompose(db, ctx, { recipientText, body, instruction }, options = {}) {
  const mailDraft = require('../assistant/mail-draft');
  if (!mailDraft.wantsComposition(instruction, body)) return prepare(db, ctx, { recipientText, body, instruction });
  // The recipient has to be one StockChief knows before anything is written about them.
  const shaped = prepare(db, ctx, { recipientText, body: body || '(to be written)', instruction });
  if (shaped.kind !== 'message_draft') return shaped;
  const composed = await mailDraft.compose(db, ctx, {
    recipient: shaped.recipient, purpose: String(body || instruction).trim(), instruction, referentNote: options.referentNote || '',
  }, { provider: options.provider });
  if (!composed.ok) return { kind: 'question', question: composed.question };
  return { ...shaped, body: composed.body, subject: composed.subject, composed: true, facts: composed.facts, factsUsed: composed.factsUsed };
}

module.exports = { prepare, prepareOrCompose, record, send, findRecipient };

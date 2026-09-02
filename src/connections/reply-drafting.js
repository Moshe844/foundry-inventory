'use strict';

/**
 * A reply, written from what Foundry can prove.
 *
 * This is the first place a model writes words that leave the building
 * addressed to somebody outside the business, so the split is stricter than
 * anywhere else in Foundry.
 *
 * Foundry gathers the facts. Deterministically, from records: who this sender
 * is, what they have on order, what shipped and when, what is tracked where,
 * what is still owed. The model is handed those facts and the message being
 * answered, and may only arrange words around them.
 *
 * Then everything it returns is checked back against the facts. Every number
 * must already appear in them — the same guard the attention brief and Ask
 * Foundry use. Every date must too, and that check is here rather than there
 * because a reply is where an invented date does real damage: "your order will
 * arrive Thursday" is a promise a customer will hold you to, and nobody at the
 * business ever made it.
 *
 * A draft that fails either check is thrown away, and a plainer one built from
 * the facts alone is offered instead. So is the case where there is no model,
 * the call fails, or it is slow. The owner reads and sends either way; nothing
 * here reaches anybody on its own.
 */

const config = require('../config');
const interpretation = require('../attention/interpretation-service');
const { createProviderForTier } = require('../ai/provider');
const { nowIso, trimOrNull } = require('../lib/util');
const { NotFoundError, ValidationError } = require('../domain/errors');

const SYSTEM = `You are answering a business email on behalf of a small company,
in the owner's voice.

You are given the message that arrived and a list of facts from the company's
own records. Write a short, direct reply.

Rules that are not style preferences:
- Use only facts from the list you are given. If the message asks something the
  facts do not answer, say plainly that you are checking and will come back to
  them. Never guess.
- Never invent a number, a date, a day of the week, a price, or a quantity. If a
  date is not in the facts, do not name one.
- Never promise anything the facts do not already show has happened or is
  scheduled.
- No apologies for things you cannot verify happened, and no blame.
- Do not mention Foundry, software, systems, or that this was drafted.
- Three short paragraphs at most. Write the way a person types an email, not the
  way a company writes a letter.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body'],
  properties: {
    subject: { type: 'string', maxLength: 160 },
    body: { type: 'string', maxLength: 1600 },
  },
};

/*
 * Words that name a day or a month.
 *
 * A number guard cannot see "Thursday". Left unchecked, a model asked to
 * reassure somebody reaches for exactly that word, and the business finds
 * itself committed to a delivery date nobody chose.
 */
const WHEN = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|today|tomorrow|tonight|this week|next week|this month|next month)\b/gi;

/*
 * Language that commits the business to something records cannot support.
 */
const OVERPROMISING = [
  /\bguarantee(?:d|ing)?\b/i,
  /\b(?:full|complete|immediate)\s+refund\b/i,
  /\bwill\s+definitely\b/i,
  /\bno\s+charge\b/i,
  /\bfree\s+of\s+charge\b/i,
  /\bcompensat(?:e|ion)\b/i,
];

const numbersOf = (text) => (String(text || '').match(/\d+(?:[.,]\d+)?/g) || [])
  .map((value) => value.replace(/,/g, ''));

/**
 * Who this sender is, and everything Foundry holds about them.
 *
 * Read only. No number below is calculated here — each is a column, so the
 * facts handed to the model are the same figures the owner can find on the
 * order, the shipment and the invoice.
 */
function factsFor(db, workspaceId, message) {
  const sender = String(message.sender || '').toLowerCase();
  const facts = [];

  const customer = db.prepare('SELECT * FROM customers WHERE workspace_id = ? AND LOWER(email) = ?')
    .get(workspaceId, sender);
  const supplier = message.supplier_id
    ? db.prepare('SELECT * FROM suppliers WHERE id = ? AND workspace_id = ?').get(message.supplier_id, workspaceId)
    : db.prepare('SELECT * FROM suppliers WHERE workspace_id = ? AND LOWER(email) = ?').get(workspaceId, sender);

  if (customer) {
    facts.push(`They are a customer of ours: ${customer.name}.`);
    const orders = db.prepare(`SELECT so.id, so.order_number, so.status, so.order_date, so.needed_by,
        COALESCE(SUM(sol.quantity_ordered), 0) AS ordered,
        COALESCE(SUM(sol.quantity_fulfilled), 0) AS shipped
      FROM sales_orders so
      LEFT JOIN sales_order_lines sol ON sol.sales_order_id = so.id
      WHERE so.workspace_id = ? AND so.customer_id = ? AND so.status <> 'CANCELLED'
      GROUP BY so.id ORDER BY so.order_date DESC LIMIT 5`).all(workspaceId, customer.id);

    for (const order of orders) {
      facts.push(`Order ${order.order_number}, placed ${order.order_date}: `
        + `${order.ordered} ordered, ${order.shipped} shipped so far.`
        + (order.needed_by ? ` They needed it by ${order.needed_by}.` : ''));

      for (const box of db.prepare(`SELECT shipment_number, status, carrier, service, tracking_number,
          shipped_at, expected_delivery_date, delivered_at
        FROM sales_shipments WHERE workspace_id = ? AND sales_order_id = ? AND status <> 'CANCELLED'
        ORDER BY created_at`).all(workspaceId, order.id)) {
        if (box.status === 'DELIVERED') {
          facts.push(`Shipment ${box.shipment_number} on that order was delivered on ${box.delivered_at}.`);
        } else if (box.status === 'SHIPPED') {
          facts.push(`Shipment ${box.shipment_number} on that order left on ${box.shipped_at}`
            + (box.carrier ? ` with ${box.carrier}${box.service ? ` ${box.service}` : ''}` : '')
            + (box.tracking_number ? `, tracking number ${box.tracking_number}` : '')
            + (box.expected_delivery_date ? `, expected ${box.expected_delivery_date}` : '')
            + '.');
        } else {
          facts.push(`Shipment ${box.shipment_number} on that order is being prepared and has not left yet.`);
        }
      }

      const live = require('../payments/collection')
        .openLinkForOrder(db, workspaceId, order.id);
      if (live) {
        facts.push(`We have asked them for ${(live.amountMinor / 100).toFixed(2)} `
          + `${live.purpose === 'DEPOSIT' ? 'as a deposit ' : ''}`
          + `and the page they pay on is ${live.hostedUrl}`);
      }

      for (const invoice of db.prepare(`SELECT invoice_number, total_minor, balance_minor, currency, due_date
        FROM accounting_customer_invoices
        WHERE workspace_id = ? AND sales_order_id = ?`).all(workspaceId, order.id)) {
        facts.push(`Invoice ${invoice.invoice_number} for that order: `
          + `${invoice.currency} ${(Number(invoice.total_minor) / 100).toFixed(2)} invoiced, `
          + `${invoice.currency} ${(Number(invoice.balance_minor) / 100).toFixed(2)} still outstanding`
          + (invoice.due_date ? `, due ${invoice.due_date}` : '') + '.');
      }
    }
    if (!orders.length) facts.push('They have no open orders with us.');
  }

  if (supplier) {
    facts.push(`They are a supplier of ours: ${supplier.name}.`);
    const orders = db.prepare(`SELECT po_number, status, ordered_at, expected_date
      FROM purchase_orders WHERE workspace_id = ? AND supplier_id = ?
      ORDER BY created_at DESC LIMIT 5`).all(workspaceId, supplier.id);
    for (const order of orders) {
      facts.push(`Our purchase order ${order.po_number} with them is ${String(order.status).toLowerCase()}`
        + (order.ordered_at ? `, sent ${order.ordered_at}` : '')
        + (order.expected_date ? `, expected ${order.expected_date}` : '') + '.');
    }
    if (!orders.length) facts.push('We have no open purchase orders with them.');
  }

  if (!customer && !supplier) {
    facts.push('Foundry does not recognise this sender as a customer or a supplier, '
      + 'so it holds no orders, shipments or invoices for them.');
  }
  return facts;
}

/**
 * A reply built from the facts alone.
 *
 * Not a fallback in the apologetic sense — it is what Foundry can honestly say
 * without a model, and it is the thing the model's version has to beat.
 */
function withoutModel(message, facts) {
  const subject = String(message.subject || '').match(/^re:/i)
    ? message.subject : `Re: ${message.subject || 'your message'}`;
  const known = facts.filter((fact) => !fact.startsWith('Foundry does not recognise'));
  const body = [
    'Hello,',
    '',
    'Thanks for your message.',
    '',
    ...(known.length
      ? ['Here is what we have on record:', ...known.map((fact) => `- ${fact}`)]
      : ['I am looking into it and will come back to you.']),
    '',
    'Best regards,',
  ].join('\n');
  return { subject, body, source: 'facts' };
}

/**
 * Everything the reply is allowed to state.
 *
 * The inbound message counts: quoting back a number the sender themselves used
 * is not inventing one.
 */
function permittedFrom(message, facts) {
  const permitted = new Set();
  for (const value of [message.subject, message.body_text, ...facts]) {
    for (const number of numbersOf(value)) permitted.add(number);
  }
  return permitted;
}

function datesAreGrounded(text, message, facts) {
  const source = `${message.subject || ''} ${message.body_text || ''} ${facts.join(' ')}`.toLowerCase();
  for (const named of String(text).match(WHEN) || []) {
    if (!source.includes(named.toLowerCase())) return false;
  }
  return true;
}

/**
 * Why a draft was rejected, or null if it stands.
 *
 * Returned rather than thrown: the owner is told which check failed, because
 * "Foundry wrote something and threw it away" is only trustworthy if it says
 * what was wrong with it.
 */
function faultIn(draft, message, facts) {
  const text = `${draft.subject} ${draft.body}`;
  if (!interpretation.numbersAreGrounded(text, permittedFrom(message, facts))) {
    return 'it used a figure that is not in your records';
  }
  if (!datesAreGrounded(text, message, facts)) {
    return 'it named a date nobody has committed to';
  }
  if (interpretation.FORBIDDEN.some((pattern) => pattern.test(text))) {
    return 'it claimed something had been done that Foundry cannot show was done';
  }
  if (OVERPROMISING.some((pattern) => pattern.test(text))) {
    return 'it promised something your records do not support';
  }
  return null;
}

function requireMessage(db, workspaceId, messageId) {
  const row = db.prepare(`SELECT m.*, s.name AS supplier_name FROM connection_email_messages m
    LEFT JOIN suppliers s ON s.id = m.supplier_id
    WHERE m.id = ? AND m.workspace_id = ?`).get(messageId, workspaceId);
  if (!row) throw new NotFoundError('That message is not in this inventory.');
  return row;
}

/**
 * Write the draft, and keep it with the message.
 */
async function draft(db, ctx, messageId, options = {}) {
  const message = requireMessage(db, ctx.workspaceId, messageId);
  const facts = factsFor(db, ctx.workspaceId, message);
  const plain = withoutModel(message, facts);

  let chosen = plain;
  let rejected = null;

  const useModel = !options.deterministicOnly && (options.provider || config.ai.configured);
  if (useModel) {
    const provider = options.provider || createProviderForTier('fast');
    try {
      const response = await provider.complete({
        system: SYSTEM,
        prompt: [
          `From: ${message.sender}`,
          `Subject: ${message.subject || '(none)'}`,
          '',
          'They wrote:',
          String(message.body_text || '(no text)'),
          '',
          'Facts from our records:',
          ...(facts.length ? facts.map((fact) => `- ${fact}`) : ['- We hold nothing about this sender.']),
        ].join('\n'),
        schema: SCHEMA,
        schemaName: 'prepared_reply',
      });
      const candidate = response && response.data
        ? { subject: trimOrNull(response.data.subject), body: trimOrNull(response.data.body) }
        : null;
      if (candidate && candidate.subject && candidate.body) {
        const fault = faultIn(candidate, message, facts);
        if (fault) rejected = fault;
        else chosen = { ...candidate, source: 'model' };
      }
    } catch {
      // No draft from the model is not a failure worth surfacing; the plain
      // one below is a working reply either way.
    }
  }

  const now = nowIso();
  db.prepare(`UPDATE connection_email_messages SET draft_subject = ?, draft_body = ?,
    draft_source = ?, draft_rejected_because = ?, draft_at = ? WHERE id = ? AND workspace_id = ?`)
    .run(chosen.subject, chosen.body, chosen.source, rejected, now, messageId, ctx.workspaceId);
  return { subject: chosen.subject, body: chosen.body, source: chosen.source, rejected, facts };
}

function getDraft(db, workspaceId, messageId) {
  const row = requireMessage(db, workspaceId, messageId);
  if (!row.draft_body) return null;
  return {
    subject: row.draft_subject,
    body: row.draft_body,
    source: row.draft_source,
    rejected: row.draft_rejected_because,
    at: row.draft_at,
    sentAt: row.reply_sent_at,
  };
}

function saveDraft(db, ctx, messageId, input = {}) {
  const message = requireMessage(db, ctx.workspaceId, messageId);
  if (message.reply_sent_at) throw new ValidationError('This reply has already been sent.');
  const body = String(input.body === undefined ? message.draft_body : input.body);
  if (!body.trim()) throw new ValidationError('A reply needs something in it.');
  db.prepare(`UPDATE connection_email_messages SET draft_subject = ?, draft_body = ?,
    draft_source = 'person', draft_rejected_because = NULL, draft_at = ?
    WHERE id = ? AND workspace_id = ?`)
    .run(trimOrNull(input.subject) || message.draft_subject, body, nowIso(), messageId, ctx.workspaceId);
  return getDraft(db, ctx.workspaceId, messageId);
}

/**
 * Send it, and mark the conversation as waiting on them.
 */
async function send(db, ctx, messageId) {
  const message = requireMessage(db, ctx.workspaceId, messageId);
  if (message.reply_sent_at) return getDraft(db, ctx.workspaceId, messageId);
  if (!message.draft_body) throw new ValidationError('There is no reply written yet.');
  const state = require('../autopilot/modes').get(db, ctx.workspaceId);
  if (state.paused || state.suspended) throw new ValidationError('Foundry is paused. Nothing was sent.');

  const result = await require('./provider-service').sendMailboxMessage(db, ctx.workspaceId, message.connector_id, {
    recipient: message.sender,
    subject: message.draft_subject,
    body: message.draft_body,
    externalThreadId: message.external_thread_id,
    connectorId: message.connector_id,
  });
  const now = nowIso();
  db.prepare(`UPDATE connection_email_messages SET reply_sent_at = ?, reply_external_message_id = ?,
    reply_state = 'WAITING', reply_reason = ?, reply_state_by_user_id = ?, reply_state_at = ?
    WHERE id = ? AND workspace_id = ?`)
    .run(now, result?.externalMessageId || null, 'You replied, so the ball is with them.',
      ctx.actorId || null, now, messageId, ctx.workspaceId);
  return getDraft(db, ctx.workspaceId, messageId);
}

module.exports = {
  SYSTEM, WHEN, OVERPROMISING,
  factsFor, withoutModel, permittedFrom, datesAreGrounded, faultIn,
  draft, getDraft, saveDraft, send,
};

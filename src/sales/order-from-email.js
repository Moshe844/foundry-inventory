'use strict';

/*
 * Reading a customer's email as a Sales Order.
 *
 * A stranger writing "I'd like to order 10 of the small black t-shirt" is
 * placing an order in the only way most customers ever will. Foundry used to
 * fetch that mail from Gmail and drop it on the floor, because the sender was
 * not an approved supplier, so the owner saw nothing at all.
 *
 * What is built here is a DRAFT, and the word is load-bearing. Foundry reads
 * the message, matches the products against the catalogue, and stops. Nothing
 * is confirmed, no stock is committed, no reply is sent. The owner opens a
 * draft order that says where it came from and approves it, edits it, or
 * throws it away.
 *
 * Two rules hold this honest:
 *
 *   1. The model may only report what the email says. Quantities and product
 *      wording are extracted, never supplied. Prices come from the catalogue,
 *      because a customer does not get to state our prices by writing them.
 *   2. Nothing is silently dropped. A line whose product cannot be identified
 *      is written onto the order in the customer's own words, so the owner
 *      sees the whole request and not just the convenient half of it.
 */

const { createProviderForTier } = require('../ai/provider');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');
const resolver = require('../actions/resolver');
const sales = require('./sales-order-service');
const orderReply = require('./order-reply');

const SCHEMA = {
  type: 'object', additionalProperties: false,
  /*
   * shippingAddress is deliberately not required.
   *
   * The other fields are required-and-empty-when-absent, which is the
   * convention here for strict structured output. This one is not, because the
   * cost of the two mistakes is not the same: a reader that omits an address
   * would fail validation and Foundry would lose the entire order over a line
   * that is optional information. Missing is read as "no address given", which
   * is exactly what it means.
   */
  required: ['isAnOrder', 'contactName', 'phone', 'lines'],
  properties: {
    isAnOrder: { type: 'boolean' },
    contactName: { type: 'string' },
    phone: { type: 'string' },
    /*
     * The address as the customer wrote it, copied and not tidied.
     *
     * Most people put where they live at the bottom of the email and expect
     * that to be enough — as the one that started this did. Foundry used to
     * read past it, so a parcel could not be quoted or labelled until
     * somebody typed it in again from the message sitting next to the order.
     *
     * Copied verbatim so the grounding check can be applied to it like
     * anything else: a street nobody wrote is a parcel nobody receives.
     */
    shippingAddress: { type: 'string' },
    deliveryMethod: { type: 'string', enum: ['SHIP', 'PICKUP', 'UNKNOWN'] },
    lines: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['itemText', 'variantText', 'quantity'],
        properties: {
          itemText: { type: 'string' },
          variantText: { type: 'string' },
          quantity: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
};

const SYSTEM = `You read one email from a customer and report what they asked to buy.
Report only what the email states. Copy product wording exactly as written, including any code or SKU.
quantity must be the number written in the email. If a quantity is not written, omit that line entirely
rather than choosing a number. contactName and phone are only the ones the email gives; otherwise empty.
shippingAddress is the postal address written in the email, copied exactly as it appears, including the
line breaks. Leave it empty when the email gives no address. Never complete or correct an address.
Set deliveryMethod to PICKUP only when the customer explicitly says they will collect or pick up the order,
SHIP only when they explicitly ask for delivery/shipping, and UNKNOWN when they do not say.
Set isAnOrder to false when the message is not asking to buy anything. Never add a product that is not
named in the email. Return only the schema.`;

/*
 * Everything the customer has written in this conversation, oldest first.
 *
 * An order is rarely one email. Foundry asked "which of these four did you
 * mean?", the customer answered "the moc toe slip in 36", and that answer read
 * on its own says nothing about how many — while the first message says two
 * and nothing about which. Neither is an order; together they are one.
 *
 * Only the customer's own words, and only the part they typed. Our question is
 * excluded on purpose, and so is the quotation of it underneath their reply.
 * Our question listed all four products by name; letting that text count as
 * something the customer wrote would let the reader pick any of the four and
 * have the grounding check wave it through, which is the exact failure the
 * grounding exists to prevent.
 */
function conversationWith(db, workspaceId, message) {
  const triage = require('../connections/reply-triage');
  const thread = message.external_thread_id;
  const rows = thread
    ? db.prepare(`SELECT id, subject, body_text, received_at FROM connection_email_messages
        WHERE workspace_id = ? AND external_thread_id = ? AND LOWER(sender) = LOWER(?)
        ORDER BY received_at, rowid`).all(workspaceId, thread, message.sender)
    : [message];
  const said = rows
    .map((row) => triage.prose(row.body_text).trim())
    .filter(Boolean);
  return said.length ? said : [String(message.body_text || '')];
}

/** What the customer asked for, or null when nothing could be read from it. */
async function read(message, options = {}) {
  try {
    const provider = options.provider || createProviderForTier('fast');
    const said = options.conversation && options.conversation.length
      ? options.conversation : [String(message.body_text || '')];
    const body = said.length === 1 ? said[0]
      : [
        'The customer wrote these, oldest first. A later message answers or corrects an earlier',
        'one, so report the order as it stands after all of them.',
        '',
        ...said.map((text, index) => `[${index + 1}] ${text}`),
      ].join('\n');
    const response = await provider.complete({
      system: SYSTEM,
      prompt: `From: ${message.sender}\nSubject: ${message.subject || ''}\n\n${body}`,
      schema: SCHEMA, schemaName: 'customer_order_email',
    });
    const result = validate(toWireSchema(SCHEMA), response.data, { key: 'customer-order-email-wire' });
    if (!result.ok) return null;
    return result.data;
  } catch {
    /*
     * A model that is slow, absent, or wrong must not invent an order. The
     * message stays captured and unanswered, which is a state the owner can
     * see and act on, unlike a guess.
     */
    return null;
  }
}

/*
 * Every word of a product name has to be a word the customer wrote.
 *
 * A reader given a catalogue will happily answer "Classic Cotton T-Shirt" to
 * an email about wool, and that name resolves to a real SKU, so the invention
 * arrives looking like a fact. This is the check that stops it: the wording
 * must be traceable to the message it claims to come from.
 *
 * The resolver has a grounding option of its own, but it wants the original
 * sentence and narrows the catalogue by every word in it. Handed a whole
 * email — "pieces", "Name", "phone number", a signature — it narrows to
 * nothing and a perfectly clear order fails to match. So the grounding
 * happens here, against the text, and the resolver is asked only to match.
 */
function tokens(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/i).filter((word) => word.length >= 3);
}

function saidInTheEmail(message, itemText, variantText) {
  const wrote = new Set(tokens(`${message.subject || ''} ${message.body_text || ''}`));
  const claimed = tokens(`${itemText || ''} ${variantText || ''}`);
  if (!claimed.length) return false;
  return claimed.every((word) => wrote.has(word));
}

/** The customer this message is from, identified by the address it came from. */
function customerFor(db, ctx, message, told) {
  const sender = String(message.sender || '').toLowerCase();
  const known = db.prepare(`SELECT * FROM customers
    WHERE workspace_id = ? AND LOWER(email) = ?`).get(ctx.workspaceId, sender);
  if (known) return known;
  /*
   * The address is the identity, not the name in the signature. Anyone can
   * sign an email "Chavy"; matching on that would attach a stranger's order
   * to an existing customer's account. A new address is a new customer, and
   * the owner can merge them if they are in fact the same person.
   */
  let name = String(told?.contactName || '').trim() || sender;
  const sameName = db.prepare(`SELECT id FROM customers
    WHERE workspace_id = ? AND name = ? COLLATE NOCASE`).get(ctx.workspaceId, name);
  if (sameName) name = `${name} (${sender})`;
  return sales.createCustomer(db, ctx, { name, email: sender, recordState: 'PROVISIONAL' });
}

/*
 * The address the customer wrote, attached to their order.
 *
 * Two checks before it is used, and both matter more here than anywhere else
 * in this file. A wrong product on a draft order is caught by the person
 * approving it; a wrong address is caught by a parcel arriving at a stranger's
 * house a week later.
 *
 *   1. Every word of it has to be a word the customer actually wrote. The same
 *      grounding as the product lines, for the same reason.
 *   2. It has to be a complete address. An address missing its postcode is not
 *      most of an address — a carrier will refuse it, and Foundry filling in
 *      the gap would be inventing where somebody lives.
 *
 * Anything else is left alone, and the parcel screen asks once. Never
 * overwrites an address a person has already put on the order.
 */
function addressFromEmail(db, ctx, message, told, customerId) {
  const written = String(told?.shippingAddress || '').trim();
  if (!written) return { attached: false, because: 'The email gave no address.' };

  const wrote = new Set(tokens(`${message.subject || ''} ${message.body_text || ''}`));
  const claimed = tokens(written);
  if (!claimed.length || !claimed.every((word) => wrote.has(word))) {
    return { attached: false, because: 'Foundry did not attach an address it could not find in their own words.' };
  }

  const parsed = require('../shipping/address').parse(written);
  if (!parsed.complete) {
    return { attached: true, parsed, address: written, incomplete: true,
      because: `The address in the email is missing the ${parsed.missing.join(', ')}. Foundry copied exactly what the customer wrote, but a carrier cannot use it yet.` };
  }

  const existing = db.prepare('SELECT shipping_address FROM customers WHERE id = ? AND workspace_id = ?')
    .get(customerId, ctx.workspaceId);
  if (existing && String(existing.shipping_address || '').trim()) {
    return { attached: true, parsed, address: written,
      because: String(existing.shipping_address).trim() === written
        ? 'The email confirms the customer address already on file.'
        : 'This order uses the address written in the email. The customer default was not silently changed.' };
  }

  db.prepare('UPDATE customers SET shipping_address = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(written, new Date().toISOString(), customerId, ctx.workspaceId);
  return { attached: true, parsed, address: written };
}

/** Why an email produced no order, written where the owner can see it. */
function noteReason(db, ctx, messageId, reason) {
  db.prepare(`UPDATE connection_email_messages SET order_draft_reason = ?
    WHERE workspace_id = ? AND id = ?`).run(reason, ctx.workspaceId, messageId);
}

/*
 * The same request, sent twice.
 *
 * A customer who hears nothing sends the email again — the two that started
 * this arrived a minute apart. Two draft orders for one request is a mess the
 * owner has to untangle, and confirming both is a double shipment. So the
 * earlier draft, from the same address with exactly the same lines, is the
 * order, and the second email is noted against it rather than duplicated.
 */
function sameRequestAlreadyDrafted(db, ctx, sender, lines) {
  const wanted = lines.map((line) => `${line.skuId}:${line.quantity}`).sort().join('|');
  const drafts = db.prepare(`SELECT so.* FROM sales_orders so
    JOIN customers c ON c.id = so.customer_id
    WHERE so.workspace_id = ? AND so.status = 'DRAFT' AND so.source_email_message_id IS NOT NULL
      AND LOWER(c.email) = ?
    ORDER BY so.created_at`).all(ctx.workspaceId, String(sender || '').toLowerCase());
  for (const order of drafts) {
    const have = db.prepare('SELECT sku_id, quantity_ordered FROM sales_order_lines WHERE sales_order_id = ?')
      .all(order.id).map((line) => `${line.sku_id}:${line.quantity_ordered}`).sort().join('|');
    if (have === wanted) return order;
  }
  return null;
}

/**
 * Draft a Sales Order from a captured email. Returns the order, or null with a
 * reason when there was nothing to draft — and the reason is written on the
 * message either way, because a customer's order that quietly produced
 * nothing is the one failure the owner most needs to hear about.
 */
async function draft(db, ctx, messageId, options = {}) {
  const message = db.prepare(`SELECT * FROM connection_email_messages
    WHERE workspace_id = ? AND id = ?`).get(ctx.workspaceId, messageId);
  if (!message) return { order: null, because: 'That message is not in this workspace.' };
  if (message.classification !== 'customer_order_request') {
    return { order: null, because: 'That message was not read as a customer order.' };
  }

  const already = db.prepare(`SELECT * FROM sales_orders
    WHERE workspace_id = ? AND source_email_message_id = ?`).get(ctx.workspaceId, messageId);
  if (already) return { order: already, because: null, replayed: true };

  /*
   * The conversation, not the message. Both the reader and the grounding
   * check work from it, so a product named in the customer's second email
   * counts as words the customer wrote — and our own question never does.
   */
  const conversation = conversationWith(db, ctx.workspaceId, message);
  const asWritten = { subject: message.subject, body_text: conversation.join('\n') };

  const told = await read(message, { ...options, conversation });
  if (!told || !told.isAnOrder || !Array.isArray(told.lines) || !told.lines.length) {
    const because = 'Foundry could not read a specific order out of that email.';
    noteReason(db, ctx, messageId, because);
    return { order: null, because };
  }

  const lines = [];
  const unmatched = [];
  /*
   * Lines the catalogue answered with a choice rather than a product.
   *
   * "Size 36" is four different shoes here. Foundry must not pick one, and it
   * must not throw the question away either — which is what happened: the
   * customer's request became "nothing matched the catalogue: 2 × size 36",
   * as though their words meant nothing, when in fact Foundry knew exactly
   * which four things they could have meant.
   */
  const questions = [];
  for (const line of told.lines) {
    const asked = `${line.quantity} × ${[line.itemText, line.variantText].filter(Boolean).join(' ')}`.trim();
    const found = saidInTheEmail(asWritten, line.itemText, line.variantText)
      ? resolver.resolveSku(db, ctx.workspaceId, line.itemText, line.variantText)
      : { ok: false };
    if (found.ok && found.value?.id) { lines.push({ skuId: found.value.id, quantity: line.quantity }); continue; }
    if (found.reason === 'ambiguous' && (found.candidates || []).length) {
      questions.push({ asked, candidates: found.candidates });
    }
    unmatched.push(asked);
  }
  if (!lines.length) {
    const because = questions.length
      ? questions.map((question) => {
        const choices = question.candidates.map(orderReply.nameOf).filter(Boolean);
        return `They asked for ${question.asked}, which is ${choices.length} different products here — `
          + `${orderReply.series(choices)}. Foundry will not choose between them.`;
      }).join(' ')
      : `Nothing in that email matched the catalogue: ${unmatched.join('; ') || 'no products named'}.`;
    noteReason(db, ctx, messageId, because);
    // The customer is owed the question, not silence.
    orderReply.askWhichProduct(db, ctx.workspaceId, messageId, message, questions);
    return { order: null, because, questions };
  }

  const twin = sameRequestAlreadyDrafted(db, ctx, message.sender, lines);
  if (twin) {
    noteReason(db, ctx, messageId,
      `Same request as ${twin.order_number}, which is already drafted from an earlier email. No second order was made.`);
    return { order: twin, because: null, duplicateOf: twin.order_number, unmatched };
  }

  /*
   * Everything the email asked for that Foundry could not identify, in the
   * customer's own words. An order that quietly contained half a request
   * would be worse than no order at all, because it would look complete.
   */
  const notes = [
    `Read from an email from ${message.sender}${message.subject ? ` — "${message.subject}"` : ''}.`,
    unmatched.length ? `Not matched to a product, still asked for: ${unmatched.join('; ')}` : null,
    told.phone ? `Phone given: ${told.phone}` : null,
  ].filter(Boolean).join('\n');

  const knownCustomer = db.prepare(`SELECT id FROM customers
    WHERE workspace_id = ? AND LOWER(email) = LOWER(?) AND record_state = 'ACTIVE'`)
    .get(ctx.workspaceId, message.sender);
  const customer = customerFor(db, ctx, message, told);
  // Before the order, so the order is created with somewhere to send it.
  const shipTo = addressFromEmail(db, ctx, message, told, customer.id);
  const order = sales.createOrder(db, ctx, {
    customerId: customer.id,
    lines,
    deliveryMethod: told.deliveryMethod === 'PICKUP' ? 'PICKUP' : 'SHIP',
    customerDecisionRequired: !knownCustomer,
    deliveryDecisionRequired: told.deliveryMethod !== 'PICKUP' && (!shipTo.address || shipTo.incomplete),
    // A grounded address is preserved even when incomplete, so the order asks
    // for the missing part instead of silently inheriting an older address.
    // An ungrounded model claim is an explicit null for the same reason.
    ...(String(told.shippingAddress || '').trim()
      ? { shipToAddress: shipTo.attached ? shipTo.address : null, shipToSource: 'EMAIL' }
      : {}),
    notes: shipTo.attached ? `${notes}
Delivery address copied from their email.${shipTo.incomplete ? ` ${shipTo.because}` : ''}`
      : `${notes}${shipTo.because && String(told.shippingAddress || '').trim() ? `\n${shipTo.because}` : ''}`,
  });
  db.prepare(`UPDATE sales_orders SET source_email_message_id = ? WHERE workspace_id = ? AND id = ?`)
    .run(messageId, ctx.workspaceId, order.id);
  let deliveryQuestion = null;
  let deliveryQuestionSent = false;
  if (told.deliveryMethod !== 'PICKUP' && (!shipTo.address || shipTo.incomplete)) {
    deliveryQuestion = orderReply.askDeliveryDetails(db, ctx.workspaceId, messageId, message, order.orderNumber, lines);
    if (deliveryQuestion) {
      try {
        await require('../connections/reply-drafting').send(db, ctx, messageId);
        deliveryQuestionSent = true;
      } catch {
        // The deterministic reply stays prepared on the source email. A mail
        // outage must not lose the order or pretend the question was sent.
      }
    }
  }
  noteReason(db, ctx, messageId, null);
  /*
   * An order Foundry cannot fill is still an order, and the customer should
   * hear it from us rather than from the delivery that never comes. Drafted,
   * never sent — what to promise a customer who is short is the owner's call.
   */
  const shortfall = deliveryQuestion
    ? deliveryQuestion.shortfall
    : orderReply.tellThemAboutStock(db, ctx.workspaceId, messageId, message, lines, order.orderNumber);
  return { order: sales.getOrder(db, ctx.workspaceId, order.id), because: null, unmatched,
    shortfall: Boolean(shortfall), shipTo, newCustomer: !knownCustomer,
    deliveryQuestion: Boolean(deliveryQuestion), deliveryQuestionSent };
}

/**
 * Two drafts for one request, made before the rule above existed.
 *
 * An earlier build drafted an order every time it read an order email, so
 * the same request sent twice became SO-1001 and SO-1002, both waiting for
 * approval, both for the same two pairs of shoes. Approving both ships them
 * twice. The later draft — same address, exactly the same lines, nothing
 * committed — is cancelled with the reason written on it and on its email,
 * which is what the rule would have done had it been there.
 *
 * Only drafts. An order somebody has confirmed is a decision they made.
 */
function collapseTwins(db, ctx) {
  const drafts = db.prepare(`SELECT so.id, so.order_number, so.source_email_message_id, LOWER(c.email) AS email
    FROM sales_orders so JOIN customers c ON c.id = so.customer_id
    WHERE so.workspace_id = ? AND so.status = 'DRAFT' AND so.source_email_message_id IS NOT NULL
    ORDER BY so.created_at, so.rowid`).all(ctx.workspaceId);
  const signature = db.prepare('SELECT sku_id, quantity_ordered FROM sales_order_lines WHERE sales_order_id = ?');
  const first = new Map();
  const cancelled = [];
  for (const order of drafts) {
    const key = `${order.email}|${signature.all(order.id)
      .map((line) => `${line.sku_id}:${line.quantity_ordered}`).sort().join('|')}`;
    const kept = first.get(key);
    if (!kept) { first.set(key, order); continue; }
    const reason = `Same request as ${kept.order_number}, which is already drafted from an earlier email. No second order was made.`;
    sales.cancel(db, ctx, order.id, `Same request as ${kept.order_number}, drafted from an earlier email.`);
    noteReason(db, ctx, order.source_email_message_id, reason);
    cancelled.push({ cancelled: order.order_number, keptOrder: kept.order_number });
  }
  return cancelled;
}

/**
 * Order emails that have neither an order nor a reason yet.
 *
 * The poller drafts a message once, when it arrives. A read that failed
 * because the model was slow, or ran under a build that dropped the error,
 * stayed silent forever. So every check of the mailbox also picks up
 * anything still unexplained from the last week and tries again. Idempotent:
 * a message with an order, or with a recorded reason, is left alone.
 */
/*
 * Replies that answer an order, filed as something else.
 *
 * A reply carries no buying language — "the moc toe slip in 36 please" is not
 * a phrase anybody would risk drafting an order from on its own — so it was
 * classified as ordinary post and the conversation it completed went nowhere.
 * New mail is now read in the context of its thread as it arrives; this is the
 * same correction applied to mail that came in before, and to anything a
 * missed classification stranded.
 *
 * The same three conditions as the live path: same thread, same sender, and
 * only while the order it belongs to is still unmade.
 */
function adoptThreadReplies(db, ctx) {
  const stranded = db.prepare(`SELECT reply.id FROM connection_email_messages reply
    JOIN connection_email_messages asked
      ON asked.workspace_id = reply.workspace_id
     AND asked.external_thread_id = reply.external_thread_id
     AND LOWER(asked.sender) = LOWER(reply.sender)
     AND asked.classification = 'customer_order_request'
     -- Not strictly earlier: two messages can share a timestamp to the second,
     -- and the test for "is this the same message" is its id.
     AND asked.id <> reply.id
     AND asked.received_at <= reply.received_at
    WHERE reply.workspace_id = ?
      AND reply.external_thread_id IS NOT NULL
      AND reply.classification <> 'customer_order_request'
      AND reply.trust_status = 'UNTRUSTED'
      -- No order out of this conversation, rather than out of that one
      -- message. The order hangs off whichever email finally completed it, so
      -- asking only about the first leaves the thread open forever and a later
      -- "thanks, got them" gets read as somebody ordering again.
      AND NOT EXISTS (SELECT 1 FROM sales_orders so
        JOIN connection_email_messages src ON src.id = so.source_email_message_id
        WHERE so.workspace_id = reply.workspace_id
          AND src.external_thread_id = reply.external_thread_id)`)
    .all(ctx.workspaceId);
  for (const row of stranded) {
    db.prepare(`UPDATE connection_email_messages SET classification = 'customer_order_request'
      WHERE workspace_id = ? AND id = ?`).run(ctx.workspaceId, row.id);
  }
  return stranded.length;
}

/**
 * Apply a customer's answer to the delivery question to the order that asked
 * it. The thread id and sender must both match: an address in an unrelated
 * message is never permission to change an order.
 */
async function applyPendingDeliveryReply(db, ctx, messageId, options = {}) {
  const message = db.prepare(`SELECT * FROM connection_email_messages
    WHERE workspace_id = ? AND id = ?`).get(ctx.workspaceId, messageId);
  if (!message?.external_thread_id) return null;

  const pending = db.prepare(`SELECT so.id, so.order_number, so.customer_id
    FROM sales_orders so
    JOIN connection_email_messages source ON source.id = so.source_email_message_id
      AND source.workspace_id = so.workspace_id
    WHERE so.workspace_id = ? AND so.delivery_decision_required = 1
      AND source.external_thread_id = ? AND LOWER(source.sender) = LOWER(?)
      AND source.id <> ?
    ORDER BY so.created_at DESC LIMIT 1`)
    .get(ctx.workspaceId, message.external_thread_id, message.sender, message.id);
  if (!pending) return null;

  const conversation = conversationWith(db, ctx.workspaceId, message);
  const told = await read(message, { ...options, conversation });
  if (!told) return null;

  let order = null;
  if (told.deliveryMethod === 'PICKUP') {
    order = sales.resolveDelivery(db, ctx, pending.id, { deliveryMethod: 'PICKUP' });
  } else if (String(told.shippingAddress || '').trim()) {
    const asWritten = { subject: message.subject, body_text: conversation.join('\n') };
    const address = addressFromEmail(db, ctx, asWritten, told, pending.customer_id);
    if (!address.attached || address.incomplete || !address.address) return null;
    order = sales.resolveDelivery(db, ctx, pending.id, {
      deliveryMethod: 'SHIP', shippingAddress: address.address, saveCustomerAddress: true,
    });
  }
  if (!order) return null;

  noteReason(db, ctx, message.id,
    `Used this answer to set ${pending.order_number} to ${order.delivery_method === 'PICKUP' ? 'customer pickup' : 'shipping to the address the customer supplied'}.`);
  return { handled: true, order };
}

async function draftPending(db, ctx, options = {}) {
  collapseTwins(db, ctx);
  adoptThreadReplies(db, ctx);
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`SELECT m.id FROM connection_email_messages m
    WHERE m.workspace_id = ? AND m.classification = 'customer_order_request'
      AND m.order_draft_reason IS NULL AND m.received_at >= ?
      AND NOT EXISTS (SELECT 1 FROM sales_orders so
        WHERE so.workspace_id = m.workspace_id AND so.source_email_message_id = m.id)
    ORDER BY m.received_at`).all(ctx.workspaceId, since);
  const results = [];
  for (const row of rows) {
    try {
      results.push({ id: row.id, ...(await draft(db, ctx, row.id, options)) });
    } catch (error) {
      const because = `Foundry could not draft an order from this: ${error.message}`;
      noteReason(db, ctx, row.id, because);
      results.push({ id: row.id, order: null, because });
    }
  }
  return results;
}

/** Draft orders read from email, with their lines, for the owner to approve. */
function waitingForApproval(db, workspaceId) {
  const orders = db.prepare(`SELECT so.id, so.order_number, so.created_at,
      so.status, so.customer_decision_required, so.delivery_decision_required,
      c.name AS customer_name, c.email AS customer_email, c.record_state,
      m.subject, m.received_at, m.draft_at, m.reply_sent_at
    FROM sales_orders so
    JOIN customers c ON c.id = so.customer_id
    LEFT JOIN connection_email_messages m ON m.id = so.source_email_message_id
    WHERE so.workspace_id = ? AND so.source_email_message_id IS NOT NULL
      AND (so.status = 'DRAFT' OR so.customer_decision_required = 1 OR so.delivery_decision_required = 1)
    ORDER BY so.created_at`).all(workspaceId);
  const lines = db.prepare(`SELECT sol.quantity_ordered AS quantity, sol.unit_price_minor, i.name AS item_name,
      s.variant_label, i.unit_label
    FROM sales_order_lines sol
    JOIN skus s ON s.id = sol.sku_id JOIN items i ON i.id = s.item_id
    WHERE sol.sales_order_id = ? ORDER BY i.name, s.variant_label`);
  return orders.map((order) => ({ ...order, lines: lines.all(order.id) }));
}

/**
 * Order emails Foundry could not turn into a draft, with the reason.
 *
 * A second copy of a request already drafted is not in this list: the
 * decision it needs is the order that exists, and that is listed already.
 *
 * Nor is one the owner has already answered. Foundry asked the customer which
 * of four shoes they meant, the owner read the question and sent it — and the
 * card went on saying "read the order yourself", as though nothing had
 * happened. Once we have written back, the next move is theirs, and a queue
 * that says otherwise is asking somebody to do a thing they have just done.
 * It comes back the moment they reply, because their reply lands on the same
 * thread and is read as part of the same order.
 *
 * And the whole conversation counts, not the single message: when the answer
 * finally makes the order, the order hangs off the reply, so the message that
 * started it must look at its own thread before claiming nothing came of it.
 */
function unreadable(db, workspaceId) {
  return db.prepare(`SELECT m.id, m.sender, m.subject, m.received_at, m.order_draft_reason,
      m.draft_at, m.draft_source
    FROM connection_email_messages m
    WHERE m.workspace_id = ? AND m.classification = 'customer_order_request'
      AND m.order_draft_reason IS NOT NULL
      AND m.order_draft_reason NOT LIKE 'Same request as %'
      AND m.reply_sent_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM sales_orders so
        JOIN connection_email_messages src ON src.id = so.source_email_message_id
        WHERE so.workspace_id = m.workspace_id
          AND (src.id = m.id
            OR (m.external_thread_id IS NOT NULL AND src.external_thread_id = m.external_thread_id)))
    ORDER BY m.received_at DESC`).all(workspaceId);
}

module.exports = { SCHEMA, SYSTEM, read, draft, draftPending, collapseTwins, noteReason,
  waitingForApproval, unreadable, customerFor, saidInTheEmail, conversationWith, adoptThreadReplies,
  applyPendingDeliveryReply, addressFromEmail };

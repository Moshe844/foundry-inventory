'use strict';

/*
 * Which mail is Foundry's business, and which is simply the owner's mail.
 *
 * Connecting the shop's mailbox used to mean handing Foundry the whole inbox.
 * Every newsletter, every bank alert, every delivery-robot notice and every
 * message from the owner's accountant became a row in Foundry's records, was
 * read by triage, and turned up on a screen the owner is supposed to trust.
 * The reasoning at the time was that a stranger might be a customer, and that
 * refusing unknown senders had already lost somebody's first order.
 *
 * Both things are true, and they are not in conflict. The question was simply
 * the wrong one. It is not "do we know this sender" — it is "is this about
 * the business Foundry runs". A stranger asking to buy fifty pairs is about
 * the business. A supplier's marketing blast is not, and the fact that we buy
 * from them does not make it so.
 *
 * So this is the gate, and it is deliberately evidence-ordered: the strongest
 * fact wins, and every decision says what that fact was.
 *
 *   1. It names something of ours   — an order, a PO, an invoice, a product
 *                                     code that exists in this workspace.
 *   2. It continues a conversation  — a reply on a thread Foundry already
 *                                     accepted.
 *   3. It is bulk or automated      — an unsubscribe link, a no-reply
 *                                     address, an out-of-office.
 *   4. It is from someone we trade  — a customer or supplier on record.
 *      with
 *   5. It is trying to trade        — buying, quoting, invoicing, delivery
 *                                     or stock language from anyone at all.
 *   6. Otherwise                    — not Foundry's.
 *
 * Rules 1 and 2 sit above rule 3 on purpose. A shipping notice legitimately
 * arrives from noreply@carrier, and a supplier's own system legitimately sends
 * an invoice from an address nobody reads. If it quotes our PO number, it is
 * ours whatever address it came from. And rule 3 sits above rule 4 for the
 * mirror reason: a newsletter from a company we buy from is still a
 * newsletter.
 *
 * Nothing here is a guess about content. Every branch is a fact that can be
 * pointed at, because a message that was set aside has to be explainable to
 * the person who went looking for it.
 */

const triage = require('./reply-triage');

/* ------------------------------------------------------------------ ours */

/*
 * Things in the text that could be a reference number.
 *
 * "SO-1043", "PO 4471", "INV/2291", "2026042902PI" — a few letters, a run of
 * digits, and any separator a person or a printer felt like using. Compared
 * after every separator is stripped, so the supplier who writes our own
 * number back with a different dash still matches it.
 */
const REFERENCE = /\b[a-z]{0,6}[-_/ ]?\d{3,}[a-z0-9-]*\b/gi;
const MAX_CANDIDATES = 20;

const flatten = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function referenceCandidates(text) {
  const found = new Set();
  for (const match of String(text || '').match(REFERENCE) || []) {
    const flat = flatten(match);
    if (flat.length < 3) continue;
    found.add(flat);
    // "PO 4471" quoted against a purchase order simply numbered 4471.
    const bare = flat.replace(/^[A-Z]+/, '');
    if (bare.length >= 3) found.add(bare);
    if (found.size >= MAX_CANDIDATES) break;
  }
  return [...found];
}

const FLAT_SQL = (column) =>
  `REPLACE(REPLACE(REPLACE(REPLACE(UPPER(${column}),'-',''),' ',''),'_',''),'/','')`;

/*
 * Reference numbers Foundry issued or recorded, and the words for them.
 *
 * The kind is carried through to the reason the owner reads, because "it
 * quotes purchase order PO-4471" is a fact they can check and "it matched a
 * record" is not.
 */
const REFERENCE_SOURCES = [
  { table: 'sales_orders', column: 'order_number', kind: 'your order' },
  { table: 'purchase_orders', column: 'po_number', kind: 'your purchase order' },
  { table: 'accounting_customer_invoices', column: 'invoice_number', kind: 'your invoice' },
  { table: 'accounting_supplier_bills', column: 'supplier_invoice_number', kind: 'a supplier bill' },
];

function namesOurRecords(db, workspaceId, text) {
  const candidates = referenceCandidates(text);
  if (!candidates.length) return null;
  const holes = candidates.map(() => '?').join(',');
  for (const source of REFERENCE_SOURCES) {
    let row = null;
    try {
      row = db.prepare(`SELECT ${source.column} AS ref FROM ${source.table}
        WHERE workspace_id = ? AND ${source.column} IS NOT NULL
          AND ${FLAT_SQL(source.column)} IN (${holes}) LIMIT 1`)
        .get(workspaceId, ...candidates);
    } catch {
      // A table this build does not have is not evidence either way.
      continue;
    }
    if (row) return { kind: source.kind, ref: row.ref };
  }
  return null;
}

/**
 * A product code of ours, written out in full.
 *
 * Only whole words of four characters or more, and only against the codes —
 * matching on product *names* would let "black" or "cotton" in an unrelated
 * newsletter speak for the business.
 */
function namesOurProducts(db, workspaceId, text) {
  const words = [...new Set(String(text || '').toUpperCase().match(/[A-Z0-9][A-Z0-9-]{3,}/g) || [])].slice(0, 300);
  if (!words.length) return null;
  const row = db.prepare(`SELECT code FROM skus
    WHERE workspace_id = ? AND code IS NOT NULL AND UPPER(code) IN (${words.map(() => '?').join(',')})
    LIMIT 1`).get(workspaceId, ...words);
  return row ? { kind: 'one of your product codes', ref: row.code } : null;
}

/* --------------------------------------------------------- who is writing */

/** The customer or supplier this address belongs to, if it belongs to one. */
function counterpartyFor(db, workspaceId, connectorId, sender) {
  const address = String(sender || '').toLowerCase();
  if (!address) return null;

  const customer = db.prepare(`SELECT id, name FROM customers
    WHERE workspace_id = ? AND LOWER(email) = ?`).get(workspaceId, address);
  if (customer) return { relationship: 'customer', kind: 'customer', id: customer.id, name: customer.name };

  const supplier = db.prepare(`SELECT id, name FROM suppliers
    WHERE workspace_id = ? AND LOWER(email) = ?`).get(workspaceId, address);
  if (supplier) return { relationship: 'supplier', kind: 'supplier', id: supplier.id, name: supplier.name };

  // An approved-sender rule is the owner saying this address is ours, which
  // outranks anything guessed from the words.
  const rule = require('./email-ingestion').matchingRule(db, { workspaceId, connectorId }, address);
  if (rule) {
    const named = rule.supplier_id
      ? db.prepare('SELECT name FROM suppliers WHERE id = ?').get(rule.supplier_id) : null;
    return { relationship: 'supplier', kind: 'approved sender', id: rule.supplier_id || null,
      name: named ? named.name : address, rule };
  }
  return null;
}

/* ------------------------------------------------------------ conversation */

/*
 * Is this a reply on a conversation that is genuinely ours?
 *
 * Two traps, and both were live.
 *
 * The message itself has to be excluded. Gmail gives a new message a thread id
 * of its own and the poll window overlaps on purpose, so a message that had
 * already been captured found itself, declared itself a continuation of
 * itself, and every message passed.
 *
 * And existing on the thread is not enough. Two of the same bank's security
 * alerts share a thread, so each vouched for the other and a conversation
 * nobody was having counted as one of ours. A thread is ours when some message
 * on it is ours on its own merits — it named one of our records, or somebody
 * we trade with wrote it, or it was somebody trading with us. A reply carries
 * that forward; it cannot create it.
 */
const THREAD_LOOKBACK = 20;

function continuesOurThread(db, workspaceId, connectorId, message) {
  const threadId = message.threadId || message.externalThreadId;
  if (!threadId) return false;
  const own = String(message.messageId || message.externalMessageId || '');
  const others = db.prepare(`SELECT sender, subject, body_text FROM connection_email_messages
    WHERE workspace_id = ? AND external_thread_id = ? AND external_message_id <> ?
    ORDER BY received_at LIMIT ?`).all(workspaceId, threadId, own, THREAD_LOOKBACK);
  return others.some((row) => {
    const text = `${row.subject || ''}\n${row.body_text || ''}`;
    if (namesOurRecords(db, workspaceId, text) || namesOurProducts(db, workspaceId, text)) return true;
    if (counterpartyFor(db, workspaceId, connectorId, row.sender)) return true;
    return Boolean(tradingLanguage(text.toLowerCase(), { subject: row.subject || '' }));
  });
}

/* ---------------------------------------------------------------- trading */

/*
 * Somebody trying to do business with us, in the words people actually use.
 *
 * The first version of this list was single commercial words — order, invoice,
 * delivery, stock — and it let a newsletter through on the sentence "Nothing
 * about purchasing." Which is the joke the triage comments already tell: every
 * marketing email in the world says "order now", and matching the vocabulary
 * of commerce matches all of it.
 *
 * So the test is not whether the message is about trade, but whether it is
 * trading with us. Every pattern here needs somebody addressing somebody:
 * a pronoun, a possessive, or a direct request. "Order now and save 20%" is
 * not one; "where is my order" is.
 */
const DIRECTED = [
  // Asking to buy.
  /\b(?:i|we)(?:'d| would)? (?:like|want|wish|need) to (?:order|buy|purchase|place)\b/,
  /\bcan (?:i|we) (?:order|buy|purchase|get|have|collect)\b/,
  /\b(?:place|placing|submit|submitting|put in) (?:an|a|another|the following) order\b/,
  /\b(?:order|send|ship) (?:me|us) (?:the following|these|a|an|\d)/,
  // Asking about what we sell.
  /\b(?:do|does|did) you (?:have|stock|sell|ship|carry|deliver|supply|offer)\b/,
  /\b(?:can|could|would) you (?:quote|send|ship|deliver|invoice|confirm|supply|check|advise)\b/,
  /\b(?:is|are) (?:it|they|these|this|that) (?:still )?(?:in stock|available)\b/,
  // A transaction that already exists, spoken about as somebody's.
  /*
   * "account" was in this list and every bank alert in the world says "your
   * Chase account". A possessive only means trade when the noun is a trade:
   * an order, an invoice, a shipment. An account is anything.
   */
  /\b(?:my|our|your|their) (?:order|invoice|shipment|delivery|consignment|parcel|quote|quotation|purchase order|refund)\b/,
  /\b(?:i|we) (?:ordered|bought|purchased|paid|placed|received|returned|sent you|attached)\b/,
  /\b(?:attached|enclosed|please find)\b.{0,40}\b(?:invoice|order|quote|quotation|statement|packing|delivery|proforma|pro forma)\b/,
  // Asking for a document by name.
  /\b(?:send|give|provide|need|want|require|requesting|request(?:ing)?)\b.{0,30}\b(?:quote|quotation|price list|pricing|proforma|pro forma|invoice|catalogue|catalog|sample)\b/,
  /\b(?:lead time|minimum order|\bmoq\b|wholesale|trade price|bulk (?:order|pricing|discount))\b/,
];

/*
 * A document dropped in without a covering note.
 *
 * Half the mail a supplier sends is an attachment and the word "invoice", and
 * nothing in it addresses anybody. That is still unmistakably ours, so a
 * document name in the subject or on the file counts on its own.
 */
const DOCUMENT_NAME = /\b(?:invoice|packing\s*(?:slip|list)|purchase\s*order|delivery\s*(?:note|confirmation)|proforma|pro\s*forma|bill\s*of\s*lading|remittance|statement\s*of\s*account|credit\s*note)\b/i;

function tradingLanguage(text, options = {}) {
  const found = DIRECTED.find((pattern) => pattern.test(text));
  if (found) {
    const match = text.match(found);
    if (match) return match[0].trim();
  }
  const named = `${options.subject || ''} ${options.filenames || ''}`.match(DOCUMENT_NAME);
  if (named && (options.hasAttachment || options.filenames)) return named[0].trim();
  return null;
}

/* ------------------------------------------------------------------ bulk */

const BULK_BODY = /\bunsubscribe\b|\bmanage (?:your )?(?:email )?preferences\b|\bview (?:this|it) in your browser\b|\bemail preferences\b/i;

/*
 * Mail that says out loud that it is machine-written.
 *
 * A bank's security alert arrives from an ordinary-looking address —
 * account.management@ — with no unsubscribe link, so neither of the other two
 * signals catches it. But somewhere in it, it tells you not to reply, which is
 * the sender saying in plain words that there is nobody at the other end.
 */
const SAYS_AUTOMATED = /\b(?:do not reply|please do not reply|don't reply|this is an automated|automatically generated|automated (?:message|email|notification)|unmonitored (?:mailbox|inbox))\b/i;

function bulkSignal(message) {
  const sender = String(message.sender || message.from || '');
  const subject = String(message.subject || '');
  const body = String(message.bodyText || message.body || message.body_text || '');
  if (BULK_BODY.test(body)) {
    return 'it carries an unsubscribe link, so it was sent to a mailing list';
  }
  if (SAYS_AUTOMATED.test(body)) {
    return 'it says itself that it is automated and not to be replied to';
  }
  if (triage.AUTOMATIC_SUBJECT.test(subject)) {
    return 'it is an automatic notice rather than a message somebody wrote';
  }
  if (triage.NO_REPLY_SENDER.test(sender)) {
    return 'it came from an address nobody reads replies to';
  }
  return null;
}

/* ----------------------------------------------------------------- verdict */

/**
 * Does this message belong in Foundry?
 *
 * Returns `{ keep, reason, evidence, relationship, counterparty }`. The reason
 * is written for the owner and is stored verbatim, whichever way it goes —
 * mail Foundry kept and mail Foundry set aside are equally owed an
 * explanation.
 */
function judge(db, workspaceId, connectorId, message = {}) {
  const sender = String(message.sender || message.from || '').toLowerCase();
  const subject = String(message.subject || '');
  const body = String(message.bodyText || message.body || message.body_text || '');
  const filenames = (message.attachments || []).map((a) => a && a.filename).filter(Boolean).join(' ');
  const text = `${subject}\n${body}\n${filenames}`;
  const lower = text.toLowerCase();
  const counterparty = counterpartyFor(db, workspaceId, connectorId, sender);
  const said = (verdict) => ({ relationship: counterparty ? counterparty.relationship : 'stranger',
    counterparty, ...verdict });

  // 1. It names something of ours.
  const ours = namesOurRecords(db, workspaceId, text) || namesOurProducts(db, workspaceId, text);
  if (ours) {
    return said({ keep: true, evidence: ours.ref,
      reason: `This quotes ${ours.kind}, ${ours.ref}.` });
  }

  // 2. It continues a conversation Foundry is already part of.
  if (continuesOurThread(db, workspaceId, connectorId, message)) {
    return said({ keep: true, evidence: message.threadId || message.externalThreadId,
      reason: 'This is a reply on a conversation Foundry is already keeping.' });
  }

  // 3. Bulk and automated mail, whoever it is from.
  const bulk = bulkSignal(message);
  if (bulk) {
    return said({ keep: false, evidence: null,
      reason: `Set aside because ${bulk}.` });
  }

  // 4. Somebody the business trades with.
  if (counterparty) {
    return said({ keep: true, evidence: sender,
      reason: `${counterparty.name} is a ${counterparty.kind} on your records.` });
  }

  // 5. Anybody at all trying to trade.
  const trading = tradingLanguage(lower, { subject, filenames,
    hasAttachment: (message.attachments || []).length > 0 });
  if (trading) {
    return said({ keep: true, evidence: trading,
      reason: `A sender you do not have on record wrote "${trading}".` });
  }

  // 6. Not Foundry's.
  return said({ keep: false, evidence: null,
    reason: 'Set aside because nothing in it mentions an order, a product, a delivery, an invoice or a '
      + 'payment, and it is not from anyone on your customer or supplier records.' });
}

/* ------------------------------------------------------- what came before */

/*
 * Mail captured before the gate existed.
 *
 * Without this the gate is invisible: it changes what arrives tomorrow and
 * leaves today's screen exactly as the owner complained about it, with bank
 * alerts sitting in "Needs a reply". So captured mail is judged again by the
 * same rule, and the ones that are plainly not the business are set aside.
 *
 * Only mail nothing depends on. A message is left exactly where it is if a
 * person has ruled on it, if a reply was written or sent, if an order or
 * purchasing evidence came out of it, if any of its attachments was used, or
 * if it came from a sender the owner approved. The remaining case is an inert
 * row — and it is not destroyed, it is moved: the envelope and the reason go
 * to the set-aside list, and bringing it back fetches it from the mailbox.
 */
function sweepCaptured(db, workspaceId, connectorId, options = {}) {
  const setAside = require('./mail-set-aside');
  const rows = db.prepare(`SELECT m.* FROM connection_email_messages m
    WHERE m.workspace_id = ? AND m.connector_id = ?
      AND m.trust_status = 'UNTRUSTED'
      AND m.reply_state_by_user_id IS NULL
      AND m.draft_at IS NULL AND m.reply_sent_at IS NULL
      AND m.order_draft_reason IS NULL
      AND NOT EXISTS (SELECT 1 FROM sales_orders so WHERE so.source_email_message_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM supplier_documents d WHERE d.message_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM connection_email_attachments a
        WHERE a.message_id = m.id AND a.setup_document_id IS NOT NULL)
    ORDER BY m.received_at`).all(workspaceId, connectorId);

  const moved = [];
  for (const row of rows) {
    const verdict = judge(db, workspaceId, connectorId, {
      messageId: row.external_message_id, sender: row.sender, subject: row.subject,
      bodyText: row.body_text, threadId: row.external_thread_id, receivedAt: row.received_at,
      attachments: db.prepare(`SELECT filename FROM connection_email_attachments
        WHERE message_id = ?`).all(row.id),
    });
    if (verdict.keep) continue;
    if (options.dryRun) { moved.push({ sender: row.sender, subject: row.subject, reason: verdict.reason }); continue; }
    setAside.record(db, workspaceId, connectorId, {
      messageId: row.external_message_id, sender: row.sender, subject: row.subject,
      receivedAt: row.received_at,
    }, verdict.reason);
    db.prepare('DELETE FROM connection_email_messages WHERE workspace_id = ? AND id = ?')
      .run(workspaceId, row.id);
    moved.push({ sender: row.sender, subject: row.subject, reason: verdict.reason });
  }

  /*
   * And the mirror of the same mistake: an order request filed as handled.
   *
   * Narrow on purpose. Only messages Foundry read as somebody asking to buy,
   * only those Foundry itself filed, and only into the drawer that says
   * somebody is waiting. Re-triaging everything would drag mail the owner has
   * already settled back onto their desk, which is the opposite of the job.
   */
  const buried = db.prepare(`SELECT id FROM connection_email_messages
    WHERE workspace_id = ? AND connector_id = ?
      AND classification = 'customer_order_request'
      AND reply_state = 'HANDLED' AND reply_state_by_user_id IS NULL
      AND reply_sent_at IS NULL`).all(workspaceId, connectorId);
  if (!options.dryRun) {
    for (const row of buried) {
      db.prepare(`UPDATE connection_email_messages SET reply_state = 'NEEDS_REPLY', reply_reason = ?,
        reply_state_at = ? WHERE workspace_id = ? AND id = ?`)
        .run('They are asking to buy something, so they are waiting on you.',
          new Date().toISOString(), workspaceId, row.id);
    }
  }
  return moved;
}

module.exports = { judge, sweepCaptured, counterpartyFor, namesOurRecords, namesOurProducts, continuesOurThread,
  tradingLanguage, bulkSignal, referenceCandidates, DIRECTED, DOCUMENT_NAME };

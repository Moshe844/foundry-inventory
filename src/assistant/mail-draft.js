'use strict';

/**
 * A message StockChief writes, from facts it can show.
 *
 * "Email Lakeside and ask for a price list" or "ask Acme when PO-1013 will
 * ship" is not dictation: the person said what the message is for, not what
 * it should say. The words used to be theirs or nothing, so this was a
 * question back. Now StockChief writes the body — and only the body — from
 * verified facts: the supplier or customer as recorded, the open orders
 * with their numbers, lines and expected dates, what is late and by how
 * much, what is owed. The model is handed those facts and nothing else, and
 * the draft is checked in code afterwards: every order number, date and
 * figure in it must appear in the facts, or the draft is not shown.
 *
 * Nothing is sent from here. The draft is written to the same record every
 * other message uses, shown on its page with the facts it was written from,
 * and goes out only when a person presses Send there.
 */

const { createProviderForTier } = require('../ai/provider');
const { validate } = require('../foundry/validator');
const position = require('../purchasing/position');

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['subject', 'body', 'factsUsed', 'couldNotWrite'],
  properties: {
    subject: { type: 'string', maxLength: 140 },
    body: { type: 'string', maxLength: 3000 },
    // Which of the numbered facts the body relies on.
    factsUsed: { type: 'array', maxItems: 20, items: { type: 'integer', minimum: 1 } },
    // '' when the body was written; otherwise, in one plain sentence, what
    // the message needed that the facts do not contain.
    couldNotWrite: { type: 'string', maxLength: 300 },
  },
};

const SYSTEM = `You write short business emails for the owner of a small stock-holding business, to a supplier or a customer.
Rules, in order of importance:
1. Use ONLY the numbered facts you are given. Never invent an order number, a date, a quantity, a price, a person's name or a promise. If the message needs something the facts do not contain, set couldNotWrite to one plain sentence saying what, and leave body empty.
2. Say what the owner asked for (the purpose), in the owner's voice, plainly and politely. Two to six short sentences. No marketing tone, no apologies for writing, no placeholders in square brackets.
3. Refer to orders by their number exactly as given. Dates as given (YYYY-MM-DD is fine to rewrite as "18 September" but never change the day).
4. Sign off with the owner's name and business name from the facts. Do not add a subject line inside the body.
5. The facts outrank the owner's wording. If the owner says an order is late but the facts say its expected date has not passed, do not call it late: ask for confirmation of the expected date instead. Never state that a date has passed, a quantity is missing or an amount is owed unless a fact says exactly that.
Return JSON: subject, body, factsUsed (the fact numbers you relied on), couldNotWrite.`;

/** The facts about this recipient that StockChief can stand behind, numbered. */
function gatherFacts(db, ctx, recipient, options = {}) {
  const facts = [];
  const push = (text, source) => { facts.push({ n: facts.length + 1, text, source }); return facts.length; };
  const workspace = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(ctx.workspaceId);
  const owner = db.prepare('SELECT name FROM users WHERE id = ?').get(ctx.actorId);
  let policy = {};
  try { policy = require('../sales/customer-communications').policy(db, ctx.workspaceId); } catch { policy = {}; }
  const business = String(policy.businessName || (workspace && workspace.name) || 'the business').replace(/\.$/, '');
  push(`The sender is ${owner && owner.name ? owner.name : 'the owner'} of ${business}.`, 'workspace');
  push(`The recipient is ${recipient.name}, a ${recipient.kind === 'supplier' ? 'supplier' : 'customer'} of ours, at ${recipient.email}.`, recipient.kind);
  const today = new Date().toISOString().slice(0, 10);
  push(`Today is ${today}.`, 'clock');

  if (recipient.kind === 'supplier' && recipient.id) {
    const orders = position.openOrders(db, ctx.workspaceId, { supplierId: recipient.id });
    const late = new Map(position.lateOrders(db, ctx.workspaceId).map((po) => [po.id, po.daysLate]));
    for (const po of orders.slice(0, 6)) {
      const lines = db.prepare(`SELECT i.name product, s.variant_label variant, l.quantity_units, l.quantity_received_units received
        FROM purchase_order_lines l JOIN skus s ON s.id = l.sku_id JOIN items i ON i.id = s.item_id WHERE l.purchase_order_id = ? ORDER BY l.line_number`).all(po.id);
      const what = lines.map((l) => `${l.quantity_units} ${l.product}${l.variant ? ` / ${l.variant}` : ''}${l.received ? ` (${l.received} received so far)` : ''}`).join('; ');
      const status = { DRAFT: 'a draft we have not sent them', AWAITING_APPROVAL: 'not yet approved on our side', APPROVED: 'approved, not yet sent to them', ORDERED: 'placed with them', PARTIALLY_RECEIVED: 'partly received' }[po.status] || po.status.toLowerCase();
      push(`Purchase order ${po.po_number}: ${status}; ordered ${po.order_date || 'on an unrecorded date'}; ${what}; ${po.outstanding_units} units still to arrive${po.expected_date ? `; expected by ${po.expected_date}` : '; no expected date recorded'}${late.has(po.id) ? `; ${late.get(po.id)} day${late.get(po.id) === 1 ? '' : 's'} past the expected date — it is late` : po.expected_date && po.expected_date >= today ? `; that date has not passed yet (${daysUntil(today, po.expected_date)} day${daysUntil(today, po.expected_date) === 1 ? '' : 's'} away) — it is not late` : ''}.`, `purchase_order:${po.id}`);
    }
    if (!orders.length) push(`We have no open purchase orders with ${recipient.name} at the moment.`, 'purchase_orders');
    try {
      const bills = require('../accounting/payables').list(db, ctx.workspaceId, { supplierId: recipient.id }).filter((b) => b.status !== 'DRAFT' && Number(b.balance_minor) > 0);
      for (const b of bills.slice(0, 4)) push(`Their bill ${b.bill_number}${b.supplier_invoice_number ? ` (their invoice ${b.supplier_invoice_number})` : ''} for ${(Number(b.total_minor) / 100).toFixed(2)} ${b.currency} is ${b.due_date ? `due ${b.due_date}` : 'due on an unrecorded date'}; ${(Number(b.balance_minor) / 100).toFixed(2)} ${b.currency} is still owed by us.`, `bill:${b.id}`);
    } catch { /* accounting not enabled */ }
    const items = db.prepare(`SELECT i.name product, si.purchase_unit, si.units_per_purchase_unit, si.last_unit_cost, si.lead_time_days
      FROM supplier_items si JOIN skus s ON s.id = si.sku_id JOIN items i ON i.id = s.item_id
      WHERE si.workspace_id = ? AND si.supplier_id = ? AND si.is_active = 1 ORDER BY i.name LIMIT 12`).all(ctx.workspaceId, recipient.id);
    if (items.length) push(`We buy from them: ${items.map((it) => `${it.product}${it.purchase_unit && it.purchase_unit !== 'unit' ? ` (by the ${it.purchase_unit} of ${it.units_per_purchase_unit})` : ''}${it.last_unit_cost != null ? ` last at ${Number(it.last_unit_cost).toFixed(2)} per unit` : ''}`).join('; ')}.`, 'supplier_items');
  }

  if (recipient.kind === 'customer' && recipient.id) {
    const orders = db.prepare(`SELECT so.id, so.order_number, so.status, so.order_date, so.needed_by FROM sales_orders so
      WHERE so.workspace_id = ? AND so.customer_id = ? AND so.status NOT IN ('CANCELLED') ORDER BY so.order_date DESC, so.created_at DESC LIMIT 5`).all(ctx.workspaceId, recipient.id);
    for (const so of orders) {
      const lines = db.prepare(`SELECT i.name product, s.variant_label variant, l.quantity_ordered, l.quantity_fulfilled FROM sales_order_lines l
        JOIN skus s ON s.id = l.sku_id JOIN items i ON i.id = s.item_id WHERE l.sales_order_id = ? ORDER BY l.created_at`).all(so.id);
      push(`Their order ${so.order_number}: ${so.status.toLowerCase().replace(/_/g, ' ')}; placed ${so.order_date || 'on an unrecorded date'}${so.needed_by ? `; needed by ${so.needed_by}` : ''}; ${lines.map((l) => `${l.quantity_ordered} ${l.product}${l.variant ? ` / ${l.variant}` : ''}${l.quantity_fulfilled ? ` (${l.quantity_fulfilled} sent)` : ''}`).join('; ')}.`, `sales_order:${so.id}`);
      const ships = db.prepare('SELECT shipment_number, status, carrier, tracking_number, shipped_at, expected_delivery_date FROM sales_shipments WHERE sales_order_id = ? ORDER BY created_at DESC LIMIT 2').all(so.id);
      for (const sh of ships) push(`Shipment ${sh.shipment_number} for ${so.order_number}: ${String(sh.status).toLowerCase()}${sh.carrier ? ` with ${sh.carrier}` : ''}${sh.tracking_number ? `, tracking ${sh.tracking_number}` : ''}${sh.shipped_at ? `, shipped ${String(sh.shipped_at).slice(0, 10)}` : ''}${sh.expected_delivery_date ? `, expected ${sh.expected_delivery_date}` : ''}.`, `shipment:${sh.shipment_number}`);
    }
    try {
      const invoices = db.prepare(`SELECT invoice_number, due_date, total_minor, balance_minor, currency FROM accounting_customer_invoices WHERE workspace_id = ? AND customer_id = ? AND status = 'OPEN' AND balance_minor > 0 ORDER BY due_date LIMIT 4`).all(ctx.workspaceId, recipient.id);
      for (const v of invoices) push(`Our invoice ${v.invoice_number} for ${(Number(v.total_minor) / 100).toFixed(2)} ${v.currency}${v.due_date ? `, due ${v.due_date}` : ''}: ${(Number(v.balance_minor) / 100).toFixed(2)} ${v.currency} still unpaid.`, `invoice:${v.invoice_number}`);
    } catch { /* no accounting */ }
  }
  if (options.referentNote) push(`Earlier in this conversation: ${options.referentNote}.`, 'conversation');
  return facts;
}

function daysUntil(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
}

/** Every order number, date and figure in the body, so each can be checked against the facts. */
function tokens(text) {
  return [...String(text || '').matchAll(/\b(?:PO|SO|SHP|RMA|BILL|INV)-\d+\b|\b\d{4}-\d{2}-\d{2}\b|\b\d+(?:[.,]\d+)?\b/gi)].map((m) => m[0].toLowerCase());
}

/** A figure the facts do not contain is one StockChief made up. */
function unsupported(body, facts) {
  const haystack = facts.map((f) => f.text.toLowerCase()).join('\n');
  // "18 September", "September 18th": the day survives either rewrite.
  const months = 'january|february|march|april|may|june|july|august|september|october|november|december';
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:${months})\\b`, 'gi');
  const monthFirst = new RegExp(`\\b(?:${months})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
  const rewrittenDays = new Set([...String(body || '').matchAll(dayFirst), ...String(body || '').matchAll(monthFirst)].map((m) => String(Number(m[1]))));
  // Whole tokens only: "40" is not in "8-40c0ff", and "2026-09-20" is not "20".
  const present = (t) => new RegExp(`(?<![\\w.-])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'i').test(haystack);
  return [...new Set(tokens(body))].filter((t) => {
    if (present(t)) return false;
    // "18 September" for 2026-09-18: the day survives the rewrite.
    if (rewrittenDays.has(String(Number(t))) && new RegExp(`-${String(t).padStart(2, '0')}\\b`).test(haystack)) return false;
    // A count of things in the message itself ("two orders") is not a fact.
    return !(Number(t) <= 6 && Number.isInteger(Number(t)));
  });
}

/**
 * @returns {{ok:true, subject, body, facts, factsUsed}|{ok:false, question}}
 */
async function compose(db, ctx, { recipient, purpose, instruction, referentNote }, options = {}) {
  const facts = gatherFacts(db, ctx, recipient, { referentNote });
  const provider = options.provider || createProviderForTier('fast');
  const prompt = `Facts (numbered; use nothing else):\n${facts.map((f) => `${f.n}. ${f.text}`).join('\n')}\n\nWhat the owner wants this message to do: ${purpose}\nThe owner's full request, for tone: ${instruction}`;
  let attempt = 0;
  let last = null;
  while (attempt < 2) {
    attempt += 1;
    const response = await provider.complete({ system: SYSTEM + (attempt > 1 && last ? `\nYour previous draft used details not in the facts (${last.join(', ')}). Write it again using only the facts.` : ''), prompt, schema: SCHEMA, schemaName: 'assistant_mail_draft', maxTokens: 1200 });
    const checked = validate(SCHEMA, response.data, { key: 'assistant-mail-draft' });
    if (!checked.ok) continue;
    const draft = checked.data;
    if (draft.couldNotWrite && !draft.body.trim()) {
      return { ok: false, question: `StockChief could not write that from your records: ${draft.couldNotWrite} Say what you want said and it will use your words.` };
    }
    const invented = unsupported(draft.body, facts);
    if (!invented.length) {
      return { ok: true, subject: draft.subject.trim() || null, body: draft.body.trim(), facts,
        factsUsed: draft.factsUsed.filter((n) => facts[n - 1]).map((n) => facts[n - 1]) };
    }
    last = invented;
  }
  return { ok: false, question: `StockChief could not write that without adding details that are not in your records${last ? ` (${last.join(', ')})` : ''}, so it wrote nothing. Say what you want said and it will use your words exactly.` };
}

/**
 * Whether the person is dictating words (kept exactly) or asking for a
 * message to be written for a purpose (composed from facts).
 */
function wantsComposition(instruction, body) {
  const text = String(instruction || '');
  if (/\b(?:saying|that says|tell (?:them|him|her)\s*:|say\s*:|says?\s*["“])/i.test(text)) return false;
  if (/["“][^"”]{12,}["”]/.test(text)) return false;
  const b = String(body || '').trim();
  if (!b) return true;
  return /^(?:to\s+)?(?:ask(?:ing)?|request(?:ing)?|chase|chasing|remind(?:ing)?|check(?:ing)?|find out|follow(?:ing)? up|see (?:if|when|whether)|about|for a|for the|when|whether|if|why)\b/i.test(b)
    || /\b(?:ask|asking|request|chase|remind|follow up)\b/i.test(text) && b.split(/\s+/).length <= 12;
}

module.exports = { compose, gatherFacts, unsupported, wantsComposition, SCHEMA, SYSTEM };

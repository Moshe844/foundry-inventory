'use strict';

/**
 * "I paid ABC $400 toward invoice 8832 by ACH."
 *
 * A payment made outside Foundry is information Foundry cannot observe. Nothing
 * can change that — no bank feed is connected, so somebody has to say it
 * happened. What can change is the cost of saying it: opening payables, finding
 * the bill, entering a payment, checking the supplier balance, and trusting
 * that the accounting followed is seven steps for one fact.
 *
 * This turns the sentence into a proposal against real records. It adds no
 * financial logic whatsoever — the posting, the allocation across bills, the
 * unapplied remainder, the idempotency and the journal are all
 * accounting/payments, which already handles them and is tested for partial
 * payments, several payments against one bill, and one payment across several.
 *
 * The one rule it enforces of its own: it does not decide which bill a payment
 * settles when the sentence does not say and the records do not make it
 * obvious. A misapplied payment is a wrong balance for two counterparties, and
 * guessing it would be exactly the kind of invented financial fact the rest of
 * Foundry refuses to produce.
 */

const payments = require('./payments');
const config = require('../config');
const { createProviderForTier } = require('../ai/provider');
const { ValidationError } = require('../domain/errors');

const money = (minor, currency = 'USD') => new Intl.NumberFormat('en-US',
  { style: 'currency', currency }).format(Number(minor || 0) / 100);

/**
 * What a model is allowed to read out of the sentence.
 *
 * Only what was said. Every one of these is checked against records before it
 * becomes a payment, and the amount is re-read from the text rather than
 * trusted, because it is the one field where a mistake moves money.
 */
const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['direction', 'counterpartyName', 'amountText', 'reference', 'method', 'dateText'],
  properties: {
    direction: { type: 'string', enum: ['SUPPLIER_PAYMENT', 'CUSTOMER_RECEIPT', 'UNCLEAR'] },
    counterpartyName: { type: 'string' },
    amountText: { type: 'string' },
    reference: { type: 'string' },
    method: { type: 'string' },
    dateText: { type: 'string' },
  },
};

const SYSTEM = `You read one sentence in which a business owner reports a payment
that has already happened, and return only what the sentence says.

- direction: SUPPLIER_PAYMENT when they paid someone, CUSTOMER_RECEIPT when
  someone paid them, UNCLEAR when the sentence does not say.
- counterpartyName: the supplier or customer exactly as written.
- amountText: the amount exactly as written, including its symbol.
- reference: the invoice, bill or order number if one is named, else "".
- method: cheque, ACH, card, cash, transfer, and so on, if said, else "".
- dateText: any date or day named, else "".

Never infer an amount, a counterparty or a reference that is not in the
sentence. An empty string is the correct answer when something was not said.`;

/** The amount, read from the text rather than from the model's retyping of it. */
function amountFrom(text) {
  const match = /(-?\$?\s?\d[\d,]*(?:\.\d{1,2})?)/.exec(String(text || ''));
  if (!match) return null;
  const value = Number(match[1].replace(/[$,\s]/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}


/**
 * The fields, read from the sentence.
 *
 * Deterministic first, because most of these sentences are plain: a payment
 * verb, an amount, sometimes an invoice number, sometimes a method. The model
 * is asked only when that leaves the counterparty unknown, and even then the
 * amount is re-parsed here rather than taken from what it returns.
 *
 * Nothing it produces is trusted on its own — propose() checks every field
 * against real records and refuses what it cannot place.
 */
async function read(text, options = {}) {
  const said = String(text || '').trim();
  if (!said) return null;

  const receipt = /\b(?:paid|pays|sent|wired|transferred|remitted)\s+(?:us|me)\b/i.test(said)
    || /\bwe\s+(?:received|got)\b/i.test(said)
    || /\breceived\s+(?:a\s+)?payment\b/i.test(said);

  const deterministic = {
    direction: receipt ? 'CUSTOMER_RECEIPT' : 'SUPPLIER_PAYMENT',
    counterpartyName: '',
    amountText: (/(\$\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*\.\d{2}\b)/.exec(said) || [])[1] || '',
    reference: (/\b(?:invoice|inv|bill|po|order)\s*#?\s*([A-Za-z0-9-]{2,})/i.exec(said) || [])[1] || '',
    method: (/\b(ach|cheque|check|card|cash|wire|transfer|bank transfer|paypal)\b/i.exec(said) || [])[1] || '',
    dateText: /\btoday\b/i.test(said) ? new Date().toISOString().slice(0, 10) : '',
  };

  // "I paid ABC Apparel $400 …" / "ABC School paid us $500 …"
  // The terminators need word boundaries: without them the "on" inside
  // "CottonWorks" ended the name after four letters.
  const paidWho = /\bpaid\s+([A-Za-z][A-Za-z0-9 &'.-]{1,60}?)\s*(?:\$|\d|\b(?:toward|towards|for|on|by)\b)/i.exec(said);
  const whoPaid = /^\s*([A-Za-z][A-Za-z0-9 &'.-]{1,60}?)\s+(?:paid|sent|wired)\b/i.exec(said);
  deterministic.counterpartyName = receipt
    ? (whoPaid ? whoPaid[1] : '').trim()
    : (paidWho ? paidWho[1] : '').trim();

  const usable = deterministic.counterpartyName && amountFrom(deterministic.amountText);
  if (usable || (!options.provider && !config.ai.configured)) return deterministic;

  let response;
  try {
    response = await (options.provider || createProviderForTier('fast')).complete({
      system: SYSTEM,
      prompt: `Sentence: ${said}`,
      schema: EXTRACTION_SCHEMA,
      schemaName: 'reported_payment',
    });
  } catch {
    return deterministic.counterpartyName ? deterministic : null;
  }

  const data = (response && response.data) || {};
  return {
    direction: ['SUPPLIER_PAYMENT', 'CUSTOMER_RECEIPT', 'UNCLEAR'].includes(data.direction)
      ? data.direction : deterministic.direction,
    counterpartyName: data.counterpartyName || deterministic.counterpartyName,
    // The figure that moves money is read from the sentence, never from the
    // model's retyping of it.
    amountText: deterministic.amountText || data.amountText || '',
    reference: data.reference || deterministic.reference,
    method: data.method || deterministic.method,
    dateText: data.dateText || deterministic.dateText,
  };
}

const normalise = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The supplier or customer named, when exactly one plausibly matches. */
function resolveCounterparty(db, workspaceId, direction, name) {
  const table = direction === 'CUSTOMER_RECEIPT' ? 'customers' : 'suppliers';
  const rows = db.prepare(`SELECT id, name FROM ${table} WHERE workspace_id = ?`).all(workspaceId);
  const wanted = normalise(name);
  if (!wanted) return { matches: [] };

  const exact = rows.filter((row) => normalise(row.name) === wanted);
  if (exact.length === 1) return { counterparty: exact[0], matches: exact };

  const partial = rows.filter((row) => {
    const candidate = normalise(row.name);
    return candidate.includes(wanted) || wanted.includes(candidate);
  });
  if (partial.length === 1) return { counterparty: partial[0], matches: partial };
  return { matches: partial.length ? partial : exact };
}

/** Bills or invoices this counterparty still owes money on, newest first. */
function openDocuments(db, workspaceId, direction, counterpartyId) {
  return direction === 'CUSTOMER_RECEIPT'
    ? db.prepare(`SELECT id, invoice_number AS number, total_minor, balance_minor, currency
         FROM accounting_customer_invoices
        WHERE workspace_id = ? AND customer_id = ? AND status <> 'VOID' AND balance_minor > 0
        ORDER BY issue_date DESC`).all(workspaceId, counterpartyId)
    : db.prepare(`SELECT id, bill_number AS number, supplier_invoice_number, total_minor,
         balance_minor, currency
         FROM accounting_supplier_bills
        WHERE workspace_id = ? AND supplier_id = ? AND status <> 'VOID' AND balance_minor > 0
        ORDER BY issue_date DESC`).all(workspaceId, counterpartyId);
}

/** The document a reference names — "8832" matches INV-8832 and bill 8832 alike. */
function matchReference(documents, reference) {
  const wanted = normalise(reference);
  if (!wanted) return [];
  return documents.filter((doc) => {
    const candidates = [doc.number, doc.supplier_invoice_number].filter(Boolean).map(normalise);
    return candidates.some((candidate) => candidate === wanted
      || candidate.endsWith(` ${wanted}`) || candidate.replace(/\s+/g, '').endsWith(wanted));
  });
}

/**
 * Turns extracted fields into something a person can approve, or a question.
 *
 * Returns either a proposal carrying the exact effect of the payment, or the
 * one thing Foundry needs before it can prepare one. It never returns a
 * proposal it had to guess at.
 */
function propose(db, workspaceId, fields) {
  const direction = fields.direction === 'CUSTOMER_RECEIPT' ? 'CUSTOMER_RECEIPT' : 'SUPPLIER_PAYMENT';
  if (fields.direction === 'UNCLEAR') {
    return { ok: false, question: 'Did you pay them, or did they pay you?' };
  }

  const amountMinor = amountFrom(fields.amountText);
  if (!amountMinor) {
    return { ok: false, question: 'How much was the payment?' };
  }

  const who = resolveCounterparty(db, workspaceId, direction, fields.counterpartyName);
  const party = direction === 'CUSTOMER_RECEIPT' ? 'customer' : 'supplier';
  if (!who.counterparty) {
    return {
      ok: false,
      question: who.matches.length
        ? `Which ${party} was that? ${who.matches.map((row) => row.name).join(', ')}`
        : `Foundry has no ${party} called “${fields.counterpartyName}”.`,
      candidates: who.matches,
    };
  }

  const documents = openDocuments(db, workspaceId, direction, who.counterparty.id);
  // A document the owner picked when Foundry asked which one. Answering the
  // question continues the same report rather than restarting it.
  const picked = fields.documentId
    ? documents.filter((doc) => doc.id === fields.documentId)
    : null;
  const named = picked || matchReference(documents, fields.reference);

  let target = null;
  if (named.length === 1) target = named[0];
  else if (named.length > 1) {
    return {
      ok: false,
      question: `More than one open ${direction === 'CUSTOMER_RECEIPT' ? 'invoice' : 'bill'} `
        + `matches “${fields.reference}”. Which one?`,
      candidates: named,
    };
  } else if (fields.reference) {
    return {
      ok: false,
      question: `${who.counterparty.name} has no open ${direction === 'CUSTOMER_RECEIPT' ? 'invoice' : 'bill'} `
        + `matching “${fields.reference}”.`,
      candidates: documents,
    };
  } else if (documents.length === 1) {
    // Only one thing it could be paying, so this is not a guess.
    [target] = documents;
  } else if (documents.length > 1) {
    return {
      ok: false,
      question: `Which ${direction === 'CUSTOMER_RECEIPT' ? 'invoice' : 'bill'} does this settle? `
        + `${who.counterparty.name} has ${documents.length} open.`,
      candidates: documents,
    };
  }

  const currency = (target && target.currency) || 'USD';
  const applied = target ? Math.min(amountMinor, Number(target.balance_minor)) : 0;
  const unapplied = amountMinor - applied;

  return {
    ok: true,
    proposal: {
      direction,
      counterpartyId: who.counterparty.id,
      counterpartyName: who.counterparty.name,
      amountMinor,
      currency,
      method: fields.method || null,
      paymentDate: /^\d{4}-\d{2}-\d{2}$/.test(fields.dateText || '')
        ? fields.dateText
        : new Date().toISOString().slice(0, 10),
      target: target ? {
        id: target.id,
        number: target.number,
        totalMinor: Number(target.total_minor),
        balanceBeforeMinor: Number(target.balance_minor),
        appliedMinor: applied,
        balanceAfterMinor: Number(target.balance_minor) - applied,
      } : null,
      unappliedMinor: unapplied,
      // What the owner is approving, in the words they would use.
      preview: target
        ? [
          `${target.number}: ${money(target.total_minor, currency)} total`,
          `${money(target.balance_minor, currency)} outstanding before this payment`,
          `${money(applied, currency)} applied`,
          `${money(Number(target.balance_minor) - applied, currency)} remaining after`,
          ...(unapplied ? [`${money(unapplied, currency)} left unapplied, held against ${who.counterparty.name}`] : []),
        ]
        : [
          `${money(amountMinor, currency)} recorded against ${who.counterparty.name}`,
          'Nothing is outstanding, so the whole amount is held unapplied until there is something to settle.',
        ],
    },
  };
}

/**
 * Records an approved proposal through the ordinary payment engine.
 *
 * Deliberately thin: everything financial happens in accounting/payments, so a
 * payment reported in a sentence and one entered on the form are the same
 * record, posted the same way, and correct in the same tests.
 */
function apply(db, ctx, membership, proposal, options = {}) {
  if (!proposal || !proposal.counterpartyId) throw new ValidationError('That payment has nothing to apply.');
  return payments.record(db, ctx, membership, {
    direction: proposal.direction,
    supplierId: proposal.direction === 'SUPPLIER_PAYMENT' ? proposal.counterpartyId : undefined,
    customerId: proposal.direction === 'CUSTOMER_RECEIPT' ? proposal.counterpartyId : undefined,
    amountMinor: proposal.amountMinor,
    paymentDate: proposal.paymentDate,
    method: proposal.method || undefined,
    reference: proposal.target ? proposal.target.number : undefined,
    // The engine names the allocated document by its own type: an invoice for
    // money coming in, a bill for money going out.
    allocations: proposal.target && proposal.target.appliedMinor
      ? [proposal.direction === 'CUSTOMER_RECEIPT'
        ? { invoiceId: proposal.target.id, amountMinor: proposal.target.appliedMinor }
        : { billId: proposal.target.id, amountMinor: proposal.target.appliedMinor }]
      : [],
    sourceKey: options.sourceKey,
  });
}

module.exports = { EXTRACTION_SCHEMA, SYSTEM, read, propose, apply, amountFrom, resolveCounterparty };

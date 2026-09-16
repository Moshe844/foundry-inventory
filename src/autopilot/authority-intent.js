'use strict';

/**
 * Reading a sentence about what StockChief may do, and turning it into grants.
 *
 * "Automatically send payment requests to customers, but always ask me before
 * placing supplier orders" is two instructions in one breath, pointing in
 * opposite directions. The owner should be able to say that and have StockChief
 * end up with exactly two settings changed and nothing else touched — the same
 * settings the Settings page edits, because there is only one set of rules.
 *
 * This is deterministic on purpose. Authority is the last thing to hand to a
 * model's judgement: a sentence it reads slightly wrong is a permission
 * somebody did not give. So the reading is done by matching phrases people
 * actually use, clause by clause, and anything that does not match cleanly
 * comes back as a question rather than a guess.
 */

const { CAPABILITIES, NAMES } = require('./capabilities');

/*
 * The words each job is described with, in the owner's language rather than
 * the schema's. Order matters within a clause only in that every match counts;
 * a clause naming two jobs sets both.
 */
const PHRASES = {
  payment_requests: [
    'payment request', 'payment requests', 'payment link', 'payment links',
    'ask for payment', 'ask customers to pay', 'ask for money', 'chase payment',
    'asking customers', 'ask customers', 'asking for money', 'asking for payment',
    'chase invoices', 'request payment', 'invoice the customer', 'deposit request',
  ],
  shipping_labels: [
    'shipping label', 'shipping labels', 'buy labels', 'buy the label', 'buy shipping',
    'postage', 'book the courier', 'book couriers', 'ship orders', 'shipping automatically',
    'buy postage', 'print labels', 'arrange shipping',
  ],
  supplier_emails: [
    'supplier email', 'supplier emails', 'email suppliers', 'emails to suppliers',
    'contact suppliers', 'send purchase orders', 'send po', 'send supplier',
  ],
  replenishment: [
    'purchase order', 'purchase orders', 'supplier order', 'supplier orders',
    'reorder', 'reordering', 'replenish', 'replenishment', 'restock', 'buy stock',
    'place orders', 'placing orders', 'order stock', 'buying',
  ],
  replenishment_settings: [
    'reorder point', 'reorder points', 'reorder level', 'reorder levels',
    'stock target', 'stock targets', 'replenishment target', 'replenishment targets',
    'safety stock', 'reorder setting', 'reorder settings', 'stock levels up to date',
  ],
  inventory_transfers: [
    'transfer', 'transfers', 'move stock', 'moving stock', 'move inventory',
    'rebalance', 'between locations', 'between branches',
  ],
  customer_replies: [
    'customer reply', 'customer replies', 'reply to customers', 'answer customers',
    'answer customer', 'respond to customers', 'reply to customer',
  ],
  shipping_notices: [
    'shipping notice', 'shipping notices', 'shipping notification', 'shipping notifications',
    'dispatch note', 'tell customers when', 'shipment notification', 'delivery notification',
  ],
};

/* Somebody handing authority over. */
const GRANTING = [
  'automatically', 'automatic', 'auto', 'without asking', 'without me',
  'on its own', 'by itself', 'yourself', 'go ahead and', 'you can', 'you may',
  'feel free to', 'handle', 'take care of', 'let stockchief', 'allow stockchief', 'let foundry', 'allow foundry',
];

/* Somebody keeping it. */
const WITHHOLDING = [
  'ask me', 'ask first', 'check with me', 'confirm with me', 'my approval',
  'approve', 'never', 'do not', "don't", 'dont', 'stop', 'no longer',
  'always ask', 'run it by me', 'not without', 'wait for me',
];

/** Word-boundary at the start, so "auto" does not match "automotive". */
function says(text, phrase) {
  for (let from = 0; ; from += 1) {
    const at = text.indexOf(phrase, from);
    if (at < 0) return false;
    if (at === 0 || !/[a-z0-9]/i.test(text[at - 1])) return true;
    from = at;
  }
}

/*
 * Clauses, because one sentence routinely contains both answers. Splitting on
 * "but", "however", "though" and the like is what lets the two halves of
 * "automatically do X but ask me before Y" disagree with each other.
 */
function clauses(sentence) {
  return String(sentence || '')
    .toLowerCase()
    // Not on bare "and": it joins far more often than it separates, and
    // splitting there tore "go ahead and reply to customers" in half —
    // the permission in one piece, the job it applied to in the other.
    .split(/\s*(?:,|;|\.|\bbut\b|\bhowever\b|\bthough\b|\balthough\b|\bwhile\b|\bwhereas\b)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Read a sentence into grants.
 *
 * Returns what would change, what was named but unclear, and a plain sentence
 * describing the reading — so the owner confirms an interpretation rather than
 * discovering one later.
 */
function read(sentence) {
  const grants = {};
  const unclear = [];
  const seen = new Set();

  let namedSoFar = [];
  for (const clause of clauses(sentence)) {
    /*
     * The phrase each job matched on, kept rather than discarded, so that a
     * clause matching two jobs can be settled by which of them was named more
     * precisely. "Keep the reorder points up to date" names one job; without
     * this it also names placing purchase orders, because "reorder point"
     * contains "reorder" — and the owner would be granting the power to spend.
     */
    const matches = new Map();
    for (const name of NAMES) {
      const phrases = (PHRASES[name] || []).filter((phrase) => says(clause, phrase));
      if (phrases.length) {
        matches.set(name, phrases.reduce((longest, phrase) =>
          (phrase.length > longest.length ? phrase : longest), ''));
      }
    }
    const named = [...matches.keys()].filter((name) => {
      const mine = matches.get(name);
      // Dropped when some other job matched on a phrase that contains this
      // one: the more specific reading is the one the person meant.
      for (const [other, phrase] of matches) {
        if (other !== name && phrase.length > mine.length && phrase.includes(mine)) return false;
      }
      return true;
    });
    const granting = GRANTING.some((word) => says(clause, word));
    const withholding = WITHHOLDING.some((word) => says(clause, word));

    /*
     * "Automatically place supplier orders, but ask me first" ends with a
     * clause naming no job at all. It is plainly about the one just named, and
     * taking authority back is the safe way to read a sentence that argues
     * with itself. Only withholding carries backwards: a trailing
     * "automatically" is not clear enough to hand authority over on.
     */
    if (!named.length) {
      if (withholding && !granting) for (const name of namedSoFar) grants[name] = false;
      continue;
    }
    namedSoFar = named;

    for (const name of named) {
      seen.add(name);
      /*
       * Withholding wins a tie. "Automatically prepare orders but ask me
       * before placing them" contains both signals, and the safe reading of an
       * ambiguous sentence about authority is the one that grants less.
       */
      if (withholding) grants[name] = false;
      else if (granting) grants[name] = true;
      else if (!(name in grants)) unclear.push(name);
    }
  }

  const changes = Object.entries(grants);
  return {
    understood: changes.length > 0,
    grants,
    unclear: unclear.filter((name) => !(name in grants)),
    summary: changes.length
      ? changes.map(([name, on]) => `${on ? 'StockChief may' : 'StockChief may not'} `
        + `${CAPABILITIES[name].label.toLowerCase()} on its own.`).join(' ')
      : null,
    /*
     * Nothing that was not named is touched. An instruction about payments
     * must leave purchasing exactly where it was, which is the whole reason
     * these are separate.
     */
    untouched: NAMES.filter((name) => !seen.has(name)),
  };
}

/** Read it and write it, in one step, through the same rules Settings edits. */
function applySentence(db, ctx, membership, sentence) {
  const reading = read(sentence);
  if (!reading.understood) return { ...reading, applied: false };
  const capabilities = require('./capabilities');
  capabilities.apply(db, ctx, membership, reading.grants);
  return { ...reading, applied: true, capabilities: capabilities.list(db, ctx.workspaceId) };
}

module.exports = { read, applySentence, PHRASES, GRANTING, WITHHOLDING };

'use strict';

/**
 * Retiring a record, whatever kind of record it is.
 *
 * Foundry could already be told to archive a product, because `archive_item`
 * was written by hand: an entry in the intent enum, a paragraph in the prompt,
 * a permission, a branch in the proposal builder, a branch in the executor, a
 * branch in the verifier, a line in the presenter. Eight places. Doing that
 * again for suppliers, then customers, then locations would be eight more each
 * time, and the fourth kind would be eight more after that.
 *
 * So the kinds live here, once. Every integration point asks this registry what
 * exists rather than naming the kinds itself — including the sentence in the
 * model prompt, which is generated from these entries. Adding a fifth kind is
 * one object in KINDS, and the reader, the preview, the permission check, the
 * execution and the verification all pick it up.
 *
 * The one rule every kind shares: a record nothing refers to is deleted, and a
 * record something refers to is archived. Deleting a supplier who is named on a
 * purchase order would leave that order attributed to nobody, so it is kept and
 * hidden instead. Which of the two will happen is worked out before anything is
 * approved, so the preview can promise the right one.
 */

const permissions = require('./permissions');
const supplierService = require('../purchasing/supplier-service');
const sales = require('../sales/sales-order-service');
const locationService = require('../domain/location-service');
const repo = require('../domain/repository');

/**
 * @typedef {object} Kind
 * @property {string} kind        machine name, and what the reader returns
 * @property {string} label       singular noun, in the words a person uses
 * @property {string} plural
 * @property {string} permission  what somebody must be allowed to do
 * @property {string[]} says      example phrasings, for the model prompt
 * @property {(db, workspaceId, name) => object} find
 * @property {(db, workspaceId, id) => object} usage
 * @property {(db, ctx, id) => object} remove
 * @property {(db, workspaceId, id) => boolean} isGone  true once it is retired
 */

/** Case-insensitive exact match first, then a single unambiguous prefix. */
function matchByName(rows, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return { ok: false, message: 'Which one did you mean?', candidates: rows };
  const exact = rows.filter((r) => String(r.name || '').toLowerCase() === wanted);
  if (exact.length === 1) return { ok: true, value: exact[0] };
  if (exact.length > 1) return { ok: false, message: `More than one is called “${name}”.`, candidates: exact };
  const partial = rows.filter((r) => String(r.name || '').toLowerCase().includes(wanted));
  if (partial.length === 1) return { ok: true, value: partial[0] };
  if (partial.length > 1) {
    return { ok: false, message: `Which one did you mean by “${name}”?`, candidates: partial };
  }
  return { ok: false, message: `Nothing here is called “${name}”.`, candidates: rows.slice(0, 8) };
}

const KINDS = [
  {
    kind: 'supplier',
    label: 'supplier',
    plural: 'suppliers',
    permission: permissions.MANAGE_SUPPLIERS || permissions.OPERATE,
    says: ['remove the supplier ABC Apparel', 'delete Vantage Footwear', 'we do not buy from Kestrel any more'],
    // Ways of naming this kind without using the word. "We don't buy from them
    // any more" is about a supplier and about nothing else, but on the words
    // alone it looks like a sentence about buying.
    hints: ["(?:do(?:es)?\\s+not|don'?t|no\\s+longer|never)\\s+(?:buy|order|purchase)\\s+from", 'vendor'],
    find: (db, workspaceId, name) =>
      matchByName(supplierService.listSuppliers(db, workspaceId, { includeInactive: false }), name),
    usage: (db, workspaceId, id) => supplierService.supplierUsage(db, workspaceId, id),
    remove: (db, ctx, id) => supplierService.removeSupplier(db, ctx, id),
    isGone: (db, workspaceId, id) => {
      const row = db.prepare('SELECT status FROM suppliers WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
      return !row || row.status !== 'active';
    },
  },
  {
    kind: 'customer',
    label: 'customer',
    plural: 'customers',
    permission: permissions.OPERATE,
    says: ['remove the customer Alpine Outfitters', 'delete Northvale from my customers'],
    hints: ['client', 'buyer'],
    find: (db, workspaceId, name) => matchByName(sales.listCustomers(db, workspaceId), name),
    usage: (db, workspaceId, id) => sales.customerUsage(db, workspaceId, id),
    remove: (db, ctx, id) => sales.removeCustomer(db, ctx, id),
    isGone: (db, workspaceId, id) => {
      const row = db.prepare('SELECT record_state FROM customers WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
      return !row || row.record_state === 'ARCHIVED';
    },
  },
  {
    kind: 'location',
    label: 'location',
    plural: 'locations',
    permission: permissions.ADMIN,
    says: ['archive the Downtown Store location', 'we closed the Harbour warehouse'],
    hints: ['warehouse', 'store', 'stockroom'],
    find: (db, workspaceId, name) =>
      matchByName(repo.listLocations(db, workspaceId), name),
    /*
     * A location is never deleted. Movements point at it by id, so removing the
     * row would strand the history of everything that ever sat there; the
     * service also refuses while stock is still on its shelves.
     */
    usage: (db, workspaceId, id) => {
      const held = db.prepare(`SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances
        WHERE workspace_id = ? AND location_id = ?`).get(workspaceId, id).n;
      const moves = db.prepare(`SELECT COUNT(*) AS n FROM movements
        WHERE workspace_id = ? AND location_id = ?`).get(workspaceId, id).n;
      const child = db.prepare(`SELECT name FROM locations
        WHERE workspace_id = ? AND parent_location_id = ? AND is_active = 1 LIMIT 1`).get(workspaceId, id);
      const used = [];
      if (moves) used.push({ label: 'recorded movements', count: moves });
      // Both of these are what setLocationActive itself refuses on. They are
      // repeated here so the preview says so before anybody approves, rather
      // than letting an approved action fail at the last moment.
      let blocked = null;
      if (held) blocked = `it still holds ${held} unit${held === 1 ? '' : 's'}. Move that stock somewhere else first.`;
      else if (child) blocked = `${child.name} still sits inside it. Move or archive that first.`;
      return { used, total: moves, deletable: false, blocked };
    },
    remove: (db, ctx, id) => {
      locationService.setLocationActive(db, ctx, id, false);
      return { deleted: false };
    },
    isGone: (db, workspaceId, id) => {
      const row = db.prepare('SELECT is_active FROM locations WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
      return !row || !row.is_active;
    },
  },
];

/**
 * The one action type these kinds share.
 *
 * It lives here rather than in the enum in intent-service, so that nothing else
 * in the pipeline has to spell it: every file that needs to recognise this
 * action compares against this constant.
 */
const ACTION_TYPE = 'archive_record';

const BY_KIND = new Map(KINDS.map((k) => [k.kind, k]));

function kinds() { return KINDS.map((k) => k.kind); }

/**
 * How a sentence names one of these kinds — the nouns, plus each kind's own
 * turns of phrase. Deterministic routing uses it, so the vocabulary that says
 * "this is about a supplier" lives with the supplier rather than in a regex
 * somebody else has to remember to update.
 */
function nounPattern() {
  return KINDS.flatMap((k) => [k.label, k.plural, ...(k.hints || [])]).join('|');
}

/** "a supplier, a customer or a location" — for prompts and questions. */
function labelList(article = 'a ') {
  const labels = KINDS.map((k) => `${article}${k.label}`);
  if (labels.length < 2) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}
function get(kind) { return BY_KIND.get(String(kind || '').trim().toLowerCase()) || null; }

/**
 * The kind an intent line or a stored proposal is about, or null when neither
 * is a removal. Both shapes are accepted because permission is checked twice —
 * once on the line before a proposal exists, once on the proposal at approval.
 */
function kindOf(subject) {
  if (!subject || subject.actionType !== ACTION_TYPE) return null;
  return get((subject.settings && subject.settings.recordKind) || subject.recordKind);
}

/**
 * Look a record up and work out, now, which of the two things will happen to
 * it. Called when the proposal is built and again when it is re-checked at
 * approval, so the preview and the execution cannot disagree.
 */
function decide(db, workspaceId, kind, recordId) {
  const usage = kind.usage(db, workspaceId, recordId) || {};
  const used = Array.isArray(usage.used) ? usage.used : [];
  const open = Number(usage.openOrders || 0);
  let blocked = usage.blocked || null;
  /*
   * An order that has not finished is the one thing that stops a record being
   * retired at all: hiding the other side of a live order is how a business
   * ends up with a delivery it cannot book in. Both services refuse it anyway;
   * saying it here means the person is told before they approve, not after.
   */
  if (!blocked && !usage.deletable && open) {
    blocked = `${open} order${open === 1 ? '' : 's'} against it ${open === 1 ? 'is' : 'are'} still open. `
      + 'Finish or cancel those first.';
  }
  return {
    deletable: Boolean(usage.deletable),
    blocked,
    used,
    // "1 linked products" is the sort of thing that makes a person distrust
    // everything else on the page, so a count of one takes the singular.
    heldBy: used.map((u) => `${u.count} ${u.count === 1 && u.label.endsWith('s') ? u.label.slice(0, -1) : u.label}`)
      .join(', ') || null,
  };
}

/** The sentence under the preview: what will happen, and why that one. */
function describe(kind, name, decision) {
  if (decision.blocked) return `${name} cannot be archived yet — ${decision.blocked}`;
  if (decision.deletable) {
    return `Nothing refers to ${name}, so the ${kind.label} record will be deleted outright.`;
  }
  const count = (decision.used || []).reduce((sum, u) => sum + Number(u.count || 0), 0);
  const because = decision.heldBy ? ` It is named on ${decision.heldBy}` : ' Other records refer to it';
  return `${name} will be archived — hidden everywhere it is picked from, and kept.${because}, `
    + `so deleting it would leave ${count === 1 ? 'that record' : 'those records'} pointing at nobody.`;
}

/**
 * The paragraph the reader is given about this action.
 *
 * Generated, so a kind added to KINDS is a kind the model is told about. A
 * hand-written list here would drift the first time somebody added one.
 */
function promptSection() {
  const lines = KINDS.map((k) => `  · ${k.kind} — ${k.says.map((s) => `"${s}"`).join(', ')}`);
  return [
    `- ${ACTION_TYPE}: retire ${labelList()} that is no longer used.`,
    '  Put which sort of record it is in recordKind. Put ONLY its name in',
    '  recordName — the words that name it and nothing else: "ABC Apparel",',
    '  "Downtown Store". Not the verb, not the word supplier/customer/location,',
    '  not the rest of the sentence, and never a word repeated. If they gave no',
    '  name, leave it empty; Foundry will ask. Use this for remove, delete,',
    '  archive, deactivate, "get rid of" and "we do not use them any more".',
    ...lines,
    '  This never touches stock counts. Foundry works out on its own whether the',
    '  record can be deleted outright or has to be kept and hidden, and refuses',
    '  safely when something is still open against it.',
  ].join('\n');
}

module.exports = { ACTION_TYPE, KINDS, kinds, labelList, nounPattern, get, kindOf, decide, describe, promptSection, matchByName };

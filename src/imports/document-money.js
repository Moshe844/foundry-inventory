'use strict';

/**
 * The money on a spreadsheet that is not the goods.
 *
 * A supplier invoice arrived as an .xlsx: twelve products, 250 pairs of shoes,
 * $10,384.50 of merchandise — and then $287.50 shipping, $70.00 handling,
 * $30.00 insurance, $105.00 import duty, a $125.00 fuel surcharge, an $85.00
 * warehouse fee and $0.00 tax, totalling $11,087.00 at the bottom of the sheet.
 *
 * StockChief imported the shoes and none of the money. The charge columns were
 * read as "supplier cost or calculated pricing" and dropped, and the footer
 * became eight products called things like "INVOICE TOTAL". The Money page
 * showed an empty Expenses section beside an invoice that reconciles to the
 * cent.
 *
 * Charges live in two places on the same sheet and both are read here:
 *
 *   - a column charged per line, which is summed down the product rows
 *   - a row under the products, which names a charge and gives one figure
 *
 * Nothing is allocated, spread or converted. Each charge keeps the supplier's
 * own wording and its own amount, exactly as the PDF path keeps them, because
 * freight divided by 800 is a unit cost nobody agreed to.
 */

const fields = require('./fields');

const NUMERIC = /^-?[\d,]+(?:\.\d+)?$/;

/** "1,234.50" → 123450. Anything that is not a plain amount → null. */
function toMinor(raw) {
  const text = String(raw ?? '').replace(/[$£€\s]/g, '').trim();
  if (!text || !NUMERIC.test(text)) return null;
  const value = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** Columns whose heading names a charge rather than a product fact. */
function chargeColumns(sheet, mappings) {
  const claimed = new Set(Object.values(mappings || {}));
  return (sheet.columns || [])
    .filter((column) => !claimed.has(column.index))
    .map((column) => ({ ...column, kind: fields.chargeKindFor(column.name) }))
    .filter((column) => column.kind);
}

/**
 * What a whole sheet says about money.
 *
 * `productRows` are the rows that became stock; `trailerRows` are the ones
 * below the last line item, which is where an invoice keeps its totals. Both
 * come from the validator, so this never has to decide again where the data
 * ended.
 */
function read(sheet, mappings, { productRows = [], trailerRows = [] } = {}) {
  const charges = [];

  /*
   * Charged per line. Summed down the products only: the same figures appear
   * again in the footer as a total, and counting both would double every fee
   * on the invoice.
   */
  for (const column of chargeColumns(sheet, mappings)) {
    let total = 0;
    let seen = 0;
    for (const row of productRows) {
      const amount = toMinor((row.cells || [])[column.index]);
      if (amount === null) continue;
      total += amount;
      seen += 1;
    }
    if (seen && total !== 0) {
      charges.push({ label: column.name, kind: column.kind, amountMinor: total, from: 'column' });
    }
  }

  /*
   * Charged on their own row, under the products. The label and the amount can
   * sit in any column — a real invoice put "Fuel Surcharge" in one column and
   * 125 four columns further along — so the row is read as: the words that
   * name a charge, and the last number on the line.
   */
  const alreadyCharged = new Set(charges.map((charge) => charge.label.toLowerCase()));
  for (const row of trailerRows) {
    const cells = (row.cells || []).map((cell) => String(cell ?? '').trim());
    /*
     * A label, not a sentence.
     *
     * The same footer carries prose — "Assorted sizes by style. Shipping and
     * ancillary fees allocated per size line." — and taking the first cell
     * that mentions shipping made a $30 freight charge out of a note, while
     * the row's real label two cells along ("Insurance") went unseen. Missing
     * the real label also defeated the duplicate check, so the invoice added
     * up to $135 more than it says it does.
     */
    let label = null;
    let kind = null;
    for (const cell of cells) {
      if (cell.length > 40 || cell.split(/\s+/).length > 5) continue;
      const guess = fields.chargeKindFor(cell);
      if (guess) { label = cell; kind = guess; break; }
    }
    if (!label) continue;
    if (alreadyCharged.has(label.toLowerCase())) continue;   // the column already carried it

    let amountMinor = null;
    for (const cell of cells) {
      const amount = toMinor(cell);
      if (amount !== null) amountMinor = amount;
    }
    if (amountMinor === null || amountMinor === 0) continue;
    charges.push({ label, kind, amountMinor, from: 'row' });
    alreadyCharged.add(label.toLowerCase());
  }

  /*
   * What the goods came to, from the cost the file recorded for each line.
   * Not read off a "total" column: that column is the supplier's arithmetic,
   * and StockChief values stock from the rows it actually created.
   */
  let goodsMinor = 0;
  if (mappings && mappings.unitCost !== undefined) {
    for (const row of productRows) {
      const unit = toMinor((row.cells || [])[mappings.unitCost]);
      const quantity = Number(String((row.cells || [])[mappings.quantity] ?? '').replace(/,/g, ''));
      if (unit === null || !Number.isFinite(quantity)) continue;
      goodsMinor += Math.round(unit * quantity);
    }
  }

  /*
   * The total the document states about itself, when it states one. Kept so
   * the page can show the supplier's own figure beside StockChief's arithmetic —
   * a difference there means something was read wrong, and saying so is worth
   * more than quietly agreeing with itself.
   */
  let documentTotalMinor = null;
  for (const row of trailerRows) {
    const cells = (row.cells || []).map((cell) => String(cell ?? '').trim());
    const saysTotal = cells.some((cell) => /\b(?:invoice|grand|order)\s*total\b/i.test(cell)
      || /^total\s*(?:due|amount)?$/i.test(cell));
    if (!saysTotal) continue;
    for (const cell of cells) {
      const amount = toMinor(cell);
      if (amount !== null) documentTotalMinor = amount;
    }
  }

  return { goodsMinor, charges, documentTotalMinor };
}

module.exports = { read, chargeColumns, toMinor };

/**
 * The money on a plan that has already been stored.
 *
 * Rebuilt from what StockChief kept — the plan's own headings and each row's own
 * cells — so this reads the file exactly as it was, long after the upload.
 */
function fromPlan(db, planId) {
  const plan = db.prepare(`SELECT id, workspace_id, source_name, source_columns, field_mappings
    FROM import_plans WHERE id = ?`).get(planId);
  if (!plan) return null;

  let columns;
  try {
    columns = JSON.parse(plan.source_columns || '[]').map((column, index) => ({
      index: Number(column.index ?? index), name: column.name,
    }));
  } catch { return null; }
  if (!columns.length) return null;

  let mappings = {};
  try { mappings = JSON.parse(plan.field_mappings || '{}'); } catch { /* charges only */ }

  const rows = db.prepare(`SELECT row_number, raw, status FROM import_rows
    WHERE import_id = ? ORDER BY row_number`).all(plan.id)
    .map((row) => {
      try {
        return { sourceRow: row.row_number, status: row.status, cells: JSON.parse(row.raw || '[]') };
      } catch { return null; }
    })
    .filter(Boolean);

  /*
   * Where the products stop and the invoice's own totals begin.
   *
   * Normally the validator has already marked them, and that marking is used.
   * A file imported before StockChief could tell the difference has its footer
   * stored as products, so the shape of the sheet is read again rather than
   * trusting a status written before the rule existed — otherwise the very
   * imports that need repairing are the ones that get none.
   */
  let productRows = rows.filter((row) => row.status !== 'EXCLUDED');
  let trailerRows = rows.filter((row) => row.status === 'EXCLUDED');
  if (!trailerRows.length) {
    const at = require('./row-validator').trailerStartsAt({ rows }, mappings);
    if (at >= 0) {
      productRows = rows.slice(0, at);
      trailerRows = rows.slice(at);
    }
  }

  return { plan, ...read({ columns }, mappings, { productRows, trailerRows }) };
}

/**
 * Keep what a file charged, beside what a PDF charges.
 *
 * The charges are recorded and deliberately not posted: freight on goods
 * coming in can honestly be part of what the stock cost or an expense of its
 * own, and that is the owner's decision. Until they make it, the money is on
 * the Money page marked as not being in the books — which is a truthful state,
 * unlike an empty Expenses section next to an invoice full of fees.
 */
function recordForPlan(db, planId) {
  const found = fromPlan(db, planId);
  if (!found || !found.charges.length) return { charges: 0 };
  const documentCosts = require('../accounting/document-costs');

  /*
   * What the goods came to, when the plan's own mapping cannot say.
   *
   * A file imported before StockChief read cost columns has no unit cost in its
   * mapping, so the arithmetic above makes the goods nothing — and the page
   * would then report the document as disagreeing with itself by the entire
   * value of the stock. The stock was valued from that same file, so its
   * costed total is the honest figure to show beside the charges.
   */
  let goodsMinor = found.goodsMinor;
  if (!goodsMinor) {
    goodsMinor = Number(db.prepare(`SELECT COALESCE(SUM(icm.cost_delta_minor), 0) AS total
      FROM accounting_inventory_cost_movements icm
      JOIN import_rows r ON r.id = icm.cost_source_record_id
      WHERE icm.workspace_id = ? AND icm.cost_source_type = 'import' AND r.import_id = ?`)
      .get(found.plan.workspace_id, found.plan.id).total);
  }
  const kept = documentCosts.record(db, { workspaceId: found.plan.workspace_id }, {
    importPlanId: found.plan.id,
    documentNumber: found.plan.source_name,
    charges: found.charges,
    goodsMinor,
    documentTotalMinor: found.documentTotalMinor,
    // The stock this file created was posted against opening balance equity,
    // so its freight has somewhere to go when the owner decides what it is.
    openedBooks: true,
  });
  return { charges: kept.length };
}

module.exports.fromPlan = fromPlan;
module.exports.recordForPlan = recordForPlan;

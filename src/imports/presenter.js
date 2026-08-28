'use strict';

/**
 * What the person sees before, during and after an import.
 *
 * Every figure on these screens is read from the stored plan, the stored rows
 * or the verification — never recomputed from a model's description of the
 * file. The preview and the import are looking at the same rows.
 */

const fields = require('./fields');

const TYPE_LABEL = {
  catalog: 'a product list',
  inventory: 'products with stock counts',
  variant_inventory: 'products with sizes or colours and stock counts',
  serials: 'individually numbered units',
  lots: 'batches or lots',
  receiving: 'a delivery or packing list',
  unknown: 'something Foundry could not identify',
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

/** The mapping, as a table a person can check column by column. */
function mappingRows(plan) {
  const byIndex = new Map();
  for (const [field, index] of Object.entries(plan.fieldMappings || {})) byIndex.set(index, field);

  const applied = new Set((plan.transformations.aiApplied || []).map((entry) => entry.column));
  return (plan.sourceColumns || []).map((column) => {
    const field = byIndex.get(column.index);
    const ignored = (plan.transformations.ignoredColumns || []).find((c) => c.index === column.index);
    return {
      column: column.name,
      index: column.index,
      field: field || null,
      label: field ? fields.FIELD_LABEL[field] : null,
      axis: field && plan.transformations.axisNames ? plan.transformations.axisNames[field] : null,
      ignoredBecause: ignored ? ignored.because : null,
      byAi: applied.has(column.name),
    };
  });
}

/** One sentence saying what this file is and what will happen to it. */
function summary(plan) {
  if ((plan.transformations || {}).operationScope === 'selling_price_update') {
    const blocked = plan.recordsInvalid
      ? ` ${plural(plan.recordsInvalid, 'row')} cannot be matched safely and will not run.`
      : '';
    return `Foundry read ${plan.sourceName} as a selling-price update with ${plural(plan.recordsDetected, 'row')}.${blocked}`;
  }
  const parts = [
    `Foundry read ${plan.sourceName} as ${TYPE_LABEL[plan.detectedType] || 'data'}`,
    `${plural(plan.recordsDetected, 'row')} found`,
  ];
  if (plan.recordsInvalid) parts.push(`${plan.recordsInvalid} of them cannot be imported as they stand`);
  return `${parts.join(', ')}.`;
}

/**
 * The preview: what would exist afterwards, counted from the stored rows.
 *
 * Products are counted by distinct identity rather than by row, because a file
 * with eleven rows for eleven sizes creates one product, and saying "11 products
 * will be created" would be wrong in the way that matters most.
 */
function preview(db, workspaceId, plan, rows) {
  const usable = rows.filter((row) => ['VALID', 'NEEDS_REVIEW'].includes(row.status));
  const priceUpdate = (plan.transformations || {}).operationScope === 'selling_price_update';

  const newProducts = new Map();
  const existingProducts = new Map();
  const locations = new Map();
  let units = 0;

  for (const row of usable) {
    const parsed = row.parsed || {};
    const key = (parsed.code || parsed.name || '').toLowerCase();
    if (parsed.existingItemId) existingProducts.set(parsed.existingItemId, parsed.name || parsed.code);
    else if (key) {
      if (!newProducts.has(key)) newProducts.set(key, { name: parsed.name || parsed.code, variants: 0, units: 0 });
      const entry = newProducts.get(key);
      if (parsed.variants && parsed.variants.length) entry.variants += 1;
      entry.units += parsed.quantity || 0;
    }
    units += parsed.quantity || 0;
    if (parsed.locationName) {
      locations.set(parsed.locationName, (locations.get(parsed.locationName) || 0) + (parsed.quantity || 0));
    }
  }

  const skus = [...newProducts.values()].reduce(
    (total, entry) => total + Math.max(entry.variants, 1),
    0
  );

  return {
    newProducts: newProducts.size,
    newSkus: skus,
    existingProducts: existingProducts.size,
    units,
    locations: [...locations.entries()].map(([name, quantity]) => ({ name, quantity })),
    willImport: usable.length,
    willSkip: rows.filter((row) => row.status === 'INVALID').length,
    excluded: rows.filter((row) => row.status === 'EXCLUDED').length,
    sentence: priceUpdate
      ? `This will update selling prices for ${plural(usable.length, 'existing variant')}. It will create no products and change no stock quantities.`
      : previewSentence({ products: newProducts.size, skus, existing: existingProducts.size, units, locations: locations.size }),
  };
}

function previewSentence({ products, skus, existing, units, locations }) {
  const clauses = [];
  if (products) {
    clauses.push(
      skus > products
        ? `create ${plural(products, 'product')} (${plural(skus, 'version')})`
        : `create ${plural(products, 'product')}`
    );
  }
  if (existing) clauses.push(`add stock to ${plural(existing, 'product')} you already have`);
  if (units) {
    clauses.push(
      `establish ${units.toLocaleString('en-GB')} units${locations ? ` across ${plural(locations, 'location')}` : ''}`
    );
  }
  if (!clauses.length) return 'This would create nothing.';
  return `This will ${clauses.join(', ')}.`;
}

/** The report afterwards, from the execution and the verification. */
function report(plan, run, verification) {
  const result = run.result || {};
  if ((plan.transformations || {}).operationScope === 'selling_price_update') {
    return {
      headline: result.rowsImported
        ? `${plural(result.rowsImported, 'selling price')} updated. No products or stock quantities were changed.`
        : 'No selling prices were updated.',
      verified: verification ? verification.verified : false,
      checks: verification ? verification.checks : [],
      problems: verification ? verification.problems : [],
      status: run.status,
      partial: run.status === 'PARTIAL',
      cancelled: run.status === 'CANCELLED',
    };
  }
  const clauses = [];
  if (result.itemsCreated) {
    clauses.push(
      result.skusCreated > result.itemsCreated
        ? `${plural(result.itemsCreated, 'product')} created (${plural(result.skusCreated, 'version')})`
        : `${plural(result.itemsCreated, 'product')} created`
    );
  }
  if (result.unitsEstablished) {
    clauses.push(`${result.unitsEstablished.toLocaleString('en-GB')} units established`);
  }
  if (result.lotsCreated) clauses.push(`${plural(result.lotsCreated, 'lot')} opened`);
  if (result.serialsCreated) clauses.push(`${plural(result.serialsCreated, 'unit')} numbered`);
  if (result.rowsFailed) clauses.push(`${plural(result.rowsFailed, 'row')} failed`);
  if (result.rowsSkipped) clauses.push(`${plural(result.rowsSkipped, 'row')} skipped`);

  return {
    headline: clauses.length ? `${clauses.join(', ')}.` : 'Nothing was imported.',
    verified: verification ? verification.verified : false,
    checks: verification ? verification.checks : [],
    problems: verification ? verification.problems : [],
    status: run.status,
    partial: run.status === 'PARTIAL',
    cancelled: run.status === 'CANCELLED',
  };
}

/** Groups the row problems so a person reads "17 rows: no location" once. */
function problemSummary(rows) {
  const groups = new Map();
  for (const row of rows) {
    for (const problem of row.problems || []) {
      if (!groups.has(problem.code)) groups.set(problem.code, { code: problem.code, count: 0, example: problem.message, rows: [] });
      const group = groups.get(problem.code);
      group.count += 1;
      if (group.rows.length < 5) group.rows.push(row.rowNumber);
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

module.exports = { TYPE_LABEL, mappingRows, summary, preview, previewSentence, report, problemSummary, plural };

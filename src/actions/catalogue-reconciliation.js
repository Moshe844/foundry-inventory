'use strict';

/**
 * Reconcile model-read catalogue lines with exact SKU evidence in the owner's
 * instruction. The language reader emits one create_item line per record so it
 * cannot lose a row. This layer decides which of those rows belong to one
 * product without guessing from fuzzy names or product categories.
 */

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function identity(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** One exact value per axis. Commas are data here, not list separators. */
function exactOptions(variantAxes) {
  const options = {};
  for (const chunk of String(variantAxes || '').split('|')) {
    const split = chunk.indexOf(':');
    if (split < 1) continue;
    const name = chunk.slice(0, split).trim();
    const value = chunk.slice(split + 1).trim();
    if (name && value) options[name] = value;
  }
  return options;
}

function instructionLabelsCode(instruction, code) {
  if (!code) return false;
  return new RegExp(`\\bSKU\\s*(?::|#|number\\s*:?)\\s*${escapeRegExp(code)}(?=$|[^A-Za-z0-9._/-])`, 'i')
    .test(String(instruction || ''));
}

function variantFrom(line, grouped) {
  const options = exactOptions(line.variantAxes);
  const values = Object.values(options);
  const variant = {
    code: String(line.productCode || '').trim(),
    label: values.join(' / ') || (grouped ? String(line.productCode || '').trim() : null),
    options,
    sourceKey: String(line.productCode || '').trim(),
  };
  if (line.catalogueRecord) variant.catalogueRecord = line.catalogueRecord;
  return variant;
}

/**
 * Group only exact product-name matches with distinct, explicitly labelled
 * SKU codes. Similar names are deliberately not merged. A single labelled SKU
 * is also made exact, so its attributes can never expand into invented SKUs.
 */
function reconcile(lines, instruction) {
  const source = Array.isArray(lines) ? lines : [];
  const buckets = new Map();
  source.forEach((line, index) => {
    if (!line || line.actionType !== 'create_item') return;
    const key = identity(line.productName || line.item);
    const code = String(line.productCode || '').trim();
    if (!key || !code || !instructionLabelsCode(instruction, code)) return;
    const groupKey = `${key}\u0000${identity(line.unitLabel || 'unit')}\u0000${line.trackingMode || ''}`;
    if (!buckets.has(groupKey)) buckets.set(groupKey, []);
    buckets.get(groupKey).push({ line, index, codeKey: code.toLowerCase() });
  });

  const replacements = new Map();
  const consumed = new Set();
  for (const rows of buckets.values()) {
    const uniqueCodes = new Set(rows.map((row) => row.codeKey));
    // Repeated source codes are contradictory evidence, not permission to
    // merge or silently rename anything.
    if (uniqueCodes.size !== rows.length) continue;
    const grouped = rows.length > 1;
    const first = rows[0];
    replacements.set(first.index, {
      ...first.line,
      productCode: '',
      variantAxes: '',
      exactVariants: rows.map((row) => variantFrom(row.line, grouped)),
      sourceText: rows.map((row) => row.line.sourceText).filter(Boolean).join('\n'),
    });
    rows.slice(1).forEach((row) => consumed.add(row.index));
  }

  return source.flatMap((line, index) => {
    if (consumed.has(index)) return [];
    return [replacements.get(index) || line];
  });
}

module.exports = { reconcile, identity, exactOptions, instructionLabelsCode };

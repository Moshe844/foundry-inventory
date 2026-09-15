'use strict';

/**
 * Transcribe an explicitly structured catalogue before the model reads it.
 *
 * This is intentionally a grammar reader, not the understanding layer:
 * numbered record headings and literal `label: value` rows are copied.  Labels
 * with an operational role are separated from arbitrary variant attributes,
 * while the original ordered fields remain attached as evidence.  Nothing is
 * filled in when it was not supplied.
 */

const YES = /^(?:yes|true|required|enabled|on)$/i;

function key(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\s_/-]+/g, ' ').replace(/[^a-z0-9 #]+/g, '').trim();
}

function money(value) {
  const match = /^\s*[$£€¥]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*$/.exec(String(value || ''));
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function quantity(value) {
  const match = /^\s*([0-9][0-9,]*)\s*(?:[a-z][a-z -]*)?\s*$/i.exec(String(value || ''));
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ''));
  return Number.isSafeInteger(amount) ? amount : null;
}

function isLocationLabel(label) {
  return /\b(?:warehouse|store|shop|counter|stockroom|depot|location|site|branch|showroom|fulfilment|fulfillment|distribution cent(?:er|re))\b/i
    .test(String(label || ''));
}

function splitSerials(value) {
  return String(value || '').split(/[;,\n]+/).map((entry) => entry.trim()).filter(Boolean);
}

function parseComponents(value) {
  return String(value || '').split(/\s*,\s*|\s+and\s+/i).map((part) => part.trim()).filter(Boolean)
    .map((part) => {
      const clean = part.replace(/^(?:and|&)\s+/i, '').replace(/[.;]+$/, '').trim();
      const match = /^(\d+)\s*(?:x|\u00d7|of)?\s+(.+?)\s*$/.exec(clean);
      if (!match) return { quantity: null, identity: clean, exactSku: '' };
      const identity = match[2].trim();
      const explicit = /^sku\s*[:#]?\s*([a-z0-9][a-z0-9._/-]*)(?:\s+[—–-]\s+.+)?$/i.exec(identity);
      const bare = /^([a-z0-9][a-z0-9._/-]*[-_][a-z0-9._/-]+)$/i.exec(identity);
      const labelled = explicit || bare;
      return { quantity: Number(match[1]), identity, exactSku: labelled ? labelled[1] : '' };
    });
}

function identityTokens(value) {
  return key(value).split(/\s+/).filter(Boolean).map((token) => {
    if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
    if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
    return token;
  });
}

function componentMatchesRecord(componentIdentity, recordName) {
  const component = identityTokens(componentIdentity);
  const product = identityTokens(recordName);
  if (!component.length || !product.length) return false;
  if (component.join(' ') === product.join(' ')) return true;
  // A multi-word component description may omit a product modifier (for
  // example "inspection light" vs "cordless inspection light"). Accept the
  // evidence only when every component word appears in the product name; the
  // caller still requires exactly one matching SKU before using it.
  return component.length >= 2 && component.every((token) => product.includes(token));
}

/**
 * Link a component description to a supplied SKU only when the catalogue
 * itself proves one unique match. Names and categories are never enumerated
 * here; ambiguous and absent products remain questions for the owner.
 */
function reconcileComponentSkus(records) {
  const updated = JSON.parse(JSON.stringify(records || []));
  for (const kit of [...updated]) {
    for (const component of kit.components || []) {
      if (component.exactSku) continue;
      const matches = updated.filter((candidate) => candidate.ordinal !== kit.ordinal
        && candidate.code && componentMatchesRecord(component.identity, candidate.name));
      if (matches.length === 1) component.exactSku = matches[0].code;
    }
  }
  return updated;
}

function roleFor(label) {
  const normal = key(label);
  if (/^(?:sku|sku #|sku number|product code|item code)$/.test(normal)) return 'sku';
  if (/^(?:category|product category)$/.test(normal)) return 'category';
  if (/^(?:unit|unit label|stock unit|inventory unit)$/.test(normal)) return 'unit';
  if (/^(?:vendor|supplier)$/.test(normal)) return 'supplier';
  if (/^(?:vendor|supplier) (?:part|item|product|sku)(?: #| number)?$/.test(normal)) return 'supplierPart';
  if (/^(?:unit cost|purchase cost|buying cost|cost)$/.test(normal)) return 'unitCost';
  if (/^(?:selling price|sale price|retail price|price)$/.test(normal)) return 'sellingPrice';
  if (/^(?:reorder point|reorder level|minimum stock)$/.test(normal)) return 'reorderPoint';
  if (/^(?:lot|batch) tracking$/.test(normal)) return 'lotTracking';
  if (/^serial(?: number)? tracking$/.test(normal)) return 'serialTracking';
  if (/^(?:current )?(?:lot|batch)(?: code| number| #)?$/.test(normal)) return 'lotCode';
  if (/^(?:expiration|expiry)(?: date)?$/.test(normal)) return 'expirationDate';
  if (/^serial(?: number)?s?$/.test(normal)) return 'serials';
  if (/^(?:components?|bill of materials|bom)(?: per kit)?$/.test(normal)) return 'components';
  return null;
}

function parseRecord(name, body, ordinal) {
  const fields = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 1) return null;
    const label = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!label || !value) return null;
    fields.push({ label, value });
  }
  if (!fields.length) return null;

  const record = {
    ordinal, name: name.trim(), fields, code: '', category: '', unitLabel: '',
    supplier: '', supplierPart: '', unitCostMinor: null, sellingPriceMinor: null,
    reorderPoint: null, trackingMode: '', lotCode: '', expirationDate: '',
    serials: [], serialsByLocation: {}, components: [], locations: [], attributes: {},
  };
  for (const field of fields) {
    const role = roleFor(field.label);
    const locatedSerials = /^(.*?)\s+(?:serial numbers?|serials)$/i.exec(field.label);
    if (role === 'sku') record.code = field.value;
    else if (role === 'category') record.category = field.value;
    else if (role === 'unit') record.unitLabel = field.value;
    else if (role === 'supplier') record.supplier = field.value;
    else if (role === 'supplierPart') record.supplierPart = field.value;
    else if (role === 'unitCost') record.unitCostMinor = money(field.value);
    else if (role === 'sellingPrice') record.sellingPriceMinor = money(field.value);
    else if (role === 'reorderPoint') record.reorderPoint = quantity(field.value);
    else if (role === 'lotTracking' && YES.test(field.value)) record.trackingMode = 'lot';
    else if (role === 'serialTracking' && YES.test(field.value)) record.trackingMode = 'serial';
    else if (role === 'lotCode') record.lotCode = field.value;
    else if (role === 'expirationDate') record.expirationDate = field.value;
    else if (role === 'serials') record.serials = splitSerials(field.value);
    else if (role === 'components') record.components = parseComponents(field.value);
    else if (locatedSerials && isLocationLabel(locatedSerials[1])) {
      record.serialsByLocation[locatedSerials[1].trim()] = splitSerials(field.value);
    }
    else if (isLocationLabel(field.label) && quantity(field.value) !== null) {
      record.locations.push({ name: field.label, quantity: quantity(field.value) });
    } else {
      // An unknown literal field is retained as a product/SKU attribute.  This
      // is how arbitrary dimensions survive without teaching this reader a
      // list of industries or product names.
      record.attributes[field.label] = field.value;
    }
  }
  return record.code ? record : null;
}

function issueList(records) {
  const missingSerials = records.filter((record) => {
    if (record.trackingMode !== 'serial') return false;
    if (record.locations.length === 1 && record.serials.length === record.locations[0].quantity) return false;
    return record.locations.some((location) => {
      const found = Object.entries(record.serialsByLocation || {})
        .find(([name]) => key(name) === key(location.name));
      return !found || found[1].length !== location.quantity;
    });
  });
  const unresolvedKits = records.filter((record) => record.components.length
    && record.components.some((component) => !component.quantity || !component.exactSku));
  const stockedKits = records.filter((record) => record.components.length && record.locations.some((location) => location.quantity > 0));
  return [
    ...missingSerials.map((record) => ({
      type: 'serials', recordOrdinal: record.ordinal, recordName: record.name, code: record.code,
      title: `${record.name} needs its serial identities`,
      detail: `${record.locations.reduce((sum, location) => sum + location.quantity, 0)} units were supplied as location totals, but serial-tracked stock needs one exact serial number per unit.`,
      fix: 'Add one “<Location> Serials:” line for every location, with the exact comma-separated serial numbers, or change Serial Number Tracking to No.',
    })),
    ...unresolvedKits.map((record) => ({
      type: 'kit_components', recordOrdinal: record.ordinal, recordName: record.name, code: record.code,
      title: `${record.name} needs exact component SKUs`,
      detail: 'Component names alone may match the wrong product or a product that is not in this inventory.',
      fix: 'Write each component as quantity × exact SKU, and include a product record for any component SKU that does not exist yet.',
    })),
    ...stockedKits.map((record) => ({
      type: 'kit_stock', recordOrdinal: record.ordinal, recordName: record.name, code: record.code,
      title: `${record.name} has two possible stock meanings`,
      detail: 'A component-based kit normally calculates availability from its components, while the supplied location totals describe independently stocked, preassembled kits.',
      fix: 'Remove the kit location totals for component-derived availability, or explicitly say these are preassembled physical kits.',
    })),
  ];
}

function blockers(records, issues = issueList(records)) {
  if (!issues.length) return '';

  const parts = [`Foundry read all ${records.length} structured product record${records.length === 1 ? '' : 's'} immediately, but cannot prepare a complete all-or-nothing preview yet.`];
  const missingSerials = issues.filter((issue) => issue.type === 'serials');
  const unresolvedKits = issues.filter((issue) => issue.type === 'kit_components');
  const stockedKits = issues.filter((issue) => issue.type === 'kit_stock');
  if (missingSerials.length) {
    parts.push(`Provide the exact serial numbers for ${missingSerials.map((issue) => issue.recordName).join(', ')} at each stated location (for example, “Main Warehouse Serials: …”); aggregate counts cannot create serial-tracked units.`);
  }
  if (unresolvedKits.length) {
    parts.push(`For ${unresolvedKits.map((issue) => issue.recordName).join(', ')}, identify every component by exact SKU and quantity (for example, “2 × SKU-123”).`);
  }
  if (stockedKits.length) {
    parts.push(`Also clarify whether the stated counts for ${stockedKits.map((issue) => issue.recordName).join(', ')} are preassembled physical kits; component-derived kit availability is not an independent stock count.`);
  }
  parts.push('Nothing was created and none of the supplied fields were discarded.');
  return parts.join(' ');
}

function replaceRoleField(record, role, label, value) {
  const index = record.fields.findIndex((field) => roleFor(field.label) === role);
  if (index >= 0) record.fields[index] = { label: record.fields[index].label, value };
  else record.fields.push({ label, value });
}

function replaceLiteralField(record, label, value) {
  const wanted = key(label);
  const index = record.fields.findIndex((field) => key(field.label) === wanted);
  if (index >= 0) record.fields[index] = { label: record.fields[index].label, value };
  else record.fields.push({ label, value });
}

function serialize(records) {
  return records.map((record) => [
    `${record.ordinal}. ${record.name}`,
    ...record.fields.map((field) => `${field.label}: ${field.value}`),
  ].join('\n')).join('\n\n');
}

/** Apply only answers entered on the dedicated missing-details screen. */
function resolveIssues(records, issues, answers = {}, options = {}) {
  const updated = JSON.parse(JSON.stringify(records || []));
  const errors = [];
  const recordFor = (issue) => updated.find((record) => record.ordinal === Number(issue.recordOrdinal || issue.ordinal)
    || (record.code && record.code === issue.code));

  for (const issue of issues || []) {
    const record = recordFor(issue);
    if (!record) {
      errors.push('A product needing details could not be matched back to its source record.');
      continue;
    }
    if (issue.type === 'serials') {
      const mode = String(answers[`serial_mode_${record.ordinal}`] || '').trim();
      if (!['serial', 'quantity'].includes(mode)) {
        errors.push(`Choose how ${record.name} should be tracked.`);
        continue;
      }
      if (mode === 'quantity') {
        replaceRoleField(record, 'serialTracking', 'Serial Number Tracking', 'No');
        continue;
      }
      const all = [];
      for (let index = 0; index < record.locations.length; index += 1) {
        const location = record.locations[index];
        const serials = splitSerials(answers[`serials_${record.ordinal}_${index}`]);
        if (serials.length !== location.quantity) {
          errors.push(`${record.name} needs exactly ${location.quantity} serial numbers for ${location.name}; ${serials.length} were entered.`);
          continue;
        }
        all.push(...serials);
        replaceLiteralField(record, `${location.name} Serials`, serials.join(', '));
      }
      if (new Set(all.map((serial) => serial.toLowerCase())).size !== all.length) {
        errors.push(`${record.name} contains a duplicate serial number.`);
      }
    }

    if (issue.type === 'kit_components') {
      const values = [];
      for (let index = 0; index < record.components.length; index += 1) {
        const component = record.components[index];
        const quantityValue = Number(answers[`component_qty_${record.ordinal}_${index}`]);
        const sku = String(answers[`component_sku_${record.ordinal}_${index}`] || '').trim();
        if (!Number.isSafeInteger(quantityValue) || quantityValue <= 0) {
          errors.push(`Enter the whole-number quantity of ${component.identity} required for one ${record.name}.`);
        }
        if (!sku) errors.push(`Enter the exact SKU for ${component.identity} in ${record.name}.`);
        if (Number.isSafeInteger(quantityValue) && quantityValue > 0 && sku) {
          component.quantity = quantityValue;
          component.exactSku = sku;
          values.push(`${quantityValue} × SKU: ${sku} — ${component.identity}`);
        }
      }
      if (values.length === record.components.length) {
        replaceRoleField(record, 'components', 'Components per kit', values.join(', '));
      }
    }

    if (issue.type === 'kit_stock') {
      const basis = String(answers[`kit_stock_${record.ordinal}`] || '').trim();
      if (!['preassembled', 'components'].includes(basis)) {
        errors.push(`Choose what the stated ${record.name} quantities mean.`);
        continue;
      }
      if (basis === 'components') {
        record.fields = record.fields.filter((field) => !(isLocationLabel(field.label) && quantity(field.value) !== null));
      }
      replaceLiteralField(record, 'Kit Stock Basis', basis === 'preassembled'
        ? 'Preassembled physical kits'
        : 'Calculated from component availability');
    }
  }

  // A component name came from the owner's catalogue and its SKU came from
  // the correction form. If that SKU does not already exist, carry those two
  // exact facts into a minimal, zero-stock product record for the final
  // preview. This lets the owner finish here without Foundry inventing a code,
  // price, quantity, category, or any other product fact.
  const availableCodes = new Set([
    ...updated.map((record) => record.code),
    ...(options.existingCodes || []),
  ].map((code) => String(code || '').toLowerCase()).filter(Boolean));
  let nextOrdinal = updated.reduce((highest, record) => Math.max(highest, Number(record.ordinal) || 0), 0) + 1;
  for (const kit of [...updated]) {
    for (const component of kit.components || []) {
      const componentCode = String(component.exactSku || '').trim();
      const normalizedCode = componentCode.toLowerCase();
      if (!normalizedCode || availableCodes.has(normalizedCode)) continue;
      const componentRecord = parseRecord(component.identity, `SKU: ${componentCode}`, nextOrdinal);
      if (!componentRecord) continue;
      updated.push(componentRecord);
      availableCodes.add(normalizedCode);
      nextOrdinal += 1;
    }
  }

  return errors.length ? { ok: false, errors, records: updated } : { ok: true, description: serialize(updated), records: updated };
}

function parse(instruction) {
  const source = String(instruction || '').replace(/^\s*(?:create|add)\s*:\s*/i, '');
  const heading = /^\s*(\d+)\.\s+(.+?)\s*$/gm;
  const matches = [...source.matchAll(heading)];
  if (!matches.length) return null;
  // Requiring the first meaningful line to be a numbered heading prevents an
  // ordinary sentence containing "1." from being mistaken for this grammar.
  if (source.slice(0, matches[0].index).trim()) return null;
  let records = matches.map((match, index) => parseRecord(
    match[2],
    source.slice(match.index + match[0].length, matches[index + 1] ? matches[index + 1].index : source.length),
    Number(match[1])
  ));
  if (records.some((record) => !record)) return null;
  if (records.some((record, index) => record.ordinal !== index + 1)) return null;

  records = reconcileComponentSkus(records);

  const issues = issueList(records);
  const blocked = blockers(records, issues);
  if (blocked) return { lines: [], clarifyingQuestion: blocked, unsupportedReason: '', structuredRecords: records, structuredIssues: issues };

  return {
    lines: records.map((record) => ({
      actionType: 'create_item', productName: record.name, productCode: record.code,
      unitLabel: record.unitLabel, trackingMode: record.trackingMode,
      variantAxes: Object.entries(record.attributes).map(([label, value]) => `${label}: ${value}`).join(' | '),
      sourceText: [`${record.ordinal}. ${record.name}`, ...record.fields.map((field) => `${field.label}: ${field.value}`)].join('\n'),
      catalogueRecord: record,
      quantity: -1, adjustmentTarget: -1,
    })),
    clarifyingQuestion: '', unsupportedReason: '', structuredRecords: records,
  };
}

module.exports = {
  parse, parseRecord, blockers, issueList, roleFor, isLocationLabel,
  resolveIssues, serialize, reconcileComponentSkus,
};

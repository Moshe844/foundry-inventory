'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const { createCanvas } = require('@napi-rs/canvas');
const { createWorker } = require('tesseract.js');
const englishOcr = require('@tesseract.js-data/eng');
const { createProviderForTier } = require('../ai/provider');
const { validate } = require('./validator');
const { toWireSchema } = require('./schema-tools');
const understandingService = require('./understanding-service');
const { UNDERSTANDING_SCHEMA } = require('./understanding-schema');
const itemService = require('../domain/item-service');
const locationService = require('../domain/location-service');
const repo = require('../domain/repository');
const supplierService = require('../purchasing/supplier-service');
const poService = require('../purchasing/po-service');
const receivingService = require('../purchasing/receiving-service');
const { inTransaction } = require('../db');
const { newId, nowIso, requireText } = require('../lib/util');
const { ValidationError } = require('../domain/errors');
const prices = require('../pricing/price-service');

const MAX_TEXT = 24000;
const SUPPORTED = ['.pdf', '.docx', '.xlsx', '.xls', '.csv', '.tsv', '.txt'];

const LINE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['styleName', 'color', 'variantDimension', 'size', 'supplierSku', 'description', 'quantity', 'unitCost'],
  properties: {
    styleName: { type: 'string' }, color: { type: 'string' }, variantDimension: { type: 'string' }, size: { type: 'string' },
    supplierSku: { type: 'string' }, description: { type: 'string' },
    quantity: { type: 'integer' }, unitCost: { type: 'number' }, sellingPrice: { type: 'number' },
  },
};

const DOCUMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['documentType', 'businessDescription', 'unitLabel', 'supplierName', 'supplierCodeLabel', 'supplierEmail', 'documentNumber',
    'documentDate', 'paymentTerms', 'currency', 'destinationName', 'destinationAddress', 'lines', 'warnings'],
  properties: {
    documentType: { type: 'string', enum: ['invoice', 'purchase_order', 'stock_report', 'catalogue', 'other'] },
    businessDescription: { type: 'string' }, unitLabel: { type: 'string' },
    supplierName: { type: 'string' }, supplierCodeLabel: { type: 'string' }, supplierEmail: { type: 'string' },
    documentNumber: { type: 'string' }, documentDate: { type: 'string' }, paymentTerms: { type: 'string' },
    currency: { type: 'string' }, destinationName: { type: 'string' }, destinationAddress: { type: 'string' },
    lines: { type: 'array', maxItems: 500, items: LINE_SCHEMA },
    warnings: { type: 'array', maxItems: 20, items: { type: 'string' } },
  },
};

const SYSTEM = `Read a business inventory source document into structured setup evidence.

Do not invent values. Use an empty string for missing text, -1 for missing unit cost, and 0 only when a line explicitly says zero quantity. Include only real inventory lines, never freight, tax, discounts, fees, totals, headings or notes.

styleName is the reusable inventory product without its line-level variant value. Put colour in color when it is explicit. variantDimension is the business name for the value in size: for example Size, Model, Grade, Length, or Pack. The size field holds that value; leave both strings empty when there is no variant. Preserve supplier SKU exactly. quantity is the inventory units on that exact line. unitCost is supplier purchase cost per inventory unit. sellingPrice is the customer retail/list price only when the source explicitly labels it as retail, selling, list, MSRP or RRP; otherwise use -1. Never copy invoice unit cost into sellingPrice.

unitLabel is the singular thing being counted, such as pair, bottle, machine, roll, or unit. Use the document's wording when it is present; otherwise use unit. Never assume an industry-specific unit from the file format.

businessDescription must describe only what this document genuinely establishes about the inventory model: what products are kept, whether size/colour variants exist, the named stock destination, the supplier relationship, and that this document is purchasing/receiving evidence. It must not claim other locations or workflows not shown.

supplierName is the seller's actual company or trading name. When a branded heading and a generic subtitle such as "Sample Footwear Supplier" both appear, use the branded heading; a generic descriptor is not the supplier's name.

supplierCodeLabel is the exact heading this document uses for the supplier's identifier for a product, such as "Style #", "Item No.", "Vendor SKU", or "Supplier Code". Use an empty string only when no such heading is present. Regardless of its wording, put the identifier value in supplierSku.

For an invoice or fulfilled supplier order, destinationName is the ship-to inventory location. For a stock report it is the row location only when one common location is explicit. Use a concise operational location name, preserving a real name from the document. Return ISO YYYY-MM-DD for an unambiguous date; otherwise empty.`;

function clean(value) { return String(value || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); }

async function renderPdfPage(page) {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const canvasContext = canvas.getContext('2d');
  await page.render({ canvasContext, viewport, canvas }).promise;
  return canvas.toBuffer('image/png');
}

async function createOcrWorker() {
  return createWorker(englishOcr.code, 1, {
    langPath: englishOcr.langPath,
    gzip: englishOcr.gzip,
    cacheMethod: 'readOnly',
  });
}

async function extractText(file) {
  const filename = requireText(file.filename, 'File name', { max: 240 });
  const ext = path.extname(filename).toLowerCase();
  if (!SUPPORTED.includes(ext)) {
    throw new ValidationError('Use a PDF, Word .docx file, Excel workbook, CSV, TSV, or text file.');
  }
  const buffer = file.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ValidationError('That document is empty.');

  let text = '';
  if (ext === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
    const pages = [];
    let worker = null;
    try {
      for (let number = 1; number <= document.numPages; number += 1) {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        let pageText = clean(content.items.map((item) => item.str).join(' '));
        // Image-only pages have no usable PDF text layer. Render and OCR only
        // those pages; ordinary PDFs stay fast and preserve their exact text.
        if (pageText.length < 20) {
          if (!worker) worker = await createOcrWorker();
          const recognised = await worker.recognize(await renderPdfPage(page));
          pageText = clean(recognised.data.text);
        }
        pages.push(pageText);
      }
    } finally {
      if (worker) await worker.terminate();
    }
    text = pages.join('\n\n');
  } else if (ext === '.docx') {
    text = (await mammoth.extractRawText({ buffer })).value;
  } else if (['.xlsx', '.xls'].includes(ext)) {
    const book = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    text = book.SheetNames.map((name) => {
      const rows = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: '' });
      return `Sheet: ${name}\n${rows.map((row) => row.join(' | ')).join('\n')}`;
    }).join('\n\n');
  } else text = buffer.toString('utf8');

  text = clean(text);
  if (text.length < 20) throw new ValidationError('Foundry could not find readable inventory text in that document. Try a clearer scan or a higher-resolution copy.');
  return text.slice(0, MAX_TEXT);
}

function normalise(raw) {
  const lines = (raw.lines || []).map((line) => ({
    styleName: clean(line.styleName).slice(0, 160), color: clean(line.color).slice(0, 80),
    variantDimension: clean(line.variantDimension).slice(0, 80), size: clean(line.size).slice(0, 80),
    supplierSku: clean(line.supplierSku).slice(0, 120),
    description: clean(line.description).slice(0, 240), quantity: Math.max(0, Math.trunc(Number(line.quantity) || 0)),
    unitCost: Number(line.unitCost) >= 0 ? Math.round(Number(line.unitCost) * 10000) / 10000 : null,
    sellingPrice: Number(line.sellingPrice) >= 0 ? Math.round(Number(line.sellingPrice) * 100) / 100 : null,
  })).filter((line) => line.styleName && line.quantity > 0);
  return {
    documentType: raw.documentType, businessDescription: clean(raw.businessDescription), unitLabel: clean(raw.unitLabel) || 'unit',
    supplierName: clean(raw.supplierName), supplierCodeLabel: clean(raw.supplierCodeLabel) || 'Supplier code',
    supplierEmail: clean(raw.supplierEmail),
    documentNumber: clean(raw.documentNumber), documentDate: clean(raw.documentDate),
    paymentTerms: clean(raw.paymentTerms), currency: clean(raw.currency) || 'USD',
    destinationName: clean(raw.destinationName) || 'Main Warehouse', destinationAddress: clean(raw.destinationAddress),
    lines, warnings: (raw.warnings || []).map(clean).filter(Boolean),
  };
}

async function interpret(text, options = {}) {
  const provider = options.provider || createProviderForTier('deep');
  const vocabulary = Array.isArray(options.supplierVocabulary) ? options.supplierVocabulary : [];
  const vocabularyPrompt = vocabulary.length
    ? `\n\nKnown supplier vocabulary for this inventory:\n${JSON.stringify(vocabulary)}\nWhen the source supplier matches one of these suppliers, recognize every listed item-code label as the same supplierSku field. Preserve the exact heading found on this source in supplierCodeLabel.`
    : '';
  const response = await provider.complete({
    system: SYSTEM, prompt: `Source document text:\n\n${text}${vocabularyPrompt}`, schema: DOCUMENT_SCHEMA,
    schemaName: 'inventory_setup_document',
  });
  const result = validate(toWireSchema(DOCUMENT_SCHEMA), response.data, { key: 'setup-document-wire' });
  if (!result.ok) throw new ValidationError('Foundry could not reliably read the inventory lines in that document.');
  const interpreted = normalise(result.data);
  if (!interpreted.businessDescription) throw new ValidationError('The document does not establish enough about the inventory to configure it safely.');
  if (!interpreted.lines.length) throw new ValidationError('Foundry found no inventory quantities to add in that document.');
  Object.defineProperty(interpreted, '_usage', { value: response.usage || null, enumerable: false });
  return interpreted;
}

function unique(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = String(value || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Once the reader has produced validated document evidence, no second model is
 * allowed to embellish it. This deliberately boring conversion is the safety
 * boundary that prevents an invoice for one warehouse from growing an inferred
 * sales floor, extra sizes, roles, or workflows in the configuration preview.
 */
function understandingFromDocument(interpretation, sourceName) {
  const variantDimension = interpretation.lines.map((line) => line.variantDimension).find(Boolean) || '';
  const variantValues = unique(interpretation.lines.map((line) => line.size)).slice(0, 12);
  const usesVariants = Boolean(variantDimension && variantValues.length);
  const products = unique(interpretation.lines.map((line) =>
    line.color && !line.styleName.toLowerCase().includes(line.color.toLowerCase())
      ? `${line.styleName} - ${line.color}` : line.styleName
  )).slice(0, 24);
  const destination = interpretation.destinationName;
  const evidence = `${interpretation.documentType.replace('_', ' ')} ${interpretation.documentNumber || sourceName}`;
  const result = {
    businessDescription: interpretation.businessDescription,
    businessType: `Inventory operation documented by ${evidence}`,
    inventoryPurpose: `Track the products, quantities, costs, supplier and destination evidenced by ${sourceName}.`,
    inventoryExamples: products,
    inventoryArchetypes: usesVariants ? ['quantity', 'variant'] : ['quantity'],
    productStructure: {
      summary: usesVariants
        ? `Products are quantity-tracked by the exact ${variantDimension.toLowerCase()} values in the document.`
        : 'Products are quantity-tracked exactly as listed in the document.',
      levels: usesVariants ? ['Product', variantDimension] : ['Product'],
      certainty: 'inferred_confidently',
    },
    variantDimensions: usesVariants ? [{ name: variantDimension, exampleValues: variantValues }] : [],
    serializedTracking: { applies: false, certainty: 'inferred_confidently', reason: 'The document contains quantities, not individual serial identities.' },
    lotTracking: { applies: false, certainty: 'inferred_confidently', reason: 'The document contains no lot or batch identifiers.' },
    expirationTracking: { applies: false, certainty: 'inferred_confidently', reason: 'The document contains no expiration dates.' },
    locationModel: {
      summary: `The document names ${destination} as the only evidenced inventory destination.`,
      multipleLocations: false, transfersExpected: false, certainty: 'inferred_confidently',
    },
    likelyLocations: [{ name: destination, kind: 'warehouse', certainty: 'inferred_confidently' }],
    unitsOfMeasure: [interpretation.unitLabel],
    receivingWorkflow: `Receive the exact lines in ${evidence} into ${destination}.`,
    issuingWorkflow: 'How inventory leaves was not established by this document.',
    transferWorkflow: 'No transfers or additional locations were established by this document.',
    adjustmentWorkflow: 'Any later count correction requires a reason and remains in the inventory ledger.',
    likelyRoles: [],
    terminology: { item: '', location: '', serialUnit: '', lot: '', variant: '' },
    importantOperationalPatterns: [],
    recommendedConfiguration: {
      trackingMode: 'quantity', usesVariants, allowNegativeStock: false,
      summary: usesVariants
        ? `Count each documented ${variantDimension.toLowerCase()} separately at ${destination}.`
        : `Count each documented product at ${destination}.`,
    },
    recommendations: [], assumptions: [], unresolvedDecisions: [], confidence: 'high',
    rationale: `Every configured product, variant, location, supplier and quantity comes directly from ${sourceName}; no additional operation was inferred.`,
  };
  const checked = validate(UNDERSTANDING_SCHEMA, result, { key: 'document-understanding' });
  if (!checked.ok) throw new ValidationError('Foundry could not turn that document into a safe inventory configuration.', { errors: checked.errors });
  return checked.data;
}

function saveDocumentUnderstanding(db, ctx, interpretation, sourceName) {
  const understanding = understandingFromDocument(interpretation, sourceName);
  const usage = interpretation._usage || {};
  return understandingService.save(db, ctx, {
    understanding,
    description: understanding.businessDescription,
    usage: {
      provider: 'document-evidence', model: usage.model || 'deterministic-configuration',
      inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0, latencyMs: usage.latencyMs || 0,
    },
  });
}

function prepareFromInterpretation(db, ctx, membership, file, interpretation, extractedText = '') {
  const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const existing = db.prepare('SELECT * FROM setup_documents WHERE workspace_id = ? AND content_hash = ?').get(ctx.workspaceId, hash);
  if (existing) {
    const stored = existing.understanding_id
      ? understandingService.getUnderstanding(db, ctx.workspaceId, existing.understanding_id) : null;
    if (existing.status !== 'PREPARED' || (stored && stored.provider === 'document-evidence')) {
      return { document: hydrate(existing), understandingId: existing.understanding_id, replayed: true };
    }
    const storedInterpretation = JSON.parse(existing.interpretation);
    const understandingId = saveDocumentUnderstanding(db, ctx, storedInterpretation, existing.source_name);
    db.prepare('UPDATE setup_documents SET understanding_id = ? WHERE id = ?').run(understandingId, existing.id);
    return { document: getByUnderstanding(db, ctx.workspaceId, understandingId), understandingId, replayed: true };
  }
  const understandingId = saveDocumentUnderstanding(db, ctx, interpretation, file.filename);
  const id = newId('sdoc');
  db.prepare(
    `INSERT INTO setup_documents
       (id, workspace_id, uploaded_by_user_id, understanding_id, source_name, source_mime,
        source_content, content_hash, extracted_text, interpretation, supplier_code_label, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED', ?)`
  ).run(id, ctx.workspaceId, ctx.actorId, understandingId, file.filename, file.mimeType || null,
    file.buffer, hash, extractedText, JSON.stringify(interpretation), interpretation.supplierCodeLabel, nowIso());
  return { document: getByUnderstanding(db, ctx.workspaceId, understandingId), understandingId, replayed: false };
}

async function prepare(db, ctx, membership, file, options = {}) {
  if (options.onStage) options.onStage('reading');
  const text = await extractText(file);
  const interpretation = await interpret(text, options);
  if (options.onStage) options.onStage('advising');
  return prepareFromInterpretation(db, ctx, membership, file, interpretation, text);
}

function hydrate(row) {
  if (!row) return null;
  const interpretation = JSON.parse(row.interpretation || '{}');
  return { id: row.id, sourceName: row.source_name, sourceMime: row.source_mime,
    interpretation,
    detectedSupplierCodeLabel: interpretation.supplierCodeLabel || 'Product code',
    supplierCodeLabel: row.supplier_code_label || interpretation.supplierCodeLabel || 'Supplier code', status: row.status,
    scopeConfirmedAt: row.scope_confirmed_at,
    appliedPlanId: row.applied_plan_id, purchaseOrderId: row.purchase_order_id,
    result: JSON.parse(row.result || '{}'), errorMessage: row.error_message };
}

function setSupplierCodeLabel(db, ctx, understandingId, value) {
  const label = requireText(value || 'Supplier code', 'Vendor product-code name', { max: 60 });
  const row = db.prepare('SELECT id, status FROM setup_documents WHERE workspace_id = ? AND understanding_id = ?')
    .get(ctx.workspaceId, understandingId);
  if (!row) return null;
  if (row.status !== 'PREPARED') return getByUnderstanding(db, ctx.workspaceId, understandingId);
  db.prepare('UPDATE setup_documents SET supplier_code_label = ? WHERE id = ? AND workspace_id = ?')
    .run(label, row.id, ctx.workspaceId);
  return getByUnderstanding(db, ctx.workspaceId, understandingId);
}

function confirmScope(db, ctx, understandingId) {
  const changed = db.prepare(`UPDATE setup_documents SET scope_confirmed_at = ?
    WHERE workspace_id = ? AND understanding_id = ? AND status = 'PREPARED'`)
    .run(nowIso(), ctx.workspaceId, understandingId);
  return changed.changes ? getByUnderstanding(db, ctx.workspaceId, understandingId) : null;
}

function getByUnderstanding(db, workspaceId, understandingId) {
  return hydrate(db.prepare('SELECT * FROM setup_documents WHERE workspace_id = ? AND understanding_id = ?').get(workspaceId, understandingId));
}

function getByPlan(db, workspaceId, planId) {
  return hydrate(db.prepare('SELECT * FROM setup_documents WHERE workspace_id = ? AND applied_plan_id = ?').get(workspaceId, planId));
}

function resolveLocation(db, ctx, membership, interpretation) {
  const existing = repo.listLocations(db, ctx.workspaceId, { includeInactive: true })
    .find((location) => location.name.toLowerCase() === interpretation.destinationName.toLowerCase());
  return existing || locationService.createLocation(db, ctx, {
    name: interpretation.destinationName, kind: 'warehouse', note: interpretation.destinationAddress || null,
  });
}

function apply(db, ctx, membership, understandingId, planId) {
  const row = db.prepare('SELECT * FROM setup_documents WHERE workspace_id = ? AND understanding_id = ?').get(ctx.workspaceId, understandingId);
  if (!row) return null;
  if (row.status === 'APPLIED') return hydrate(row);
  const interpretation = JSON.parse(row.interpretation);
  const itemCodeLabel = row.supplier_code_label || interpretation.supplierCodeLabel || 'Supplier code';

  return inTransaction(db, () => {
    db.prepare("UPDATE setup_documents SET status = 'APPLYING', error_message = NULL WHERE id = ?").run(row.id);
    const location = resolveLocation(db, ctx, membership, interpretation);
    let supplier = db.prepare('SELECT id FROM suppliers WHERE workspace_id = ? AND name = ? COLLATE NOCASE')
      .get(ctx.workspaceId, interpretation.supplierName);
    supplier = supplier
      ? supplierService.updateSupplier(db, ctx, membership, supplier.id, {
          itemCodeLabel, itemCodeAliases: [interpretation.supplierCodeLabel],
        })
      : supplierService.createSupplier(db, ctx, membership, {
          name: interpretation.supplierName || 'Supplier from ' + row.source_name,
          email: interpretation.supplierEmail, currency: interpretation.currency,
          paymentTerms: interpretation.paymentTerms, notes: `Created from ${row.source_name}`,
          itemCodeLabel, itemCodeAliases: [interpretation.supplierCodeLabel],
        });

    const groups = new Map();
    for (const line of interpretation.lines) {
      const name = line.color && !line.styleName.toLowerCase().includes(line.color.toLowerCase())
        ? `${line.styleName} - ${line.color}` : line.styleName;
      const key = `${name.toLowerCase()}|${line.supplierSku.toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, { name, code: line.supplierSku || null, lines: [] });
      groups.get(key).lines.push(line);
    }

    const orderLines = [];
    const createdItemIds = [];
    for (const group of groups.values()) {
      const sizes = [...new Set(group.lines.map((line) => line.size).filter(Boolean))];
      const variantDimension = group.lines.map((line) => line.variantDimension).find(Boolean) || 'Variant';
      const created = itemService.createItem(db, ctx, {
        name: group.name, baseCode: group.code, trackingMode: 'quantity', unitLabel: interpretation.unitLabel,
        hasVariants: sizes.length > 0, options: sizes.length ? [{ name: variantDimension, values: sizes }] : [],
        description: `Created from ${row.source_name}`,
      });
      createdItemIds.push(created.itemId);
      const skus = repo.listSkusForItem(db, ctx.workspaceId, created.itemId);
      for (const line of group.lines) {
        const sku = line.size ? skus.find((entry) => String(entry.variant_label).toLowerCase() === line.size.toLowerCase()) : skus[0];
        if (!sku) throw new ValidationError(`Foundry could not match size ${line.size} for ${group.name}.`);
        supplierService.linkItem(db, ctx, membership, {
          supplierId: supplier.id, skuId: sku.id, supplierSku: line.supplierSku,
          supplierDescription: line.description, purchaseUnit: interpretation.unitLabel, unitsPerPurchaseUnit: 1,
          lastUnitCost: line.unitCost, isPreferred: true,
        });
        if (line.sellingPrice !== null) prices.setPrice(db, ctx, { skuId: sku.id,
          amountMinor: prices.fromMajorNumber(line.sellingPrice), currency: interpretation.currency,
          source: 'approved_document', sourceDetail: { setupDocumentId: row.id, sourceName: row.source_name } });
        orderLines.push({ skuId: sku.id, quantityUnits: line.quantity, unitCost: line.unitCost,
          destinationLocationId: location.id, description: line.description, supplierSku: line.supplierSku });
      }
    }

    let order = poService.createOrder(db, ctx, membership, {
      supplierId: supplier.id, poNumber: interpretation.documentNumber || undefined,
      orderDate: interpretation.documentDate || undefined, destinationLocationId: location.id,
      source: 'instruction', sourceDetail: { setupDocumentId: row.id, sourceName: row.source_name },
      notes: `Imported from ${row.source_name}`, lines: orderLines,
    });
    order = poService.approve(db, ctx, membership, order.id, { expectedHash: order.integrityHash, markOrdered: true });
    const received = receivingService.receive(db, ctx, membership, order.id, {
      idempotencyKey: `setup-document:${row.id}`, receivedAt: interpretation.documentDate || undefined,
      reference: interpretation.documentNumber || row.source_name,
      note: `Opening inventory received from ${row.source_name}`,
      lines: order.lines.map((line) => ({ lineId: line.id, quantityUnits: line.quantityUnits, locationId: location.id })),
    });
    const result = { products: groups.size, variants: orderLines.length, units: received.result.unitsReceived,
      unitLabel: interpretation.unitLabel,
      supplier: supplier.name, location: location.name, poNumber: order.poNumber, purchaseOrderId: order.id,
      createdItemIds,
      detectedSupplierCodeLabel: interpretation.supplierCodeLabel || 'Product code', itemCodeLabel };
    db.prepare(
      `UPDATE setup_documents SET status = 'APPLIED', applied_plan_id = ?, purchase_order_id = ?,
        result = ?, applied_at = ? WHERE id = ?`
    ).run(planId, order.id, JSON.stringify(result), nowIso(), row.id);
    return getByUnderstanding(db, ctx.workspaceId, understandingId);
  });
}

module.exports = { SUPPORTED, DOCUMENT_SCHEMA, SYSTEM, extractText, interpret, normalise,
  renderPdfPage, createOcrWorker,
  understandingFromDocument, prepare, prepareFromInterpretation,
  hydrate, getByUnderstanding, getByPlan, setSupplierCodeLabel, confirmScope, apply };

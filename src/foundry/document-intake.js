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
    locationQuantities: { type: 'array', maxItems: 50, items: {
      type: 'object', additionalProperties: false, required: ['locationName', 'quantity'],
      properties: { locationName: { type: 'string' }, quantity: { type: 'integer' } },
    } },
  },
};

/*
 * Freight, duty, insurance, a credit for samples: everything on the document
 * that is money but is not a product.
 *
 * These used to be thrown away — the prompt said so in as many words — which
 * is why an invoice totalling $26,604 imported as $21,390 and the owner could
 * not see where the difference went. They are not inventory lines and they are
 * not noise; they are what the goods actually cost to get here.
 */
const CHARGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['label', 'kind', 'amount'],
  properties: {
    label: { type: 'string' },
    kind: { type: 'string', enum: ['freight', 'insurance', 'duty', 'tax', 'discount', 'deposit', 'other'] },
    amount: { type: 'number' },
  },
};

const DOCUMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['documentType', 'goodsHaveArrived', 'referencedOrderNumber', 'businessDescription', 'unitLabel', 'supplierName',
    'supplierCodeLabel', 'supplierEmail', 'documentNumber', 'documentDate', 'paymentTerms', 'currency',
    'destinationName', 'destinationAddress', 'lines', 'charges', 'documentTotal', 'warnings'],
  properties: {
    /*
     * A proforma invoice had no place in this list, so the reader had to pick
     * one of these — and every one of them means the goods exist. An entire
     * shipment still in the factory was imported as stock on the shelf.
     */
    documentType: { type: 'string',
      enum: ['invoice', 'proforma_invoice', 'quote', 'order_confirmation',
        'purchase_order', 'stock_report', 'catalogue', 'other'] },
    /*
     * The load-bearing question, asked outright rather than inferred from the
     * word at the top of the page. Nothing creates stock unless this is true.
     */
    goodsHaveArrived: { type: 'boolean' },
    /*
     * The purchase order this document is about, in the document's own words.
     * A supplier invoice almost always quotes it, and it is the difference
     * between a bill StockChief can match and one somebody has to hunt down.
     */
    referencedOrderNumber: { type: 'string' },
    charges: { type: 'array', maxItems: 30, items: CHARGE_SCHEMA },
    documentTotal: { type: 'number' },
    businessDescription: { type: 'string' }, unitLabel: { type: 'string' },
    supplierName: { type: 'string' }, supplierCodeLabel: { type: 'string' }, supplierEmail: { type: 'string' },
    documentNumber: { type: 'string' }, documentDate: { type: 'string' }, paymentTerms: { type: 'string' },
    currency: { type: 'string' }, destinationName: { type: 'string' }, destinationAddress: { type: 'string' },
    lines: { type: 'array', maxItems: 500, items: LINE_SCHEMA },
    warnings: { type: 'array', maxItems: 20, items: { type: 'string' } },
  },
};

const SYSTEM = `Read a business inventory source document into structured setup evidence.

Do not invent values. Use an empty string for missing text, -1 for missing unit cost, and 0 only when a line explicitly says zero quantity. lines holds real inventory lines only — never freight, tax, discounts, fees, totals, headings or notes.

goodsHaveArrived is the most important field here. It is true only when this document is evidence that the goods have physically arrived: a supplier invoice for a delivery, a packing slip, a goods-received note, or a stock report of what is on the shelf. It is false for a proforma invoice, a quotation, an order confirmation, a purchase order not yet delivered, or anything describing goods still to be made or shipped. A document promising future delivery, stating a lead time, or asking for a deposit before production has not delivered anything. When it is not clear, use false and say why in warnings — inventing stock that does not exist is far worse than making somebody confirm a delivery.

referencedOrderNumber is the purchase order, order number or job number this document says it is against — the "Your PO", "Order No." or "Ref" the supplier quotes back at you. It is not this document's own number, which belongs in documentNumber. Empty when none is quoted.

charges holds every money line that is not a product: freight, shipping, insurance, import duty, tax, a discount, a sample credit, a deposit already paid. Copy the document's own wording into label and the amount exactly as shown, negative for a credit or discount. Do not convert, allocate or spread these across the products. documentTotal is the final total the document itself states, -1 when it states none. These are not noise: they are the difference between what the goods cost and what the owner actually pays.

When a document lays out one product across a row of sizes — a size run, with the sizes as column headings and a quantity under each — return one line per size that has a quantity, each with the same styleName and supplierSku, variantDimension "Size", and size set to that column's heading. Never collapse a size run into a single line, and never assign a quantity to a size the document did not put it under. If the columns cannot be read reliably, return one line for the row with the stated row total and say so in warnings.

styleName is the reusable inventory product without its line-level variant value. Put colour in color when it is explicit. variantDimension is the business name for the value in size: for example Size, Model, Grade, Length, or Pack. The size field holds that value; leave both strings empty when there is no variant. Preserve supplier SKU exactly. quantity is the inventory units on that exact line. unitCost is supplier purchase cost per inventory unit. sellingPrice is the customer retail/list price only when the source explicitly labels it as retail, selling, list, MSRP or RRP; otherwise use -1. Never copy invoice unit cost into sellingPrice.

unitLabel is the singular thing being counted, such as pair, bottle, machine, roll, or unit. Use the document's wording when it is present; otherwise use unit. Never assume an industry-specific unit from the file format.

When a stock report gives separate quantities for named stores, warehouses, bins, or other locations, put every explicit location and its quantity in locationQuantities. Keep quantity as the explicit total when the document provides one, otherwise use the sum of locationQuantities. Do not put a Total column in locationQuantities. Leave locationQuantities empty when the row has no location split.

businessDescription must describe only what this document genuinely establishes about the inventory model: what products are kept, whether size/colour variants exist, the named stock destination, the supplier relationship, and that this document is purchasing/receiving evidence. It must not claim other locations or workflows not shown.

supplierName is the seller's actual company or trading name. When a branded heading and a generic subtitle such as "Sample Footwear Supplier" both appear, use the branded heading; a generic descriptor is not the supplier's name.

supplierCodeLabel is the exact heading this document uses for the supplier's identifier for a product, such as "Style #", "Item No.", "Vendor SKU", or "Supplier Code". Use an empty string only when no such heading is present. Regardless of its wording, put the identifier value in supplierSku.

destinationName is the name of a PLACE the stock is kept — a warehouse, a store, a branch, a unit, a bay: "Main Warehouse", "Downtown Store", "Unit 4". It is not the buyer's company name. A supplier document is addressed to the business that is buying, so the ship-to is usually the reader's own company and their street address, and neither is the name of a place inside their business. When the document names no such place, leave it empty; StockChief has a sensible default and a company name used as a warehouse reads like a mistake to the person who owns it. For a stock report it is the row location only when one common location is explicit. Use a concise operational location name, preserving a real name from the document. Return ISO YYYY-MM-DD for an unambiguous date; otherwise empty.`;

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
  if (text.length < 20) throw new ValidationError('StockChief could not find readable inventory text in that document. Try a clearer scan or a higher-resolution copy.');
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
    locationQuantities: (line.locationQuantities || []).map((entry) => ({
      locationName: clean(entry.locationName).slice(0, 160),
      quantity: Math.max(0, Math.trunc(Number(entry.quantity) || 0)),
    })).filter((entry) => entry.locationName),
  })).filter((line) => line.styleName && line.quantity > 0);
  /*
   * Charges keep the document's own wording and its own signs. StockChief does
   * not net them off, allocate them across products, or decide which of them
   * are "real" — that is the owner's call once they can see them, and they
   * could not see them at all while these were being discarded.
   */
  const charges = (raw.charges || []).map((charge) => ({
    label: clean(charge.label).slice(0, 160),
    kind: ['freight', 'insurance', 'duty', 'tax', 'discount', 'deposit', 'other'].includes(charge.kind)
      ? charge.kind : 'other',
    amountMinor: Number.isFinite(Number(charge.amount)) ? Math.round(Number(charge.amount) * 100) : null,
  })).filter((charge) => charge.label && charge.amountMinor !== null && charge.amountMinor !== 0);

  return {
    documentType: raw.documentType,
    /*
     * Missing means no. A reader that did not answer has not established that
     * anything arrived, and defaulting the other way is how 800 pairs still in
     * a factory ended up on the balance sheet.
     */
    goodsHaveArrived: raw.goodsHaveArrived === true,
    referencedOrderNumber: clean(raw.referencedOrderNumber),
    charges,
    documentTotalMinor: Number(raw.documentTotal) >= 0 ? Math.round(Number(raw.documentTotal) * 100) : null,
    businessDescription: clean(raw.businessDescription), unitLabel: clean(raw.unitLabel) || 'unit',
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
    signal: options.signal,
  });
  const result = validate(toWireSchema(DOCUMENT_SCHEMA), response.data, { key: 'setup-document-wire' });
  if (!result.ok) throw new ValidationError('StockChief could not reliably read the inventory lines in that document.');
  const interpreted = normalise(result.data);
  if (!interpreted.businessDescription) throw new ValidationError('The document does not establish enough about the inventory to configure it safely.');
  if (!interpreted.lines.length) throw new ValidationError('StockChief found no inventory quantities to add in that document.');
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
  const locationNames = unique(interpretation.lines.flatMap((line) =>
    (line.locationQuantities || []).map((entry) => entry.locationName)));
  const destinations = locationNames.length ? locationNames : [interpretation.destinationName];
  const destination = destinations[0];
  const evidence = `${interpretation.documentType.replace('_', ' ')} ${interpretation.documentNumber || sourceName}`;
  const result = {
    businessDescription: interpretation.businessDescription,
    businessType: `Inventory operation documented by ${evidence}`,
    inventoryPurpose: `Track the products, quantities, costs, supplier and destination evidenced by ${sourceName}.`,
    inventoryExamples: products,
    ownerProvidedInventory: { hasRecords: false, lines: [], ambiguities: [] },
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
      summary: destinations.length > 1
        ? `The document gives separate inventory quantities for ${destinations.join(', ')}.`
        : `The document names ${destination} as the evidenced inventory destination.`,
      multipleLocations: destinations.length > 1, transfersExpected: false, certainty: 'inferred_confidently',
    },
    likelyLocations: destinations.map((name) => ({ name, kind: 'warehouse', certainty: 'inferred_confidently' })),
    unitsOfMeasure: [interpretation.unitLabel],
    receivingWorkflow: `Receive the exact lines in ${evidence} into ${destination}.`,
    issuingWorkflow: 'How inventory leaves was not established by this document.',
    transferWorkflow: 'No transfers or additional locations were established by this document.',
    adjustmentWorkflow: 'Any later count correction requires a reason and remains in the inventory ledger.',
    likelyRoles: [],
    terminology: { item: '', location: '', serialUnit: '', lot: '', variant: '' },
    importantOperationalPatterns: [],
    statedRequirements: [],
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
  if (!checked.ok) throw new ValidationError('StockChief could not turn that document into a safe inventory configuration.', { errors: checked.errors });
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
  // Three real waits, reported as three: getting the text out of the file, the
  // model call that reads it, and matching what it found against this
  // inventory. They used to be reported as two, and the middle one — by far
  // the longest — shared a label with the first.
  if (options.onStage) options.onStage('extracting');
  const text = await extractText(file);
  if (options.onStage) options.onStage('reading');
  const interpretation = await interpret(text, options);
  if (options.onStage) options.onStage('preparing');
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
    result: JSON.parse(row.result || '{}'), errorMessage: row.error_message,
    createdAt: row.created_at, appliedAt: row.applied_at };
}

function markMailboxDocumentApplied(db, setupDocumentId, at = nowIso()) {
  db.prepare(`UPDATE connection_email_messages SET classification = 'inventory_document',
    processing_status = 'INVENTORY_APPLIED', processed_at = ?
    WHERE workspace_id = (SELECT workspace_id FROM setup_documents WHERE id = ?)
      AND processing_status = 'AWAITING_INVENTORY_REVIEW'
      AND id IN (SELECT message_id FROM connection_email_attachments WHERE setup_document_id = ?)`)
    .run(at, setupDocumentId, setupDocumentId);
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

function resolveNamedLocation(db, ctx, name) {
  const existing = repo.listLocations(db, ctx.workspaceId, { includeInactive: true })
    .find((location) => location.name.toLowerCase() === name.toLowerCase());
  return existing || locationService.createLocation(db, ctx, { name, kind: 'warehouse' });
}

function existingSkuForDocumentLine(db, workspaceId, supplierId, itemName, line) {
  return db.prepare(`SELECT s.*, i.name AS item_name
    FROM skus s JOIN items i ON i.id = s.item_id AND i.workspace_id = s.workspace_id
    LEFT JOIN supplier_items si ON si.sku_id = s.id AND si.workspace_id = s.workspace_id
      AND si.supplier_id = ? AND si.is_active = 1
    WHERE s.workspace_id = ? AND s.is_active = 1 AND (
      (? <> '' AND LOWER(COALESCE(si.supplier_sku, '')) = LOWER(?)
        AND (? = '' OR LOWER(COALESCE(s.variant_label, '')) = LOWER(?)))
      OR (? <> '' AND LOWER(s.code) = LOWER(?))
      OR (LOWER(i.name) = LOWER(?) AND LOWER(COALESCE(s.variant_label, '')) = LOWER(?))
    ) ORDER BY CASE WHEN LOWER(COALESCE(si.supplier_sku, '')) = LOWER(?) THEN 0 ELSE 1 END LIMIT 1`)
    .get(supplierId || '', workspaceId, line.supplierSku || '', line.supplierSku || '',
      line.size || '', line.size || '', line.supplierSku || '', line.supplierSku || '',
      itemName, line.size || '', line.supplierSku || '') || null;
}

function matchPreview(db, workspaceId, interpretation) {
  const supplier = interpretation.supplierName ? db.prepare(
    'SELECT id FROM suppliers WHERE workspace_id = ? AND name = ? COLLATE NOCASE'
  ).get(workspaceId, interpretation.supplierName) : null;
  return interpretation.lines.map((line) => {
    const itemName = line.color && !line.styleName.toLowerCase().includes(line.color.toLowerCase())
      ? `${line.styleName} - ${line.color}` : line.styleName;
    const match = existingSkuForDocumentLine(db, workspaceId, supplier?.id, itemName, line);
    return match ? { status: 'match', skuId: match.id, label: `${match.item_name}${match.variant_label ? ` / ${match.variant_label}` : ''}` }
      : { status: 'new', skuId: null, label: 'Create as new' };
  });
}

/*
 * What the owner said this document is.
 *
 * A proforma invoice proves nothing on its own, but the person who uploaded
 * it knows why they did. Three answers cover it, and each leads somewhere
 * different: place the order, keep only the prices, or — the one that was
 * missing — "this is what I already have", which is somebody using a supplier
 * document as the opening count of a business they are setting up.
 *
 * The decision only ever widens what a document may establish, never narrows
 * what it already proved: an owner cannot say a delivered invoice did not
 * arrive by choosing a different button.
 */
const INTENTS = {
  'Place the order': { orders: true, opening: false },
  'Just keep the prices': { orders: false, opening: false },
  'This is what I already have in stock': { orders: false, opening: true },
};

/**
 * Opening stock: what the business already had, on the day it started using
 * StockChief.
 *
 * This does not go through supplier receiving, and that is the whole point.
 * Receiving posts inventory against Received-Not-Invoiced — a debt to the
 * supplier — which is correct for a delivery and completely wrong here. An
 * owner uploading a document to say "this is what I have" would have been
 * told they owed a factory in Chongqing $21,390 for shoes they already owned.
 *
 * Opening stock has no supplier transaction behind it. The goods are already
 * yours, so the other side of the entry is opening equity: this is what the
 * business was worth when the books began. No purchase order, no bill, no
 * money owed to anybody.
 *
 * It is also why nobody is asked for an adjustment reason on each line. The
 * reason is inherent and the same for every one of them — this is where the
 * business started.
 */
function openTheBooks(db, ctx, membership, { orderLines, interpretation, sourceName, startDate }) {
  const engine = require('../domain/inventory-engine');
  const perSku = new Map();

  for (const line of orderLines) {
    const key = `${line.skuId}|${line.destinationLocationId}`;
    const costMinor = Math.round(Number(line.unitCost || 0) * 100) * Number(line.quantityUnits || 0);
    const existing = perSku.get(key)
      || { skuId: line.skuId, locationId: line.destinationLocationId, quantityUnits: 0, totalCostMinor: 0 };
    existing.quantityUnits += Number(line.quantityUnits || 0);
    existing.totalCostMinor += costMinor;
    perSku.set(key, existing);
  }

  let units = 0;
  for (const row of perSku.values()) {
    engine.receive(db, ctx, {
      skuId: row.skuId, locationId: row.locationId, quantity: row.quantityUnits,
      reasonCode: 'opening', notes: `Opening stock from ${sourceName}`,
      reference: interpretation.documentNumber || sourceName,
    });
    units += row.quantityUnits;
  }

  /*
   * The ledger half, only when the workspace keeps books at all. Stock is a
   * physical fact and does not wait on accounting being switched on.
   */
  const settings = db.prepare('SELECT enabled FROM accounting_settings WHERE workspace_id = ?')
    .get(ctx.workspaceId);
  const valued = [...perSku.values()].filter((row) => row.totalCostMinor > 0);
  const totalMinor = valued.reduce((sum, row) => sum + row.totalCostMinor, 0);
  if (!settings?.enabled || !totalMinor) return { units, journalEntryId: null, totalMinor };

  const openingBalances = require('../accounting/opening-balances');
  const prepared = openingBalances.prepare(db, ctx, membership, {
    startDate: startDate || interpretation.documentDate || nowIso().slice(0, 10),
    currency: interpretation.currency || 'USD',
    sourceDescription: `Opening stock from ${sourceName}`,
    lines: [
      { accountKey: 'INVENTORY_ASSET', debitMinor: totalMinor, memo: `Opening stock from ${sourceName}` },
      { accountKey: 'OPENING_BALANCE_EQUITY', creditMinor: totalMinor, memo: `Opening stock from ${sourceName}` },
    ],
    inventory: valued,
  });
  const posted = openingBalances.approve(db, ctx, membership, prepared.id, prepared.integrity_hash);
  return { units, journalEntryId: posted.opening.journal_entry_id, totalMinor };
}

function apply(db, ctx, membership, understandingId, planId, options = {}) {
  const row = db.prepare('SELECT * FROM setup_documents WHERE workspace_id = ? AND understanding_id = ?').get(ctx.workspaceId, understandingId);
  if (!row) return null;
  if (row.status === 'APPLIED') {
    markMailboxDocumentApplied(db, row.id);
    return hydrate(row);
  }
  const interpretation = JSON.parse(row.interpretation);
  const itemCodeLabel = row.supplier_code_label || interpretation.supplierCodeLabel || 'Supplier code';

  return inTransaction(db, () => {
    db.prepare("UPDATE setup_documents SET status = 'APPLYING', error_message = NULL WHERE id = ?").run(row.id);
    const explicitLocationNames = unique(interpretation.lines.flatMap((line) =>
      (line.locationQuantities || []).map((entry) => entry.locationName)));
    const location = explicitLocationNames.length
      ? resolveNamedLocation(db, ctx, explicitLocationNames[0])
      : resolveLocation(db, ctx, membership, interpretation);
    const locationsByName = new Map([[location.name.toLowerCase(), location]]);
    for (const name of unique(interpretation.lines.flatMap((line) =>
      (line.locationQuantities || []).map((entry) => entry.locationName)))) {
      if (!locationsByName.has(name.toLowerCase())) locationsByName.set(name.toLowerCase(), resolveNamedLocation(db, ctx, name));
    }
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
      const existingForLine = group.lines.map((line) =>
        existingSkuForDocumentLine(db, ctx.workspaceId, supplier.id, group.name, line));
      const matchedCount = existingForLine.filter(Boolean).length;
      if (matchedCount && matchedCount !== group.lines.length) {
        throw new ValidationError(`${group.name} partly matches existing inventory. Review its variants before importing; StockChief did not create a duplicate item.`);
      }
      let skus;
      if (matchedCount === group.lines.length) {
        skus = existingForLine;
      } else {
        const created = itemService.createItem(db, ctx, {
          name: group.name, baseCode: group.code, trackingMode: 'quantity', unitLabel: interpretation.unitLabel,
          hasVariants: sizes.length > 0, options: sizes.length ? [{ name: variantDimension, values: sizes }] : [],
          description: `Created from ${row.source_name}`,
        });
        createdItemIds.push(created.itemId);
        const createdSkus = repo.listSkusForItem(db, ctx.workspaceId, created.itemId);
        skus = group.lines.map((line) => line.size
          ? createdSkus.find((entry) => String(entry.variant_label).toLowerCase() === line.size.toLowerCase())
          : createdSkus[0]);
      }
      for (const [index, line] of group.lines.entries()) {
        const sku = skus[index];
        if (!sku) throw new ValidationError(`StockChief could not match size ${line.size} for ${group.name}.`);
        supplierService.linkItem(db, ctx, membership, {
          supplierId: supplier.id, skuId: sku.id, supplierSku: line.supplierSku,
          supplierDescription: line.description, purchaseUnit: interpretation.unitLabel, unitsPerPurchaseUnit: 1,
          lastUnitCost: line.unitCost, isPreferred: true,
        });
        if (line.sellingPrice !== null) prices.setPrice(db, ctx, { skuId: sku.id,
          amountMinor: prices.fromMajorNumber(line.sellingPrice), currency: interpretation.currency,
          source: 'approved_document', sourceDetail: { setupDocumentId: row.id, sourceName: row.source_name } });
        const allocations = (line.locationQuantities?.length ? line.locationQuantities
          : [{ locationName: location.name, quantity: line.quantity }]).filter((entry) => entry.quantity > 0);
        for (const allocation of allocations) {
          const destination = locationsByName.get(allocation.locationName.toLowerCase()) || location;
          orderLines.push({ skuId: sku.id, quantityUnits: allocation.quantity, unitCost: line.unitCost,
            destinationLocationId: destination.id, description: line.description, supplierSku: line.supplierSku });
        }
      }
    }

    const intent = INTENTS[options.documentIntent] || null;
    const opensTheBooks = Boolean(intent?.opening);

    /*
     * A quotation somebody wanted only for its prices leads to no order.
     * Creating one anyway would put money on a supplier's account that
     * nobody committed to, and leave a purchase to chase that does not exist.
     */
    /*
     * Opening stock has no supplier transaction behind it, so it gets no
     * purchase order either. Creating one would leave a delivery to chase for
     * goods already on the shelf, and a bill for goods already owned.
     */
    const wantsOrder = intent ? intent.orders : true;

    /*
     * A supplier invoice is money, not merchandise.
     *
     * It gets its own path because everything about it is different: the
     * order it is billing usually already exists, so making another would
     * double the business's commitments, and the goods it lists have not
     * necessarily moved an inch. What it establishes is that somebody is owed.
     */
    const invoiceIntake = require('./supplier-invoice-intake');
    const isSupplierInvoice = require('./document-meaning').kindOf(interpretation) === 'supplier_invoice';
    const matchedOrder = isSupplierInvoice
      ? invoiceIntake.findOrder(db, ctx.workspaceId, interpretation, supplier.id)
      : null;
    /*
     * "Are these expected to arrive?" — the one question a bill with no order
     * behind it needs answered. StockChief will record what is owed either way;
     * what it will not do is invent a purchase nobody told it about.
     */
    const expectsGoods = options.documentIntent === 'Yes, they are coming';
    const billsOnly = isSupplierInvoice && (Boolean(matchedOrder)
      || (!expectsGoods && !interpretation.goodsHaveArrived));

    let order = matchedOrder;
    if (wantsOrder && !billsOnly && !matchedOrder) {
      order = poService.createOrder(db, ctx, membership, {
        supplierId: supplier.id, poNumber: interpretation.documentNumber || undefined,
        orderDate: interpretation.documentDate || undefined, destinationLocationId: location.id,
        source: 'instruction', sourceDetail: { setupDocumentId: row.id, sourceName: row.source_name },
        notes: `Imported from ${row.source_name}`, lines: orderLines,
      });
      order = poService.approve(db, ctx, membership, order.id, { expectedHash: order.integrityHash, markOrdered: true });
    }

    /*
     * Receiving only what has actually been received.
     *
     * This used to run unconditionally: every document imported became a
     * goods receipt. A proforma invoice for 800 pairs of shoes still being
     * made in Chongqing arrived as 800 pairs on the shelf and $21,390 debited
     * to Inventory Asset — a balance sheet asserting ownership of goods that
     * did not exist, on the owner's first day using the product.
     *
     * An order that has not arrived is still worth importing. The catalogue,
     * the supplier, the prices and the purchase order are all real and all
     * useful. What is not real is the stock, so the order simply stays on
     * order until somebody receives it, which is the same path every other
     * delivery takes.
     */
    /*
     * Opening stock is the one case where a person may establish physical
     * quantities from a document that does not itself evidence a delivery.
     * It is confined to a business being set up: there is no prior truth to
     * contradict, and the reason for every 0 -> quantity is inherent.
     */
    /*
     * The money. Recorded whether or not there was an order to match — a bill
     * is owed regardless of how tidy StockChief's purchasing records are — and
     * compared against the order when there is one, so a supplier billing for
     * more than they were asked for is a fact somebody sees rather than a
     * silent adjustment.
     */
    let billing = null;
    let billMatch = null;
    if (isSupplierInvoice) {
      if (matchedOrder) billMatch = invoiceIntake.compare(db, ctx.workspaceId, matchedOrder, interpretation);
      try {
        billing = invoiceIntake.bill(db, ctx, membership, {
          interpretation, supplierId: supplier.id, order: order || null, sourceName: row.source_name,
          expectGoods: expectsGoods,
        });
      } catch (error) {
        billing = { billed: false, because: String(error.message || error) };
      }
    }

    const opened = opensTheBooks
      ? openTheBooks(db, ctx, membership, { orderLines, interpretation,
        sourceName: row.source_name, startDate: interpretation.documentDate })
      : null;
    const received = order && interpretation.goodsHaveArrived
      ? receivingService.receive(db, ctx, membership, order.id, {
        idempotencyKey: `setup-document:${row.id}`, receivedAt: interpretation.documentDate || undefined,
        reference: interpretation.documentNumber || row.source_name,
        note: `Opening inventory received from ${row.source_name}`,
        lines: order.lines.map((line) => ({ lineId: line.id, quantityUnits: line.quantityUnits,
          locationId: line.destinationLocationId || location.id })),
      })
      : null;
    // An invoice can prove a freight/duty/insurance charge and the posted
    // supplier bill proves its accounting source. A receipt proves which
    // goods are eligible. Only when all three exist do we prepare a draft
    // allocation; approval and application remain separate owner decisions.
    let landedCostProposal = null;
    if (isSupplierInvoice && billing?.bill && matchedOrder && (interpretation.charges || []).length) {
      try {
        landedCostProposal = require('./landed-cost-proposal').propose(db, ctx, membership, {
          interpretation, bill: billing.bill, purchaseOrder: matchedOrder, sourceDocumentId: row.id,
        });
      } catch (error) {
        landedCostProposal = { proposed: false, reason: String(error.message || error) };
      }
    }
    /*
     * The charges go onto the order, not into the product costs.
     *
     * Kept as the document stated them so the owner can see the whole bill:
     * goods, then freight, then duty, then whatever credit was given. Spreading
     * them over the units would produce a unit cost nobody agreed to and would
     * make the document impossible to reconcile against.
     */
    for (const charge of (order ? interpretation.charges || [] : [])) {
      db.prepare(`INSERT INTO purchase_order_charges
          (id, workspace_id, purchase_order_id, label, kind, amount_minor, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId('pochg'), ctx.workspaceId, order.id, charge.label, charge.kind,
          charge.amountMinor, row.source_name, nowIso());
    }

    const orderedUnits = orderLines.reduce((sum, entry) => sum + Number(entry.quantityUnits || 0), 0);
    const result = { products: groups.size, variants: new Set(orderLines.map((entry) => entry.skuId)).size,
      goodsHaveArrived: Boolean(interpretation.goodsHaveArrived),
      documentIntent: options.documentIntent || null,
      openingStock: opensTheBooks,
      units: opened ? opened.units : (received ? received.result.unitsReceived : 0),
      openingValueMinor: opened ? opened.totalMinor : null,
      billedNumber: billing?.bill ? billing.bill.bill_number : null,
      billedMinor: billing?.bill ? Number(billing.bill.total_minor || 0) : null,
      billedAgainstOrder: matchedOrder ? matchedOrder.po_number : null,
      billDifferences: billMatch ? billMatch.differences : [],
      billNotRecorded: billing && !billing.billed ? billing.because : null,
      landedCostProposal,
      unitsOnOrder: (received || opened) ? 0 : orderedUnits,
      charges: interpretation.charges || [],
      documentTotalMinor: interpretation.documentTotalMinor ?? null,
      unitLabel: interpretation.unitLabel,
      supplier: supplier.name, location: [...locationsByName.values()].map((entry) => entry.name).join(', '),
      poNumber: order ? order.poNumber : null, purchaseOrderId: order ? order.id : null,
      createdItemIds,
      detectedSupplierCodeLabel: interpretation.supplierCodeLabel || 'Product code', itemCodeLabel };
    /*
     * And kept whichever way the document was read.
     *
     * The loop above only reaches a charge when the document created a
     * purchase order. An owner saying "this is stock I already have" creates
     * none, so a proforma's $5,411 of sea freight was read, shown on the
     * proposal, and then silently dropped — leaving the Money page an empty
     * Expenses section beside an inventory value five thousand dollars short
     * of what had actually been paid. These are kept for every path, outside
     * the books until somebody says what they are.
     */
    require('../accounting/document-costs').record(db, ctx, {
      setupDocumentId: row.id,
      purchaseOrderId: order ? order.id : null,
      documentNumber: interpretation.documentNumber || null,
      supplierName: supplier.name,
      currency: interpretation.currency || 'USD',
      charges: interpretation.charges || [],
      // The goods belong to the document, not to what was chosen to do with
      // it. Reading this from the opening value meant a proforma answered
      // with "Place the order" recorded its freight and forgot the goods the
      // freight was on — and the reconciliation then blamed StockChief for a
      // misread that never happened.
      goodsMinor: require('../accounting/document-costs').goodsValueOf(interpretation)
        || result.openingValueMinor || 0,
      documentTotalMinor: result.documentTotalMinor ?? interpretation.documentTotalMinor ?? null,
      openedBooks: opensTheBooks,
    });

    const appliedAt = nowIso();
    db.prepare(
      `UPDATE setup_documents SET status = 'APPLIED', applied_plan_id = ?, purchase_order_id = ?,
        result = ?, applied_at = ? WHERE id = ?`
    ).run(planId, order ? order.id : null, JSON.stringify(result), appliedAt, row.id);
    markMailboxDocumentApplied(db, row.id, appliedAt);
    return getByUnderstanding(db, ctx.workspaceId, understandingId);
  });
}

module.exports = { SUPPORTED, DOCUMENT_SCHEMA, SYSTEM, extractText, interpret, normalise,
  renderPdfPage, createOcrWorker,
  understandingFromDocument, prepare, prepareFromInterpretation,
  hydrate, getByUnderstanding, getByPlan, setSupplierCodeLabel, confirmScope, markMailboxDocumentApplied,
  existingSkuForDocumentLine, matchPreview, apply };

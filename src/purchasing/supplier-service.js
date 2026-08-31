'use strict';

/**
 * Suppliers, and what each one calls the things we buy from them.
 *
 * Two ideas carry most of the weight here.
 *
 * The first is that a supplier belongs to one workspace. Two inventories that
 * both buy from "ABC Footwear" have two records, because they are two different
 * businesses' relationships — different prices, different lead times, different
 * contacts — and merging them would leak one customer's terms into another's.
 *
 * The second is the purchase unit. We count shoes; ABC sells cases of twelve
 * with a minimum of two. Every quantity Foundry recommends has to survive that
 * conversion, so it is stored explicitly rather than folded into a number
 * nobody can check.
 */

const { inTransaction } = require('../db');
const { newId, nowIso, trimOrNull, requireText } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const repo = require('../domain/repository');
const supplierCodeMappings = require('./supplier-code-mappings');

const STATUSES = ['active', 'inactive'];
const MAX_LEAD_TIME_DAYS = 365;
const COMMON_ITEM_CODE_ALIASES = [
  'Supplier code', 'Supplier SKU', 'Vendor code', 'Vendor SKU', 'Item code', 'Item no.',
  'Product code', 'Catalogue number', 'Catalog number', 'Style number', 'Style #', 'Reference',
];

function parseAliases(value) {
  let values = value;
  if (typeof value === 'string') {
    try { values = JSON.parse(value); } catch { values = value.split(','); }
  }
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  return values.map((entry) => String(entry || '').trim()).filter((entry) => {
    const key = entry.toLowerCase();
    if (!key || entry.length > 60 || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 30);
}

function preferredItemCodeLabel(value) {
  return requireText(value || 'Supplier code', 'Vendor product-code name', { max: 60 });
}

function mergeAliases(...groups) {
  return parseAliases(groups.flatMap((group) => parseAliases(group)));
}

function optionalInt(value, field, { min = 0, max = 1000000 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ValidationError(`${field} must be a whole number.`, { field });
  }
  if (n < min || n > max) {
    throw new ValidationError(`${field} must be between ${min} and ${max}.`, { field });
  }
  return n;
}

function optionalMoney(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(String(value).replace(/[,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw new ValidationError(`${field} must be an amount.`, { field });
  return Math.round(n * 10000) / 10000;
}

function optionalPercent(value, field, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new ValidationError(`${field} must be between 0 and 100.`, { field });
  return Math.round(n * 100) / 100;
}

const checkbox = (value, fallback = false) => {
  if (value === undefined) return fallback;
  const chosen = Array.isArray(value) ? value[value.length - 1] : value;
  return ['1', 'true', 'on', 'yes'].includes(String(chosen).toLowerCase());
};
const moneyMinor = (value, field, fallback = null) => {
  if (value === undefined) return fallback;
  const money = optionalMoney(value, field);
  return money === null ? null : Math.round(money * 100);
};

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    code: row.code,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    notes: row.notes,
    status: row.status,
    isActive: row.status === 'active',
    defaultLeadTimeDays: row.default_lead_time_days,
    minimumOrderAmount: row.minimum_order_amount,
    currency: row.currency,
    paymentTerms: row.payment_terms,
    itemCodeLabel: row.item_code_label || 'Supplier code',
    internalCode: row.internal_code,
    internalBaseCode: row.internal_base_code,
    itemCodeAliases: parseAliases(row.item_code_aliases),
    preferredOrderingMethod: row.preferred_ordering_method || 'email',
    watchedConnectorId: row.watched_connector_id,
    prepareCommunications: row.prepare_communications !== 0,
    autoSendEnabled: row.auto_send_enabled === 1,
    autoSendLimitMinor: row.auto_send_limit_minor,
    autoSendLimit: row.auto_send_limit_minor === null ? null : Number(row.auto_send_limit_minor) / 100,
    priceTolerancePercent: Number(row.price_tolerance_percent ?? 5),
    quantityTolerancePercent: Number(row.quantity_tolerance_percent ?? 0),
    trustedDeliveryReceipt: row.trusted_delivery_receipt === 1,
    followUpDays: Number(row.follow_up_days ?? 2),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

function createSupplier(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_SUPPLIERS, 'manage suppliers');
  const now = nowIso();
  const name = requireText(input.name, 'Supplier name', { max: 160 });

  const clash = db
    .prepare('SELECT id FROM suppliers WHERE workspace_id = ? AND name = ? COLLATE NOCASE')
    .get(ctx.workspaceId, name);
  if (clash) throw new ValidationError(`There is already a supplier called ${name}.`, { field: 'name' });

  const id = newId('sup');
  const itemCodeLabel = preferredItemCodeLabel(input.itemCodeLabel);
  const itemCodeAliases = mergeAliases(input.itemCodeAliases || [], [itemCodeLabel]);
  db.prepare(
    `INSERT INTO suppliers (
       id, workspace_id, name, code, contact_name, email, phone, notes, status,
       default_lead_time_days, minimum_order_amount, currency, payment_terms,
       item_code_label, item_code_aliases, preferred_ordering_method, watched_connector_id,
       prepare_communications, auto_send_enabled, auto_send_limit_minor, price_tolerance_percent,
       quantity_tolerance_percent, trusted_delivery_receipt, follow_up_days, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    ctx.workspaceId,
    name,
    trimOrNull(input.code),
    trimOrNull(input.contactName),
    trimOrNull(input.email),
    trimOrNull(input.phone),
    trimOrNull(input.notes),
    STATUSES.includes(input.status) ? input.status : 'active',
    optionalInt(input.defaultLeadTimeDays, 'Lead time', { max: MAX_LEAD_TIME_DAYS }),
    optionalMoney(input.minimumOrderAmount, 'Minimum order amount'),
    trimOrNull(input.currency) || 'USD',
    trimOrNull(input.paymentTerms),
    itemCodeLabel,
    JSON.stringify(itemCodeAliases),
    trimOrNull(input.preferredOrderingMethod) || 'email',
    trimOrNull(input.watchedConnectorId),
    checkbox(input.prepareCommunications, true) ? 1 : 0,
    checkbox(input.autoSendEnabled, false) ? 1 : 0,
    moneyMinor(input.autoSendLimit, 'Automatic send limit'),
    optionalPercent(input.priceTolerancePercent, 'Price tolerance', 5) ?? 5,
    optionalPercent(input.quantityTolerancePercent, 'Quantity tolerance', 0) ?? 0,
    checkbox(input.trustedDeliveryReceipt, false) ? 1 : 0,
    optionalInt(input.followUpDays, 'Follow-up timing', { min: 1, max: 60 }) ?? 2,
    now,
    now
  );
  return getSupplier(db, ctx.workspaceId, id);
}

function updateSupplier(db, ctx, membership, supplierId, input) {
  permissions.assertCan(membership, permissions.MANAGE_SUPPLIERS, 'manage suppliers');
  const existing = getSupplier(db, ctx.workspaceId, supplierId);
  const name = input.name === undefined ? existing.name : requireText(input.name, 'Supplier name', { max: 160 });

  if (name.toLowerCase() !== existing.name.toLowerCase()) {
    const clash = db
      .prepare('SELECT id FROM suppliers WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND id <> ?')
      .get(ctx.workspaceId, name, supplierId);
    if (clash) throw new ValidationError(`There is already a supplier called ${name}.`, { field: 'name' });
  }

  const pick = (key, current) => (input[key] === undefined ? current : trimOrNull(input[key]));
  const itemCodeLabel = input.itemCodeLabel === undefined
    ? existing.itemCodeLabel : preferredItemCodeLabel(input.itemCodeLabel);
  const itemCodeAliases = input.itemCodeAliases === undefined
    ? mergeAliases(existing.itemCodeAliases, [existing.itemCodeLabel], [itemCodeLabel])
    : mergeAliases(existing.itemCodeAliases, input.itemCodeAliases, [existing.itemCodeLabel], [itemCodeLabel]);
  db.prepare(
    `UPDATE suppliers
        SET name = ?, code = ?, contact_name = ?, email = ?, phone = ?, notes = ?, status = ?,
            default_lead_time_days = ?, minimum_order_amount = ?, currency = ?, payment_terms = ?,
            item_code_label = ?, item_code_aliases = ?, preferred_ordering_method = ?, watched_connector_id = ?,
            prepare_communications = ?, auto_send_enabled = ?, auto_send_limit_minor = ?,
            price_tolerance_percent = ?, quantity_tolerance_percent = ?, trusted_delivery_receipt = ?,
            follow_up_days = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`
  ).run(
    name,
    pick('code', existing.code),
    pick('contactName', existing.contactName),
    pick('email', existing.email),
    pick('phone', existing.phone),
    pick('notes', existing.notes),
    input.status && STATUSES.includes(input.status) ? input.status : existing.status,
    input.defaultLeadTimeDays === undefined
      ? existing.defaultLeadTimeDays
      : optionalInt(input.defaultLeadTimeDays, 'Lead time', { max: MAX_LEAD_TIME_DAYS }),
    input.minimumOrderAmount === undefined
      ? existing.minimumOrderAmount
      : optionalMoney(input.minimumOrderAmount, 'Minimum order amount'),
    pick('currency', existing.currency) || existing.currency,
    pick('paymentTerms', existing.paymentTerms),
    itemCodeLabel,
    JSON.stringify(itemCodeAliases),
    input.preferredOrderingMethod === undefined ? existing.preferredOrderingMethod : trimOrNull(input.preferredOrderingMethod) || 'email',
    input.watchedConnectorId === undefined ? existing.watchedConnectorId : trimOrNull(input.watchedConnectorId),
    checkbox(input.prepareCommunications, existing.prepareCommunications) ? 1 : 0,
    checkbox(input.autoSendEnabled, existing.autoSendEnabled) ? 1 : 0,
    moneyMinor(input.autoSendLimit, 'Automatic send limit', existing.autoSendLimitMinor),
    optionalPercent(input.priceTolerancePercent, 'Price tolerance', existing.priceTolerancePercent) ?? existing.priceTolerancePercent,
    optionalPercent(input.quantityTolerancePercent, 'Quantity tolerance', existing.quantityTolerancePercent) ?? existing.quantityTolerancePercent,
    checkbox(input.trustedDeliveryReceipt, existing.trustedDeliveryReceipt) ? 1 : 0,
    input.followUpDays === undefined ? existing.followUpDays : optionalInt(input.followUpDays, 'Follow-up timing', { min: 1, max: 60 }),
    nowIso(),
    supplierId,
    ctx.workspaceId
  );
  const saved = getSupplier(db, ctx.workspaceId, supplierId);
  db.prepare(`UPDATE supplier_communications SET connector_id = ?, recipient = COALESCE(?, recipient), updated_at = ?
    WHERE workspace_id = ? AND supplier_id = ? AND status IN ('PREPARED','QUEUED','FAILED')`)
    .run(saved.watchedConnectorId, saved.email, nowIso(), ctx.workspaceId, supplierId);
  return saved;
}

function getSupplier(db, workspaceId, supplierId) {
  const row = db
    .prepare('SELECT * FROM suppliers WHERE id = ? AND workspace_id = ?')
    .get(supplierId, workspaceId);
  if (!row) throw new NotFoundError('That supplier is not in this inventory.');
  return hydrate(row);
}

function findSupplier(db, workspaceId, supplierId) {
  return hydrate(
    db.prepare('SELECT * FROM suppliers WHERE id = ? AND workspace_id = ?').get(supplierId, workspaceId)
  );
}

function listSuppliers(db, workspaceId, { includeInactive = false } = {}) {
  const clause = includeInactive ? '' : " AND status = 'active'";
  return db
    .prepare(`SELECT * FROM suppliers WHERE workspace_id = ?${clause} ORDER BY name COLLATE NOCASE`)
    .all(workspaceId)
    .map(hydrate);
}

/** Suppliers with how many products each one supplies and what is open. */
function listWithCounts(db, workspaceId, { includeInactive = false } = {}) {
  return listSuppliers(db, workspaceId, { includeInactive }).map((supplier) => ({
    ...supplier,
    itemCount: db
      .prepare('SELECT COUNT(*) AS n FROM supplier_items WHERE workspace_id = ? AND supplier_id = ? AND is_active = 1')
      .get(workspaceId, supplier.id).n,
    openOrders: db
      .prepare(
        `SELECT COUNT(*) AS n FROM purchase_orders
          WHERE workspace_id = ? AND supplier_id = ?
            AND status IN ('APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED')`
      )
      .get(workspaceId, supplier.id).n,
  }));
}

/**
 * Records wording Foundry actually observed on a document without replacing
 * the supplier's chosen display term. Future invoices can use either spelling.
 */
function rememberItemCodeAlias(db, workspaceId, supplierId, observedLabel) {
  const label = trimOrNull(observedLabel);
  if (!label || label.length > 60) return getSupplier(db, workspaceId, supplierId);
  const supplier = getSupplier(db, workspaceId, supplierId);
  const aliases = mergeAliases(supplier.itemCodeAliases, [supplier.itemCodeLabel], [label]);
  db.prepare('UPDATE suppliers SET item_code_aliases = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(JSON.stringify(aliases), nowIso(), supplierId, workspaceId);
  return getSupplier(db, workspaceId, supplierId);
}

function documentVocabulary(db, workspaceId) {
  return listSuppliers(db, workspaceId, { includeInactive: true }).map((supplier) => ({
    supplierId: supplier.id,
    supplierName: supplier.name,
    preferredItemCodeLabel: supplier.itemCodeLabel,
    recognizedItemCodeLabels: mergeAliases(COMMON_ITEM_CODE_ALIASES, supplier.itemCodeAliases, [supplier.itemCodeLabel]),
  }));
}

// ---------------------------------------------------------------------------
// Supplier items
// ---------------------------------------------------------------------------

function hydrateSupplierItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    supplierStatus: row.supplier_status,
    supplierLeadTimeDays: row.supplier_lead_time_days,
    currency: row.currency,
    itemCodeLabel: row.item_code_label || 'Supplier code',
    skuId: row.sku_id,
    itemId: row.item_id,
    displayName: row.variant_label ? `${row.item_name} / ${row.variant_label}` : row.item_name,
    itemName: row.item_name,
    variantLabel: row.variant_label,
    internalCode: row.internal_code,
    internalBaseCode: row.internal_base_code,
    unitLabel: row.unit_label,
    supplierSku: row.supplier_sku,
    supplierDescription: row.supplier_description,
    purchaseUnit: row.purchase_unit,
    unitsPerPurchaseUnit: row.units_per_purchase_unit,
    lastUnitCost: row.last_unit_cost,
    lastCostAt: row.last_cost_at,
    leadTimeDays: row.lead_time_days,
    minimumOrderQuantity: row.minimum_order_quantity,
    orderMultiple: row.order_multiple,
    isPreferred: Boolean(row.is_preferred),
    isActive: Boolean(row.is_active),
    notes: row.notes,
    // The lead time that actually applies: the item's, or the supplier's.
    effectiveLeadTimeDays: row.lead_time_days ?? row.supplier_lead_time_days ?? null,
  };
}

const SUPPLIER_ITEM_SELECT = `
  SELECT si.*, s.name AS supplier_name, s.status AS supplier_status,
         s.default_lead_time_days AS supplier_lead_time_days, s.currency, s.item_code_label,
         sk.item_id, sk.code AS internal_code, sk.variant_label,
         i.name AS item_name, i.base_code AS internal_base_code, i.unit_label
    FROM supplier_items si
    JOIN suppliers s ON s.id = si.supplier_id
    JOIN skus sk ON sk.id = si.sku_id
    JOIN items i ON i.id = sk.item_id`;

function linkItem(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_SUPPLIERS, 'manage suppliers');
  const supplier = getSupplier(db, ctx.workspaceId, input.supplierId);
  const sku = repo.requireSku(db, ctx.workspaceId, input.skuId);

  const unitsPer = optionalInt(input.unitsPerPurchaseUnit, 'Units per purchase unit', { min: 1, max: 100000 }) ?? 1;
  const purchaseUnit = trimOrNull(input.purchaseUnit) || 'unit';
  if (purchaseUnit.toLowerCase() === 'unit' && unitsPer !== 1) {
    throw new ValidationError(
      'A purchase unit of "unit" holds exactly one. Name the pack (case, box, pallet) if it holds more.',
      { field: 'purchaseUnit' }
    );
  }

  const now = nowIso();
  const existing = db
    .prepare('SELECT id FROM supplier_items WHERE workspace_id = ? AND supplier_id = ? AND sku_id = ?')
    .get(ctx.workspaceId, supplier.id, sku.id);

  const values = {
    supplierSku: trimOrNull(input.supplierSku),
    supplierDescription: trimOrNull(input.supplierDescription),
    purchaseUnit,
    unitsPer,
    lastUnitCost: optionalMoney(input.lastUnitCost, 'Unit cost'),
    leadTimeDays: optionalInt(input.leadTimeDays, 'Lead time', { max: MAX_LEAD_TIME_DAYS }),
    minimumOrderQuantity: optionalInt(input.minimumOrderQuantity, 'Minimum order quantity', { min: 0, max: 100000 }),
    orderMultiple: optionalInt(input.orderMultiple, 'Order multiple', { min: 1, max: 100000 }),
    isPreferred: input.isPreferred === true || input.isPreferred === 'on' || input.isPreferred === '1' ? 1 : 0,
    isActive: input.isActive === false || input.isActive === '0' ? 0 : 1,
    notes: trimOrNull(input.notes),
  };

  return inTransaction(db, () => {
    // One preferred supplier per product, or "preferred" means nothing.
    if (values.isPreferred) {
      db.prepare(
        'UPDATE supplier_items SET is_preferred = 0, updated_at = ? WHERE workspace_id = ? AND sku_id = ?'
      ).run(now, ctx.workspaceId, sku.id);
    }

    let supplierItemId;
    if (existing) {
      db.prepare(
        `UPDATE supplier_items
            SET supplier_sku = ?, supplier_description = ?, purchase_unit = ?, units_per_purchase_unit = ?,
                last_unit_cost = COALESCE(?, last_unit_cost),
                last_cost_at = CASE WHEN ? IS NULL THEN last_cost_at ELSE ? END,
                lead_time_days = ?, minimum_order_quantity = ?, order_multiple = ?,
                is_preferred = ?, is_active = ?, notes = ?, updated_at = ?
          WHERE id = ?`
      ).run(
        values.supplierSku, values.supplierDescription, values.purchaseUnit, values.unitsPer,
        values.lastUnitCost, values.lastUnitCost, now,
        values.leadTimeDays, values.minimumOrderQuantity, values.orderMultiple,
        values.isPreferred, values.isActive, values.notes, now, existing.id
      );
      supplierItemId = existing.id;
    } else {
      supplierItemId = newId('supi');
      db.prepare(
        `INSERT INTO supplier_items (
           id, workspace_id, supplier_id, sku_id, supplier_sku, supplier_description,
           purchase_unit, units_per_purchase_unit, last_unit_cost, last_cost_at, lead_time_days,
           minimum_order_quantity, order_multiple, is_preferred, is_active, notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        supplierItemId, ctx.workspaceId, supplier.id, sku.id, values.supplierSku, values.supplierDescription,
        values.purchaseUnit, values.unitsPer, values.lastUnitCost, values.lastUnitCost ? now : null,
        values.leadTimeDays, values.minimumOrderQuantity, values.orderMultiple,
        values.isPreferred, values.isActive, values.notes, now, now
      );
    }
    supplierCodeMappings.applySavedForSupplierItem(
      db, ctx, supplier.id, sku.id, values.supplierSku
    );
    return getSupplierItem(db, ctx.workspaceId, supplierItemId);
  });
}

function getSupplierItem(db, workspaceId, supplierItemId) {
  const row = db
    .prepare(`${SUPPLIER_ITEM_SELECT} WHERE si.id = ? AND si.workspace_id = ?`)
    .get(supplierItemId, workspaceId);
  if (!row) throw new NotFoundError('That supplier product is not in this inventory.');
  return hydrateSupplierItem(row);
}

function unlinkItem(db, ctx, membership, supplierItemId) {
  permissions.assertCan(membership, permissions.MANAGE_SUPPLIERS, 'manage suppliers');
  const existing = getSupplierItem(db, ctx.workspaceId, supplierItemId);
  db.prepare('UPDATE supplier_items SET is_active = 0, is_preferred = 0, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(nowIso(), existing.id, ctx.workspaceId);
  return getSupplierItem(db, ctx.workspaceId, supplierItemId);
}

/** Every supplier who sells this SKU, preferred first, then cheapest. */
function suppliersForSku(db, workspaceId, skuId, { includeInactive = false } = {}) {
  const clause = includeInactive ? '' : " AND si.is_active = 1 AND s.status = 'active'";
  return db
    .prepare(
      `${SUPPLIER_ITEM_SELECT}
        WHERE si.workspace_id = ? AND si.sku_id = ?${clause}
        ORDER BY si.is_preferred DESC, si.last_unit_cost IS NULL, si.last_unit_cost, s.name COLLATE NOCASE`
    )
    .all(workspaceId, skuId)
    .map(hydrateSupplierItem);
}

function itemsForSupplier(db, workspaceId, supplierId, { includeInactive = false } = {}) {
  const clause = includeInactive ? '' : ' AND si.is_active = 1';
  return db
    .prepare(
      `${SUPPLIER_ITEM_SELECT}
        WHERE si.workspace_id = ? AND si.supplier_id = ?${clause}
        ORDER BY i.name COLLATE NOCASE, sk.position`
    )
    .all(workspaceId, supplierId)
    .map(hydrateSupplierItem);
}

/**
 * Turns inventory units into whole purchase units, applying the supplier's own
 * rules in the order they actually bind: round up to a whole pack, then meet
 * the minimum, then land on an order multiple.
 *
 * Every step is returned rather than just the answer, because "why 48?" has to
 * be answerable without rerunning anything.
 */
function toPurchaseUnits(neededUnits, supplierItem) {
  const perUnit = Math.max(1, supplierItem.unitsPerPurchaseUnit || 1);
  const steps = [];

  let packs = Math.ceil(Math.max(0, neededUnits) / perUnit);
  steps.push({
    step: 'pack',
    detail:
      perUnit === 1
        ? `${neededUnits} needed, bought singly.`
        : `${neededUnits} needed ÷ ${perUnit} per ${supplierItem.purchaseUnit} = ${packs} ${supplierItem.purchaseUnit}(s), rounded up.`,
    value: packs,
  });

  const moq = supplierItem.minimumOrderQuantity || 0;
  if (moq && packs < moq) {
    packs = moq;
    steps.push({
      step: 'minimum',
      detail: `${supplierItem.supplierName || 'The supplier'} has a minimum of ${moq} ${supplierItem.purchaseUnit}(s).`,
      value: packs,
    });
  }

  const multiple = supplierItem.orderMultiple || 0;
  if (multiple > 1 && packs % multiple !== 0) {
    const rounded = Math.ceil(packs / multiple) * multiple;
    steps.push({
      step: 'multiple',
      detail: `Ordered in multiples of ${multiple}, so ${packs} rounds up to ${rounded}.`,
      value: rounded,
    });
    packs = rounded;
  }

  return {
    purchaseUnits: packs,
    units: packs * perUnit,
    unitsPerPurchaseUnit: perUnit,
    purchaseUnit: supplierItem.purchaseUnit,
    steps,
  };
}

module.exports = {
  STATUSES,
  COMMON_ITEM_CODE_ALIASES,
  hydrate,
  hydrateSupplierItem,
  createSupplier,
  updateSupplier,
  getSupplier,
  findSupplier,
  listSuppliers,
  listWithCounts,
  rememberItemCodeAlias,
  documentVocabulary,
  linkItem,
  unlinkItem,
  getSupplierItem,
  suppliersForSku,
  itemsForSupplier,
  toPurchaseUnits,
};

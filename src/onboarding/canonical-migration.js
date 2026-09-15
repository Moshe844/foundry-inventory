'use strict';

/**
 * Provider-neutral, evidence-first migration and cutover.
 *
 * A connector may translate any source into this contract. It may not write
 * catalog, stock, purchasing, sales or accounting tables itself. Each staged
 * record is immutable by hash, dependencies are resolved by external identity,
 * and cutover is impossible until material reconciliation checks agree.
 */

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const { newId, nowIso, requireText } = require('../lib/util');
const { ValidationError, NotFoundError, InvariantError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const locations = require('../domain/location-service');
const items = require('../domain/item-service');
const inventory = require('../domain/inventory-engine');
const suppliers = require('../purchasing/supplier-service');
const purchaseOrders = require('../purchasing/po-service');
const salesOrders = require('../sales/sales-order-service');
const pricing = require('../pricing/price-service');
const reorder = require('../purchasing/policy-service');
const attributes = require('../catalog/attributes');
const costing = require('../accounting/costing');

const TYPES = Object.freeze({
  location: 10,
  product: 20,
  sku: 25,
  sku_batch: 25,
  supplier: 30,
  customer: 30,
  attribute: 35,
  supplier_item: 40,
  selling_price: 45,
  purchase_cost: 45,
  reorder_policy: 50,
  purchase_order: 60,
  sales_order: 60,
  inventory_position: 70,
  history_fact: 80,
});

const materialTypes = new Set(Object.keys(TYPES).filter((type) => type !== 'history_fact'));
const MISSING_SERIAL_DECISION = 'missing_serial_identities';
const USE_AGGREGATE_QUANTITY = 'USE_AGGREGATE_QUANTITY_TRACKING';

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}
const hash = (value) => crypto.createHash('sha256').update(stable(value)).digest('hex');
const parse = (value, fallback = {}) => {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};
const normalizedIdentity = (value) => String(value || '').trim().toLowerCase()
  .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const skuCodeAlias = (code) => code ? `sku:${normalizedIdentity(code)}` : null;
const LOCATION_KIND_ALIASES = Object.freeze({
  warehouse:'warehouse', distributioncenter:'warehouse', distributioncentre:'warehouse', dc:'warehouse',
  store:'store', retailstore:'store', shop:'store',
  stockroom:'stockroom', storeroom:'stockroom',
  truck:'truck', vehicle:'truck',
  office:'office',
  zone:'zone', aisle:'aisle', shelf:'shelf', bin:'bin', dock:'dock', staging:'staging', other:'other',
});

/** Source labels are evidence, but capitalization and common display labels
 * are not business judgments. Normalize only exact, well-known synonyms; an
 * unfamiliar kind remains "other" and its original value stays in the staged
 * evidence instead of breaking a 500k-record cutover at the first location. */
function canonicalLocationKind(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g,'');
  return LOCATION_KIND_ALIASES[key] || 'other';
}

function hydratePackage(row) {
  if (!row) return null;
  return {
    id: row.id, workspaceId: row.workspace_id, sourceNamespace: row.source_namespace,
    sourceLabel: row.source_label, status: row.status, manifest: parse(row.manifest_json),
    sourceSnapshotHash: row.source_snapshot_hash, stagedCount: row.staged_count,
    cutoverMode: row.cutover_mode || 'STATIC', sourceSnapshotAt: row.source_snapshot_at,
    sourceCheckpoint: row.source_checkpoint, deltaStartedAt: row.delta_started_at,
    finalCheckpoint: row.final_checkpoint, sourceFrozenAt: row.source_frozen_at,
    appliedCount: row.applied_count, problemCount: row.problem_count,
    preparationStatus: row.preparation_status || 'IDLE',
    preparationStage: row.preparation_stage || null,
    preparationCompleted: Number(row.preparation_completed || 0),
    preparationTotal: Number(row.preparation_total || 0),
    preparationDetail: row.preparation_detail || null,
    preparationError: row.preparation_error || null,
    approvedAt: row.approved_at, verifiedAt: row.verified_at, cutoverAt: row.cutover_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function getPackage(db, workspaceId, packageId) {
  const row = db.prepare('SELECT * FROM migration_packages WHERE id = ? AND workspace_id = ?')
    .get(packageId, workspaceId);
  if (!row) throw new NotFoundError('That migration package is not in this inventory.');
  return hydratePackage(row);
}

function listPackages(db, workspaceId, limit = 100) {
  return db.prepare(`SELECT * FROM migration_packages WHERE workspace_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(workspaceId, Math.min(500, Math.max(1, Number(limit))))
    .map(hydratePackage);
}

function createPackage(db, ctx, membership, input = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'prepare an inventory migration');
  const sourceNamespace = requireText(input.sourceNamespace, 'Source identity', { max: 160 });
  const sourceLabel = requireText(input.sourceLabel || sourceNamespace, 'Source name', { max: 160 });
  const manifest = input.manifest && typeof input.manifest === 'object' ? input.manifest : {};
  const cutoverMode = String(input.cutoverMode || 'STATIC').trim().toUpperCase();
  if (!['STATIC','SNAPSHOT_DELTA'].includes(cutoverMode)) throw new ValidationError('Cutover mode must be STATIC or SNAPSHOT_DELTA.');
  const sourceCheckpoint = input.sourceCheckpoint ? requireText(input.sourceCheckpoint, 'Source checkpoint', { max:500 }) : null;
  const sourceSnapshotAt = input.sourceSnapshotAt || nowIso();
  if (cutoverMode === 'SNAPSHOT_DELTA' && !sourceCheckpoint) {
    throw new ValidationError('A live source needs its starting checkpoint before records are staged.');
  }
  const snapshot = input.sourceSnapshotHash || hash(manifest);
  const existing = db.prepare(`SELECT * FROM migration_packages
    WHERE workspace_id = ? AND source_namespace = ? AND source_snapshot_hash = ?`)
    .get(ctx.workspaceId, sourceNamespace, snapshot);
  if (existing) return { ...hydratePackage(existing), replayed: true };
  const now = nowIso();
  const id = newId('mig');
  db.prepare(`INSERT INTO migration_packages
    (id, workspace_id, source_namespace, source_label, status, manifest_json,
     source_snapshot_hash, cutover_mode, source_snapshot_at, source_checkpoint,
     created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'STAGING', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, sourceNamespace, sourceLabel, stable(manifest), snapshot,
      cutoverMode, sourceSnapshotAt, sourceCheckpoint, ctx.actorId || null, now, now);
  recordCheckpoint(db, ctx, id, 'SNAPSHOT', sourceCheckpoint, {
    snapshotAt:sourceSnapshotAt, snapshotHash:snapshot, cutoverMode,
  });
  return getPackage(db, ctx.workspaceId, id);
}

function recordCheckpoint(db, ctx, packageId, kind, cursor, evidence = {}) {
  const now = nowIso(); const evidenceJson = stable(evidence); const evidenceHash = hash({ kind, cursor:cursor || null, evidence });
  const prior = db.prepare('SELECT evidence_hash FROM migration_cutover_checkpoints WHERE package_id=? AND checkpoint_kind=?')
    .get(packageId,kind);
  if (prior) {
    if (prior.evidence_hash !== evidenceHash) throw new InvariantError(`${kind} checkpoint evidence changed after it was recorded.`, 'migration_checkpoint_changed');
    return;
  }
  db.prepare(`INSERT INTO migration_cutover_checkpoints
    (id,workspace_id,package_id,checkpoint_kind,source_cursor,evidence_hash,evidence_json,recorded_by_user_id,recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(newId('mcp'),ctx.workspaceId,packageId,kind,cursor || null,evidenceHash,evidenceJson,ctx.actorId || null,now);
}

function beginDeltaCapture(db, ctx, membership, packageId, input = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'capture source changes');
  const pkg = getPackage(db,ctx.workspaceId,packageId);
  if (pkg.cutoverMode !== 'SNAPSHOT_DELTA') throw new InvariantError('An immutable snapshot does not need delta capture.', 'migration_delta_not_required');
  if (!['STAGING','NEEDS_ATTENTION'].includes(pkg.status) || pkg.sourceFrozenAt) throw new InvariantError('Delta capture is no longer open.', 'migration_delta_closed');
  const cursor = requireText(input.sourceCursor || pkg.sourceCheckpoint, 'Delta start checkpoint', { max:500 });
  if (pkg.deltaStartedAt) return { ...pkg, replayed:true };
  const now = nowIso();
  inTransaction(db, () => {
    recordCheckpoint(db,ctx,packageId,'DELTA_START',cursor,{ afterSnapshot:true });
    db.prepare('UPDATE migration_packages SET delta_started_at=?,updated_at=? WHERE id=?').run(now,now,packageId);
  });
  return getPackage(db,ctx.workspaceId,packageId);
}

/** Consolidates a bounded, ordered delta page into final staged source truth. */
function stageDeltaPage(db, ctx, membership, packageId, sourceCursor, changes, { startOrdinal = 0 } = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'capture source changes');
  const pkg = getPackage(db,ctx.workspaceId,packageId);
  if (pkg.cutoverMode !== 'SNAPSHOT_DELTA' || !pkg.deltaStartedAt || pkg.sourceFrozenAt) {
    throw new InvariantError('Start delta capture before staging changes, and stop after the source is frozen.', 'migration_delta_closed');
  }
  const cursor = requireText(sourceCursor, 'Source change checkpoint', { max:500 });
  if (!Array.isArray(changes) || !changes.length || changes.length > 5000) throw new ValidationError('Stage 1–5,000 source changes at a time.');
  let changed = 0; const now = nowIso();
  inTransaction(db, () => {
    changes.forEach((raw,index) => {
      const operation = String(raw.operation || 'UPSERT').toUpperCase();
      if (!['UPSERT','DELETE'].includes(operation)) throw new ValidationError('A source change must be UPSERT or DELETE.');
      const record = operation === 'UPSERT' ? normaliseRecord(raw.record || raw,startOrdinal + index) : {
        entityType:String(raw.entityType || '').trim().toLowerCase(),
        sourceKey:requireText(raw.sourceKey,'Source record key',{ max:300 }), sourceVersion:raw.sourceVersion || null,
      };
      if (!Object.hasOwn(TYPES,record.entityType)) throw new ValidationError(`Migration entity type "${record.entityType}" is not registered.`);
      const changeHash = hash({ cursor,operation,record });
      const priorChange = db.prepare(`SELECT change_hash FROM migration_source_changes
        WHERE package_id=? AND source_cursor=? AND entity_type=? AND source_key=? AND operation=?`)
        .get(packageId,cursor,record.entityType,record.sourceKey,operation);
      if (priorChange) {
        if (priorChange.change_hash !== changeHash) throw new InvariantError('A source cursor replayed with different evidence.', 'migration_delta_changed');
        return;
      }
      db.prepare(`INSERT INTO migration_source_changes
        (id,workspace_id,package_id,source_cursor,entity_type,source_key,operation,source_version,payload_json,payload_hash,change_hash,ordinal,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(newId('mdelta'),ctx.workspaceId,packageId,cursor,record.entityType,
          record.sourceKey,operation,record.sourceVersion,operation === 'UPSERT' ? stable(record.payload) : null,
          operation === 'UPSERT' ? record.payloadHash : null,changeHash,startOrdinal + index,now);
      const existing = db.prepare('SELECT id,status FROM migration_records WHERE package_id=? AND entity_type=? AND source_key=?')
        .get(packageId,record.entityType,record.sourceKey);
      if (existing && !['STAGED','VALID','BLOCKED'].includes(existing.status)) throw new InvariantError('Source changed after operational application began.', 'migration_delta_too_late');
      if (operation === 'DELETE') {
        if (existing) db.prepare('DELETE FROM migration_records WHERE id=?').run(existing.id);
      } else if (existing) {
        db.prepare(`UPDATE migration_records SET source_version=?,payload_json=?,payload_hash=?,status='STAGED',
          issue_code=NULL,issue_detail=NULL,ordinal=?,updated_at=? WHERE id=?`).run(record.sourceVersion,stable(record.payload),
            record.payloadHash,startOrdinal + index,now,existing.id);
      } else {
        db.prepare(`INSERT INTO migration_records
          (id,workspace_id,package_id,entity_type,source_key,source_version,payload_json,payload_hash,status,ordinal,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,'STAGED',?,?,?)`).run(newId('mrec'),ctx.workspaceId,packageId,record.entityType,
            record.sourceKey,record.sourceVersion,stable(record.payload),record.payloadHash,startOrdinal + index,now,now);
      }
      changed += 1;
    });
    db.prepare(`UPDATE migration_packages SET staged_count=(SELECT COUNT(*) FROM migration_records WHERE package_id=?),updated_at=? WHERE id=?`)
      .run(packageId,now,packageId);
  });
  return { package:getPackage(db,ctx.workspaceId,packageId), changed };
}

function freezeSource(db, ctx, membership, packageId, input = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'freeze the migration source');
  const pkg = getPackage(db,ctx.workspaceId,packageId);
  if (pkg.cutoverMode !== 'SNAPSHOT_DELTA') throw new InvariantError('Static snapshot evidence is already immutable.', 'migration_freeze_not_required');
  if (!pkg.deltaStartedAt) throw new InvariantError('Start delta capture before freezing the source.', 'migration_delta_not_started');
  const cursor = requireText(input.finalCheckpoint, 'Final source checkpoint', { max:500 });
  if (pkg.sourceFrozenAt) {
    if (pkg.finalCheckpoint !== cursor) throw new InvariantError('The final source checkpoint cannot be changed.', 'migration_checkpoint_changed');
    return { ...pkg,replayed:true };
  }
  const now = nowIso();
  inTransaction(db, () => {
    recordCheckpoint(db,ctx,packageId,'SOURCE_FROZEN',cursor,{ confirmedByOwner:true, note:String(input.evidence || '').slice(0,500) });
    recordCheckpoint(db,ctx,packageId,'FINAL',cursor,{ allChangesThroughCursorCaptured:true });
    db.prepare('UPDATE migration_packages SET final_checkpoint=?,source_frozen_at=?,updated_at=? WHERE id=?')
      .run(cursor,now,now,packageId);
  });
  return getPackage(db,ctx.workspaceId,packageId);
}

function normaliseRecord(record, ordinal) {
  const entityType = String(record.entityType || '').trim().toLowerCase();
  if (!Object.hasOwn(TYPES, entityType)) {
    throw new ValidationError(`Migration entity type "${entityType || 'blank'}" is not registered.`);
  }
  const sourceKey = requireText(record.sourceKey, 'Source record key', { max: 300 });
  const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
    ? record.payload : null;
  if (!payload) throw new ValidationError(`${entityType} ${sourceKey} has no structured payload.`);
  return { entityType, sourceKey, sourceVersion: record.sourceVersion || null,
    payload, payloadHash: hash(payload), ordinal: Number.isSafeInteger(ordinal) ? ordinal : 0 };
}

const ENRICHABLE_REFERENCE_TYPES = new Set(['location','product','sku','supplier','customer']);
const isBlankEvidence = (value) => value === null || value === undefined || value === '';

function mergeCompatibleReference(type, left, right) {
  if (!ENRICHABLE_REFERENCE_TYPES.has(type)) return null;
  const merged = { ...left };
  for (const [key,value] of Object.entries(right)) {
    if (isBlankEvidence(value)) continue;
    if (isBlankEvidence(merged[key])) { merged[key] = value; continue; }
    if (stable(merged[key]) === stable(value)) continue;
    if (key === 'attributes' && Array.isArray(merged[key]) && Array.isArray(value)) {
      const byKey = new Map(merged[key].map((entry) => [String(entry.key || ''),entry]));
      for (const entry of value) {
        const prior = byKey.get(String(entry.key || ''));
        if (prior && stable(prior) !== stable(entry)) return null;
        if (!prior) { merged[key].push(entry); byKey.set(String(entry.key || ''),entry); }
      }
      continue;
    }
    return null;
  }
  return merged;
}

/** Stages one bounded page. Replays are accepted when the bytes agree. A
 * compatible master-data row may also enrich an earlier name-only reference;
 * contradictory values still stop the migration. */
function stagePage(db, ctx, membership, packageId, records, { startOrdinal = 0 } = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'prepare an inventory migration');
  const pkg = getPackage(db, ctx.workspaceId, packageId);
  if (!['STAGING', 'NEEDS_ATTENTION'].includes(pkg.status)) {
    throw new InvariantError('This migration is no longer accepting source records.', 'migration_not_staging');
  }
  if (!Array.isArray(records) || !records.length) throw new ValidationError('Stage at least one source record.');
  if (records.length > 5000) throw new ValidationError('Stage migration records in pages of 5,000 or fewer.');
  const now = nowIso();
  let inserted = 0;
  let enriched = 0;
  inTransaction(db, () => {
    records.forEach((raw, index) => {
      const record = normaliseRecord(raw, startOrdinal + index);
      const prior = db.prepare(`SELECT id,payload_json,payload_hash,status FROM migration_records
        WHERE package_id = ? AND entity_type = ? AND source_key = ?`)
        .get(packageId, record.entityType, record.sourceKey);
      if (prior) {
        if (prior.payload_hash !== record.payloadHash) {
          const merged = prior.status === 'STAGED'
            ? mergeCompatibleReference(record.entityType,parse(prior.payload_json),record.payload) : null;
          if (!merged) {
            throw new InvariantError(`${record.entityType} ${record.sourceKey} changed inside the same source snapshot.`,
              'migration_source_changed');
          }
          db.prepare(`UPDATE migration_records SET payload_json=?,payload_hash=?,updated_at=? WHERE id=?`)
            .run(stable(merged),hash(merged),now,prior.id);
          enriched += 1;
        }
        return;
      }
      db.prepare(`INSERT INTO migration_records
        (id, workspace_id, package_id, entity_type, source_key, source_version,
         payload_json, payload_hash, status, ordinal, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STAGED', ?, ?, ?)`)
        .run(newId('mrec'), ctx.workspaceId, packageId, record.entityType, record.sourceKey,
          record.sourceVersion, stable(record.payload), record.payloadHash, record.ordinal, now, now);
      inserted += 1;
    });
    db.prepare(`UPDATE migration_packages SET staged_count =
      (SELECT COUNT(*) FROM migration_records WHERE package_id = ?), updated_at = ? WHERE id = ?`)
      .run(packageId, now, packageId);
  });
  return { package: getPackage(db, ctx.workspaceId, packageId), inserted, enriched };
}

function dependencyKeys(type, payload) {
  const refs = [];
  const add = (entityType, sourceKey, field) => { if (sourceKey) refs.push({ entityType, sourceKey, field }); };
  if (type === 'location') add('location', payload.parentLocationKey, 'parentLocationKey');
  if (type === 'sku' || type === 'sku_batch') add('product', payload.productKey, 'productKey');
  if (type === 'attribute') add(payload.subjectType, payload.subjectKey, 'subjectKey');
  if (type === 'supplier_item') { add('supplier', payload.supplierKey, 'supplierKey'); add('sku', payload.skuKey, 'skuKey'); }
  if (['selling_price', 'purchase_cost', 'reorder_policy'].includes(type)) add('sku', payload.skuKey, 'skuKey');
  if (type === 'reorder_policy') {
    add('location', payload.locationKey, 'locationKey'); add('supplier', payload.preferredSupplierKey, 'preferredSupplierKey');
  }
  if (type === 'purchase_order') {
    add('supplier', payload.supplierKey, 'supplierKey'); add('location', payload.destinationLocationKey, 'destinationLocationKey');
    for (const line of payload.lines || []) add('sku', line.skuKey, 'lines.skuKey');
  }
  if (type === 'sales_order') {
    add('customer', payload.customerKey, 'customerKey'); add('location', payload.fulfillmentLocationKey, 'fulfillmentLocationKey');
    for (const line of payload.lines || []) add('sku', line.skuKey, 'lines.skuKey');
  }
  if (type === 'inventory_position') {
    add('sku', payload.skuKey, 'skuKey'); add('location', payload.locationKey, 'locationKey');
  }
  return refs;
}

function availableKeys(db, pkg) {
  const keys = new Set();
  for (const row of db.prepare('SELECT entity_type, source_key, payload_json FROM migration_records WHERE package_id = ?').all(pkg.id)) {
    keys.add(`${row.entity_type}:${row.source_key}`);
    const payload = parse(row.payload_json);
    if (row.entity_type === 'sku' && payload.code) keys.add(`sku:${skuCodeAlias(payload.code)}`);
    if (row.entity_type === 'product' || row.entity_type === 'sku_batch') {
      for (const variant of payload.variants || []) {
        if (variant.sourceKey) keys.add(`sku:${variant.sourceKey}`);
        if (variant.code) keys.add(`sku:${skuCodeAlias(variant.code)}`);
      }
    }
  }
  for (const row of db.prepare(`SELECT entity_type, external_key FROM external_identity_maps
    WHERE workspace_id = ? AND source_namespace = ?`).all(pkg.workspaceId, pkg.sourceNamespace)) {
    keys.add(`${row.entity_type}:${row.external_key}`);
  }
  return keys;
}

function basicIssue(type, payload) {
  if (type === 'location' && !payload.name) return 'Location name is missing.';
  if (type === 'product' && !payload.name) return 'Product name is missing.';
  if (type === 'sku' && !payload.productKey) return 'The SKU product reference is missing.';
  if (type === 'sku_batch' && (!payload.productKey || !Array.isArray(payload.variants)
      || !payload.variants.length || payload.variants.length > 5000)) {
    return 'The SKU page needs a product reference and 1–5,000 exact variants.';
  }
  if (type === 'supplier' && !payload.name) return 'Supplier name is missing.';
  if (type === 'customer' && !payload.name) return 'Customer name is missing.';
  if (type === 'attribute' && (!payload.subjectType || !payload.subjectKey || !payload.key)) return 'Attribute subject or name is missing.';
  if (type === 'inventory_position') {
    const serialCount = Array.isArray(payload.serials) ? payload.serials.length : 0;
    const quantity = payload.quantity === undefined || payload.quantity === null ? serialCount : Number(payload.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 0) return 'Inventory quantity must be a non-negative whole number.';
    if (serialCount && payload.quantity !== undefined && quantity !== serialCount) {
      return 'Serial-tracked quantity must equal the number of exact serial identities.';
    }
    const reserved = Number(payload.reservedQuantity || 0);
    const damaged = Number(payload.damagedQuantity || 0);
    if (![reserved,damaged].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      return 'Reserved and damaged quantities must be non-negative whole numbers.';
    }
    if (reserved + damaged > quantity) return 'Reserved and damaged quantities cannot exceed physical on-hand stock.';
    if (payload.availableQuantity != null && Number(payload.availableQuantity) !== quantity - reserved - damaged) {
      return 'Available quantity does not equal on hand minus reserved and damaged.';
    }
    if (payload.inventoryValue != null) {
      const valueMinor = Math.round(Number(payload.inventoryValue) * 100);
      if (!Number.isSafeInteger(valueMinor) || valueMinor < 0 || (quantity === 0 && valueMinor !== 0)) {
        return 'Inventory value must be a non-negative amount and zero when on-hand quantity is zero.';
      }
    }
  }
  if (['purchase_order', 'sales_order'].includes(type) && (!Array.isArray(payload.lines) || !payload.lines.length)) return 'Order lines are missing.';
  return null;
}

function missingSerialEvidence(db, packageId) {
  const serialProducts = new Map();
  for (const row of db.prepare(`SELECT source_key,payload_json,target_id,status FROM migration_records
    WHERE package_id=? AND entity_type='product'`).all(packageId)) {
    const payload = parse(row.payload_json);
    if (payload.trackingMode === 'serial') serialProducts.set(row.source_key,{
      sourceKey:row.source_key,name:payload.name || row.source_key,targetId:row.target_id,status:row.status,
      positions:0,quantity:0,exactSerials:0,samples:[],recordIds:[],
    });
  }
  if (!serialProducts.size) return { products:[],productKeys:[],positionCount:0,quantity:0,exactSerials:0,canUseAggregateQuantity:false };
  const skuProducts = new Map();
  for (const row of db.prepare(`SELECT source_key,payload_json FROM migration_records
    WHERE package_id=? AND entity_type='sku'`).all(packageId)) {
    const productKey = parse(row.payload_json).productKey;
    if (serialProducts.has(productKey)) skuProducts.set(row.source_key,productKey);
  }
  for (const row of db.prepare(`SELECT id,source_key,payload_json,status FROM migration_records
    WHERE package_id=? AND entity_type='inventory_position'`).all(packageId)) {
    const payload = parse(row.payload_json);
    const product = serialProducts.get(skuProducts.get(payload.skuKey));
    if (!product) continue;
    const serials = Array.isArray(payload.serials) ? payload.serials.filter((entry) => entry && entry.serial) : [];
    if (serials.length) {
      product.exactSerials += serials.length;
      continue;
    }
    const quantity = Number(payload.quantity || 0);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) continue;
    product.positions += 1;
    product.quantity += quantity;
    product.recordIds.push(row.id);
    if (product.samples.length < 3) product.samples.push({
      sourceKey:row.source_key,skuKey:payload.skuKey,locationKey:payload.locationKey,quantity,
    });
  }
  const products = [...serialProducts.values()].filter((entry) => entry.positions > 0);
  return {
    products,
    productKeys:products.map((entry) => entry.sourceKey),
    positionCount:products.reduce((sum,entry) => sum + entry.positions,0),
    quantity:products.reduce((sum,entry) => sum + entry.quantity,0),
    exactSerials:products.reduce((sum,entry) => sum + entry.exactSerials,0),
    canUseAggregateQuantity:products.length > 0 && products.every((entry) => entry.exactSerials === 0),
  };
}

function serialResolution(db,packageId) {
  const row = db.prepare(`SELECT choice,evidence_json,decided_at FROM migration_source_decisions
    WHERE package_id=? AND decision_key=?`).get(packageId,MISSING_SERIAL_DECISION);
  return row ? { choice:row.choice,evidence:parse(row.evidence_json),decidedAt:row.decided_at } : null;
}

function quantityTrackingProductKeys(db,pkg) {
  if (!pkg._quantityTrackingProductKeys) {
    const decision = serialResolution(db,pkg.id);
    pkg._quantityTrackingProductKeys = new Set(decision && decision.choice === USE_AGGREGATE_QUANTITY
      ? decision.evidence.productKeys || [] : []);
  }
  return pkg._quantityTrackingProductKeys;
}

function resolveMissingSerialEvidence(db,ctx,membership,packageId,choice) {
  permissions.assertCan(membership,permissions.ADMIN,'resolve missing serial identity evidence');
  if (choice !== USE_AGGREGATE_QUANTITY) {
    throw new ValidationError('Choose whether to keep the proven aggregate quantities, or upload the exact serial identities.');
  }
  const pkg = getPackage(db,ctx.workspaceId,packageId);
  if (!['NEEDS_ATTENTION','FAILED'].includes(pkg.status)) {
    throw new InvariantError('This migration does not currently need a tracking-evidence decision.',
      'migration_tracking_resolution_not_needed');
  }
  const evidence = missingSerialEvidence(db,packageId);
  if (!evidence.products.length) throw new InvariantError('No unresolved serial-tracking source records were found.',
    'migration_tracking_resolution_not_found');
  if (!evidence.canUseAggregateQuantity) {
    throw new InvariantError('This source also contains exact serial identities. Supply the missing identities instead; Foundry will not discard the existing ones.',
      'migration_mixed_serial_evidence');
  }
  const decidedAt = nowIso();
  const storedEvidence = {
    sourceTrackingMode:'serial',effectiveTrackingMode:'quantity',productKeys:evidence.productKeys,
    affectedProducts:evidence.products.length,affectedPositions:evidence.positionCount,
    provenQuantity:evidence.quantity,samples:evidence.products.slice(0,5).flatMap((entry) => entry.samples.slice(0,1)),
    explanation:'The source proves aggregate quantities but contains no exact serial identities. Quantities are retained; serial tracking begins only after identities are supplied.',
  };
  inTransaction(db,() => {
    db.prepare(`INSERT INTO migration_source_decisions
      (id,workspace_id,package_id,decision_key,choice,evidence_json,decided_by_user_id,decided_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(package_id,decision_key) DO UPDATE SET
      choice=excluded.choice,evidence_json=excluded.evidence_json,decided_by_user_id=excluded.decided_by_user_id,
      decided_at=excluded.decided_at`).run(newId('mdec'),ctx.workspaceId,packageId,MISSING_SERIAL_DECISION,
        choice,stable(storedEvidence),ctx.actorId || null,decidedAt);
    const migrationCtx = { ...ctx,verifiedMigration:true };
    for (const product of evidence.products) {
      if (product.targetId) items.correctTrackingModeForMigration(db,migrationCtx,product.targetId,{ from:'serial',to:'quantity' });
      for (const recordId of product.recordIds) {
        db.prepare(`UPDATE migration_records SET status='VALID',issue_code=NULL,issue_detail=NULL,updated_at=?
          WHERE id=? AND status IN ('BLOCKED','FAILED')`).run(decidedAt,recordId);
      }
    }
    const problems = db.prepare(`SELECT COUNT(*) AS n FROM migration_records
      WHERE package_id=? AND status IN ('BLOCKED','FAILED')`).get(packageId).n;
    const nextStatus = problems ? pkg.status : pkg.approvedAt ? 'APPROVED' : 'READY';
    db.prepare(`UPDATE migration_packages SET status=?,problem_count=?,updated_at=? WHERE id=?`)
      .run(nextStatus,problems,decidedAt,packageId);
  });
  return { package:getPackage(db,ctx.workspaceId,packageId),evidence:storedEvidence };
}

function validate(db, ctx, membership, packageId) {
  permissions.assertCan(membership, permissions.ADMIN, 'validate an inventory migration');
  const pkg = getPackage(db, ctx.workspaceId, packageId);
  if (!['STAGING', 'NEEDS_ATTENTION', 'READY'].includes(pkg.status)) {
    throw new InvariantError('This migration cannot be validated in its current state.', 'migration_not_validatable');
  }
  if (pkg.cutoverMode === 'SNAPSHOT_DELTA' && (!pkg.deltaStartedAt || !pkg.sourceFrozenAt || !pkg.finalCheckpoint)) {
    throw new InvariantError('Capture source changes, freeze the source, and record its final checkpoint before validation.', 'migration_source_not_frozen');
  }
  const unstagedOwnerDatasets = db.prepare(`SELECT COUNT(*) AS n FROM migration_source_datasets
    WHERE package_id=? AND status<>'STAGED'`).get(packageId).n;
  if (unstagedOwnerDatasets) throw new InvariantError('Review and stage every uploaded dataset before validating the migration.', 'migration_datasets_not_staged');
  const unapprovedMappings = db.prepare(`SELECT COUNT(*) AS n FROM migration_mapping_profiles
    WHERE package_id=? AND status<>'APPROVED'`).get(packageId).n;
  if (unapprovedMappings) throw new InvariantError('Approve every source mapping before validating the migration.', 'migration_mapping_not_approved');
  const keys = availableKeys(db, pkg);
  const rows = db.prepare('SELECT * FROM migration_records WHERE package_id = ? ORDER BY ordinal, id').all(packageId);
  if (!rows.length) throw new ValidationError('The migration package is empty.');
  const serialEvidence = missingSerialEvidence(db,packageId);
  const serialProductBySku = new Map();
  const serialProductKeys = new Set(serialEvidence.productKeys);
  for (const row of rows) if (row.entity_type === 'sku') {
    const payload = parse(row.payload_json);
    if (serialProductKeys.has(payload.productKey)) serialProductBySku.set(row.source_key,payload.productKey);
  }
  const resolvedSerialProducts = quantityTrackingProductKeys(db,pkg);
  let sourceIncoming = 0; let sourceIncomingClaimed = false; let poIncoming = 0; let financialMismatch = 0;
  for (const row of rows) {
    const payload = parse(row.payload_json);
    if (row.entity_type === 'inventory_position' && payload.incomingQuantity != null) {
      sourceIncomingClaimed = true;
      sourceIncoming += Number(payload.incomingQuantity || 0);
    }
    if (row.entity_type === 'purchase_order') {
      poIncoming += (payload.lines || []).reduce((sum,line) => sum + Number(line.quantityUnits || 0),0);
      const money = payload.sourceFinancialEvidence || {};
      if (money.total != null && money.subtotal != null
          && Math.abs(Number(money.total) - Number(money.subtotal) - Number(money.shipping || 0) - Number(money.tax || 0)) > 0.011) financialMismatch += 1;
      if (money.subtotal != null && money.lineTotal != null
          && Math.abs(Number(money.subtotal) - Number(money.lineTotal)) > 0.011) financialMismatch += 1;
    }
  }
  if (((sourceIncomingClaimed && sourceIncoming !== poIncoming) || financialMismatch > 0)
      && !db.prepare(`SELECT 1 FROM migration_source_decisions WHERE package_id=? AND decision_key='operational_truth'`)
        .get(packageId)) {
    throw new InvariantError('The workbook summaries disagree with its detailed records. Choose which source should control operations before verification.','migration_source_truth_unresolved');
  }
  let problems = 0;
  const now = nowIso();
  inTransaction(db, () => {
    for (const row of rows) {
      const payload = parse(row.payload_json);
      let issue = basicIssue(row.entity_type, payload);
      if (!issue && row.entity_type === 'inventory_position') {
        const productKey = serialProductBySku.get(payload.skuKey);
        const serials = Array.isArray(payload.serials) ? payload.serials.filter((entry) => entry && entry.serial) : [];
        if (productKey && Number(payload.quantity || 0) > 0 && !serials.length
            && !resolvedSerialProducts.has(productKey)) {
          issue = 'This product is marked serial-tracked, but the source supplies only an aggregate quantity and no exact serial identities.';
        }
      }
      if (!issue) {
        const missing = dependencyKeys(row.entity_type, payload)
          .filter((ref) => !keys.has(`${ref.entityType}:${ref.sourceKey}`));
        if (missing.length) issue = `Unknown source reference: ${missing.map((ref) => `${ref.field}=${ref.sourceKey}`).join(', ')}.`;
      }
      const status = issue ? 'BLOCKED' : 'VALID';
      if (issue) problems += 1;
      const issueCode = issue && row.entity_type === 'inventory_position'
        && /marked serial-tracked/.test(issue) ? 'SERIAL_IDENTITIES_MISSING' : issue ? 'INVALID_OR_MISSING_EVIDENCE' : null;
      db.prepare(`UPDATE migration_records SET status = ?, issue_code = ?, issue_detail = ?, updated_at = ? WHERE id = ?`)
        .run(status, issueCode, issue, now, row.id);
    }
    db.prepare(`UPDATE migration_packages SET status = ?, problem_count = ?, updated_at = ? WHERE id = ?`)
      .run(problems ? 'NEEDS_ATTENTION' : 'READY', problems, now, packageId);
  });
  return { package: getPackage(db, ctx.workspaceId, packageId), problems };
}

function approve(db, ctx, membership, packageId) {
  permissions.assertCan(membership, permissions.ADMIN, 'approve an inventory cutover');
  const pkg = getPackage(db, ctx.workspaceId, packageId);
  if (pkg.status !== 'READY') throw new InvariantError('Resolve every migration problem before approval.', 'migration_not_ready');
  const now = nowIso();
  db.prepare(`UPDATE migration_packages SET status = 'APPROVED', approved_by_user_id = ?, approved_at = ?, updated_at = ? WHERE id = ?`)
    .run(ctx.actorId || null, now, now, packageId);
  return getPackage(db, ctx.workspaceId, packageId);
}

/** Put the package in its durable working state before a background worker is
 * started. The redirect can therefore never render the old approval action
 * beside a banner claiming that the switch is already running. */
function beginCutover(db, ctx, membership, packageId) {
  let pkg = getPackage(db,ctx.workspaceId,packageId);
  if (pkg.status === 'CUTOVER_ACTIVE' || pkg.status === 'APPLYING') return pkg;
  if (pkg.status === 'READY') pkg = approve(db,ctx,membership,packageId);
  if (!['APPROVED','FAILED'].includes(pkg.status)) {
    throw new InvariantError('Validate the complete source before approving the switch.','migration_not_ready');
  }
  db.prepare("UPDATE migration_packages SET status='APPLYING',updated_at=? WHERE id=?")
    .run(nowIso(),packageId);
  return getPackage(db,ctx.workspaceId,packageId);
}

function setPreparationProgress(db, workspaceId, packageId, update = {}) {
  getPackage(db,workspaceId,packageId);
  const status = String(update.status || 'RUNNING').toUpperCase();
  if (!['IDLE','RUNNING','WAITING','DONE','FAILED'].includes(status)) {
    throw new ValidationError('Migration preparation status is invalid.');
  }
  const completed = Math.max(0,Number(update.completed || 0));
  const total = Math.max(completed,Number(update.total || 0));
  db.prepare(`UPDATE migration_packages SET preparation_status=?,preparation_stage=?,
    preparation_completed=?,preparation_total=?,preparation_detail=?,preparation_error=?,updated_at=?
    WHERE id=? AND workspace_id=?`).run(status,update.stage || null,completed,total,
      update.detail || null,update.error || null,nowIso(),packageId,workspaceId);
  return getPackage(db,workspaceId,packageId);
}

function identity(db, pkg, type, key) {
  if (!key) return null;
  const row = db.prepare(`SELECT local_id FROM external_identity_maps
    WHERE workspace_id = ? AND source_namespace = ? AND entity_type = ? AND external_key = ?`)
    .get(pkg.workspaceId, pkg.sourceNamespace, type, key);
  if (!row) throw new ValidationError(`Migration reference ${type}:${key} has not been applied yet.`);
  return row.local_id;
}

function remember(db, pkg, record, mapped) {
  const identities = mapped.identities || [{ entityType: record.entity_type,
    externalKey: record.source_key, localType: mapped.targetType || record.entity_type, localId: mapped.targetId }];
  const now = nowIso();
  for (const entry of identities) {
    const prior = db.prepare(`SELECT * FROM external_identity_maps WHERE workspace_id = ? AND source_namespace = ?
      AND entity_type = ? AND external_key = ?`).get(pkg.workspaceId, pkg.sourceNamespace, entry.entityType, entry.externalKey);
    if (prior && (prior.local_id !== entry.localId || prior.evidence_hash !== record.payload_hash)) {
      throw new InvariantError(`External identity ${entry.entityType}:${entry.externalKey} conflicts with an existing mapping.`,
        'migration_identity_conflict');
    }
    db.prepare(`INSERT INTO external_identity_maps
      (id, workspace_id, source_namespace, entity_type, external_key, external_version,
       local_type, local_id, evidence_hash, first_package_id, last_package_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, source_namespace, entity_type, external_key) DO UPDATE SET
        external_version = excluded.external_version, last_package_id = excluded.last_package_id, updated_at = excluded.updated_at`)
      .run(newId('xid'), pkg.workspaceId, pkg.sourceNamespace, entry.entityType, entry.externalKey,
        record.source_version, entry.localType, entry.localId, record.payload_hash, pkg.id, pkg.id, now, now);
  }
  return identities[0];
}

function attachAttributesForMigration(db,ctx,subjectType,subjectId,payload) {
  for (const entry of payload.attributes || []) {
    attributes.set(db,ctx,subjectType,subjectId,{ key:entry.key,value:entry.value },'migration');
  }
}

/** Apply parent locations before their children regardless of worksheet row
 * order. A bin on row 1 may legitimately point at a warehouse defined later
 * in another sheet; dependency order, not upload order, owns the cutover. */
function pendingLocationRows(db,pkg,limit) {
  const rows = db.prepare(`SELECT * FROM migration_records
    WHERE package_id=? AND entity_type='location' AND status IN ('VALID','FAILED')`).all(pkg.id);
  if (!rows.length) return [];
  const byKey = new Map(rows.map((row) => [row.source_key,row]));
  const alreadyMapped = new Set(db.prepare(`SELECT external_key FROM external_identity_maps
    WHERE workspace_id=? AND source_namespace=? AND entity_type='location'`)
    .all(pkg.workspaceId,pkg.sourceNamespace).map((row) => row.external_key));
  const memo = new Map(); const visiting = new Set();
  const depth = (row) => {
    if (memo.has(row.id)) return memo.get(row.id);
    if (visiting.has(row.id)) return Number.MAX_SAFE_INTEGER;
    visiting.add(row.id);
    const parentKey = parse(row.payload_json).parentLocationKey;
    let value = 0;
    if (parentKey && !alreadyMapped.has(parentKey)) {
      const parent = byKey.get(parentKey);
      value = parent ? depth(parent) + 1 : Number.MAX_SAFE_INTEGER;
    }
    visiting.delete(row.id); memo.set(row.id,value); return value;
  };
  return rows.sort((left,right) => depth(left) - depth(right)
    || left.ordinal - right.ordinal || left.id.localeCompare(right.id)).slice(0,limit);
}

function defaultAdapters() {
  const attachAttributes = (db,ctx,subjectType,subjectId,payload) => {
    for (const entry of payload.attributes || []) {
      attributes.set(db,ctx,subjectType,subjectId,{ key:entry.key,value:entry.value },'migration');
    }
  };
  return {
    location({ db, ctx, payload, pkg }) {
      const target = locations.createLocation(db, ctx, { ...payload,
        kind: canonicalLocationKind(payload.kind), parentLocationId: identity(db, pkg, 'location', payload.parentLocationKey) });
      attachAttributes(db,ctx,'location',target.id,payload);
      return { targetType: 'location', targetId: target.id };
    },
    product({ db, ctx, payload, record, pkg }) {
      const effectivePayload = quantityTrackingProductKeys(db,pkg).has(record.source_key)
        ? { ...payload,trackingMode:'quantity' } : payload;
      const target = Array.isArray(effectivePayload.variants) && effectivePayload.variants.length
        ? items.createExactItem(db, ctx, effectivePayload) : items.createItemShell(db, ctx, effectivePayload);
      attachAttributes(db,ctx,'item',target.itemId,payload);
      const identities = [{ entityType: 'product', externalKey: record.source_key, localType: 'item', localId: target.itemId }];
      (target.skus || []).forEach((sku, index) => {
        const externalKey = (effectivePayload.variants[index] || {}).sourceKey;
        if (externalKey) identities.push({ entityType: 'sku', externalKey, localType: 'sku', localId: sku.skuId });
      });
      return { targetType: 'item', targetId: target.itemId, identities };
    },
    sku({ db, ctx, payload, record, pkg }) {
      const target = items.addExactVariants(db, ctx, identity(db, pkg, 'product', payload.productKey),
        [{ ...payload, sourceKey: record.source_key }]);
      attachAttributes(db,ctx,'sku',target.skus[0].skuId,payload);
      const aliases = [record.source_key,skuCodeAlias(payload.code)].filter(Boolean);
      return { targetType: 'sku', targetId: target.skus[0].skuId,
        identities: [...new Set(aliases)].map((externalKey) => ({ entityType: 'sku', externalKey,
          localType: 'sku', localId: target.skus[0].skuId })) };
    },
    sku_batch({ db, ctx, payload, pkg }) {
      const target = items.addExactVariants(db, ctx, identity(db, pkg, 'product', payload.productKey), payload.variants);
      return { targetType: 'item', targetId: target.itemId,
        identities: target.skus.flatMap((sku,index) => {
          const variant = payload.variants[index] || {};
          return [...new Set([sku.sourceKey,skuCodeAlias(variant.code)].filter(Boolean))].map((externalKey) => ({
            entityType: 'sku',externalKey,localType: 'sku',localId: sku.skuId,
          }));
        }) };
    },
    supplier({ db, ctx, membership, payload }) {
      const target = suppliers.createSupplier(db, ctx, membership, payload);
      attachAttributes(db,ctx,'supplier',target.id,payload);
      return { targetType: 'supplier', targetId: target.id };
    },
    customer({ db, ctx, payload }) {
      const target = salesOrders.createCustomer(db, ctx, payload);
      return { targetType: 'customer', targetId: target.id };
    },
    attribute({ db, ctx, payload, pkg }) {
      const sourceType = payload.subjectType;
      const targetType = sourceType === 'product' ? 'item' : sourceType;
      const targetId = identity(db, pkg, sourceType, payload.subjectKey);
      attributes.set(db, ctx, targetType, targetId, payload, 'migration');
      return { targetType: 'catalog_attribute', targetId: `${targetType}:${targetId}:${payload.key}` };
    },
    supplier_item({ db, ctx, membership, payload, pkg }) {
      const unitsPerPurchaseUnit = Number(payload.unitsPerPurchaseUnit || 1);
      // The source has already supplied the material conversion. A missing
      // label does not make that conversion unknown; preserve it under the
      // neutral name "pack" instead of falsely calling two units one "unit".
      const purchaseUnit = payload.purchaseUnit || (unitsPerPurchaseUnit > 1 ? 'pack' : 'unit');
      const target = suppliers.linkItem(db, ctx, membership, { ...payload,purchaseUnit,unitsPerPurchaseUnit,
        supplierId: identity(db, pkg, 'supplier', payload.supplierKey),
        skuId: identity(db, pkg, 'sku', payload.skuKey) });
      return { targetType: 'supplier_item', targetId: target.id };
    },
    selling_price({ db, ctx, payload, pkg }) {
      const target = pricing.setPrice(db, ctx, { ...payload, skuId: identity(db, pkg, 'sku', payload.skuKey), source: 'migration' });
      return { targetType: 'sku_price', targetId: target.id };
    },
    purchase_cost({ db, ctx, payload, pkg }) {
      const target = pricing.setPurchaseCost(db, ctx, { ...payload, skuId: identity(db, pkg, 'sku', payload.skuKey), source: 'migration' });
      // An identical evidenced supplier cost is a legitimate replay. In that
      // case price-service returns the supplier-item row rather than inventing
      // a duplicate owner-cost row, so preserve the actual target type.
      return target.id
        ? { targetType: 'sku_purchase_cost', targetId: target.id }
        : { targetType: 'supplier_item', targetId: target.supplier_item_id };
    },
    reorder_policy({ db, ctx, membership, payload, pkg }) {
      const skuId = identity(db, pkg, 'sku', payload.skuKey);
      const target = reorder.setPolicy(db, ctx, membership, skuId, { ...payload,
        preferredSupplierId: identity(db, pkg, 'supplier', payload.preferredSupplierKey), source: 'manual' });
      return { targetType: 'reorder_policy', targetId: target.id || skuId };
    },
    purchase_order({ db, ctx, membership, payload, pkg }) {
      const target = purchaseOrders.createOrder(db, ctx, membership, { ...payload,
        poNumber: payload.poNumber || payload.orderNumber,
        supplierId: identity(db, pkg, 'supplier', payload.supplierKey),
        destinationLocationId: identity(db, pkg, 'location', payload.destinationLocationKey),
        lines: payload.lines.map((line) => ({ ...line,
          // Canonical quantityUnits are already exact stocking units. A
          // supplier's default pack must not round them up unless this source
          // line explicitly supplied the conversion evidence.
          purchaseUnit:line.purchaseUnit || 'unit',
          unitsPerPurchaseUnit:line.unitsPerPurchaseUnit || 1,
          skuId: identity(db, pkg, 'sku', line.skuKey),
        })),
        source: 'instruction', sourceDetail: { migrationPackageId: pkg.id } });
      if (['AWAITING_APPROVAL','APPROVED','ORDERED'].includes(String(payload.status || '').toUpperCase())) {
        purchaseOrders.submitForApproval(db, ctx, membership, target.id);
      }
      if (['APPROVED','ORDERED'].includes(String(payload.status || '').toUpperCase())) {
        purchaseOrders.approve(db, ctx, membership, target.id, { markOrdered: String(payload.status).toUpperCase() === 'ORDERED' });
      }
      return { targetType: 'purchase_order', targetId: target.id };
    },
    sales_order({ db, ctx, payload, pkg }) {
      const target = salesOrders.createOrder(db, ctx, { ...payload,
        customerId: identity(db, pkg, 'customer', payload.customerKey),
        fulfillmentLocationId: identity(db, pkg, 'location', payload.fulfillmentLocationKey),
        lines: payload.lines.map((line) => ({ ...line, skuId: identity(db, pkg, 'sku', line.skuKey) })) });
      if (String(payload.status || '').toUpperCase() !== 'DRAFT') salesOrders.confirm(db, ctx, target.id);
      return { targetType: 'sales_order', targetId: target.id };
    },
    inventory_position({ db, ctx, payload, pkg, record }) {
      const quantity = payload.quantity === undefined || payload.quantity === null
        ? (Array.isArray(payload.serials) ? payload.serials.length : 0) : Number(payload.quantity);
      if (quantity < 0) throw new ValidationError('A negative opening position must be resolved before migration; Foundry will not invent offsetting stock.');
      // A zero balance is still useful source evidence (and may carry incoming
      // or reorder context), but it is not a physical receipt. Preserve the
      // mapped record without fabricating a zero-quantity stock movement.
      if (quantity === 0) return { targetType:'migration_record',targetId:record.id };
      const skuId = identity(db, pkg, 'sku', payload.skuKey);
      const locationId = identity(db, pkg, 'location', payload.locationKey);
      const target = inventory.receive(db, ctx, { ...payload, quantity,
        skuId, locationId,
        reasonCode: 'migration_opening', reference: `migration:${pkg.id}:${record.id}`,
        notes: payload.notes || `Verified opening position from ${pkg.sourceLabel}` });
      if (payload.inventoryValue != null || payload.unitCost != null) {
        const totalCostMinor = payload.inventoryValue != null
          ? Math.round(Number(payload.inventoryValue) * 100)
          : Math.round(quantity * Number(payload.unitCost) * 100);
        costing.receive(db,ctx,{ movementIds:target.movementIds,totalCostMinor,
          sourceType:'verified_migration_opening_value',sourceRecordId:record.id });
      }
      const now = nowIso();
      for (const [kind,amount] of [['legacy_reserved',Number(payload.reservedQuantity || 0)],['damaged',Number(payload.damagedQuantity || 0)]]) {
        if (!amount) continue;
        db.prepare(`INSERT INTO inventory_availability_holds
          (id,workspace_id,sku_id,location_id,kind,quantity,remaining_quantity,source_type,source_id,evidence_json,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,'OPEN',?,?) ON CONFLICT(workspace_id,source_type,source_id,kind) DO NOTHING`)
          .run(newId('ihold'),ctx.workspaceId,skuId,locationId,kind,amount,amount,'migration_record',record.id,
            stable({ packageId:pkg.id,sourceKey:record.source_key,availableQuantity:payload.availableQuantity }),now,now);
      }
      return { targetType: 'movement_group', targetId: target.groupId };
    },
    history_fact({ db, ctx, payload, pkg, record }) {
      const id = newId('mhist');
      db.prepare(`INSERT INTO migration_history_facts
        (id, workspace_id, package_id, source_namespace, external_key, fact_type,
         occurred_at, payload_json, evidence_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, ctx.workspaceId, pkg.id, pkg.sourceNamespace, record.source_key,
          payload.factType || 'source_history', payload.occurredAt || null, stable(payload), record.payload_hash, nowIso());
      return { targetType: 'migration_history_fact', targetId: id };
    },
  };
}

function apply(db, ctx, membership, packageId, options = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'apply an inventory migration');
  const pkg = getPackage(db, ctx.workspaceId, packageId);
  if (!['APPROVED', 'APPLYING', 'FAILED'].includes(pkg.status)) {
    throw new InvariantError('Approve the validated migration before applying it.', 'migration_not_approved');
  }
  const limit = Math.min(5000, Math.max(1, Number(options.limit || 500)));
  const adapters = { ...defaultAdapters(), ...(options.adapters || {}) };
  db.prepare(`UPDATE migration_packages SET status = 'APPLYING', updated_at = ? WHERE id = ?`).run(nowIso(), packageId);
  const locationRows = pendingLocationRows(db,pkg,limit);
  const remainingSlots = Math.max(0,limit - locationRows.length);
  const otherRows = remainingSlots ? db.prepare(`SELECT * FROM migration_records WHERE package_id = ?
    AND entity_type<>'location' AND status IN ('VALID','FAILED')
    ORDER BY CASE entity_type
      WHEN 'product' THEN 20 WHEN 'sku' THEN 25 WHEN 'sku_batch' THEN 25
      WHEN 'supplier' THEN 30 WHEN 'customer' THEN 30 WHEN 'attribute' THEN 35
      WHEN 'supplier_item' THEN 40 WHEN 'selling_price' THEN 45 WHEN 'purchase_cost' THEN 45
      WHEN 'reorder_policy' THEN 50 WHEN 'purchase_order' THEN 60 WHEN 'sales_order' THEN 60
      WHEN 'inventory_position' THEN 70 ELSE 80 END,
      CASE WHEN entity_type='sku' THEN json_extract(payload_json,'$.productKey') ELSE '' END,
      ordinal,id LIMIT ?`).all(packageId, remainingSlots) : [];
  const rows = [...locationRows,...otherRows];
  let applied = 0;
  const migrationCtx = { ...ctx,verifiedMigration:true };
  const markFailure = (record,error) => {
    db.prepare(`UPDATE migration_records SET status = 'FAILED', issue_code = 'DOMAIN_REJECTED', issue_detail = ?, updated_at = ? WHERE id = ?`)
      .run(String(error.message || error), nowIso(), record.id);
    db.prepare(`UPDATE migration_packages SET status = 'FAILED',
      applied_count=(SELECT COUNT(*) FROM migration_records WHERE package_id=? AND status='APPLIED'),
      problem_count=(SELECT COUNT(*) FROM migration_records WHERE package_id=? AND status IN ('BLOCKED','FAILED')),
      updated_at = ? WHERE id = ?`).run(packageId,packageId,nowIso(),packageId);
    return { package:getPackage(db,ctx.workspaceId,packageId),applied,failedRecordId:record.id,error };
  };
  const applyOne = (record) => {
    const adapter = adapters[record.entity_type];
    if (!adapter) throw new InvariantError(`No domain adapter owns ${record.entity_type}.`, 'migration_adapter_missing');
    inTransaction(db, () => {
      const mapped = adapter({ db,ctx:migrationCtx,membership,payload:parse(record.payload_json),pkg,record });
      const primary = remember(db,pkg,record,mapped);
      db.prepare(`UPDATE migration_records SET status='APPLIED',target_type=?,target_id=?,
        issue_code=NULL,issue_detail=NULL,applied_at=?,updated_at=? WHERE id=?`)
        .run(primary.localType,primary.localId,nowIso(),nowIso(),record.id);
    });
    applied += 1;
  };
  const applyNonSkuGroup = (group) => {
    try {
      inTransaction(db,() => {
        for (const record of group) {
          const adapter = adapters[record.entity_type];
          if (!adapter) throw new InvariantError(`No domain adapter owns ${record.entity_type}.`, 'migration_adapter_missing');
          const mapped = adapter({ db,ctx:migrationCtx,membership,payload:parse(record.payload_json),pkg,record });
          const primary = remember(db,pkg,record,mapped);
          db.prepare(`UPDATE migration_records SET status='APPLIED',target_type=?,target_id=?,
            issue_code=NULL,issue_detail=NULL,applied_at=?,updated_at=? WHERE id=?`)
            .run(primary.localType,primary.localId,nowIso(),nowIso(),record.id);
        }
      });
      applied += group.length;
      return null;
    } catch (error) {
      // The batch was atomic and rolled back. Isolate the exact bad record so
      // one malformed source row never makes the rest ambiguous.
      for (const record of group) {
        try { applyOne(record); } catch (recordError) { return markFailure(record,recordError); }
      }
      return null;
    }
  };
  const applySkuGroup = (group) => {
    try {
      inTransaction(db,() => {
        const payloads = group.map((record) => parse(record.payload_json));
        const productKey = payloads[0].productKey;
        const target = items.addExactVariants(db,migrationCtx,identity(db,pkg,'product',productKey),
          payloads.map((payload,index) => ({ ...payload,sourceKey:group[index].source_key })));
        group.forEach((record,index) => {
          const payload = payloads[index]; const sku = target.skus[index];
          attachAttributesForMigration(db,migrationCtx,'sku',sku.skuId,payload);
          const aliases = [...new Set([record.source_key,skuCodeAlias(payload.code)].filter(Boolean))];
          const primary = remember(db,pkg,record,{ targetType:'sku',targetId:sku.skuId,
            identities:aliases.map((externalKey) => ({ entityType:'sku',externalKey,localType:'sku',localId:sku.skuId })) });
          db.prepare(`UPDATE migration_records SET status='APPLIED',target_type=?,target_id=?,
            issue_code=NULL,issue_detail=NULL,applied_at=?,updated_at=? WHERE id=?`)
            .run(primary.localType,primary.localId,nowIso(),nowIso(),record.id);
        });
      });
      applied += group.length;
      return null;
    } catch (error) {
      if (group.length === 1) return markFailure(group[0],error);
      const middle = Math.floor(group.length / 2);
      return applySkuGroup(group.slice(0,middle)) || applySkuGroup(group.slice(middle));
    }
  };
  for (let index=0;index<rows.length;) {
    const record = rows[index];
    if (record.entity_type === 'sku' && !(options.adapters && options.adapters.sku)) {
      const skuRows = [];
      while (index < rows.length && rows[index].entity_type === 'sku') skuRows.push(rows[index++]);
      const groups = new Map();
      for (const skuRecord of skuRows) {
        const productKey = parse(skuRecord.payload_json).productKey;
        if (!groups.has(productKey)) groups.set(productKey,[]);
        groups.get(productKey).push(skuRecord);
      }
      for (const group of groups.values()) {
        // Keep write leases short enough that ordinary browser actions do not
        // sit behind a many-thousand-variant transaction. The outer batch is
        // still large for throughput; each product group is committed in
        // bounded, independently retryable pieces.
        const chunkSize = Math.min(500,Math.max(25,Number(options.skuChunkSize || 100)));
        for (let offset=0;offset<group.length;offset += chunkSize) {
          const failure = applySkuGroup(group.slice(offset,offset + chunkSize));
          if (failure) return failure;
        }
      }
      continue;
    }
    const entityType = record.entity_type;
    const group = [];
    const batchSize = Math.min(500,Math.max(25,Number(options.nonSkuChunkSize || 250)));
    while (index < rows.length && rows[index].entity_type === entityType && group.length < batchSize) {
      group.push(rows[index++]);
    }
    const failure = applyNonSkuGroup(group);
    if (failure) return failure;
  }
  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM migration_records
    WHERE package_id = ? AND status IN ('VALID','FAILED')`).get(packageId).n;
  db.prepare(`UPDATE migration_packages SET applied_count =
    (SELECT COUNT(*) FROM migration_records WHERE package_id = ? AND status = 'APPLIED'),
    problem_count = (SELECT COUNT(*) FROM migration_records WHERE package_id = ? AND status IN ('BLOCKED','FAILED')),
    status = ?, updated_at = ? WHERE id = ?`)
    .run(packageId, packageId, remaining ? 'APPLYING' : 'RECONCILING', nowIso(), packageId);
  return { package: getPackage(db, ctx.workspaceId, packageId), applied, remaining };
}

const TARGET_TABLES = Object.freeze({
  item:'items', sku:'skus', location:'locations', supplier:'suppliers', customer:'customers',
  supplier_item:'supplier_items', sku_price:'sku_prices', sku_purchase_cost:'sku_purchase_costs',
  reorder_policy:'reorder_policies', purchase_order:'purchase_orders', sales_order:'sales_orders',
  migration_history_fact:'migration_history_facts',
});

/** Reconciliation trusts present domain state, never the worker's success flag. */
function targetStillExists(db, workspaceId, row) {
  if (!row.target_type || !row.target_id) return false;
  if (row.target_type === 'migration_record') {
    return Boolean(db.prepare(`SELECT 1 FROM migration_records
      WHERE id=? AND package_id IN (SELECT id FROM migration_packages WHERE workspace_id=?)`)
      .get(row.target_id,workspaceId));
  }
  if (row.target_type === 'movement_group') {
    return Boolean(db.prepare('SELECT 1 FROM movements WHERE workspace_id=? AND group_id=? LIMIT 1')
      .get(workspaceId, row.target_id));
  }
  if (row.target_type === 'catalog_attribute') {
    const [subjectType, subjectId, ...keyParts] = String(row.target_id).split(':');
    return Boolean(subjectType && subjectId && keyParts.length && db.prepare(`SELECT 1 FROM catalog_attributes
      WHERE workspace_id=? AND subject_type=? AND subject_id=? AND attribute_key=? LIMIT 1`)
      .get(workspaceId, subjectType, subjectId, keyParts.join(':')));
  }
  const table = TARGET_TABLES[row.target_type];
  if (!table) return false;
  return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE workspace_id=? AND id=? LIMIT 1`)
    .get(workspaceId, row.target_id));
}

function addCheck(checks, key, label, source, foundry, material = true, evidence = {}) {
  checks.push({ key, label, source, foundry,
    status: source === foundry ? 'MATCHED' : 'MISMATCHED', material, evidence });
}

function sumSourceLines(rows, entityType, predicate = () => true) {
  return rows.filter((row) => row.entity_type === entityType).reduce((sum, row) => {
    const payload = parse(row.payload_json);
    if (!predicate(payload)) return sum;
    return sum + (payload.lines || []).reduce((lineSum, line) =>
      lineSum + Number(line.quantityUnits ?? line.quantity ?? 0), 0);
  }, 0);
}

function migratedOrderUnits(db, pkg, entityType, orderTable, lineTable, orderIdColumn, quantityExpression, statuses = null) {
  const statusSql = statuses?.length ? ` AND o.status IN (${statuses.map(() => '?').join(',')})` : '';
  const params = [pkg.workspaceId, pkg.sourceNamespace, pkg.id, ...statuses || []];
  return Number(db.prepare(`SELECT COALESCE(SUM(${quantityExpression}),0) AS n
    FROM external_identity_maps x JOIN ${orderTable} o ON o.id=x.local_id
    JOIN ${lineTable} l ON l.${orderIdColumn}=o.id
    WHERE x.workspace_id=? AND x.source_namespace=? AND x.last_package_id=?
      AND x.entity_type='${entityType}'${statusSql}`).get(...params).n || 0);
}

function attachMigrationInventoryCosts(db,ctx,membership,packageId) {
  permissions.assertCan(membership,permissions.MANAGE_ACCOUNTING,'reconcile migrated inventory value');
  const rows = db.prepare(`SELECT id,payload_json FROM migration_records
    WHERE package_id=? AND entity_type='inventory_position' AND status IN ('APPLIED','VERIFIED') ORDER BY ordinal,id`).all(packageId);
  let costed=0; let replayed=0; let sourceTotalMinor=0;
  const applyOne=(row) => {
    const payload=parse(row.payload_json);
    const quantity=Number(payload.quantity || 0);
    if (payload.inventoryValue == null && payload.unitCost == null) return;
    const totalCostMinor=payload.inventoryValue != null
      ? Math.round(Number(payload.inventoryValue) * 100)
      : Math.round(quantity * Number(payload.unitCost) * 100);
    sourceTotalMinor += totalCostMinor;
    if (!quantity) return;
    const movementIds=db.prepare(`SELECT id FROM movements WHERE workspace_id=? AND reference=? ORDER BY id`)
      .all(ctx.workspaceId,`migration:${packageId}:${row.id}`).map((entry)=>entry.id);
    if (!movementIds.length) throw new InvariantError('A valued migration position has no physical opening movement.',
      'migration_value_movement_missing');
    const result=costing.receive(db,{ ...ctx,verifiedMigration:true },{ movementIds,totalCostMinor,
      sourceType:'verified_migration_opening_value',sourceRecordId:row.id });
    if (result.replayed) replayed += 1; else costed += 1;
  };
  for(let offset=0;offset<rows.length;offset+=250) inTransaction(db,() => rows.slice(offset,offset+250).forEach(applyOne));
  return { costed,replayed,sourceTotalMinor };
}

function reconcile(db, ctx, membership, packageId) {
  permissions.assertCan(membership, permissions.ADMIN, 'reconcile an inventory migration');
  const pkg = getPackage(db, ctx.workspaceId, packageId);
  const allApplied = !db.prepare(`SELECT 1 FROM migration_records
    WHERE package_id=? AND status NOT IN ('APPLIED','VERIFIED') LIMIT 1`).get(packageId);
  if (!['RECONCILING', 'VERIFIED','CUTOVER_ACTIVE'].includes(pkg.status) && !(pkg.status === 'NEEDS_ATTENTION' && allApplied)) {
    throw new InvariantError('Apply every staged record before reconciliation.', 'migration_not_applied');
  }
  const rows = db.prepare('SELECT * FROM migration_records WHERE package_id = ?').all(packageId);
  const valueResult=attachMigrationInventoryCosts(db,ctx,membership,packageId);
  let correctedPurchaseOrderLines = 0;
  const migrationCtx = { ...ctx,verifiedMigration:true };
  for (const row of rows.filter((entry) => entry.entity_type === 'purchase_order' && entry.target_id)) {
    const payload = parse(row.payload_json);
    const result = purchaseOrders.correctMigrationQuantities(db,migrationCtx,membership,row.target_id,payload.lines || [],packageId);
    correctedPurchaseOrderLines += result.corrected;
  }
  const checks = [];
  if (pkg.cutoverMode === 'SNAPSHOT_DELTA') {
    const final = db.prepare(`SELECT source_cursor FROM migration_cutover_checkpoints
      WHERE package_id=? AND checkpoint_kind='FINAL'`).get(packageId);
    addCheck(checks,'source.final_checkpoint','Frozen source checkpoint',pkg.finalCheckpoint,
      final?.source_cursor || null,true,{ method:'immutable source checkpoint evidence', deltaRecords:
        db.prepare('SELECT COUNT(*) AS n FROM migration_source_changes WHERE package_id=?').get(packageId).n });
  }
  for (const type of Object.keys(TYPES)) {
    if (type === 'sku' || type === 'sku_batch') continue;
    const source = rows.filter((row) => row.entity_type === type).length;
    if (!source) continue;
    const foundry = rows.filter((row) => row.entity_type === type && targetStillExists(db, pkg.workspaceId, row)).length;
    addCheck(checks, `${type}.records`, `${type.replaceAll('_', ' ')} records`, source, foundry,
      materialTypes.has(type), { method:'live target existence' });
  }
  const sourceSkus = rows.reduce((sum, row) => {
    const payload = parse(row.payload_json);
    if (row.entity_type === 'sku') return sum + 1;
    if (row.entity_type === 'sku_batch') return sum + (payload.variants || []).length;
    if (row.entity_type === 'product') return sum + (payload.variants || []).length;
    return sum;
  }, 0);
  if (sourceSkus) {
    const foundrySkus = Number(db.prepare(`SELECT COUNT(DISTINCT local_id) AS n FROM external_identity_maps
      WHERE workspace_id = ? AND source_namespace = ? AND entity_type = 'sku' AND last_package_id = ?`)
      .get(ctx.workspaceId, pkg.sourceNamespace, packageId).n);
    addCheck(checks, 'sku.records', 'SKU / variant records', sourceSkus, foundrySkus, true,
      { method:'external identities joined to canonical SKUs' });
  }
  const positions = rows.filter((row) => row.entity_type === 'inventory_position');
  if (positions.length) {
    const source = positions.reduce((sum, row) => {
      const payload = parse(row.payload_json);
      const quantity = payload.quantity === undefined || payload.quantity === null
        ? (Array.isArray(payload.serials) ? payload.serials.length : 0) : Number(payload.quantity);
      return sum + quantity;
    }, 0);
    const foundry = Number(db.prepare(`SELECT COALESCE(SUM(quantity_delta), 0) AS n FROM movements
      WHERE workspace_id = ? AND reference LIKE ?`).get(ctx.workspaceId, `migration:${packageId}:%`).n);
    addCheck(checks, 'inventory.units', 'inventory units', source, foundry, true,
      { method:'immutable migration movement deltas' });
    const valuedPositions=positions.filter((row) => {
      const payload=parse(row.payload_json); return payload.inventoryValue != null || payload.unitCost != null;
    });
    if (valuedPositions.length) {
      const sourceValueMinor=valuedPositions.reduce((sum,row) => {
        const payload=parse(row.payload_json); const quantity=Number(payload.quantity || 0);
        return sum + (payload.inventoryValue != null ? Math.round(Number(payload.inventoryValue) * 100)
          : Math.round(quantity * Number(payload.unitCost) * 100));
      },0);
      const foundryValueMinor=Number(db.prepare(`SELECT COALESCE(SUM(cm.cost_delta_minor),0) AS n
        FROM accounting_inventory_cost_movements cm JOIN movements m ON m.id=cm.inventory_movement_id
        WHERE cm.workspace_id=? AND m.reference LIKE ?`).get(ctx.workspaceId,`migration:${packageId}:%`).n || 0);
      addCheck(checks,'inventory.value_minor','Inventory cost value',sourceValueMinor,foundryValueMinor,true,
        { method:'source position value attached to exact opening movements',costedPositions:valueResult.costed,
          replayedPositions:valueResult.replayed });
    }
    const sourceLots = new Set();
    let sourceSerials = 0;
    for (const row of positions) {
      const payload = parse(row.payload_json);
      if (payload.lotCode) sourceLots.add(`${payload.skuKey}:${payload.lotCode}`);
      sourceSerials += Array.isArray(payload.serials) ? payload.serials.length : 0;
    }
    if (sourceLots.size) {
      const foundryLots = Number(db.prepare(`SELECT COUNT(DISTINCT lot_id) AS n FROM movements
        WHERE workspace_id=? AND reference LIKE ? AND lot_id IS NOT NULL`)
        .get(ctx.workspaceId, `migration:${packageId}:%`).n || 0);
      addCheck(checks, 'lot.records', 'Lot / batch identities', sourceLots.size, foundryLots);
    }
    if (sourceSerials) {
      const foundrySerials = Number(db.prepare(`SELECT COUNT(DISTINCT serial_unit_id) AS n FROM movements
        WHERE workspace_id=? AND reference LIKE ? AND serial_unit_id IS NOT NULL`)
        .get(ctx.workspaceId, `migration:${packageId}:%`).n || 0);
      addCheck(checks, 'serial.records', 'Serial identities', sourceSerials, foundrySerials);
    }
  }

  const purchaseRows = rows.filter((row) => row.entity_type === 'purchase_order');
  if (purchaseRows.length) {
    const sourceUnits = sumSourceLines(rows, 'purchase_order');
    const foundryUnits = migratedOrderUnits(db, pkg, 'purchase_order', 'purchase_orders',
      'purchase_order_lines', 'purchase_order_id', 'l.quantity_units');
    addCheck(checks, 'purchase_order.units', 'Purchase-order units', sourceUnits, foundryUnits,true,
      { method:'exact staged stock-unit quantities',correctedLines:correctedPurchaseOrderLines });
    const openStatuses = new Set(['AWAITING_APPROVAL','APPROVED','ORDERED','PARTIALLY_RECEIVED']);
    const sourceIncoming = sumSourceLines(rows, 'purchase_order', (payload) =>
      openStatuses.has(String(payload.status || 'DRAFT').toUpperCase()));
    const foundryIncoming = migratedOrderUnits(db, pkg, 'purchase_order', 'purchase_orders',
      'purchase_order_lines', 'purchase_order_id', '(l.quantity_units-l.quantity_received_units)',
      [...openStatuses]);
    addCheck(checks, 'purchase_order.incoming_units', 'Open incoming units', sourceIncoming, foundryIncoming,true,
      { method:'exact staged outstanding stock-unit quantities',correctedLines:correctedPurchaseOrderLines });
  }
  const salesRows = rows.filter((row) => row.entity_type === 'sales_order');
  if (salesRows.length) {
    const sourceUnits = sumSourceLines(rows, 'sales_order');
    const foundryUnits = migratedOrderUnits(db, pkg, 'sales_order', 'sales_orders',
      'sales_order_lines', 'sales_order_id', 'l.quantity_ordered');
    addCheck(checks, 'sales_order.units', 'Sales-order units', sourceUnits, foundryUnits);
    const openStatuses = new Set(['CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED']);
    const sourceOpen = sumSourceLines(rows, 'sales_order', (payload) =>
      openStatuses.has(String(payload.status || 'DRAFT').toUpperCase()));
    const foundryOpen = migratedOrderUnits(db, pkg, 'sales_order', 'sales_orders',
      'sales_order_lines', 'sales_order_id', '(l.quantity_ordered-l.quantity_fulfilled)',
      [...openStatuses]);
    addCheck(checks, 'sales_order.open_units', 'Open customer-demand units', sourceOpen, foundryOpen);
  }
  const manifestTotals = pkg.manifest.reconciliation || {};
  for (const [key, source] of Object.entries(manifestTotals)) {
    if (checks.some((check) => check.key === key)) continue;
    checks.push({ key, label: key.replaceAll('.', ' '), source, foundry: null, status: 'UNKNOWN', material: true,
      evidence: { reason: 'No deterministic Foundry query is registered for this source total.' } });
  }
  const now = nowIso();
  inTransaction(db, () => {
    for (const check of checks) {
      db.prepare(`INSERT INTO migration_reconciliation_checks
        (id, workspace_id, package_id, check_key, label, material, source_value,
         foundry_value, status, evidence_json, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(package_id, check_key) DO UPDATE SET source_value = excluded.source_value,
          foundry_value = excluded.foundry_value, status = excluded.status,
          evidence_json = excluded.evidence_json, checked_at = excluded.checked_at`)
        .run(newId('mchk'), ctx.workspaceId, packageId, check.key, check.label, check.material ? 1 : 0,
          check.source === null ? null : String(check.source), check.foundry === null ? null : String(check.foundry),
          check.status, stable(check.evidence || {}), now);
    }
    const failures = checks.filter((check) => check.material && check.status !== 'MATCHED').length;
    // A fresh audit of an already activated cutover may temporarily surface a
    // new material check. Once that check passes, restore its live state from
    // the durable cutover timestamp rather than leaving it downgraded.
    const verifiedStatus=pkg.cutoverAt ? 'CUTOVER_ACTIVE' : 'VERIFIED';
    db.prepare(`UPDATE migration_packages SET status = ?, problem_count = ?, verified_at = ?, updated_at = ? WHERE id = ?`)
      .run(failures ? 'NEEDS_ATTENTION' : verifiedStatus, failures, failures ? null : now, now, packageId);
    if (!failures) db.prepare(`UPDATE migration_records SET status = 'VERIFIED', verified_at = ?, updated_at = ?
      WHERE package_id = ? AND status = 'APPLIED'`).run(now, now, packageId);
  });
  return { package: getPackage(db, ctx.workspaceId, packageId), checks, matched: checks.every((c) => !c.material || c.status === 'MATCHED') };
}

function activateCutover(db, ctx, membership, packageId) {
  permissions.assertCan(membership, permissions.ADMIN, 'activate an inventory cutover');
  const pkg = getPackage(db, ctx.workspaceId, packageId);
  if (pkg.status !== 'VERIFIED') throw new InvariantError('Cutover is blocked until every material reconciliation check matches.', 'migration_not_verified');
  if (pkg.cutoverMode === 'SNAPSHOT_DELTA' && (!pkg.sourceFrozenAt || !pkg.finalCheckpoint)) {
    throw new InvariantError('A live source cannot be activated without its frozen final checkpoint.', 'migration_source_not_frozen');
  }
  const blockers = db.prepare(`SELECT COUNT(*) AS n FROM migration_reconciliation_checks
    WHERE package_id = ? AND material = 1 AND status <> 'MATCHED'`).get(packageId).n;
  if (blockers) throw new InvariantError('Cutover is blocked by unresolved reconciliation differences.', 'migration_reconciliation_failed');
  const now = nowIso();
  db.prepare(`UPDATE migration_packages SET status = 'CUTOVER_ACTIVE', cutover_at = ?, updated_at = ? WHERE id = ?`)
    .run(now, now, packageId);
  return getPackage(db, ctx.workspaceId, packageId);
}

/**
 * One owner decision, followed by deterministic work. Batches remain durable
 * and individually idempotent, but the owner is not turned into the worker.
 * Activation is still impossible unless a fresh domain reread reconciles every
 * material source total.
 */
function approveAndActivate(db, ctx, membership, packageId) {
  let pkg = getPackage(db, ctx.workspaceId, packageId);
  if (pkg.status === 'CUTOVER_ACTIVE') return { package:pkg, replayed:true };
  if (pkg.status === 'READY') pkg = approve(db,ctx,membership,packageId);
  if (!['APPROVED','APPLYING','FAILED'].includes(pkg.status)) {
    throw new InvariantError('Validate the complete source before approving the switch.', 'migration_not_ready');
  }

  let totalApplied = 0;
  while (['APPROVED','APPLYING','FAILED'].includes(pkg.status)) {
    const result = apply(db,ctx,membership,packageId,{ limit:5000 });
    totalApplied += result.applied;
    if (result.error) throw result.error;
    pkg = result.package;
    if (!result.remaining) break;
  }
  if (pkg.status !== 'RECONCILING') {
    throw new InvariantError('The migration paused before reconciliation and remains safely resumable.', 'migration_apply_paused');
  }
  const reconciled = reconcile(db,ctx,membership,packageId);
  if (!reconciled.matched) return { package:reconciled.package,reconciled,totalApplied,activated:false };
  const activated = activateCutover(db,ctx,membership,packageId);
  return { package:activated,reconciled,totalApplied,activated:true };
}

/** One bounded, resumable cutover step for large browser migrations. The web
 * worker calls this repeatedly and yields between steps so ordinary pages stay
 * responsive while hundreds of thousands of records are applied. */
function advanceCutover(db,ctx,membership,packageId,options = {}) {
  let pkg = getPackage(db,ctx.workspaceId,packageId);
  if (pkg.status === 'CUTOVER_ACTIVE') return { package:pkg,done:true,activated:true,applied:0 };
  if (pkg.status === 'READY') pkg = approve(db,ctx,membership,packageId);
  if (['APPROVED','APPLYING','FAILED'].includes(pkg.status)) {
    const result = apply(db,ctx,membership,packageId,{ limit:options.limit || 5000 });
    if (result.error) throw result.error;
    pkg = result.package;
    if (pkg.status === 'APPLYING') return { package:pkg,done:false,activated:false,applied:result.applied };
    if (pkg.status !== 'RECONCILING') return { package:pkg,done:true,activated:false,applied:result.applied };
    const reconciled = reconcile(db,ctx,membership,packageId);
    if (!reconciled.matched) return { package:reconciled.package,done:true,activated:false,applied:result.applied };
    const activated = activateCutover(db,ctx,membership,packageId);
    return { package:activated,done:true,activated:true,applied:result.applied };
  }
  if (pkg.status === 'RECONCILING') {
    const reconciled = reconcile(db,ctx,membership,packageId);
    if (!reconciled.matched) return { package:reconciled.package,done:true,activated:false,applied:0 };
    const activated = activateCutover(db,ctx,membership,packageId);
    return { package:activated,done:true,activated:true,applied:0 };
  }
  throw new InvariantError('Validate the complete source before approving the switch.','migration_not_ready');
}

function report(db, workspaceId, packageId) {
  const pkg = getPackage(db, workspaceId, packageId);
  // Older interrupted attempts may have stopped before their denormalized
  // counters were refreshed. The report must tell the truth from records.
  const actual = db.prepare(`SELECT
    SUM(CASE WHEN status IN ('APPLIED','VERIFIED') THEN 1 ELSE 0 END) AS applied,
    SUM(CASE WHEN status IN ('BLOCKED','FAILED') THEN 1 ELSE 0 END) AS problems
    FROM migration_records WHERE package_id=?`).get(packageId);
  pkg.appliedCount = Number(actual.applied || 0);
  pkg.problemCount = Number(actual.problems || 0);
  const checks = db.prepare(`SELECT check_key AS key, label, material, source_value AS source,
    foundry_value AS foundry, status, evidence_json FROM migration_reconciliation_checks
    WHERE package_id = ? ORDER BY material DESC, label COLLATE NOCASE`).all(packageId)
    .map((row) => ({ ...row, material: Boolean(row.material), evidence: parse(row.evidence_json) }));
  const issues = db.prepare(`SELECT id, entity_type AS entityType, source_key AS sourceKey,
    issue_code AS code, issue_detail AS detail,payload_json AS payloadJson,status FROM migration_records
    WHERE package_id = ? AND status IN ('BLOCKED','FAILED') ORDER BY ordinal, id LIMIT 500`).all(packageId)
    .map((issue) => {
      const payload = parse(issue.payloadJson);
      const normalizedLocationKind = issue.status === 'FAILED' && issue.entityType === 'location'
        && issue.code === 'DOMAIN_REJECTED' && /^Location type must be one of:/.test(issue.detail || '')
        ? canonicalLocationKind(payload.kind) : null;
      const missingSerials = issue.entityType === 'inventory_position' && (
        issue.code === 'SERIAL_IDENTITIES_MISSING'
        || (issue.status === 'FAILED' && /^Enter at least one serial number\.$/.test(issue.detail || ''))
      );
      let serialDetail = null;
      if (missingSerials) {
        const sourceSku = db.prepare(`SELECT payload_json FROM migration_records
          WHERE package_id=? AND entity_type='sku' AND source_key=? LIMIT 1`).get(packageId,payload.skuKey);
        const skuPayload = sourceSku ? parse(sourceSku.payload_json) : {};
        const sourceProduct = skuPayload.productKey ? db.prepare(`SELECT payload_json FROM migration_records
          WHERE package_id=? AND entity_type='product' AND source_key=? LIMIT 1`).get(packageId,skuPayload.productKey) : null;
        const productPayload = sourceProduct ? parse(sourceProduct.payload_json) : {};
        const quantity = Number(payload.quantity || 0);
        const item = [productPayload.name,skuPayload.code || payload.skuKey,skuPayload.label].filter(Boolean).join(' · ');
        serialDetail = `${issue.sourceKey}: ${item || payload.skuKey} is marked serial-tracked, but the source claims ${quantity.toLocaleString()} units at ${payload.locationKey} and supplies no serial numbers. Add the ${quantity.toLocaleString()} exact serial identities, or correct the product tracking mode in the source and upload a new snapshot.`;
      }
      const reorderedParent = issue.status === 'FAILED' && issue.entityType === 'location'
        && issue.code === 'DOMAIN_REJECTED' && /^Migration reference location:.* has not been applied yet\.$/.test(issue.detail || '')
        && payload.parentLocationKey
        && db.prepare(`SELECT 1 FROM migration_records WHERE package_id=? AND entity_type='location'
          AND source_key=? AND status IN ('VALID','FAILED','APPLIED')`).get(packageId,payload.parentLocationKey);
      const zeroOpeningPosition = issue.status === 'FAILED' && issue.entityType === 'inventory_position'
        && /^Quantity must be a whole number greater than zero\.$/.test(issue.detail || '')
        && Number(payload.quantity) === 0;
      return { ...issue,payloadJson:undefined,retryable:Boolean(normalizedLocationKind || reorderedParent || zeroOpeningPosition),
        resolutionType:missingSerials ? 'SERIAL_AGGREGATE' : null,
        resolvedDetail:serialDetail || (normalizedLocationKind
          ? `The source value “${payload.kind}” is now understood as “${normalizedLocationKind}”. No source edit is needed.`
          : reorderedParent
            ? `Foundry will now apply parent location “${payload.parentLocationKey}” before this sublocation. No source edit is needed.`
          : zeroOpeningPosition
            ? 'This is a valid zero-on-hand source position. Foundry will preserve it as evidence without inventing a stock receipt.'
          : null) };
    });
  const checkpoints = db.prepare(`SELECT checkpoint_kind AS kind,source_cursor AS cursor,evidence_json AS evidence,
    recorded_at AS recordedAt FROM migration_cutover_checkpoints WHERE package_id=? ORDER BY recorded_at,id`)
    .all(packageId).map((row) => ({ ...row,evidence:parse(row.evidence) }));
  const deltaCount = db.prepare('SELECT COUNT(*) AS n FROM migration_source_changes WHERE package_id=?').get(packageId).n;
  const mappingProfiles = db.prepare(`SELECT id,source_dataset AS sourceDataset,entity_type AS entityType,status
    FROM migration_mapping_profiles WHERE package_id=? ORDER BY created_at,id`).all(packageId);
  const recordCounts = Object.fromEntries(db.prepare(`SELECT entity_type AS entityType,COUNT(*) AS count
    FROM migration_records WHERE package_id=? GROUP BY entity_type ORDER BY entity_type`).all(packageId)
    .map((row) => [row.entityType,Number(row.count || 0)]));
  const needsSerialResolution = issues.some((issue) => issue.resolutionType === 'SERIAL_AGGREGATE');
  const serialIdentityGap = needsSerialResolution ? missingSerialEvidence(db,packageId) : null;
  return { package: pkg, checks, issues, checkpoints, deltaCount, mappingProfiles, recordCounts, serialIdentityGap };
}

module.exports = { TYPES, createPackage, getPackage, listPackages, stagePage, validate, approve, beginCutover, apply,
  beginDeltaCapture, stageDeltaPage, freezeSource, reconcile, activateCutover, approveAndActivate,
  advanceCutover,report, setPreparationProgress, stable, hash, defaultAdapters,
  missingSerialEvidence,resolveMissingSerialEvidence,USE_AGGREGATE_QUANTITY,attachMigrationInventoryCosts };

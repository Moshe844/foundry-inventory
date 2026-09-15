'use strict';

/**
 * Browser-owned migration intake.
 *
 * Source files remain immutable in migration_sources.  This service joins
 * each real sheet to the canonical mapping and migration engines so an owner
 * can perform the entire staged cutover without a developer manufacturing a
 * package first.
 */

const { inTransaction } = require('../db');
const { newId, nowIso, requireText } = require('../lib/util');
const { ValidationError, NotFoundError, InvariantError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const parser = require('../imports/parser');
const sources = require('./source-service');
const migrations = require('./canonical-migration');
const mappings = require('./canonical-mapping');

const OWNER_TYPES = Object.freeze([
  { id:'catalog_inventory', label:'Products, SKUs and stock', hint:'A normal item export; one row per SKU/location.' },
  { id:'location', label:'Locations', hint:'Warehouses, stores, bins or other stock locations.' },
  { id:'product', label:'Products', hint:'Product parents without stock quantities.' },
  { id:'sku', label:'Variants / SKUs', hint:'Sellable or stockable variants tied to products.' },
  { id:'supplier', label:'Suppliers', hint:'Supplier identities and contact details.' },
  { id:'customer', label:'Customers', hint:'Customer identities and contact details.' },
  { id:'supplier_item', label:'Supplier item terms', hint:'Supplier SKUs, pack sizes, costs, MOQ and lead time.' },
  { id:'selling_price', label:'Selling prices', hint:'Current price by SKU.' },
  { id:'purchase_cost', label:'Purchase costs', hint:'Current cost by SKU.' },
  { id:'reorder_policy', label:'Reorder rules', hint:'Reorder point, safety stock and order-up-to levels.' },
  { id:'inventory_position', label:'Stock by location', hint:'On-hand quantity by SKU and location.' },
  { id:'purchase_order', label:'Open purchase orders', hint:'One row per PO line; repeated order numbers are grouped safely.' },
  { id:'sales_order', label:'Open sales orders', hint:'One row per sales-order line; repeated order numbers are grouped safely.' },
  { id:'history_fact', label:'Historical facts', hint:'History retained as evidence, without guessed links.' },
]);

const words = (value) => String(value || '').replace(/([a-z0-9])([A-Z])/g,'$1 $2')
  .toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const columnNames = (sheet) => (sheet.columns || []).map((column) => words(column.name));
const hasColumn = (sheet, patterns) => columnNames(sheet).some((name) => patterns.some((pattern) => pattern.test(name)));
const ORDER_KEY = [/^(?:po|purchase order) (?:id|number|no)$/, /^poid$/];
const SKU_KEY = [/^sku(?: id| code)?$/, /^item code$/, /^part number$/];
const ORDER_QTY = [/^ordered (?:qty|quantity)$/, /^quantity ordered$/, /^line quantity$/];
const SUPPLIER_KEY = [/^(?:supplier|vendor)(?: id| name)?$/];
const LOCATION_KEY = [/^(?:location|warehouse|site)(?: id| name)?$/, /^destination(?: location)?$/];

function looksLikeAggregateSummary(sheet) {
  const names = columnNames(sheet);
  const hasMetric = names.some((name) => /^(?:kpi|metric|measure|statistic|summary item)$/.test(name));
  const hasValue = names.some((name) => /^(?:value|result|total|amount)$/.test(name));
  return hasMetric && hasValue;
}

function inferEntityType(source, sheet, allSheets = source.profile?.sheets || []) {
  const has = (patterns) => hasColumn(sheet,patterns);
  // Aggregate dashboards are evidence/control totals, not one product per KPI.
  // Their plural columns ("SKUs", "Units") can otherwise look like item IDs
  // and quantities even though each row is a summary statistic.
  if (looksLikeAggregateSummary(sheet)) return 'reference_only';
  const hasOrder = has(ORDER_KEY);
  const lineLike = hasOrder && has(SKU_KEY) && has(ORDER_QTY);
  const headerLike = hasOrder && has(SUPPLIER_KEY) && (has(LOCATION_KEY)
    || has([/^order date$/, /^expected date$/, /^status$/]));
  const companionLines = allSheets.some((candidate) => candidate !== sheet
    && hasColumn(candidate,ORDER_KEY) && hasColumn(candidate,SKU_KEY) && hasColumn(candidate,ORDER_QTY));

  if (lineLike) return 'purchase_order';
  if (headerLike && companionLines) return 'reference_only';
  if (has([/^(?:transaction|movement|event) id$/])
      && has([/^(?:date time|datetime|transaction date|event date)$/])
      && has([/^(?:transaction |event )?type$/])) return 'history_fact';
  if (has([/^(?:inventory|stock|position) id$/]) && has(SKU_KEY) && has(LOCATION_KEY)
      && has([/^on hand$/, /^onhand$/, /^physical quantity$/])) return 'inventory_position';
  if (has([/^location id$/, /^warehouse id$/, /^site id$/])
      && has([/^location name$/, /^warehouse name$/, /^site name$/])) return 'location';
  if ((has([/^(?:supplier|vendor) id$/]) && has([/^(?:supplier|vendor) name$/]))
      || (has(SUPPLIER_KEY) && has([/^contact(?: name)?$/, /^email(?: address)?$/, /^phone(?: number)?$/, /^payment terms$/, /^terms$/]))) {
    return 'supplier';
  }
  if (has(SKU_KEY) && has([/^(?:item|product|parent item|parent product) id$/])) return 'sku';
  if (has([/^(?:item|product|style) id$/]) && has([/^(?:item|product) name$/])) return 'product';
  if (has(SKU_KEY) && has([/^option name$/, /^option value$/, /^customization id$/])) return 'history_fact';
  if (hasOrder) return headerLike ? 'purchase_order' : null;

  const operational = has([/^sku/, /^(?:item|product|supplier|vendor|location) (?:id|name)$/, /quantity/, /on hand/, /order/]);
  if (!operational && sheet.rows <= 250) return 'reference_only';
  const purpose = sheet.purpose || source.inferredPurpose;
  if (['inventory','stock_count','lots','serials'].includes(purpose)) return 'catalog_inventory';
  if (purpose === 'catalog') return 'catalog_inventory';
  if (purpose === 'sales_orders') return 'sales_order';
  return null;
}

function hydrateDataset(row) {
  if (!row) return null;
  let isJoinedOrderHeader = false;
  if (row.source_profile) {
    try {
      const sourceProfile = JSON.parse(row.source_profile);
      const sheet = (sourceProfile.sheets || []).find((candidate) => candidate.index === row.sheet_index);
      if (sheet) {
        const headerLike = hasColumn(sheet,ORDER_KEY) && hasColumn(sheet,SUPPLIER_KEY);
        const companionLines = (sourceProfile.sheets || []).some((candidate) => candidate.index !== row.sheet_index
          && hasColumn(candidate,ORDER_KEY) && hasColumn(candidate,SKU_KEY) && hasColumn(candidate,ORDER_QTY));
        isJoinedOrderHeader = headerLike && companionLines;
      }
    } catch { /* older source profiles remain readable without this display hint */ }
  }
  return {
    id:row.id, packageId:row.package_id, sourceId:row.source_id, sourceName:row.source_name,
    sheetIndex:row.sheet_index, sheetName:row.sheet_name, entityType:row.entity_type,
    profileId:row.mapping_profile_id, status:row.status, sourceRowCount:row.source_row_count,
    stagedRecordCount:row.staged_record_count, isJoinedOrderHeader,
    createdAt:row.created_at, updatedAt:row.updated_at,
  };
}

function getDataset(db, workspaceId, datasetId) {
  const row = db.prepare(`SELECT d.*,s.name AS source_name,s.profile AS source_profile FROM migration_source_datasets d
    JOIN migration_sources s ON s.id=d.source_id
    WHERE d.id=? AND d.workspace_id=?`).get(datasetId,workspaceId);
  if (!row) throw new NotFoundError('That source dataset is not in this inventory.');
  return hydrateDataset(row);
}

function listDatasets(db, workspaceId, packageId) {
  migrations.getPackage(db,workspaceId,packageId);
  return db.prepare(`SELECT d.*,s.name AS source_name,s.profile AS source_profile FROM migration_source_datasets d
    JOIN migration_sources s ON s.id=d.source_id
    WHERE d.workspace_id=? AND d.package_id=? ORDER BY d.created_at,d.source_id,d.sheet_index`)
    .all(workspaceId,packageId).map(hydrateDataset);
}

function sheetInput(db, workspaceId, dataset) {
  const content = sources.contentOf(db,workspaceId,dataset.sourceId);
  const parsed = parser.parse({ buffer:content.buffer, filename:content.filename });
  const sheet = parsed.sheets[dataset.sheetIndex];
  if (!sheet) throw new InvariantError('The reviewed sheet is no longer present in the immutable source.', 'migration_sheet_missing');
  let rows = sheet.rows.map((row) => Object.fromEntries(sheet.columns.map((column,index) =>
    [column.name,row.cells[index] ?? ''])));
  let columns = sheet.columns.map((column,index) => ({ name:column.name,
    samples:rows.slice(0,5).map((row) => row[column.name]).filter((value) => String(value || '').trim()) }));
  if (dataset.entityType === 'purchase_order' && hasColumn(sheet,ORDER_KEY)
      && hasColumn(sheet,SKU_KEY) && hasColumn(sheet,ORDER_QTY)) {
    const lineKeyColumn = sheet.columns.find((column) => ORDER_KEY.some((pattern) => pattern.test(words(column.name))));
    const header = parsed.sheets.find((candidate) => candidate !== sheet
      && hasColumn(candidate,ORDER_KEY) && hasColumn(candidate,SUPPLIER_KEY)
      && !hasColumn(candidate,SKU_KEY));
    if (header && lineKeyColumn) {
      const headerKeyColumn = header.columns.find((column) => ORDER_KEY.some((pattern) => pattern.test(words(column.name))));
      const headerRows = header.rows.map((row) => Object.fromEntries(header.columns.map((column,index) =>
        [column.name,row.cells[index] ?? ''])));
      const byOrder = new Map(headerRows.map((row) => [String(row[headerKeyColumn.name] ?? '').trim(),row]));
      rows = rows.map((row) => ({ ...(byOrder.get(String(row[lineKeyColumn.name] ?? '').trim()) || {}),...row }));
      const names = [...header.columns.map((column) => column.name),...sheet.columns.map((column) => column.name)]
        .filter((name,index,array) => array.indexOf(name) === index);
      columns = names.map((name) => ({ name,samples:rows.slice(0,5).map((row) => row[name])
        .filter((value) => String(value || '').trim()) }));
    }
  }
  return { sheet,rows,columns };
}

function attachProfile(db, ctx, membership, datasetId, entityType) {
  const dataset = getDataset(db,ctx.workspaceId,datasetId);
  if (dataset.status === 'STAGED') throw new InvariantError('That dataset is already staged.', 'migration_dataset_staged');
  const wanted = requireText(entityType,'Dataset type',{ max:80 }).toLowerCase();
  if (!OWNER_TYPES.some((type) => type.id === wanted)) throw new ValidationError('Choose a supported dataset type.');
  if (dataset.profileId) {
    if (dataset.entityType !== wanted) throw new InvariantError('A reviewed dataset type cannot be changed. Remove the package and start again.', 'migration_dataset_type_locked');
    return mappings.getProfile(db,ctx.workspaceId,dataset.profileId);
  }
  const { columns } = sheetInput(db,ctx.workspaceId,dataset);
  const profile = mappings.createProfile(db,ctx,membership,dataset.packageId,{
    sourceDataset:`${dataset.sourceName} · ${dataset.sheetName}`,
    entityType:wanted, columns,
  });
  db.prepare(`UPDATE migration_source_datasets SET entity_type=?,mapping_profile_id=?,status='NEEDS_MAPPING',updated_at=?
    WHERE id=?`).run(wanted,profile.id,nowIso(),dataset.id);
  const approved = mappings.approveDeterministic(db,ctx,membership,profile.id);
  if (approved) {
    db.prepare(`UPDATE migration_source_datasets SET status='READY_TO_STAGE',updated_at=? WHERE id=?`)
      .run(nowIso(),dataset.id);
    return approved;
  }
  return profile;
}

function addDatasets(db,ctx,membership,pkg,sourcesToAdd) {
  const now = nowIso();
  inTransaction(db,() => {
    for (const source of sourcesToAdd) {
      for (const sheet of source.profile.sheets || []) {
        if (!sheet.rows) continue;
        const inferred = inferEntityType(source,sheet,source.profile.sheets || []);
        const referenceOnly = inferred === 'reference_only';
        db.prepare(`INSERT OR IGNORE INTO migration_source_datasets
          (id,workspace_id,package_id,source_id,sheet_index,sheet_name,entity_type,status,source_row_count,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(newId('mds'),ctx.workspaceId,pkg.id,source.id,sheet.index,
            sheet.name,inferred,referenceOnly ? 'STAGED' : inferred ? 'NEEDS_MAPPING' : 'NEEDS_CLASSIFICATION',sheet.rows,now,now);
      }
    }
  });
  for (const dataset of listDatasets(db,ctx.workspaceId,pkg.id)) {
    if (dataset.entityType && dataset.entityType !== 'reference_only' && !dataset.profileId) {
      attachProfile(db,ctx,membership,dataset.id,dataset.entityType);
    }
  }
}

function createFromFiles(db, ctx, membership, input = {}) {
  permissions.assertCan(membership,permissions.ADMIN,'prepare an inventory migration');
  const files = Array.isArray(input.files) ? input.files.filter((file) => file && file.size > 0) : [];
  const pasted = String(input.pasted || '').trim();
  if (!files.length && !pasted) throw new ValidationError('Choose at least one export, or paste rows from a spreadsheet.');
  const stored = [];
  for (const file of files) stored.push(sources.addSource(db,ctx,membership,{ buffer:file.buffer,filename:file.filename }).source);
  if (pasted) stored.push(sources.addSource(db,ctx,membership,{ text:pasted,filename:'Pasted migration data' }).source);
  const sourceLabel = requireText(input.sourceLabel || 'Existing inventory records','Source name',{ max:160 });
  const evidence = stored.map((source) => ({ id:source.id,name:source.name,hash:source.contentHash,bytes:source.bytes }));
  const snapshotHash = migrations.hash(evidence);
  const pkg = migrations.createPackage(db,ctx,membership,{
    sourceNamespace:`owner-upload:${snapshotHash.slice(0,24)}`,
    sourceLabel,
    sourceSnapshotHash:snapshotHash,
    cutoverMode:'STATIC',
    manifest:{ sourceFiles:evidence, sourceKind:'owner_upload' },
  });
  addDatasets(db,ctx,membership,pkg,stored);
  return { package:migrations.getPackage(db,ctx.workspaceId,pkg.id), datasets:listDatasets(db,ctx.workspaceId,pkg.id) };
}

function reanalyze(db,ctx,membership,packageId) {
  permissions.assertCan(membership,permissions.ADMIN,'re-analyze an inventory migration');
  const pkg = migrations.getPackage(db,ctx.workspaceId,packageId);
  if (!['STAGING','NEEDS_ATTENTION'].includes(pkg.status)) {
    throw new InvariantError('Only a private, unapproved migration can be re-analyzed.','migration_analysis_locked');
  }
  const datasets = listDatasets(db,ctx.workspaceId,packageId);
  const changedLiveData = Number(pkg.appliedCount || 0) > 0 || db.prepare(`SELECT COUNT(*) AS n FROM migration_records
    WHERE package_id=? AND status IN ('APPLIED','VERIFIED')`).get(packageId).n > 0;
  if (changedLiveData) {
    throw new InvariantError('This migration has already changed live records and cannot be re-analyzed.','migration_analysis_has_work');
  }
  const sourceIds = [...new Set(datasets.map((dataset) => dataset.sourceId))];
  inTransaction(db,() => {
    // These are private derived records. The immutable uploaded source remains
    // untouched and is the only input to the fresh analysis.
    db.prepare('DELETE FROM migration_records WHERE package_id=?').run(packageId);
    db.prepare('DELETE FROM migration_source_reviews WHERE package_id=?').run(packageId);
    db.prepare('DELETE FROM migration_source_decisions WHERE package_id=?').run(packageId);
    db.prepare('DELETE FROM migration_source_datasets WHERE package_id=?').run(packageId);
    db.prepare('DELETE FROM migration_mapping_profiles WHERE package_id=?').run(packageId);
    db.prepare(`UPDATE migration_packages SET status='STAGING',staged_count=0,problem_count=0,
      preparation_status='IDLE',preparation_stage=NULL,preparation_completed=0,preparation_total=0,
      preparation_detail=NULL,preparation_error=NULL,updated_at=? WHERE id=?`).run(nowIso(),packageId);
  });
  addDatasets(db,ctx,membership,pkg,sourceIds.map((id) => sources.get(db,ctx.workspaceId,id)));
  return { package:pkg,datasets:listDatasets(db,ctx.workspaceId,packageId) };
}

function stageDataset(db, ctx, membership, profileId) {
  const row = db.prepare(`SELECT id FROM migration_source_datasets
    WHERE workspace_id=? AND mapping_profile_id=?`).get(ctx.workspaceId,profileId);
  if (!row) return null; // Connector-owned profiles continue to stage through their connector.
  const dataset = getDataset(db,ctx.workspaceId,row.id);
  if (dataset.status === 'STAGED') return { dataset,replayed:true };
  const { rows } = sheetInput(db,ctx.workspaceId,dataset);
  let inserted = 0;
  let enriched = 0;
  const pageSize = ['purchase_order','sales_order'].includes(dataset.entityType) ? Math.max(1,rows.length) : 1000;
  for (let offset=0;offset<rows.length;offset += pageSize) {
    const page = mappings.stageRows(db,ctx,membership,profileId,rows.slice(offset,offset + pageSize),{
      startOrdinal:offset,
    });
    inserted += page.inserted;
    enriched += page.enriched || 0;
  }
  db.prepare(`UPDATE migration_source_datasets SET status='STAGED',staged_record_count=?,updated_at=? WHERE id=?`)
    .run(inserted + enriched,nowIso(),dataset.id);
  db.prepare('DELETE FROM migration_source_reviews WHERE package_id=?').run(dataset.packageId);
  return { dataset:getDataset(db,ctx.workspaceId,dataset.id),result:{ inserted,enriched,sourceRows:rows.length } };
}

/** Upgrade older owner uploads when Foundry has since gained a deterministic
 * meaning for their columns. This is one action for the workbook, never one
 * raw form per field. */
function prepareKnownEvidence(db,ctx,membership,packageId,options = {}) {
  permissions.assertCan(membership,permissions.ADMIN,'finish automatic workbook analysis');
  const datasets = listDatasets(db,ctx.workspaceId,packageId);
  const candidates = datasets.filter((dataset) => dataset.profileId && dataset.status !== 'STAGED');
  let prepared = 0;
  for (const dataset of datasets) {
    if (!dataset.profileId || dataset.status === 'STAGED') continue;
    if (typeof options.onProgress === 'function') options.onProgress({
      completed:prepared,total:candidates.length,dataset,stage:'PREPARING',
      detail:`Preparing ${dataset.sheetName} (${Number(dataset.sourceRowCount || 0).toLocaleString()} source rows)`,
    });
    const profile = mappings.getProfile(db,ctx.workspaceId,dataset.profileId);
    const decisions = profile.mappings.filter((entry) => entry.disposition === 'UNRESOLVED')
      .map((entry) => ({ entry,proposal:mappings.suggest(profile.entityType,entry.sourceField) }))
      .filter(({ proposal }) => proposal.disposition === 'MAPPED')
      .map(({ entry,proposal }) => ({ sourceField:entry.sourceField,targetField:proposal.targetField,disposition:'MAPPED' }));
    if (decisions.length) mappings.setMappings(db,ctx,membership,profile.id,decisions);
    const approved = mappings.approveDeterministic(db,ctx,membership,profile.id);
    if (!approved) continue;
    db.prepare(`UPDATE migration_source_datasets SET status='READY_TO_STAGE',updated_at=? WHERE id=?`)
      .run(nowIso(),dataset.id);
    stageDataset(db,ctx,membership,profile.id);
    prepared += 1;
    if (typeof options.onProgress === 'function') options.onProgress({
      completed:prepared,total:candidates.length,dataset,stage:'PREPARING',
      detail:`Prepared ${dataset.sheetName}`,
    });
  }
  return { prepared,review:refreshSourceReview(db,ctx.workspaceId,packageId) };
}

function computeSourceReview(db,workspaceId,packageId) {
  migrations.getPackage(db,workspaceId,packageId);
  const records = db.prepare(`SELECT entity_type,payload_json FROM migration_records
    WHERE workspace_id=? AND package_id=? AND entity_type IN ('inventory_position','purchase_order')`)
    .all(workspaceId,packageId);
  const review = { inventoryPositions:0,onHand:0,reserved:0,damaged:0,available:0,hasIncomingClaim:false,
    sourceIncoming:0,openPurchaseOrderIncoming:0,inventoryFormulaMismatches:0,
    sourceInventoryValue:0,calculatedInventoryValue:0,inventoryValueMismatches:0,
    inventoryValueRecords:0,calculatedInventoryValueRecords:0,
    purchaseOrderFinancialMismatches:0 };
  for (const record of records) {
    const payload = JSON.parse(record.payload_json);
    if (record.entity_type === 'inventory_position') {
      review.inventoryPositions += 1;
      const onHand = Number(payload.quantity || 0);
      const reserved = Number(payload.reservedQuantity || 0);
      const damaged = Number(payload.damagedQuantity || 0);
      const available = payload.availableQuantity == null ? onHand - reserved - damaged : Number(payload.availableQuantity);
      review.onHand += onHand; review.reserved += reserved; review.damaged += damaged;
      review.available += available;
      if (payload.incomingQuantity != null) {
        review.hasIncomingClaim = true;
        review.sourceIncoming += Number(payload.incomingQuantity || 0);
      }
      if (available !== onHand - reserved - damaged) review.inventoryFormulaMismatches += 1;
      if (payload.inventoryValue != null) {
        review.inventoryValueRecords += 1;
        const sourceValue = Number(payload.inventoryValue);
        review.sourceInventoryValue += sourceValue;
        if (payload.unitCost != null) {
          review.calculatedInventoryValueRecords += 1;
          const calculated = onHand * Number(payload.unitCost);
          review.calculatedInventoryValue += calculated;
          if (Math.abs(sourceValue - calculated) > 0.011) review.inventoryValueMismatches += 1;
        }
      }
    } else {
      review.openPurchaseOrderIncoming += (payload.lines || []).reduce((sum,line) => sum + Number(line.quantityUnits || 0),0);
      const money = payload.sourceFinancialEvidence || {};
      if (money.total != null && money.subtotal != null
          && Math.abs(Number(money.total) - (Number(money.subtotal) + Number(money.shipping || 0) + Number(money.tax || 0))) > 0.011) {
        review.purchaseOrderFinancialMismatches += 1;
      }
      if (money.subtotal != null && money.lineTotal != null
          && Math.abs(Number(money.subtotal) - Number(money.lineTotal)) > 0.011) {
        review.purchaseOrderFinancialMismatches += 1;
      }
    }
  }
  // Older staged packages predate canonical PO charge fields. Re-read their
  // immutable source bytes so the upgraded verifier does not mistake missing
  // staged metadata for agreement.
  if (!review.purchaseOrderFinancialMismatches) {
    for (const dataset of listDatasets(db,workspaceId,packageId).filter((entry) => entry.entityType === 'purchase_order')) {
      const { rows } = sheetInput(db,workspaceId,dataset);
      const find = (wanted) => Object.keys(rows[0] || {}).find((name) => wanted.includes(words(name)));
      const orderField = find(['poid','po id','po number','purchase order id','purchase order number']);
      const subtotalField = find(['subtotal','order subtotal']);
      const shippingField = find(['shipping','shipping amount','freight','freight amount']);
      const taxField = find(['tax','tax amount']);
      const totalField = find(['total','order total']);
      const lineTotalField = find(['line total','line amount']);
      if (!orderField || (!totalField && !subtotalField)) continue;
      const groups = new Map();
      for (const row of rows) {
        const key = String(row[orderField] || '').trim();
        if (!key) continue;
        const group = groups.get(key) || { subtotal:Number(row[subtotalField] || 0),shipping:Number(row[shippingField] || 0),
          tax:Number(row[taxField] || 0),total:Number(row[totalField] || 0),lineTotal:0 };
        group.lineTotal += Number(row[lineTotalField] || 0);
        groups.set(key,group);
      }
      for (const group of groups.values()) {
        if (totalField && subtotalField && Math.abs(group.total - group.subtotal - group.shipping - group.tax) > 0.011) {
          review.purchaseOrderFinancialMismatches += 1;
        }
        if (subtotalField && lineTotalField && Math.abs(group.subtotal - group.lineTotal) > 0.011) {
          review.purchaseOrderFinancialMismatches += 1;
        }
      }
    }
  }
  review.incomingMismatch = review.hasIncomingClaim && review.sourceIncoming !== review.openPurchaseOrderIncoming;
  review.requiresDecision = review.inventoryFormulaMismatches > 0 || review.inventoryValueMismatches > 0 || review.incomingMismatch
    || review.purchaseOrderFinancialMismatches > 0;
  const decision = db.prepare(`SELECT choice,decided_at FROM migration_source_decisions
    WHERE workspace_id=? AND package_id=? AND decision_key='operational_truth'`).get(workspaceId,packageId);
  review.decision = decision ? { choice:decision.choice,decidedAt:decision.decided_at } : null;
  review.resolved = !review.requiresDecision || Boolean(decision);
  review.autoResolvable = canResolveOperationalTruthByPolicy(review);
  return review;
}

function sourceReviewCached(db,workspaceId,packageId) {
  const row = db.prepare('SELECT review_json FROM migration_source_reviews WHERE workspace_id=? AND package_id=?')
    .get(workspaceId,packageId);
  return row ? JSON.parse(row.review_json) : null;
}

function refreshSourceReview(db,workspaceId,packageId) {
  const review = computeSourceReview(db,workspaceId,packageId);
  db.prepare(`INSERT INTO migration_source_reviews (package_id,workspace_id,review_json,computed_at)
    VALUES (?,?,?,?) ON CONFLICT(package_id) DO UPDATE SET review_json=excluded.review_json,computed_at=excluded.computed_at`)
    .run(packageId,workspaceId,JSON.stringify(review),nowIso());
  return review;
}

function sourceReview(db,workspaceId,packageId) {
  return sourceReviewCached(db,workspaceId,packageId) || refreshSourceReview(db,workspaceId,packageId);
}

/**
 * Summary cells are useful evidence, but they are not safe business commands.
 * When the only disagreement is between a summary and the row-level records
 * that produced it, Foundry can make the conservative choice without asking
 * the owner to understand the import engine: operational rows control, while
 * every conflicting summary remains attached to the immutable source.
 *
 * Row-level arithmetic or value contradictions are different. Those can
 * change physical stock or accounting and still require source evidence.
 */
function canResolveOperationalTruthByPolicy(review) {
  if (!review || review.resolved || !review.requiresDecision) return false;
  const summaryConflict = Boolean(review.incomingMismatch)
    || Number(review.purchaseOrderFinancialMismatches || 0) > 0;
  const rowLevelConflict = Number(review.inventoryFormulaMismatches || 0) > 0
    || Number(review.inventoryValueMismatches || 0) > 0;
  return summaryConflict && !rowLevelConflict;
}

function resolveOperationalTruthByPolicy(db,workspaceId,packageId) {
  const review = sourceReview(db,workspaceId,packageId);
  if (!canResolveOperationalTruthByPolicy(review)) return null;
  const now = nowIso();
  const evidence = {
    ...review,
    resolution:{
      kind:'SYSTEM_POLICY',
      policy:'ROW_LEVEL_OPERATIONAL_RECORDS_OVER_CONFLICTING_SUMMARIES',
      version:1,
      explanation:'Detailed operational rows control stock, purchasing and accounting. Conflicting summaries remain immutable source evidence and cannot post business effects.',
    },
  };
  db.prepare(`INSERT INTO migration_source_decisions
    (id,workspace_id,package_id,decision_key,choice,evidence_json,decided_by_user_id,decided_at)
    VALUES (?,?,?,?,?,?,NULL,?) ON CONFLICT(package_id,decision_key) DO NOTHING`)
    .run(newId('mdec'),workspaceId,packageId,'operational_truth','DETAILED_OPERATIONAL_RECORDS',JSON.stringify(evidence),now);
  db.prepare('DELETE FROM migration_source_reviews WHERE package_id=?').run(packageId);
  return refreshSourceReview(db,workspaceId,packageId);
}

function decideOperationalTruth(db,ctx,membership,packageId,choice) {
  permissions.assertCan(membership,permissions.ADMIN,'choose migration operational truth');
  if (choice !== 'DETAILED_OPERATIONAL_RECORDS') throw new ValidationError('Choose the safe detailed-records option, or correct the workbook and upload it again.');
  const review = sourceReview(db,ctx.workspaceId,packageId);
  const now = nowIso();
  db.prepare(`INSERT INTO migration_source_decisions
    (id,workspace_id,package_id,decision_key,choice,evidence_json,decided_by_user_id,decided_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(package_id,decision_key) DO NOTHING`)
    .run(newId('mdec'),ctx.workspaceId,packageId,'operational_truth',choice,JSON.stringify(review),ctx.actorId || null,now);
  db.prepare('DELETE FROM migration_source_reviews WHERE package_id=?').run(packageId);
  return refreshSourceReview(db,ctx.workspaceId,packageId);
}

/**
 * A reviewed flat purchase-order export can safely contribute outstanding
 * supply only when its line arithmetic proves the split. This is deliberately
 * an explicit owner action for older mapping profiles where received and
 * backordered quantities were retained as evidence-only fields. It promotes
 * those exact business facts, then the canonical mapper verifies every row
 * before staging anything. Completed orders become history; only a positive,
 * reconciled remainder becomes incoming supply.
 */
function preparePurchaseOrderLifecycle(db,ctx,membership,datasetId) {
  permissions.assertCan(membership,permissions.ADMIN,'prepare open purchase orders from source evidence');
  const dataset = getDataset(db,ctx.workspaceId,datasetId);
  if (dataset.entityType !== 'purchase_order' || !dataset.profileId) {
    throw new ValidationError('That source is not a mapped purchase-order dataset.');
  }
  if (dataset.status === 'STAGED') return { dataset,replayed:true };
  const profile = mappings.getProfile(db,ctx.workspaceId,dataset.profileId);
  const lifecycleTargets = new Map([
    ['received qty','receivedQuantityUnits'],['received quantity','receivedQuantityUnits'],
    ['quantity received','receivedQuantityUnits'],['backordered qty','backorderedQuantityUnits'],
    ['backordered quantity','backorderedQuantityUnits'],['quantity backordered','backorderedQuantityUnits'],
    ['remaining qty','backorderedQuantityUnits'],['remaining quantity','backorderedQuantityUnits'],
    ['line status','lineStatus'],
  ]);
  const existingTargets = new Set(profile.mappings.filter((entry) => entry.disposition === 'MAPPED')
    .map((entry) => entry.targetField));
  const promotions = profile.mappings.filter((entry) => entry.disposition !== 'MAPPED')
    .map((entry) => ({ entry,target:lifecycleTargets.get(words(entry.sourceField)) }))
    .filter(({ target }) => target && !existingTargets.has(target));
  const promotedTargets = new Set(promotions.map(({ target }) => target));
  if (!existingTargets.has('receivedQuantityUnits') && !promotedTargets.has('receivedQuantityUnits')) {
    throw new InvariantError('The source does not identify how many units were already received. Foundry cannot calculate what is still incoming.','migration_po_received_quantity_missing');
  }
  if (!existingTargets.has('backorderedQuantityUnits') && !promotedTargets.has('backorderedQuantityUnits')) {
    throw new InvariantError('The source does not identify the remaining or backordered quantity. Foundry cannot calculate what is still incoming.','migration_po_remaining_quantity_missing');
  }
  const now = nowIso();
  inTransaction(db,() => {
    for (const { entry,target } of promotions) {
      db.prepare(`UPDATE migration_field_mappings SET target_field=?,disposition='MAPPED',confidence='OWNER',
        approved_by_user_id=?,updated_at=? WHERE profile_id=? AND source_field=?`)
        .run(target,ctx.actorId || null,now,profile.id,entry.sourceField);
    }
    db.prepare(`UPDATE migration_mapping_profiles SET status='APPROVED',approved_by_user_id=?,approved_at=COALESCE(approved_at,?),updated_at=?
      WHERE id=?`).run(ctx.actorId || null,now,now,profile.id);
    db.prepare(`UPDATE migration_source_datasets SET status='READY_TO_STAGE',updated_at=? WHERE id=?`)
      .run(now,dataset.id);
  });
  return stageDataset(db,ctx,membership,profile.id);
}

module.exports = { OWNER_TYPES, inferEntityType, createFromFiles, reanalyze, listDatasets, getDataset,
  attachProfile, stageDataset, preparePurchaseOrderLifecycle, prepareKnownEvidence, sourceReview, sourceReviewCached,
  refreshSourceReview, canResolveOperationalTruthByPolicy, resolveOperationalTruthByPolicy, decideOperationalTruth };

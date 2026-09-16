'use strict';

/**
 * Provider-neutral source mapping.
 *
 * A connector describes columns and samples; this service proposes only
 * canonical StockChief meanings. Exact canonical names are deterministic. Aliases
 * are suggestions that an owner must approve, and every other column must be
 * explicitly mapped or ignored. The model may supply an explanation in the UI,
 * but it never decides what a source field means.
 */

const { inTransaction } = require('../db');
const { newId, nowIso, requireText } = require('../lib/util');
const { ValidationError, NotFoundError, InvariantError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const migrations = require('./canonical-migration');

const FIELD_CATALOG = Object.freeze({
  catalog_inventory: {
    required: [],
    requiredAny: [['name','code']],
    fields: ['sourceKey','sourceVersion','name','baseCode','code','barcode','label','description',
      'unitLabel','trackingMode','location','quantity','serial','lotCode','receivedAt','expiresAt',
      'sellingPrice','unitCost','currency','supplier','supplierSku','reorderPoint',
      'defaultOrderQuantity','reservedQuantity','availableQuantity','incomingQuantity',
      'damagedQuantity','inventoryValue'],
  },
  location: {
    required: ['sourceKey', 'name'],
    fields: ['sourceKey','sourceVersion','name','kind','parentLocationKey','barcode','note'],
  },
  product: {
    required: ['sourceKey', 'name'],
    fields: ['sourceKey','sourceVersion','name','baseCode','description','unitLabel','trackingMode','trackSerial'],
  },
  sku: {
    required: ['productKey','code'],
    fields: ['sourceKey','sourceVersion','productKey','code','barcode','label','unitLabel',
      'supplierKey','supplierSku','purchaseUnit','unitsPerPurchaseUnit','unitCost','sellingPrice',
      'currency','reorderPoint','defaultOrderQuantity','leadTimeDays'],
  },
  supplier: {
    required: ['name'],
    fields: ['sourceKey','sourceVersion','name','code','contactName','email','phone','notes',
      'defaultLeadTimeDays','minimumOrderAmount','currency','paymentTerms'],
  },
  customer: {
    required: ['sourceKey','name'],
    fields: ['sourceKey','sourceVersion','name','company','email','phone','shippingAddress','notes'],
  },
  supplier_item: {
    required: ['sourceKey','supplierKey','skuKey'],
    fields: ['sourceKey','sourceVersion','supplierKey','skuKey','supplierSku','supplierDescription',
      'purchaseUnit','unitsPerPurchaseUnit','lastUnitCost','leadTimeDays','minimumOrderQuantity',
      'orderMultiple','isPreferred','notes'],
  },
  selling_price: {
    required: ['sourceKey','skuKey','amountMinor'],
    fields: ['sourceKey','sourceVersion','skuKey','amountMinor','currency'],
  },
  purchase_cost: {
    required: ['sourceKey','skuKey','amountMinor'],
    fields: ['sourceKey','sourceVersion','skuKey','amountMinor','currency'],
  },
  reorder_policy: {
    required: ['sourceKey','skuKey'],
    fields: ['sourceKey','sourceVersion','skuKey','locationKey','preferredSupplierKey','reorderPoint',
      'targetStock','safetyStock','defaultOrderQuantity','leadTimeDays','notes'],
  },
  inventory_position: {
    required: ['sourceKey','skuKey','locationKey','quantity'],
    fields: ['sourceKey','sourceVersion','skuKey','locationKey','quantity','bin','lotCode','receivedAt','expiresAt','note',
      'unitCost','currency','reorderPoint','defaultOrderQuantity','reservedQuantity','availableQuantity',
      'incomingQuantity','damagedQuantity','inventoryValue'],
  },
  purchase_order: {
    required: ['orderNumber','skuCode','quantityUnits'],
    requiredAny: [['supplier','supplierKey'],['destinationLocation','destinationLocationKey']],
    fields: ['sourceVersion','orderNumber','supplier','supplierKey','destinationLocation','destinationLocationKey','status','orderDate','expectedDate',
      'currency','skuCode','quantityUnits','receivedQuantityUnits','backorderedQuantityUnits','unitCost',
      'supplierSku','purchaseUnit','unitsPerPurchaseUnit','lineStatus','lineNote','notes',
      'subtotalAmount','shippingAmount','taxAmount','totalAmount','lineTotalAmount'],
  },
  sales_order: {
    required: ['orderNumber','customer','skuCode','quantity'],
    fields: ['sourceVersion','orderNumber','customer','fulfillmentLocation','status','orderDate','neededBy',
      'currency','skuCode','quantity','unitPrice','deliveryMethod','shipToAddress','lineNote','notes'],
  },
  history_fact: {
    required: ['sourceKey','factType'],
    fields: ['sourceKey','sourceVersion','factType','occurredAt','sourceRecord'],
  },
});

const FIELD_LABELS = Object.freeze({
  sourceKey:'Record ID in the old system',sourceVersion:'Old-system record version',name:'Name',
  baseCode:'Product or style code',code:'SKU / item code',barcode:'Barcode',label:'Variant description',
  description:'Description',unitLabel:'Stocking unit',trackingMode:'Tracking method',location:'Location name',
  trackSerial:'Serial-tracked item',
  quantity:'On-hand quantity',sellingPrice:'Selling price',unitCost:'Unit cost',currency:'Currency',
  supplier:'Supplier name',supplierSku:'Supplier SKU',productKey:'Product reference',skuKey:'SKU reference',
  supplierKey:'Supplier reference',locationKey:'Location reference',parentLocationKey:'Parent location reference',
  preferredSupplierKey:'Preferred supplier reference',kind:'Location type',contactName:'Contact name',
  email:'Email',phone:'Phone',company:'Company',shippingAddress:'Shipping address',notes:'Notes',note:'Note',
  defaultLeadTimeDays:'Default lead time (days)',minimumOrderAmount:'Minimum order amount',paymentTerms:'Payment terms',
  purchaseUnit:'Purchasing unit',unitsPerPurchaseUnit:'Units per purchasing unit',lastUnitCost:'Last unit cost',
  leadTimeDays:'Lead time (days)',minimumOrderQuantity:'Minimum order quantity',orderMultiple:'Order multiple',
  isPreferred:'Preferred supplier',amountMinor:'Amount in minor currency units',reorderPoint:'Reorder point',
  targetStock:'Order-up-to level',safetyStock:'Safety stock',defaultOrderQuantity:'Default order quantity',
  lotCode:'Lot / batch',receivedAt:'Received date',expiresAt:'Expiration date',factType:'History fact type',
  serial:'Serial number',occurredAt:'Occurred at',sourceRecord:'Source record reference',
  orderNumber:'Order number',customer:'Customer name',destinationLocation:'Destination location',
  fulfillmentLocation:'Fulfilment location',status:'Order status',orderDate:'Order date',
  expectedDate:'Expected arrival date',neededBy:'Needed-by date',skuCode:'Line SKU',
  quantityUnits:'Line quantity',unitPrice:'Line selling price',deliveryMethod:'Delivery method',
  receivedQuantityUnits:'Line quantity already received',backorderedQuantityUnits:'Line quantity still incoming',
  lineStatus:'Line status',
  reservedQuantity:'Reserved quantity',availableQuantity:'Available quantity',incomingQuantity:'Incoming quantity',
  damagedQuantity:'Damaged quantity',inventoryValue:'Inventory value',subtotalAmount:'Order subtotal',
  shippingAmount:'Shipping charge',taxAmount:'Tax charge',totalAmount:'Order total',lineTotalAmount:'Line total',
  shipToAddress:'Ship-to address',lineNote:'Line note',
  bin:'Bin / sublocation',
});

// Generic operational vocabulary only. There are deliberately no provider,
// file-template or catalogue-size branches here.
const ALIASES = Object.freeze({
  sourceKey: ['source id','external id','record id','record key','external key','id'],
  sourceVersion: ['source version','record version','version','etag'],
  name: ['name','title','display name','product','product name','item name'],
  baseCode: ['base code','product code','style code'],
  productKey: ['product key','product id','parent product id','parent key'],
  skuKey: ['sku key','sku id','item key','item id'],
  supplierKey: ['supplier key','supplier id','vendor key','vendor id'],
  locationKey: ['location key','location id','warehouse id','site id'],
  parentLocationKey: ['parent location key','parent location id'],
  preferredSupplierKey: ['preferred supplier key','preferred supplier id'],
  code: ['sku','item code','part number','product code'],
  barcode: ['barcode','gtin','upc','ean'],
  label: ['variant label','option label'],
  location: ['location','warehouse','site','store','branch','bin'],
  supplier: ['supplier','vendor','supplier name','vendor name'],
  description: ['description','product description'],
  supplierDescription: ['supplier description','vendor description'],
  supplierSku: ['supplier sku','vendor sku','supplier item code'],
  unitLabel: ['unit','unit label','stocking unit'],
  purchaseUnit: ['purchase unit','purchasing unit'],
  unitsPerPurchaseUnit: ['units per purchase unit','units per case','pack size'],
  trackingMode: ['tracking mode','tracking type'],
  quantity: ['quantity','qty','on hand','stock on hand','available stock'],
  reservedQuantity:['reserved','reserved quantity','quantity reserved'],
  availableQuantity:['available','available quantity','quantity available'],
  incomingQuantity:['incoming','incoming quantity','quantity incoming'],
  damagedQuantity:['damaged','damaged quantity','quantity damaged'],
  inventoryValue:['inventory value','stock value'],
  sellingPrice: ['selling price','sell price','sale price','retail price','customer price','price'],
  unitCost: ['unit cost','purchase price','buying price','wholesale cost','cost'],
  amountMinor: ['amount minor','price minor','cost minor'],
  lastUnitCost: ['unit cost','last unit cost','purchase cost'],
  reorderPoint: ['reorder point','minimum stock'],
  targetStock: ['target stock','order up to','maximum stock'],
  safetyStock: ['safety stock','buffer stock'],
  defaultOrderQuantity: ['default order quantity','order quantity'],
  minimumOrderQuantity: ['minimum order quantity','moq'],
  orderMultiple: ['order multiple','purchase multiple'],
  leadTimeDays: ['lead time days','lead time'],
  defaultLeadTimeDays: ['default lead time days','default lead time'],
  minimumOrderAmount: ['minimum order amount'],
  currency: ['currency','currency code'],
  contactName: ['contact name','contact'],
  email: ['email','email address'],
  phone: ['phone','phone number','telephone'],
  company: ['company','company name'],
  shippingAddress: ['shipping address','delivery address'],
  paymentTerms: ['payment terms','terms'],
  lotCode: ['lot','lot code','batch','batch code'],
  serial: ['serial','serial number','serial no','serial id'],
  orderNumber: ['order number','order no','order id','po number','po no','purchase order','purchase order number','sales order','sales order number','so number','so no'],
  customer: ['customer','customer name','buyer','client','client name'],
  destinationLocation: ['destination','destination location','ship to location','receiving location','warehouse'],
  fulfillmentLocation: ['fulfillment location','fulfilment location','ship from','shipping location','warehouse'],
  status: ['status','order status','po status','sales order status'],
  orderDate: ['order date','ordered date','created date'],
  expectedDate: ['expected date','expected arrival','due date','eta'],
  neededBy: ['needed by','required by','promise date','promised date'],
  skuCode: ['line sku','item sku','sku','item code','part number','product code'],
  quantityUnits: ['line quantity','ordered quantity','quantity ordered','units ordered','qty ordered','quantity','qty'],
  unitPrice: ['line price','unit price','selling price','sale price'],
  deliveryMethod: ['delivery method','fulfillment method','fulfilment method'],
  shipToAddress: ['ship to address','shipping address','delivery address'],
  lineNote: ['line note','line notes'],
  subtotalAmount:['subtotal','order subtotal'],
  shippingAmount:['shipping','shipping amount','freight','freight amount'],
  taxAmount:['tax','tax amount'],
  totalAmount:['total','order total'],
  lineTotalAmount:['line total','line amount'],
  receivedAt: ['received at','received date'],
  expiresAt: ['expires at','expiration date','expiry date'],
  factType: ['fact type','event type'],
  occurredAt: ['occurred at','event date','event time'],
  sourceRecord: ['source record','source reference'],
  note: ['note'], notes: ['notes'], kind: ['kind','location type'], isPreferred: ['preferred'],
});

const normal = (value) => String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const camelWords = (value) => normal(String(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
const INTEGER_FIELDS = new Set(['quantity','amountMinor','unitsPerPurchaseUnit','leadTimeDays',
  'defaultLeadTimeDays','minimumOrderQuantity','orderMultiple','reorderPoint','targetStock','safetyStock',
  'defaultOrderQuantity','quantityUnits','receivedQuantityUnits','backorderedQuantityUnits','reservedQuantity',
  'availableQuantity','incomingQuantity','damagedQuantity']);
const NUMBER_FIELDS = new Set(['lastUnitCost','minimumOrderAmount','sellingPrice','unitCost','unitPrice','inventoryValue',
  'subtotalAmount','shippingAmount','taxAmount','totalAmount','lineTotalAmount']);
const BOOLEAN_FIELDS = new Set(['isPreferred','trackSerial']);

// These are business concepts, not workbook or provider templates. They let a
// relational export keep its own IDs while StockChief resolves those IDs only
// inside the same immutable migration package.
const ENTITY_ALIASES = Object.freeze({
  product: {
    sourceKey:['item id','product id','master item id','style id'], name:['item name','product name'],
    baseCode:['base code','style code'], unitLabel:['uom','unit of measure'], trackSerial:['track serial','serial tracked'],
  },
  sku: {
    productKey:['item id','product id','parent item id','parent product id'],
    code:['sku','item code','variant sku'], label:['variant name','variant label'],
    unitLabel:['uom','unit of measure'],
    supplierKey:['supplier id','vendor id'], supplierSku:['supplier part no','vendor part no','vendor sku'],
    unitsPerPurchaseUnit:['pack qty','pack quantity'], sellingPrice:['sell price','selling price'],
    unitCost:['unit cost','base cost'], defaultOrderQuantity:['reorder qty','reorder quantity'],
  },
  supplier: {
    sourceKey:['supplier id','vendor id'], name:['supplier','vendor','supplier name','vendor name'],
    paymentTerms:['terms','payment terms'], minimumOrderAmount:['minimum order','minimum order amount'],
  },
  location: {
    sourceKey:['location id','warehouse id','site id'], name:['location name','warehouse name','site name'],
    kind:['type','location type'], parentLocationKey:['parent location id','parent warehouse id'],
  },
  inventory_position: {
    sourceKey:['inventory id','stock id','position id'], skuKey:['sku','sku id','item id','item code'],
    locationKey:['location id','warehouse id','site id'], quantity:['on hand','onhand','physical quantity'],
    bin:['bin','bin id','bin code','shelf'], defaultOrderQuantity:['reorder qty','reorder quantity'],
    reservedQuantity:['reserved'],availableQuantity:['available'],incomingQuantity:['incoming'],
    damagedQuantity:['damaged'],inventoryValue:['inventory value'],
  },
  purchase_order: {
    orderNumber:['poid','po id','po number','purchase order id','purchase order number'],
    supplierKey:['supplier id','vendor id'], destinationLocationKey:['location id','warehouse id','destination location id'],
    skuCode:['sku','item code','part number'], quantityUnits:['ordered qty','ordered quantity','quantity ordered'],
    receivedQuantityUnits:['received qty','received quantity','quantity received'],
    backorderedQuantityUnits:['backordered qty','backordered quantity','quantity backordered','remaining qty','remaining quantity'],
    unitCost:['unit cost','price each'], lineStatus:['line status'], lineNote:['line note','line notes'],
    subtotalAmount:['subtotal'],shippingAmount:['shipping'],taxAmount:['tax'],totalAmount:['total'],
    lineTotalAmount:['line total'],
  },
  sales_order: {
    orderNumber:['so id','so number','sales order id','sales order number'],
    customer:['customer name','customer'], skuCode:['sku','item code','part number'],
    quantity:['ordered qty','ordered quantity','quantity ordered'],
  },
  history_fact: {
    sourceKey:['transaction id','event id','movement id','history id','customization id','customisation id','record id'], factType:['transaction type','event type','type'],
    occurredAt:['date time','datetime','transaction date','event date'], sourceRecord:['reference','source reference'],
  },
});

function coerce(field,value,rowNumber) {
  if (value === undefined || value === null || value === '') return null;
  if (INTEGER_FIELDS.has(field)) {
    const number = Number(String(value).trim().replace(/[\s,]/g,''));
    if (!Number.isSafeInteger(number)) throw new ValidationError(`${field} on row ${rowNumber} must be a whole number.`);
    return number;
  }
  if (NUMBER_FIELDS.has(field)) {
    const clean = String(value).trim().replace(/[$£€¥,\s]/g,'');
    const number = Number(clean);
    if (!Number.isFinite(number)) throw new ValidationError(`${field} on row ${rowNumber} must be a number.`);
    return number;
  }
  if (BOOLEAN_FIELDS.has(field)) return value === true || ['1','true','yes','y'].includes(normal(value));
  return String(value).trim();
}

function specFor(entityType) {
  const spec = FIELD_CATALOG[String(entityType || '').trim().toLowerCase()];
  if (!spec) throw new ValidationError(`Tabular mapping is not registered for ${entityType || 'that record type'}. Structured connectors may still stage canonical records directly.`);
  return spec;
}

function suggest(entityType, sourceField) {
  const spec = specFor(entityType);
  const wanted = normal(sourceField);
  const exact = spec.fields.find((field) => camelWords(field) === wanted);
  if (exact) return { targetField: exact, disposition:'MAPPED', confidence:'EXACT', reason:'canonical field name' };
  const entityMatches = Object.entries(ENTITY_ALIASES[entityType] || {})
    .filter(([field,aliases]) => spec.fields.includes(field) && aliases.some((alias) => normal(alias) === wanted))
    .map(([field]) => field);
  if (entityMatches.length === 1) return { targetField:entityMatches[0], disposition:'MAPPED', confidence:'HIGH', reason:'record-specific business vocabulary' };
  const candidates = spec.fields.filter((field) => (ALIASES[field] || []).some((alias) => normal(alias) === wanted));
  if (candidates.length === 1) return { targetField:candidates[0], disposition:'MAPPED', confidence:'PROPOSED', reason:'generic inventory vocabulary' };
  return { targetField:null, disposition:'UNRESOLVED', confidence:'PROPOSED', reason:candidates.length ? 'ambiguous meaning' : 'no deterministic meaning' };
}

const ATTRIBUTE_ENTITIES = new Set(['catalog_inventory','product','sku','supplier','location']);
const attributeKey = (sourceField) => normal(sourceField).replace(/\s+/g,'_').slice(0,100);
const SAFE_RETAINED = Object.freeze({
  inventory_position:new Set(['last count date','last movement date']),
  purchase_order:new Set(['buyer','reference','po line id','poline id']),
});
const BLOCKING_REASON = Object.freeze({});

function hydrateProfile(db, workspaceId, profileId) {
  const row = db.prepare('SELECT * FROM migration_mapping_profiles WHERE id=? AND workspace_id=?').get(profileId, workspaceId);
  if (!row) throw new NotFoundError('That source mapping is not in this inventory.');
  const mappings = db.prepare(`SELECT source_field AS sourceField, target_field AS targetField,
    disposition, confidence, evidence_json AS evidence FROM migration_field_mappings
    WHERE profile_id=? ORDER BY rowid`).all(profileId).map((entry) => ({ ...entry,
      evidence: JSON.parse(entry.evidence || '{}') }));
  return { id:row.id, packageId:row.package_id, sourceDataset:row.source_dataset,
    entityType:row.entity_type, status:row.status, columns:JSON.parse(row.columns_json), mappings,
    approvedAt:row.approved_at, createdAt:row.created_at, updatedAt:row.updated_at };
}

function createProfile(db, ctx, membership, packageId, input = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'map source records');
  const pkg = migrations.getPackage(db, ctx.workspaceId, packageId);
  if (!['STAGING','NEEDS_ATTENTION'].includes(pkg.status)) throw new InvariantError('Source mappings are locked after validation starts.', 'migration_mapping_locked');
  const entityType = requireText(input.entityType, 'Record type', { max:80 }).toLowerCase();
  specFor(entityType);
  const sourceDataset = requireText(input.sourceDataset, 'Source dataset', { max:200 });
  const columns = (input.columns || []).map((column) => ({
    name:requireText(typeof column === 'string' ? column : column.name, 'Column name', { max:200 }),
    samples:Array.isArray(column.samples) ? column.samples.slice(0, 5).map((v) => String(v).slice(0, 300)) : [],
  }));
  if (!columns.length) throw new ValidationError('Describe at least one source column.');
  if (columns.length > 300) throw new ValidationError('Describe source datasets in groups of 300 columns or fewer.');
  if (new Set(columns.map((c) => normal(c.name))).size !== columns.length) throw new ValidationError('Source column names must be unique.');
  const existing = db.prepare('SELECT id FROM migration_mapping_profiles WHERE package_id=? AND source_dataset=?')
    .get(packageId, sourceDataset);
  if (existing) return { ...hydrateProfile(db, ctx.workspaceId, existing.id), replayed:true };
  const id = newId('map'); const now = nowIso();
  inTransaction(db, () => {
    db.prepare(`INSERT INTO migration_mapping_profiles
      (id,workspace_id,package_id,source_dataset,entity_type,status,columns_json,created_by_user_id,created_at,updated_at)
      VALUES (?,?,?,?,?,'PROPOSED',?,?,?,?)`).run(id,ctx.workspaceId,packageId,sourceDataset,entityType,
        JSON.stringify(columns),ctx.actorId || null,now,now);
    const insert = db.prepare(`INSERT INTO migration_field_mappings
      (id,workspace_id,profile_id,source_field,target_field,disposition,confidence,evidence_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const column of columns) {
      let proposal = suggest(entityType, column.name);
      if (proposal.disposition === 'UNRESOLVED' && ATTRIBUTE_ENTITIES.has(entityType)) {
        proposal = { targetField:`attribute:${attributeKey(column.name)}`, disposition:'MAPPED', confidence:'HIGH',
          reason:'preserved as a searchable custom attribute' };
      } else if (proposal.disposition === 'UNRESOLVED' && entityType === 'history_fact') {
        proposal = { targetField:null, disposition:'IGNORED', confidence:'HIGH',
          reason:'preserved inside the immutable history fact' };
      } else if (proposal.disposition === 'UNRESOLVED' && SAFE_RETAINED[entityType]?.has(normal(column.name))) {
        proposal = { targetField:null, disposition:'IGNORED', confidence:'HIGH',
          reason:'derived or descriptive value retained in the immutable source evidence' };
      } else if (proposal.disposition === 'UNRESOLVED' && BLOCKING_REASON[entityType]?.[attributeKey(column.name)]) {
        proposal = { ...proposal, reason:BLOCKING_REASON[entityType][attributeKey(column.name)] };
      }
      insert.run(newId('mapf'),ctx.workspaceId,id,column.name,proposal.targetField,proposal.disposition,
        proposal.confidence,JSON.stringify({ reason:proposal.reason, samples:column.samples }),now,now);
    }
  });
  return hydrateProfile(db, ctx.workspaceId, id);
}

function setMappings(db, ctx, membership, profileId, decisions = []) {
  permissions.assertCan(membership, permissions.ADMIN, 'approve source meanings');
  const profile = hydrateProfile(db, ctx.workspaceId, profileId);
  if (profile.status === 'APPROVED') throw new InvariantError('This source mapping is already approved.', 'mapping_already_approved');
  const spec = specFor(profile.entityType); const now = nowIso();
  inTransaction(db, () => {
    for (const decision of decisions) {
      const sourceField = requireText(decision.sourceField, 'Source column', { max:200 });
      if (!profile.columns.some((column) => column.name === sourceField)) throw new ValidationError(`${sourceField} is not a source column.`);
      const ignored = decision.disposition === 'IGNORED' || decision.targetField === null;
      const targetField = ignored ? null : requireText(decision.targetField, 'StockChief field', { max:100 });
      if (targetField && !spec.fields.includes(targetField)
          && !(ATTRIBUTE_ENTITIES.has(profile.entityType) && targetField.startsWith('attribute:'))) {
        throw new ValidationError(`${targetField} is not a ${profile.entityType} field.`);
      }
      db.prepare(`UPDATE migration_field_mappings SET target_field=?, disposition=?, confidence='OWNER',
        approved_by_user_id=?, updated_at=? WHERE profile_id=? AND source_field=?`)
        .run(targetField, ignored ? 'IGNORED' : 'MAPPED', ctx.actorId || null, now, profileId, sourceField);
    }
    db.prepare("UPDATE migration_mapping_profiles SET status='PROPOSED',updated_at=? WHERE id=?").run(now,profileId);
  });
  return hydrateProfile(db, ctx.workspaceId, profileId);
}

function approve(db, ctx, membership, profileId) {
  permissions.assertCan(membership, permissions.ADMIN, 'approve source meanings');
  const profile = hydrateProfile(db, ctx.workspaceId, profileId); const spec = specFor(profile.entityType);
  const unresolved = profile.mappings.filter((m) => m.disposition === 'UNRESOLVED');
  const mapped = profile.mappings.filter((m) => m.disposition === 'MAPPED');
  const duplicates = mapped.filter((m, index) => mapped.findIndex((other) => other.targetField === m.targetField) !== index);
  const targets = new Set(mapped.map((m) => m.targetField));
  const missing = spec.required.filter((field) => !targets.has(field));
  const missingAlternatives = (spec.requiredAny || []).filter((group) => !group.some((field) => targets.has(field)));
  if (unresolved.length || duplicates.length || missing.length || missingAlternatives.length) {
    db.prepare("UPDATE migration_mapping_profiles SET status='NEEDS_ATTENTION',updated_at=? WHERE id=?").run(nowIso(),profileId);
    const missingText = [...missing,...missingAlternatives.map((group) => group.join(' or '))];
    throw new InvariantError(`Mapping cannot be approved: ${unresolved.length} unresolved, ${duplicates.length} duplicate, missing ${missingText.join(', ') || 'none'}.`, 'mapping_incomplete');
  }
  const now = nowIso();
  db.prepare(`UPDATE migration_mapping_profiles SET status='APPROVED',approved_by_user_id=?,approved_at=?,updated_at=? WHERE id=?`)
    .run(ctx.actorId || null,now,now,profileId);
  return hydrateProfile(db, ctx.workspaceId, profileId);
}

function approveDeterministic(db, ctx, membership, profileId) {
  permissions.assertCan(membership, permissions.ADMIN, 'lock proven source meanings');
  const profile = hydrateProfile(db, ctx.workspaceId, profileId);
  if (profile.mappings.some((mapping) => mapping.disposition === 'UNRESOLVED')) return null;
  const spec = specFor(profile.entityType);
  const mapped = profile.mappings.filter((mapping) => mapping.disposition === 'MAPPED');
  const targets = new Set(mapped.map((mapping) => mapping.targetField));
  if (mapped.some((mapping,index) => mapped.findIndex((other) => other.targetField === mapping.targetField) !== index)
      || spec.required.some((field) => !targets.has(field))
      || (spec.requiredAny || []).some((group) => !group.some((field) => targets.has(field)))) return null;
  const now = nowIso();
  db.prepare(`UPDATE migration_mapping_profiles SET status='APPROVED',approved_by_user_id=NULL,
    approved_at=?,updated_at=? WHERE id=?`).run(now,now,profileId);
  return hydrateProfile(db,ctx.workspaceId,profileId);
}

function stageRows(db, ctx, membership, profileId, rows, options = {}) {
  const profile = hydrateProfile(db, ctx.workspaceId, profileId);
  if (profile.status !== 'APPROVED') throw new InvariantError('Approve the source mapping before staging its records.', 'mapping_not_approved');
  const orderDataset = ['purchase_order','sales_order'].includes(profile.entityType);
  if (!Array.isArray(rows) || !rows.length || (!orderDataset && rows.length > 5000) || rows.length > 1000000) {
    throw new ValidationError(orderDataset
      ? 'Stage 1–1,000,000 order lines at a time so repeated order numbers remain together.'
      : 'Stage 1–5,000 mapped rows at a time.');
  }
  const mapped = profile.mappings.filter((m) => m.disposition === 'MAPPED');
  const translatedRows = rows.map((row, index) => {
    const translated = {};
    for (const mapping of mapped) translated[mapping.targetField] = coerce(mapping.targetField,row[mapping.sourceField],index + 1);
    if (profile.entityType === 'history_fact' || orderDataset) translated.__sourceRow = row;
    return translated;
  });
  const records = profile.entityType === 'catalog_inventory'
    ? expandCatalogInventory(translatedRows)
    : profile.entityType === 'sku'
      ? expandSkuRows(translatedRows)
    : profile.entityType === 'inventory_position'
      ? expandInventoryPositionRows(translatedRows)
    : ['purchase_order','sales_order'].includes(profile.entityType)
      ? expandOrderRows(profile.entityType,translatedRows)
    : profile.entityType === 'history_fact'
      ? translatedRows.map((translated,index) => ({
        entityType:'history_fact',
        sourceKey:translated.sourceKey || derivedSourceKey('history_fact',translated,index + 1),
        sourceVersion:translated.sourceVersion || null,
        payload:{ factType:translated.factType || 'source_history', occurredAt:translated.occurredAt || null,
          sourceRecord:JSON.stringify(translated.__sourceRow || translated) },
      }))
    : translatedRows.map((translated,index) => {
      const sourceKey = translated.sourceKey || derivedSourceKey(profile.entityType,translated,index + 1);
      const sourceVersion = translated.sourceVersion || null;
      delete translated.sourceKey; delete translated.sourceVersion;
      if (profile.entityType === 'product' && translated.trackSerial !== null
          && translated.trackSerial !== undefined) {
        translated.trackingMode = translated.trackSerial ? 'serial' : (translated.trackingMode || 'quantity');
        delete translated.trackSerial;
      }
      translated.attributes = takeAttributes(translated);
      return { entityType:profile.entityType,sourceKey,sourceVersion,payload:translated };
    });
  let inserted = 0;
  let enriched = 0;
  for (let offset=0;offset<records.length;offset += 5000) {
    const result = migrations.stagePage(db,ctx,membership,profile.packageId,records.slice(offset,offset + 5000),
      { startOrdinal:(options.startOrdinal || 0) + offset });
    inserted += result.inserted;
    enriched += result.enriched || 0;
  }
  return { package:migrations.getPackage(db,ctx.workspaceId,profile.packageId),inserted,enriched,sourceRows:rows.length };
}

function takeAttributes(row) {
  const values = [];
  for (const key of Object.keys(row)) {
    if (!key.startsWith('attribute:')) continue;
    const value = row[key];
    delete row[key];
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      values.push({ key:key.slice('attribute:'.length), value:String(value) });
    }
  }
  return values;
}

function expandSkuRows(rows) {
  const records = [];
  rows.forEach((row,index) => {
    const customAttributes = takeAttributes(row);
    const code = requireText(row.code,'SKU / item code',{ max:160 });
    const sourceKey = row.sourceKey || code;
    const productKey = requireText(row.productKey,'Product reference',{ max:300 });
    records.push({ entityType:'sku',sourceKey,sourceVersion:row.sourceVersion || null,payload:{
      productKey,code,barcode:row.barcode || null,label:row.label || null,attributes:customAttributes,
    } });
    const currency = String(row.currency || 'USD').toUpperCase();
    if (row.sellingPrice !== null && row.sellingPrice !== undefined && row.sellingPrice !== '') {
      records.push({ entityType:'selling_price',sourceKey:`selling-price:${keyPart(sourceKey)}:${currency}`,payload:{
        skuKey:sourceKey,amountMinor:majorToMinor(row.sellingPrice,'Selling price',index + 1),currency,
      } });
    }
    if (row.unitCost !== null && row.unitCost !== undefined && row.unitCost !== '') {
      records.push({ entityType:'purchase_cost',sourceKey:`purchase-cost:${keyPart(sourceKey)}:${currency}`,payload:{
        skuKey:sourceKey,amountMinor:majorToMinor(row.unitCost,'Unit cost',index + 1),currency,
      } });
    }
    if (row.supplierKey) {
      records.push({ entityType:'supplier_item',sourceKey:`supplier-item:${keyPart(row.supplierKey)}:${keyPart(sourceKey)}`,payload:{
        supplierKey:row.supplierKey,skuKey:sourceKey,supplierSku:row.supplierSku || code,
        purchaseUnit:row.purchaseUnit || null,unitsPerPurchaseUnit:row.unitsPerPurchaseUnit || null,
        lastUnitCost:row.unitCost ?? null,leadTimeDays:row.leadTimeDays ?? null,
      } });
    }
    if (row.reorderPoint !== null && row.reorderPoint !== undefined && row.reorderPoint !== '') {
      records.push({ entityType:'reorder_policy',sourceKey:`reorder:${keyPart(sourceKey)}:all`,payload:{
        skuKey:sourceKey,preferredSupplierKey:row.supplierKey || null,reorderPoint:row.reorderPoint,
        defaultOrderQuantity:row.defaultOrderQuantity ?? null,leadTimeDays:row.leadTimeDays ?? null,
      } });
    }
  });
  return records;
}

function expandInventoryPositionRows(rows) {
  const records = [];
  rows.forEach((row,index) => {
    const sourceKey = row.sourceKey || derivedSourceKey('inventory_position',row,index + 1);
    let locationKey = requireText(row.locationKey,'Location reference',{ max:300 });
    if (row.bin) {
      const binKey = `bin:${keyPart(locationKey)}:${keyPart(row.bin)}`;
      records.push({ entityType:'location',sourceKey:binKey,payload:{
        name:String(row.bin).trim(),kind:'bin',parentLocationKey:locationKey,
      } });
      locationKey = binKey;
    }
    records.push({ entityType:'inventory_position',sourceKey,sourceVersion:row.sourceVersion || null,payload:{
      skuKey:row.skuKey,locationKey,quantity:row.quantity,lotCode:row.lotCode || null,
      receivedAt:row.receivedAt || null,expiresAt:row.expiresAt || null,note:row.note || null,
      reservedQuantity:row.reservedQuantity ?? null,availableQuantity:row.availableQuantity ?? null,
      incomingQuantity:row.incomingQuantity ?? null,damagedQuantity:row.damagedQuantity ?? null,
      inventoryValue:row.inventoryValue ?? null,
    } });
    const currency = String(row.currency || 'USD').toUpperCase();
    if (row.unitCost !== null && row.unitCost !== undefined && row.unitCost !== '') {
      records.push({ entityType:'purchase_cost',sourceKey:`purchase-cost:${keyPart(row.skuKey)}:${currency}`,payload:{
        skuKey:row.skuKey,amountMinor:majorToMinor(row.unitCost,'Unit cost',index + 1),currency,
      } });
    }
    if (row.reorderPoint !== null && row.reorderPoint !== undefined && row.reorderPoint !== '') {
      records.push({ entityType:'reorder_policy',sourceKey:`reorder:${keyPart(row.skuKey)}:${keyPart(row.locationKey)}`,payload:{
        skuKey:row.skuKey,locationKey:row.locationKey,reorderPoint:row.reorderPoint,
        defaultOrderQuantity:row.defaultOrderQuantity ?? null,
      } });
    }
  });
  return records;
}

const keyPart = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

function derivedSourceKey(entityType,row,rowNumber) {
  const candidates = {
    location:[row.name], product:[row.baseCode || row.name], sku:[row.code],
    supplier:[row.code || row.name || row.email], customer:[row.code || row.name || row.email],
    supplier_item:[row.supplierKey,row.skuKey,row.supplierSku],
    selling_price:[row.skuKey,row.currency || 'default'], purchase_cost:[row.skuKey,row.currency || 'default'],
    reorder_policy:[row.skuKey,row.locationKey || 'all'], inventory_position:[row.skuKey,row.locationKey,row.lotCode || ''],
    history_fact:[row.factType,row.sourceRecord,row.occurredAt],
  }[entityType] || [];
  const usable = candidates.map(keyPart).filter(Boolean);
  if (!usable.length) throw new ValidationError(`StockChief cannot establish a stable identity for ${entityType} row ${rowNumber}. Map Source key or the record's identifier.`);
  return `${entityType}:${usable.join(':')}`.slice(0,300);
}

function expandCatalogInventory(rows) {
  const byIdentity = new Map();
  const add = (record) => {
    const key = `${record.entityType}:${record.sourceKey}`;
    const prior = byIdentity.get(key);
    if (prior && migrations.hash(prior.payload) !== migrations.hash(record.payload)) {
      throw new ValidationError(`${record.entityType} ${record.sourceKey} appears more than once with conflicting facts.`);
    }
    if (!prior) byIdentity.set(key,record);
  };
  rows.forEach((row,index) => {
    const customAttributes = takeAttributes(row);
    const name = String(row.name || row.code || '').trim();
    if (!name) throw new ValidationError(`Product name or SKU is missing on row ${index + 1}.`);
    const code = String(row.code || '').trim();
    if (!code) throw new ValidationError(`SKU is missing on row ${index + 1}. StockChief will not invent a business identifier.`);
    const productIdentity = keyPart(row.baseCode || row.name || row.code);
    const productKey = `product:${productIdentity}`;
    const skuKey = `sku:${keyPart(code)}`;
    add({ entityType:'product',sourceKey:productKey,sourceVersion:row.sourceVersion || null,payload:{
      name,baseCode:row.baseCode || null,description:row.description || null,unitLabel:row.unitLabel || 'each',
      trackingMode:row.trackingMode || (row.serial ? 'serial' : row.lotCode ? 'lot' : 'quantity'),
    } });
    add({ entityType:'sku',sourceKey:skuKey,sourceVersion:row.sourceVersion || null,payload:{
      productKey,code,barcode:row.barcode || null,label:row.label || null,attributes:customAttributes,
    } });
    const currency = String(row.currency || 'USD').toUpperCase();
    const supplierKey = row.supplier ? `supplier:${keyPart(row.supplier)}` : null;
    if (row.location) {
      const locationKey = `location:${keyPart(row.location)}`;
      add({ entityType:'location',sourceKey:locationKey,payload:{ name:String(row.location).trim(),kind:'warehouse' } });
      if ((row.quantity !== null && row.quantity !== undefined && row.quantity !== '') || row.serial) {
        const trackedKey = row.serial ? `:serial:${keyPart(row.serial)}` : row.lotCode ? `:lot:${keyPart(row.lotCode)}` : '';
        add({ entityType:'inventory_position',sourceKey:`position:${skuKey}:${locationKey}${trackedKey}`,payload:{
          skuKey,locationKey,
          // A serial is exact identity evidence for one unit. Leave quantity
          // absent when the source omitted it so canonical validation derives
          // one from the serial rather than StockChief fabricating a count.
          quantity:row.quantity === null || row.quantity === undefined || row.quantity === ''
            ? undefined : Number(row.quantity),
          lotCode:row.lotCode || null,
          receivedAt:row.receivedAt || null,expiresAt:row.expiresAt || null,
          serials:row.serial ? [{ serial:String(row.serial).trim() }] : undefined,
          reservedQuantity:row.reservedQuantity ?? null,
          availableQuantity:row.availableQuantity ?? null,
          incomingQuantity:row.incomingQuantity ?? null,
          damagedQuantity:row.damagedQuantity ?? null,
          inventoryValue:row.inventoryValue ?? null,
          unitCost:row.unitCost ?? null,currency,
          note:'Opening position from the reviewed source export',
        } });
      }
      if (row.reorderPoint !== null && row.reorderPoint !== undefined && row.reorderPoint !== '') {
        add({ entityType:'reorder_policy',sourceKey:`reorder:${skuKey}:${locationKey}`,payload:{
          skuKey,preferredSupplierKey:supplierKey,reorderPoint:row.reorderPoint,
          defaultOrderQuantity:row.defaultOrderQuantity ?? null,
        } });
      }
    } else if (row.quantity !== null && row.quantity !== undefined && row.quantity !== '') {
      throw new ValidationError(`Location is missing on row ${index + 1}; StockChief will not guess where ${row.quantity} units are.`);
    }
    if (row.sellingPrice !== null && row.sellingPrice !== undefined && row.sellingPrice !== '') {
      add({ entityType:'selling_price',sourceKey:`selling-price:${skuKey}:${currency}`,payload:{
        skuKey,amountMinor:majorToMinor(row.sellingPrice,'Selling price',index + 1),currency,
      } });
    }
    if (row.unitCost !== null && row.unitCost !== undefined && row.unitCost !== '') {
      add({ entityType:'purchase_cost',sourceKey:`purchase-cost:${skuKey}:${currency}`,payload:{
        skuKey,amountMinor:majorToMinor(row.unitCost,'Unit cost',index + 1),currency,
      } });
    }
    if (row.supplier) {
      add({ entityType:'supplier',sourceKey:supplierKey,payload:{ name:String(row.supplier).trim(),currency } });
      add({ entityType:'supplier_item',sourceKey:`supplier-item:${supplierKey}:${skuKey}`,payload:{
        supplierKey,skuKey,supplierSku:row.supplierSku || code,lastUnitCost:row.unitCost ?? null,
      } });
    }
  });
  return [...byIdentity.values()];
}

function requireConsistent(group,row,fields,rowNumber) {
  for (const field of fields) {
    const incoming = row[field];
    if (incoming === null || incoming === undefined || incoming === '') continue;
    if (group[field] === null || group[field] === undefined || group[field] === '') group[field] = incoming;
    else if (String(group[field]) !== String(incoming)) {
      throw new ValidationError(`${field} conflicts between lines of ${group.orderNumber} (row ${rowNumber}). StockChief will not choose one.`);
    }
  }
}

function normalOrderStatus(type,value,rowNumber) {
  const raw = normal(value || 'draft').replace(/ /g,'_').toUpperCase();
  const aliases = type === 'purchase_order'
    ? { OPEN:'ORDERED',SUBMITTED:'ORDERED',SENT:'ORDERED',ISSUED:'ORDERED',
      PARTIALLY_RECEIVED:'ORDERED',PENDING:'AWAITING_APPROVAL' }
    : { OPEN:'CONFIRMED',ALLOCATED:'CONFIRMED',BACKORDERED:'CONFIRMED' };
  const status = aliases[raw] || raw;
  const allowed = type === 'purchase_order'
    ? ['DRAFT','AWAITING_APPROVAL','APPROVED','ORDERED'] : ['DRAFT','CONFIRMED'];
  if (!allowed.includes(status)) {
    throw new ValidationError(`Order status ${value} on row ${rowNumber} carries lifecycle facts this flat export cannot prove. Map a supported open state or use the structured connector contract.`);
  }
  return status;
}

/** One row per order line becomes one exact canonical order with nested lines. */
function expandOrderRows(type,rows) {
  const groups = new Map();
  rows.forEach((row,index) => {
    const rowNumber = index + 1;
    const orderNumber = requireText(row.orderNumber,'Order number',{ max:120 });
    const skuCode = requireText(row.skuCode,'Line SKU',{ max:160 });
    const quantityField = type === 'purchase_order' ? 'quantityUnits' : 'quantity';
    const quantity = Number(row[quantityField]);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new ValidationError(`Line quantity on row ${rowNumber} must be a positive whole number.`);
    let group = groups.get(orderNumber);
    if (!group) {
      group = { orderNumber,sourceVersion:row.sourceVersion || null,lines:[] };
      groups.set(orderNumber,group);
    }
    const headers = type === 'purchase_order'
      ? ['supplier','supplierKey','destinationLocation','destinationLocationKey','status','orderDate','expectedDate','currency','notes',
        'subtotalAmount','shippingAmount','taxAmount','totalAmount']
      : ['customer','fulfillmentLocation','status','orderDate','neededBy','currency','deliveryMethod','shipToAddress','notes'];
    requireConsistent(group,row,headers,rowNumber);
    if (type === 'purchase_order') {
      const hasReceived = row.receivedQuantityUnits !== null && row.receivedQuantityUnits !== undefined && row.receivedQuantityUnits !== '';
      const hasBackordered = row.backorderedQuantityUnits !== null && row.backorderedQuantityUnits !== undefined && row.backorderedQuantityUnits !== '';
      const received = hasReceived ? Number(row.receivedQuantityUnits) : 0;
      const remaining = hasBackordered ? Number(row.backorderedQuantityUnits) : quantity - received;
      if (!Number.isSafeInteger(received) || received < 0 || !Number.isSafeInteger(remaining) || remaining < 0) {
        throw new ValidationError(`Received and remaining quantities on row ${rowNumber} must be non-negative whole numbers.`);
      }
      if (hasReceived && hasBackordered && quantity !== received + remaining) {
        throw new ValidationError(`Ordered, received and remaining quantities do not reconcile on row ${rowNumber}. StockChief will not choose which quantity is right.`);
      }
      group.lines.push({
      skuKey:`sku:${keyPart(skuCode)}`,quantityUnits:remaining,orderedQuantityUnits:quantity,
      receivedQuantityUnits:received,backorderedQuantityUnits:remaining,lineStatus:row.lineStatus || null,
      unitCost:row.unitCost ?? null,lineTotalAmount:row.lineTotalAmount ?? null,
      supplierSku:row.supplierSku || null,purchaseUnit:row.purchaseUnit || null,
      unitsPerPurchaseUnit:row.unitsPerPurchaseUnit || null,notes:row.lineNote || null,
      sourceRow:row.__sourceRow || null,
    });
    }
    else group.lines.push({ skuKey:`sku:${keyPart(skuCode)}`,quantity,
      unitPriceMinor:row.unitPrice === null || row.unitPrice === undefined ? null
        : majorToMinor(row.unitPrice,'Line selling price',rowNumber),notes:row.lineNote || null });
  });
  const records = [];
  for (const group of groups.values()) {
    const rawStatus = normal(group.status || 'draft').replace(/ /g,'_').toUpperCase();
    const historicalPurchaseOrder = type === 'purchase_order' && ['RECEIVED','CLOSED'].includes(rawStatus);
    const status = historicalPurchaseOrder ? null : normalOrderStatus(type,group.status,1);
    if (type === 'purchase_order') {
      const supplier = group.supplier ? requireText(group.supplier,'Supplier',{ max:200 }) : null;
      const location = group.destinationLocation ? requireText(group.destinationLocation,'Destination location',{ max:200 }) : null;
      const supplierKey = group.supplierKey || `supplier:${keyPart(supplier)}`;
      const locationKey = group.destinationLocationKey || `location:${keyPart(location)}`;
      const historyPayload = {
        factType:'purchase_order_source_state',occurredAt:group.orderDate || null,
        sourceRecord:JSON.stringify({ orderNumber:group.orderNumber,status:group.status || 'Draft',
          expectedDate:group.expectedDate || null,supplierKey,destinationLocationKey:locationKey,
          financialEvidence:{ subtotal:group.subtotalAmount ?? null,shipping:group.shippingAmount ?? null,
            tax:group.taxAmount ?? null,total:group.totalAmount ?? null,
            lineTotal:group.lines.reduce((sum,line) => sum + Number(line.lineTotalAmount || 0),0) },
          lines:group.lines.map((line) => ({ skuKey:line.skuKey,orderedQuantityUnits:line.orderedQuantityUnits,
            receivedQuantityUnits:line.receivedQuantityUnits,backorderedQuantityUnits:line.backorderedQuantityUnits,
            lineStatus:line.lineStatus,sourceRow:line.sourceRow })) }),
      };
      const remainingLines = group.lines.filter((line) => line.quantityUnits > 0).map((line) => ({
        skuKey:line.skuKey,quantityUnits:line.quantityUnits,unitCost:line.unitCost,
        supplierSku:line.supplierSku,purchaseUnit:line.purchaseUnit,
        unitsPerPurchaseUnit:line.unitsPerPurchaseUnit,notes:line.notes,
      }));
      if (historicalPurchaseOrder || group.lines.some((line) => line.receivedQuantityUnits > 0)) {
        records.push({ entityType:'history_fact',sourceKey:`purchase-order-history:${keyPart(group.orderNumber)}`,
          sourceVersion:group.sourceVersion,payload:historyPayload });
      }
      if (!historicalPurchaseOrder && remainingLines.length) {
        if (supplier) records.push({ entityType:'supplier',sourceKey:supplierKey,payload:{ name:supplier,currency:group.currency || 'USD' } });
        if (location) records.push({ entityType:'location',sourceKey:locationKey,payload:{ name:location,kind:'warehouse' } });
        records.push({ entityType:type,sourceKey:`purchase-order:${keyPart(group.orderNumber)}`,sourceVersion:group.sourceVersion,payload:{
          orderNumber:group.orderNumber,supplierKey,destinationLocationKey:locationKey,status,
          orderDate:group.orderDate || null,expectedDate:group.expectedDate || null,currency:group.currency || 'USD',
          sourceFinancialEvidence:{ subtotal:group.subtotalAmount ?? null,shipping:group.shippingAmount ?? null,
            tax:group.taxAmount ?? null,total:group.totalAmount ?? null,
            lineTotal:group.lines.reduce((sum,line) => sum + Number(line.lineTotalAmount || 0),0) },
          notes:group.notes || (rawStatus === 'PARTIALLY_RECEIVED'
            ? 'Imported outstanding quantity from a source order with verified partial-receipt totals.' : null),lines:remainingLines,
        } });
      }
    } else {
      const customer = requireText(group.customer,'Customer',{ max:200 });
      const customerKey = `customer:${keyPart(customer)}`;
      const payload = { orderNumber:group.orderNumber,customerKey,status,orderDate:group.orderDate || null,
        neededBy:group.neededBy || null,currency:group.currency || 'USD',deliveryMethod:group.deliveryMethod || 'SHIP',
        shipToAddress:group.shipToAddress || null,notes:group.notes || null,lines:group.lines };
      records.push({ entityType:'customer',sourceKey:customerKey,payload:{ name:customer } });
      if (group.fulfillmentLocation) {
        const locationKey = `location:${keyPart(group.fulfillmentLocation)}`;
        records.push({ entityType:'location',sourceKey:locationKey,payload:{ name:group.fulfillmentLocation,kind:'warehouse' } });
        payload.fulfillmentLocationKey = locationKey;
      }
      records.push({ entityType:type,sourceKey:`sales-order:${keyPart(group.orderNumber)}`,sourceVersion:group.sourceVersion,payload });
    }
  }
  return records;
}

function majorToMinor(value,label,rowNumber) {
  const clean = String(value).trim().replace(/[$£€¥,\s]/g,'');
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) {
    throw new ValidationError(`${label} on row ${rowNumber} must be an amount with no more than two decimal places.`);
  }
  const [whole,fraction=''] = clean.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2,'0'));
  if (!Number.isSafeInteger(result)) throw new ValidationError(`${label} on row ${rowNumber} is outside the supported range.`);
  return result;
}

function listProfiles(db, workspaceId, packageId) {
  return db.prepare('SELECT id FROM migration_mapping_profiles WHERE workspace_id=? AND package_id=? ORDER BY created_at,id')
    .all(workspaceId,packageId).map((row) => hydrateProfile(db,workspaceId,row.id));
}

module.exports = { FIELD_CATALOG, FIELD_LABELS, suggest, createProfile, setMappings, approve, approveDeterministic, stageRows,
  getProfile:hydrateProfile, listProfiles };

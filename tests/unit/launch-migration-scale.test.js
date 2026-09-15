'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { after } = require('node:test');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');
const migration = require('../../src/onboarding/canonical-migration');
const attributes = require('../../src/catalog/attributes');
const itemService = require('../../src/domain/item-service');
const mapping = require('../../src/onboarding/canonical-mapping');
const ownerMigration = require('../../src/onboarding/owner-migration');
const needsYou = require('../../src/manager/needs-you-inbox');
const search = require('../../src/domain/search-service');
const prices = require('../../src/pricing/price-service');
const salesOrders = require('../../src/sales/sales-order-service');
const XLSX = require('xlsx');

after(cleanupAll);

test('a provider-neutral cutover stages, applies, reconciles and activates exact operational truth', () => {
  const { db } = makeDatabase();
  const seeded = seedWorkspace(db);
  const member = { role: 'owner' };
  const pkg = migration.createPackage(db, seeded.ctx, member, {
    sourceNamespace: 'source-tenant-42', sourceLabel: 'Previous inventory system',
    sourceSnapshotHash: 'snapshot-001',
  });
  const records = [
    { entityType: 'location', sourceKey: 'loc-east', payload: { name: 'East DC', kind: 'Warehouse' } },
    { entityType: 'product', sourceKey: 'product-shoe', payload: { name: 'Trail Shoe', trackingMode: 'quantity' } },
    { entityType: 'sku_batch', sourceKey: 'product-shoe:page-1', payload: { productKey: 'product-shoe', variants: [
      { sourceKey: 'sku-blue-9', code: 'SHOE-BLUE-9', label: 'Blue / 9', barcode: '100000000009',
        options: { Colour: 'Blue', Size: '9', Width: 'Regular', Season: 'Core' } },
      { sourceKey: 'sku-blue-10', code: 'SHOE-BLUE-10', label: 'Blue / 10', barcode: '100000000010',
        options: { Colour: 'Blue', Size: '10', Width: 'Regular', Season: 'Core' } },
    ] } },
    { entityType: 'attribute', sourceKey: 'attr-core', payload: {
      subjectType: 'product', subjectKey: 'product-shoe', key: 'category', value: 'Footwear',
    } },
    { entityType: 'supplier', sourceKey: 'supplier-abc', payload: { name: 'ABC Supply', currency: 'USD' } },
    { entityType: 'customer', sourceKey: 'customer-one', payload: { name: 'Customer One', email: 'one@example.test' } },
    { entityType: 'supplier_item', sourceKey: 'supplier-blue-9', payload: {
      supplierKey: 'supplier-abc', skuKey: 'sku-blue-9', supplierSku: 'ABC-BLUE-9',
      lastUnitCost: 62, leadTimeDays: 12, purchaseUnit: 'case', unitsPerPurchaseUnit: 6,
      minimumOrderQuantity: 6, orderMultiple: 6, isPreferred: true,
    } },
    { entityType: 'selling_price', sourceKey: 'price-blue-9', payload: { skuKey: 'sku-blue-9', amountMinor: 12900, currency: 'USD' } },
    { entityType: 'purchase_cost', sourceKey: 'cost-blue-9', payload: { skuKey: 'sku-blue-9', amountMinor: 6200, currency: 'USD' } },
    { entityType: 'reorder_policy', sourceKey: 'policy-blue-9', payload: {
      skuKey: 'sku-blue-9', locationKey: 'loc-east', preferredSupplierKey: 'supplier-abc',
      reorderPoint: 12, targetStock: 30, safetyStock: 6,
    } },
    { entityType: 'purchase_order', sourceKey: 'open-po-1', payload: {
      supplierKey: 'supplier-abc', destinationLocationKey: 'loc-east', status: 'ORDERED',
      lines: [{ skuKey: 'sku-blue-9', quantityUnits: 12, unitCost: 62 }],
    } },
    { entityType: 'sales_order', sourceKey: 'open-so-1', payload: {
      customerKey: 'customer-one', fulfillmentLocationKey: 'loc-east', status: 'CONFIRMED',
      lines: [{ skuKey: 'sku-blue-9', quantity: 3, unitPriceMinor: 12900 }],
    } },
    { entityType: 'inventory_position', sourceKey: 'pos-east-blue-9', payload: {
      skuKey: 'sku-blue-9', locationKey: 'loc-east', quantity: 52418,
    } },
    { entityType: 'history_fact', sourceKey: 'legacy-movement-1', payload: {
      factType: 'legacy_inventory_movement', occurredAt: '2025-01-01T00:00:00.000Z', quantity: -2,
      sourceRecord: 'legacy-movement-1',
    } },
  ];
  assert.equal(migration.stagePage(db, seeded.ctx, member, pkg.id, records).inserted, records.length);
  assert.equal(migration.validate(db, seeded.ctx, member, pkg.id).problems, 0);
  migration.approve(db, seeded.ctx, member, pkg.id);
  const applied = migration.apply(db, seeded.ctx, member, pkg.id);
  assert.equal(applied.remaining, 0);
  const reconciled = migration.reconcile(db, seeded.ctx, member, pkg.id);
  assert.equal(reconciled.matched, true, JSON.stringify(reconciled.checks));
  assert.equal(reconciled.checks.find((check) => check.key === 'inventory.units').source, 52418);
  assert.equal(reconciled.checks.find((check) => check.key === 'inventory.units').foundry, 52418);
  assert.equal(reconciled.checks.find((check) => check.key === 'purchase_order.units').foundry, 12);
  assert.equal(reconciled.checks.find((check) => check.key === 'purchase_order.incoming_units').foundry, 12);
  assert.equal(reconciled.checks.find((check) => check.key === 'sales_order.units').foundry, 3);
  assert.equal(reconciled.checks.find((check) => check.key === 'sales_order.open_units').foundry, 3);
  assert.equal(migration.activateCutover(db, seeded.ctx, member, pkg.id).status, 'CUTOVER_ACTIVE');

  const sku = db.prepare("SELECT * FROM skus WHERE workspace_id = ? AND code = 'SHOE-BLUE-9'").get(seeded.workspaceId);
  assert.equal(sku.barcode, '100000000009');
  assert.equal(db.prepare('SELECT on_hand FROM balances WHERE workspace_id = ? AND sku_id = ?')
    .get(seeded.workspaceId, sku.id).on_hand, 52418);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM item_options WHERE workspace_id = ? AND item_id = ?")
    .get(seeded.workspaceId, sku.item_id).n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migration_history_facts WHERE package_id = ?')
    .get(pkg.id).n, 1);
});

test('unknown source identities block before any operational mutation and cutover cannot be forced', () => {
  const { db } = makeDatabase();
  const seeded = seedWorkspace(db);
  const member = { role: 'owner' };
  const pkg = migration.createPackage(db, seeded.ctx, member, {
    sourceNamespace: 'arbitrary-provider', sourceLabel: 'Arbitrary provider', sourceSnapshotHash: 'broken-1',
  });
  migration.stagePage(db, seeded.ctx, member, pkg.id, [{ entityType: 'inventory_position', sourceKey: 'position-1',
    payload: { skuKey: 'missing-sku', locationKey: 'missing-location', quantity: 10 } }]);
  const checked = migration.validate(db, seeded.ctx, member, pkg.id);
  assert.equal(checked.package.status, 'NEEDS_ATTENTION');
  assert.equal(checked.problems, 1);
  assert.throws(() => migration.approve(db, seeded.ctx, member, pkg.id), /Resolve every migration problem/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND reference LIKE 'migration:%'")
    .get(seeded.workspaceId).n, 0);
});

test('an evidenced pack conversion does not stop because its optional label is blank', () => {
  const { db } = makeDatabase();
  const seeded = seedWorkspace(db); const member = { role:'owner' };
  const pkg = migration.createPackage(db,seeded.ctx,member,{
    sourceNamespace:'owner-upload:unlabelled-pack',sourceLabel:'Supplier export',sourceSnapshotHash:'unlabelled-pack-1',
  });
  migration.stagePage(db,seeded.ctx,member,pkg.id,[
    { entityType:'product',sourceKey:'P1',payload:{ name:'Shoe',trackingMode:'quantity' } },
    { entityType:'sku',sourceKey:'SKU1',payload:{ productKey:'P1',code:'SKU1' } },
    { entityType:'supplier',sourceKey:'V1',payload:{ name:'Supplier One' } },
    { entityType:'supplier_item',sourceKey:'V1:SKU1',payload:{ supplierKey:'V1',skuKey:'SKU1',
      supplierSku:'V1-SKU1',purchaseUnit:null,unitsPerPurchaseUnit:2,lastUnitCost:10 } },
  ]);
  assert.equal(migration.validate(db,seeded.ctx,member,pkg.id).problems,0);
  migration.approve(db,seeded.ctx,member,pkg.id);
  assert.equal(migration.apply(db,seeded.ctx,member,pkg.id,{ limit:5000 }).remaining,0);
  const linked = db.prepare('SELECT purchase_unit,units_per_purchase_unit FROM supplier_items WHERE workspace_id=?')
    .get(seeded.workspaceId);
  assert.deepEqual(linked,{ purchase_unit:'pack',units_per_purchase_unit:2 });
});

test('a repaired location-kind stop is presented as resumable and remains visible in Needs You', () => {
  const { db } = makeDatabase();
  const seeded = seedWorkspace(db); const member = { role:'owner' };
  const pkg = migration.createPackage(db,seeded.ctx,member,{
    sourceNamespace:'owner-upload:retryable-location',sourceLabel:'Large workbook',sourceSnapshotHash:'retryable-location-1',
  });
  migration.stagePage(db,seeded.ctx,member,pkg.id,[
    { entityType:'location',sourceKey:'MAIN',payload:{ name:'Main Distribution Center',kind:'Warehouse' } },
  ]);
  assert.equal(migration.validate(db,seeded.ctx,member,pkg.id).problems,0);
  migration.approve(db,seeded.ctx,member,pkg.id);
  db.prepare(`UPDATE migration_records SET status='FAILED',issue_code='DOMAIN_REJECTED',
    issue_detail='Location type must be one of: warehouse, store, other.' WHERE package_id=?`).run(pkg.id);
  db.prepare("UPDATE migration_packages SET status='FAILED',problem_count=1 WHERE id=?").run(pkg.id);
  const report = migration.report(db,seeded.workspaceId,pkg.id);
  assert.equal(report.issues[0].retryable,true);
  assert.match(report.issues[0].resolvedDetail,/understood as “warehouse”/);
  const waiting = needsYou.fromMigrations(db,seeded.workspaceId);
  assert.equal(waiting.length,1);
  assert.match(waiting[0].title,/safely paused and ready to resume/);
});

test('missing serial identities become one governed source-wide decision without workbook-specific rules', () => {
  const { db } = makeDatabase();
  const seeded = seedWorkspace(db); const member = { role:'owner' };
  const pkg = migration.createPackage(db,seeded.ctx,member,{
    sourceNamespace:'owner-upload:any-system',sourceLabel:'Unrelated source',sourceSnapshotHash:'serial-gap-1',
  });
  migration.stagePage(db,seeded.ctx,member,pkg.id,[
    { entityType:'location',sourceKey:'L1',payload:{ name:'Primary',kind:'warehouse' } },
    { entityType:'product',sourceKey:'P1',payload:{ name:'Device',trackingMode:'serial' } },
    { entityType:'sku',sourceKey:'S1',payload:{ productKey:'P1',code:'DEVICE-1' } },
    { entityType:'inventory_position',sourceKey:'POS1',payload:{ skuKey:'S1',locationKey:'L1',quantity:7,inventoryValue:70 } },
  ]);
  const checked = migration.validate(db,seeded.ctx,member,pkg.id);
  assert.equal(checked.problems,1);
  const report = migration.report(db,seeded.workspaceId,pkg.id);
  assert.deepEqual({ products:report.serialIdentityGap.products.length,positions:report.serialIdentityGap.positionCount,
    quantity:report.serialIdentityGap.quantity,canResolve:report.serialIdentityGap.canUseAggregateQuantity },
  { products:1,positions:1,quantity:7,canResolve:true });
  const resolved = migration.resolveMissingSerialEvidence(db,seeded.ctx,member,pkg.id,
    migration.USE_AGGREGATE_QUANTITY);
  assert.equal(resolved.package.status,'READY');
  migration.approve(db,seeded.ctx,member,pkg.id);
  assert.equal(migration.apply(db,seeded.ctx,member,pkg.id,{ limit:5000 }).remaining,0);
  const item = db.prepare("SELECT tracking_mode FROM items WHERE workspace_id=? AND name='Device'").get(seeded.workspaceId);
  assert.equal(item.tracking_mode,'quantity');
  assert.equal(db.prepare('SELECT SUM(on_hand) AS n FROM balances WHERE workspace_id=?').get(seeded.workspaceId).n,7);
  assert.equal(db.prepare(`SELECT SUM(total_cost_minor) AS n FROM accounting_inventory_cost_balances
    WHERE workspace_id=?`).get(seeded.workspaceId).n,7000);
  const decision = db.prepare(`SELECT evidence_json FROM migration_source_decisions
    WHERE package_id=? AND decision_key='missing_serial_identities'`).get(pkg.id);
  assert.equal(JSON.parse(decision.evidence_json).provenQuantity,7);
});

test('a zero-on-hand source position reconciles without a fabricated receipt', () => {
  const { db } = makeDatabase();
  const seeded = seedWorkspace(db); const member = { role:'owner' };
  const pkg = migration.createPackage(db,seeded.ctx,member,{
    sourceNamespace:'owner-upload:zero-position',sourceLabel:'Any inventory export',sourceSnapshotHash:'zero-position-1',
  });
  migration.stagePage(db,seeded.ctx,member,pkg.id,[
    { entityType:'location',sourceKey:'L1',payload:{ name:'Primary',kind:'warehouse' } },
    { entityType:'product',sourceKey:'P1',payload:{ name:'Item',trackingMode:'quantity' } },
    { entityType:'sku',sourceKey:'S1',payload:{ productKey:'P1',code:'ITEM-1' } },
    { entityType:'inventory_position',sourceKey:'POS-ZERO',payload:{ skuKey:'S1',locationKey:'L1',quantity:0,
      incomingQuantity:0,reservedQuantity:0,damagedQuantity:0,availableQuantity:0 } },
  ]);
  assert.equal(migration.validate(db,seeded.ctx,member,pkg.id).problems,0);
  migration.approve(db,seeded.ctx,member,pkg.id);
  const applied = migration.apply(db,seeded.ctx,member,pkg.id,{ limit:5000 });
  assert.equal(applied.error,undefined);
  assert.equal(applied.remaining,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id=?').get(seeded.workspaceId).n,0);
  const record = db.prepare(`SELECT status,target_type FROM migration_records
    WHERE package_id=? AND source_key='POS-ZERO'`).get(pkg.id);
  assert.deepEqual(record,{ status:'APPLIED',target_type:'migration_record' });
  assert.equal(migration.reconcile(db,seeded.ctx,member,pkg.id).matched,true);
});

test('exact imported PO stock units are not rounded by an unrelated supplier pack default', () => {
  const { db } = makeDatabase();
  const seeded = seedWorkspace(db); const member = { role:'owner' };
  const pkg = migration.createPackage(db,seeded.ctx,member,{
    sourceNamespace:'owner-upload:exact-po-units',sourceLabel:'Any purchasing export',sourceSnapshotHash:'po-units-1',
  });
  migration.stagePage(db,seeded.ctx,member,pkg.id,[
    { entityType:'location',sourceKey:'L1',payload:{ name:'Primary',kind:'warehouse' } },
    { entityType:'product',sourceKey:'P1',payload:{ name:'Item',trackingMode:'quantity' } },
    { entityType:'sku',sourceKey:'S1',payload:{ productKey:'P1',code:'ITEM-1' } },
    { entityType:'supplier',sourceKey:'V1',payload:{ name:'Supplier' } },
    { entityType:'supplier_item',sourceKey:'V1:S1',payload:{ supplierKey:'V1',skuKey:'S1',
      purchaseUnit:'case',unitsPerPurchaseUnit:4,lastUnitCost:5 } },
    { entityType:'purchase_order',sourceKey:'PO1',payload:{ orderNumber:'PO1',supplierKey:'V1',
      destinationLocationKey:'L1',status:'ORDERED',lines:[{ skuKey:'S1',quantityUnits:7,unitCost:5 }] } },
  ]);
  assert.equal(migration.validate(db,seeded.ctx,member,pkg.id).problems,0);
  migration.approve(db,seeded.ctx,member,pkg.id);
  assert.equal(migration.apply(db,seeded.ctx,member,pkg.id,{ limit:5000 }).remaining,0);
  const target = db.prepare("SELECT target_id FROM migration_records WHERE package_id=? AND entity_type='purchase_order'").get(pkg.id);
  assert.equal(db.prepare('SELECT SUM(quantity_units) AS n FROM purchase_order_lines WHERE purchase_order_id=?').get(target.target_id).n,7);
  // Simulate a package created by the older importer, which rounded 7 exact
  // stock units to two 4-unit cases. Reconciliation repairs it through the PO
  // domain and records the correction.
  db.prepare(`UPDATE purchase_order_lines SET purchase_unit='case',units_per_purchase_unit=4,
    quantity_purchase_units=2,quantity_units=8 WHERE purchase_order_id=?`).run(target.target_id);
  db.prepare("UPDATE migration_packages SET status='NEEDS_ATTENTION' WHERE id=?").run(pkg.id);
  const reconciled = migration.reconcile(db,seeded.ctx,member,pkg.id);
  assert.equal(reconciled.matched,true);
  assert.equal(db.prepare('SELECT SUM(quantity_units) AS n FROM purchase_order_lines WHERE purchase_order_id=?').get(target.target_id).n,7);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM purchase_order_events
    WHERE purchase_order_id=? AND event='migration_quantity_reconciled'`).get(target.target_id).n,1);
});

test('location hierarchy applies parents before children even when workbook rows are reversed', () => {
  const { db } = makeDatabase();
  const seeded = seedWorkspace(db); const member = { role:'owner' };
  const pkg = migration.createPackage(db,seeded.ctx,member,{
    sourceNamespace:'owner-upload:reversed-locations',sourceLabel:'Reversed locations',sourceSnapshotHash:'reversed-locations-1',
  });
  migration.stagePage(db,seeded.ctx,member,pkg.id,[
    { entityType:'location',sourceKey:'BIN-1',payload:{ name:'Bin 1',kind:'Bin',parentLocationKey:'WH-A' } },
    { entityType:'location',sourceKey:'WH-A',payload:{ name:'Warehouse A',kind:'Warehouse' } },
  ]);
  assert.equal(migration.validate(db,seeded.ctx,member,pkg.id).problems,0);
  migration.approve(db,seeded.ctx,member,pkg.id);
  assert.equal(migration.apply(db,seeded.ctx,member,pkg.id).remaining,0);
  const parent = db.prepare("SELECT id FROM locations WHERE workspace_id=? AND name='Warehouse A'").get(seeded.workspaceId);
  const child = db.prepare("SELECT parent_location_id FROM locations WHERE workspace_id=? AND name='Bin 1'").get(seeded.workspaceId);
  assert.equal(child.parent_location_id,parent.id);
});

test('a verified migration preserves a source catalogue larger than the normal plan boundary', () => {
  const { db } = makeDatabase();
  const seeded = seedWorkspace(db); const member = { role:'owner' };
  const pkg = migration.createPackage(db,seeded.ctx,member,{
    sourceNamespace:'owner-upload:existing-large-catalogue',sourceLabel:'Existing large catalogue',sourceSnapshotHash:'large-catalogue-1',
  });
  const records = [{ entityType:'product',sourceKey:'P1',payload:{ name:'Existing catalogue',trackingMode:'quantity' } }];
  for (let index=0;index<501;index += 1) records.push({ entityType:'sku',sourceKey:`SKU-${index}`,
    payload:{ productKey:'P1',code:`SKU-${index}`,label:`Variant ${index}` } });
  migration.stagePage(db,seeded.ctx,member,pkg.id,records);
  assert.equal(migration.validate(db,seeded.ctx,member,pkg.id).problems,0);
  migration.approve(db,seeded.ctx,member,pkg.id);
  assert.equal(migration.apply(db,seeded.ctx,member,pkg.id,{ limit:5000 }).remaining,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM skus WHERE workspace_id=?').get(seeded.workspaceId).count,501);
});

test('summary contradictions are resolved by the conservative row-level policy and unavailable stock cannot be allocated', () => {
  const { db } = makeDatabase(); const seeded = seedWorkspace(db); const member = { role:'owner' };
  const pkg = migration.createPackage(db,seeded.ctx,member,{
    sourceNamespace:'owner-upload:contradiction',sourceLabel:'Contradictory workbook',sourceSnapshotHash:'contradiction-1',
  });
  migration.stagePage(db,seeded.ctx,member,pkg.id,[
    { entityType:'location',sourceKey:'MAIN',payload:{ name:'Main',kind:'warehouse' } },
    { entityType:'product',sourceKey:'I1',payload:{ name:'Boot',trackingMode:'quantity' } },
    { entityType:'sku',sourceKey:'BOOT-9',payload:{ productKey:'I1',code:'BOOT-9' } },
    { entityType:'inventory_position',sourceKey:'INV1',payload:{ skuKey:'BOOT-9',locationKey:'MAIN',quantity:10,
      reservedQuantity:2,damagedQuantity:1,availableQuantity:7,incomingQuantity:12 } },
  ]);
  assert.throws(() => migration.validate(db,seeded.ctx,member,pkg.id),/summaries disagree/);
  const review = ownerMigration.refreshSourceReview(db,seeded.workspaceId,pkg.id);
  assert.equal(review.autoResolvable,true);
  const resolved = ownerMigration.resolveOperationalTruthByPolicy(db,seeded.workspaceId,pkg.id);
  assert.equal(resolved.resolved,true);
  const decision = db.prepare("SELECT choice,evidence_json,decided_by_user_id FROM migration_source_decisions WHERE package_id=? AND decision_key='operational_truth'")
    .get(pkg.id);
  assert.equal(decision.choice,'DETAILED_OPERATIONAL_RECORDS');
  assert.equal(decision.decided_by_user_id,null);
  assert.equal(JSON.parse(decision.evidence_json).resolution.kind,'SYSTEM_POLICY');
  assert.equal(migration.validate(db,seeded.ctx,member,pkg.id).problems,0);
  migration.approve(db,seeded.ctx,member,pkg.id);
  assert.equal(migration.apply(db,seeded.ctx,member,pkg.id).remaining,0);
  const sku = db.prepare("SELECT id FROM skus WHERE workspace_id=? AND code='BOOT-9'").get(seeded.workspaceId);
  assert.equal(db.prepare("SELECT SUM(remaining_quantity) AS n FROM inventory_availability_holds WHERE workspace_id=? AND status='OPEN'")
    .get(seeded.workspaceId).n,3);
  const availability = salesOrders.availabilityForSku(db,seeded.workspaceId,sku.id);
  assert.equal(availability.onHand,10);
  assert.equal(availability.available,7);
});

test('row-level quantity contradictions still require evidence instead of being auto-resolved', () => {
  const { db } = makeDatabase(); const seeded = seedWorkspace(db); const member = { role:'owner' };
  const pkg = migration.createPackage(db,seeded.ctx,member,{
    sourceNamespace:'owner-upload:row-conflict',sourceLabel:'Any workbook',sourceSnapshotHash:'row-conflict-1',
  });
  migration.stagePage(db,seeded.ctx,member,pkg.id,[
    { entityType:'location',sourceKey:'MAIN',payload:{ name:'Main',kind:'warehouse' } },
    { entityType:'product',sourceKey:'I1',payload:{ name:'Boot',trackingMode:'quantity' } },
    { entityType:'sku',sourceKey:'BOOT-9',payload:{ productKey:'I1',code:'BOOT-9' } },
    { entityType:'inventory_position',sourceKey:'INV1',payload:{ skuKey:'BOOT-9',locationKey:'MAIN',quantity:10,
      reservedQuantity:2,damagedQuantity:1,availableQuantity:9,incomingQuantity:12 } },
  ]);
  const review = ownerMigration.refreshSourceReview(db,seeded.workspaceId,pkg.id);
  assert.equal(review.inventoryFormulaMismatches,1);
  assert.equal(review.autoResolvable,false);
  assert.equal(ownerMigration.resolveOperationalTruthByPolicy(db,seeded.workspaceId,pkg.id),null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM migration_source_decisions WHERE package_id=?").get(pkg.id).n,0);
});

test('catalog groups work across attributes without one rule per SKU', () => {
  const { db } = makeDatabase();
  const seeded = seedWorkspace(db);
  const product = itemService.createItemShell(db, seeded.ctx, { name: 'Configurable machine', trackingMode: 'quantity' });
  const variants = Array.from({ length: 225 }, (_, index) => ({
    sourceKey: `v-${index}`, code: `MACHINE-${index}`, label: `Configuration ${index}`,
    options: { Voltage: `${100 + index}V`, Region: index % 2 ? 'East' : 'West',
      Finish: 'Industrial', Revision: `R${index % 7}` },
  }));
  const made = itemService.addExactVariants(db, seeded.ctx, product.itemId, variants);
  assert.equal(made.skus.length, 225);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_options WHERE item_id = ?').get(product.itemId).n, 4);
  attributes.set(db, seeded.ctx, 'item', product.itemId, { key: 'category', value: 'Machinery' });
  attributes.set(db, seeded.ctx, 'item', product.itemId, { key: 'temperature', value: 'Ambient' });
  const selector = { all: [{ key: 'category', value: 'machinery' }],
    none: [{ key: 'temperature', value: 'Frozen' }] };
  assert.equal(attributes.matchesProduct(db, seeded.workspaceId,
    { skuId: made.skus[224].skuId }, selector), true);
});

test('supported lot and serial identity crosses the migration boundary exactly', () => {
  const { db } = makeDatabase();
  const seeded = seedWorkspace(db);
  const member = { role:'owner' };
  const pkg = migration.createPackage(db, seeded.ctx, member, {
    sourceNamespace:'tracked-stock-source', sourceSnapshotHash:'tracked-1',
  });
  migration.stagePage(db, seeded.ctx, member, pkg.id, [
    { entityType:'location', sourceKey:'vault', payload:{ name:'Identity vault', kind:'warehouse' } },
    { entityType:'product', sourceKey:'lot-product', payload:{ name:'Lot material', trackingMode:'lot',
      variants:[{ sourceKey:'lot-sku', code:'LOT-MATERIAL' }] } },
    { entityType:'product', sourceKey:'serial-product', payload:{ name:'Serialized device', trackingMode:'serial',
      variants:[{ sourceKey:'serial-sku', code:'SERIAL-DEVICE' }] } },
    { entityType:'inventory_position', sourceKey:'lot-position', payload:{ skuKey:'lot-sku',
      locationKey:'vault', quantity:7, lotCode:'BATCH-EXACT-7', expiresAt:'2027-09-11' } },
    { entityType:'inventory_position', sourceKey:'serial-position', payload:{ skuKey:'serial-sku',
      locationKey:'vault', serials:[{ serial:'DEVICE-A' }, { serial:'DEVICE-B' }] } },
  ]);
  assert.equal(migration.validate(db, seeded.ctx, member, pkg.id).problems, 0);
  migration.approve(db, seeded.ctx, member, pkg.id);
  assert.equal(migration.apply(db, seeded.ctx, member, pkg.id).remaining, 0);
  const reconciled = migration.reconcile(db, seeded.ctx, member, pkg.id);
  assert.equal(reconciled.matched, true, JSON.stringify(reconciled.checks));
  assert.equal(reconciled.checks.find((check) => check.key === 'lot.records').foundry, 1);
  assert.equal(reconciled.checks.find((check) => check.key === 'serial.records').foundry, 2);
  assert.equal(reconciled.checks.find((check) => check.key === 'inventory.units').foundry, 9);
});

test('an unfamiliar tabular source is reviewed once and then stages canonical records', () => {
  const { db } = makeDatabase(); const seeded = seedWorkspace(db); const member = { role:'owner' };
  const pkg = migration.createPackage(db,seeded.ctx,member,{ sourceNamespace:'custom-built-system',
    sourceSnapshotHash:'custom-file-1' });
  const profile = mapping.createProfile(db,seeded.ctx,member,pkg.id,{ sourceDataset:'product export',
    entityType:'product',columns:[{ name:'External ID',samples:['P-900'] },{ name:'Name',samples:['Unique assembly'] },
      { name:'Internal Workflow Flag',samples:['A7'] }] });
  assert.equal(profile.mappings.find((row) => row.sourceField === 'External ID').targetField,'sourceKey');
  assert.equal(profile.mappings.find((row) => row.sourceField === 'Internal Workflow Flag').targetField,
    'attribute:internal_workflow_flag');
  assert.equal(mapping.approve(db,seeded.ctx,member,profile.id).status,'APPROVED');
  mapping.stageRows(db,seeded.ctx,member,profile.id,[{ 'External ID':'P-900',Name:'Unique assembly',
    'Internal Workflow Flag':'A7' }]);
  assert.equal(migration.validate(db,seeded.ctx,member,pkg.id).problems,0);
  migration.approve(db,seeded.ctx,member,pkg.id); migration.apply(db,seeded.ctx,member,pkg.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE workspace_id=? AND name='Unique assembly'")
    .get(seeded.workspaceId).n,1);
});

test('an owner upload becomes products, stock, prices, costs and suppliers through the canonical cutover', () => {
  const { db } = makeDatabase(); const seeded = seedWorkspace(db); const member = { role:'owner' };
  const csv = [
    'SKU,Product,Location,Quantity,Selling Price,Unit Cost,Supplier',
    'OWN-BLUE-9,Owner shoe / Blue 9,North Depot,12,89.50,41.25,Owner Footwear Supply',
    'OWN-BLACK-10,Owner shoe / Black 10,North Depot,7,94.00,43.00,Owner Footwear Supply',
  ].join('\n');
  const intake = ownerMigration.createFromFiles(db,seeded.ctx,member,{
    sourceLabel:'My current inventory',pasted:csv,
  });
  assert.equal(intake.datasets.length,1);
  assert.equal(intake.datasets[0].entityType,'catalog_inventory');
  const profile = mapping.getProfile(db,seeded.workspaceId,intake.datasets[0].profileId);
  assert.equal(profile.mappings.every((entry) => entry.disposition === 'MAPPED'),true);
  mapping.approve(db,seeded.ctx,member,profile.id);
  const staged = ownerMigration.stageDataset(db,seeded.ctx,member,profile.id);
  assert.equal(staged.dataset.status,'STAGED');
  assert.equal(staged.dataset.sourceRowCount,2);
  assert.equal(migration.validate(db,seeded.ctx,member,intake.package.id).problems,0);
  migration.approve(db,seeded.ctx,member,intake.package.id);
  assert.equal(migration.apply(db,seeded.ctx,member,intake.package.id,{ limit:5000 }).remaining,0);
  assert.equal(migration.reconcile(db,seeded.ctx,member,intake.package.id).matched,true);
  assert.equal(migration.activateCutover(db,seeded.ctx,member,intake.package.id).status,'CUTOVER_ACTIVE');

  const sku = db.prepare("SELECT * FROM skus WHERE workspace_id=? AND code='OWN-BLUE-9'").get(seeded.workspaceId);
  const north = db.prepare("SELECT * FROM locations WHERE workspace_id=? AND name='North Depot'").get(seeded.workspaceId);
  assert.ok(sku); assert.ok(north);
  assert.equal(db.prepare('SELECT on_hand FROM balances WHERE workspace_id=? AND sku_id=? AND location_id=?')
    .get(seeded.workspaceId,sku.id,north.id).on_hand,12);
  assert.equal(db.prepare('SELECT amount_minor FROM sku_prices WHERE workspace_id=? AND sku_id=? ORDER BY rowid DESC LIMIT 1')
    .get(seeded.workspaceId,sku.id).amount_minor,8950);
  assert.equal(prices.purchaseCostForSku(db,seeded.workspaceId,sku.id).amount_minor,4125);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM suppliers WHERE workspace_id=? AND name='Owner Footwear Supply'")
    .get(seeded.workspaceId).n,1);
});

test('a relational multi-sheet workbook is understood as one migration instead of a form per tab', () => {
  const { db } = makeDatabase(); const seeded = seedWorkspace(db); const member = { role:'owner' };
  const book = XLSX.utils.book_new();
  const add = (name,rows) => XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),name);
  add('Guide',[{ Purpose:'Evidence only',Detail:'This workbook describes the export.' }]);
  add('Master records',[{ ItemID:'I1',ItemName:'Boot',Category:'Footwear',UOM:'each',TrackSerial:false }]);
  add('Trading partners',[{ VendorID:'V1',VendorName:'Supply Co',Email:'supply@example.test',Country:'US' }]);
  add('Variants',[{ SKU:'BOOT-9',ItemID:'I1',VariantName:'Black / 9',Color:'Black',Size:'9',
    VendorID:'V1',VendorPartNo:'VP9',UnitCost:10,SellPrice:20,ReorderPoint:4,ReorderQty:8 }]);
  add('Sites',[{ LocationID:'MAIN',LocationName:'Main warehouse',Type:'warehouse',Address:'1 Main' }]);
  add('Stock positions',[{ InventoryID:'INV1',SKU:'BOOT-9',LocationID:'MAIN',OnHand:7,Bin:'A-1',
    Reserved:1,Available:6,Incoming:3,Damaged:0,ReorderPoint:4,ReorderQty:8 }]);
  add('Order headers',[{ POID:'PO1',VendorID:'V1',LocationID:'MAIN',OrderDate:'2026-09-01',
    ExpectedDate:'2026-09-20',Status:'Open',Subtotal:30 }]);
  add('Order detail',[{ POLineID:'L1',POID:'PO1',SKU:'BOOT-9',OrderedQty:3,ReceivedQty:0,UnitCost:10 }]);
  add('Movement history',[{ TransactionID:'T1',DateTime:'2026-09-02',Type:'Receipt',SKU:'BOOT-9',
    LocationID:'MAIN',Qty:7,Reference:'opening' }]);
  const buffer = XLSX.write(book,{ type:'buffer',bookType:'xlsx' });
  const intake = ownerMigration.createFromFiles(db,seeded.ctx,member,{ files:[{
    filename:'unfamiliar-business-export.xlsx',buffer,size:buffer.length,field:'files',
  }] });
  const bySheet = Object.fromEntries(intake.datasets.map((dataset) => [dataset.sheetName,dataset]));
  assert.equal(bySheet.Guide.entityType,'reference_only');
  assert.equal(bySheet['Master records'].entityType,'product');
  assert.equal(bySheet['Trading partners'].entityType,'supplier');
  assert.equal(bySheet.Variants.entityType,'sku');
  assert.equal(bySheet.Sites.entityType,'location');
  assert.equal(bySheet['Stock positions'].entityType,'inventory_position');
  assert.equal(bySheet['Order headers'].entityType,'reference_only');
  assert.equal(bySheet['Order detail'].entityType,'purchase_order');
  assert.equal(bySheet['Movement history'].entityType,'history_fact');
  assert.equal(bySheet.Variants.status,'READY_TO_STAGE');
  assert.equal(mapping.getProfile(db,seeded.workspaceId,bySheet.Variants.profileId).mappings
    .find((entry) => entry.sourceField === 'Color').targetField,'attribute:color');
  assert.deepEqual(mapping.getProfile(db,seeded.workspaceId,bySheet['Stock positions'].profileId).mappings
    .filter((entry) => entry.disposition === 'UNRESOLVED').map((entry) => entry.sourceField),[]);
  assert.equal(bySheet['Stock positions'].status,'READY_TO_STAGE');
  assert.deepEqual(mapping.getProfile(db,seeded.workspaceId,bySheet['Order detail'].profileId).mappings
    .filter((entry) => entry.disposition === 'UNRESOLVED').map((entry) => entry.sourceField),
    []);
  assert.equal(bySheet['Order detail'].status,'READY_TO_STAGE');
});

test('a compact multi-tab workbook preserves stock, availability, pricing, policy, attributes and supplier contacts', () => {
  const { db } = makeDatabase(); const seeded = seedWorkspace(db); const member = { role:'owner' };
  const book = XLSX.utils.book_new();
  const add = (name,rows) => XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),name);
  add('Current stock',[
    { SKU:'A-101',ItemName:'Cable',Category:'Electronics',Location:'MAIN',OnHand:8,Reserved:2,Available:6,
      ReorderPoint:4,UnitCost:3.25,SellPrice:9.99,InventoryValue:26,Vendor:'Supplier One',Status:'Active' },
    { SKU:'B-202',ItemName:'Mug',Category:'Home',Location:'STORE',OnHand:7,Reserved:1,Available:6,
      ReorderPoint:3,UnitCost:5,SellPrice:12,InventoryValue:35,Vendor:'Supplier Two',Status:'Seasonal' },
  ]);
  add('Business partners',[
    { Vendor:'Supplier One',Contact:'Alex',Email:'one@example.test',Phone:'555-0101',Terms:'Net 30' },
    { Vendor:'Supplier Two',Contact:'Sam',Email:'two@example.test',Phone:'555-0102',Terms:'Net 15' },
  ]);
  add('Management totals',[
    { KPI:'Total SKUs',Value:2,Category:'Electronics',SKUs:1,Units:8 },
    { KPI:'Total units',Value:15,Category:'Home',SKUs:1,Units:7 },
  ]);
  const buffer = XLSX.write(book,{ type:'buffer',bookType:'xlsx' });
  const intake = ownerMigration.createFromFiles(db,seeded.ctx,member,{ files:[{
    filename:'customer-export-2026.xlsx',buffer,size:buffer.length,field:'files',
  }] });
  const bySheet = Object.fromEntries(intake.datasets.map((dataset) => [dataset.sheetName,dataset]));
  assert.equal(bySheet['Current stock'].entityType,'catalog_inventory');
  assert.equal(bySheet['Business partners'].entityType,'supplier');
  assert.equal(bySheet['Management totals'].entityType,'reference_only');

  for (const dataset of intake.datasets.filter((entry) => entry.entityType !== 'reference_only')) {
    assert.equal(dataset.status,'READY_TO_STAGE',`${dataset.sheetName} should need no manual field selection`);
    ownerMigration.stageDataset(db,seeded.ctx,member,dataset.profileId);
  }
  const review = ownerMigration.refreshSourceReview(db,seeded.workspaceId,intake.package.id);
  assert.equal(review.onHand,15);
  assert.equal(review.reserved,3);
  assert.equal(review.available,12);
  assert.equal(review.sourceInventoryValue,61);
  assert.equal(review.inventoryFormulaMismatches,0);
  assert.equal(review.inventoryValueMismatches,0);
  assert.equal(review.resolved,true);
  assert.equal(migration.validate(db,seeded.ctx,member,intake.package.id).problems,0);
  migration.approve(db,seeded.ctx,member,intake.package.id);
  while (migration.getPackage(db,seeded.workspaceId,intake.package.id).status !== 'RECONCILING') {
    const result = migration.apply(db,seeded.ctx,member,intake.package.id,{ limit:5000 });
    if (result.error) throw result.error;
  }
  assert.equal(migration.reconcile(db,seeded.ctx,member,intake.package.id).matched,true);

  const cable = db.prepare("SELECT * FROM skus WHERE workspace_id=? AND code='A-101'").get(seeded.workspaceId);
  assert.ok(cable);
  assert.equal(db.prepare('SELECT SUM(on_hand) n FROM balances WHERE workspace_id=?').get(seeded.workspaceId).n,15);
  assert.equal(db.prepare("SELECT SUM(remaining_quantity) n FROM inventory_availability_holds WHERE workspace_id=? AND kind='legacy_reserved'")
    .get(seeded.workspaceId).n,3);
  assert.equal(db.prepare('SELECT amount_minor FROM sku_prices WHERE workspace_id=? AND sku_id=? ORDER BY rowid DESC LIMIT 1')
    .get(seeded.workspaceId,cable.id).amount_minor,999);
  assert.equal(prices.purchaseCostForSku(db,seeded.workspaceId,cable.id).amount_minor,325);
  assert.equal(db.prepare('SELECT reorder_point FROM reorder_policies WHERE workspace_id=? AND sku_id=?')
    .get(seeded.workspaceId,cable.id).reorder_point,4);
  assert.deepEqual(attributes.list(db,seeded.workspaceId,'sku',cable.id).map((entry) => [entry.key,entry.value]),
    [['category','Electronics'],['status','Active']]);
  assert.equal(db.prepare("SELECT email FROM suppliers WHERE workspace_id=? AND name='Supplier One'")
    .get(seeded.workspaceId).email,'one@example.test');
});

test('mixed purchase-order lifecycle imports only reconciled outstanding supply and preserves receipts as history', () => {
  const { db } = makeDatabase(); const seeded = seedWorkspace(db); const member = { role:'owner' };
  const book = XLSX.utils.book_new();
  const add = (name,rows) => XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),name);
  add('Products',[{ ItemID:'I1',ItemName:'Boot' }]);
  add('Suppliers',[{ VendorID:'V1',VendorName:'Supply Co' }]);
  add('SKUs',[{ SKU:'BOOT-9',ItemID:'I1' }]);
  add('Locations',[{ LocationID:'MAIN',LocationName:'Main warehouse' }]);
  add('PO Headers',[
    { POID:'PO-PART',VendorID:'V1',LocationID:'MAIN',Status:'Partially Received' },
    { POID:'PO-DONE',VendorID:'V1',LocationID:'MAIN',Status:'Received' },
    { POID:'PO-OPEN',VendorID:'V1',LocationID:'MAIN',Status:'Issued' },
  ]);
  add('PO Lines',[
    { POLineID:'L1',POID:'PO-PART',SKU:'BOOT-9',OrderedQty:10,ReceivedQty:7,BackorderedQty:3,UnitCost:8 },
    { POLineID:'L2',POID:'PO-DONE',SKU:'BOOT-9',OrderedQty:5,ReceivedQty:5,BackorderedQty:0,UnitCost:8 },
    { POLineID:'L3',POID:'PO-OPEN',SKU:'BOOT-9',OrderedQty:4,ReceivedQty:0,BackorderedQty:4,UnitCost:8 },
  ]);
  const buffer = XLSX.write(book,{ type:'buffer',bookType:'xlsx' });
  const intake = ownerMigration.createFromFiles(db,seeded.ctx,member,{ files:[{
    filename:'mixed-orders.xlsx',buffer,size:buffer.length,field:'files',
  }] });
  for (const dataset of intake.datasets.filter((entry) => entry.entityType !== 'reference_only')) {
    assert.equal(dataset.status,'READY_TO_STAGE',`${dataset.sheetName} should be structurally proven`);
    ownerMigration.stageDataset(db,seeded.ctx,member,dataset.profileId);
  }
  assert.equal(migration.validate(db,seeded.ctx,member,intake.package.id).problems,0);
  const rows = db.prepare(`SELECT entity_type,payload_json FROM migration_records
    WHERE package_id=? AND entity_type IN ('purchase_order','history_fact') ORDER BY entity_type,payload_json`).all(intake.package.id);
  const orders = rows.filter((row) => row.entity_type === 'purchase_order').map((row) => JSON.parse(row.payload_json));
  const history = rows.filter((row) => row.entity_type === 'history_fact').map((row) => JSON.parse(row.payload_json));
  assert.equal(orders.length,2);
  assert.equal(orders.reduce((sum,order) => sum + order.lines.reduce((n,line) => n + line.quantityUnits,0),0),7);
  assert.deepEqual(orders.map((order) => order.status).sort(),['ORDERED','ORDERED']);
  assert.equal(history.length,2);
  assert.equal(history.every((fact) => fact.factType === 'purchase_order_source_state'),true);
});

test('an owner serial export uses exact serial identity as one unit without inventing a quantity', () => {
  const { db } = makeDatabase(); const seeded = seedWorkspace(db); const member = { role:'owner' };
  const csv = [
    'SKU,Product,Location,Serial Number',
    'DEVICE-1,Tracked device,Secure Store,SN-EXACT-001',
  ].join('\n');
  const intake = ownerMigration.createFromFiles(db,seeded.ctx,member,{
    sourceLabel:'My serialized inventory',pasted:csv,
  });
  const profile = mapping.getProfile(db,seeded.workspaceId,intake.datasets[0].profileId);
  assert.equal(profile.mappings.find((entry) => entry.sourceField === 'Serial Number').targetField,'serial');
  mapping.approve(db,seeded.ctx,member,profile.id);
  ownerMigration.stageDataset(db,seeded.ctx,member,profile.id);
  assert.equal(migration.validate(db,seeded.ctx,member,intake.package.id).problems,0);
  migration.approve(db,seeded.ctx,member,intake.package.id);
  assert.equal(migration.apply(db,seeded.ctx,member,intake.package.id,{ limit:5000 }).remaining,0);
  assert.equal(migration.reconcile(db,seeded.ctx,member,intake.package.id).matched,true);
  const movement = db.prepare("SELECT serial,1 AS quantity FROM serial_units WHERE workspace_id=? AND serial='SN-EXACT-001'")
    .get(seeded.workspaceId);
  assert.equal(movement.serial,'SN-EXACT-001');
  assert.equal(movement.quantity,1);
});

test('ordinary row-per-line PO and sales exports become grouped open orders without proprietary templates', () => {
  const { db } = makeDatabase(); const seeded = seedWorkspace(db); const member = { role:'owner' };
  const asFile = (filename,text) => ({ filename,buffer:Buffer.from(text),size:Buffer.byteLength(text),field:'files' });
  const catalog = [
    'SKU,Product,Location,Quantity,Currency',
    'ORDER-SKU-1,Order migration item,Migration Depot,20,USD',
    'ORDER-SKU-2,Second order item,Migration Depot,12,USD',
  ].join('\n');
  const purchase = [
    'PO Number,Supplier,Destination,Status,SKU,Quantity,Unit Cost,Currency',
    'PO-EXT-77,Source Supplier,Migration Depot,Open,ORDER-SKU-1,5,8.25,USD',
    'PO-EXT-77,Source Supplier,Migration Depot,Open,ORDER-SKU-2,3,6.00,USD',
  ].join('\n');
  const sales = [
    'Sales Order Number,Customer,Status,SKU,Quantity,Unit Price,Delivery Method,Currency',
    'SO-EXT-44,Source Customer,Confirmed,ORDER-SKU-1,2,15.50,Pickup,USD',
    'SO-EXT-44,Source Customer,Confirmed,ORDER-SKU-2,1,12.00,Pickup,USD',
  ].join('\n');
  const intake = ownerMigration.createFromFiles(db,seeded.ctx,member,{
    sourceLabel:'My old system',files:[asFile('catalog.csv',catalog),asFile('open-purchase-orders.csv',purchase),asFile('open-sales-orders.csv',sales)],
  });
  assert.deepEqual(intake.datasets.map((dataset) => dataset.entityType).sort(),['catalog_inventory','purchase_order','sales_order']);
  for (const dataset of intake.datasets) {
    const profile = mapping.getProfile(db,seeded.workspaceId,dataset.profileId);
    assert.equal(profile.mappings.every((entry) => entry.disposition === 'MAPPED'),true,JSON.stringify(profile.mappings));
    mapping.approve(db,seeded.ctx,member,profile.id);
    ownerMigration.stageDataset(db,seeded.ctx,member,profile.id);
  }
  assert.equal(migration.validate(db,seeded.ctx,member,intake.package.id).problems,0);
  const switched = migration.approveAndActivate(db,seeded.ctx,member,intake.package.id);
  assert.equal(switched.activated,true);
  const po = db.prepare("SELECT * FROM purchase_orders WHERE workspace_id=? AND po_number='PO-EXT-77'").get(seeded.workspaceId);
  const so = db.prepare("SELECT * FROM sales_orders WHERE workspace_id=? AND order_number='SO-EXT-44'").get(seeded.workspaceId);
  assert.ok(po); assert.ok(so);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_order_lines WHERE purchase_order_id=?').get(po.id).n,2);
  assert.equal(db.prepare('SELECT SUM(quantity_ordered) AS n FROM sales_order_lines WHERE sales_order_id=?').get(so.id).n,3);
});

test('a live source cannot cut over until ordered deltas are captured and frozen', () => {
  const { db } = makeDatabase(); const seeded = seedWorkspace(db); const member = { role:'owner' };
  const pkg = migration.createPackage(db,seeded.ctx,member,{ sourceNamespace:'bespoke-live-source',
    sourceSnapshotHash:'live-snapshot-1',cutoverMode:'SNAPSHOT_DELTA',sourceCheckpoint:'cursor-100',
    sourceSnapshotAt:'2026-09-14T10:00:00.000Z' });
  migration.stagePage(db,seeded.ctx,member,pkg.id,[
    { entityType:'location',sourceKey:'main',payload:{ name:'Main',kind:'warehouse' } },
    { entityType:'product',sourceKey:'p1',payload:{ name:'Delta item',trackingMode:'quantity',
      variants:[{ sourceKey:'s1',code:'DELTA-1' }] } },
    { entityType:'inventory_position',sourceKey:'position-1',payload:{ skuKey:'s1',locationKey:'main',quantity:10 } },
  ]);
  assert.throws(() => migration.validate(db,seeded.ctx,member,pkg.id),/freeze the source/);
  migration.beginDeltaCapture(db,seeded.ctx,member,pkg.id,{ sourceCursor:'cursor-100' });
  migration.stageDeltaPage(db,seeded.ctx,member,pkg.id,'cursor-101',[{ operation:'UPSERT',record:{
    entityType:'inventory_position',sourceKey:'position-1',sourceVersion:'2',
    payload:{ skuKey:'s1',locationKey:'main',quantity:12 } } }]);
  migration.freezeSource(db,seeded.ctx,member,pkg.id,{ finalCheckpoint:'cursor-101',evidence:'Source write lock confirmed' });
  assert.equal(migration.validate(db,seeded.ctx,member,pkg.id).problems,0);
  migration.approve(db,seeded.ctx,member,pkg.id); migration.apply(db,seeded.ctx,member,pkg.id);
  const reconciled = migration.reconcile(db,seeded.ctx,member,pkg.id);
  assert.equal(reconciled.checks.find((check) => check.key === 'source.final_checkpoint').status,'MATCHED');
  assert.equal(reconciled.checks.find((check) => check.key === 'inventory.units').foundry,12);
  assert.equal(migration.activateCutover(db,seeded.ctx,member,pkg.id).status,'CUTOVER_ACTIVE');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migration_source_changes WHERE package_id=?').get(pkg.id).n,1);
});

test('indexed discovery finds catalog attributes and supplier codes without wildcard scans', () => {
  const { db } = makeDatabase(); const seeded = seedWorkspace(db);
  const product = itemService.createExactItem(db,seeded.ctx,{ name:'Precision assembly',trackingMode:'quantity',
    variants:[{ code:'PA-RED-1',label:'Red configuration' }] });
  attributes.set(db,seeded.ctx,'item',product.itemId,{ key:'certification',value:'Cryogenic-rated' });
  const result = search.search(db,seeded.workspaceId,'cryogenic');
  assert.equal(result.results[0].id,product.itemId);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT d.entity_id FROM search_documents_fts JOIN search_documents d ON d.rowid=search_documents_fts.rowid WHERE search_documents_fts MATCH 'cryogenic*' AND d.workspace_id=?")
    .all(seeded.workspaceId).map((row) => row.detail).join(' ');
  assert.match(plan,/VIRTUAL TABLE INDEX/i);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const authService = require('../../src/domain/auth-service');
const itemService = require('../../src/domain/item-service');
const repo = require('../../src/domain/repository');
const supplierService = require('../../src/purchasing/supplier-service');
const mappings = require('../../src/purchasing/supplier-code-mappings');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Code Mapping Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const created = itemService.createItem(db, workspace.ctx, {
    name: 'Boys Dress Oxford', baseCode: 'SH-204-BRN', trackingMode: 'quantity',
    hasVariants: true, options: [{ name: 'Size', values: '28, 29' }],
  });
  const skus = repo.listSkusForItem(db, workspace.workspaceId, created.itemId);
  const supplier = supplierService.createSupplier(db, workspace.ctx, membership, {
    name: 'Step & Style Wholesale', itemCodeLabel: 'Style Number',
  });
  for (const sku of skus) {
    supplierService.linkItem(db, workspace.ctx, membership, {
      supplierId: supplier.id, skuId: sku.id, supplierSku: 'SH-204-BRN',
      purchaseUnit: 'unit', unitsPerPurchaseUnit: 1,
    });
  }
  return { db, workspace, membership, itemId: created.itemId, skus, supplier };
}

test('a vendor code mapping previews every internal SKU and changes nothing before approval', () => {
  const env = setup();
  const proposal = mappings.preview(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id, vendorCode: 'SH-204-BRN', internalBaseCode: 'OXFORD-BROWN',
  });

  assert.equal(proposal.status, 'PROPOSED');
  assert.deepEqual(proposal.affected.map((row) => row.afterCode), ['OXFORD-BROWN-28', 'OXFORD-BROWN-29']);
  assert.deepEqual(repo.listSkusForItem(env.db, env.workspace.workspaceId, env.itemId).map((sku) => sku.code),
    ['SH-204-BRN-28', 'SH-204-BRN-29']);
  assert.equal(env.db.prepare('SELECT base_code FROM items WHERE id = ?').get(env.itemId).base_code, 'SH-204-BRN');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, 0);
  env.db.close();
});

test('approval changes only customer codes, retains the vendor code, and remembers the mapping', () => {
  const env = setup();
  const proposal = mappings.preview(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id, vendorCode: 'SH-204-BRN', internalBaseCode: 'OXFORD-BROWN',
  });
  const applied = mappings.apply(env.db, env.workspace.ctx, env.membership, proposal.id);

  assert.equal(applied.status, 'APPLIED');
  assert.equal(env.db.prepare('SELECT base_code FROM items WHERE id = ?').get(env.itemId).base_code, 'OXFORD-BROWN');
  assert.deepEqual(repo.listSkusForItem(env.db, env.workspace.workspaceId, env.itemId).map((sku) => sku.code),
    ['OXFORD-BROWN-28', 'OXFORD-BROWN-29']);
  assert.deepEqual(env.db.prepare(
    'SELECT DISTINCT supplier_sku FROM supplier_items WHERE workspace_id = ? AND supplier_id = ?'
  ).all(env.workspace.workspaceId, env.supplier.id).map((row) => row.supplier_sku), ['SH-204-BRN']);
  assert.equal(env.db.prepare(
    'SELECT internal_base_code FROM supplier_code_mappings WHERE workspace_id = ? AND supplier_id = ? AND vendor_code = ?'
  ).get(env.workspace.workspaceId, env.supplier.id, 'SH-204-BRN').internal_base_code, 'OXFORD-BROWN');
  assert.equal(mappings.apply(env.db, env.workspace.ctx, env.membership, proposal.id).status, 'APPLIED',
    'replaying approval is idempotent');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, 0, 'renaming codes never fabricates inventory movement');
  env.db.close();
});

test('a remembered mapping is enforced when another variant from that vendor is linked later', () => {
  const env = setup();
  const proposal = mappings.preview(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id, vendorCode: 'SH-204-BRN', internalBaseCode: 'OXFORD-BROWN',
  });
  mappings.apply(env.db, env.workspace.ctx, env.membership, proposal.id);

  const added = itemService.addVariant(env.db, env.workspace.ctx, env.itemId, { Size: '30' });
  supplierService.linkItem(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id, skuId: added.skuId, supplierSku: 'SH-204-BRN',
    purchaseUnit: 'unit', unitsPerPurchaseUnit: 1,
  });
  assert.equal(repo.requireSku(env.db, env.workspace.workspaceId, added.skuId).code, 'OXFORD-BROWN-30');
  assert.equal(supplierService.getSupplierItem(
    env.db, env.workspace.workspaceId,
    env.db.prepare('SELECT id FROM supplier_items WHERE sku_id = ?').get(added.skuId).id
  ).supplierSku, 'SH-204-BRN');
  env.db.close();
});

test('Foundry refuses a customer-code collision instead of silently suffixing it', () => {
  const env = setup();
  itemService.createItem(env.db, env.workspace.ctx, {
    name: 'Existing Oxford', baseCode: 'OXFORD-BROWN', trackingMode: 'quantity',
  });
  assert.throws(() => mappings.preview(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id, vendorCode: 'SH-204-BRN', internalBaseCode: 'OXFORD-BROWN',
  }), /already uses your code OXFORD-BROWN/);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM supplier_code_mapping_proposals').get().n, 0);
  env.db.close();
});

test('ordinary language identifies a vendor-to-customer code instruction', () => {
  assert.deepEqual(mappings.parseInstruction('Change vendor code SH-204-BRN to my code OXFORD-BROWN'), {
    matched: true, vendorCode: 'SH-204-BRN', internalBaseCode: 'OXFORD-BROWN',
  });
  assert.deepEqual(mappings.parseInstruction('For supplier SKU SH-204-BRN, use OXFORD-BROWN'), {
    matched: true, vendorCode: 'SH-204-BRN', internalBaseCode: 'OXFORD-BROWN',
  });
});

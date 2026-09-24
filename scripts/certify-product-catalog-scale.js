'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { openDatabase } = require('../src/db');
const auth = require('../src/domain/auth-service');
const itemService = require('../src/domain/item-service');
const inventoryQuery = require('../src/domain/inventory-query');
const search = require('../src/domain/search-service');

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
}

const productCount = arg('products', 50000);
if (!Number.isSafeInteger(productCount) || productCount < 1) throw new Error('Use a positive whole product count.');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-product-scale-cert-'));
const databasePath = path.join(dir, 'products.db');
let measuringQueries = false;
let measuredQueries = 0;
const db = openDatabase(databasePath, { verbose: () => { if (measuringQueries) measuredQueries += 1; } });
const metrics = {};
const timed = (name, fn) => {
  const started = performance.now();
  const result = fn();
  metrics[name] = Math.round((performance.now() - started) * 10) / 10;
  return result;
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

try {
  const registered = auth.registerAccount(db, {
    workspaceName: 'Product catalogue certification', name: 'Scale Owner',
    email: `product-scale-${Date.now()}@example.test`, password: 'production-certification-only',
  });
  const ctx = { workspaceId: registered.workspaceId, actorId: registered.userId, accountId: registered.accountId };
  db.prepare("UPDATE workspaces SET data_mode='synthetic' WHERE id=?").run(ctx.workspaceId);

  timed('canonicalProductCreateMs', () => {
    const create = db.transaction((start, end) => {
      for (let index = start; index < end; index += 1) {
        const suffix = String(index).padStart(6, '0');
        itemService.createItem(db, ctx, { name: `Product ${suffix}`, baseCode: `PROD-${suffix}`,
          trackingMode: 'quantity', hasVariants: false });
      }
    });
    for (let start = 0; start < productCount; start += 1000) {
      create.immediate(start, Math.min(start + 1000, productCount));
    }
  });

  const counts = {
    products: db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id=?').get(ctx.workspaceId).n,
    skus: db.prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id=?').get(ctx.workspaceId).n,
  };
  assert(counts.products === productCount && counts.skus === productCount,
    `Expected ${productCount} products and SKUs, found ${counts.products} and ${counts.skus}.`);
  const lastCode = `PROD-${String(productCount - 1).padStart(6, '0')}`;
  const lastSku = db.prepare('SELECT id FROM skus WHERE workspace_id=? AND code=?').get(ctx.workspaceId, lastCode);

  measuringQueries = true;
  const first = timed('firstPageMs', () => inventoryQuery.listItems(db, ctx.workspaceId, { limit: 50 }));
  const second = timed('keysetPageMs', () => inventoryQuery.listItems(db, ctx.workspaceId,
    { limit: 50, afterName: first.nextCursor.afterName, afterId: first.nextCursor.afterId }));
  const exact = timed('exactSearchMs', () => search.search(db, ctx.workspaceId, lastCode));
  const filtered = timed('filteredCatalogMs', () => inventoryQuery.listItems(db, ctx.workspaceId,
    { limit: 50, q: lastCode }));
  measuringQueries = false;

  assert(first.items.length === 50 && first.hasMore && second.items.length === 50,
    'Catalogue pagination did not remain bounded to the requested page size.');
  assert(first.items.at(-1).id !== second.items[0].id, 'Keyset pagination repeated the boundary product.');
  assert(exact.results[0]?.id === lastSku.id, 'Exact search did not resolve the last product SKU.');
  assert(filtered.items.length === 1 && filtered.items[0].base_code === lastCode,
    'Filtered catalogue did not resolve the exact final product.');
  assert(measuredQueries <= 12, `Catalogue journeys issued ${measuredQueries} SQL statements; expected at most 12.`);

  const budgets = { firstPageMs: 3000, keysetPageMs: 3000, exactSearchMs: 2000, filteredCatalogMs: 3000 };
  for (const [name, budget] of Object.entries(budgets)) {
    assert(metrics[name] <= budget, `${name} took ${metrics[name]}ms; budget is ${budget}ms.`);
  }
  process.stdout.write(`${JSON.stringify({ certified: true, scale: counts, measuredQueries, metrics, budgets }, null, 2)}\n`);
} finally {
  if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

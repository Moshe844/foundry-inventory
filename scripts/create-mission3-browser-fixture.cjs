'use strict';

// Creates a real, domain-owned repair case in the local development database.
// This is intentionally not a SQL data patch: products, connections, mappings
// and the repair case all pass through the same services the application uses.

const path = require('node:path');
const { openDatabase } = require('../src/db');
const auth = require('../src/domain/auth-service');
const items = require('../src/domain/item-service');
const connections = require('../src/connections/service');
const repairs = require('../src/repairs/service');

const databasePath = process.env.FOUNDRY_DB_PATH
  || path.join(__dirname, '..', 'data', 'foundry-inventory.db');
const workspaceName = process.argv[2] || 'Operational Readiness QA';
const db = openDatabase(databasePath);

try {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE name = ? ORDER BY created_at DESC LIMIT 1')
    .get(workspaceName);
  if (!workspace) throw new Error(`Workspace not found: ${workspaceName}`);
  const membershipRow = db.prepare(
    `SELECT u.* FROM users u
      WHERE u.workspace_id = ? AND u.role = 'owner'
      ORDER BY u.created_at LIMIT 1`
  ).get(workspace.id);
  if (!membershipRow) throw new Error(`Owner membership not found for: ${workspaceName}`);
  const membership = auth.getMembership(db, workspace.id, membershipRow.account_id);
  const ctx = { workspaceId: workspace.id, actorId: membership.id };
  const suffix = Date.now().toString(36).toUpperCase();
  const wrong = items.createItem(db, ctx, {
    name: `Old catalog match ${suffix}`,
    baseCode: `OLD-${suffix}`,
    trackingMode: 'quantity',
  });
  const correct = items.createItem(db, ctx, {
    name: `Correct catalog match ${suffix}`,
    baseCode: `RIGHT-${suffix}`,
    trackingMode: 'quantity',
  });
  const connection = connections.create(db, ctx, membership, {
    providerType: 'reference_webhook',
    displayName: `Browser QA POS ${suffix}`,
  }).connection;
  const externalId = `REGISTER-${suffix}`;
  connections.mapExternal(db, ctx, connection.id, {
    entityType: 'sku', externalId, foundryRecordId: wrong.skuIds[0],
  });
  const result = repairs.openAndAssess(db, ctx, {
    kind: 'wrong_mapping',
    symptom: `${externalId} is connected to the wrong product`,
    failedInvariant: `${externalId} must point to the product confirmed by the owner`,
    affectedRecords: {
      connectorId: connection.id,
      entityType: 'sku',
      externalId,
      foundryRecordId: correct.skuIds[0],
    },
    evidence: [{
      source: 'owner-confirmed catalog comparison',
      observed: wrong.skuIds[0],
      expected: correct.skuIds[0],
    }],
    idempotencyKey: `mission3-browser-${suffix}`,
  });
  process.stdout.write(`${JSON.stringify({
    workspace: workspace.name,
    repairId: result.repairCase.id,
    status: result.repairCase.status,
    externalId,
    wrongSkuId: wrong.skuIds[0],
    correctSkuId: correct.skuIds[0],
    url: `http://localhost:4000/repairs/${result.repairCase.id}`,
  }, null, 2)}\n`);
} finally {
  db.close();
}

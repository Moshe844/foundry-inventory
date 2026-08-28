'use strict';

// A separate process is required here: two promises in one Node process would
// not prove that SQLite protects commitments made at the same time.
const { openDatabase } = require('../../src/db');
const sales = require('../../src/sales/sales-order-service');

const [, , databasePath, payloadJson] = process.argv;
const payload = JSON.parse(payloadJson);
const db = openDatabase(databasePath);

try {
  const order = sales.confirm(db, {
    workspaceId: payload.workspaceId,
    actorId: payload.actorId,
  }, payload.orderId, { idempotencyKey: `concurrent-confirm:${payload.orderId}` });
  process.stdout.write(JSON.stringify({
    orderId: order.id,
    allocated: order.totals.allocated,
    backordered: order.totals.backordered,
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { message: error.message, code: error.code, stack: error.stack } }));
  process.exitCode = 1;
} finally {
  db.close();
}

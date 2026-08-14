'use strict';

/**
 * A separate OS process that hammers the same database file as its siblings.
 * Used by the concurrency tests: in-process loops would prove nothing, because
 * Node would serialise them for us.
 */

const { openDatabase } = require('../../src/db');
const engine = require('../../src/domain/inventory-engine');

const [, , databasePath, payloadJson] = process.argv;
const payload = JSON.parse(payloadJson);

const db = openDatabase(databasePath);
const ctx = { workspaceId: payload.workspaceId, actorId: payload.actorId };

let succeeded = 0;
let rejected = 0;
let unexpected = null;

for (let i = 0; i < payload.iterations; i += 1) {
  try {
    if (payload.operation === 'issue') {
      engine.issue(db, ctx, {
        skuId: payload.skuId,
        locationId: payload.locationId,
        quantity: payload.quantity,
        reasonCode: 'used',
      });
    } else if (payload.operation === 'transfer') {
      engine.transfer(db, ctx, {
        skuId: payload.skuId,
        fromLocationId: payload.fromLocationId,
        toLocationId: payload.toLocationId,
        quantity: payload.quantity,
      });
    } else if (payload.operation === 'receive') {
      engine.receive(db, ctx, {
        skuId: payload.skuId,
        locationId: payload.locationId,
        quantity: payload.quantity,
      });
    } else if (payload.operation === 'receiveSerial') {
      engine.receive(db, ctx, {
        skuId: payload.skuId,
        locationId: payload.locationId,
        serials: [{ serial: payload.serial }],
      });
    }
    succeeded += 1;
  } catch (err) {
    if (err && ['insufficient_stock', 'duplicate_serial'].includes(err.code)) {
      rejected += 1;
    } else {
      unexpected = { message: err.message, code: err && err.code, stack: err.stack };
      break;
    }
  }
}

db.close();
process.stdout.write(JSON.stringify({ succeeded, rejected, unexpected }));
process.exit(unexpected ? 1 : 0);

'use strict';

/**
 * Trading history for the demo workspace.
 *
 * The base fixture builds a correct inventory, but every movement in it happens
 * "now" — and an operator that reasons about usage over time has nothing to
 * reason about. This adds two months of plausible trading on top, so the
 * briefing a person sees when they click around is the real detector output on
 * real movements rather than a canned list.
 *
 * Every movement below goes through the Mission 1 engine. Only `occurred_at` is
 * rewritten afterwards, which is why the immutability trigger is lifted for
 * exactly that statement and restored immediately. Quantities, balances and the
 * ledger's own arithmetic are never touched. This is a development fixture; it
 * is not reachable from the application.
 */

const engine = require('../src/domain/inventory-engine');
const repo = require('../src/domain/repository');
const itemService = require('../src/domain/item-service');
const reevaluate = require('../src/attention/reevaluate');

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

function backdate(db, movementIds, days) {
  const when = daysAgo(days);
  db.exec('DROP TRIGGER IF EXISTS movements_no_update');
  const stmt = db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
  const adj = db.prepare('UPDATE adjustments SET created_at = ? WHERE movement_id = ?');
  for (const id of movementIds) {
    stmt.run(when, id);
    adj.run(when, id);
  }
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS movements_no_update
     BEFORE UPDATE ON movements
     BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
  );
}

function at(db, ctx, days, operation, input) {
  const result = engine[operation](db, ctx, input);
  backdate(db, result.movementIds, days);
  return result;
}

/** Pushes everything the base fixture created back to the start of the period. */
function ageExistingMovements(db, workspaceId, days = 70) {
  const rows = db.prepare('SELECT id FROM movements WHERE workspace_id = ?').all(workspaceId);
  backdate(db, rows.map((r) => r.id), days);
}

function addOperatingHistory(db, seeded) {
  const workspaceId = seeded.workspaceId;
  const ctx = { workspaceId, actorId: seeded.ownerId };
  const staffCtx = { workspaceId, actorId: seeded.staffId };
  const { warehouse, store, van } = seeded.locations;

  ageExistingMovements(db, workspaceId, 70);

  // --- A line that sells steadily and is now nearly out ---------------------
  const elbowSku = seeded.items.elbow.skuId;
  for (let i = 0; i < 7; i += 1) {
    at(db, staffCtx, 30 - i * 4, 'issue', {
      skuId: elbowSku,
      locationId: warehouse.id,
      quantity: 18,
      reasonCode: 'sold',
      reference: `WO-52${i}`,
    });
  }
  for (let i = 0; i < 6; i += 1) {
    at(db, staffCtx, 24 - i * 4, 'issue', {
      skuId: elbowSku,
      locationId: store.id,
      quantity: 5,
      reasonCode: 'sold',
      reference: `Counter sale 90${i}`,
    });
  }

  // --- A line that piled up in the wrong place ------------------------------
  const cream4 = seeded.items.sweater.cream4;
  at(db, ctx, 55, 'receive', { skuId: cream4, locationId: warehouse.id, quantity: 90, reference: 'GRN-124' });
  for (let i = 0; i < 6; i += 1) {
    at(db, staffCtx, 26 - i * 4, 'issue', {
      skuId: cream4,
      locationId: store.id,
      quantity: 2,
      reasonCode: 'sold',
    });
  }

  // --- Small routine corrections, then one well outside them ---------------
  const navy5 = seeded.items.sweater.navy5;
  at(db, ctx, 60, 'receive', { skuId: navy5, locationId: warehouse.id, quantity: 60, reference: 'GRN-125' });
  at(db, staffCtx, 44, 'adjust', { skuId: navy5, locationId: warehouse.id, countedQty: 59, reasonCode: 'physical_count' });
  at(db, staffCtx, 30, 'adjust', { skuId: navy5, locationId: warehouse.id, countedQty: 61, reasonCode: 'found' });
  at(db, staffCtx, 16, 'adjust', { skuId: navy5, locationId: warehouse.id, countedQty: 59, reasonCode: 'physical_count' });
  at(db, staffCtx, 2, 'adjust', {
    skuId: navy5,
    locationId: warehouse.id,
    countedQty: 31,
    reasonCode: 'physical_count',
    notes: 'Counted twice, shelf and back room.',
  });

  // --- A batch coming up on its date, with real quantity left --------------
  const jamStrawberry = seeded.items.jam.strawberry;
  const soon = new Date(Date.now() + 11 * DAY).toISOString().slice(0, 10);
  at(db, ctx, 25, 'receive', {
    skuId: jamStrawberry,
    locationId: store.id,
    quantity: 64,
    lotCode: 'B-0731',
    expiresAt: soon,
    reference: 'PO-4502',
  });
  const nearLot = db
    .prepare('SELECT id FROM lots WHERE workspace_id = ? AND code = ?')
    .get(workspaceId, 'B-0731');
  at(db, staffCtx, 6, 'issue', {
    skuId: jamStrawberry,
    locationId: store.id,
    lotId: nearLot.id,
    quantity: 5,
    reasonCode: 'sold',
  });

  // --- Something bought once and never touched since ------------------------
  const bracket = itemService.createItem(db, ctx, {
    name: 'Galvanised Pipe Bracket',
    baseCode: 'GB-311',
    description: 'Heavy duty, 2 in. Bought for a job that was cancelled.',
    unitLabel: 'unit',
    trackingMode: 'quantity',
  });
  const bracketSku = repo.listSkusForItem(db, workspaceId, bracket.itemId)[0];
  at(db, ctx, 190, 'receive', {
    skuId: bracketSku.id,
    locationId: warehouse.id,
    quantity: 120,
    reference: 'PO-4390',
  });
  at(db, staffCtx, 172, 'issue', {
    skuId: bracketSku.id,
    locationId: warehouse.id,
    quantity: 14,
    reasonCode: 'sold',
  });

  // --- And a line that is simply healthy, so the briefing is not all alarm --
  const rationSku = seeded.items.rations.skuId;
  const rationLot = seeded.items.rations.lots[1];
  for (let i = 0; i < 5; i += 1) {
    at(db, staffCtx, 24 - i * 5, 'issue', {
      skuId: rationSku,
      locationId: warehouse.id,
      lotId: rationLot.id,
      quantity: 6,
      reasonCode: 'sold',
    });
  }
  at(db, ctx, 3, 'transfer', {
    skuId: rationSku,
    fromLocationId: warehouse.id,
    toLocationId: van.id,
    lotId: rationLot.id,
    quantity: 10,
    notes: 'Restocked the van.',
  });

  return reevaluate.refresh(db, workspaceId, 'demo-seed');
}

module.exports = { addOperatingHistory, ageExistingMovements, backdate, at };

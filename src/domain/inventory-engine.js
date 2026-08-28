'use strict';

/**
 * The inventory engine.
 *
 * This module is the ONLY place in the application allowed to change stock.
 * Routes, fixtures and future AI configuration all go through these four
 * operations, so the invariants below hold no matter who is calling:
 *
 *   1. Balances only ever move through `applyBalanceDelta`, which refuses to
 *      go negative unless the item explicitly allows it.
 *   2. Every balance change writes an immutable movement row carrying actor,
 *      timestamp, operation, reason and the resulting balance.
 *   3. Whole operations run in a single IMMEDIATE transaction, so a transfer
 *      can never create or destroy stock, even if it fails half way.
 *   4. A serial unit has one nullable location column, so it cannot be in two
 *      places; a partial unique index stops an active serial being received
 *      twice.
 *   5. Lot quantity is tracked per lot per location and can never go negative.
 *   6. Every lookup is workspace scoped, so cross-tenant operations fail as
 *      "not found" rather than touching another tenant's stock.
 */

const { inTransaction } = require('../db');
const repo = require('./repository');
const operatingGuards = require('./operating-guards');
const { ValidationError, InvariantError, InsufficientStockError } = require('./errors');
const {
  ADJUSTMENT_REASON_IDS,
  ISSUE_REASON_IDS,
  CONDITION_IDS,
} = require('./constants');
const {
  newId,
  nowIso,
  trimOrNull,
  requireText,
  requirePositiveInt,
  requireNonNegativeInt,
  requireOneOf,
  optionalDate,
} = require('../lib/util');

// ---------------------------------------------------------------------------
// Low level primitives (always called inside a transaction)
// ---------------------------------------------------------------------------

function applyBalanceDelta(db, { workspaceId, skuId, locationId, delta, allowNegative, now, label }) {
  db.prepare(
    `INSERT INTO balances (workspace_id, sku_id, location_id, on_hand, updated_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(sku_id, location_id) DO NOTHING`
  ).run(workspaceId, skuId, locationId, now);

  // The guard lives in the WHERE clause so two concurrent writers can never
  // both pass a "do we have enough?" check and then both subtract.
  const result = db
    .prepare(
      `UPDATE balances
          SET on_hand = on_hand + @delta, updated_at = @now
        WHERE sku_id = @skuId AND location_id = @locationId AND workspace_id = @workspaceId
          AND (@allowNegative = 1 OR on_hand + @delta >= 0)`
    )
    .run({ workspaceId, skuId, locationId, delta, now, allowNegative: allowNegative ? 1 : 0 });

  if (result.changes === 0) {
    const current = repo.getBalance(db, workspaceId, skuId, locationId);
    throw new InsufficientStockError(
      `Not enough stock at ${label || 'that location'}. On hand: ${current}, requested: ${Math.abs(delta)}.`,
      { onHand: current, requested: Math.abs(delta) }
    );
  }
  return repo.getBalance(db, workspaceId, skuId, locationId);
}

function applyLotDelta(db, { workspaceId, lotId, locationId, delta, now, lotCode, locationName }) {
  db.prepare(
    `INSERT INTO lot_balances (workspace_id, lot_id, location_id, quantity, updated_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(lot_id, location_id) DO NOTHING`
  ).run(workspaceId, lotId, locationId, now);

  const result = db
    .prepare(
      `UPDATE lot_balances
          SET quantity = quantity + @delta, updated_at = @now
        WHERE lot_id = @lotId AND location_id = @locationId AND workspace_id = @workspaceId
          AND quantity + @delta >= 0`
    )
    .run({ workspaceId, lotId, locationId, delta, now });

  if (result.changes === 0) {
    const current = repo.getLotBalance(db, workspaceId, lotId, locationId);
    throw new InsufficientStockError(
      `Lot ${lotCode || ''} only has ${current} at ${locationName || 'that location'}, but ${Math.abs(delta)} was requested.`.replace(
        /\s+/g,
        ' '
      ),
      { onHand: current, requested: Math.abs(delta) }
    );
  }
  return repo.getLotBalance(db, workspaceId, lotId, locationId);
}

function recordMovement(db, movement) {
  const id = newId('mv');
  db.prepare(
    `INSERT INTO movements (
       id, workspace_id, group_id, operation, leg, item_id, sku_id, location_id,
       counterparty_location_id, lot_id, serial_unit_id, quantity_delta,
       balance_after, reason_code, notes, reference, actor_user_id, occurred_at
     ) VALUES (
       @id, @workspaceId, @groupId, @operation, @leg, @itemId, @skuId, @locationId,
       @counterpartyLocationId, @lotId, @serialUnitId, @quantityDelta,
       @balanceAfter, @reasonCode, @notes, @reference, @actorUserId, @occurredAt
     )`
  ).run({
    id,
    leg: null,
    counterpartyLocationId: null,
    lotId: null,
    serialUnitId: null,
    reasonCode: null,
    notes: null,
    reference: null,
    ...movement,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

function requireContext(ctx) {
  if (!ctx || !ctx.workspaceId || !ctx.actorId) {
    throw new ValidationError('A workspace and an acting user are required.');
  }
  return ctx;
}

function resolveTarget(db, ctx, input, { locationField = 'locationId', locationLabel = 'location' } = {}) {
  const sku = repo.requireSku(db, ctx.workspaceId, input.skuId);
  const location = repo.requireLocation(db, ctx.workspaceId, input[locationField], locationLabel);
  if (!location.is_active) {
    throw new ValidationError(`${location.name} is archived and cannot be used.`);
  }
  if (!sku.is_active) {
    throw new ValidationError('That item variant is archived.');
  }
  return { sku, location };
}

function commonMeta(input, { requireReason = false, reasonCodes = null } = {}) {
  const notes = trimOrNull(input.notes);
  const reference = trimOrNull(input.reference);
  let reasonCode = trimOrNull(input.reasonCode);
  if (requireReason) {
    reasonCode = requireOneOf(reasonCode, reasonCodes, 'Reason');
  } else if (reasonCode && reasonCodes && !reasonCodes.includes(reasonCode)) {
    throw new ValidationError('That reason is not recognised.', { field: 'reasonCode' });
  }
  if (notes && notes.length > 500) {
    throw new ValidationError('Notes must be 500 characters or fewer.', { field: 'notes' });
  }
  return { reasonCode, notes, reference };
}

/**
 * A connected system may deliver an event seconds later or replay historical
 * movement history during its first sync. The ledger records that business
 * timestamp while balances still carry the time Foundry actually applied it.
 */
function operationOccurredAt(input, recordedAt) {
  const occurredAt = optionalDate(input && input.occurredAt, 'Occurred at') || recordedAt;
  if (Date.parse(occurredAt) > Date.parse(recordedAt) + 5 * 60 * 1000) {
    throw new ValidationError('Occurred at cannot be in the future.', { field: 'occurredAt' });
  }
  return occurredAt;
}

/** Serial units named in the request must be active stock at `location`. */
function resolveSerialUnits(db, ctx, sku, location, rawIds) {
  const ids = (Array.isArray(rawIds) ? rawIds : [rawIds]).filter(Boolean);
  if (ids.length === 0) {
    throw new ValidationError('Select at least one unit.', { field: 'serialUnitIds' });
  }
  const unique = [...new Set(ids)];
  return unique.map((id) => {
    const unit = repo.requireSerialUnit(db, ctx.workspaceId, id);
    if (unit.sku_id !== sku.id) {
      throw new ValidationError('That unit does not belong to this item.');
    }
    if (unit.status !== 'in_stock') {
      throw new InvariantError(`Unit ${unit.serial} is no longer in stock.`, 'unit_not_in_stock');
    }
    if (unit.location_id !== location.id) {
      throw new InvariantError(
        `Unit ${unit.serial} is not at ${location.name}.`,
        'unit_wrong_location'
      );
    }
    return unit;
  });
}

/** Finds or creates the lot named in the request for this SKU. */
function resolveLotForReceive(db, ctx, sku, input, now) {
  if (input.lotId) {
    const lot = repo.requireLot(db, ctx.workspaceId, input.lotId);
    if (lot.sku_id !== sku.id) throw new ValidationError('That lot belongs to a different item.');
    return lot;
  }
  const code = requireText(input.lotCode, 'Lot or batch number', { max: 80 });
  const existing = repo.getLotByCode(db, ctx.workspaceId, sku.id, code);
  const expiresAt = optionalDate(input.expiresAt, 'Expiration date');
  const receivedAt = optionalDate(input.lotReceivedAt, 'Received date') || now;
  if (existing) {
    // Receiving more of a known lot may fill in details that were left blank.
    if ((expiresAt && !existing.expires_at) || (input.lotNote && !existing.note)) {
      db.prepare('UPDATE lots SET expires_at = COALESCE(?, expires_at), note = COALESCE(?, note) WHERE id = ?').run(
        expiresAt,
        trimOrNull(input.lotNote),
        existing.id
      );
      return repo.requireLot(db, ctx.workspaceId, existing.id);
    }
    return existing;
  }
  const id = newId('lot');
  db.prepare(
    `INSERT INTO lots (id, workspace_id, sku_id, code, received_at, expires_at, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ctx.workspaceId, sku.id, code, receivedAt, expiresAt, trimOrNull(input.lotNote), now);
  return repo.requireLot(db, ctx.workspaceId, id);
}

function resolveLotForMove(db, ctx, sku, input) {
  if (!input.lotId) {
    throw new ValidationError('Choose which lot the stock comes from.', { field: 'lotId' });
  }
  const lot = repo.requireLot(db, ctx.workspaceId, input.lotId);
  if (lot.sku_id !== sku.id) throw new ValidationError('That lot belongs to a different item.');
  return lot;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Receive: stock enters a location.
 */
function receive(db, ctx, input) {
  requireContext(ctx);
  return inTransaction(db, () => {
    const now = nowIso();
    const occurredAt = operationOccurredAt(input, now);
    const groupId = newId('grp');
    const { sku, location } = resolveTarget(db, ctx, input);
    const meta = commonMeta(input);
    const base = {
      workspaceId: ctx.workspaceId,
      groupId,
      operation: 'receive',
      itemId: sku.item_id,
      skuId: sku.id,
      locationId: location.id,
      actorUserId: ctx.actorId,
      occurredAt,
      reasonCode: meta.reasonCode,
      notes: meta.notes,
      reference: meta.reference,
    };

    if (sku.tracking_mode === 'serial') {
      const serials = parseSerialInput(input.serials);
      const movements = [];
      for (const entry of serials) {
        const unitId = createSerialUnit(db, ctx, {
          sku,
          location,
          serial: entry.serial,
          condition: entry.condition,
          now,
        });
        const balanceAfter = applyBalanceDelta(db, {
          workspaceId: ctx.workspaceId,
          skuId: sku.id,
          locationId: location.id,
          delta: 1,
          allowNegative: false,
          now,
          label: location.name,
        });
        movements.push(
          recordMovement(db, {
            ...base,
            serialUnitId: unitId,
            quantityDelta: 1,
            balanceAfter,
          })
        );
      }
      return { groupId, quantity: serials.length, movementIds: movements };
    }

    const quantity = requirePositiveInt(input.quantity, 'Quantity');

    if (sku.tracking_mode === 'lot') {
      const lot = resolveLotForReceive(db, ctx, sku, input, now);
      applyLotDelta(db, {
        workspaceId: ctx.workspaceId,
        lotId: lot.id,
        locationId: location.id,
        delta: quantity,
        now,
        lotCode: lot.code,
        locationName: location.name,
      });
      const balanceAfter = applyBalanceDelta(db, {
        workspaceId: ctx.workspaceId,
        skuId: sku.id,
        locationId: location.id,
        delta: quantity,
        allowNegative: false,
        now,
        label: location.name,
      });
      const movementId = recordMovement(db, {
        ...base,
        lotId: lot.id,
        quantityDelta: quantity,
        balanceAfter,
      });
      return { groupId, quantity, lotId: lot.id, movementIds: [movementId] };
    }

    const balanceAfter = applyBalanceDelta(db, {
      workspaceId: ctx.workspaceId,
      skuId: sku.id,
      locationId: location.id,
      delta: quantity,
      allowNegative: false,
      now,
      label: location.name,
    });
    const movementId = recordMovement(db, { ...base, quantityDelta: quantity, balanceAfter });
    return { groupId, quantity, movementIds: [movementId] };
  });
}

function parseSerialInput(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  const cleaned = [];
  const seen = new Set();
  for (const entry of list) {
    if (!entry) continue;
    const serial = requireText(
      typeof entry === 'string' ? entry : entry.serial,
      'Serial number',
      { max: 120 }
    );
    const condition = typeof entry === 'object' && entry.condition
      ? requireOneOf(entry.condition, CONDITION_IDS, 'Condition')
      : 'good';
    const key = serial.toLowerCase();
    if (seen.has(key)) {
      throw new ValidationError(`Serial number ${serial} was entered twice.`, { field: 'serials' });
    }
    seen.add(key);
    cleaned.push({ serial, condition });
  }
  if (cleaned.length === 0) {
    throw new ValidationError('Enter at least one serial number.', { field: 'serials' });
  }
  if (cleaned.length > 500) {
    throw new ValidationError('Receive at most 500 units at a time.', { field: 'serials' });
  }
  return cleaned;
}

function createSerialUnit(db, ctx, { sku, location, serial, condition, now }) {
  const id = newId('unit');
  try {
    db.prepare(
      `INSERT INTO serial_units (
         id, workspace_id, sku_id, serial, status, location_id, condition, received_at, updated_at
       ) VALUES (?, ?, ?, ?, 'in_stock', ?, ?, ?, ?)`
    ).run(id, ctx.workspaceId, sku.id, serial, location.id, condition || 'good', now, now);
  } catch (err) {
    if (err && String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
      throw new InvariantError(
        `Serial number ${serial} is already in stock. A unit cannot be received twice while it is active.`,
        'duplicate_serial'
      );
    }
    throw err;
  }
  return id;
}

/**
 * Issue: stock leaves available inventory (used, sold, scrapped).
 */
function issue(db, ctx, input) {
  requireContext(ctx);
  return inTransaction(db, () => {
    const now = nowIso();
    const occurredAt = operationOccurredAt(input, now);
    const groupId = newId('grp');
    const { sku, location } = resolveTarget(db, ctx, input);
    const meta = commonMeta(input, { reasonCodes: ISSUE_REASON_IDS });
    const base = {
      workspaceId: ctx.workspaceId,
      groupId,
      operation: 'issue',
      itemId: sku.item_id,
      skuId: sku.id,
      locationId: location.id,
      actorUserId: ctx.actorId,
      occurredAt,
      reasonCode: meta.reasonCode,
      notes: meta.notes,
      reference: meta.reference,
    };

    if (sku.tracking_mode === 'serial') {
      const units = resolveSerialUnits(db, ctx, sku, location, input.serialUnitIds);
      operatingGuards.assertIssueAllowed(db, ctx.workspaceId, {
        skuId: sku.id, locationId: location.id, quantity: units.length,
      });
      const movementIds = [];
      for (const unit of units) {
        db.prepare(
          `UPDATE serial_units SET status = 'issued', location_id = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`
        ).run(now, unit.id, ctx.workspaceId);
        const balanceAfter = applyBalanceDelta(db, {
          workspaceId: ctx.workspaceId,
          skuId: sku.id,
          locationId: location.id,
          delta: -1,
          allowNegative: false,
          now,
          label: location.name,
        });
        movementIds.push(
          recordMovement(db, { ...base, serialUnitId: unit.id, quantityDelta: -1, balanceAfter })
        );
      }
      return { groupId, quantity: units.length, movementIds };
    }

    const quantity = requirePositiveInt(input.quantity, 'Quantity');

    operatingGuards.assertIssueAllowed(db, ctx.workspaceId, {
      skuId: sku.id, locationId: location.id, quantity,
    });

    if (sku.tracking_mode === 'lot') {
      const lot = resolveLotForMove(db, ctx, sku, input);
      applyLotDelta(db, {
        workspaceId: ctx.workspaceId,
        lotId: lot.id,
        locationId: location.id,
        delta: -quantity,
        now,
        lotCode: lot.code,
        locationName: location.name,
      });
      const balanceAfter = applyBalanceDelta(db, {
        workspaceId: ctx.workspaceId,
        skuId: sku.id,
        locationId: location.id,
        delta: -quantity,
        allowNegative: false,
        now,
        label: location.name,
      });
      const movementId = recordMovement(db, {
        ...base,
        lotId: lot.id,
        quantityDelta: -quantity,
        balanceAfter,
      });
      return { groupId, quantity, movementIds: [movementId] };
    }

    const balanceAfter = applyBalanceDelta(db, {
      workspaceId: ctx.workspaceId,
      skuId: sku.id,
      locationId: location.id,
      delta: -quantity,
      allowNegative: !!sku.allow_negative,
      now,
      label: location.name,
    });
    const movementId = recordMovement(db, { ...base, quantityDelta: -quantity, balanceAfter });
    return { groupId, quantity, movementIds: [movementId] };
  });
}

/**
 * Transfer: stock moves between two locations in one atomic step.
 * Both legs share a group id; no intermediate state is ever visible.
 */
function transfer(db, ctx, input) {
  requireContext(ctx);
  return inTransaction(db, () => {
    const now = nowIso();
    const occurredAt = operationOccurredAt(input, now);
    const groupId = newId('grp');
    const sku = repo.requireSku(db, ctx.workspaceId, input.skuId);
    const from = repo.requireLocation(db, ctx.workspaceId, input.fromLocationId, 'source location');
    const to = repo.requireLocation(db, ctx.workspaceId, input.toLocationId, 'destination location');
    if (from.id === to.id) {
      throw new ValidationError('Choose two different locations.', { field: 'toLocationId' });
    }
    if (!to.is_active || !from.is_active) {
      throw new ValidationError('Archived locations cannot be used for transfers.');
    }
    const meta = commonMeta(input);
    const base = {
      workspaceId: ctx.workspaceId,
      groupId,
      operation: 'transfer',
      itemId: sku.item_id,
      skuId: sku.id,
      actorUserId: ctx.actorId,
      occurredAt,
      reasonCode: meta.reasonCode,
      notes: meta.notes,
      reference: meta.reference,
    };

    if (sku.tracking_mode === 'serial') {
      const units = resolveSerialUnits(db, ctx, sku, from, input.serialUnitIds);
      const movementIds = [];
      for (const unit of units) {
        db.prepare('UPDATE serial_units SET location_id = ?, updated_at = ? WHERE id = ? AND workspace_id = ?').run(
          to.id,
          now,
          unit.id,
          ctx.workspaceId
        );
        const outBalance = applyBalanceDelta(db, {
          workspaceId: ctx.workspaceId,
          skuId: sku.id,
          locationId: from.id,
          delta: -1,
          allowNegative: false,
          now,
          label: from.name,
        });
        const inBalance = applyBalanceDelta(db, {
          workspaceId: ctx.workspaceId,
          skuId: sku.id,
          locationId: to.id,
          delta: 1,
          allowNegative: false,
          now,
          label: to.name,
        });
        movementIds.push(
          recordMovement(db, {
            ...base,
            leg: 'out',
            locationId: from.id,
            counterpartyLocationId: to.id,
            serialUnitId: unit.id,
            quantityDelta: -1,
            balanceAfter: outBalance,
          }),
          recordMovement(db, {
            ...base,
            leg: 'in',
            locationId: to.id,
            counterpartyLocationId: from.id,
            serialUnitId: unit.id,
            quantityDelta: 1,
            balanceAfter: inBalance,
          })
        );
      }
      return { groupId, quantity: units.length, movementIds };
    }

    const quantity = requirePositiveInt(input.quantity, 'Quantity');
    let lot = null;
    if (sku.tracking_mode === 'lot') {
      lot = resolveLotForMove(db, ctx, sku, input);
      applyLotDelta(db, {
        workspaceId: ctx.workspaceId,
        lotId: lot.id,
        locationId: from.id,
        delta: -quantity,
        now,
        lotCode: lot.code,
        locationName: from.name,
      });
      applyLotDelta(db, {
        workspaceId: ctx.workspaceId,
        lotId: lot.id,
        locationId: to.id,
        delta: quantity,
        now,
        lotCode: lot.code,
        locationName: to.name,
      });
    }

    const outBalance = applyBalanceDelta(db, {
      workspaceId: ctx.workspaceId,
      skuId: sku.id,
      locationId: from.id,
      delta: -quantity,
      allowNegative: sku.tracking_mode === 'quantity' && !!sku.allow_negative,
      now,
      label: from.name,
    });
    const inBalance = applyBalanceDelta(db, {
      workspaceId: ctx.workspaceId,
      skuId: sku.id,
      locationId: to.id,
      delta: quantity,
      allowNegative: false,
      now,
      label: to.name,
    });

    const movementIds = [
      recordMovement(db, {
        ...base,
        leg: 'out',
        locationId: from.id,
        counterpartyLocationId: to.id,
        lotId: lot ? lot.id : null,
        quantityDelta: -quantity,
        balanceAfter: outBalance,
      }),
      recordMovement(db, {
        ...base,
        leg: 'in',
        locationId: to.id,
        counterpartyLocationId: from.id,
        lotId: lot ? lot.id : null,
        quantityDelta: quantity,
        balanceAfter: inBalance,
      }),
    ];
    return { groupId, quantity, movementIds };
  });
}

/**
 * Adjust: an authorised correction. Always requires a reason.
 *
 * For quantity and lot stock the caller supplies what was actually counted.
 * For serialized stock the caller names the units that are missing or being
 * written off, because "a count" is not meaningful for identified units.
 */
function adjust(db, ctx, input) {
  requireContext(ctx);
  return inTransaction(db, () => {
    const now = nowIso();
    const occurredAt = operationOccurredAt(input, now);
    const groupId = newId('grp');
    const { sku, location } = resolveTarget(db, ctx, input);
    const meta = commonMeta(input, { requireReason: true, reasonCodes: ADJUSTMENT_REASON_IDS });
    const base = {
      workspaceId: ctx.workspaceId,
      groupId,
      operation: 'adjust',
      itemId: sku.item_id,
      skuId: sku.id,
      locationId: location.id,
      actorUserId: ctx.actorId,
      occurredAt,
      reasonCode: meta.reasonCode,
      notes: meta.notes,
      reference: meta.reference,
    };

    if (sku.tracking_mode === 'serial') {
      const units = resolveSerialUnits(db, ctx, sku, location, input.serialUnitIds);
      const movementIds = [];
      for (const unit of units) {
        db.prepare(
          `UPDATE serial_units SET status = 'issued', location_id = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`
        ).run(now, unit.id, ctx.workspaceId);
        const expected = repo.getBalance(db, ctx.workspaceId, sku.id, location.id);
        const balanceAfter = applyBalanceDelta(db, {
          workspaceId: ctx.workspaceId,
          skuId: sku.id,
          locationId: location.id,
          delta: -1,
          allowNegative: false,
          now,
          label: location.name,
        });
        const movementId = recordMovement(db, {
          ...base,
          serialUnitId: unit.id,
          quantityDelta: -1,
          balanceAfter,
        });
        recordAdjustment(db, {
          workspaceId: ctx.workspaceId,
          movementId,
          skuId: sku.id,
          locationId: location.id,
          lotId: null,
          expectedQty: expected,
          countedQty: balanceAfter,
          reasonCode: meta.reasonCode,
          notes: meta.notes,
          actorUserId: ctx.actorId,
          now,
        });
        movementIds.push(movementId);
      }
      return { groupId, quantity: -units.length, movementIds };
    }

    const counted = requireNonNegativeInt(input.countedQty, 'Counted quantity');
    let lot = null;
    let expected;
    if (sku.tracking_mode === 'lot') {
      lot = resolveLotForMove(db, ctx, sku, input);
      expected = repo.getLotBalance(db, ctx.workspaceId, lot.id, location.id);
    } else {
      expected = repo.getBalance(db, ctx.workspaceId, sku.id, location.id);
    }

    const delta = counted - expected;
    if (delta === 0) {
      throw new ValidationError(
        `The counted quantity already matches what Foundry has on record (${expected}). No adjustment was recorded.`
      );
    }

    if (lot) {
      applyLotDelta(db, {
        workspaceId: ctx.workspaceId,
        lotId: lot.id,
        locationId: location.id,
        delta,
        now,
        lotCode: lot.code,
        locationName: location.name,
      });
    }

    const balanceAfter = applyBalanceDelta(db, {
      workspaceId: ctx.workspaceId,
      skuId: sku.id,
      locationId: location.id,
      delta,
      allowNegative: sku.tracking_mode === 'quantity' && !!sku.allow_negative,
      now,
      label: location.name,
    });

    const movementId = recordMovement(db, {
      ...base,
      lotId: lot ? lot.id : null,
      quantityDelta: delta,
      balanceAfter,
    });
    recordAdjustment(db, {
      workspaceId: ctx.workspaceId,
      movementId,
      skuId: sku.id,
      locationId: location.id,
      lotId: lot ? lot.id : null,
      expectedQty: expected,
      countedQty: counted,
      reasonCode: meta.reasonCode,
      notes: meta.notes,
      actorUserId: ctx.actorId,
      now,
    });
    return { groupId, expected, counted, delta, movementIds: [movementId] };
  });
}

function recordAdjustment(db, a) {
  db.prepare(
    `INSERT INTO adjustments (
       id, workspace_id, movement_id, sku_id, location_id, lot_id, expected_qty,
       counted_qty, reason_code, notes, actor_user_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId('adj'),
    a.workspaceId,
    a.movementId,
    a.skuId,
    a.locationId,
    a.lotId,
    a.expectedQty,
    a.countedQty,
    a.reasonCode,
    a.notes,
    a.actorUserId,
    a.now
  );
}

/**
 * Consistency audit used by tests and by the settings screen: the ledger, the
 * aggregate balances, the lot balances and the serial units must all agree.
 */
function verifyIntegrity(db, workspaceId) {
  const problems = [];

  const ledgerMismatches = db
    .prepare(
      `SELECT b.sku_id, b.location_id, b.on_hand,
              COALESCE((SELECT SUM(m.quantity_delta) FROM movements m
                        WHERE m.sku_id = b.sku_id AND m.location_id = b.location_id), 0) AS ledger
         FROM balances b
        WHERE b.workspace_id = ?`
    )
    .all(workspaceId)
    .filter((row) => row.on_hand !== row.ledger);
  for (const row of ledgerMismatches) {
    problems.push({
      kind: 'balance_ledger_mismatch',
      detail: `SKU ${row.sku_id} at ${row.location_id}: balance ${row.on_hand}, ledger ${row.ledger}`,
    });
  }

  const lotMismatches = db
    .prepare(
      `SELECT b.sku_id, b.location_id, b.on_hand,
              COALESCE((SELECT SUM(lb.quantity) FROM lot_balances lb
                        JOIN lots l ON l.id = lb.lot_id
                       WHERE l.sku_id = b.sku_id AND lb.location_id = b.location_id), 0) AS lot_total
         FROM balances b
         JOIN skus s ON s.id = b.sku_id
         JOIN items i ON i.id = s.item_id
        WHERE b.workspace_id = ? AND i.tracking_mode = 'lot'`
    )
    .all(workspaceId)
    .filter((row) => row.on_hand !== row.lot_total);
  for (const row of lotMismatches) {
    problems.push({
      kind: 'lot_balance_mismatch',
      detail: `SKU ${row.sku_id} at ${row.location_id}: balance ${row.on_hand}, lots total ${row.lot_total}`,
    });
  }

  const serialMismatches = db
    .prepare(
      `SELECT b.sku_id, b.location_id, b.on_hand,
              (SELECT COUNT(*) FROM serial_units su
                WHERE su.sku_id = b.sku_id AND su.location_id = b.location_id AND su.status = 'in_stock') AS units
         FROM balances b
         JOIN skus s ON s.id = b.sku_id
         JOIN items i ON i.id = s.item_id
        WHERE b.workspace_id = ? AND i.tracking_mode = 'serial'`
    )
    .all(workspaceId)
    .filter((row) => row.on_hand !== row.units);
  for (const row of serialMismatches) {
    problems.push({
      kind: 'serial_balance_mismatch',
      detail: `SKU ${row.sku_id} at ${row.location_id}: balance ${row.on_hand}, units ${row.units}`,
    });
  }

  const negatives = db
    .prepare(
      `SELECT b.sku_id, b.location_id, b.on_hand FROM balances b
         JOIN skus s ON s.id = b.sku_id
         JOIN items i ON i.id = s.item_id
        WHERE b.workspace_id = ? AND b.on_hand < 0 AND i.allow_negative = 0`
    )
    .all(workspaceId);
  for (const row of negatives) {
    problems.push({
      kind: 'negative_balance',
      detail: `SKU ${row.sku_id} at ${row.location_id} is ${row.on_hand}`,
    });
  }

  const strayUnits = db
    .prepare(
      `SELECT id, serial FROM serial_units
        WHERE workspace_id = ? AND ((status = 'in_stock' AND location_id IS NULL)
                           OR (status = 'issued' AND location_id IS NOT NULL))`
    )
    .all(workspaceId);
  for (const row of strayUnits) {
    problems.push({ kind: 'serial_state_invalid', detail: `Unit ${row.serial} has an inconsistent location` });
  }

  return { ok: problems.length === 0, problems };
}

module.exports = {
  receive,
  issue,
  transfer,
  adjust,
  verifyIntegrity,
};

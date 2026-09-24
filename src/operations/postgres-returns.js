'use strict';

const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError, InvariantError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const inventory = require('../domain/postgres-inventory-engine');
const costing = require('../accounting/postgres-costing');
const ledger = require('../accounting/postgres-ledger');
const workflows = require('./postgres-business-workflows');

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new ValidationError(`${label} must be a whole number above zero.`);
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new ValidationError(`${label} must be a whole number of zero or more.`);
  return number;
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; }
}

function requireContext(ctx) {
  if (!ctx?.workspaceId || !ctx?.actorId) throw new ValidationError('A workspace and acting user are required.');
  return ctx;
}

async function requirePermission(client, ctx, permission, action) {
  const result = await client.query('SELECT role,permissions FROM users WHERE id=$1 AND workspace_id=$2',
    [ctx.actorId, ctx.workspaceId]);
  if (!result.rows.length) throw new ValidationError('The acting user does not belong to this inventory.');
  permissions.assertCan(result.rows[0], permission, action);
}

async function beginOperation(client, ctx, kind, rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) throw new ValidationError('A durable idempotency key is required.');
  const id = newId('pgop');
  const inserted = await client.query(`INSERT INTO stockchief_runtime.business_operations
      (id,workspace_id,kind,idempotency_key) VALUES($1,$2,$3,$4)
      ON CONFLICT(workspace_id,kind,idempotency_key) DO NOTHING RETURNING id`,
  [id, ctx.workspaceId, kind, key]);
  if (inserted.rows.length) return { id, key, replayed: false };
  const prior = await client.query(`SELECT id,status,result FROM stockchief_runtime.business_operations
    WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3 FOR UPDATE`, [ctx.workspaceId, kind, key]);
  if (prior.rows[0]?.status === 'COMPLETED') return { id: prior.rows[0].id, key, replayed: true, result: prior.rows[0].result };
  throw new InvariantError('That return operation is already running.', 'operation_in_progress');
}

async function completeOperation(client, operation, result) {
  await client.query(`UPDATE stockchief_runtime.business_operations
    SET status='COMPLETED',result=$2::jsonb,completed_at=now() WHERE id=$1`,
  [operation.id, JSON.stringify(result)]);
}

function transaction(database, callback) {
  return database.transaction(callback, { isolation: 'SERIALIZABLE', retrySafe: true });
}

async function addSalesEvent(client, ctx, salesOrderId, type, detail, key) {
  await client.query(`INSERT INTO sales_order_events
    (id,workspace_id,sales_order_id,event_type,detail,actor_user_id,idempotency_key,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
  [newId('soevt'), ctx.workspaceId, salesOrderId, type, JSON.stringify(detail || {}), ctx.actorId, key, nowIso()]);
}

async function nextReturnNumber(client, workspaceId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`number:${workspaceId}:customer_returns`]);
  const count = await client.query('SELECT COUNT(*) AS count FROM customer_returns WHERE workspace_id=$1', [workspaceId]);
  return `RMA-${String(Number(count.rows[0].count) + 1001).padStart(5, '0')}`;
}

async function readReturn(queryable, workspaceId, id, lock = false) {
  const header = await queryable.query(`SELECT r.*,so.order_number,so.customer_id,so.currency,
      c.name AS customer_name,q.name AS quarantine_name
    FROM customer_returns r JOIN sales_orders so ON so.id=r.sales_order_id AND so.workspace_id=r.workspace_id
    JOIN customers c ON c.id=so.customer_id AND c.workspace_id=r.workspace_id
    JOIN locations q ON q.id=r.quarantine_location_id AND q.workspace_id=r.workspace_id
    WHERE r.workspace_id=$1 AND r.id=$2${lock ? ' FOR UPDATE OF r' : ''}`, [workspaceId, id]);
  if (!header.rows.length) throw new NotFoundError('That customer return could not be found.');
  const lines = await queryable.query(`SELECT rl.*,sol.quantity_fulfilled,sol.unit_price_minor,s.item_id,s.code,
      s.variant_label,i.name AS item_name,i.tracking_mode
    FROM customer_return_lines rl JOIN sales_order_lines sol ON sol.id=rl.sales_order_line_id
    JOIN skus s ON s.id=rl.sku_id JOIN items i ON i.id=s.item_id
    WHERE rl.workspace_id=$1 AND rl.customer_return_id=$2 ORDER BY rl.created_at,rl.id`, [workspaceId, id]);
  return { ...header.rows[0], lines: lines.rows.map((line) => ({ ...line,
    receiveMovementIds: parseJson(line.receive_movement_ids, []),
    dispositionMovementIds: parseJson(line.disposition_movement_ids, []),
    trackingEvidence: parseJson(line.tracking_evidence, {}),
  })) };
}

async function getCustomerReturn(database, workspaceId, id) {
  return readReturn(database, workspaceId, id, false);
}

async function listCustomerReturns(database, workspaceId, salesOrderId = null) {
  const result = await database.query(`SELECT r.*,so.order_number,c.name AS customer_name
    FROM customer_returns r JOIN sales_orders so ON so.id=r.sales_order_id AND so.workspace_id=r.workspace_id
    JOIN customers c ON c.id=so.customer_id AND c.workspace_id=r.workspace_id
    WHERE r.workspace_id=$1 AND ($2::text IS NULL OR r.sales_order_id=$2)
    ORDER BY r.created_at DESC,r.id DESC`, [workspaceId, salesOrderId]);
  return result.rows;
}

async function requestCustomerReturn(database, rawContext, input) {
  const ctx = requireContext(rawContext);
  if (!Array.isArray(input.lines) || !input.lines.length) throw new ValidationError('Choose at least one fulfilled order line to return.');
  return transaction(database, async (client) => {
    await requirePermission(client, ctx, permissions.AUTHORIZE_CUSTOMER_RETURN, 'authorize customer returns');
    const operation = await beginOperation(client, ctx, 'customer_return.request', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const orderResult = await client.query(`SELECT * FROM sales_orders WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
      [input.salesOrderId, ctx.workspaceId]);
    const order = orderResult.rows[0];
    if (!order) throw new NotFoundError('That customer order could not be found.');
    if (!['PARTIALLY_FULFILLED', 'FULFILLED'].includes(order.status)) {
      throw new ValidationError('Only goods that actually left can be returned.');
    }
    const location = await client.query(`SELECT id FROM locations WHERE id=$1 AND workspace_id=$2 AND is_active=1`,
      [input.quarantineLocationId, ctx.workspaceId]);
    if (!location.rows.length) throw new ValidationError('Choose an active quarantine location.');
    const resolution = String(input.resolution || 'REFUND').toUpperCase();
    if (!['REFUND', 'EXCHANGE', 'NO_REFUND'].includes(resolution)) throw new ValidationError('Choose refund, exchange, or no refund.');
    const id = newId('rma'); const at = nowIso(); const returnNumber = await nextReturnNumber(client, ctx.workspaceId);
    await client.query(`INSERT INTO customer_returns
      (id,workspace_id,return_number,sales_order_id,status,resolution,reason,quarantine_location_id,created_by_user_id,created_at)
      VALUES($1,$2,$3,$4,'REQUESTED',$5,$6,$7,$8,$9)`,
    [id, ctx.workspaceId, returnNumber, order.id, resolution, trimOrNull(input.reason), input.quarantineLocationId, ctx.actorId, at]);
    for (const [index, requested] of input.lines.entries()) {
      const lineResult = await client.query(`SELECT sol.*,s.item_id FROM sales_order_lines sol JOIN skus s ON s.id=sol.sku_id
        WHERE sol.workspace_id=$1 AND sol.sales_order_id=$2 AND sol.id=$3 FOR UPDATE`,
      [ctx.workspaceId, order.id, requested.salesOrderLineId]);
      const line = lineResult.rows[0];
      if (!line) throw new ValidationError(`Return line ${index + 1} is not on that order.`);
      const quantity = positiveInteger(requested.quantity, `Return line ${index + 1} quantity`);
      const prior = await client.query(`SELECT COALESCE(SUM(rl.quantity_authorized),0)::bigint AS quantity
        FROM customer_return_lines rl JOIN customer_returns r ON r.id=rl.customer_return_id
        WHERE rl.workspace_id=$1 AND rl.sales_order_line_id=$2 AND r.status<>'CANCELLED'`, [ctx.workspaceId, line.id]);
      if (Number(prior.rows[0].quantity) + quantity > Number(line.quantity_fulfilled)) {
        throw new ValidationError(`Return line ${index + 1} exceeds the quantity that actually left.`);
      }
      await client.query(`INSERT INTO customer_return_lines
        (id,workspace_id,customer_return_id,sales_order_line_id,sku_id,quantity_authorized,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
      [newId('rmal'), ctx.workspaceId, id, line.id, line.sku_id, quantity, at]);
    }
    await addSalesEvent(client, ctx, order.id, 'customer_return_requested', { customerReturnId: id, returnNumber, resolution },
      `${operation.key}:event`);
    const result = { customerReturnId: id, returnNumber, status: 'REQUESTED' };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
  });
}

async function authorizeCustomerReturn(database, rawContext, id, input) {
  const ctx = requireContext(rawContext);
  return transaction(database, async (client) => {
    await requirePermission(client, ctx, permissions.AUTHORIZE_CUSTOMER_RETURN, 'authorize customer returns');
    const operation = await beginOperation(client, ctx, 'customer_return.authorize', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const row = await readReturn(client, ctx.workspaceId, id, true);
    if (row.status !== 'REQUESTED') throw new ValidationError('Only a requested return can be authorized.');
    const at = nowIso();
    await client.query(`UPDATE customer_returns SET status='AUTHORIZED',authorized_by_user_id=$3,authorized_at=$4
      WHERE id=$1 AND workspace_id=$2`, [id, ctx.workspaceId, ctx.actorId, at]);
    await addSalesEvent(client, ctx, row.sales_order_id, 'customer_return_authorized',
      { customerReturnId: id, returnNumber: row.return_number }, `${operation.key}:event`);
    const result = { customerReturnId: id, status: 'AUTHORIZED' };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
  });
}

async function fulfillmentEvidence(client, ctx, salesOrderLineId) {
  const result = await client.query(`SELECT icm.inventory_movement_id,icm.journal_entry_id,
      ABS(icm.quantity_delta)::bigint AS quantity,ABS(icm.cost_delta_minor)::bigint AS cost_minor,m.lot_id,je.posted_at
    FROM accounting_inventory_cost_movements icm
    JOIN accounting_journal_entries je ON je.id=icm.journal_entry_id AND je.workspace_id=icm.workspace_id
    JOIN movements m ON m.id=icm.inventory_movement_id AND m.workspace_id=icm.workspace_id
    WHERE icm.workspace_id=$1 AND je.source_type='sale_fulfillment'
      AND je.status='POSTED' AND je.metadata::jsonb->>'salesOrderLineId'=$2
      AND icm.quantity_delta<0 ORDER BY je.posted_at,icm.created_at,icm.id`, [ctx.workspaceId, salesOrderLineId]);
  return result.rows.map((row) => ({ inventoryMovementId: row.inventory_movement_id,
    originalJournalEntryId: row.journal_entry_id, quantity: Number(row.quantity), costMinor: Number(row.cost_minor),
    lotId: row.lot_id || null }));
}

async function existingAllocations(client, ctx, salesOrderLineId) {
  const rows = await client.query(`SELECT rl.tracking_evidence FROM customer_return_lines rl
    JOIN customer_returns r ON r.id=rl.customer_return_id AND r.workspace_id=rl.workspace_id
    WHERE rl.workspace_id=$1 AND rl.sales_order_line_id=$2 AND r.status<>'CANCELLED'`,
  [ctx.workspaceId, salesOrderLineId]);
  return rows.rows.flatMap((row) => parseJson(row.tracking_evidence, {}).costAllocations || []);
}

function allocateCost(evidence, used, quantity, preferredMovementIds = []) {
  const usedByMovement = new Map();
  for (const allocation of used) {
    const key = allocation.inventoryMovementId;
    const current = usedByMovement.get(key) || { quantity: 0, costMinor: 0 };
    current.quantity += Number(allocation.quantity || 0); current.costMinor += Number(allocation.costMinor || 0);
    usedByMovement.set(key, current);
  }
  const preferred = new Set(preferredMovementIds);
  const ordered = preferred.size ? evidence.filter((row) => preferred.has(row.inventoryMovementId)) : evidence;
  const allocations = []; let remaining = quantity;
  for (const source of ordered) {
    if (!remaining) break;
    const prior = usedByMovement.get(source.inventoryMovementId) || { quantity: 0, costMinor: 0 };
    const availableQuantity = source.quantity - prior.quantity;
    const availableCost = source.costMinor - prior.costMinor;
    if (availableQuantity <= 0) continue;
    const take = Math.min(remaining, availableQuantity);
    const costMinor = take === availableQuantity ? availableCost : Math.round(availableCost * take / availableQuantity);
    allocations.push({ inventoryMovementId: source.inventoryMovementId,
      originalJournalEntryId: source.originalJournalEntryId, quantity: take, costMinor });
    remaining -= take;
  }
  if (remaining) throw new ValidationError('The return quantity exceeds the fulfilled inventory-cost evidence.');
  return allocations;
}

async function resolveReturnIdentity(client, ctx, line, raw, evidence, quantity) {
  if (line.tracking_mode === 'quantity') return { preferredMovementIds: [], tracking: {} };
  if (line.tracking_mode === 'lot') {
    let lotId = trimOrNull(raw.lotId);
    if (!lotId && trimOrNull(raw.lotCode)) {
      const lot = await client.query(`SELECT id FROM lots WHERE workspace_id=$1 AND sku_id=$2 AND lower(code)=lower($3)`,
        [ctx.workspaceId, line.sku_id, raw.lotCode]);
      lotId = lot.rows[0]?.id || null;
    }
    if (!lotId) throw new ValidationError(`${line.item_name}: enter the returned lot or batch number.`);
    const proven = evidence.filter((row) => row.lotId === lotId);
    if (!proven.length) throw new ValidationError(`${line.item_name}: that lot is not proven to have left on this order.`);
    return { preferredMovementIds: proven.map((row) => row.inventoryMovementId), tracking: { lotId } };
  }
  const serials = [...new Set((raw.serials || []).map((value) => String(value).trim()).filter(Boolean))];
  if (serials.length !== quantity) throw new ValidationError(`${line.item_name}: scan every returned serial number.`);
  const movementIds = evidence.map((row) => row.inventoryMovementId);
  const units = await client.query(`SELECT su.id,su.serial,ims.movement_id FROM serial_units su
    JOIN stockchief_runtime.inventory_movement_serial_units ims ON ims.serial_unit_id=su.id AND ims.workspace_id=su.workspace_id
    WHERE su.workspace_id=$1 AND su.sku_id=$2 AND su.status='issued'
      AND ims.movement_id=ANY($3::text[]) AND lower(su.serial)=ANY($4::text[])`,
  [ctx.workspaceId, line.sku_id, movementIds, serials.map((serial) => serial.toLowerCase())]);
  if (units.rows.length !== quantity) {
    throw new ValidationError(`${line.item_name}: one or more serial numbers are not proven to have left on this order.`);
  }
  return { preferredMovementIds: units.rows.map((unit) => unit.movement_id),
    tracking: { serialUnitIds: units.rows.map((unit) => unit.id), serials: units.rows.map((unit) => unit.serial) } };
}

async function receiveCustomerReturn(database, rawContext, id, input) {
  const ctx = requireContext(rawContext);
  if (!Array.isArray(input.lines) || !input.lines.length) throw new ValidationError('Record what physically arrived.');
  return transaction(database, async (client) => {
    await requirePermission(client, ctx, permissions.INSPECT_CUSTOMER_RETURN, 'receive customer returns');
    const operation = await beginOperation(client, ctx, 'customer_return.receive', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const row = await readReturn(client, ctx.workspaceId, id, true);
    if (!['AUTHORIZED', 'PARTIALLY_RECEIVED'].includes(row.status)) {
      throw new ValidationError('Authorize this return before receiving it.');
    }
    const received = [];
    for (const [index, raw] of input.lines.entries()) {
      const line = row.lines.find((candidate) => candidate.id === raw.lineId);
      if (!line) throw new ValidationError(`Received line ${index + 1} is not authorized on this return.`);
      const quantity = positiveInteger(raw.quantity, `${line.item_name} received quantity`);
      if (Number(line.quantity_received) + quantity > Number(line.quantity_authorized)) {
        throw new ValidationError(`${line.item_name}: received quantity exceeds the authorization.`);
      }
      const evidence = await fulfillmentEvidence(client, ctx, line.sales_order_line_id);
      if (!evidence.length) throw new ValidationError(`${line.item_name}: the original fulfillment has no inventory-cost evidence.`);
      const identity = await resolveReturnIdentity(client, ctx, line, raw, evidence, quantity);
      const used = await existingAllocations(client, ctx, line.sales_order_line_id);
      const allocations = allocateCost(evidence, used, quantity, identity.preferredMovementIds);
      const costMinor = allocations.reduce((sum, allocation) => sum + allocation.costMinor, 0);
      const physical = await inventory.receiveInTransaction(client, ctx, {
        skuId: line.sku_id, locationId: row.quarantine_location_id, quantity,
        lotId: identity.tracking.lotId, returnSerialUnitIds: identity.tracking.serialUnitIds,
        returnCondition: 'unknown', reasonCode: 'customer_return', reference: row.return_number,
        notes: 'Received into quarantine; condition not yet decided.',
        idempotencyKey: `${operation.key}:inventory:${line.id}`,
      });
      let inventoryJournalEntryId = null;
      if (costMinor) {
        const posted = await ledger.postInTransaction(client, ctx, {
          postingDate: nowIso().slice(0, 10), sourceKey: `customer-return-receipt:${operation.key}:${line.id}`,
          description: `Receive ${quantity} returned units on ${row.return_number}`,
          sourceType: 'customer_return_receipt', sourceRecordType: 'customer_return', sourceRecordId: id,
          currency: row.currency, metadata: { customerReturnId: id, customerReturnLineId: line.id,
            movementId: physical.movementId, costMinor },
          lines: [
            { accountKey: 'INVENTORY_ASSET', debitMinor: costMinor, customerId: row.customer_id,
              itemId: line.item_id, skuId: line.sku_id, locationId: row.quarantine_location_id },
            { accountKey: 'COST_OF_GOODS_SOLD', creditMinor: costMinor, customerId: row.customer_id,
              itemId: line.item_id, skuId: line.sku_id, locationId: row.quarantine_location_id },
          ],
        });
        inventoryJournalEntryId = posted.entry.id;
      }
      await costing.receiveInTransaction(client, ctx, { movementId: physical.movementId, totalCostMinor: costMinor,
        journalEntryId: inventoryJournalEntryId, sourceType: 'customer_return_receipt', sourceRecordId: id });
      const trackingEvidence = line.trackingEvidence || {};
      const batch = { quantity, costMinor, returnMovementId: physical.movementId, inventoryJournalEntryId,
        lotId: identity.tracking.lotId || null, serialUnitIds: identity.tracking.serialUnitIds || [],
        serials: identity.tracking.serials || [], allocations: allocations.map((allocation) => ({ ...allocation,
          inventoryJournalEntryId, returnMovementId: physical.movementId })) };
      trackingEvidence.receivedBatches = [...(trackingEvidence.receivedBatches || []), batch];
      trackingEvidence.costAllocations = [...(trackingEvidence.costAllocations || []), ...batch.allocations];
      const movementIds = [...line.receiveMovementIds, physical.movementId];
      await client.query(`UPDATE customer_return_lines SET quantity_received=quantity_received+$2,
        receive_movement_ids=$3,tracking_evidence=$4,updated_at=$5 WHERE id=$1`,
      [line.id, quantity, JSON.stringify(movementIds), JSON.stringify(trackingEvidence), nowIso()]);
      received.push({ lineId: line.id, quantity, movementId: physical.movementId, costMinor, inventoryJournalEntryId });
    }
    const incomplete = await client.query(`SELECT COUNT(*) AS count FROM customer_return_lines
      WHERE customer_return_id=$1 AND quantity_received<quantity_authorized`, [id]);
    const status = Number(incomplete.rows[0].count) ? 'PARTIALLY_RECEIVED' : 'RECEIVED';
    await client.query(`UPDATE customer_returns SET status=$3,
      received_at=CASE WHEN $3='RECEIVED' THEN COALESCE(received_at,$4) ELSE received_at END
      WHERE id=$1 AND workspace_id=$2`, [id, ctx.workspaceId, status, nowIso()]);
    await addSalesEvent(client, ctx, row.sales_order_id, 'customer_return_received',
      { customerReturnId: id, returnNumber: row.return_number, status, lines: received }, `${operation.key}:event`);
    const result = { customerReturnId: id, status, lines: received };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
  });
}

function dispositionChunks(batches, quantities) {
  const available = batches.map((batch) => ({ ...batch, remaining: Number(batch.quantity), serialOffset: 0 }));
  const chunks = [];
  for (const choice of quantities) {
    let remaining = choice.quantity;
    for (const batch of available) {
      if (!remaining || !batch.remaining) continue;
      const quantity = Math.min(remaining, batch.remaining);
      chunks.push({ kind: choice.kind, destinationLocationId: choice.destinationLocationId, quantity,
        lotId: batch.lotId || null,
        serialUnitIds: (batch.serialUnitIds || []).slice(batch.serialOffset, batch.serialOffset + quantity) });
      batch.serialOffset += quantity; batch.remaining -= quantity; remaining -= quantity;
    }
    if (remaining) throw new InvariantError('Return disposition exceeds the received identity evidence.', 'return_identity_mismatch');
  }
  return chunks;
}

async function inspectCustomerReturn(database, rawContext, id, input) {
  const ctx = requireContext(rawContext);
  if (!Array.isArray(input.lines) || !input.lines.length) {
    throw new ValidationError('Record the physical condition and disposition of every returned unit.');
  }
  return transaction(database, async (client) => {
    await requirePermission(client, ctx, permissions.INSPECT_CUSTOMER_RETURN, 'inspect customer returns');
    const operation = await beginOperation(client, ctx, 'customer_return.inspect', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const row = await readReturn(client, ctx.workspaceId, id, true);
    if (row.status !== 'RECEIVED') throw new ValidationError('Receive all returned goods into quarantine before inspecting them.');
    const outcomes = [];
    for (const line of row.lines) {
      const decision = input.lines.find((candidate) => candidate.lineId === line.id);
      if (!decision) throw new ValidationError(`${line.item_name}: choose restock, scrap, or repair.`);
      const restock = nonNegativeInteger(decision.restock, `${line.item_name} restock quantity`);
      const scrap = nonNegativeInteger(decision.scrap, `${line.item_name} scrap quantity`);
      const repair = nonNegativeInteger(decision.repair, `${line.item_name} repair quantity`);
      if (restock + scrap + repair !== Number(line.quantity_received)) {
        throw new ValidationError(`${line.item_name}: dispositions must total the ${line.quantity_received} units received.`);
      }
      if (restock && !trimOrNull(decision.restockLocationId)) throw new ValidationError(`${line.item_name}: choose a restock location.`);
      if (repair && !trimOrNull(decision.repairLocationId)) throw new ValidationError(`${line.item_name}: choose a repair location.`);
      const batches = line.trackingEvidence.receivedBatches || [];
      const chunks = dispositionChunks(batches, [
        { kind: 'restock', quantity: restock, destinationLocationId: decision.restockLocationId },
        { kind: 'repair', quantity: repair, destinationLocationId: decision.repairLocationId },
        { kind: 'scrap', quantity: scrap, destinationLocationId: null },
      ]);
      const movementIds = [];
      for (const [chunkIndex, chunk] of chunks.entries()) {
        const exact = chunk.lotId ? { lotId: chunk.lotId } : chunk.serialUnitIds.length ? { serialUnitIds: chunk.serialUnitIds } : {};
        if (chunk.kind === 'scrap') {
          const physical = await inventory.issueInTransaction(client, ctx, { skuId: line.sku_id,
            locationId: row.quarantine_location_id, quantity: chunk.quantity, reasonCode: 'damaged',
            reference: row.return_number, idempotencyKey: `${operation.key}:${line.id}:scrap:${chunkIndex}`, ...exact });
          const prepared = await costing.prepareIssueInTransaction(client, ctx, { movementId: physical.movementId });
          let journalEntryId = null;
          if (prepared.totalCostMinor) {
            const posted = await ledger.postInTransaction(client, ctx, {
              postingDate: nowIso().slice(0, 10), sourceKey: `customer-return-scrap:${operation.key}:${line.id}:${chunkIndex}`,
              description: `Scrap returned stock on ${row.return_number}`,
              sourceType: 'customer_return_scrap', sourceRecordType: 'customer_return', sourceRecordId: id,
              currency: row.currency, metadata: { customerReturnId: id, movementId: physical.movementId },
              lines: [
                { accountKey: 'INVENTORY_ADJUSTMENTS', debitMinor: prepared.totalCostMinor,
                  itemId: line.item_id, skuId: line.sku_id, locationId: row.quarantine_location_id },
                { accountKey: 'INVENTORY_ASSET', creditMinor: prepared.totalCostMinor,
                  itemId: line.item_id, skuId: line.sku_id, locationId: row.quarantine_location_id },
              ],
            });
            journalEntryId = posted.entry.id;
          }
          await costing.commitIssueInTransaction(client, ctx, prepared, { journalEntryId,
            sourceType: 'customer_return_scrap', sourceRecordId: id });
          movementIds.push(physical.movementId);
        } else {
          const physical = await inventory.transferInTransaction(client, ctx, { skuId: line.sku_id,
            sourceLocationId: row.quarantine_location_id, destinationLocationId: chunk.destinationLocationId,
            quantity: chunk.quantity, reference: row.return_number,
            idempotencyKey: `${operation.key}:${line.id}:${chunk.kind}:${chunkIndex}`, ...exact });
          await costing.transferInTransaction(client, ctx, { outMovementId: physical.outMovementId,
            inMovementId: physical.inMovementId, sourceType: `customer_return_${chunk.kind}`, sourceRecordId: id });
          movementIds.push(physical.outMovementId, physical.inMovementId);
        }
      }
      await client.query(`UPDATE customer_return_lines SET quantity_restocked=$2,quantity_scrapped=$3,
        quantity_repair=$4,condition_note=$5,disposition_movement_ids=$6,updated_at=$7 WHERE id=$1`,
      [line.id, restock, scrap, repair, trimOrNull(decision.conditionNote),
        JSON.stringify([...line.dispositionMovementIds, ...movementIds]), nowIso()]);
      outcomes.push({ lineId: line.id, restock, scrap, repair, movementIds });
    }
    const status = row.resolution === 'REFUND' ? 'AWAITING_REFUND' : row.resolution === 'EXCHANGE' ? 'INSPECTED' : 'COMPLETED';
    const at = nowIso();
    await client.query(`UPDATE customer_returns SET status=$3,inspected_by_user_id=$4,inspected_at=$5,
      completed_at=CASE WHEN $3='COMPLETED' THEN $5 ELSE completed_at END WHERE id=$1 AND workspace_id=$2`,
    [id, ctx.workspaceId, status, ctx.actorId, at]);
    await addSalesEvent(client, ctx, row.sales_order_id, 'customer_return_inspected',
      { customerReturnId: id, returnNumber: row.return_number, status, lines: outcomes }, `${operation.key}:event`);
    const result = { customerReturnId: id, status, lines: outcomes };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
  });
}

async function refundCustomerReturnInTransaction(client, rawContext, id, input) {
  const providerSystem = rawContext?.systemSource === 'payment_provider_refund';
  const ctx = providerSystem ? { workspaceId: rawContext.workspaceId, actorId: null } : requireContext(rawContext);
  if (!ctx.workspaceId) throw new ValidationError('A workspace is required.');
  const destination = String(input.destination || 'CASH').toUpperCase();
  if (!['AR', 'CASH'].includes(destination)) throw new ValidationError('Choose receivable or cash as the refund destination.');
    if (providerSystem) {
      if (!rawContext.providerEffectId) throw new ValidationError('A confirmed provider refund is required.');
      const authorized = await client.query(`SELECT id FROM stockchief_runtime.provider_effects
        WHERE id=$1 AND workspace_id=$2 AND kind='payment.refund.create' AND aggregate_id=$3
          AND status='RUNNING' FOR UPDATE`, [rawContext.providerEffectId, ctx.workspaceId, id]);
      if (!authorized.rows.length) throw new ValidationError('That provider refund is not available for accounting.');
    } else await requirePermission(client, ctx, permissions.REFUND_CUSTOMER_RETURN, 'approve customer refunds');
    const operation = await beginOperation(client, ctx, 'customer_return.refund', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const row = await readReturn(client, ctx.workspaceId, id, true);
    if (row.resolution !== 'REFUND' || row.status !== 'AWAITING_REFUND') {
      throw new ValidationError('This return is not waiting for a refund.');
    }
    const groups = new Map();
    for (const line of row.lines) {
      for (const allocation of line.trackingEvidence.costAllocations || []) {
        const key = `${allocation.originalJournalEntryId}:${allocation.inventoryJournalEntryId || 'none'}`;
        const current = groups.get(key) || { originalJournalEntryId: allocation.originalJournalEntryId,
          inventoryJournalEntryId: allocation.inventoryJournalEntryId || null, revenueMinor: 0, costMinor: 0,
          itemId: line.item_id, skuId: line.sku_id, allocations: [] };
        current.revenueMinor += Number(allocation.quantity) * Number(line.unit_price_minor);
        current.costMinor += Number(allocation.costMinor);
        current.allocations.push(allocation);
        groups.set(key, current);
      }
    }
    const refundGroups = [...groups.values()];
    const amountMinor = refundGroups.reduce((sum, group) => sum + group.revenueMinor, 0);
    const invoiceResult = await client.query(`SELECT * FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND sales_order_id=$2 FOR UPDATE`, [ctx.workspaceId, row.sales_order_id]);
    const invoice = invoiceResult.rows[0];
    if (amountMinor && !invoice) throw new ValidationError('The fulfilled order has no customer invoice to refund.');
    if (amountMinor > Number(invoice?.total_minor || 0)) throw new ValidationError('The refund exceeds the customer invoice total.');
    if (destination === 'AR' && amountMinor > Number(invoice?.balance_minor || 0)) {
      throw new ValidationError('The unpaid invoice balance is smaller than this refund. Refund the paid amount to cash instead.');
    }
    if (destination === 'CASH' && amountMinor) {
      const paid = await client.query(`SELECT COALESCE(SUM(a.amount_minor),0)::bigint AS amount
        FROM accounting_payment_allocations a WHERE a.workspace_id=$1 AND a.customer_invoice_id=$2`,
      [ctx.workspaceId, invoice.id]);
      const priorCash = await client.query(`SELECT COALESCE(SUM(r.revenue_minor+r.tax_minor),0)::bigint AS amount
        FROM accounting_sale_refunds r JOIN accounting_journal_entries je ON je.id=r.original_journal_entry_id
        JOIN sales_order_lines sol ON sol.id=je.metadata::jsonb->>'salesOrderLineId'
        WHERE r.workspace_id=$1 AND sol.sales_order_id=$2 AND r.destination='CASH'`, [ctx.workspaceId, row.sales_order_id]);
      if (amountMinor + Number(priorCash.rows[0].amount) > Number(paid.rows[0].amount)) {
        throw new ValidationError('Cash refunds cannot exceed the amount the customer has actually paid.');
      }
    }
    const refundIds = [];
    for (const [index, group] of refundGroups.entries()) {
      if (!group.revenueMinor) continue;
      const original = await client.query(`SELECT je.id,
          COALESCE(SUM(CASE WHEN a.system_key='SALES_REVENUE' THEN jl.credit_minor ELSE 0 END),0)::bigint AS revenue_minor,
          COALESCE(SUM(CASE WHEN a.system_key='COST_OF_GOODS_SOLD' THEN jl.debit_minor ELSE 0 END),0)::bigint AS cogs_minor
        FROM accounting_journal_entries je JOIN accounting_journal_lines jl ON jl.entry_id=je.id
        JOIN accounting_accounts a ON a.id=jl.account_id WHERE je.workspace_id=$1 AND je.id=$2
          AND je.source_type='sale_fulfillment' AND je.status='POSTED' GROUP BY je.id`,
      [ctx.workspaceId, group.originalJournalEntryId]);
      if (!original.rows.length) throw new ValidationError('The original fulfilled sale accounting entry could not be verified.');
      const prior = await client.query(`SELECT COALESCE(SUM(revenue_minor),0)::bigint AS revenue,
          COALESCE(SUM(cogs_minor),0)::bigint AS cogs FROM accounting_sale_refunds
        WHERE workspace_id=$1 AND original_journal_entry_id=$2`, [ctx.workspaceId, group.originalJournalEntryId]);
      if (Number(prior.rows[0].revenue) + group.revenueMinor > Number(original.rows[0].revenue_minor)
        || Number(prior.rows[0].cogs) + group.costMinor > Number(original.rows[0].cogs_minor)) {
        throw new ValidationError('This refund exceeds the unrefunded amount on the original fulfilled sale.');
      }
      let journalEntryId = null;
      if (group.revenueMinor) {
        const posted = await ledger.postInTransaction(client, ctx, {
          postingDate: String(input.refundDate || nowIso().slice(0, 10)),
          sourceKey: `customer-return-refund:${id}:${index}`,
          description: `Refund ${row.return_number}`, sourceType: 'sales_refund',
          sourceRecordType: 'customer_return', sourceRecordId: id, currency: row.currency,
          metadata: { customerReturnId: id, originalJournalEntryId: group.originalJournalEntryId,
            revenueMinor: group.revenueMinor, cogsMinor: group.costMinor, destination },
          lines: [
            { accountKey: 'SALES_RETURNS', debitMinor: group.revenueMinor, customerId: row.customer_id,
              itemId: group.itemId, skuId: group.skuId },
            { accountKey: destination === 'CASH' ? 'CASH' : 'ACCOUNTS_RECEIVABLE',
              creditMinor: group.revenueMinor, customerId: row.customer_id,
              itemId: group.itemId, skuId: group.skuId },
          ],
        });
        journalEntryId = posted.entry.id;
      }
      const refundId = newId('refund');
      await client.query(`INSERT INTO accounting_sale_refunds
        (id,workspace_id,original_journal_entry_id,refund_reference,refund_date,revenue_minor,tax_minor,
         cogs_minor,physical_return,destination,journal_entry_id,inventory_journal_entry_id,source_key,
         created_by_user_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,0,$7,1,$8,$9,$10,$11,$12,$13)`,
      [refundId, ctx.workspaceId, group.originalJournalEntryId, row.return_number,
        String(input.refundDate || nowIso().slice(0, 10)), group.revenueMinor, group.costMinor, destination,
        journalEntryId, group.inventoryJournalEntryId, `customer-return:${id}:${index}`, ctx.actorId, nowIso()]);
      refundIds.push(refundId);
    }
    if (amountMinor) {
      const balanceMinor = destination === 'AR' ? Number(invoice.balance_minor) - amountMinor : Number(invoice.balance_minor);
      const totalMinor = Number(invoice.total_minor) - amountMinor;
      const subtotalMinor = Math.max(0, Number(invoice.subtotal_minor) - amountMinor);
      const status = balanceMinor === 0 ? 'PAID' : balanceMinor < totalMinor ? 'PARTIALLY_PAID' : 'OPEN';
      await client.query(`UPDATE accounting_customer_invoices SET subtotal_minor=$2,total_minor=$3,
        balance_minor=$4,status=$5,updated_at=$6 WHERE id=$1`,
      [invoice.id, subtotalMinor, totalMinor, balanceMinor, status, nowIso()]);
    }
    await client.query(`UPDATE customer_returns SET status='COMPLETED',refund_id=$3,completed_at=$4
      WHERE id=$1 AND workspace_id=$2`, [id, ctx.workspaceId, refundIds[0] || null, nowIso()]);
    await addSalesEvent(client, ctx, row.sales_order_id, 'customer_return_refunded',
      { customerReturnId: id, returnNumber: row.return_number, destination, amountMinor, refundIds }, `${operation.key}:event`);
    const result = { customerReturnId: id, status: 'COMPLETED', destination, amountMinor, refundIds };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
}

async function refundCustomerReturn(database, rawContext, id, input) {
  return transaction(database, (client) => refundCustomerReturnInTransaction(client, rawContext, id, input));
}

async function exchangeCustomerReturn(database, rawContext, id, input) {
  const ctx = requireContext(rawContext);
  if (!Array.isArray(input.lines) || !input.lines.length) throw new ValidationError('Choose at least one replacement line.');
  return transaction(database, async (client) => {
    await requirePermission(client, ctx, permissions.REFUND_CUSTOMER_RETURN, 'approve return exchanges');
    const operation = await beginOperation(client, ctx, 'customer_return.exchange', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const row = await readReturn(client, ctx.workspaceId, id, true);
    if (row.resolution !== 'EXCHANGE' || row.status !== 'INSPECTED') {
      throw new ValidationError('This return is not waiting for a replacement order.');
    }
    const original = (await client.query(`SELECT * FROM sales_orders WHERE id=$1 AND workspace_id=$2`,
      [row.sales_order_id, ctx.workspaceId])).rows[0];
    const exchange = await workflows.createSalesOrderInTransaction(client, ctx, {
      customerId: row.customer_id, orderDate: input.orderDate || nowIso().slice(0, 10),
      neededBy: input.neededBy || null, fulfillmentLocationId: input.fulfillmentLocationId || original.fulfillment_location_id,
      deliveryMethod: original.delivery_method, shipToAddress: original.ship_to_address, currency: original.currency,
      reference: `Exchange for ${row.return_number}`, notes: trimOrNull(input.notes),
      idempotencyKey: `${operation.key}:replacement-order`, lines: input.lines,
    });
    await client.query(`UPDATE customer_returns SET status='COMPLETED',exchange_order_id=$3,completed_at=$4
      WHERE id=$1 AND workspace_id=$2`, [id, ctx.workspaceId, exchange.salesOrderId, nowIso()]);
    await addSalesEvent(client, ctx, row.sales_order_id, 'customer_return_exchange_prepared',
      { customerReturnId: id, returnNumber: row.return_number, exchangeOrderId: exchange.salesOrderId }, `${operation.key}:event`);
    const result = { customerReturnId: id, status: 'COMPLETED', exchangeOrderId: exchange.salesOrderId,
      exchangeOrderNumber: exchange.orderNumber };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
  });
}

async function nextSupplierReturnNumber(client, workspaceId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`number:${workspaceId}:supplier_returns`]);
  const count = await client.query('SELECT COUNT(*) AS count FROM supplier_returns WHERE workspace_id=$1', [workspaceId]);
  return `RTV-${String(Number(count.rows[0].count) + 1001).padStart(5, '0')}`;
}

async function readSupplierReturn(queryable, workspaceId, id, lock = false) {
  const header = await queryable.query(`SELECT r.*,s.name AS supplier_name,b.bill_number,b.supplier_invoice_number,
      b.currency,b.balance_minor,b.tax_minor,b.total_minor,po.id AS purchase_order_id,po.po_number
    FROM supplier_returns r JOIN suppliers s ON s.id=r.supplier_id AND s.workspace_id=r.workspace_id
    LEFT JOIN accounting_supplier_bills b ON b.id=r.supplier_bill_id AND b.workspace_id=r.workspace_id
    LEFT JOIN purchase_orders po ON po.id=b.purchase_order_id AND po.workspace_id=r.workspace_id
    WHERE r.workspace_id=$1 AND r.id=$2${lock ? ' FOR UPDATE OF r' : ''}`, [workspaceId, id]);
  if (!header.rows.length) throw new NotFoundError('That supplier return could not be found.');
  const lines = await queryable.query(`SELECT l.*,s.item_id,s.code,s.variant_label,i.name AS item_name,
      i.tracking_mode,loc.name AS location_name FROM supplier_return_lines l
    JOIN skus s ON s.id=l.sku_id JOIN items i ON i.id=s.item_id JOIN locations loc ON loc.id=l.location_id
    WHERE l.workspace_id=$1 AND l.supplier_return_id=$2 ORDER BY l.created_at,l.id`, [workspaceId, id]);
  return { ...header.rows[0], lines: lines.rows.map((line) => ({ ...line,
    serialUnitIds: parseJson(line.serial_unit_ids, []), movementIds: parseJson(line.movement_ids, []) })) };
}

async function getSupplierReturn(database, workspaceId, id) {
  return readSupplierReturn(database, workspaceId, id, false);
}

async function listSupplierReturns(database, workspaceId, purchaseOrderId = null) {
  const result = await database.query(`SELECT r.*,s.name AS supplier_name,b.purchase_order_id
    FROM supplier_returns r JOIN suppliers s ON s.id=r.supplier_id AND s.workspace_id=r.workspace_id
    LEFT JOIN accounting_supplier_bills b ON b.id=r.supplier_bill_id AND b.workspace_id=r.workspace_id
    WHERE r.workspace_id=$1 AND ($2::text IS NULL OR b.purchase_order_id=$2)
    ORDER BY r.created_at DESC,r.id DESC`, [workspaceId, purchaseOrderId]);
  return result.rows;
}

async function requestSupplierReturn(database, rawContext, input) {
  const ctx = requireContext(rawContext);
  if (!Array.isArray(input.lines) || !input.lines.length) throw new ValidationError('Choose stock to return to the supplier.');
  return transaction(database, async (client) => {
    await requirePermission(client, ctx, permissions.AUTHORIZE_SUPPLIER_RETURN, 'authorize supplier returns');
    const operation = await beginOperation(client, ctx, 'supplier_return.request', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const supplier = (await client.query(`SELECT * FROM suppliers WHERE id=$1 AND workspace_id=$2 AND status='active'`,
      [input.supplierId, ctx.workspaceId])).rows[0];
    if (!supplier) throw new ValidationError('Choose an active supplier from this inventory.');
    let bill = null;
    if (trimOrNull(input.supplierBillId)) {
      bill = (await client.query(`SELECT * FROM accounting_supplier_bills WHERE id=$1 AND workspace_id=$2
        AND supplier_id=$3 AND status IN('OPEN','PARTIALLY_PAID') FOR UPDATE`,
      [input.supplierBillId, ctx.workspaceId, supplier.id])).rows[0];
      if (!bill) throw new ValidationError('Choose an open supplier bill for the credit reconciliation.');
    }
    const expectedCreditMinor = input.expectedCreditMinor === '' || input.expectedCreditMinor == null
      ? null : positiveInteger(input.expectedCreditMinor, 'Expected supplier credit');
    const id = newId('rtv'); const at = nowIso(); const returnNumber = await nextSupplierReturnNumber(client, ctx.workspaceId);
    await client.query(`INSERT INTO supplier_returns
      (id,workspace_id,return_number,supplier_id,supplier_bill_id,status,expected_credit_minor,reason,created_by_user_id,created_at)
      VALUES($1,$2,$3,$4,$5,'REQUESTED',$6,$7,$8,$9)`,
    [id, ctx.workspaceId, returnNumber, supplier.id, bill?.id || null, expectedCreditMinor,
      trimOrNull(input.reason), ctx.actorId, at]);
    for (const [index, raw] of input.lines.entries()) {
      const stock = (await client.query(`SELECT s.id,s.item_id,i.name,i.tracking_mode,l.id AS location_id,
          COALESCE(b.on_hand,0)::bigint AS on_hand FROM skus s JOIN items i ON i.id=s.item_id
        JOIN locations l ON l.id=$3 AND l.workspace_id=s.workspace_id
        LEFT JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id AND b.location_id=l.id
        WHERE s.id=$1 AND s.workspace_id=$2 AND s.is_active=1 AND i.is_active=1 AND l.is_active=1`,
      [raw.skuId, ctx.workspaceId, raw.locationId])).rows[0];
      if (!stock) throw new ValidationError(`Supplier-return line ${index + 1} has an unavailable SKU or location.`);
      const quantity = positiveInteger(raw.quantity, `Supplier-return line ${index + 1} quantity`);
      if (quantity > Number(stock.on_hand)) throw new ValidationError(`${stock.name}: return quantity exceeds stock on hand.`);
      let lotId = null; let serialUnitIds = [];
      if (stock.tracking_mode === 'lot') {
        lotId = trimOrNull(raw.lotId);
        if (!lotId && trimOrNull(raw.lotCode)) {
          lotId = (await client.query(`SELECT id FROM lots WHERE workspace_id=$1 AND sku_id=$2 AND lower(code)=lower($3)`,
            [ctx.workspaceId, stock.id, raw.lotCode])).rows[0]?.id || null;
        }
        if (!lotId) throw new ValidationError(`${stock.name}: name the exact lot being returned.`);
      }
      if (stock.tracking_mode === 'serial') {
        const named = [...new Set((raw.serials || []).map((value) => String(value).trim()).filter(Boolean))];
        const ids = [...new Set((raw.serialUnitIds || []).map(String))];
        const units = ids.length ? await client.query(`SELECT id FROM serial_units WHERE workspace_id=$1 AND sku_id=$2
          AND location_id=$3 AND status='in_stock' AND id=ANY($4::text[])`, [ctx.workspaceId, stock.id, stock.location_id, ids])
          : await client.query(`SELECT id FROM serial_units WHERE workspace_id=$1 AND sku_id=$2
            AND location_id=$3 AND status='in_stock' AND lower(serial)=ANY($4::text[])`,
          [ctx.workspaceId, stock.id, stock.location_id, named.map((serial) => serial.toLowerCase())]);
        serialUnitIds = units.rows.map((unit) => unit.id);
        if (serialUnitIds.length !== quantity) throw new ValidationError(`${stock.name}: name every serial unit being returned.`);
      }
      await client.query(`INSERT INTO supplier_return_lines
        (id,workspace_id,supplier_return_id,sku_id,location_id,lot_id,serial_unit_ids,quantity,reason,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [newId('rtvl'), ctx.workspaceId, id, stock.id, stock.location_id, lotId,
        JSON.stringify(serialUnitIds), quantity, trimOrNull(raw.reason), at]);
    }
    const result = { supplierReturnId: id, returnNumber, status: 'REQUESTED' };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
  });
}

async function authorizeSupplierReturn(database, rawContext, id, input) {
  const ctx = requireContext(rawContext);
  return transaction(database, async (client) => {
    await requirePermission(client, ctx, permissions.AUTHORIZE_SUPPLIER_RETURN, 'authorize supplier returns');
    const operation = await beginOperation(client, ctx, 'supplier_return.authorize', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const row = await readSupplierReturn(client, ctx.workspaceId, id, true);
    if (row.status !== 'REQUESTED') throw new ValidationError('Only a requested supplier return can be authorized.');
    await client.query(`UPDATE supplier_returns SET status='AUTHORIZED',authorized_by_user_id=$3,authorized_at=$4
      WHERE id=$1 AND workspace_id=$2`, [id, ctx.workspaceId, ctx.actorId, nowIso()]);
    const result = { supplierReturnId: id, status: 'AUTHORIZED' };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
  });
}

async function shipSupplierReturn(database, rawContext, id, input) {
  const ctx = requireContext(rawContext);
  return transaction(database, async (client) => {
    await requirePermission(client, ctx, permissions.SHIP_SUPPLIER_RETURN, 'ship supplier returns');
    const operation = await beginOperation(client, ctx, 'supplier_return.ship', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const row = await readSupplierReturn(client, ctx.workspaceId, id, true);
    if (row.status !== 'AUTHORIZED') throw new ValidationError('Authorize this supplier return before shipping it.');
    const shipped = [];
    for (const [index, line] of row.lines.entries()) {
      const physical = await inventory.issueInTransaction(client, ctx, { skuId: line.sku_id,
        locationId: line.location_id, quantity: Number(line.quantity), lotId: line.lot_id,
        serialUnitIds: line.serialUnitIds, reasonCode: 'returned', reference: row.return_number,
        idempotencyKey: `${operation.key}:inventory:${line.id}` });
      const prepared = await costing.prepareIssueInTransaction(client, ctx, { movementId: physical.movementId });
      let journalEntryId = null;
      if (prepared.totalCostMinor) {
        const posted = await ledger.postInTransaction(client, ctx, {
          postingDate: String(input.shippedAt || nowIso()).slice(0, 10),
          sourceKey: `supplier-return-shipment:${operation.key}:${index}`,
          description: `Ship ${row.return_number} to ${row.supplier_name}`,
          sourceType: 'supplier_return_shipment', sourceRecordType: 'supplier_return', sourceRecordId: id,
          currency: row.currency || 'USD', metadata: { supplierReturnId: id, movementId: physical.movementId,
            costMinor: prepared.totalCostMinor },
          lines: [
            { accountKey: 'SUPPLIER_CREDITS_RECEIVABLE', debitMinor: prepared.totalCostMinor,
              supplierId: row.supplier_id, itemId: line.item_id, skuId: line.sku_id, locationId: line.location_id },
            { accountKey: 'INVENTORY_ASSET', creditMinor: prepared.totalCostMinor,
              supplierId: row.supplier_id, itemId: line.item_id, skuId: line.sku_id, locationId: line.location_id },
          ],
        });
        journalEntryId = posted.entry.id;
      }
      await costing.commitIssueInTransaction(client, ctx, prepared, { journalEntryId,
        sourceType: 'supplier_return_shipment', sourceRecordId: id });
      await client.query('UPDATE supplier_return_lines SET movement_ids=$2 WHERE id=$1',
        [line.id, JSON.stringify([physical.movementId])]);
      shipped.push({ lineId: line.id, movementId: physical.movementId,
        quantity: Number(line.quantity), costMinor: prepared.totalCostMinor, journalEntryId });
    }
    await client.query(`UPDATE supplier_returns SET status='AWAITING_CREDIT',shipped_at=$3
      WHERE id=$1 AND workspace_id=$2`, [id, ctx.workspaceId, input.shippedAt || nowIso()]);
    const result = { supplierReturnId: id, status: 'AWAITING_CREDIT', lines: shipped };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
  });
}

async function reconcileSupplierReturn(database, rawContext, id, input) {
  const ctx = requireContext(rawContext);
  const amountMinor = positiveInteger(input.amountMinor, 'Supplier credit');
  return transaction(database, async (client) => {
    await requirePermission(client, ctx, permissions.RECONCILE_SUPPLIER_RETURN, 'reconcile supplier credits');
    const operation = await beginOperation(client, ctx, 'supplier_return.reconcile', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const row = await readSupplierReturn(client, ctx.workspaceId, id, true);
    if (row.status !== 'AWAITING_CREDIT') throw new ValidationError('This supplier return is not waiting for a credit.');
    if (!row.supplier_bill_id) throw new ValidationError('Match the supplier return to an open bill before reconciling its credit.');
    const bill = (await client.query(`SELECT * FROM accounting_supplier_bills WHERE id=$1 AND workspace_id=$2
      AND supplier_id=$3 AND status IN('OPEN','PARTIALLY_PAID') FOR UPDATE`,
    [row.supplier_bill_id, ctx.workspaceId, row.supplier_id])).rows[0];
    if (!bill) throw new ValidationError('The matched supplier bill is no longer open.');
    if (amountMinor > Number(bill.balance_minor)) throw new ValidationError('Supplier credit cannot exceed the amount still owed on the bill.');
    const movementIds = row.lines.flatMap((line) => line.movementIds);
    const costResult = await client.query(`SELECT COALESCE(SUM(ABS(cost_delta_minor)),0)::bigint AS amount
      FROM accounting_inventory_cost_movements WHERE workspace_id=$1 AND inventory_movement_id=ANY($2::text[])`,
    [ctx.workspaceId, movementIds]);
    const returnCostMinor = Number(costResult.rows[0].amount);
    if (!returnCostMinor) throw new ValidationError('The shipped supplier return has no inventory-cost evidence.');
    const taxCreditMinor = Number(bill.total_minor) > 0
      ? Math.min(Number(bill.tax_minor), Math.round(amountMinor * Number(bill.tax_minor) / Number(bill.total_minor))) : 0;
    const baseCreditMinor = amountMinor - taxCreditMinor;
    const lines = [{ accountKey: 'ACCOUNTS_PAYABLE', debitMinor: amountMinor, supplierId: row.supplier_id }];
    if (taxCreditMinor) lines.push({ accountKey: 'SALES_TAX_RECOVERABLE', creditMinor: taxCreditMinor,
      supplierId: row.supplier_id });
    lines.push({ accountKey: 'SUPPLIER_CREDITS_RECEIVABLE', creditMinor: returnCostMinor, supplierId: row.supplier_id });
    if (baseCreditMinor > returnCostMinor) lines.push({ accountKey: 'PURCHASE_PRICE_VARIANCE',
      creditMinor: baseCreditMinor - returnCostMinor, supplierId: row.supplier_id });
    if (baseCreditMinor < returnCostMinor) lines.push({ accountKey: 'PURCHASE_PRICE_VARIANCE',
      debitMinor: returnCostMinor - baseCreditMinor, supplierId: row.supplier_id });
    const creditId = newId('apcredit'); const at = nowIso();
    const posted = await ledger.postInTransaction(client, ctx, {
      postingDate: input.creditDate || at.slice(0, 10), sourceKey: `supplier-return-credit:${id}`,
      description: `Supplier credit ${input.creditNumber || row.return_number}`,
      sourceType: 'supplier_credit', sourceRecordType: 'supplier_return', sourceRecordId: id,
      currency: bill.currency, metadata: { supplierReturnId: id, supplierBillId: bill.id,
        amountMinor, returnCostMinor, taxCreditMinor }, lines,
    });
    const balanceMinor = Number(bill.balance_minor) - amountMinor;
    await client.query(`UPDATE accounting_supplier_bills SET balance_minor=$2::bigint,status=$3,updated_at=$4,
      paid_at=CASE WHEN $2::bigint=0::bigint THEN $4 ELSE paid_at END WHERE id=$1`,
    [bill.id, balanceMinor, balanceMinor === 0 ? 'PAID' : 'PARTIALLY_PAID', at]);
    await client.query(`INSERT INTO accounting_supplier_credits
      (id,workspace_id,supplier_bill_id,supplier_id,credit_number,credit_date,amount_minor,reason,
       journal_entry_id,source_key,created_by_user_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [creditId, ctx.workspaceId, bill.id, row.supplier_id, trimOrNull(input.creditNumber),
      input.creditDate || at.slice(0, 10), amountMinor, `Supplier return ${row.return_number}`,
      posted.entry.id, `supplier-return:${id}`, ctx.actorId, at]);
    const matches = row.expected_credit_minor == null || Number(row.expected_credit_minor) === amountMinor;
    await client.query(`UPDATE supplier_returns SET actual_credit_minor=$3,supplier_credit_id=$4,status=$5,
      reconciled_at=CASE WHEN $5='RECONCILED' THEN $6 ELSE NULL END WHERE id=$1 AND workspace_id=$2`,
    [id, ctx.workspaceId, amountMinor, creditId, matches ? 'RECONCILED' : 'CREDIT_MISMATCH', at]);
    const result = { supplierReturnId: id, status: matches ? 'RECONCILED' : 'CREDIT_MISMATCH',
      supplierCreditId: creditId, amountMinor, returnCostMinor, balanceMinor, journalEntryId: posted.entry.id };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
  });
}

module.exports = { getCustomerReturn, listCustomerReturns, requestCustomerReturn, authorizeCustomerReturn,
  receiveCustomerReturn, inspectCustomerReturn, refundCustomerReturn, refundCustomerReturnInTransaction,
  exchangeCustomerReturn,
  getSupplierReturn, listSupplierReturns, requestSupplierReturn, authorizeSupplierReturn,
  shipSupplierReturn, reconcileSupplierReturn };

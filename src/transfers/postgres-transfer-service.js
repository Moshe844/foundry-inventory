'use strict';

const inventory = require('../domain/postgres-inventory-engine');
const permissions = require('../actions/permissions');
const costing = require('../accounting/postgres-costing');
const ledger = require('../accounting/postgres-ledger');
const { ValidationError, NotFoundError, InvariantError } = require('../domain/errors');
const { newId, nowIso, trimOrNull } = require('../lib/util');

const OPEN = ['REQUESTED', 'APPROVED', 'PICKED', 'SHIPPED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED'];
const RECEIVABLE = ['SHIPPED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED'];

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function requireContext(ctx) {
  if (!ctx?.workspaceId || !ctx?.actorId) throw new ValidationError('A workspace and acting user are required.');
  return ctx;
}

function positiveInteger(value, label = 'Quantity') {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new ValidationError(`${label} must be a whole number above zero.`);
  return number;
}

function outcomeInteger(value, label) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new ValidationError(`${label} must be a non-negative whole number.`);
  return number;
}

async function requirePermission(client, ctx, permission, what) {
  const result = await client.query('SELECT id,role,permissions FROM users WHERE id=$1 AND workspace_id=$2',
    [ctx.actorId, ctx.workspaceId]);
  if (!result.rows.length) throw new ValidationError('The acting user does not belong to this inventory.');
  permissions.assertCan(result.rows[0], permission, what);
  return result.rows[0];
}

async function lockKey(client, workspaceId, key) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`transfer:${workspaceId}:${key}`]);
}

async function eventByKey(client, workspaceId, key) {
  const result = await client.query(`SELECT * FROM inventory_transfer_events
    WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceId, key]);
  return result.rows[0] || null;
}

function eventKey(input, action, transferId) {
  const supplied = trimOrNull(input?.idempotencyKey);
  if (supplied) return supplied;
  if (action === 'receive' || action === 'request') throw new ValidationError(`${action === 'receive' ? 'A receipt' : 'A transfer request'} needs a stable idempotency key.`);
  return `transfer:${transferId}:${action}`;
}

async function addEvent(client, ctx, transferId, type, detail, key) {
  const existing = await eventByKey(client, ctx.workspaceId, key);
  if (existing) return { ...existing, detail: parseJson(existing.detail), replayed: true };
  const id = newId('tre');
  const at = nowIso();
  await client.query(`INSERT INTO inventory_transfer_events
    (id,workspace_id,transfer_id,event_type,detail,actor_user_id,idempotency_key,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
  [id, ctx.workspaceId, transferId, type, JSON.stringify(detail || {}), ctx.actorId, key, at]);
  return { id, workspace_id: ctx.workspaceId, transfer_id: transferId, event_type: type,
    detail: detail || {}, actor_user_id: ctx.actorId, idempotency_key: key, created_at: at, replayed: false };
}

async function numberFor(client, workspaceId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`number:${workspaceId}:inventory_transfers`]);
  const result = await client.query(`SELECT COALESCE(MAX(
      CASE WHEN transfer_number ~ '^TR-[0-9]+$' THEN substring(transfer_number from 4)::bigint ELSE 0 END),0) AS number
    FROM inventory_transfers WHERE workspace_id=$1`, [workspaceId]);
  return `TR-${String(Number(result.rows[0].number) + 1).padStart(4, '0')}`;
}

async function get(client, workspaceId, id, { lock = false } = {}) {
  const result = await client.query(`SELECT t.*,src.name AS source_name,dst.name AS destination_name
    FROM inventory_transfers t JOIN locations src ON src.id=t.source_location_id
    JOIN locations dst ON dst.id=t.destination_location_id
    WHERE t.id=$1 AND t.workspace_id=$2${lock ? ' FOR UPDATE OF t' : ''}`, [id, workspaceId]);
  if (!result.rows.length) throw new NotFoundError('That transfer could not be found.');
  const transfer = result.rows[0];
  const lines = (await client.query(`SELECT tl.*,s.code,s.variant_label,i.name AS item_name,i.tracking_mode,l.code AS lot_code
    FROM inventory_transfer_lines tl JOIN skus s ON s.id=tl.sku_id JOIN items i ON i.id=s.item_id
    LEFT JOIN lots l ON l.id=tl.lot_id WHERE tl.transfer_id=$1 AND tl.workspace_id=$2
    ORDER BY i.name,s.position,tl.id${lock ? ' FOR UPDATE OF tl' : ''}`, [id, workspaceId])).rows;
  for (const line of lines) {
    line.in_transit_quantity = Math.max(0, Number(line.shipped_quantity) - Number(line.received_quantity)
      - Number(line.lost_quantity) - Number(line.damaged_quantity));
    line.serials = (await client.query(`SELECT ts.*,su.serial FROM inventory_transfer_serials ts
      JOIN serial_units su ON su.id=ts.serial_unit_id WHERE ts.transfer_line_id=$1 ORDER BY su.serial`, [line.id])).rows;
    line.pegs = (await client.query(`SELECT p.*,so.order_number,c.name AS customer_name
      FROM inventory_transfer_pegs p JOIN sales_order_lines sol ON sol.id=p.sales_order_line_id
      JOIN sales_orders so ON so.id=sol.sales_order_id JOIN customers c ON c.id=so.customer_id
      WHERE p.transfer_line_id=$1 ORDER BY p.priority_snapshot,so.needed_by NULLS LAST,so.created_at`, [line.id])).rows;
  }
  const events = (await client.query(`SELECT e.*,u.name AS actor_name FROM inventory_transfer_events e
    LEFT JOIN users u ON u.id=e.actor_user_id WHERE e.transfer_id=$1 AND e.workspace_id=$2
    ORDER BY e.created_at,e.id`, [id, workspaceId])).rows.map((row) => ({ ...row, detail: parseJson(row.detail) }));
  const totals = lines.reduce((sum, line) => ({ requested: sum.requested + Number(line.requested_quantity),
    approved: sum.approved + Number(line.approved_quantity), picked: sum.picked + Number(line.picked_quantity),
    shipped: sum.shipped + Number(line.shipped_quantity), received: sum.received + Number(line.received_quantity),
    lost: sum.lost + Number(line.lost_quantity), damaged: sum.damaged + Number(line.damaged_quantity),
    inTransit: sum.inTransit + Number(line.in_transit_quantity) }),
  { requested: 0, approved: 0, picked: 0, shipped: 0, received: 0, lost: 0, damaged: 0, inTransit: 0 });
  return { ...transfer, decision_detail: parseJson(transfer.decision_detail), lines, events, totals };
}

async function list(database, workspaceId, { status = null } = {}) {
  const values = [workspaceId];
  let filter = '';
  if (status) { values.push(status); filter = ` AND t.status=$${values.length}`; }
  return (await database.query(`SELECT t.*,src.name AS source_name,dst.name AS destination_name,
      COALESCE((SELECT SUM(requested_quantity) FROM inventory_transfer_lines WHERE transfer_id=t.id),0) AS requested_units,
      COALESCE((SELECT SUM(shipped_quantity-received_quantity-lost_quantity-damaged_quantity)
        FROM inventory_transfer_lines WHERE transfer_id=t.id),0) AS in_transit_units
    FROM inventory_transfers t JOIN locations src ON src.id=t.source_location_id
    JOIN locations dst ON dst.id=t.destination_location_id
    WHERE t.workspace_id=$1${filter}
    ORDER BY CASE WHEN t.status IN ('RECEIVED','CANCELLED') THEN 1 ELSE 0 END,
      t.expected_arrival_date NULLS LAST,t.created_at DESC`, values)).rows;
}

async function demandPegs(client, workspaceId, skuId, destinationLocationId, quantity) {
  let remaining = quantity;
  const rows = (await client.query(`SELECT sol.id,so.allocation_priority,
      GREATEST(0,sol.quantity_ordered-sol.quantity_fulfilled-
        COALESCE((SELECT SUM(a.quantity) FROM sales_order_allocations a WHERE a.sales_order_line_id=sol.id),0)) AS waiting
    FROM sales_order_lines sol JOIN sales_orders so ON so.id=sol.sales_order_id
    WHERE sol.workspace_id=$1 AND sol.sku_id=$2 AND so.fulfillment_location_id=$3
      AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
    ORDER BY so.allocation_priority,so.needed_by NULLS LAST,so.created_at,so.id`,
  [workspaceId, skuId, destinationLocationId])).rows;
  const pegs = [];
  for (const row of rows) {
    if (remaining <= 0) break;
    const allocated = Math.min(remaining, Number(row.waiting));
    if (allocated > 0) pegs.push({ salesOrderLineId: row.id, quantity: allocated,
      priority: Number(row.allocation_priority), reason: 'Destination customer shortage' });
    remaining -= allocated;
  }
  return pegs;
}

async function addPeg(client, workspaceId, transferLine, input) {
  const quantity = positiveInteger(input.quantity, 'Peg quantity');
  const result = await client.query(`SELECT sol.id,sol.sku_id,so.allocation_priority
    FROM sales_order_lines sol JOIN sales_orders so ON so.id=sol.sales_order_id
    WHERE sol.id=$1 AND sol.workspace_id=$2 AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')`,
  [input.salesOrderLineId, workspaceId]);
  const orderLine = result.rows[0];
  if (!orderLine || orderLine.sku_id !== transferLine.skuId) {
    throw new ValidationError('A demand peg must name an open order line for the same product.');
  }
  await client.query(`INSERT INTO inventory_transfer_pegs
    (id,workspace_id,transfer_line_id,sales_order_line_id,quantity,priority_snapshot,reason,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(transfer_line_id,sales_order_line_id) DO NOTHING`,
  [newId('trp'), workspaceId, transferLine.id, orderLine.id, quantity,
    Number(input.priority ?? orderLine.allocation_priority), trimOrNull(input.reason) || 'Customer demand', nowIso()]);
}

async function requestInTransaction(client, rawContext, input) {
  const ctx = requireContext(rawContext);
  const key = eventKey(input, 'request');
  await requirePermission(client, ctx, permissions.REQUEST_TRANSFER, 'request an inventory transfer');
  await lockKey(client, ctx.workspaceId, key);
  const prior = await eventByKey(client, ctx.workspaceId, key);
  if (prior) return { ...(await get(client, ctx.workspaceId, prior.transfer_id)), replayed: true };
  if (!Array.isArray(input.lines) || !input.lines.length) throw new ValidationError('Add at least one product to transfer.');
  const locations = (await client.query(`SELECT id,name,is_active FROM locations
    WHERE workspace_id=$1 AND id=ANY($2::text[]) FOR UPDATE`,
  [ctx.workspaceId, [input.fromLocationId, input.toLocationId]])).rows;
  const from = locations.find((row) => row.id === input.fromLocationId);
  const to = locations.find((row) => row.id === input.toLocationId);
  if (!from || !to) throw new ValidationError('Choose source and destination locations from this inventory.');
  if (from.id === to.id) throw new ValidationError('Choose two different locations.');
  if (!Number(from.is_active) || !Number(to.is_active)) throw new ValidationError('Archived locations cannot be used for transfers.');
  const duplicate = new Set();
  const prepared = [];
  for (const [index, supplied] of input.lines.entries()) {
    const skuResult = await client.query(`SELECT s.id,i.name,i.tracking_mode FROM skus s JOIN items i ON i.id=s.item_id
      WHERE s.id=$1 AND s.workspace_id=$2 AND s.is_active=1 AND i.is_active=1`, [supplied.skuId, ctx.workspaceId]);
    const sku = skuResult.rows[0];
    if (!sku) throw new ValidationError(`Transfer line ${index + 1} does not name an active product in this inventory.`);
    const quantity = positiveInteger(supplied.quantity, `Transfer line ${index + 1} quantity`);
    let lotId = null;
    if (sku.tracking_mode === 'lot') {
      const lot = (await client.query(`SELECT l.id FROM lots l JOIN lot_balances b ON b.lot_id=l.id
        WHERE l.id=$1 AND l.workspace_id=$2 AND l.sku_id=$3 AND b.location_id=$4 AND b.quantity>0`,
      [supplied.lotId, ctx.workspaceId, sku.id, from.id])).rows[0];
      if (!lot) throw new ValidationError('That lot is not available at the source location.');
      lotId = lot.id;
    }
    const lineKey = `${sku.id}:${lotId || ''}`;
    if (duplicate.has(lineKey)) throw new ValidationError('Combine duplicate product and lot lines into one quantity.');
    duplicate.add(lineKey);
    let serialUnitIds = [];
    if (sku.tracking_mode === 'serial') {
      serialUnitIds = [...new Set((supplied.serialUnitIds || []).map(String))];
      if (serialUnitIds.length !== quantity) throw new ValidationError('Select each serial unit included in this transfer.');
      const serials = await client.query(`SELECT id FROM serial_units WHERE workspace_id=$1 AND sku_id=$2
        AND location_id=$3 AND status='in_stock' AND id=ANY($4::text[])`,
      [ctx.workspaceId, sku.id, from.id, serialUnitIds]);
      if (serials.rows.length !== quantity) throw new ValidationError('One selected serial unit is not available at the source.');
    }
    prepared.push({ supplied, sku, quantity, lotId, serialUnitIds });
  }
  const at = nowIso();
  const id = newId('tr');
  const transferNumber = await numberFor(client, ctx.workspaceId);
  await client.query(`INSERT INTO inventory_transfers
    (id,workspace_id,transfer_number,source_location_id,destination_location_id,status,expected_arrival_date,
     reason,notes,reference,decision_detail,requested_by_user_id,requested_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'REQUESTED',$6,$7,$8,$9,$10,$11,$12,$12,$12)`,
  [id, ctx.workspaceId, transferNumber, from.id, to.id, trimOrNull(input.expectedArrivalDate),
    trimOrNull(input.reason), trimOrNull(input.notes), trimOrNull(input.reference),
    JSON.stringify(input.decisionDetail || {}), ctx.actorId, at]);
  for (const row of prepared) {
    const lineId = newId('trl');
    await client.query(`INSERT INTO inventory_transfer_lines
      (id,workspace_id,transfer_id,sku_id,lot_id,requested_quantity,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
    [lineId, ctx.workspaceId, id, row.sku.id, row.lotId, row.quantity, at]);
    for (const serialUnitId of row.serialUnitIds) {
      await client.query(`INSERT INTO inventory_transfer_serials
        (workspace_id,transfer_line_id,serial_unit_id,state,created_at,updated_at)
        VALUES($1,$2,$3,'REQUESTED',$4,$4)`, [ctx.workspaceId, lineId, serialUnitId, at]);
    }
    const suppliedPegs = Array.isArray(row.supplied.pegs) && row.supplied.pegs.length
      ? row.supplied.pegs
      : await demandPegs(client, ctx.workspaceId, row.sku.id, to.id, row.quantity);
    for (const peg of suppliedPegs) await addPeg(client, ctx.workspaceId, { id: lineId, skuId: row.sku.id }, peg);
  }
  await addEvent(client, ctx, id, 'REQUESTED', { from: from.id, to: to.id }, key);
  return { ...(await get(client, ctx.workspaceId, id)), replayed: false };
}

function request(database, ctx, input) {
  return database.transaction((client) => requestInTransaction(client, ctx, input),
    { isolation: 'SERIALIZABLE', retrySafe: true });
}

async function sourceAvailable(client, workspaceId, skuId, locationId, { lotId = null, excludeTransferId = null } = {}) {
  const balance = (await client.query(`SELECT COALESCE(on_hand,0) AS on_hand FROM balances
    WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`, [workspaceId, skuId, locationId])).rows[0];
  const committed = await client.query(`SELECT COALESCE(SUM(a.quantity),0) AS quantity
    FROM sales_order_allocations a JOIN sales_order_lines l ON l.id=a.sales_order_line_id
    JOIN sales_orders o ON o.id=l.sales_order_id WHERE a.workspace_id=$1 AND a.location_id=$2 AND l.sku_id=$3
      AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')`, [workspaceId, locationId, skuId]);
  const reserved = await client.query(`SELECT COALESCE(SUM(tl.approved_quantity),0) AS quantity
    FROM inventory_transfer_lines tl JOIN inventory_transfers t ON t.id=tl.transfer_id
    WHERE tl.workspace_id=$1 AND t.source_location_id=$2 AND tl.sku_id=$3
      AND (($4::text IS NULL AND tl.lot_id IS NULL) OR tl.lot_id=$4)
      AND t.status IN ('APPROVED','PICKED') AND ($5::text IS NULL OR t.id<>$5)`,
  [workspaceId, locationId, skuId, lotId, excludeTransferId]);
  let onHand = Number(balance?.on_hand || 0);
  if (lotId) {
    const lot = await client.query(`SELECT COALESCE(quantity,0) AS quantity FROM lot_balances
      WHERE workspace_id=$1 AND lot_id=$2 AND location_id=$3`, [workspaceId, lotId, locationId]);
    onHand = Number(lot.rows[0]?.quantity || 0);
  }
  const committedUnits = lotId ? 0 : Number(committed.rows[0].quantity);
  const reservedUnits = Number(reserved.rows[0].quantity);
  return { onHand, committed: committedUnits, reserved: reservedUnits,
    available: Math.max(0, onHand - committedUnits - reservedUnits) };
}

async function approveInTransaction(client, rawContext, transferId, input = {}) {
  const ctx = requireContext(rawContext);
  const key = eventKey(input, 'approve', transferId);
  await requirePermission(client, ctx, permissions.APPROVE_TRANSFER, 'approve an inventory transfer');
  await lockKey(client, ctx.workspaceId, key);
  const replay = await eventByKey(client, ctx.workspaceId, key);
  if (replay) return { ...(await get(client, ctx.workspaceId, replay.transfer_id)), replayed: true };
  const transfer = await get(client, ctx.workspaceId, transferId, { lock: true });
  if (transfer.status !== 'REQUESTED') throw new ValidationError('Only a requested transfer can be approved.');
  const lockRows = [...transfer.lines].sort((a, b) => `${a.sku_id}:${a.lot_id || ''}`.localeCompare(`${b.sku_id}:${b.lot_id || ''}`));
  for (const line of lockRows) {
    await client.query(`INSERT INTO balances(workspace_id,sku_id,location_id,on_hand,updated_at)
      VALUES($1,$2,$3,0,$4) ON CONFLICT(sku_id,location_id) DO NOTHING`,
    [ctx.workspaceId, line.sku_id, transfer.source_location_id, nowIso()]);
    await client.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE`,
      [ctx.workspaceId, line.sku_id, transfer.source_location_id]);
    if (line.lot_id) await client.query(`SELECT quantity FROM lot_balances
      WHERE workspace_id=$1 AND lot_id=$2 AND location_id=$3 FOR UPDATE`,
    [ctx.workspaceId, line.lot_id, transfer.source_location_id]);
  }
  for (const line of transfer.lines) {
    const quantity = input.quantities?.[line.id] === undefined ? Number(line.requested_quantity)
      : positiveInteger(input.quantities[line.id], 'Approved quantity');
    if (quantity > Number(line.requested_quantity)) throw new ValidationError('Approved quantity cannot exceed requested quantity.');
    const availability = await sourceAvailable(client, ctx.workspaceId, line.sku_id, transfer.source_location_id,
      { lotId: line.lot_id, excludeTransferId: transfer.id });
    if (quantity > availability.available) {
      throw new ValidationError(`${line.item_name} only has ${availability.available} available at ${transfer.source_name} after customer commitments and other approved transfers.`);
    }
    if (line.tracking_mode === 'serial') {
      const ids = line.serials.map((serial) => serial.serial_unit_id);
      const valid = await client.query(`SELECT su.id FROM serial_units su WHERE su.workspace_id=$1 AND su.sku_id=$2
        AND su.location_id=$3 AND su.status='in_stock' AND su.id=ANY($4::text[]) FOR UPDATE`,
      [ctx.workspaceId, line.sku_id, transfer.source_location_id, ids]);
      const reserved = await client.query(`SELECT DISTINCT ts.serial_unit_id FROM inventory_transfer_serials ts
        JOIN inventory_transfer_lines tl ON tl.id=ts.transfer_line_id JOIN inventory_transfers t ON t.id=tl.transfer_id
        WHERE ts.workspace_id=$1 AND ts.serial_unit_id=ANY($2::text[]) AND t.id<>$3
          AND t.status IN ('APPROVED','PICKED')`, [ctx.workspaceId, ids, transfer.id]);
      if (valid.rows.length !== ids.length || reserved.rows.length) {
        throw new ValidationError('One selected serial unit is no longer available for this transfer.');
      }
    }
    await client.query(`UPDATE inventory_transfer_lines SET approved_quantity=$2,
      cancelled_quantity=requested_quantity-$2,updated_at=$3 WHERE id=$1`, [line.id, quantity, nowIso()]);
  }
  const at = nowIso();
  await client.query(`UPDATE inventory_transfers SET status='APPROVED',approved_by_user_id=$3,approved_at=$4,
    updated_at=$4,version=version+1 WHERE id=$1 AND workspace_id=$2`, [transferId, ctx.workspaceId, ctx.actorId, at]);
  await addEvent(client, ctx, transferId, 'APPROVED', {}, key);
  return { ...(await get(client, ctx.workspaceId, transferId)), replayed: false };
}

function approve(database, ctx, transferId, input) {
  return database.transaction((client) => approveInTransaction(client, ctx, transferId, input),
    { isolation: 'READ COMMITTED', retrySafe: true });
}

async function pickInTransaction(client, rawContext, transferId, input = {}) {
  const ctx = requireContext(rawContext);
  const key = eventKey(input, 'pick', transferId);
  await requirePermission(client, ctx, permissions.PICK_TRANSFER, 'pick an inventory transfer');
  await lockKey(client, ctx.workspaceId, key);
  const replay = await eventByKey(client, ctx.workspaceId, key);
  if (replay) return { ...(await get(client, ctx.workspaceId, replay.transfer_id)), replayed: true };
  const transfer = await get(client, ctx.workspaceId, transferId, { lock: true });
  if (transfer.status !== 'APPROVED') throw new ValidationError('Only an approved transfer can be picked.');
  const at = nowIso();
  await client.query(`UPDATE inventory_transfer_lines SET picked_quantity=approved_quantity,updated_at=$2
    WHERE transfer_id=$1`, [transferId, at]);
  await client.query(`UPDATE inventory_transfer_serials SET state='PICKED',updated_at=$2
    WHERE transfer_line_id IN (SELECT id FROM inventory_transfer_lines WHERE transfer_id=$1)`, [transferId, at]);
  await client.query(`UPDATE inventory_transfers SET status='PICKED',picked_by_user_id=$3,picked_at=$4,
    updated_at=$4,version=version+1 WHERE id=$1 AND workspace_id=$2`, [transferId, ctx.workspaceId, ctx.actorId, at]);
  await addEvent(client, ctx, transferId, 'PICKED', {}, key);
  return { ...(await get(client, ctx.workspaceId, transferId)), replayed: false };
}

function pick(database, ctx, transferId, input) {
  return database.transaction((client) => pickInTransaction(client, ctx, transferId, input),
    { isolation: 'READ COMMITTED', retrySafe: true });
}

async function accountingEnabled(client, workspaceId) {
  const result = await client.query('SELECT 1 FROM accounting_settings WHERE workspace_id=$1 AND enabled=1', [workspaceId]);
  return Boolean(result.rows.length);
}

async function postTransitJournal(client, ctx, transfer, line, eventId, amount, kind) {
  if (!amount || !(await accountingEnabled(client, ctx.workspaceId))) return null;
  const dispatch = kind === 'dispatch';
  const receipt = kind === 'receipt';
  return ledger.postInTransaction(client, ctx, {
    postingDate: nowIso().slice(0, 10),
    description: `${transfer.transfer_number}: ${kind === 'writeoff' ? 'transfer loss or damage' : kind}`,
    sourceType: `inventory_transfer_${kind}`, sourceRecordType: 'inventory_transfer',
    sourceRecordId: transfer.id, sourceEventId: eventId,
    sourceKey: `inventory-transfer:${transfer.id}:${line.id}:${eventId}:${kind}`,
    lines: dispatch ? [
      { accountKey: 'INVENTORY_IN_TRANSIT', debitMinor: amount, skuId: line.sku_id },
      { accountKey: 'INVENTORY_ASSET', creditMinor: amount, skuId: line.sku_id, locationId: transfer.source_location_id },
    ] : receipt ? [
      { accountKey: 'INVENTORY_ASSET', debitMinor: amount, skuId: line.sku_id, locationId: transfer.destination_location_id },
      { accountKey: 'INVENTORY_IN_TRANSIT', creditMinor: amount, skuId: line.sku_id },
    ] : [
      { accountKey: 'INVENTORY_ADJUSTMENTS', debitMinor: amount, skuId: line.sku_id },
      { accountKey: 'INVENTORY_IN_TRANSIT', creditMinor: amount, skuId: line.sku_id },
    ],
  });
}

async function dispatchInTransaction(client, rawContext, transferId, input = {}) {
  const ctx = requireContext(rawContext);
  const key = eventKey(input, 'dispatch', transferId);
  await requirePermission(client, ctx, permissions.DISPATCH_TRANSFER, 'dispatch an inventory transfer');
  await lockKey(client, ctx.workspaceId, key);
  const replay = await eventByKey(client, ctx.workspaceId, key);
  if (replay) return { ...(await get(client, ctx.workspaceId, replay.transfer_id)), replayed: true };
  const transfer = await get(client, ctx.workspaceId, transferId, { lock: true });
  if (transfer.status !== 'PICKED') throw new ValidationError('Only a picked transfer can be dispatched.');
  const event = await addEvent(client, ctx, transferId, 'SHIPPED', {}, key);
  for (const line of transfer.lines) {
    const serialUnitIds = line.serials.map((serial) => serial.serial_unit_id);
    const physical = await inventory.dispatchTransferInTransaction(client, ctx, {
      groupId: `transfer:${transferId}:${line.id}`, skuId: line.sku_id,
      sourceLocationId: transfer.source_location_id, destinationLocationId: transfer.destination_location_id,
      quantity: Number(line.picked_quantity), lotId: line.lot_id, serialUnitIds,
      reference: transfer.transfer_number, notes: `Dispatched ${transfer.transfer_number}`,
      idempotencyKey: `${key}:line:${line.id}`,
    });
    let dispatchedCost = 0;
    let costStatus = 'NOT_RECORDED';
    const costState = await client.query(`SELECT quantity_units FROM accounting_inventory_cost_balances
      WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE`,
    [ctx.workspaceId, line.sku_id, transfer.source_location_id]);
    if (Number(costState.rows[0]?.quantity_units || 0) >= Number(line.picked_quantity)) {
      const prepared = await costing.prepareIssueInTransaction(client, ctx, { movementId: physical.movementId });
      const posted = await postTransitJournal(client, ctx, transfer, line, event.id, prepared.totalCostMinor, 'dispatch');
      await costing.commitIssueInTransaction(client, ctx, prepared, { journalEntryId: posted?.entry.id || null,
        sourceType: 'inventory_transfer_dispatch', sourceRecordId: line.id });
      dispatchedCost = prepared.totalCostMinor;
      costStatus = 'RECORDED';
    }
    await client.query(`UPDATE inventory_transfer_lines SET shipped_quantity=picked_quantity,
      dispatched_cost_minor=$2,cost_status=$3,updated_at=$4 WHERE id=$1`,
    [line.id, dispatchedCost, costStatus, nowIso()]);
    await client.query(`UPDATE inventory_transfer_serials SET state='IN_TRANSIT',updated_at=$2
      WHERE transfer_line_id=$1`, [line.id, nowIso()]);
    await client.query(`INSERT INTO inventory_transfer_movement_links
      (workspace_id,transfer_line_id,movement_id,role,event_id,created_at)
      VALUES($1,$2,$3,'DISPATCH',$4,$5)`, [ctx.workspaceId, line.id, physical.movementId, event.id, nowIso()]);
  }
  const at = nowIso();
  await client.query(`UPDATE inventory_transfers SET status='SHIPPED',dispatched_by_user_id=$3,shipped_at=$4,
    updated_at=$4,version=version+1 WHERE id=$1 AND workspace_id=$2`, [transferId, ctx.workspaceId, ctx.actorId, at]);
  return { ...(await get(client, ctx.workspaceId, transferId)), replayed: false };
}

function dispatch(database, ctx, transferId, input) {
  return database.transaction((client) => dispatchInTransaction(client, ctx, transferId, input),
    { isolation: 'READ COMMITTED', retrySafe: true });
}

async function markInTransitInTransaction(client, rawContext, transferId, input = {}) {
  const ctx = requireContext(rawContext);
  const key = eventKey(input, 'in-transit', transferId);
  await requirePermission(client, ctx, permissions.DISPATCH_TRANSFER, 'mark an inventory transfer in transit');
  await lockKey(client, ctx.workspaceId, key);
  const replay = await eventByKey(client, ctx.workspaceId, key);
  if (replay) return { ...(await get(client, ctx.workspaceId, replay.transfer_id)), replayed: true };
  const transfer = await get(client, ctx.workspaceId, transferId, { lock: true });
  if (transfer.status !== 'SHIPPED') throw new ValidationError('Only a shipped transfer can be marked in transit.');
  const at = nowIso();
  await client.query(`UPDATE inventory_transfers SET status='IN_TRANSIT',in_transit_at=$3,
    updated_at=$3,version=version+1 WHERE id=$1 AND workspace_id=$2`, [transferId, ctx.workspaceId, at]);
  await addEvent(client, ctx, transferId, 'IN_TRANSIT', {}, key);
  return { ...(await get(client, ctx.workspaceId, transferId)), replayed: false };
}

function markInTransit(database, ctx, transferId, input) {
  return database.transaction((client) => markInTransitInTransaction(client, ctx, transferId, input),
    { isolation: 'READ COMMITTED', retrySafe: true });
}

async function reconcilePegs(client, ctx, transferId, destinationLocationId) {
  const pegs = (await client.query(`SELECT p.*,l.sku_id,l.sales_order_id,o.status,o.fulfillment_location_id
    FROM inventory_transfer_pegs p JOIN sales_order_lines l ON l.id=p.sales_order_line_id
    JOIN sales_orders o ON o.id=l.sales_order_id JOIN inventory_transfer_lines tl ON tl.id=p.transfer_line_id
    WHERE tl.transfer_id=$1 AND p.workspace_id=$2
    ORDER BY p.priority_snapshot,o.needed_by NULLS LAST,o.created_at,p.id FOR UPDATE OF l,o`,
  [transferId, ctx.workspaceId])).rows;
  const orderIds = new Set();
  for (const peg of pegs) {
    if (!['CONFIRMED', 'BACKORDERED', 'PARTIALLY_FULFILLED'].includes(peg.status)
      || peg.fulfillment_location_id !== destinationLocationId) continue;
    const needResult = await client.query(`SELECT l.quantity_ordered-l.quantity_fulfilled-
        COALESCE((SELECT SUM(a.quantity) FROM sales_order_allocations a WHERE a.sales_order_line_id=l.id),0) AS needed
      FROM sales_order_lines l WHERE l.id=$1`, [peg.sales_order_line_id]);
    const availability = await client.query(`SELECT COALESCE(b.on_hand,0)-COALESCE((SELECT SUM(a.quantity)
        FROM sales_order_allocations a JOIN sales_order_lines l ON l.id=a.sales_order_line_id
        WHERE a.workspace_id=b.workspace_id AND a.location_id=b.location_id AND l.sku_id=b.sku_id),0) AS available
      FROM balances b WHERE b.workspace_id=$1 AND b.sku_id=$2 AND b.location_id=$3 FOR UPDATE`,
    [ctx.workspaceId, peg.sku_id, destinationLocationId]);
    const quantity = Math.min(Number(peg.quantity), Math.max(0, Number(needResult.rows[0]?.needed || 0)),
      Math.max(0, Number(availability.rows[0]?.available || 0)));
    if (quantity > 0) {
      await client.query(`INSERT INTO sales_order_allocations
        (id,workspace_id,sales_order_line_id,location_id,quantity,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$6)
        ON CONFLICT(sales_order_line_id,location_id) DO UPDATE SET quantity=sales_order_allocations.quantity+EXCLUDED.quantity,
          updated_at=EXCLUDED.updated_at`,
      [newId('soa'), ctx.workspaceId, peg.sales_order_line_id, destinationLocationId, quantity, nowIso()]);
      orderIds.add(peg.sales_order_id);
    }
  }
  for (const orderId of orderIds) {
    const shortage = await client.query(`SELECT COUNT(*) FILTER (WHERE l.quantity_ordered-l.quantity_fulfilled>
        COALESCE((SELECT SUM(a.quantity) FROM sales_order_allocations a WHERE a.sales_order_line_id=l.id),0)) AS shortage,
        SUM(l.quantity_fulfilled) AS fulfilled FROM sales_order_lines l WHERE l.sales_order_id=$1 AND l.workspace_id=$2`,
    [orderId, ctx.workspaceId]);
    const state = shortage.rows[0];
    const status = Number(state.fulfilled) > 0 ? 'PARTIALLY_FULFILLED' : Number(state.shortage) > 0 ? 'BACKORDERED' : 'CONFIRMED';
    await client.query(`UPDATE sales_orders SET status=$3,updated_at=$4,version=version+1
      WHERE id=$1 AND workspace_id=$2 AND status<>'CANCELLED'`, [orderId, ctx.workspaceId, status, nowIso()]);
  }
}

async function receiveInTransaction(client, rawContext, transferId, input = {}) {
  const ctx = requireContext(rawContext);
  const key = eventKey(input, 'receive', transferId);
  await requirePermission(client, ctx, permissions.RECEIVE_TRANSFER, 'receive an inventory transfer');
  if (!Array.isArray(input.lines) || !input.lines.length) throw new ValidationError('Record what arrived, was lost, or was damaged.');
  const hasDifference = input.lines.some((line) => Number(line.lost || 0) > 0 || Number(line.damaged || 0) > 0);
  if (hasDifference) await requirePermission(client, ctx, permissions.ADJUST, 'record transfer loss or damage');
  await lockKey(client, ctx.workspaceId, key);
  const replay = await eventByKey(client, ctx.workspaceId, key);
  if (replay) return { ...(await get(client, ctx.workspaceId, replay.transfer_id)), replayed: true };
  const transfer = await get(client, ctx.workspaceId, transferId, { lock: true });
  if (!RECEIVABLE.includes(transfer.status)) throw new ValidationError('This transfer is not waiting to be received.');
  const event = await addEvent(client, ctx, transferId, 'RECEIPT_RECORDED', { lines: input.lines }, key);
  for (const supplied of input.lines) {
    const line = transfer.lines.find((candidate) => candidate.id === supplied.lineId);
    if (!line) throw new ValidationError('One receipt line is not part of this transfer.');
    const good = outcomeInteger(supplied.received, 'Received quantity');
    const lost = outcomeInteger(supplied.lost, 'Lost quantity');
    const damaged = outcomeInteger(supplied.damaged, 'Damaged quantity');
    if (good + lost + damaged <= 0) throw new ValidationError('Record at least one received, lost, or damaged unit.');
    if (good + lost + damaged > Number(line.in_transit_quantity)) {
      throw new ValidationError(`That would over-receive ${line.item_name}. Only ${line.in_transit_quantity} remain in transit.`);
    }
    let serialGood = [];
    let serialLost = [];
    let serialDamaged = [];
    if (line.tracking_mode === 'serial') {
      serialGood = [...new Set((supplied.receivedSerialUnitIds || []).map(String))];
      serialLost = [...new Set((supplied.lostSerialUnitIds || []).map(String))];
      serialDamaged = [...new Set((supplied.damagedSerialUnitIds || []).map(String))];
      const all = [...serialGood, ...serialLost, ...serialDamaged];
      const valid = new Set(line.serials.filter((serial) => serial.state === 'IN_TRANSIT').map((serial) => serial.serial_unit_id));
      if (new Set(all).size !== all.length || serialGood.length !== good || serialLost.length !== lost
        || serialDamaged.length !== damaged || all.some((id) => !valid.has(id))) {
        throw new ValidationError('Name each serialized unit exactly once in the outcome where it belongs.');
      }
    }
    const settledBefore = Number(line.received_quantity) + Number(line.lost_quantity) + Number(line.damaged_quantity);
    if (good > 0) {
      const physical = await inventory.receiveTransferInTransaction(client, ctx, {
        groupId: `transfer:${transferId}:${line.id}`, skuId: line.sku_id,
        sourceLocationId: transfer.source_location_id, destinationLocationId: transfer.destination_location_id,
        quantity: good, lotId: line.lot_id, serialUnitIds: serialGood,
        reference: transfer.transfer_number, notes: `Received ${transfer.transfer_number}`,
        idempotencyKey: `${key}:line:${line.id}:received`,
      });
      const receivedCost = line.cost_status === 'RECORDED'
        ? Math.round(Number(line.dispatched_cost_minor) * (settledBefore + good) / Number(line.shipped_quantity))
          - Math.round(Number(line.dispatched_cost_minor) * settledBefore / Number(line.shipped_quantity)) : 0;
      const posted = await postTransitJournal(client, ctx, transfer, line, event.id, receivedCost, 'receipt');
      if (line.cost_status === 'RECORDED') await costing.receiveInTransaction(client, ctx, {
        movementId: physical.movementId, totalCostMinor: receivedCost, journalEntryId: posted?.entry.id || null,
        sourceType: 'inventory_transfer_receipt', sourceRecordId: line.id,
      });
      await client.query(`UPDATE inventory_transfer_lines SET received_quantity=received_quantity+$2,
        received_cost_minor=received_cost_minor+$3,updated_at=$4 WHERE id=$1`,
      [line.id, good, receivedCost, nowIso()]);
      await client.query(`INSERT INTO inventory_transfer_movement_links
        (workspace_id,transfer_line_id,movement_id,role,event_id,created_at)
        VALUES($1,$2,$3,'RECEIPT',$4,$5)`, [ctx.workspaceId, line.id, physical.movementId, event.id, nowIso()]);
    }
    if (lost + damaged > 0) {
      const lossCost = line.cost_status === 'RECORDED'
        ? Math.round(Number(line.dispatched_cost_minor) * (settledBefore + good + lost + damaged) / Number(line.shipped_quantity))
          - Math.round(Number(line.dispatched_cost_minor) * (settledBefore + good) / Number(line.shipped_quantity)) : 0;
      await postTransitJournal(client, ctx, transfer, line, event.id, lossCost, 'writeoff');
      await client.query(`UPDATE inventory_transfer_lines SET lost_quantity=lost_quantity+$2,
        damaged_quantity=damaged_quantity+$3,written_off_cost_minor=written_off_cost_minor+$4,updated_at=$5 WHERE id=$1`,
      [line.id, lost, damaged, lossCost, nowIso()]);
    }
    for (const [state, ids] of [['RECEIVED', serialGood], ['LOST', serialLost], ['DAMAGED', serialDamaged]]) {
      if (!ids.length) continue;
      await client.query(`UPDATE inventory_transfer_serials SET state=$3,updated_at=$4
        WHERE transfer_line_id=$1 AND serial_unit_id=ANY($2::text[])`, [line.id, ids, state, nowIso()]);
      if (state === 'DAMAGED') await client.query(`UPDATE serial_units SET condition='damaged',note=$3,updated_at=$4
        WHERE workspace_id=$1 AND id=ANY($2::text[])`, [ctx.workspaceId, ids, `Damaged in ${transfer.transfer_number}`, nowIso()]);
    }
  }
  const remaining = await client.query(`SELECT COALESCE(SUM(
      shipped_quantity-received_quantity-lost_quantity-damaged_quantity),0) AS quantity
    FROM inventory_transfer_lines WHERE transfer_id=$1`, [transferId]);
  const status = Number(remaining.rows[0].quantity) === 0 ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
  const at = nowIso();
  await client.query(`UPDATE inventory_transfers SET status=$3,received_by_user_id=$4,
    received_at=CASE WHEN $3='RECEIVED' THEN $5 ELSE received_at END,updated_at=$5,version=version+1
    WHERE id=$1 AND workspace_id=$2`, [transferId, ctx.workspaceId, status, ctx.actorId, at]);
  await reconcilePegs(client, ctx, transferId, transfer.destination_location_id);
  return { ...(await get(client, ctx.workspaceId, transferId)), replayed: false };
}

function receive(database, ctx, transferId, input) {
  return database.transaction((client) => receiveInTransaction(client, ctx, transferId, input),
    { isolation: 'READ COMMITTED', retrySafe: true });
}

async function cancelInTransaction(client, rawContext, transferId, input = {}) {
  const ctx = requireContext(rawContext);
  const key = eventKey(input, 'cancel', transferId);
  await requirePermission(client, ctx, permissions.APPROVE_TRANSFER, 'cancel an inventory transfer');
  await lockKey(client, ctx.workspaceId, key);
  const replay = await eventByKey(client, ctx.workspaceId, key);
  if (replay) return { ...(await get(client, ctx.workspaceId, replay.transfer_id)), replayed: true };
  const transfer = await get(client, ctx.workspaceId, transferId, { lock: true });
  if (!['REQUESTED', 'APPROVED', 'PICKED'].includes(transfer.status)) {
    throw new ValidationError('A dispatched transfer cannot be cancelled; record receipt, loss, or damage to settle its custody.');
  }
  const at = nowIso();
  await client.query(`UPDATE inventory_transfer_lines SET cancelled_quantity=requested_quantity-shipped_quantity,
    updated_at=$2 WHERE transfer_id=$1`, [transferId, at]);
  await client.query(`UPDATE inventory_transfer_serials SET state='CANCELLED',updated_at=$2
    WHERE transfer_line_id IN (SELECT id FROM inventory_transfer_lines WHERE transfer_id=$1)`, [transferId, at]);
  await client.query(`UPDATE inventory_transfers SET status='CANCELLED',cancelled_by_user_id=$3,cancelled_at=$4,
    updated_at=$4,version=version+1 WHERE id=$1 AND workspace_id=$2`, [transferId, ctx.workspaceId, ctx.actorId, at]);
  await addEvent(client, ctx, transferId, 'CANCELLED', { reason: trimOrNull(input.reason) }, key);
  return { ...(await get(client, ctx.workspaceId, transferId)), replayed: false };
}

function cancel(database, ctx, transferId, input) {
  return database.transaction((client) => cancelInTransaction(client, ctx, transferId, input),
    { isolation: 'READ COMMITTED', retrySafe: true });
}

async function verify(database, workspaceId, transferId) {
  const transfer = await get(database, workspaceId, transferId);
  const problems = [];
  for (const line of transfer.lines) {
    if (line.in_transit_quantity < 0) problems.push(`${line.item_name} has negative transfer custody.`);
    const movements = await database.query(`SELECT ml.role,COALESCE(SUM(ABS(m.quantity_delta)),0) AS quantity
      FROM inventory_transfer_movement_links ml JOIN movements m ON m.id=ml.movement_id
      WHERE ml.transfer_line_id=$1 GROUP BY ml.role`, [line.id]);
    const byRole = Object.fromEntries(movements.rows.map((row) => [row.role, Number(row.quantity)]));
    if (Number(byRole.DISPATCH || 0) !== Number(line.shipped_quantity)) problems.push(`${line.item_name} dispatch movements do not reconcile.`);
    if (Number(byRole.RECEIPT || 0) !== Number(line.received_quantity)) problems.push(`${line.item_name} receipt movements do not reconcile.`);
    if (line.cost_status === 'RECORDED'
      && Number(line.received_cost_minor) + Number(line.written_off_cost_minor) > Number(line.dispatched_cost_minor)) {
      problems.push(`${line.item_name} transfer cost is over-settled.`);
    }
  }
  if (transfer.status === 'RECEIVED' && transfer.totals.inTransit !== 0) problems.push('A received transfer still has inventory in custody.');
  return { ok: problems.length === 0, problems, transfer };
}

async function incomingForSku(database, workspaceId, skuId, { locationId = null } = {}) {
  const values = [workspaceId, skuId];
  let filter = '';
  if (locationId) { values.push(locationId); filter = ` AND t.destination_location_id=$${values.length}`; }
  return (await database.query(`SELECT t.id AS "transferId",t.transfer_number AS "transferNumber",
      t.expected_arrival_date AS "expectedDate",t.destination_location_id AS "destinationLocationId",
      src.name AS "sourceName",tl.shipped_quantity-tl.received_quantity-tl.lost_quantity-tl.damaged_quantity AS units
    FROM inventory_transfer_lines tl JOIN inventory_transfers t ON t.id=tl.transfer_id
    JOIN locations src ON src.id=t.source_location_id WHERE tl.workspace_id=$1 AND tl.sku_id=$2
      AND t.status IN ('SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED')
      AND tl.shipped_quantity-tl.received_quantity-tl.lost_quantity-tl.damaged_quantity>0${filter}
    ORDER BY t.expected_arrival_date NULLS LAST,t.created_at`, values)).rows;
}

module.exports = { OPEN, request, requestInTransaction, approve, approveInTransaction, pick, pickInTransaction,
  dispatch, dispatchInTransaction, markInTransit, markInTransitInTransaction, receive, receiveInTransaction,
  cancel, cancelInTransaction, get, list, sourceAvailable, incomingForSku, verify };

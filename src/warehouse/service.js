'use strict';

const { inTransaction } = require('../db');
const engine = require('../domain/inventory-engine');
const repo = require('../domain/repository');
const { ValidationError, InvariantError, NotFoundError } = require('../domain/errors');
const { newId, nowIso, requireText, requirePositiveInt, requireOneOf, trimOrNull } = require('../lib/util');

const TASK_TYPES = ['RECEIVE', 'PUTAWAY', 'PICK', 'COUNT', 'TRANSFER'];
const CONTAINER_KINDS = ['tote', 'carton', 'pallet', 'package', 'other'];
const TARGET_KINDS = ['sku', 'location', 'lot', 'serial', 'container'];

function nativeCandidates(db, workspaceId, barcode, { kind = null, skuId = null } = {}) {
  const value = requireText(barcode, 'Barcode', { max: 160 });
  const candidates = [];
  const wants = (name) => !kind || kind === name;
  if (wants('sku')) {
    for (const row of db.prepare(`SELECT id, code, barcode FROM skus
      WHERE workspace_id = ? AND is_active = 1
        AND (code = ? COLLATE NOCASE OR barcode = ? COLLATE NOCASE)`).all(workspaceId, value, value)) {
      candidates.push({ kind: 'sku', id: row.id, label: row.code });
    }
  }
  if (wants('location')) {
    for (const row of db.prepare(`SELECT id, name, barcode FROM locations
      WHERE workspace_id = ? AND is_active = 1 AND barcode = ? COLLATE NOCASE`).all(workspaceId, value)) {
      candidates.push({ kind: 'location', id: row.id, label: row.name });
    }
  }
  if (wants('lot')) {
    const rows = skuId
      ? db.prepare(`SELECT id, code FROM lots WHERE workspace_id = ? AND sku_id = ? AND code = ? COLLATE NOCASE`)
        .all(workspaceId, skuId, value)
      : db.prepare(`SELECT id, code FROM lots WHERE workspace_id = ? AND code = ? COLLATE NOCASE`)
        .all(workspaceId, value);
    for (const row of rows) candidates.push({ kind: 'lot', id: row.id, label: row.code });
  }
  if (wants('serial')) {
    const rows = skuId
      ? db.prepare(`SELECT id, serial FROM serial_units
          WHERE workspace_id = ? AND sku_id = ? AND serial = ? COLLATE NOCASE AND status = 'in_stock'`)
        .all(workspaceId, skuId, value)
      : db.prepare(`SELECT id, serial FROM serial_units
          WHERE workspace_id = ? AND serial = ? COLLATE NOCASE AND status = 'in_stock'`)
        .all(workspaceId, value);
    for (const row of rows) candidates.push({ kind: 'serial', id: row.id, label: row.serial });
  }
  if (wants('container')) {
    for (const row of db.prepare(`SELECT id, code FROM warehouse_containers
      WHERE workspace_id = ? AND status <> 'VOID'
        AND (barcode = ? COLLATE NOCASE OR code = ? COLLATE NOCASE)`).all(workspaceId, value, value)) {
      candidates.push({ kind: 'container', id: row.id, label: row.code });
    }
  }
  return candidates;
}

function resolveIdentity(db, workspaceId, barcode, options = {}) {
  const value = requireText(barcode, options.label || 'Barcode', { max: 160 });
  const candidates = nativeCandidates(db, workspaceId, value, options);
  const alias = db.prepare(`SELECT target_kind AS kind, target_id AS id, COALESCE(label, barcode) AS label
      FROM warehouse_barcode_aliases WHERE workspace_id = ? AND barcode = ? COLLATE NOCASE`)
    .get(workspaceId, value);
  if (alias && (!options.kind || alias.kind === options.kind)) candidates.push(alias);
  const unique = [...new Map(candidates.map((entry) => [`${entry.kind}:${entry.id}`, entry])).values()];
  if (!unique.length) throw new NotFoundError(`${options.label || 'Barcode'} ${value} is not known in this inventory.`);
  if (unique.length > 1) throw new ValidationError(`${options.label || 'Barcode'} ${value} matches more than one record. Add a unique barcode alias before scanning it.`);
  return unique[0];
}

function requireTarget(db, workspaceId, kind, id) {
  if (kind === 'sku') return repo.requireSku(db, workspaceId, id);
  if (kind === 'location') return repo.requireLocation(db, workspaceId, id);
  if (kind === 'lot') return repo.requireLot(db, workspaceId, id);
  if (kind === 'serial') return repo.requireSerialUnit(db, workspaceId, id);
  if (kind === 'container') {
    const row = db.prepare('SELECT * FROM warehouse_containers WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
    if (!row) throw new NotFoundError('That container could not be found.');
    return row;
  }
  throw new ValidationError('That barcode target is not supported.');
}

function createAlias(db, ctx, input) {
  const barcode = requireText(input.barcode, 'Barcode alias', { max: 160 });
  const targetKind = requireOneOf(input.targetKind, TARGET_KINDS, 'Barcode target');
  requireTarget(db, ctx.workspaceId, targetKind, requireText(input.targetId, 'Target'));
  const occupied = resolveIdentityIfAny(db, ctx.workspaceId, barcode);
  if (occupied) throw new ValidationError(`Barcode ${barcode} already identifies ${occupied.label}.`, { field: 'barcode' });
  const id = newId('wba');
  db.prepare(`INSERT INTO warehouse_barcode_aliases
    (id, workspace_id, barcode, target_kind, target_id, label, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, barcode, targetKind, input.targetId, trimOrNull(input.label), ctx.actorId, nowIso());
  return db.prepare('SELECT * FROM warehouse_barcode_aliases WHERE id = ?').get(id);
}

function resolveIdentityIfAny(db, workspaceId, barcode) {
  try { return resolveIdentity(db, workspaceId, barcode); }
  catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

function createContainer(db, ctx, input) {
  const code = requireText(input.code, 'Container code', { max: 80 });
  const barcode = requireText(input.barcode || code, 'Container barcode', { max: 160 });
  const kind = requireOneOf(input.kind || 'tote', CONTAINER_KINDS, 'Container type');
  const location = input.locationId ? repo.requireLocation(db, ctx.workspaceId, input.locationId) : null;
  const occupied = resolveIdentityIfAny(db, ctx.workspaceId, barcode);
  if (occupied) throw new ValidationError(`Barcode ${barcode} already identifies ${occupied.label}.`, { field: 'barcode' });
  const id = newId('cnt');
  const now = nowIso();
  db.prepare(`INSERT INTO warehouse_containers
    (id, workspace_id, code, barcode, kind, status, location_id, note,
     created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, code, barcode, kind, location ? location.id : null,
      trimOrNull(input.note), ctx.actorId, now, now);
  return requireTarget(db, ctx.workspaceId, 'container', id);
}

function createPutawayRule(db, ctx, input) {
  const sku = input.skuId ? repo.requireSku(db, ctx.workspaceId, input.skuId) : null;
  const from = input.fromLocationId ? repo.requireLocation(db, ctx.workspaceId, input.fromLocationId) : null;
  const destination = repo.requireLocation(db, ctx.workspaceId,
    requireText(input.destinationLocationId, 'Destination location'));
  if (!destination.is_active) throw new ValidationError(`${destination.name} is archived.`);
  const priority = input.priority === undefined || input.priority === '' ? 100 : Number(input.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 999999) {
    throw new ValidationError('Priority must be a whole number from 0 to 999999.');
  }
  const id = newId('pwr');
  db.prepare(`INSERT INTO warehouse_putaway_rules
    (id, workspace_id, sku_id, from_location_id, destination_location_id,
     priority, is_active, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(id, ctx.workspaceId, sku ? sku.id : null, from ? from.id : null,
      destination.id, priority, ctx.actorId, nowIso());
  return db.prepare('SELECT * FROM warehouse_putaway_rules WHERE id = ?').get(id);
}

function putawayDestination(db, workspaceId, skuId, fromLocationId) {
  return db.prepare(`SELECT r.*, l.name AS destination_name
      FROM warehouse_putaway_rules r
      JOIN locations l ON l.id = r.destination_location_id AND l.workspace_id = r.workspace_id
     WHERE r.workspace_id = ? AND r.is_active = 1
       AND (r.sku_id = ? OR r.sku_id IS NULL)
       AND (r.from_location_id = ? OR r.from_location_id IS NULL)
     ORDER BY (r.sku_id IS NOT NULL) DESC, (r.from_location_id IS NOT NULL) DESC, r.priority, r.created_at
     LIMIT 1`).get(workspaceId, skuId, fromLocationId) || null;
}

function nextTaskNumber(db, workspaceId) {
  return Number(db.prepare('SELECT COALESCE(MAX(task_number), 0) + 1 AS n FROM warehouse_tasks WHERE workspace_id = ?')
    .get(workspaceId).n);
}

function createTask(db, ctx, input) {
  return inTransaction(db, () => {
    const taskType = requireOneOf(String(input.taskType || '').toUpperCase(), TASK_TYPES, 'Warehouse task type');
    const rawLines = Array.isArray(input.lines) ? input.lines : [];
    if (!rawLines.length) throw new ValidationError('Add at least one task line.');
    const container = input.containerId ? requireTarget(db, ctx.workspaceId, 'container', input.containerId) : null;
    const now = nowIso();
    const taskNumber = nextTaskNumber(db, ctx.workspaceId);
    const id = newId('wht');
    const title = trimOrNull(input.title) || `${taskType.charAt(0)}${taskType.slice(1).toLowerCase()} task ${taskNumber}`;
    db.prepare(`INSERT INTO warehouse_tasks
      (id, workspace_id, task_number, task_type, status, title, reference, container_id,
       assigned_user_id, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ctx.workspaceId, taskNumber, taskType, title, trimOrNull(input.reference),
        container ? container.id : null, trimOrNull(input.assignedUserId), ctx.actorId, now, now);

    rawLines.forEach((raw, position) => {
      const sku = repo.requireSku(db, ctx.workspaceId, raw.skuId);
      const from = raw.fromLocationId ? repo.requireLocation(db, ctx.workspaceId, raw.fromLocationId) : null;
      let to = raw.toLocationId ? repo.requireLocation(db, ctx.workspaceId, raw.toLocationId) : null;
      if (taskType === 'PUTAWAY' && !to && from) {
        const rule = putawayDestination(db, ctx.workspaceId, sku.id, from.id);
        if (rule) to = repo.requireLocation(db, ctx.workspaceId, rule.destination_location_id);
      }
      validateTaskLocations(taskType, from, to);
      const lot = raw.lotId ? repo.requireLot(db, ctx.workspaceId, raw.lotId) : null;
      if (lot && lot.sku_id !== sku.id) throw new ValidationError('That lot belongs to a different item.');
      if (taskType === 'COUNT' && sku.tracking_mode === 'lot' && !lot) {
        throw new ValidationError('A lot-tracked count must name the exact lot. StockChief will not combine or infer lots.');
      }
      const quantity = requirePositiveInt(raw.quantity, 'Task quantity');
      db.prepare(`INSERT INTO warehouse_task_lines
        (id, workspace_id, task_id, position, sku_id, from_location_id, to_location_id,
         lot_id, planned_quantity, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId('wtl'), ctx.workspaceId, id, position, sku.id, from ? from.id : null,
          to ? to.id : null, lot ? lot.id : null, quantity, now, now);
    });
    return getTask(db, ctx.workspaceId, id);
  });
}

function validateTaskLocations(type, from, to) {
  if (type === 'RECEIVE' && !to) throw new ValidationError('Receiving needs a destination location.');
  if (type === 'COUNT' && !from) throw new ValidationError('Counting needs a location.');
  if (['PUTAWAY', 'PICK', 'TRANSFER'].includes(type) && (!from || !to)) {
    throw new ValidationError(`${type === 'PICK' ? 'Picking' : 'Moving stock'} needs a source and destination.`);
  }
  if (from && to && from.id === to.id) throw new ValidationError('Source and destination must be different.');
  if ((from && !from.is_active) || (to && !to.is_active)) throw new ValidationError('Archived locations cannot be used for warehouse work.');
}

function getTask(db, workspaceId, taskId) {
  const task = db.prepare(`SELECT t.*, c.code AS container_code
    FROM warehouse_tasks t LEFT JOIN warehouse_containers c ON c.id = t.container_id
    WHERE t.workspace_id = ? AND t.id = ?`).get(workspaceId, taskId);
  if (!task) throw new NotFoundError('That warehouse task could not be found.');
  task.lines = db.prepare(`SELECT l.*, s.code AS sku_code, s.variant_label, i.name AS item_name,
      i.tracking_mode, src.name AS from_name, dst.name AS to_name, lots.code AS lot_code
    FROM warehouse_task_lines l
    JOIN skus s ON s.id = l.sku_id AND s.workspace_id = l.workspace_id
    JOIN items i ON i.id = s.item_id AND i.workspace_id = l.workspace_id
    LEFT JOIN locations src ON src.id = l.from_location_id
    LEFT JOIN locations dst ON dst.id = l.to_location_id
    LEFT JOIN lots ON lots.id = l.lot_id
    WHERE l.workspace_id = ? AND l.task_id = ? ORDER BY l.position`)
    .all(workspaceId, taskId);
  task.scans = db.prepare(`SELECT * FROM warehouse_scan_events
    WHERE workspace_id = ? AND task_id = ? ORDER BY seq DESC LIMIT 50`).all(workspaceId, taskId)
    .map(hydrateScan);
  return task;
}

function listTasks(db, workspaceId, { status = null } = {}) {
  const rows = status
    ? db.prepare(`SELECT * FROM warehouse_tasks WHERE workspace_id = ? AND status = ? ORDER BY created_at`).all(workspaceId, status)
    : db.prepare(`SELECT * FROM warehouse_tasks WHERE workspace_id = ? ORDER BY
        CASE status WHEN 'IN_PROGRESS' THEN 0 WHEN 'OPEN' THEN 1 WHEN 'PAUSED' THEN 2 ELSE 3 END,
        created_at DESC`).all(workspaceId);
  return rows.map((task) => ({ ...task,
    lines: db.prepare(`SELECT COUNT(*) AS line_count, COALESCE(SUM(planned_quantity),0) AS planned,
      COALESCE(SUM(processed_quantity),0) AS processed FROM warehouse_task_lines WHERE task_id = ?`).get(task.id) }));
}

function hydrateScan(row) {
  if (!row) return null;
  let movementIds = [];
  try { movementIds = JSON.parse(row.movement_ids_json || '[]'); } catch { movementIds = []; }
  return { ...row, movementIds, accepted: row.status === 'ACCEPTED' };
}

function expectedLocationId(taskType, line) {
  return taskType === 'RECEIVE' ? line.to_location_id : line.from_location_id;
}

function scanTask(db, ctx, input) {
  return inTransaction(db, () => {
    const clientScanId = requireText(input.clientScanId, 'Scan ID', { max: 160 });
    const prior = db.prepare(`SELECT * FROM warehouse_scan_events
      WHERE workspace_id = ? AND client_scan_id = ?`).get(ctx.workspaceId, clientScanId);
    if (prior) return { ...hydrateScan(prior), duplicate: true };
    const task = getTask(db, ctx.workspaceId, input.taskId);
    const scanBase = { taskId: task.id, clientScanId, deviceId: trimOrNull(input.deviceId),
      locationBarcode: trimOrNull(input.locationBarcode), itemBarcode: trimOrNull(input.itemBarcode),
      lotBarcode: trimOrNull(input.lotBarcode), serialBarcode: trimOrNull(input.serialBarcode) };
    try {
      if (!['OPEN', 'IN_PROGRESS'].includes(task.status)) {
        throw new InvariantError(`This task is ${task.status.toLowerCase()} and cannot accept scans.`, 'warehouse_task_not_active');
      }
      const quantity = requirePositiveInt(input.quantity || 1, 'Scan quantity');
      const location = resolveIdentity(db, ctx.workspaceId, input.locationBarcode,
        { kind: 'location', label: 'Location barcode' });
      const sku = resolveIdentity(db, ctx.workspaceId, input.itemBarcode,
        { kind: 'sku', label: 'Product barcode' });
      const line = task.lines.find((candidate) => candidate.sku_id === sku.id
        && expectedLocationId(task.task_type, candidate) === location.id
        && (task.task_type === 'COUNT' || candidate.processed_quantity < candidate.planned_quantity));
      if (!line) {
        const expected = task.lines.filter((candidate) => candidate.sku_id === sku.id)
          .map((candidate) => candidate.from_name || candidate.to_name).filter(Boolean);
        if (expected.length) throw new ValidationError(`That product belongs at ${expected.join(' or ')} for this task, not the scanned location.`);
        throw new ValidationError('That product is not on this task. Nothing was moved.');
      }
      if (line.tracking_mode === 'serial' && quantity !== 1) {
        throw new ValidationError('Scan one serial number at a time. Nothing was moved.');
      }
      const remaining = line.planned_quantity - line.processed_quantity;
      if (task.task_type !== 'COUNT' && quantity > remaining) {
        throw new ValidationError(`Only ${remaining} remain on this task line. Nothing was moved.`);
      }
      const identity = scanTrackingIdentity(db, ctx.workspaceId, line, task.task_type, input);
      if (task.task_type === 'COUNT' && line.tracking_mode === 'serial') {
        const alreadyCounted = db.prepare(`SELECT 1 FROM warehouse_scan_events
          WHERE workspace_id = ? AND task_id = ? AND task_line_id = ? AND status = 'ACCEPTED'
            AND serial_barcode = ? COLLATE NOCASE LIMIT 1`)
          .get(ctx.workspaceId, task.id, line.id, input.serialBarcode);
        if (alreadyCounted) throw new ValidationError('That serial was already counted on this task. Nothing was added.');
      }
      const result = applyScanOperation(db, ctx, task, line, identity, quantity);
      const now = nowIso();
      if (task.task_type === 'COUNT') {
        db.prepare(`UPDATE warehouse_task_lines SET counted_quantity = counted_quantity + ?,
          status = 'IN_PROGRESS', last_error = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`)
          .run(quantity, now, line.id, ctx.workspaceId);
      } else {
        db.prepare(`UPDATE warehouse_task_lines SET processed_quantity = processed_quantity + ?,
          status = CASE WHEN processed_quantity + ? >= planned_quantity THEN 'COMPLETED' ELSE 'IN_PROGRESS' END,
          last_error = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`)
          .run(quantity, quantity, now, line.id, ctx.workspaceId);
      }
      db.prepare(`UPDATE warehouse_tasks SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, ?),
        updated_at = ? WHERE id = ? AND workspace_id = ?`).run(now, now, task.id, ctx.workspaceId);
      addContainerContents(db, ctx.workspaceId, task, line, identity, quantity, now);
      if (task.task_type !== 'COUNT') completeIfDone(db, ctx.workspaceId, task.id, now);
      return recordScan(db, ctx, { ...scanBase, taskLineId: line.id, quantity,
        status: 'ACCEPTED', message: result.message, movementGroupId: result.groupId,
        movementIds: result.movementIds || [] });
    } catch (error) {
      if (!error.status || error.status >= 500) throw error;
      return recordScan(db, ctx, { ...scanBase, quantity: Number(input.quantity) || 1,
        status: 'REJECTED', message: error.message, movementIds: [] });
    }
  });
}

function scanTrackingIdentity(db, workspaceId, line, taskType, input) {
  if (line.tracking_mode === 'serial') {
    const serial = requireText(input.serialBarcode, 'Serial number', { max: 160 });
    if (taskType === 'RECEIVE') return { serial };
    const identity = resolveIdentity(db, workspaceId, serial,
      { kind: 'serial', skuId: line.sku_id, label: 'Serial number' });
    const unit = repo.requireSerialUnit(db, workspaceId, identity.id);
    if (unit.location_id !== line.from_location_id) throw new ValidationError('That serial is not at the scanned source location. Nothing was moved.');
    return { serialUnitId: unit.id };
  }
  if (line.tracking_mode === 'lot') {
    const code = requireText(input.lotBarcode, 'Lot or batch barcode', { max: 160 });
    if (taskType === 'RECEIVE') {
      const existing = db.prepare(`SELECT id FROM lots WHERE workspace_id = ? AND sku_id = ? AND code = ? COLLATE NOCASE`)
        .get(workspaceId, line.sku_id, code);
      return existing ? { lotId: existing.id } : { lotCode: code };
    }
    const identity = resolveIdentity(db, workspaceId, code,
      { kind: 'lot', skuId: line.sku_id, label: 'Lot or batch barcode' });
    if (line.lot_id && line.lot_id !== identity.id) throw new ValidationError('That is the wrong lot for this task. Nothing was moved.');
    return { lotId: identity.id };
  }
  return {};
}

function applyScanOperation(db, ctx, task, line, identity, quantity) {
  const common = { skuId: line.sku_id, quantity, reference: task.reference || `Warehouse task ${task.task_number}` };
  if (task.task_type === 'COUNT') return { message: `Counted ${quantity}; review the total before posting.`, movementIds: [] };
  if (task.task_type === 'RECEIVE') {
    const result = engine.receive(db, ctx, { ...common, locationId: line.to_location_id,
      ...(line.tracking_mode === 'serial' ? { serials: [{ serial: identity.serial }] } : identity) });
    return { ...result, message: `Received ${quantity} into ${line.to_name}.` };
  }
  const result = engine.transfer(db, ctx, { ...common, fromLocationId: line.from_location_id,
    toLocationId: line.to_location_id,
    ...(line.tracking_mode === 'serial' ? { serialUnitIds: [identity.serialUnitId] } : identity) });
  return { ...result, message: `Moved ${quantity} from ${line.from_name} to ${line.to_name}.` };
}

function addContainerContents(db, workspaceId, task, line, identity, quantity, now) {
  if (!task.container_id || !['PICK', 'PUTAWAY', 'TRANSFER'].includes(task.task_type)) return;
  const identityKey = identity.serialUnitId ? `serial:${identity.serialUnitId}`
    : identity.lotId ? `lot:${line.sku_id}:${identity.lotId}` : `sku:${line.sku_id}`;
  db.prepare(`INSERT INTO warehouse_container_contents
    (container_id, workspace_id, identity_key, sku_id, lot_id, serial_unit_id, quantity, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(container_id, identity_key) DO UPDATE SET quantity = quantity + excluded.quantity`)
    .run(task.container_id, workspaceId, identityKey, line.sku_id, identity.lotId || null,
      identity.serialUnitId || null, quantity, now);
  db.prepare('UPDATE warehouse_containers SET location_id = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(line.to_location_id, now, task.container_id, workspaceId);
}

function completeIfDone(db, workspaceId, taskId, now) {
  const open = db.prepare(`SELECT COUNT(*) AS n FROM warehouse_task_lines
    WHERE workspace_id = ? AND task_id = ? AND status <> 'COMPLETED'`).get(workspaceId, taskId).n;
  if (!open) db.prepare(`UPDATE warehouse_tasks SET status = 'COMPLETED', completed_at = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(now, now, workspaceId, taskId);
}

function recordScan(db, ctx, input) {
  const id = newId('wse');
  const now = nowIso();
  db.prepare(`INSERT INTO warehouse_scan_events
    (id, workspace_id, task_id, task_line_id, client_scan_id, device_id,
     location_barcode, item_barcode, lot_barcode, serial_barcode, quantity,
     status, message, movement_group_id, movement_ids_json, actor_user_id, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, input.taskId, input.taskLineId || null, input.clientScanId,
      input.deviceId, input.locationBarcode, input.itemBarcode, input.lotBarcode,
      input.serialBarcode, input.quantity, input.status, input.message,
      input.movementGroupId || null, JSON.stringify(input.movementIds || []), ctx.actorId, now);
  return hydrateScan(db.prepare('SELECT * FROM warehouse_scan_events WHERE id = ?').get(id));
}

function finishCount(db, ctx, taskId, input = {}) {
  return inTransaction(db, () => {
    const task = getTask(db, ctx.workspaceId, taskId);
    if (task.task_type !== 'COUNT') throw new ValidationError('Only a count task can post a counted result.');
    if (task.status === 'COMPLETED') return task;
    if (task.status === 'CANCELLED') throw new ValidationError('A cancelled task cannot be posted.');
    const noScans = task.lines.every((line) => Number(line.counted_quantity) === 0);
    if (noScans && !input.confirmEmpty) {
      throw new ValidationError('Nothing has been counted. Confirm that every task location is physically empty before posting zero.');
    }
    for (const line of task.lines) {
      const expected = line.tracking_mode === 'lot'
        ? repo.getLotBalance(db, ctx.workspaceId, line.lot_id, line.from_location_id)
        : repo.getBalance(db, ctx.workspaceId, line.sku_id, line.from_location_id);
      if (line.tracking_mode === 'serial') {
        const expectedSerials = db.prepare(`SELECT serial FROM serial_units
          WHERE workspace_id = ? AND sku_id = ? AND location_id = ? AND status = 'in_stock' ORDER BY serial`)
          .all(ctx.workspaceId, line.sku_id, line.from_location_id)
          .map((row) => row.serial.toLowerCase()).sort();
        const scannedSerials = db.prepare(`SELECT serial_barcode FROM warehouse_scan_events
          WHERE workspace_id = ? AND task_id = ? AND task_line_id = ? AND status = 'ACCEPTED' ORDER BY serial_barcode`)
          .all(ctx.workspaceId, task.id, line.id)
          .map((row) => String(row.serial_barcode).toLowerCase()).sort();
        if (line.counted_quantity !== expected || JSON.stringify(scannedSerials) !== JSON.stringify(expectedSerials)) {
          throw new ValidationError('Serial counts must identify the missing serials before StockChief can correct stock. The count remains open.');
        }
      } else if (line.counted_quantity !== expected) {
        engine.adjust(db, ctx, { skuId: line.sku_id, locationId: line.from_location_id,
          countedQty: line.counted_quantity, reasonCode: 'physical_count',
          reference: task.reference || `Warehouse count ${task.task_number}`,
          ...(line.lot_id ? { lotId: line.lot_id } : {}) });
      }
      db.prepare(`UPDATE warehouse_task_lines SET processed_quantity = counted_quantity,
        status = 'COMPLETED', updated_at = ? WHERE id = ? AND workspace_id = ?`)
        .run(nowIso(), line.id, ctx.workspaceId);
    }
    const now = nowIso();
    db.prepare(`UPDATE warehouse_tasks SET status = 'COMPLETED', completed_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`).run(now, now, task.id, ctx.workspaceId);
    return getTask(db, ctx.workspaceId, task.id);
  });
}

function setTaskStatus(db, ctx, taskId, status) {
  const wanted = requireOneOf(String(status || '').toUpperCase(), ['IN_PROGRESS', 'PAUSED', 'CANCELLED'], 'Task status');
  const task = getTask(db, ctx.workspaceId, taskId);
  if (task.status === 'COMPLETED') throw new ValidationError('A completed task cannot be changed.');
  const now = nowIso();
  db.prepare(`UPDATE warehouse_tasks SET status = ?, started_at = CASE WHEN ? = 'IN_PROGRESS'
    THEN COALESCE(started_at, ?) ELSE started_at END, updated_at = ? WHERE id = ? AND workspace_id = ?`)
    .run(wanted, wanted, now, now, task.id, ctx.workspaceId);
  return getTask(db, ctx.workspaceId, task.id);
}

function listContainers(db, workspaceId) {
  return db.prepare(`SELECT c.*, l.name AS location_name,
    COALESCE((SELECT SUM(quantity) FROM warehouse_container_contents x WHERE x.container_id = c.id), 0) AS units
    FROM warehouse_containers c LEFT JOIN locations l ON l.id = c.location_id
    WHERE c.workspace_id = ? ORDER BY c.status, c.created_at DESC`).all(workspaceId);
}

function listRules(db, workspaceId) {
  return db.prepare(`SELECT r.*, s.code AS sku_code, i.name AS item_name,
    src.name AS from_name, dst.name AS destination_name
    FROM warehouse_putaway_rules r
    LEFT JOIN skus s ON s.id = r.sku_id LEFT JOIN items i ON i.id = s.item_id
    LEFT JOIN locations src ON src.id = r.from_location_id
    JOIN locations dst ON dst.id = r.destination_location_id
    WHERE r.workspace_id = ? ORDER BY r.priority, r.created_at`).all(workspaceId);
}

module.exports = { TASK_TYPES, CONTAINER_KINDS, TARGET_KINDS, resolveIdentity, createAlias,
  createContainer, createPutawayRule, putawayDestination, createTask, getTask, listTasks,
  scanTask, finishCount, setTaskStatus, listContainers, listRules };

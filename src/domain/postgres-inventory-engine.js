'use strict';

const { newId, nowIso } = require('../lib/util');
const { ValidationError, InsufficientStockError, InvariantError } = require('./errors');
const permissions = require('../actions/permissions');
const physicalInput=require('./physical-stock-input');

function positiveInteger(value, label = 'Quantity') {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new ValidationError(`${label} must be a whole number above zero.`);
  if(number>physicalInput.MAX_QUANTITY)throw new ValidationError(`${label} exceeds the supported maximum of ${physicalInput.MAX_QUANTITY.toLocaleString('en-US')} units per movement.`);
  return number;
}

function context(input) {
  if (!input?.workspaceId || !input?.actorId) throw new ValidationError('A workspace and an acting user are required.');
  return input;
}

async function requireActor(client, ctx) {
  const result = await client.query(`SELECT id,role,permissions FROM users WHERE id = $1 AND workspace_id = $2`,
    [ctx.actorId, ctx.workspaceId]);
  if (!result.rows.length) throw new ValidationError('The acting user does not belong to this inventory.');
  return result.rows[0];
}

async function requirePermission(client, ctx, permission, what) {
  await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'inventory.core');
  const actor = await requireActor(client, ctx);
  permissions.assertCan(actor, permission, what);
  return actor;
}

function assertActiveTarget(row){
  if (!Number(row.sku_active) || !Number(row.item_active)) throw new ValidationError('That item variant is archived.');
  if (!Number(row.location_active)) throw new ValidationError(`${row.location_name} is archived and cannot be used.`);
}

async function target(client, ctx, skuId, locationId) {
  const result = await client.query(`SELECT s.id, s.item_id, s.is_active AS sku_active,
      i.name, i.tracking_mode, i.allow_negative AS allow_negative_stock, i.is_active AS item_active,
      l.id AS location_id, l.name AS location_name, l.is_active AS location_active
    FROM skus s JOIN items i ON i.id = s.item_id AND i.workspace_id = s.workspace_id
    JOIN locations l ON l.id = $3 AND l.workspace_id = s.workspace_id
    WHERE s.id = $1 AND s.workspace_id = $2`, [skuId, ctx.workspaceId, locationId]);
  const row = result.rows[0];
  if (!row) throw new ValidationError('That item variant or location is not in this inventory.');
  if(['lot','serial'].includes(row.tracking_mode))await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'inventory.lot_serial');
  assertActiveTarget(row);
  return row;
}

async function beginOperation(client, ctx, kind, idempotencyKey) {
  if(kind.includes('transfer'))await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'inventory.transfers');
  if(kind.includes('adjust'))await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'inventory.counts');
  const key = String(idempotencyKey || newId('operation'));
  const id = newId('pgop');
  const inserted = await client.query(`INSERT INTO stockchief_runtime.business_operations
      (id, workspace_id, kind, idempotency_key) VALUES ($1, $2, $3, $4)
    ON CONFLICT (workspace_id, kind, idempotency_key) DO NOTHING RETURNING id`,
  [id, ctx.workspaceId, kind, key]);
  if (inserted.rows.length) return { id, replayed: false };
  const existing = await client.query(`SELECT id, status, result FROM stockchief_runtime.business_operations
    WHERE workspace_id = $1 AND kind = $2 AND idempotency_key = $3 FOR UPDATE`, [ctx.workspaceId, kind, key]);
  if (existing.rows[0]?.status === 'COMPLETED') return { id: existing.rows[0].id, replayed: true, result: existing.rows[0].result };
  throw new InvariantError('That inventory operation is already running.', 'operation_in_progress');
}

async function completeOperation(client, operation, result) {
  await client.query(`UPDATE stockchief_runtime.business_operations
    SET status = 'COMPLETED', result = $2::jsonb, completed_at = now() WHERE id = $1`,
  [operation.id, JSON.stringify(result)]);
}

async function balanceDelta(client, ctx, row, delta, at) {
  await client.query(`INSERT INTO balances(workspace_id, sku_id, location_id, on_hand, updated_at)
    VALUES ($1, $2, $3, 0, $4) ON CONFLICT (sku_id, location_id) DO NOTHING`,
  [ctx.workspaceId, row.id, row.location_id, at]);
  const changed = await client.query(`UPDATE balances SET on_hand = on_hand + $4, updated_at = $5
    WHERE workspace_id = $1 AND sku_id = $2 AND location_id = $3
      AND ($6 OR on_hand + $4 >= 0) RETURNING on_hand`,
  [ctx.workspaceId, row.id, row.location_id, delta, at, Boolean(Number(row.allow_negative_stock))]);
  if (!changed.rows.length) {
    const current = await client.query(`SELECT on_hand FROM balances
      WHERE workspace_id = $1 AND sku_id = $2 AND location_id = $3`, [ctx.workspaceId, row.id, row.location_id]);
    const onHand = Number(current.rows[0]?.on_hand || 0);
    throw new InsufficientStockError(`Not enough stock at ${row.location_name}. On hand: ${onHand}, requested: ${Math.abs(delta)}.`,
      { onHand, requested: Math.abs(delta) });
  }
  return Number(changed.rows[0].on_hand);
}

async function lotDelta(client, ctx, lotId, locationId, delta, at) {
  await client.query(`INSERT INTO lot_balances(workspace_id, lot_id, location_id, quantity, updated_at)
    VALUES ($1, $2, $3, 0, $4) ON CONFLICT (lot_id, location_id) DO NOTHING`,
  [ctx.workspaceId, lotId, locationId, at]);
  const changed = await client.query(`UPDATE lot_balances SET quantity = quantity + $4, updated_at = $5
    WHERE workspace_id = $1 AND lot_id = $2 AND location_id = $3 AND quantity + $4 >= 0 RETURNING quantity`,
  [ctx.workspaceId, lotId, locationId, delta, at]);
  if (!changed.rows.length) throw new InsufficientStockError('That lot does not have enough stock at this location.');
  return Number(changed.rows[0].quantity);
}

async function movement(client, ctx, row, input) {
  const id = newId('mv');
  await client.query(`INSERT INTO movements
      (id, workspace_id, group_id, operation, leg, item_id, sku_id, location_id,
       counterparty_location_id, lot_id, serial_unit_id, quantity_delta, balance_after,
       reason_code, notes, reference, actor_user_id, occurred_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
  [id, ctx.workspaceId, input.groupId, input.operation, input.leg || null, row.item_id, row.id,
    row.location_id, input.counterpartyLocationId || null, input.lotId || null, input.serialUnitId || null,
    input.quantityDelta, input.balanceAfter, input.reasonCode || null, input.notes || null,
    input.reference || null, ctx.actorId, input.occurredAt]);
  return id;
}

async function recordMovementSerials(client, ctx, movementId, serialUnitIds) {
  for (const serialUnitId of serialUnitIds || []) {
    await client.query(`INSERT INTO stockchief_runtime.inventory_movement_serial_units
      (workspace_id,movement_id,serial_unit_id) VALUES($1,$2,$3)
      ON CONFLICT(movement_id,serial_unit_id) DO NOTHING`, [ctx.workspaceId, movementId, serialUnitId]);
  }
}

async function resolveLot(client, ctx, row, input, at, create) {
  physicalInput.validate({...input,lotReceivedAt:input.lotReceivedAt||at});
  if (input.lotId) {
    const found = await client.query(`SELECT * FROM lots WHERE id = $1 AND workspace_id = $2 AND sku_id = $3 FOR UPDATE`,
      [input.lotId, ctx.workspaceId, row.id]);
    if (!found.rows.length) throw new ValidationError('That lot is not in this inventory item.');
    return found.rows[0];
  }
  if (!input.lotCode) throw new ValidationError('Lot or batch number is required.');
  const found = await client.query(`SELECT * FROM lots WHERE workspace_id = $1 AND sku_id = $2 AND code = $3 FOR UPDATE`,
    [ctx.workspaceId, row.id, String(input.lotCode)]);
  if (found.rows.length) return found.rows[0];
  if (!create) throw new ValidationError('That lot was not found.');
  const lot = { id: newId('lot'), code: String(input.lotCode) };
  await client.query(`INSERT INTO lots(id, workspace_id, sku_id, code, received_at, expires_at, note, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [lot.id, ctx.workspaceId, row.id, lot.code,
    input.lotReceivedAt || at, input.expiresAt || null, input.notes || null, at]);
  return lot;
}

async function receiveInTransaction(client, rawContext, input) {
  physicalInput.validate(input);
  const ctx = context(rawContext);
  const quantity = positiveInteger(input.quantity);
  await requirePermission(client, ctx, permissions.OPERATE, 'receive stock');
    const operation = await beginOperation(client, ctx, 'inventory.receive', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const row = await target(client, ctx, input.skuId, input.locationId);
    const at = input.occurredAt || nowIso();
    const groupId = newId('grp');
    let lot = null;
    let serials = [];
    let serialUnitIds = [];
    if (row.tracking_mode === 'lot') lot = await resolveLot(client, ctx, row, input, at, true);
    if (row.tracking_mode === 'serial') {
      const returnedIds = [...new Set((input.returnSerialUnitIds || []).map(String))];
      if (returnedIds.length) {
        if (returnedIds.length !== quantity) throw new ValidationError('Select every returned serial unit.');
        const locked = await client.query(`SELECT id,serial FROM serial_units WHERE workspace_id=$1 AND sku_id=$2
          AND status='issued' AND location_id IS NULL AND id=ANY($3::text[]) FOR UPDATE`,
        [ctx.workspaceId, row.id, returnedIds]);
        if (locked.rows.length !== quantity) {
          throw new InvariantError('One or more serial units were not issued or have already returned.', 'unit_not_issued');
        }
        await client.query(`UPDATE serial_units SET status='in_stock',location_id=$4,condition=$5,note=$6,updated_at=$7
          WHERE workspace_id=$1 AND sku_id=$2 AND id=ANY($3::text[])`,
        [ctx.workspaceId, row.id, returnedIds, row.location_id, input.returnCondition || 'unknown', input.notes || null, at]);
        serialUnitIds = returnedIds;
        serials = locked.rows.map((unit) => unit.serial);
      } else {
        serials = [...new Set((input.serials || []).map(String))];
        if (serials.length !== quantity) throw new ValidationError('Provide one unique serial number for every received unit.');
        const duplicate=await client.query(`SELECT serial FROM serial_units WHERE workspace_id=$1 AND sku_id=$2
          AND status='in_stock' AND serial=ANY($3::text[]) LIMIT 1`,[ctx.workspaceId,row.id,serials]);
        if(duplicate.rows.length)throw new ValidationError(`Serial ${duplicate.rows[0].serial} is already in stock. Use a transfer to move it between locations.`);
        for (const serial of serials) {
          const serialUnitId = newId('serial');
          const inserted=await client.query(`INSERT INTO serial_units
            (id, workspace_id, sku_id, serial, status, location_id, received_at, note, updated_at)
            VALUES ($1,$2,$3,$4,'in_stock',$5,$6,$7,$6)
            ON CONFLICT (workspace_id,sku_id,serial) WHERE status='in_stock' DO NOTHING RETURNING id`,
          [serialUnitId, ctx.workspaceId, row.id, serial, row.location_id, at, input.notes || null]);
          if(!inserted.rows.length)throw new ValidationError(`Serial ${serial} is already in stock. Use a transfer to move it between locations.`);
          serialUnitIds.push(serialUnitId);
        }
      }
    }
    const balanceAfter = await balanceDelta(client, ctx, row, quantity, at);
    if (lot) await lotDelta(client, ctx, lot.id, row.location_id, quantity, at);
    const movementId = await movement(client, ctx, row, { groupId, operation: 'receive', quantityDelta: quantity,
      balanceAfter, lotId: lot?.id, notes: input.notes, reference: input.reference, occurredAt: at });
    await recordMovementSerials(client, ctx, movementId, serialUnitIds);
    const result = { movementId, groupId, balanceAfter, quantity, lotId: lot?.id || null, serials, serialUnitIds };
    await completeOperation(client, operation, result);
  return { ...result, replayed: false };
}

async function receiveManyInTransaction(client,rawContext,inputs){
  const ctx=context(rawContext);if(!Array.isArray(inputs))throw new ValidationError('Stock receipts must be a list.');if(!inputs.length)return [];
  const values=inputs.map((input,index)=>({input:physicalInput.validate(input),index,quantity:positiveInteger(input.quantity),key:String(input.idempotencyKey||newId('operation'))}));
  await requirePermission(client,ctx,permissions.OPERATE,'receive stock');
  const keys=values.map(value=>value.key),existing=(await client.query("SELECT id FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND kind='inventory.receive' AND idempotency_key=ANY($2::text[])",[ctx.workspaceId,keys])).rows;
  async function sequential(){const out=[];for(const value of values)out.push(await receiveInTransaction(client,ctx,{...value.input,idempotencyKey:value.key}));return out;}
  if(existing.length||new Set(keys).size!==keys.length)return sequential();
  const pairs=values.map(value=>({position:value.index,sku_id:value.input.skuId,location_id:value.input.locationId}));
  const targets=(await client.query(`SELECT x.position,s.id,s.item_id,s.is_active AS sku_active,i.tracking_mode,i.allow_negative AS allow_negative_stock,i.is_active AS item_active,l.id AS location_id,l.name AS location_name,l.is_active AS location_active
   FROM jsonb_to_recordset($2::jsonb) AS x(position integer,sku_id text,location_id text) JOIN skus s ON s.id=x.sku_id AND s.workspace_id=$1 JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id JOIN locations l ON l.id=x.location_id AND l.workspace_id=s.workspace_id ORDER BY x.position`,[ctx.workspaceId,JSON.stringify(pairs)])).rows;
  if(targets.length!==values.length)throw new ValidationError('That item variant or location is not in this inventory.');
  for(const row of targets)assertActiveTarget(row);
  if(targets.some(row=>row.tracking_mode!=='quantity'))return sequential();
  const positions=[...new Map(pairs.map(row=>[JSON.stringify([row.sku_id,row.location_id]),{sku_id:row.sku_id,location_id:row.location_id}])).values()].sort((a,b)=>a.sku_id.localeCompare(b.sku_id)||a.location_id.localeCompare(b.location_id)),positionJSON=JSON.stringify(positions),at=nowIso();
  await client.query(`INSERT INTO balances(workspace_id,sku_id,location_id,on_hand,updated_at) SELECT $1,x.sku_id,x.location_id,0,$3 FROM jsonb_to_recordset($2::jsonb) AS x(sku_id text,location_id text) ON CONFLICT(sku_id,location_id) DO NOTHING`,[ctx.workspaceId,positionJSON,at]);
  const balances=(await client.query(`SELECT b.sku_id,b.location_id,b.on_hand FROM balances b JOIN jsonb_to_recordset($2::jsonb) AS x(sku_id text,location_id text) ON b.sku_id=x.sku_id AND b.location_id=x.location_id WHERE b.workspace_id=$1 ORDER BY b.sku_id,b.location_id FOR UPDATE OF b`,[ctx.workspaceId,positionJSON])).rows;
  const states=new Map(balances.map(row=>[JSON.stringify([row.sku_id,row.location_id]),{sku_id:row.sku_id,location_id:row.location_id,before:Number(row.on_hand),after:Number(row.on_hand)}])),operations=[],movements=[],results=[];
  for(const value of values){const row=targets[value.index],state=states.get(JSON.stringify([row.id,row.location_id])),input=value.input,occurredAt=input.occurredAt||nowIso(),before=state.after;state.after+=value.quantity;if(!Number.isSafeInteger(state.after))throw new ValidationError('Stock totals exceed the supported exact range.');
    if(state.after<0&&!Number(row.allow_negative_stock))throw new InsufficientStockError(`Not enough stock at ${row.location_name}. On hand: ${before}, requested: ${value.quantity}.`,{onHand:before,requested:value.quantity});
    const result={movementId:newId('mv'),groupId:newId('grp'),balanceAfter:state.after,quantity:value.quantity,lotId:null,serials:[],serialUnitIds:[]};
    operations.push({id:newId('pgop'),idempotency_key:value.key,result});movements.push({position:value.index,id:result.movementId,group_id:result.groupId,item_id:row.item_id,sku_id:row.id,location_id:row.location_id,quantity_delta:value.quantity,balance_after:state.after,notes:input.notes||null,reference:input.reference||null,occurred_at:occurredAt});results.push({...result,replayed:false});
  }
  const inserted=await client.query(`INSERT INTO stockchief_runtime.business_operations(id,workspace_id,kind,idempotency_key) SELECT x.id,$1,'inventory.receive',x.idempotency_key FROM jsonb_to_recordset($2::jsonb) AS x(id text,idempotency_key text) ON CONFLICT(workspace_id,kind,idempotency_key) DO NOTHING`,[ctx.workspaceId,JSON.stringify(operations)]);if(inserted.rowCount!==values.length)throw new InvariantError('That inventory operation is already running.','operation_in_progress');
  const changed=await client.query(`UPDATE balances b SET on_hand=x.after,updated_at=$3 FROM jsonb_to_recordset($2::jsonb) AS x(sku_id text,location_id text,before bigint,after bigint) WHERE b.workspace_id=$1 AND b.sku_id=x.sku_id AND b.location_id=x.location_id AND b.on_hand=x.before`,[ctx.workspaceId,JSON.stringify([...states.values()]),at]);if(changed.rowCount!==states.size)throw new InvariantError('Stock changed while its receipt was being prepared.','stock_changed');
  await client.query(`INSERT INTO movements(id,workspace_id,group_id,operation,item_id,sku_id,location_id,quantity_delta,balance_after,notes,reference,actor_user_id,occurred_at)
   SELECT x.id,$1,x.group_id,'receive',x.item_id,x.sku_id,x.location_id,x.quantity_delta,x.balance_after,x.notes,x.reference,$2,x.occurred_at FROM jsonb_to_recordset($3::jsonb) AS x(position integer,id text,group_id text,item_id text,sku_id text,location_id text,quantity_delta bigint,balance_after bigint,notes text,reference text,occurred_at text) ORDER BY x.position`,[ctx.workspaceId,ctx.actorId,JSON.stringify(movements)]);
  await client.query(`UPDATE stockchief_runtime.business_operations b SET status='COMPLETED',result=x.result,completed_at=now() FROM jsonb_to_recordset($2::jsonb) AS x(id text,result jsonb) WHERE b.workspace_id=$1 AND b.id=x.id`,[ctx.workspaceId,JSON.stringify(operations)]);
  return results;
}

async function receive(database, rawContext, input) {
  return database.transaction((client) => receiveInTransaction(client, rawContext, input),
    { isolation: 'SERIALIZABLE', retrySafe: Boolean(input.idempotencyKey) });
}

async function issueInTransaction(client, rawContext, input) {
  physicalInput.validate(input);
  const ctx = context(rawContext);
  const quantity = positiveInteger(input.quantity);
  await requirePermission(client, ctx, permissions.OPERATE, 'issue stock');
    const operation = await beginOperation(client, ctx, 'inventory.issue', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const row = await target(client, ctx, input.skuId, input.locationId);
    const at = input.occurredAt || nowIso();
    const groupId = newId('grp');
    let lot = null;
    if (row.tracking_mode === 'lot') lot = await resolveLot(client, ctx, row, input, at, false);
    let serialUnitIds = [];
    if (row.tracking_mode === 'serial') {
      const ids = [...new Set((input.serialUnitIds || []).map(String))];
      if (ids.length !== quantity) throw new ValidationError('Select the exact serial units being issued.');
      const locked = await client.query(`SELECT id FROM serial_units WHERE workspace_id = $1 AND sku_id = $2
        AND location_id = $3 AND status = 'in_stock' AND id = ANY($4::text[]) FOR UPDATE`,
      [ctx.workspaceId, row.id, row.location_id, ids]);
      if (locked.rows.length !== quantity) throw new InvariantError('One or more selected units are no longer available.', 'unit_not_in_stock');
      await client.query(`UPDATE serial_units SET status = 'issued', location_id = NULL, updated_at = $2
        WHERE id = ANY($1::text[])`, [ids, at]);
      serialUnitIds = ids;
    }
    const balanceAfter = await balanceDelta(client, ctx, row, -quantity, at);
    if (lot) await lotDelta(client, ctx, lot.id, row.location_id, -quantity, at);
    const movementId = await movement(client, ctx, row, { groupId, operation: 'issue', quantityDelta: -quantity,
      balanceAfter, lotId: lot?.id, reasonCode: input.reasonCode, notes: input.notes,
      reference: input.reference, occurredAt: at });
    await recordMovementSerials(client, ctx, movementId, serialUnitIds);
    const result = { movementId, groupId, balanceAfter, quantity, lotId: lot?.id || null, serialUnitIds };
    await completeOperation(client, operation, result);
  return { ...result, replayed: false };
}

async function issue(database, rawContext, input) {
  return database.transaction((client) => issueInTransaction(client, rawContext, input),
    { isolation: 'SERIALIZABLE', retrySafe: Boolean(input.idempotencyKey) });
}

async function transferInTransaction(client, rawContext, input) {
  const ctx = context(rawContext);
  const quantity = positiveInteger(input.quantity);
  if (input.sourceLocationId === input.destinationLocationId) throw new ValidationError('Choose two different locations.');
    await requirePermission(client, ctx, permissions.REQUEST_TRANSFER, 'transfer stock');
    const operation = await beginOperation(client, ctx, 'inventory.transfer', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const source = await target(client, ctx, input.skuId, input.sourceLocationId);
    const destination = await target(client, ctx, input.skuId, input.destinationLocationId);
    const at = input.occurredAt || nowIso();
    const groupId = newId('grp');
    let lot = null;
    if (source.tracking_mode === 'lot') lot = await resolveLot(client, ctx, source, input, at, false);
    const sourceAfter = await balanceDelta(client, ctx, source, -quantity, at);
    const destinationAfter = await balanceDelta(client, ctx, destination, quantity, at);
    if (lot) {
      await lotDelta(client, ctx, lot.id, source.location_id, -quantity, at);
      await lotDelta(client, ctx, lot.id, destination.location_id, quantity, at);
    }
    let serialUnitIds = [];
    if (source.tracking_mode === 'serial') {
      const ids = [...new Set((input.serialUnitIds || []).map(String))];
      if (ids.length !== quantity) throw new ValidationError('Select the exact serial units being transferred.');
      const moved = await client.query(`UPDATE serial_units SET location_id = $4, updated_at = $5
        WHERE workspace_id = $1 AND sku_id = $2 AND location_id = $3 AND status = 'in_stock'
          AND id = ANY($6::text[]) RETURNING id`,
      [ctx.workspaceId, source.id, source.location_id, destination.location_id, at, ids]);
      if (moved.rows.length !== quantity) throw new InvariantError('One or more selected units are no longer available.', 'unit_not_in_stock');
      serialUnitIds = ids;
    }
    const outMovementId = await movement(client, ctx, source, { groupId, operation: 'transfer', leg: 'out',
      counterpartyLocationId: destination.location_id, quantityDelta: -quantity, balanceAfter: sourceAfter,
      lotId: lot?.id, notes: input.notes, reference: input.reference, occurredAt: at });
    const inMovementId = await movement(client, ctx, destination, { groupId, operation: 'transfer', leg: 'in',
      counterpartyLocationId: source.location_id, quantityDelta: quantity, balanceAfter: destinationAfter,
      lotId: lot?.id, notes: input.notes, reference: input.reference, occurredAt: at });
    await recordMovementSerials(client, ctx, outMovementId, serialUnitIds);
    await recordMovementSerials(client, ctx, inMovementId, serialUnitIds);
    const result = { groupId, outMovementId, inMovementId, sourceAfter, destinationAfter, quantity,
      lotId: lot?.id || null, serialUnitIds };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
}

async function transfer(database, rawContext, input) {
  return database.transaction(async (client) => {
    return transferInTransaction(client, rawContext, input);
  }, { isolation: 'SERIALIZABLE', retrySafe: Boolean(input.idempotencyKey) });
}

async function dispatchTransferInTransaction(client, rawContext, input) {
  const ctx = context(rawContext);
  const quantity = positiveInteger(input.quantity);
  await requirePermission(client, ctx, permissions.DISPATCH_TRANSFER, 'dispatch an inventory transfer');
  const operation = await beginOperation(client, ctx, 'inventory.transfer.dispatch', input.idempotencyKey);
  if (operation.replayed) return { ...operation.result, replayed: true };
  const source = await target(client, ctx, input.skuId, input.sourceLocationId);
  const at = input.occurredAt || nowIso();
  const groupId = input.groupId || newId('grp');
  let lot = null;
  if (source.tracking_mode === 'lot') lot = await resolveLot(client, ctx, source, input, at, false);
  let serialUnitIds = [];
  if (source.tracking_mode === 'serial') {
    const ids = [...new Set((input.serialUnitIds || []).map(String))];
    if (ids.length !== quantity) throw new ValidationError('Select the exact serial units being dispatched.');
    const moved = await client.query(`UPDATE serial_units SET status='issued',location_id=NULL,updated_at=$5
      WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 AND status='in_stock'
        AND id=ANY($4::text[]) RETURNING id`,
    [ctx.workspaceId, source.id, source.location_id, ids, at]);
    if (moved.rows.length !== quantity) {
      throw new InvariantError('One or more selected units are no longer available for dispatch.', 'unit_not_in_stock');
    }
    serialUnitIds = ids;
  }
  const sourceAfter = await balanceDelta(client, ctx, source, -quantity, at);
  if (lot) await lotDelta(client, ctx, lot.id, source.location_id, -quantity, at);
  const movementId = await movement(client, ctx, source, { groupId, operation: 'transfer', leg: 'out',
    counterpartyLocationId: input.destinationLocationId, quantityDelta: -quantity, balanceAfter: sourceAfter,
    lotId: lot?.id, notes: input.notes, reference: input.reference, occurredAt: at });
  await recordMovementSerials(client, ctx, movementId, serialUnitIds);
  const result = { groupId, movementId, sourceAfter, quantity, lotId: lot?.id || null, serialUnitIds };
  await completeOperation(client, operation, result);
  return { ...result, replayed: false };
}

async function receiveTransferInTransaction(client, rawContext, input) {
  const ctx = context(rawContext);
  const quantity = positiveInteger(input.quantity);
  await requirePermission(client, ctx, permissions.RECEIVE_TRANSFER, 'receive an inventory transfer');
  const operation = await beginOperation(client, ctx, 'inventory.transfer.receive', input.idempotencyKey);
  if (operation.replayed) return { ...operation.result, replayed: true };
  const destination = await target(client, ctx, input.skuId, input.destinationLocationId);
  const at = input.occurredAt || nowIso();
  const groupId = input.groupId || newId('grp');
  let lot = null;
  if (destination.tracking_mode === 'lot') lot = await resolveLot(client, ctx, destination, input, at, false);
  let serialUnitIds = [];
  if (destination.tracking_mode === 'serial') {
    const ids = [...new Set((input.serialUnitIds || []).map(String))];
    if (ids.length !== quantity) throw new ValidationError('Select every serialized unit that arrived.');
    const moved = await client.query(`UPDATE serial_units SET status='in_stock',location_id=$4,condition='good',updated_at=$5
      WHERE workspace_id=$1 AND sku_id=$2 AND status='issued' AND location_id IS NULL
        AND id=ANY($3::text[]) RETURNING id`,
    [ctx.workspaceId, destination.id, ids, destination.location_id, at]);
    if (moved.rows.length !== quantity) {
      throw new InvariantError('One or more serialized units are no longer in transfer custody.', 'unit_not_in_transit');
    }
    serialUnitIds = ids;
  }
  const destinationAfter = await balanceDelta(client, ctx, destination, quantity, at);
  if (lot) await lotDelta(client, ctx, lot.id, destination.location_id, quantity, at);
  const movementId = await movement(client, ctx, destination, { groupId, operation: 'transfer', leg: 'in',
    counterpartyLocationId: input.sourceLocationId, quantityDelta: quantity, balanceAfter: destinationAfter,
    lotId: lot?.id, notes: input.notes, reference: input.reference, occurredAt: at });
  await recordMovementSerials(client, ctx, movementId, serialUnitIds);
  const result = { groupId, movementId, destinationAfter, quantity, lotId: lot?.id || null, serialUnitIds };
  await completeOperation(client, operation, result);
  return { ...result, replayed: false };
}

async function adjustInTransaction(client,rawContext,input){
  const ctx = context(rawContext);
  const counted = Number(input.countedQuantity);
  if (!Number.isSafeInteger(counted) || counted < 0) throw new ValidationError('Counted quantity must be a whole number of zero or more.');
  if(counted>physicalInput.MAX_QUANTITY)throw new ValidationError('Counted quantity exceeds the supported range.');
  if (!input.reasonCode) throw new ValidationError('A count correction requires a reason.');
    await requirePermission(client, ctx, permissions.ADJUST, 'correct counts');
    const operation = await beginOperation(client, ctx, 'inventory.adjust', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const row = await target(client, ctx, input.skuId, input.locationId);
    if (row.tracking_mode !== 'quantity') throw new ValidationError('Lot and serial counts must identify the affected stock.');
    const currentResult = await client.query(`SELECT on_hand FROM balances
      WHERE workspace_id = $1 AND sku_id = $2 AND location_id = $3 FOR UPDATE`,
    [ctx.workspaceId, row.id, row.location_id]);
    const expected = Number(currentResult.rows[0]?.on_hand || 0);
    const delta = counted - expected;
    if (!delta) {
      const result = { unchanged: true, balanceAfter: counted };
      await completeOperation(client, operation, result);
      return { ...result, replayed: false };
    }
    const at = input.occurredAt || nowIso();
    const groupId = newId('grp');
    const balanceAfter = await balanceDelta(client, ctx, row, delta, at);
    const movementId = await movement(client, ctx, row, { groupId, operation: 'adjust', quantityDelta: delta,
      balanceAfter, reasonCode: input.reasonCode, notes: input.notes, reference: input.reference, occurredAt: at });
    const adjustmentId = newId('adj');
    await client.query(`INSERT INTO adjustments
      (id, workspace_id, movement_id, sku_id, location_id, expected_qty, counted_qty,
       reason_code, notes, actor_user_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [adjustmentId, ctx.workspaceId, movementId, row.id, row.location_id, expected, counted,
      input.reasonCode, input.notes || null, ctx.actorId, at]);
    const result = { adjustmentId, movementId, groupId, expected, counted, balanceAfter };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
}

async function adjust(database, rawContext, input) {
  return database.transaction((client)=>adjustInTransaction(client,rawContext,input),
    { isolation: 'SERIALIZABLE', retrySafe: Boolean(input.idempotencyKey) });
}

module.exports = { receive, receiveInTransaction, receiveManyInTransaction, issue, issueInTransaction, transfer, transferInTransaction,
  dispatchTransferInTransaction, receiveTransferInTransaction, adjust,adjustInTransaction };

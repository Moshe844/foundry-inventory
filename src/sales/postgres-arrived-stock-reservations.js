'use strict';

const { newId, nowIso } = require('../lib/util');
const { ValidationError } = require('../domain/errors');
const rotation = require('../operations/postgres-stock-rotation');
const { add } = require('./arrived-stock-inventory');

const inputKey = Symbol('verified arrived stock');
const confirmationInput = (idempotencyKey, plan) => ({ idempotencyKey, resumeRemaining: true, [inputKey]: plan });

async function apply(c, ctx, order, input) {
  const plan = input[inputKey];
  if (!plan) return null;
  if (plan.order.id !== order.id || String(plan.order.version) !== String(order.version) || !order.confirmed_at
      || !['BACKORDERED', 'PARTIALLY_FULFILLED'].includes(order.status)) {
    throw new ValidationError('The waiting order changed. Prepare a fresh receipt reservation.');
  }
  const metadataBytes = Buffer.byteLength(JSON.stringify({ pools: plan.pools, quantities: plan.quantities })) * 5 + 8192
    + plan.pools.reduce((total, pool) => total + pool.layers.length * 1024, 0) + plan.quantities.length * 1024;
  await require('../commercial/storage-capacity').reserve(c, ctx.workspaceId, 'arrived-stock:' + input.idempotencyKey, metadataBytes, { finished: true });
  await rotation.initializePools(c, ctx, plan.pools);
  const allocations = [], kitAllocations = [], receiptReservations = [];
  for (const choice of plan.quantities) {
    const { lineId, locationId, quantity, componentId, skuId, previousId, previousQuantity, selection, strategy } = choice;
    const isKit = choice.kind === 'kit';
    const table = isKit ? 'sales_order_kit_allocations' : 'sales_order_allocations';
    const parentColumn = isKit ? 'kit_component_id' : 'sales_order_line_id';
    const parentId = isKit ? componentId : lineId;
    for (const part of choice.componentRequirements || []) {
      await c.query('UPDATE sales_order_kit_components SET quantity_required=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2',
        [ctx.workspaceId, part.id, part.required, nowIso()]);
    }
    const allocationId = previousId || newId(isKit ? 'soka' : 'soa');
    const total = add(previousQuantity, quantity);
    const at = nowIso();
    const written = previousId
      ? await c.query(`UPDATE ${table} SET quantity=$6,rotation_strategy=$7,rotation_selection=$8::jsonb,rotation_authorized_by=$9,updated_at=$10
        WHERE workspace_id=$1 AND id=$2 AND ${parentColumn}=$3 AND location_id=$4 AND quantity=$5`,
      [ctx.workspaceId, allocationId, parentId, locationId, previousQuantity, total, strategy, JSON.stringify(selection), ctx.actorId, at])
      : await c.query(`INSERT INTO ${table}(workspace_id,id,${parentColumn},location_id,quantity,rotation_strategy,rotation_selection,rotation_authorized_by,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$9)`,
      [ctx.workspaceId, allocationId, parentId, locationId, total, strategy, JSON.stringify(selection), ctx.actorId, at]);
    if (!written.rowCount) throw new ValidationError('A native reservation changed. Prepare a fresh receipt reservation.');
    if (isKit) kitAllocations.push({ lineId, componentId, skuId, locationId, quantity });
    else allocations.push({ lineId, locationId, quantity });
    receiptReservations.push({ allocationId, kind: choice.kind, lineId, componentId, skuId, locationId, quantity,
      secondaryQuantity: choice.secondaryQuantity, arrivals: choice.arrivals, selection });
  }
  return { allocations, kitAllocations, receiptReservations, shortage: plan.shortage };
}

module.exports = { confirmationInput, apply };

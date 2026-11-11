'use strict';

const exact = require('../domain/exact-quantity');
const stock = require('../domain/postgres-stock-availability');
const { ValidationError } = require('../domain/errors');

const add = (a, b) => exact.add(a ?? 0, b ?? 0);
const sub = (a, b) => exact.subtract(a ?? 0, b ?? 0);
const sum = (rows, value) => rows.reduce((total, row) => add(total, value(row)), '0');
const positive = value => Number(value) > 0;
const min = (a, b) => Number(a) <= Number(b) ? String(a) : String(b);
const stamp = value => value ? new Date(value).toISOString() : null;
const byPosition = (rows, skuId, locationId) => rows.filter(row => row.sku_id === skuId && row.location_id === locationId);
const newArrival = (receipt, confirmedAt) => receipt.arrivedAt && receipt.arrivedAt >= confirmedAt && receipt.arrivedAt <= new Date().toISOString();
const costedArrival = `(m.operation='receive' OR (m.operation='transfer' AND m.leg='in'))
 AND EXISTS(SELECT 1 FROM accounting_inventory_cost_movements cm
  WHERE cm.workspace_id=m.workspace_id AND cm.inventory_movement_id=m.id AND cm.quantity_delta=m.quantity_delta)`;
const qualityClear = `NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_quality_holds h
 JOIN purchase_order_receipt_lines rl ON rl.workspace_id=h.workspace_id AND rl.id=h.receipt_line_id
 WHERE h.workspace_id=m.workspace_id AND h.sku_id=m.sku_id AND h.location_id=m.location_id
  AND rl.movement_ids::jsonb ? m.id AND h.status<>'PASSED')`;

function receiptLayer(m) {
  return {
    receiptMovementId: m.id, receiptReference: m.reference, quantity: m.quantity_delta,
    receivedAt: m.arrived ? stamp(m.occurred_at) : null, arrivedAt: m.arrived && m.quality_clear ? stamp(m.occurred_at) : null,
    fullQuantity: m.quantity_delta, secondaryQuantity: m.secondary_quantity_delta,
  };
}

// Where prior picks had no identity, the remaining units of a mixed pool have
// unknown receipt provenance. A later receipt is still evidence on its own.
function reconcile(moves, physical) {
  const layers = [];
  for (const movement of moves) {
    if (positive(movement.quantity_delta)) {
      layers.push(receiptLayer(movement));
      continue;
    }
    if (!positive(sub(0, movement.quantity_delta))) continue;
    let removed = sub(0, movement.quantity_delta);
    const open = layers.filter(l => positive(l.quantity));
    if (open.length > 1) for (const layer of open) layer.receivedAt = layer.arrivedAt = null;
    for (const layer of open) {
      const used = min(removed, layer.quantity);
      layer.quantity = sub(layer.quantity, used);
      removed = sub(removed, used);
      if (!positive(removed)) break;
    }
    if (positive(removed)) return null;
  }
  return sum(layers, l => l.quantity) === exact.canonical(physical) ? layers.filter(l => positive(l.quantity)) : null;
}

async function read(c, ctx, skuIds, fixedLocation, { lock = false } = {}) {
  const params = [ctx.workspaceId, skuIds, fixedLocation];
  const positions = (await c.query(`SELECT b.sku_id,b.location_id,b.on_hand::text,b.secondary_on_hand::text,
    b.quality_held::text,l.name location,l.pick_sequence,coalesce(cost.quantity_units,0)::text cost_quantity,
    cost.secondary_quantity_units::text cost_secondary
    FROM balances b JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id
    LEFT JOIN accounting_inventory_cost_balances cost ON cost.workspace_id=b.workspace_id AND cost.sku_id=b.sku_id AND cost.location_id=b.location_id
    JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id AND s.is_active=1
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    WHERE b.workspace_id=$1 AND b.sku_id=ANY($2::text[]) AND ($3::text IS NULL OR b.location_id=$3)
      AND b.on_hand>0 AND l.is_active=1 AND l.custody_agreement_id IS NULL
    ORDER BY b.sku_id,b.location_id${lock ? ' FOR UPDATE OF b' : ''}`, params)).rows;
  const today = await require('../lib/business-time').today(c, ctx.workspaceId);
  const requests = positions.map(p => ({ skuId: p.sku_id, locationId: p.location_id }));
  const availability = await stock.readMany(c, ctx.workspaceId, requests);
  const returns = await require('../operations/postgres-return-holds').heldMany(c, ctx.workspaceId, requests);
  const locations = [...new Set(positions.map(p => p.location_id))];
  if (!locations.length) return [];
  const [workspace] = params;
  const trackedParams = [workspace, skuIds, locations, today];
  const lots = (await c.query(`SELECT l.id,l.sku_id,l.code,l.received_at,l.expires_at,l.recalled_at,
    b.location_id,b.quantity::text,b.secondary_quantity::text FROM lot_balances b
    JOIN lots l ON l.workspace_id=b.workspace_id AND l.id=b.lot_id
    WHERE b.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND b.location_id=ANY($3::text[]) AND b.quantity>0
      AND l.recalled_at IS NULL AND (l.expires_at IS NULL OR l.expires_at::date >= $4::date)
    ORDER BY l.id,b.location_id${lock ? ' FOR UPDATE OF l,b' : ''}`, trackedParams)).rows;
  const serials = (await c.query(`SELECT u.id,u.sku_id,u.location_id,u.serial,u.lot_id,u.received_at,
    u.secondary_quantity::text,l.code lot_code,l.expires_at,receipt.id movement_id,receipt.reference,
    receipt.occurred_at,receipt.arrived,receipt.quality_clear FROM serial_units u
    LEFT JOIN lots l ON l.workspace_id=u.workspace_id AND l.id=u.lot_id
    LEFT JOIN LATERAL (SELECT m.id,m.location_id,m.reference,m.occurred_at,${costedArrival} arrived,
       ${qualityClear} quality_clear FROM stockchief_runtime.inventory_movement_serial_units s
       JOIN movements m ON m.workspace_id=s.workspace_id AND m.id=s.movement_id
       WHERE s.workspace_id=u.workspace_id AND s.serial_unit_id=u.id ORDER BY m.seq DESC LIMIT 1) receipt
       ON receipt.location_id=u.location_id
    WHERE u.workspace_id=$1 AND u.sku_id=ANY($2::text[]) AND u.location_id=ANY($3::text[])
      AND u.status='in_stock' AND u.condition='good' AND l.recalled_at IS NULL
      AND (l.expires_at IS NULL OR l.expires_at::date >= $4::date)
    ORDER BY u.id${lock ? ' FOR UPDATE OF u' : ''}`, trackedParams)).rows;
  const holds = (await c.query(`SELECT sku_id,location_id,lot_id,serial_unit_id,quantity::text,selection,
    allocation_key,NULL::text picked_line FROM stockchief_runtime.sales_rotation_entries
    WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND location_id=ANY($3::text[])
    UNION ALL SELECT t.sku_id,h.source_location_id,t.lot_id,u.serial_unit_id,
    CASE WHEN u.serial_unit_id IS NOT NULL THEN '1' WHEN h.status='REQUESTED' THEN t.requested_quantity::text ELSE t.approved_quantity::text END,
    NULL,NULL,NULL FROM inventory_transfer_lines t JOIN inventory_transfers h ON h.workspace_id=t.workspace_id AND h.id=t.transfer_id
    LEFT JOIN inventory_transfer_serials u ON u.workspace_id=t.workspace_id AND u.transfer_line_id=t.id AND u.state IN('REQUESTED','PICKED')
    WHERE t.workspace_id=$1 AND t.sku_id=ANY($2::text[]) AND h.source_location_id=ANY($3::text[]) AND h.status IN('REQUESTED','APPROVED','PICKED')
    UNION ALL SELECT w.sku_id,w.location_id,s.lot_id,s.serial_unit_id,s.quantity::text,NULL,
     CASE WHEN a.rotation_selection IS NOT NULL THEN 'sales:'||a.id END,sl.sales_order_line_id
    FROM fulfillment_wave_scans s JOIN fulfillment_wave_lines w ON w.workspace_id=s.workspace_id AND w.id=s.line_id
    JOIN sales_shipments h ON h.workspace_id=w.workspace_id AND h.id=w.shipment_id
    JOIN sales_shipment_lines sl ON sl.workspace_id=w.workspace_id AND sl.id=w.shipment_line_id
    LEFT JOIN sales_order_allocations a ON a.workspace_id=sl.workspace_id AND a.sales_order_line_id=sl.sales_order_line_id AND a.location_id=w.location_id
    WHERE w.workspace_id=$1 AND w.sku_id=ANY($2::text[]) AND w.location_id=ANY($3::text[])
      AND s.status='ACCEPTED' AND h.status NOT IN('SHIPPED','DELIVERED','CANCELLED')
    UNION ALL SELECT h.sku_id,h.location_id,rl.lot_id,NULL,h.quantity::text,NULL,NULL,NULL
    FROM stockchief_runtime.agent_quality_holds h JOIN purchase_order_receipt_lines rl ON rl.workspace_id=h.workspace_id AND rl.id=h.receipt_line_id
    WHERE h.workspace_id=$1 AND h.sku_id=ANY($2::text[]) AND h.location_id=ANY($3::text[]) AND h.status<>'PASSED'
      AND rl.lot_id IS NOT NULL`, [workspace, skuIds, locations])).rows;
  for (const p of positions) {
    const key = stock.key(p.sku_id, p.location_id);
    p.available = availability.get(key);
    p.lots = byPosition(lots, p.sku_id, p.location_id);
    p.serials = byPosition(serials, p.sku_id, p.location_id);
    p.holds = byPosition(holds, p.sku_id, p.location_id);
    p.returnHeld = returns.get(key);
  }
  return positions;
}

async function history(c, workspaceId, p, lotId = null) {
  return (await c.query(`SELECT m.id,m.seq,m.quantity_delta::text,m.secondary_quantity_delta::text,m.reference,m.occurred_at,
    ${costedArrival} arrived,${qualityClear} quality_clear FROM movements m
    WHERE m.workspace_id=$1 AND m.sku_id=$2 AND m.location_id=$3 AND m.lot_id IS NOT DISTINCT FROM $4
      AND m.seq>coalesce((SELECT max(z.seq) FROM movements z WHERE z.workspace_id=m.workspace_id
        AND z.sku_id=m.sku_id AND z.location_id=m.location_id AND z.balance_after=0),0)
    ORDER BY m.seq`, [workspaceId, p.sku_id, p.location_id, lotId])).rows;
}

async function quantityLayers(c, workspaceId, p) {
  const args = [workspaceId, p.sku_id, p.location_id];
  if ((await c.query(`SELECT 1 FROM stockchief_runtime.stock_rotation_pools
    WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`, args)).rowCount) {
    const rows = (await c.query(`SELECT m.id,l.remaining_quantity::text quantity_delta,m.quantity_delta::text original,
      m.secondary_quantity_delta::text,m.reference,l.received_at occurred_at,${costedArrival} arrived,${qualityClear} quality_clear
      FROM stockchief_runtime.stock_rotation_layers l JOIN movements m ON m.workspace_id=l.workspace_id AND m.id=l.receipt_movement_id
      WHERE l.workspace_id=$1 AND l.sku_id=$2 AND l.location_id=$3 AND l.remaining_quantity>0
      ORDER BY l.received_at NULLS LAST,m.seq`, args)).rows;
    return rows.map(m => ({ ...receiptLayer(m), fullQuantity: m.original }));
  }
  const moves = await history(c, workspaceId, p);
  const layers = reconcile(moves, p.on_hand);
  if (!layers) return [];
  p.pool = { skuId: p.sku_id, locationId: p.location_id, initializedSeq: String(moves.at(-1)?.seq ?? 0),
    layers: layers.map(l => ({ receipt_movement_id: l.receiptMovementId, received_at: l.receivedAt, quantity: l.quantity })) };
  return layers;
}

async function candidates(c, ctx, p, item, confirmedAt) {
  const measure = Boolean(item.secondary_unit_label);
  const good = item.tracking_mode === 'serial' ? p.serials.length : item.tracking_mode === 'lot' ? sum(p.lots, l => l.quantity) : p.on_hand;
  const { committed = 0, reserved = 0 } = p.available || {};
  p.free = min(sub(good, add(committed, reserved)), sub(p.cost_quantity, add(committed, reserved)));
  if (!positive(p.free) || Number(p.cost_quantity) !== Number(p.on_hand)) return [];
  // Quantity-only rental holds lack pick identities. Do not promise a
  // particular serial or batch unless its physical custody is established.
  if ((item.tracking_mode !== 'quantity' || measure) &&
      (p.available.rentalReserved || Number(p.returnHeld?.quantity || 0) > Number(p.quality_held))) return [];
  const used = p.holds.filter(h => !h.picked_line || !h.allocation_key);
  if (item.tracking_mode === 'serial') return p.serials.filter(s => !used.some(h => h.serial_unit_id === s.id)
    && (!s.movement_id || s.quality_clear) && (!measure || positive(s.secondary_quantity))).map(s => ({
    serialUnitId: s.id, serial: s.serial, lotId: s.lot_id, lotCode: s.lot_code, quantity: '1',
    receivedAt: s.received_at, expiresOn: s.expires_at?.slice(0, 10) || null,
    secondaryQuantity: s.secondary_quantity, fullQuantity: '1',
    arrivals: s.arrived && s.quality_clear && newArrival({ arrivedAt: stamp(s.occurred_at) }, confirmedAt)
      ? [{ movementId: s.movement_id, reference: s.reference, at: stamp(s.occurred_at), quantity: '1' }] : [],
  }));
  if (item.tracking_mode === 'lot') {
    const selections = [];
    for (const lot of p.lots) {
      const held = used.filter(h => h.lot_id === lot.id);
      const free = sub(lot.quantity, sum(held, h => h.quantity));
      if (!positive(free)) continue;
      const moves = await history(c, ctx.workspaceId, p, lot.id);
      const layers = reconcile(moves, lot.quantity) || [];
      const arrivals = layers.filter(l => newArrival(l, confirmedAt)).map(l => {
        const used = held.flatMap(h => h.selection?.arrivals || []).filter(a => a.movementId === l.receiptMovementId);
        return { movementId: l.receiptMovementId, reference: l.receiptReference, at: l.arrivedAt, quantity: sub(l.quantity, sum(used, a => a.quantity)) };
      }).filter(a => positive(a.quantity));
      if (measure && (!positive(lot.secondary_quantity) || exact.canonical(free) !== exact.canonical(lot.quantity)
          || exact.canonical(p.cost_secondary || 0) !== exact.canonical(p.secondary_on_hand || 0))) continue;
      selections.push({ lotId: lot.id, lotCode: lot.code, quantity: free, fullQuantity: lot.quantity,
        receivedAt: lot.received_at, expiresOn: lot.expires_at?.slice(0, 10) || null, secondaryQuantity: lot.secondary_quantity, arrivals });
    }
    return selections;
  }
  const layers = await quantityLayers(c, ctx.workspaceId, p);
  return layers.map(l => {
    const claimed = sum(used.filter(h => h.selection?.receiptMovementId === l.receiptMovementId), h => h.quantity);
    const quantity = sub(l.quantity, claimed);
    const weighed = !measure || (positive(l.secondaryQuantity) && exact.canonical(quantity) === exact.canonical(l.fullQuantity)
      && exact.canonical(p.cost_secondary || 0) === exact.canonical(p.secondary_on_hand || 0));
    return { ...l, quantity: weighed ? quantity : '0', arrivals: weighed && newArrival(l, confirmedAt)
      ? [{ movementId: l.receiptMovementId, reference: l.receiptReference, at: l.arrivedAt, quantity }] : [] };
  }).filter(l => positive(l.quantity));
}

function allocate(candidates, need, { fresh, secondaryNeed = null, quantityIncrement = '1', quantityPrecision = 0 } = {}) {
  const choices = [];
  const increment = exact.atoms(quantityIncrement, quantityPrecision, { positive: true });
  for (const candidate of candidates) {
    if (!positive(need)) break;
    const evidence = sum(candidate.arrivals, a => a.quantity);
    let quantity = min(need, fresh ? min(candidate.quantity, evidence) : candidate.quantity);
    if (!positive(quantity)) continue;
    const atoms = exact.atoms(quantity, quantityPrecision);
    quantity = exact.fromAtoms(atoms - atoms % increment, quantityPrecision);
    if (!positive(quantity)) continue;
    if (secondaryNeed !== null && (exact.canonical(quantity) !== exact.canonical(candidate.fullQuantity)
        || !positive(candidate.secondaryQuantity) || Number(candidate.secondaryQuantity) > Number(secondaryNeed))) continue;
    let covered = quantity;
    const arrivals = [];
    for (const a of candidate.arrivals) {
      const take = min(covered, a.quantity);
      if (positive(take)) arrivals.push({ ...a, quantity: take });
      covered = sub(covered, take);
    }
    const { fullQuantity, arrivedAt, ...choice } = candidate;
    choices.push({ ...choice, quantity, arrivals });
    need = sub(need, quantity);
    if (secondaryNeed !== null) secondaryNeed = sub(secondaryNeed, choice.secondaryQuantity);
  }
  return choices;
}

function consume(candidates, choices) {
  for (const choice of choices) {
    const candidate = candidates.find(c => c.serialUnitId ? c.serialUnitId === choice.serialUnitId :
      c.lotId ? c.lotId === choice.lotId : c.receiptMovementId === choice.receiptMovementId);
    if (!candidate) throw new ValidationError('The receipt evidence changed. Prepare a new reservation.');
    candidate.quantity = sub(candidate.quantity, choice.quantity);
    candidate.arrivals = candidate.arrivals.map(a => ({ ...a,
      quantity: sub(a.quantity, sum(choice.arrivals.filter(c => c.movementId === a.movementId), c => c.quantity)) })).filter(a => positive(a.quantity));
  }
}

function weightedSites(sites, need, weightNeeded, units, trackingMode) {
  const choose = (p, candidates) => allocate(candidates, min(need, p.free), { ...units, fresh: true, secondaryNeed: weightNeeded });
  const initial = { quantity: '0', weight: '0', picked: null };
  let states = new Map([['0|0', initial]]);
  for (const { p } of sites) {
    const options = trackingMode === 'quantity' ? [choose(p, p.candidates)].filter(s => sum(s, x => x.quantity) === exact.canonical(p.on_hand))
      : p.candidates.map(candidate => choose(p, [candidate])).filter(s => s.length);
    let local = new Map([...states].map(([key, state]) => [key + '|0', { ...state, siteQuantity: '0' }]));
    for (const selection of options) {
      const optionQuantity = sum(selection, x => x.quantity), optionWeight = sum(selection, x => x.secondaryQuantity);
      const next = new Map(local);
      for (const state of local.values()) {
        const quantity = add(state.quantity, optionQuantity), weight = add(state.weight, optionWeight), siteQuantity = add(state.siteQuantity, optionQuantity);
        if (Number(quantity) > Number(need) || Number(weight) > Number(weightNeeded) || Number(siteQuantity) > Number(p.free)) continue;
        const key = [quantity, weight, siteQuantity].join('|');
        if (!next.has(key)) next.set(key, { quantity, weight, siteQuantity, picked: { p, selection, previous: state.picked } });
      }
      if (next.size > 30000) throw new ValidationError('Review the exact weighed pieces for this order. Multiple receipt combinations need physical identification.');
      local = next;
    }
    states = new Map();
    for (const state of local.values()) {
      const key = [state.quantity, state.weight].join('|');
      if (!states.has(key)) states.set(key, state);
    }
    if (states.has(need + '|' + weightNeeded)) break;
  }
  let selected = states.get(need + '|' + weightNeeded);
  if (!selected) {
    // When pieces cover the count but their actual total conflicts with the
    // order, a partial reservation could make the corrected combination impossible.
    if ([...states.values()].some(state => state.quantity === need)) return new Map();
    selected = [...states.values()].filter(state => Number(state.quantity) < Number(need) && Number(state.weight) < Number(weightNeeded))
      .reduce((best, state) => Number(state.quantity) > Number(best.quantity) ? state : best, initial);
  }
  const result = new Map();
  for (let pick = selected.picked; pick; pick = pick.previous) {
    result.set(pick.p, [...pick.selection, ...result.get(pick.p) || []]);
  }
  return result;
}

module.exports = { add, sub, sum, positive, min, read, candidates, allocate, consume, weightedSites };

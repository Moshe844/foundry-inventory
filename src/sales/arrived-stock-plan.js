'use strict';

const { ValidationError } = require('../domain/errors');
const exact = require('../domain/exact-quantity');
const inventory = require('./arrived-stock-inventory');
const { add, sub, sum, positive, min } = inventory;

const open = ['BACKORDERED', 'PARTIALLY_FULFILLED'];
const remaining = line => sub(sub(line.quantity_ordered, line.quantity_fulfilled), line.direct_committed_quantity);
const compareReceipt = (a, b) => String(a.receivedAt || '9999').localeCompare(String(b.receivedAt || '9999'));
const sameIdentity = (a, b) => a.lotId && !a.serialUnitId && !b.serialUnitId && a.lotId === b.lotId;
const boundQuantity = a => sum(a.rotation_selection || [], s => s.secondaryQuantity);

async function facts(c, ctx, orderId, lock) {
  const args = [ctx.workspaceId, orderId];
  const order = (await c.query(`SELECT o.*,customer.name customer_name,customer.record_state,loc.name location_name,loc.is_active,loc.custody_agreement_id
    FROM sales_orders o JOIN customers customer ON customer.workspace_id=o.workspace_id AND customer.id=o.customer_id
    LEFT JOIN locations loc ON loc.workspace_id=o.workspace_id AND loc.id=o.fulfillment_location_id
    WHERE o.workspace_id=$1 AND o.id=$2${lock ? ' FOR UPDATE OF o' : ''}`, args)).rows[0];
  if (!order || !open.includes(order.status) || !order.confirmed_at || order.record_state !== 'ACTIVE'
      || order.fulfillment_location_id && (Number(order.is_active) !== 1 || order.custody_agreement_id)) {
    throw new ValidationError('Choose an already confirmed backorder with an active customer and eligible dispatch warehouse.');
  }
  if (Number(order.customer_decision_required) || Number(order.delivery_decision_required)) {
    throw new ValidationError('Confirm the existing customer and delivery details before routing a receipt.');
  }
  const lines = (await c.query(`SELECT l.id,l.sku_id,l.quantity_ordered::text,l.quantity_fulfilled::text,l.secondary_quantity_ordered::text,
    l.secondary_quantity_fulfilled::text,coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0)::text direct_committed_quantity,
    coalesce((to_jsonb(l)->>'direct_committed_secondary_quantity')::numeric,0)::text direct_committed_secondary_quantity,
    l.unit_price_minor::text,s.code,i.tracking_mode,i.unit_label,i.quantity_increment::text,i.quantity_precision,i.secondary_unit_label
    FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY l.created_at,l.id${lock ? ' FOR UPDATE OF l' : ''}`, args)).rows;
  const components = (await c.query(`SELECT k.id,k.sales_order_line_id,k.component_sku_id sku_id,k.quantity_per_kit::text,
    k.quantity_fulfilled::text,k.quantity_required::text,s.code,i.tracking_mode,i.unit_label,
    i.quantity_increment::text,i.quantity_precision,i.secondary_unit_label
    FROM sales_order_kit_components k JOIN sales_order_lines l ON l.workspace_id=k.workspace_id AND l.id=k.sales_order_line_id
    JOIN skus s ON s.workspace_id=k.workspace_id AND s.id=k.component_sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY k.component_sku_id,k.id${lock ? ' FOR UPDATE OF k' : ''}`, args)).rows;
  const allocations = [];
  for (const [kind, table, parent, join] of [
    ['sales', 'sales_order_allocations', 'sales_order_line_id', 'l.id=a.sales_order_line_id'],
    ['kit', 'sales_order_kit_allocations', 'kit_component_id', 'l.id=(SELECT k.sales_order_line_id FROM sales_order_kit_components k WHERE k.workspace_id=a.workspace_id AND k.id=a.kit_component_id)'],
  ]) {
    const { rows } = await c.query(`SELECT a.id,a.${parent} demand_id,a.location_id,a.quantity::text,a.rotation_strategy,a.rotation_selection
      FROM ${table} a JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND ${join}
      WHERE a.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY a.location_id,a.id${lock ? ' FOR UPDATE OF a' : ''}`, args);
    allocations.push(...rows.map(a => ({ ...a, kind })));
  }
  return { order, lines, components, allocations };
}

async function earlierOrders(c, ctx, order, skuIds) {
  return (await c.query(`WITH earlier AS MATERIALIZED(
    SELECT o.id,o.order_number,o.fulfillment_location_id,o.allocation_priority,o.needed_by,o.created_at
    FROM sales_orders o JOIN customers customer ON customer.workspace_id=o.workspace_id AND customer.id=o.customer_id
    WHERE o.workspace_id=$1 AND o.confirmed_at IS NOT NULL AND customer.record_state='ACTIVE'
      AND o.status IN('BACKORDERED','PARTIALLY_FULFILLED')
      AND (o.allocation_priority,coalesce(o.needed_by,'9999-12-31'),o.created_at,o.id)<($3,$4,$5,$6)
  ), demands AS (
    SELECT o.*,l.sku_id FROM earlier o JOIN sales_order_lines l ON l.workspace_id=$1 AND l.sales_order_id=o.id
    WHERE l.sku_id=ANY($2::text[]) AND l.quantity_ordered-l.quantity_fulfilled-coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0)>
      coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id),0)
    UNION ALL
    SELECT o.*,k.component_sku_id FROM earlier o JOIN sales_order_lines l ON l.workspace_id=$1 AND l.sales_order_id=o.id
    JOIN sales_order_kit_components k ON k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id
    WHERE k.component_sku_id=ANY($2::text[]) AND k.quantity_required-k.quantity_fulfilled>
      coalesce((SELECT sum(a.quantity) FROM sales_order_kit_allocations a WHERE a.workspace_id=k.workspace_id AND a.kit_component_id=k.id),0)
  )
  SELECT DISTINCT ON(sku_id,fulfillment_location_id) sku_id,fulfillment_location_id,order_number
  FROM demands ORDER BY sku_id,fulfillment_location_id,allocation_priority,needed_by NULLS LAST,created_at,id`,
  [ctx.workspaceId, skuIds, order.allocation_priority, order.needed_by || '9999-12-31', order.created_at, order.id])).rows;
}

function combineSelections(previous, appended) {
  const selection = [...previous];
  for (const next of appended) {
    const index = selection.findIndex(prior => sameIdentity(prior, next));
    if (index < 0) selection.push(next);
    else {
      const prior = selection[index];
      selection[index] = { ...prior, quantity: add(prior.quantity, next.quantity), arrivals: [...prior.arrivals || [], ...next.arrivals],
        secondaryQuantity: next.secondaryQuantity == null ? prior.secondaryQuantity : add(prior.secondaryQuantity, next.secondaryQuantity) };
    }
  }
  if (selection.some(s => s.receiptMovementId)) selection.sort((a, b) =>
    compareReceipt(a, b) || String(a.receiptMovementId || '').localeCompare(String(b.receiptMovementId || '')));
  return selection;
}

async function plan(c, ctx, orderId, { lock = false } = {}) {
  const source = await facts(c, ctx, orderId, lock);
  const { order, lines, components, allocations } = source;
  const skuIds = [...new Set([...lines, ...components].map(l => l.sku_id))];
  const positions = await inventory.read(c, ctx, skuIds, order.fulfillment_location_id, { lock });
  const earlier = await earlierOrders(c, ctx, order, skuIds);
  const quantities = [], blocked = [], priced = [], changedPools = new Set();
  let shortage = false;

  async function route(item, kind, line, need, secondaryNeed = null) {
    if (!positive(need)) return { need, secondaryNeed };
    const own = allocations.filter(a => a.kind === kind && a.demand_id === item.id);
    const sites = positions.filter(p => p.sku_id === item.sku_id).sort((a, b) =>
      a.pick_sequence - b.pick_sequence || a.location_id.localeCompare(b.location_id));
    const units = { quantityPrecision: Number(item.quantity_precision), quantityIncrement: item.quantity_increment };
    const usable = [];
    for (const p of sites) {
      if (!p.candidates) p.candidates = (await inventory.candidates(c, ctx, p, item, new Date(order.confirmed_at).toISOString())).sort(compareReceipt);
      if (!positive(p.free) || !p.candidates.some(candidate => candidate.arrivals.some(a => positive(a.quantity)))) continue;
      const prior = earlier.find(o => o.sku_id === item.sku_id && (!o.fulfillment_location_id || o.fulfillment_location_id === p.location_id));
      if (prior) {
        blocked.push('Order ' + prior.order_number + ' has priority for this stock at ' + p.location + '.');
        continue;
      }
      const current = own.find(a => a.location_id === p.location_id);
      let bridge = [];
      if (current && !current.rotation_selection) {
        if (item.tracking_mode === 'quantity' && !item.secondary_unit_label) {
          bridge = [{ quantity: exact.canonical(current.quantity), receivedAt: null, arrivals: [] }];
        } else {
          if (item.secondary_unit_label || p.holds.some(h => h.picked_line === line.id)) {
            blocked.push('Review the existing unassigned measured stock or physical picks for ' + item.code + ' at ' + p.location + '.');
            continue;
          }
          const older = p.candidates.map(candidate => ({ ...candidate, quantity: sub(candidate.quantity, sum(candidate.arrivals, a => a.quantity)), arrivals: [] }));
          bridge = inventory.allocate(older, current.quantity, { ...units, fresh: false });
          if (sum(bridge, b => b.quantity) !== exact.canonical(current.quantity)) {
            blocked.push('Identify the existing reserved batches or serials for ' + item.code + ' at ' + p.location + '.');
            continue;
          }
        }
      }
      usable.push({ p, current, bridge });
    }
    const weighed = secondaryNeed === null ? null : inventory.weightedSites(usable, need, secondaryNeed, units, item.tracking_mode);
    if (weighed && !weighed.size && usable.length) blocked.push('The actual arrived weight of ' + item.code + ' needs review against the confirmed order.');
    for (const { p, current, bridge } of usable) {
      if (!positive(need)) break;
      const selected = weighed ? weighed.get(p) || [] : inventory.allocate(p.candidates, min(need, p.free), { ...units, fresh: true });
      const quantity = sum(selected, s => s.quantity), weight = secondaryNeed === null ? null : sum(selected, s => s.secondaryQuantity);
      if (!positive(quantity)) continue;
      inventory.consume(p.candidates, [...bridge.filter(b => b.lotId || b.serialUnitId), ...selected]);
      const selection = combineSelections(current?.rotation_selection || bridge, selected);
      quantities.push({ kind, lineId: line.id, componentId: kind === 'kit' ? item.id : null, skuId: item.sku_id, code: item.code,
        locationId: p.location_id, location: p.location, unit: item.unit_label, secondaryUnit: item.secondary_unit_label,
        quantity: exact.safeNumber(quantity), secondaryQuantity: weight, previousId: current?.id || null, previousQuantity: current?.quantity || '0',
        strategy: current?.rotation_strategy || 'FIFO', selection, arrivals: selected.flatMap(s => s.arrivals) });
      p.free = sub(p.free, quantity);
      if (p.pool) changedPools.add(p.pool);
      need = sub(need, quantity);
      if (secondaryNeed !== null) secondaryNeed = sub(secondaryNeed, weight);
    }
    return { need, secondaryNeed };
  }

  for (const line of lines) {
    const own = allocations.filter(a => a.kind === 'sales' && a.demand_id === line.id);
    const parts = components.filter(k => k.sales_order_line_id === line.id);
    const held = sum(own, a => a.quantity);
    const unreserved = sub(remaining(line), held);
    if (!positive(unreserved)) continue;
    const before = quantities.length;
    if (line.secondary_unit_label && (!positive(line.secondary_quantity_ordered) ||
        own.some(a => !a.rotation_selection || a.rotation_selection.some(s => !positive(s.secondaryQuantity))))) {
      blocked.push('Confirm the remaining ordered weight and existing measured allocations for ' + line.code + '.');
      shortage = true;
      continue;
    }
    const secondaryNeed = line.secondary_unit_label ? sub(sub(sub(line.secondary_quantity_ordered, line.secondary_quantity_fulfilled),
      line.direct_committed_secondary_quantity), sum(own, boundQuantity)) : null;
    const hasComponentCommitment = parts.some(part => allocations.some(a => a.kind === 'kit' && a.demand_id === part.id));
    const result = hasComponentCommitment ? { need: unreserved, secondaryNeed } : await route(line, 'sales', line, unreserved, secondaryNeed);
    const componentRequirements = [];
    let missing = positive(result.need);
    if (parts.length) {
      missing = false;
      for (const part of parts) {
        const required = add(part.quantity_fulfilled, positive(result.need) ? exact.convert(result.need, { numerator: part.quantity_per_kit, precision: 6 }) : '0');
        if (required !== exact.canonical(part.quantity_required)) componentRequirements.push({ id: part.id, required });
        const heldPart = sum(allocations.filter(a => a.kind === 'kit' && a.demand_id === part.id), a => a.quantity);
        const missingPart = sub(sub(required, part.quantity_fulfilled), heldPart);
        if (positive(missingPart) && part.secondary_unit_label) {
          blocked.push('Confirm the independent component weight for ' + part.code + ' in ' + line.code + '.');
          missing = true;
          continue;
        }
        if (positive((await route(part, 'kit', line, missingPart)).need)) missing = true;
      }
    }
    shortage = shortage || missing;
    if (quantities.length === before) continue;
    const measure = secondaryNeed === null ? sub(unreserved, result.need) : sub(secondaryNeed, result.secondaryNeed);
    const pricedMeasure = quantities.slice(before).some(q => q.kind === 'kit') ? unreserved : measure;
    priced.push(exact.costMinor(pricedMeasure, line.unit_price_minor));
    quantities[before].componentRequirements = componentRequirements;
  }
  if (!quantities.length) throw new ValidationError(blocked[0] || 'No eligible costed receipt or transfer has arrived for this backorder.');
  return { ...source, quantities, pools: [...changedPools], amountMinor: require('../domain/currency').sum(priced), shortage };
}

module.exports = { plan };

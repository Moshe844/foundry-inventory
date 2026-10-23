'use strict';

const crypto = require('node:crypto');
const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError, InvariantError } = require('../domain/errors');
const access = require('../actions/permissions');
const inventory = require('../domain/postgres-inventory-engine');
const ledger = require('../accounting/postgres-ledger');
const costing = require('../accounting/postgres-costing');
const priceCalculator=require('../pricing/calculator');

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ValidationError(`${label} must be a whole number above zero.`);
  }
  return number;
}

function nonNegativeMinor(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ValidationError(`${label} must use non-negative whole minor currency units.`);
  }
  return number;
}

function dateOnly(value, label) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00.000Z`)) || new Date(`${text}T00:00:00.000Z`).toISOString().slice(0,10)!==text) {
    throw new ValidationError(`${label} must be a valid date in YYYY-MM-DD format.`);
  }
  return text;
}

function requireContext(ctx) {
  if (!ctx?.workspaceId || !ctx?.actorId) throw new ValidationError('A workspace and acting user are required.');
  return ctx;
}

async function requireActor(client, ctx) {
  const result = await client.query('SELECT id,role,permissions FROM users WHERE id=$1 AND workspace_id=$2',
    [ctx.actorId, ctx.workspaceId]);
  if (!result.rows.length) throw new ValidationError('The acting user does not belong to this inventory.');
  return result.rows[0];
}

async function requirePermission(client, ctx, permission, what) {
  const actor = await requireActor(client, ctx);
  access.assertCan(actor, permission, what);
  return actor;
}

async function requireRow(client, sql, values, message) {
  const result = await client.query(sql, values);
  if (!result.rows.length) throw new NotFoundError(message);
  return result.rows[0];
}

async function beginOperation(client, ctx, kind, key) {
  const capability=kind==='purchase_order.receive'?'receiving.core':kind.startsWith('supplier_invoice')?'purchasing.invoices':
    kind.startsWith('purchase')?'purchasing.core':kind.includes('fulfill')?'fulfillment.core':
    kind.startsWith('sales')?'sales_orders.core':'accounting.core';
  // Only a validated durable provider receipt bypasses the subscription gate;
  // cancellation must not erase incoming money facts.
  if(!(ctx.verifiedProviderReceipt&&kind.startsWith('payment.')))
    await require('../commercial/enforcement').workspace(client,ctx.workspaceId,capability);
  const idempotencyKey = String(key || '').trim();
  if (!idempotencyKey) throw new ValidationError('A durable idempotency key is required.');
  const id = newId('pgop');
  const inserted = await client.query(`INSERT INTO stockchief_runtime.business_operations
      (id,workspace_id,kind,idempotency_key) VALUES($1,$2,$3,$4)
      ON CONFLICT(workspace_id,kind,idempotency_key) DO NOTHING RETURNING id`,
  [id, ctx.workspaceId, kind, idempotencyKey]);
  if (inserted.rows.length) return { id, replayed: false };
  const prior = await client.query(`SELECT id,status,result FROM stockchief_runtime.business_operations
    WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3 FOR UPDATE`,
  [ctx.workspaceId, kind, idempotencyKey]);
  if (prior.rows[0]?.status === 'COMPLETED') {
    return { id: prior.rows[0].id, replayed: true, result: prior.rows[0].result };
  }
  throw new InvariantError('That business operation is already running.', 'operation_in_progress');
}

async function completeOperation(client, operation, result) {
  await client.query(`UPDATE stockchief_runtime.business_operations
    SET status='COMPLETED',result=$2::jsonb,completed_at=now() WHERE id=$1`,
  [operation.id, JSON.stringify(result)]);
}

async function accountId(client, workspaceId, systemKey) {
  const row = await requireRow(client, `SELECT id FROM accounting_accounts
    WHERE workspace_id=$1 AND system_key=$2 AND active=1`, [workspaceId, systemKey],
  `The ${systemKey} accounting control account is missing.`);
  return row.id;
}

async function numbered(client, workspaceId, table, prefix) {
  if (!['purchase_orders', 'sales_orders', 'accounting_supplier_bills', 'accounting_customer_invoices',
    'accounting_payments'].includes(table)) throw new Error('Unsupported numbering table.');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`number:${workspaceId}:${table}`]);
  const result = await client.query(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id=$1`, [workspaceId]);
  return `${prefix}-${String(Number(result.rows[0].count) + 1).padStart(5, '0')}`;
}

async function event(client, table, fields, values) {
  if (table === 'purchase_order_events') {
    await client.query(`INSERT INTO purchase_order_events
      (id,workspace_id,purchase_order_id,event,detail,actor_user_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [newId('poevt'), values.workspaceId, values.recordId, values.type,
      JSON.stringify(values.detail || {}), values.actorId || null, values.at]);
    return;
  }
  await client.query(`INSERT INTO sales_order_events
    (id,workspace_id,sales_order_id,event_type,detail,actor_user_id,idempotency_key,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
  [newId('soevt'), values.workspaceId, values.recordId, values.type,
    JSON.stringify(values.detail || {}), values.actorId || null, values.key, values.at]);
}

function transaction(database, operation) {
  return database.transaction(operation, { isolation: 'SERIALIZABLE', retrySafe: true });
}

async function createPurchaseOrderInTransaction(client, rawContext, input) {
  const ctx = requireContext(rawContext);
  if (!Array.isArray(input.lines) || !input.lines.length) throw new ValidationError('A purchase order needs at least one line.');
    await requirePermission(client, ctx, access.CREATE_PO, 'prepare purchase orders');
    const operation = await beginOperation(client, ctx, 'purchase_order.create', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const supplier = await requireRow(client, 'SELECT * FROM suppliers WHERE id=$1 AND workspace_id=$2 AND status=$3',
      [input.supplierId, ctx.workspaceId, 'active'], 'Choose an active supplier from this inventory.');
    const at = nowIso();
    const resolved = [];
    for (const [index, line] of input.lines.entries()) {
      const sku = await requireRow(client, `SELECT s.id,i.name FROM skus s JOIN items i ON i.id=s.item_id
        WHERE s.id=$1 AND s.workspace_id=$2 AND s.is_active=1 AND i.is_active=1`,
      [line.skuId, ctx.workspaceId], `Purchase-order line ${index + 1} has an unavailable SKU.`);
      const supplierItemResult = await client.query(`SELECT * FROM supplier_items
        WHERE workspace_id=$1 AND supplier_id=$2 AND sku_id=$3 AND is_active=1`,
      [ctx.workspaceId, supplier.id, sku.id]);
      const supplierItem = supplierItemResult.rows[0] || null;
      const unitsPer = positiveInteger(line.unitsPerPurchaseUnit ?? supplierItem?.units_per_purchase_unit ?? 1,
        `Line ${index + 1} pack size`);
      const purchaseUnits = positiveInteger(line.quantityPurchaseUnits ??
        Math.ceil(positiveInteger(line.quantityUnits, `Line ${index + 1} quantity`) / unitsPer),
      `Line ${index + 1} purchase quantity`);
      const quantityUnits = purchaseUnits * unitsPer;
      const unitCost = line.unitCost === undefined || line.unitCost === null
        ? (supplierItem?.last_unit_cost === null || supplierItem?.last_unit_cost === undefined
          ? null : Number(supplierItem.last_unit_cost)) : Number(line.unitCost);
      let resolvedCost=unitCost;if(resolvedCost===null){const fallback=await require('../pricing/postgres-service').purchaseCost(client,ctx.workspaceId,sku.id);if(fallback?.currency===(input.currency||supplier.currency||'USD'))resolvedCost=Number(require('../domain/currency').fromMinor(fallback.amount_minor,fallback.currency));}
      if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0)) {
        throw new ValidationError(`Line ${index + 1} unit cost is invalid.`);
      }
      const locationId = line.destinationLocationId || input.destinationLocationId;
      await requireRow(client, 'SELECT id FROM locations WHERE id=$1 AND workspace_id=$2 AND is_active=1',
        [locationId, ctx.workspaceId], `Purchase-order line ${index + 1} needs an active destination location.`);
      resolved.push({ sku, supplierItem, unitsPer, purchaseUnits, quantityUnits, unitCost:resolvedCost,
        locationId, description: trimOrNull(line.description) || supplierItem?.supplier_description || sku.name,
        purchaseUnit: trimOrNull(line.purchaseUnit) || supplierItem?.purchase_unit || 'unit',
        supplierSku: trimOrNull(line.supplierSku) || supplierItem?.supplier_sku || null,
        notes: trimOrNull(line.notes) });
    }
    const id = newId('po');
    const poNumber = trimOrNull(input.poNumber) || await numbered(client, ctx.workspaceId, 'purchase_orders', 'PO');
    const orderDate = dateOnly(input.orderDate || at.slice(0, 10), 'Order date');
    const leads=resolved.map(l=>l.supplierItem?.lead_time_days??supplier.default_lead_time_days).filter(v=>v!=null).map(Number);let expectedDate=input.expectedDate?dateOnly(input.expectedDate,'Expected date'):null;if(!expectedDate&&leads.length){const date=new Date(orderDate+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+Math.max(...leads));expectedDate=date.toISOString().slice(0,10);}
    await client.query(`INSERT INTO purchase_orders
      (id,workspace_id,po_number,supplier_id,status,order_date,expected_date,expected_date_source,
       destination_location_id,currency,notes,source,source_detail,created_by_user_id,integrity_hash,reference,created_at,updated_at)
      VALUES($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)`,
    [id, ctx.workspaceId, poNumber, supplier.id, orderDate, expectedDate,
      input.expectedDate ? 'manual' : expectedDate?(resolved.some(l=>l.supplierItem?.lead_time_days!=null)?'supplier_item':'supplier_default'):'unknown', input.destinationLocationId || null,
      input.currency || supplier.currency || 'USD', trimOrNull(input.notes), input.source || 'manual',
      JSON.stringify(input.sourceDetail || {}), ctx.actorId, crypto.createHash('sha256').update(JSON.stringify(resolved)).digest('hex'), trimOrNull(input.reference), at]);
    const lineIds = [];
    for (const [index, line] of resolved.entries()) {
      const lineId = newId('pol'); lineIds.push(lineId);
      await client.query(`INSERT INTO purchase_order_lines
        (id,workspace_id,purchase_order_id,line_number,sku_id,supplier_item_id,supplier_sku,description,
         purchase_unit,units_per_purchase_unit,quantity_purchase_units,quantity_units,quantity_received_units,
         unit_cost,line_total,destination_location_id,notes,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,$13,$14,$15,$16,$17)`,
      [lineId, ctx.workspaceId, id, index + 1, line.sku.id, line.supplierItem?.id || null,
        line.supplierSku, line.description, line.purchaseUnit, line.unitsPer, line.purchaseUnits,
        line.quantityUnits, line.unitCost, line.unitCost === null ? null : line.unitCost * line.quantityUnits,
        line.locationId, line.notes, at]);
    }
    await event(client, 'purchase_order_events', null, { workspaceId: ctx.workspaceId, recordId: id,
      type: 'created', detail: { lineCount: lineIds.length }, actorId: ctx.actorId, at });
    const result = { purchaseOrderId: id, poNumber, status: 'DRAFT', lineIds };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
}

async function createPurchaseOrder(database, rawContext, input) {
  return transaction(database, (client) => createPurchaseOrderInTransaction(client, rawContext, input));
}

async function reviseDraftPurchaseOrderLineInTransaction(client, rawContext, purchaseOrderId, input) {
  const ctx = requireContext(rawContext);
  await requirePermission(client, ctx, access.CREATE_PO, 'edit draft purchase orders');
  const operation = await beginOperation(client, ctx, 'purchase_order.revise_draft_line', input.idempotencyKey);
  if (operation.replayed) return { ...operation.result, replayed: true };
  const order = await requireRow(client, `SELECT id,status,updated_at,integrity_hash FROM purchase_orders
    WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [purchaseOrderId, ctx.workspaceId],
  'That purchase order was not found.');
  if (!['DRAFT', 'AWAITING_APPROVAL'].includes(order.status)) throw new ValidationError(
    'Only an unapproved draft purchase order can be revised; nothing changed.');
  if (input.expectedUpdatedAt && new Date(order.updated_at).toISOString() !== input.expectedUpdatedAt)
    throw new ValidationError('This draft changed after review. Ask again before revising it.');
  const line = await requireRow(client, `SELECT id,sku_id,quantity_units,quantity_purchase_units,
    units_per_purchase_unit,unit_cost,quantity_received_units FROM purchase_order_lines
    WHERE id=$1 AND purchase_order_id=$2 AND workspace_id=$3 FOR UPDATE`,
  [input.lineId, purchaseOrderId, ctx.workspaceId], 'That purchase-order line was not found.');
  if (Number(line.quantity_received_units) !== 0) throw new ValidationError(
    'Received purchase-order goods cannot be revised as a draft.');
  if (input.expectedQuantityUnits != null && Number(line.quantity_units) !== Number(input.expectedQuantityUnits))
    throw new ValidationError('The ordered quantity changed after review. Ask again before revising it.');
  const quantityUnits = positiveInteger(input.quantityUnits, 'Revised stock-unit quantity');
  const unitsPer = positiveInteger(line.units_per_purchase_unit, 'Purchase pack size');
  if (quantityUnits % unitsPer !== 0) throw new ValidationError(
    `Order a multiple of ${unitsPer} stock units for this supplier pack.`);
  const at = nowIso();
  await client.query(`UPDATE purchase_order_lines SET quantity_units=$4::bigint,
    quantity_purchase_units=$5::bigint,
    line_total=CASE WHEN unit_cost IS NULL THEN NULL ELSE unit_cost*($4::bigint) END
    WHERE workspace_id=$1 AND purchase_order_id=$2 AND id=$3`,
  [ctx.workspaceId, purchaseOrderId, line.id, quantityUnits, quantityUnits / unitsPer]);
  const hash = crypto.createHash('sha256').update(JSON.stringify({previous:order.integrity_hash,
    lineId:line.id,from:Number(line.quantity_units),to:quantityUnits})).digest('hex');
  await client.query(`UPDATE purchase_orders SET updated_at=$3,integrity_hash=$4
    WHERE id=$1 AND workspace_id=$2`, [purchaseOrderId, ctx.workspaceId, at, hash]);
  await event(client, 'purchase_order_events', null, { workspaceId:ctx.workspaceId,
    recordId:purchaseOrderId, type:'draft_line_revised', actorId:ctx.actorId, at,
    detail:{lineId:line.id,skuId:line.sku_id,from:Number(line.quantity_units),to:quantityUnits} });
  const result={purchaseOrderId,lineId:line.id,quantityUnits,
    unitCost:line.unit_cost==null?null:Number(line.unit_cost),
    lineTotal:line.unit_cost==null?null:Number(line.unit_cost)*quantityUnits,status:order.status};
  await completeOperation(client, operation, result);
  return {...result,replayed:false};
}

function reviseDraftPurchaseOrderLine(database, ctx, purchaseOrderId, input) {
  return transaction(database, (client) => reviseDraftPurchaseOrderLineInTransaction(client,ctx,purchaseOrderId,input));
}

async function reviseDraftPurchaseOrderReference(database, rawContext, purchaseOrderId, input) {
  const ctx=requireContext(rawContext);
  return transaction(database,async client=>{
    await requirePermission(client,ctx,access.CREATE_PO,'correct a draft purchase-order reference');
    const operation=await beginOperation(client,ctx,'purchase_order.revise_draft_reference',input.idempotencyKey);
    if(operation.replayed)return {...operation.result,replayed:true};
    const reference=trimOrNull(input.reference);
    if(!reference||!Object.hasOwn(input,'expectedReference')||!input.expectedUpdatedAt)
      throw new ValidationError('Review the exact reference and current draft before correcting it.');
    const order=await requireRow(client,'SELECT * FROM purchase_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,purchaseOrderId],'That purchase order was not found.');
    if(order.status!=='DRAFT'||trimOrNull(order.reference)!==trimOrNull(input.expectedReference)||new Date(order.updated_at).toISOString()!==input.expectedUpdatedAt)
      throw new ValidationError('This draft changed after review. Nothing was corrected.');
    const at=nowIso(),integrity=crypto.createHash('sha256').update(JSON.stringify({previous:order.integrity_hash,reference})).digest('hex');
    await client.query('UPDATE purchase_orders SET reference=$3,updated_at=$4,integrity_hash=$5 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,purchaseOrderId,reference,at,integrity]);
    await event(client,'purchase_order_events',null,{workspaceId:ctx.workspaceId,recordId:purchaseOrderId,type:'draft_reference_revised',actorId:ctx.actorId,at,detail:{from:order.reference,to:reference,approvalReference:trimOrNull(input.approvalReference)}});
    const result={purchaseOrderId,reference,status:'DRAFT'};await completeOperation(client,operation,result);return {...result,replayed:false};
  });
}

async function approvePurchaseOrder(database, rawContext, purchaseOrderId, input) {
  const ctx = requireContext(rawContext);
  return transaction(database, async (client) => {
    await requirePermission(client, ctx, access.APPROVE_PO, 'approve purchase orders');
    const operation = await beginOperation(client, ctx, 'purchase_order.approve', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const order = await requireRow(client, `SELECT * FROM purchase_orders
      WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [purchaseOrderId, ctx.workspaceId], 'That purchase order was not found.');
    if (!['DRAFT', 'AWAITING_APPROVAL', 'APPROVED'].includes(order.status)) {
      throw new ValidationError('Only a draft purchase order can be approved.');
    }
    const missing = await client.query(`SELECT COUNT(*) AS count FROM purchase_order_lines
      WHERE purchase_order_id=$1 AND workspace_id=$2 AND unit_cost IS NULL`, [purchaseOrderId, ctx.workspaceId]);
    if (Number(missing.rows[0].count)) throw new ValidationError('Every purchase-order line needs an approved cost.');
    const at = nowIso();
    await client.query(`UPDATE purchase_orders SET status='APPROVED',approved_by_user_id=$3,
      approved_at=COALESCE(approved_at,$4),updated_at=$4 WHERE id=$1 AND workspace_id=$2`,
    [purchaseOrderId, ctx.workspaceId, ctx.actorId, at]);
    await event(client, 'purchase_order_events', null, { workspaceId: ctx.workspaceId, recordId: purchaseOrderId,
      type: 'approved', actorId: ctx.actorId, at });
    const result = { purchaseOrderId, status: 'APPROVED' };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
  });
}

async function placePurchaseOrder(database, rawContext, purchaseOrderId, input) {
  const ctx = requireContext(rawContext);
  return transaction(database, async (client) => {
    await requirePermission(client, ctx, access.APPROVE_PO, 'place purchase orders');
    const operation = await beginOperation(client, ctx, 'purchase_order.place', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const order = await requireRow(client, `SELECT * FROM purchase_orders
      WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [purchaseOrderId, ctx.workspaceId], 'That purchase order was not found.');
    if (!['APPROVED', 'ORDERED'].includes(order.status)) throw new ValidationError('Approve the purchase order before placing it.');
    const at = nowIso();
    await client.query(`UPDATE purchase_orders SET status='ORDERED',ordered_at=COALESCE(ordered_at,$3),updated_at=$3
      WHERE id=$1 AND workspace_id=$2`, [purchaseOrderId, ctx.workspaceId, at]);
    await event(client, 'purchase_order_events', null, { workspaceId: ctx.workspaceId, recordId: purchaseOrderId,
      type: 'ordered', detail: { externalReference: input.externalReference || null }, actorId: ctx.actorId, at });
    const result = { purchaseOrderId, status: 'ORDERED' };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
  });
}

async function cancelPurchaseOrderInTransaction(client,rawContext,purchaseOrderId,input={}){
  const ctx=requireContext(rawContext);
  await requirePermission(client,ctx,access.APPROVE_PO,'cancel purchase orders');
  const operation=await beginOperation(client,ctx,'purchase_order.cancel',input.idempotencyKey);
  if(operation.replayed)return {...operation.result,replayed:true};
  const order=await requireRow(client,`SELECT * FROM purchase_orders
    WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,[purchaseOrderId,ctx.workspaceId],
  'That purchase order was not found.');
  if(['RECEIVED','CANCELLED'].includes(order.status))throw new ValidationError(
    'That purchase order can no longer be cancelled.');
  const at=nowIso(),reason=trimOrNull(input.reason);
  await client.query(`UPDATE purchase_orders SET status='CANCELLED',cancel_reason=$3,
    cancelled_by_user_id=$4,cancelled_at=$5,updated_at=$5 WHERE workspace_id=$1 AND id=$2`,
  [ctx.workspaceId,purchaseOrderId,reason,ctx.actorId,at]);
  await event(client,'purchase_order_events',null,{workspaceId:ctx.workspaceId,
    recordId:purchaseOrderId,type:'cancelled',detail:{reason},actorId:ctx.actorId,at});
  const result={purchaseOrderId,status:'CANCELLED'};
  await completeOperation(client,operation,result);
  return {...result,replayed:false};
}
async function cancelPurchaseOrder(database,ctx,purchaseOrderId,input){
  return transaction(database,(client)=>cancelPurchaseOrderInTransaction(client,ctx,purchaseOrderId,input));
}

async function receivePurchaseOrderInTransaction(client, rawContext, purchaseOrderId, input) {
  const ctx = requireContext(rawContext);
  if (!Array.isArray(input.lines) || !input.lines.length) throw new ValidationError('Select at least one purchase-order line to receive.');
    await requirePermission(client, ctx, access.RECEIVE_PO, 'book in deliveries');
    const operation = await beginOperation(client, ctx, 'purchase_order.receive', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const order = await requireRow(client, `SELECT * FROM purchase_orders
      WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [purchaseOrderId, ctx.workspaceId], 'That purchase order was not found.');
    if (!['ORDERED', 'PARTIALLY_RECEIVED'].includes(order.status)) {
      throw new ValidationError('Only a placed purchase order can be received.');
    }
    const at = input.receivedAt || nowIso();
    const receiptId = newId('poreceipt');
    const movementGroupIds = [];
    const received = [];
    await client.query(`INSERT INTO purchase_order_receipts
      (id,workspace_id,purchase_order_id,idempotency_key,received_by_user_id,received_at,reference,note,
       over_receipt_approved,movement_group_ids,result,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]','{}',$10)`,
    [receiptId, ctx.workspaceId, purchaseOrderId, input.idempotencyKey, ctx.actorId, at,
      trimOrNull(input.reference), trimOrNull(input.note), input.overReceiptApproved ? 1 : 0, nowIso()]);
    for (const [index, requested] of input.lines.entries()) {
      const line = await requireRow(client, `SELECT pol.*,s.item_id FROM purchase_order_lines pol
        JOIN skus s ON s.id=pol.sku_id WHERE pol.id=$1 AND pol.purchase_order_id=$2
        AND pol.workspace_id=$3 FOR UPDATE`, [requested.lineId, purchaseOrderId, ctx.workspaceId],
      `Receipt line ${index + 1} is not on this purchase order.`);
      const quantity = positiveInteger(requested.quantity, `Receipt line ${index + 1} quantity`);
      const outstanding = Number(line.quantity_units) - Number(line.quantity_received_units);
      const overBy = Math.max(0, quantity - outstanding);
      if (overBy && !input.overReceiptApproved) {
        throw new ValidationError(`Receipt line ${index + 1} exceeds the ordered quantity by ${overBy}.`);
      }
      const locationId = requested.locationId || line.destination_location_id || order.destination_location_id;
      const physical = await inventory.receiveInTransaction(client, ctx, {
        skuId: line.sku_id, locationId, quantity, lotId: requested.lotId,
        lotCode: requested.lotCode, expiresAt: requested.expiresAt, serials: requested.serials,
        reference: input.reference || order.po_number, notes: input.note,
        occurredAt: at, idempotencyKey: `${input.idempotencyKey}:line:${line.id}`,
      });
      const unitCostMinor = Math.round(Number(line.unit_cost) * 100);
      const totalCostMinor = unitCostMinor * quantity;
      if(totalCostMinor===0)await ledger.validatePostingDateInTransaction(client,ctx,at.slice(0,10));
      const posted = totalCostMinor===0?null:await ledger.postInTransaction(client, ctx, {
        postingDate: at.slice(0, 10), sourceKey: `purchase-receipt:${receiptId}:${line.id}`,
        description: `Receive ${quantity} units on ${order.po_number}`, sourceType: 'purchase_receipt',
        sourceRecordType: 'purchase_order_receipt', sourceRecordId: receiptId,
        currency: order.currency,
        metadata: { purchaseOrderId, purchaseOrderLineId: line.id, movementId: physical.movementId },
        lines: [
          { accountKey: 'INVENTORY_ASSET', debitMinor: totalCostMinor, supplierId: order.supplier_id,
            itemId: line.item_id, skuId: line.sku_id, locationId },
          { accountKey: 'RECEIVED_NOT_INVOICED', creditMinor: totalCostMinor, supplierId: order.supplier_id,
            itemId: line.item_id, skuId: line.sku_id, locationId },
        ],
      });
      await costing.receiveInTransaction(client, ctx, { movementId: physical.movementId, unitCostMinor,
        totalCostMinor, journalEntryId: posted?.entry.id||null, sourceType: 'purchase_order_receipt', sourceRecordId: receiptId });
      await client.query(`UPDATE purchase_order_lines SET quantity_received_units=quantity_received_units+$4
        WHERE id=$1 AND purchase_order_id=$2 AND workspace_id=$3`, [line.id, purchaseOrderId, ctx.workspaceId, quantity]);
      await client.query(`INSERT INTO purchase_order_receipt_lines
        (id,workspace_id,receipt_id,purchase_order_line_id,sku_id,location_id,quantity_units,lot_id,lot_code,
         expires_at,serials,over_by_units,movement_ids,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [newId('porline'), ctx.workspaceId, receiptId, line.id, line.sku_id, locationId, quantity,
        physical.lotId, requested.lotCode || null, requested.expiresAt || null,
        JSON.stringify(requested.serials || []), overBy, JSON.stringify([physical.movementId]), nowIso()]);
      movementGroupIds.push(physical.groupId);
      received.push({ lineId: line.id, quantity, movementId: physical.movementId,
        journalEntryId: posted?.entry.id||null, totalCostMinor, overBy });
    }
    const totals = await client.query(`SELECT COUNT(*) FILTER (WHERE quantity_received_units < quantity_units) AS open
      FROM purchase_order_lines WHERE purchase_order_id=$1 AND workspace_id=$2`, [purchaseOrderId, ctx.workspaceId]);
    const status = Number(totals.rows[0].open) ? 'PARTIALLY_RECEIVED' : 'RECEIVED';
    await client.query(`UPDATE purchase_orders SET status=$3,updated_at=$4,
      completed_at=CASE WHEN $3='RECEIVED' THEN $4 ELSE completed_at END WHERE id=$1 AND workspace_id=$2`,
    [purchaseOrderId, ctx.workspaceId, status, nowIso()]);
    const result = { purchaseOrderId, receiptId, status, lines: received };
    await client.query(`UPDATE purchase_order_receipts SET movement_group_ids=$2,result=$3 WHERE id=$1`,
      [receiptId, JSON.stringify(movementGroupIds), JSON.stringify(result)]);
    await event(client, 'purchase_order_events', null, { workspaceId: ctx.workspaceId, recordId: purchaseOrderId,
      type: 'received', detail: { receiptId, status, lines: received }, actorId: ctx.actorId, at: nowIso() });
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
}

async function receivePurchaseOrder(database, rawContext, purchaseOrderId, input) {
  return transaction(database, (client) => receivePurchaseOrderInTransaction(client, rawContext, purchaseOrderId, input));
}

async function recordSupplierInvoice(database, rawContext, input, {preview=false,recheckId=null}={}) {
  const ctx = requireContext(rawContext);
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length>500) throw new ValidationError('A supplier invoice needs between one and 500 lines.');
  return transaction(database, async (client) => {
    await requirePermission(client, ctx, access.MANAGE_ACCOUNTING, 'record supplier invoices');
    const operation = preview?null:await beginOperation(client, ctx, recheckId?'supplier_invoice.recheck':'supplier_invoice.record', input.idempotencyKey);
    if (operation?.replayed) return { ...operation.result, replayed: true };
    const supplier = await requireRow(client, 'SELECT * FROM suppliers WHERE id=$1 AND workspace_id=$2'+(preview?'':' FOR UPDATE'),
      [input.supplierId, ctx.workspaceId], 'That supplier was not found.');
    const issueDate = dateOnly(input.issueDate || nowIso().slice(0, 10), 'Supplier invoice date');
    const purchaseOrder = input.purchaseOrderId ? await requireRow(client, `SELECT * FROM purchase_orders
      WHERE id=$1 AND workspace_id=$2 ${preview?'':'FOR UPDATE'}`, [input.purchaseOrderId, ctx.workspaceId], 'That purchase order was not found.') : null;
    if (purchaseOrder && purchaseOrder.supplier_id !== supplier.id) throw new ValidationError('The supplier invoice does not match the purchase order supplier.');
    const reviewed=recheckId?await requireRow(client,'SELECT * FROM accounting_supplier_bills WHERE workspace_id=$1 AND id=$2'+(preview?'':' FOR UPDATE'),[ctx.workspaceId,recheckId],'That invoice is not in this business.'):null;
    if(reviewed&&(!['DRAFT','DISPUTED'].includes(reviewed.status)||reviewed.journal_entry_id||reviewed.opened_at))throw new ValidationError('Only unposted disputed invoices can be rechecked. Posted bills retain their accounting history.');
    if(reviewed&&(reviewed.supplier_id!==supplier.id||reviewed.purchase_order_id!==(input.purchaseOrderId||null)||!reviewed.invoice_input))throw new ValidationError('This bill needs an evidenced accounting review before it can be rechecked.');
    if(reviewed&&!preview&&input.expectedBillRevision!==Number(reviewed.review_revision))throw new ValidationError('This invoice review changed. Reload the current evidence.');
    const dueDate=input.dueDate?dateOnly(input.dueDate,'Invoice due date'):null;
    if(dueDate&&dueDate<issueDate)throw new ValidationError('The due date cannot precede the invoice date.');
    const invoiceNumber=trimOrNull(input.supplierInvoiceNumber);if(invoiceNumber&&invoiceNumber.length>80)throw new ValidationError('Use the exact supplier invoice number, up to 80 characters.');
    const currency=require('../pricing/postgres-service').normaliseCurrency(input.currency||purchaseOrder?.currency||supplier.currency||'USD');
    if(input.sourceMessageId){const message=await requireRow(client,'SELECT id,supplier_id FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,input.sourceMessageId],'That invoice email is not in this business.');if(message.supplier_id!==supplier.id)throw new ValidationError('The invoice email does not belong to this supplier.');
      if(input.sourceAttachmentHash)await requireRow(client,'SELECT id FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2 AND content_hash=$3 AND extraction_status=\'READABLE\'',[ctx.workspaceId,input.sourceMessageId,input.sourceAttachmentHash],'The invoice attachment must be completely readable and belong to the source email.');}
    else if(input.sourceAttachmentHash)throw new ValidationError('An attachment needs its source email.');
    const documentFingerprint=require('../pricing/postgres-promotions').hash({supplierId:supplier.id,purchaseOrderId:input.purchaseOrderId||null,invoiceNumber,issueDate,dueDate,currency,lines:input.lines,charges:input.charges||[],taxMinor:input.taxMinor||0,documentTotalMinor:input.documentTotalMinor??null,sourceMessageId:input.sourceMessageId||null,sourceAttachmentHash:input.sourceAttachmentHash||null});
    if(reviewed&&reviewed.document_fingerprint!==documentFingerprint)throw new ValidationError('The original invoice evidence changed. A recheck cannot rewrite the supplier document.');
    if(invoiceNumber){const prior=(await client.query("SELECT id,bill_number,status,match_status,total_minor,balance_minor,journal_entry_id,document_fingerprint FROM accounting_supplier_bills WHERE workspace_id=$1 AND supplier_id=$2 AND lower(supplier_invoice_number)=lower($3) AND status<>'VOID'",[ctx.workspaceId,supplier.id,invoiceNumber])).rows[0];if(prior&&prior.id!==reviewed?.id){if(prior.document_fingerprint!==documentFingerprint)throw new ValidationError('That supplier invoice number already exists with different evidence. Review the recorded bill rather than creating a duplicate.');const result={billId:prior.id,billNumber:prior.bill_number,status:prior.status,matchStatus:prior.match_status,totalMinor:Number(prior.total_minor),balanceMinor:Number(prior.balance_minor),journalEntryId:prior.journal_entry_id};if(operation)await completeOperation(client,operation,result);return {...result,replayed:true};}}
    const prepared = [];
    let subtotal = 0;
    let matchStatus = purchaseOrder ? 'MATCHED' : 'NOT_MATCHED';
    const differences = [];
    if(purchaseOrder&&currency!==purchaseOrder.currency){matchStatus='EXCEPTION';differences.push({kind:'invoice_currency_differs',approvedCurrency:purchaseOrder.currency,billedCurrency:currency});}
    if(purchaseOrder&&!['ORDERED','PARTIALLY_RECEIVED','RECEIVED'].includes(purchaseOrder.status)){matchStatus='EXCEPTION';differences.push({kind:'purchase_order_not_placed',status:purchaseOrder.status});}
    const quantitiesThisDocument=new Map();
    const journalLines = [];
    const allSkus=(await client.query('SELECT id FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,input.lines.map(l=>l?.skuId).filter(Boolean)])).rows,allItems=(await client.query('SELECT id FROM items WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,input.lines.map(l=>l?.itemId).filter(Boolean)])).rows;
    const purchaseLines=purchaseOrder?(await client.query(`SELECT * FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2 ${preview?'':'FOR UPDATE'}`,[ctx.workspaceId,purchaseOrder.id])).rows:[],byPoLine=new Map(purchaseLines.map(l=>[l.id,l]));
    const billedLines=purchaseOrder?(await client.query(`SELECT bl.purchase_order_line_id,sum(bl.quantity) AS quantity FROM accounting_supplier_bill_lines bl JOIN accounting_supplier_bills b ON b.id=bl.bill_id AND b.workspace_id=bl.workspace_id WHERE bl.workspace_id=$1 AND b.purchase_order_id=$2 AND b.status IN ('OPEN','PARTIALLY_PAID','PAID') GROUP BY bl.purchase_order_line_id`,[ctx.workspaceId,purchaseOrder.id])).rows:[],billedByLine=new Map(billedLines.map(l=>[l.purchase_order_line_id,Number(l.quantity)]));
    for (const [index, line] of input.lines.entries()) {
      if(!line||typeof line!=='object'||Array.isArray(line))throw new ValidationError('Each supplier invoice line needs valid document fields.');
      const quantity = Number(line.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0 || !/^\d+(?:\.\d{1,6})?$/.test(String(quantity))) throw new ValidationError(`Supplier invoice line ${index + 1} quantity is invalid.`);
      const unitCostMinor = nonNegativeMinor(line.unitCostMinor, `Supplier invoice line ${index + 1} cost`);
      const lineTotalMinor = priceCalculator.ratio(unitCostMinor,Math.round(quantity*1000000),1000000);
      if(!Number.isSafeInteger(lineTotalMinor)||!Number.isSafeInteger(subtotal+lineTotalMinor))throw new ValidationError('The invoice line total exceeds the supported accounting range.');
      if(line.skuId&&!allSkus.some(s=>s.id===line.skuId))throw new ValidationError('The invoice product is not in this business.');
      if(line.itemId&&!allItems.some(i=>i.id===line.itemId))throw new ValidationError('The invoice item is not in this business.');
      let purchaseLine = null, billedUnits=0;
      if (line.purchaseOrderLineId) {
        purchaseLine=byPoLine.get(line.purchaseOrderLineId);if(!purchaseLine)throw new ValidationError(`Supplier invoice line ${index+1} does not match this purchase order.`);
        if(line.skuId&&line.skuId!==purchaseLine.sku_id)throw new ValidationError('The invoice SKU does not match its purchase-order line.');
        billedUnits=billedByLine.get(purchaseLine.id)||0;const documentQuantity=(quantitiesThisDocument.get(purchaseLine.id)||0)+quantity;quantitiesThisDocument.set(purchaseLine.id,documentQuantity);
        if (billedUnits + documentQuantity > Number(purchaseLine.quantity_received_units)) {
          matchStatus = 'EXCEPTION';
          differences.push({ line: index + 1, kind: 'invoice_ahead_of_receipt',
            received: Number(purchaseLine.quantity_received_units),
            previouslyBilled: billedUnits, billed: quantity });
        }
        const approvedUnitCostMinor = Math.round(Number(purchaseLine.unit_cost) * 100);
        if (unitCostMinor !== approvedUnitCostMinor) {
          matchStatus = 'EXCEPTION';
          differences.push({ line: index + 1, kind: 'price_outside_approved_cost',
            approvedUnitCostMinor, billedUnitCostMinor: unitCostMinor });
        }
      } else if (purchaseOrder) {
        matchStatus = 'EXCEPTION';
        differences.push({ line: index + 1, kind: 'missing_purchase_order_line' });
      }
      subtotal += lineTotalMinor;
      prepared.push({ ...line, quantity, unitCostMinor, lineTotalMinor, purchaseLine,billedUnits });
      journalLines.push({ accountKey: purchaseLine ? 'RECEIVED_NOT_INVOICED' : 'OPERATING_EXPENSE',
        debitMinor: lineTotalMinor, supplierId: supplier.id, skuId: line.skuId || purchaseLine?.sku_id || null,
        memo: line.description });
    }
    const taxMinor = nonNegativeMinor(input.taxMinor || 0, 'Supplier invoice tax');
    const charges=input.charges||[];if(!Array.isArray(charges)||charges.length>50)throw new ValidationError('Use at most 50 explicit invoice charges.');
    let chargesMinor=0;for(const charge of charges){if(!charge||!['freight','insurance','duty','discount','other'].includes(charge.kind)||!trimOrNull(charge.label)||String(charge.label).length>240||!Number.isSafeInteger(charge.amountMinor)||(charge.kind==='discount'?charge.amountMinor>0:charge.amountMinor<0))throw new ValidationError('Every charge needs its document label, supported kind and exact signed minor amount. Tax belongs in the invoice tax field.');chargesMinor+=charge.amountMinor;if(!Number.isSafeInteger(chargesMinor))throw new ValidationError('The invoice charges exceed the accounting range.');journalLines.push({accountKey:'OPERATING_EXPENSE',...(charge.amountMinor<0?{creditMinor:-charge.amountMinor}:{debitMinor:charge.amountMinor}),supplierId:supplier.id,memo:charge.label});}
    if (taxMinor) journalLines.push({ accountKey: 'SALES_TAX_RECOVERABLE', debitMinor: taxMinor, supplierId: supplier.id });
    const totalMinor = subtotal + taxMinor+chargesMinor;
    if(!Number.isSafeInteger(totalMinor)||totalMinor<=0)throw new ValidationError('A supplier invoice must have a positive, supported total. Use a supplier credit for a credit document.');
    if(input.documentTotalMinor!==undefined&&input.documentTotalMinor!==null){nonNegativeMinor(input.documentTotalMinor,'Document total');if(input.documentTotalMinor!==totalMinor){matchStatus='EXCEPTION';differences.push({kind:'document_total_differs',documentTotalMinor:input.documentTotalMinor,calculatedTotalMinor:totalMinor});}}
    if(purchaseOrder&&chargesMinor){matchStatus='EXCEPTION';differences.push({kind:'additional_charges_require_review',chargesMinor});}
    journalLines.push({ accountKey: 'ACCOUNTS_PAYABLE', creditMinor: totalMinor, supplierId: supplier.id });
    const billId = reviewed?.id||newId('apbill');
    const sourceKey = reviewed?.source_key||input.sourceKey || `supplier-invoice:${supplier.id}:${input.supplierInvoiceNumber || input.idempotencyKey}`;
    const previewResult={preview:true,status:matchStatus==='EXCEPTION'?'DISPUTED':'OPEN',matchStatus,differences,subtotalMinor:subtotal,chargesMinor,taxMinor,totalMinor,currency,issueDate,dueDate,documentFingerprint,
      matchFingerprint:require('../pricing/postgres-promotions').hash({documentFingerprint,differences,received:prepared.map(l=>({lineId:l.purchaseLine?.id||null,received:l.purchaseLine?.quantity_received_units||0,cost:l.purchaseLine?.unit_cost||null,billed:l.billedUnits})),matchStatus}),lines:prepared.map(l=>({skuId:l.skuId||l.purchaseLine?.sku_id||null,description:l.description,quantity:l.quantity,unitCostMinor:l.unitCostMinor,lineTotalMinor:l.lineTotalMinor}))};
    if(preview)return previewResult;
    if(input.expectedMatchFingerprint&&input.expectedMatchFingerprint!==previewResult.matchFingerprint)throw new ValidationError('The invoice, purchase order or matched business state changed after approval. Review it again.');
    if(reviewed&&Number(reviewed.total_minor)!==totalMinor)throw new ValidationError('The rechecked invoice total does not match its original recorded amount.');
    const posted = matchStatus === 'EXCEPTION' ? null : await ledger.postInTransaction(client, ctx, {
      postingDate: issueDate, sourceKey: `journal:${sourceKey}`,
      description: `Supplier invoice ${input.supplierInvoiceNumber || ''}`.trim(),
      sourceType: 'supplier_invoice', sourceRecordType: 'supplier_bill', sourceRecordId: billId,
      currency, lines: journalLines,
    });
    const status = matchStatus === 'EXCEPTION' ? 'DISPUTED' : 'OPEN';
    if(reviewed){
      const reason=String(input.reviewReason||'').trim();if(!reason||reason.length>1000)throw new ValidationError('Explain why this invoice is being rechecked, up to 1000 characters.');
      const details=typeof reviewed.exception_detail==='string'?JSON.parse(reviewed.exception_detail||'{}'):reviewed.exception_detail||{},reviews=[...(details.reviews||[]),{at:nowIso(),actorId:ctx.actorId,reason,priorDifferences:details.differences||[],matchFingerprint:previewResult.matchFingerprint,status}];
      await client.query(`UPDATE accounting_supplier_bills SET status=$3,match_status=$4,journal_entry_id=$5,opened_at=CASE WHEN $3='OPEN' THEN $6 ELSE NULL END,updated_at=$6,exception_detail=$7,review_revision=review_revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,billId,status,matchStatus,posted?.entry.id||null,nowIso(),JSON.stringify({differences,reviews})]);
      const result={billId,billNumber:reviewed.bill_number,status,matchStatus,differences,totalMinor,balanceMinor:totalMinor,journalEntryId:posted?.entry.id||null};await completeOperation(client,operation,result);return {...result,replayed:false};
    }
    const billNumber = trimOrNull(input.billNumber) || await numbered(client, ctx.workspaceId, 'accounting_supplier_bills', 'BILL');
    const at = nowIso();
    await client.query(`INSERT INTO accounting_supplier_bills
      (id,workspace_id,bill_number,supplier_id,purchase_order_id,purchase_receipt_id,supplier_invoice_number,
       issue_date,due_date,status,match_status,currency,subtotal_minor,tax_minor,total_minor,balance_minor,journal_entry_id,
       source_key,exception_detail,notes,created_by_user_id,created_at,updated_at,opened_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17,$18,$19,$20,$21,$21,
        CASE WHEN $10='OPEN' THEN $21 ELSE NULL END)`,
    [billId, ctx.workspaceId, billNumber, supplier.id, input.purchaseOrderId || null,
      input.purchaseReceiptId || null, invoiceNumber, issueDate, dueDate,
      status, matchStatus, currency, subtotal+chargesMinor,
      taxMinor, totalMinor, posted?.entry.id || null, sourceKey, JSON.stringify({ differences }),
      trimOrNull(input.notes), ctx.actorId, at]);
    const invoiceInput={supplierId:supplier.id,purchaseOrderId:input.purchaseOrderId||null,supplierInvoiceNumber:invoiceNumber,issueDate,dueDate,currency,lines:input.lines,charges,taxMinor,documentTotalMinor:input.documentTotalMinor??null,sourceMessageId:input.sourceMessageId||null,sourceAttachmentHash:input.sourceAttachmentHash||null};
    await client.query('UPDATE accounting_supplier_bills SET charges=$3::jsonb,document_total_minor=$4,source_message_id=$5,source_attachment_hash=$6,document_fingerprint=$7,invoice_input=$8::jsonb WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,billId,JSON.stringify(charges),input.documentTotalMinor??null,input.sourceMessageId||null,input.sourceAttachmentHash||null,documentFingerprint,JSON.stringify(invoiceInput)]);
    const defaultDebitAccountId = await accountId(client, ctx.workspaceId,
      purchaseOrder ? 'RECEIVED_NOT_INVOICED' : 'OPERATING_EXPENSE');
    for (const [index, line] of prepared.entries()) {
      await client.query(`INSERT INTO accounting_supplier_bill_lines
        (id,workspace_id,bill_id,line_number,description,quantity,unit_cost_minor,line_total_minor,debit_account_id,
         item_id,sku_id,purchase_order_line_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [newId('apline'), ctx.workspaceId, billId, index + 1, line.description || `Invoice line ${index + 1}`,
        line.quantity, line.unitCostMinor, line.lineTotalMinor, defaultDebitAccountId, line.itemId || null,
        line.skuId || line.purchaseLine?.sku_id || null, line.purchaseOrderLineId || null, at]);
    }
    const result = { billId, billNumber, status, matchStatus, differences,
      totalMinor, balanceMinor: totalMinor, journalEntryId: posted?.entry.id || null };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
  });
}

async function salesOrderDefaults(client,ctx,input){
    const customer = await requireRow(client, 'SELECT * FROM customers WHERE id=$1 AND workspace_id=$2 AND record_state=$3',
      [input.customerId, ctx.workspaceId, 'ACTIVE'], 'Choose an active customer from this inventory.');
    const requestedDeliveryMethod = String(input.deliveryMethod || 'SHIP').trim().toUpperCase();
    // An own-delivery order still has a shipping destination. Transport and
    // physical handoff are recorded by the shipment engine, not a third
    // sales-order delivery mode. Retain compatibility with prepared proposals.
    const deliveryMethod = requestedDeliveryMethod === 'OWN_DELIVERY' ? 'SHIP' : requestedDeliveryMethod;
    if (!['SHIP', 'PICKUP'].includes(deliveryMethod)) throw new ValidationError('Choose shipped delivery or customer pickup.');
    const addressWasSubmitted = input.shipToAddress !== undefined;
    const shipToAddress = addressWasSubmitted ? trimOrNull(input.shipToAddress) : trimOrNull(customer.shipping_address);
    if (deliveryMethod !== 'PICKUP' && !shipToAddress) {
      throw new ValidationError('A delivery destination is required before creating a shipped or business-delivered order.');
    }
    const contactEmail=input.customerEmail===undefined?customer.email:trimOrNull(input.customerEmail),contactPhone=input.customerPhone===undefined?customer.phone:trimOrNull(input.customerPhone);
    if(contactEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))throw new ValidationError('Enter a valid order contact email.');
    if(input.fulfillmentLocationId)await requireRow(client,'SELECT id FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1',[ctx.workspaceId,input.fulfillmentLocationId],'Choose a ship-from location in this inventory.');

    return {customer,deliveryMethod,shipToAddress,addressWasSubmitted,contactEmail,contactPhone};
}

async function createSalesOrderInTransaction(client, rawContext, input) {
  const ctx = requireContext(rawContext);
  if (!Array.isArray(input.lines) || !input.lines.length) throw new ValidationError('A sales order needs at least one line.');
    await requirePermission(client, ctx, access.OPERATE, 'create sales orders');
    const operation = await beginOperation(client, ctx, 'sales_order.create', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const promotions=require('../pricing/postgres-promotions'),quote=await promotions.prepareQuote(client,ctx,input,{lock:true});
    if(input.pricingQuoteHash&&promotions.quoteHash(quote)!==input.pricingQuoteHash)
      throw new ValidationError('The exact order pricing changed after review. Review the current totals before continuing.');
    if(quote.violations.length)throw new ValidationError('This order violates its pricing safeguards. Review its prices and recorded cost before continuing.');
    const {customer,deliveryMethod,shipToAddress,addressWasSubmitted,contactEmail,contactPhone}=await salesOrderDefaults(client,ctx,input);
    const at = nowIso();
    const id = newId('so');
    const orderNumber = trimOrNull(input.orderNumber) || await numbered(client, ctx.workspaceId, 'sales_orders', 'SO');
    await client.query(`INSERT INTO sales_orders
      (id,workspace_id,customer_id,order_number,order_date,needed_by,fulfillment_location_id,delivery_method,
       ship_to_address,ship_to_source,notes,reference,currency,discount_minor,tax_minor,status,version,
       created_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'DRAFT',1,$16,$17,$17)`,
    [id, ctx.workspaceId, customer.id, orderNumber, dateOnly(input.orderDate || at.slice(0, 10), 'Order date'),
      input.neededBy || null, input.fulfillmentLocationId || null, deliveryMethod,
      shipToAddress, addressWasSubmitted ? 'order' : 'customer',
      trimOrNull(input.notes), trimOrNull(input.reference), input.currency || 'USD',
      quote.discountMinor, quote.taxMinor, ctx.actorId, at]);
    await client.query('UPDATE sales_orders SET contact_email=$3,contact_phone=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,contactEmail,contactPhone]);
    const lineIds = [];
    for (const [index, line] of input.lines.entries()) {
      await requireRow(client, `SELECT id FROM skus WHERE id=$1 AND workspace_id=$2 AND is_active=1`,
        [line.skuId, ctx.workspaceId], `Sales-order line ${index + 1} has an unavailable SKU.`);
      if(quote.lines[index]?.skuId!==line.skuId||quote.lines[index]?.quantity!==Number(line.quantity))throw new ValidationError('The pricing quote must match every exact order line.');
      const lineId = newId('sol'); lineIds.push(lineId);
      await client.query(`INSERT INTO sales_order_lines
        (id,workspace_id,sales_order_id,sku_id,quantity_ordered,quantity_fulfilled,unit_price_minor,notes,created_at,updated_at,external_line_id)
        VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,$8,$9)`,
      [lineId, ctx.workspaceId, id, line.skuId, positiveInteger(line.quantity, `Sales-order line ${index + 1} quantity`),
        quote.lines[index].unitPriceMinor, trimOrNull(line.notes), at, trimOrNull(line.externalLineId)]);
    }
    await promotions.saveQuote(client,ctx,id,quote,lineIds);
    await event(client, 'sales_order_events', null, { workspaceId: ctx.workspaceId, recordId: id,
      type: 'created', detail: { lineCount: lineIds.length }, actorId: ctx.actorId,
      key: `${input.idempotencyKey}:event`, at });
    const result = { salesOrderId: id, orderNumber, status: 'DRAFT', lineIds,pricing:{subtotalMinor:quote.subtotalMinor,discountMinor:quote.discountMinor,taxMinor:quote.taxMinor,totalMinor:quote.totalMinor,currency:quote.currency} };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
}

async function createSalesOrder(database, rawContext, input) {
  return transaction(database, (client) => createSalesOrderInTransaction(client, rawContext, input));
}

async function editDraftSalesOrder(database,ctx,id,input){
 return transaction(database,async client=>{
  await requirePermission(client,ctx,access.OPERATE,'edit draft sales orders');
  const order=await requireRow(client,'SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id],'That order is not in this inventory.');
  if(order.status!=='DRAFT')throw new ValidationError('Only a draft order can be edited.');
  if(Number(input.expectedVersion)!==Number(order.version))throw new ValidationError('This order changed in another tab. Reload it before editing.');
  const history=(await client.query(`SELECT
    EXISTS(SELECT 1 FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2 AND status<>'VOID')
    OR EXISTS(SELECT 1 FROM accounting_payments WHERE workspace_id=$1 AND sales_order_id=$2 AND status='POSTED')
    OR EXISTS(SELECT 1 FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2)
    OR EXISTS(SELECT 1 FROM stockchief_runtime.pricing_order_snapshots WHERE workspace_id=$1 AND id=$3 AND quote->>'recordedAmounts'='true') AS protected`,
  [ctx.workspaceId,id,order.pricing_quote_id])).rows[0];
  if(history.protected)throw new ValidationError('This order has recorded financial or shipment history. Use a governed amendment or duplicate the order instead of replacing its draft lines.');
  if((await client.query('SELECT 1 FROM sales_order_allocations a JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id WHERE l.workspace_id=$1 AND l.sales_order_id=$2',[ctx.workspaceId,id])).rows.length)throw new ValidationError('This draft has stock commitments and cannot be replaced.');
  const {customer,deliveryMethod,shipToAddress,addressWasSubmitted,contactEmail,contactPhone}=await salesOrderDefaults(client,ctx,input),at=nowIso(),promotions=require('../pricing/postgres-promotions');
  const quote=await promotions.prepareQuote(client,ctx,input,{lock:true,orderId:id});
  if(quote.violations.length)throw new ValidationError('This order violates its pricing safeguards. Review its prices and recorded cost.');
  await client.query('DELETE FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,id]);
  const lineIds=[];for(const [index,line]of input.lines.entries()){const lineId=newId('sol');lineIds.push(lineId);await client.query(`INSERT INTO sales_order_lines(id,workspace_id,sales_order_id,sku_id,quantity_ordered,quantity_fulfilled,unit_price_minor,created_at,updated_at) VALUES($1,$2,$3,$4,$5,0,$6,$7,$7)`,[lineId,ctx.workspaceId,id,line.skuId,positiveInteger(line.quantity,'Line '+(index+1)+' quantity'),quote.lines[index].unitPriceMinor,at]);}
  await client.query(`UPDATE sales_orders SET customer_id=$3,contact_email=$4,contact_phone=$5,order_date=$6,needed_by=$7,fulfillment_location_id=$8,
    delivery_method=$9,ship_to_address=$10,ship_to_source=$11,notes=$12,reference=$13,currency=$14,version=version+1,updated_at=$15
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,customer.id,contactEmail,contactPhone,dateOnly(input.orderDate||at.slice(0,10),'Order date'),input.neededBy||null,input.fulfillmentLocationId||null,deliveryMethod,shipToAddress,addressWasSubmitted?'order':'customer',trimOrNull(input.notes),trimOrNull(input.reference),input.currency||'USD',at]);
  await promotions.saveQuote(client,ctx,id,quote,lineIds);
  await event(client,'sales_order_events',null,{workspaceId:ctx.workspaceId,recordId:id,type:'draft_edited',detail:{previousVersion:order.version},actorId:ctx.actorId,key:'draft-edit:'+id+':'+order.version,at:nowIso()});
  return {salesOrderId:id,orderNumber:order.order_number};
 });
}

async function confirmSalesOrderInTransaction(client, rawContext, salesOrderId, input) {
  const ctx = requireContext(rawContext);
    await requirePermission(client, ctx, access.OPERATE, 'confirm sales orders');
    const operation = await beginOperation(client, ctx, 'sales_order.confirm', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const order = await requireRow(client, `SELECT * FROM sales_orders WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
      [salesOrderId, ctx.workspaceId], 'That sales order was not found.');
    if (!['DRAFT', 'CONFIRMED', 'BACKORDERED'].includes(order.status)) throw new ValidationError('That sales order cannot be confirmed.');
    const lines = await client.query(`SELECT * FROM sales_order_lines
      WHERE sales_order_id=$1 AND workspace_id=$2 ORDER BY created_at,id FOR UPDATE`, [salesOrderId, ctx.workspaceId]);
    const skuIds = [...new Set(lines.rows.map((line) => line.sku_id))];
    await client.query(`SELECT b.sku_id,b.location_id FROM balances b JOIN locations l ON l.id=b.location_id
      WHERE b.workspace_id=$1 AND b.sku_id=ANY($2::text[]) AND l.is_active=1
        AND ($3::text IS NULL OR b.location_id=$3)
      ORDER BY b.sku_id,b.location_id FOR UPDATE OF b`,
    [ctx.workspaceId, skuIds, order.fulfillment_location_id]);
    const allocations = [];
    let short = false;
    for (const line of lines.rows) {
      let needed = Number(line.quantity_ordered) - Number(line.quantity_fulfilled);
      const existing = await client.query(`SELECT COALESCE(SUM(quantity),0) AS quantity FROM sales_order_allocations
        WHERE sales_order_line_id=$1 AND workspace_id=$2`, [line.id, ctx.workspaceId]);
      needed -= Number(existing.rows[0].quantity);
      const balances = await client.query(`SELECT b.location_id,b.on_hand,
          COALESCE((SELECT SUM(a.quantity) FROM sales_order_allocations a JOIN sales_order_lines ol ON ol.id=a.sales_order_line_id
            WHERE a.workspace_id=b.workspace_id AND a.location_id=b.location_id AND ol.sku_id=b.sku_id),0) AS committed
        FROM balances b JOIN locations l ON l.id=b.location_id
        WHERE b.workspace_id=$1 AND b.sku_id=$2 AND l.is_active=1
          AND ($3::text IS NULL OR b.location_id=$3) ORDER BY b.on_hand DESC,b.location_id`,
      [ctx.workspaceId, line.sku_id, order.fulfillment_location_id]);
      for (const balance of balances.rows) {
        if (needed <= 0) break;
        const available = Math.max(0, Number(balance.on_hand) - Number(balance.committed));
        const quantity = Math.min(needed, available);
        if (!quantity) continue;
        await client.query(`INSERT INTO sales_order_allocations
          (id,workspace_id,sales_order_line_id,location_id,quantity,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$6)
          ON CONFLICT(sales_order_line_id,location_id) DO UPDATE SET quantity=sales_order_allocations.quantity+EXCLUDED.quantity,
            updated_at=EXCLUDED.updated_at`,
        [newId('soa'), ctx.workspaceId, line.id, balance.location_id, quantity, nowIso()]);
        allocations.push({ lineId: line.id, locationId: balance.location_id, quantity });
        needed -= quantity;
      }
      if (needed > 0) short = true;
    }
    if (short && input.requireFullAllocation === true) throw new ValidationError(
      'The full order cannot be reserved from available stock. No confirmation or allocation was saved. Receive or transfer the missing stock, then try again.');
    const status = short ? 'BACKORDERED' : 'CONFIRMED';
    const at = nowIso();
    await client.query(`UPDATE sales_orders SET status=$3,confirmed_by_user_id=$4,
      confirmed_at=COALESCE(confirmed_at,$5),updated_at=$5,version=version+1 WHERE id=$1 AND workspace_id=$2`,
    [salesOrderId, ctx.workspaceId, status, ctx.actorId, at]);
    await event(client, 'sales_order_events', null, { workspaceId: ctx.workspaceId, recordId: salesOrderId,
      type: 'confirmed', detail: { status, allocations }, actorId: ctx.actorId,
      key: `${input.idempotencyKey}:event`, at });
    const result = { salesOrderId, status, allocations, shortage: short };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
}

async function confirmSalesOrder(database, rawContext, salesOrderId, input) {
  return database.transaction((client)=>confirmSalesOrderInTransaction(client,rawContext,salesOrderId,input),
    { isolation: 'READ COMMITTED', retrySafe: true });
}

async function fulfillSalesOrderInTransaction(client, rawContext, salesOrderId, input) {
  const ctx = requireContext(rawContext);
  if (!Array.isArray(input.lines) || !input.lines.length) throw new ValidationError('Choose at least one allocated line to fulfill.');
    await requirePermission(client, ctx, access.OPERATE, 'fulfill sales orders');
    const operation = await beginOperation(client, ctx, 'sales_order.fulfill', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const order = await requireRow(client, `SELECT * FROM sales_orders WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
      [salesOrderId, ctx.workspaceId], 'That sales order was not found.');
    if (!['CONFIRMED', 'BACKORDERED', 'PARTIALLY_FULFILLED'].includes(order.status)) {
      throw new ValidationError('Confirm and allocate the sales order before fulfilling it.');
    }
    const at = input.fulfilledAt || nowIso();
    const fulfilled = [];
    for (const [index, requested] of input.lines.entries()) {
      const line = await requireRow(client, `SELECT sol.*,s.item_id FROM sales_order_lines sol JOIN skus s ON s.id=sol.sku_id
        WHERE sol.id=$1 AND sol.sales_order_id=$2 AND sol.workspace_id=$3 FOR UPDATE`,
      [requested.lineId, salesOrderId, ctx.workspaceId], `Fulfillment line ${index + 1} is not on this sales order.`);
      const quantity = positiveInteger(requested.quantity, `Fulfillment line ${index + 1} quantity`);
      const remaining = Number(line.quantity_ordered) - Number(line.quantity_fulfilled);
      if (quantity > remaining) throw new ValidationError(`Fulfillment line ${index + 1} exceeds the quantity still open.`);
      const allocation = await requireRow(client, `SELECT * FROM sales_order_allocations
        WHERE sales_order_line_id=$1 AND location_id=$2 AND workspace_id=$3 FOR UPDATE`,
      [line.id, requested.locationId, ctx.workspaceId], `Fulfillment line ${index + 1} is not allocated at that location.`);
      if (quantity > Number(allocation.quantity)) throw new ValidationError(`Fulfillment line ${index + 1} exceeds its allocation.`);
      const physical = await inventory.issueInTransaction(client, ctx, {
        skuId: line.sku_id, locationId: requested.locationId, quantity,
        lotId: requested.lotId, serialUnitIds: requested.serialUnitIds,
        reasonCode: 'sale', reference: order.order_number, occurredAt: at,
        idempotencyKey: `${input.idempotencyKey}:line:${line.id}:${requested.locationId}`,
      });
      const preparedCost = await costing.prepareIssueInTransaction(client, ctx, { movementId: physical.movementId });
      let snapshot=line.pricing_snapshot;
      if(!snapshot){
        const original=(await client.query('SELECT id,sku_id,quantity_ordered,unit_price_minor,quantity_fulfilled FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2 ORDER BY created_at,id',[ctx.workspaceId,salesOrderId])).rows;
        if((Number(order.discount_minor)||Number(order.tax_minor))&&original.some(r=>Number(r.quantity_fulfilled)>0))throw new ValidationError('This older partially fulfilled order needs an accounting review before applying historical adjustments.');
        const legacy=priceCalculator.quote({at,customerId:order.customer_id,currency:order.currency,discountMinor:Number(order.discount_minor||0),taxMinor:Number(order.tax_minor||0),lines:original.map(r=>({skuId:r.sku_id,quantity:Number(r.quantity_ordered),unitPriceMinor:Number(r.unit_price_minor)}))});
        await require('../pricing/postgres-promotions').saveQuote(client,ctx,salesOrderId,legacy,original.map(r=>r.id));
        snapshot=legacy.lines[original.findIndex(r=>r.id===line.id)];
      }
      if(snapshot.quantity!==Number(line.quantity_ordered)||snapshot.unitPriceMinor!==Number(line.unit_price_minor))throw new ValidationError('The order pricing snapshot no longer matches its line. Review pricing before fulfillment.');
      const before=Number(line.quantity_fulfilled);
      if(before&&snapshot.allocationVersion!==2){
        const historical=(await client.query(`SELECT coalesce(sum((metadata::jsonb->>'grossMinor')::bigint),0) AS gross,coalesce(sum((metadata::jsonb->>'discountMinor')::bigint),0) AS discount,coalesce(sum((metadata::jsonb->>'taxMinor')::bigint),0) AS tax,coalesce(sum((metadata::jsonb->>'revenueMinor')::bigint),0) AS revenue FROM accounting_journal_entries WHERE workspace_id=$1 AND source_type='sale_fulfillment' AND metadata::jsonb->>'salesOrderLineId'=$2`,[ctx.workspaceId,line.id])).rows[0],expected=priceCalculator.monetaryPortion(snapshot,snapshot.quantity,0,before);
        if([['grossMinor','gross'],['discountMinor','discount'],['taxMinor','tax'],['revenueMinor','revenue']].some(([k,c])=>expected[k]!==Number(historical[c])))throw new ValidationError('The historical partial amounts need reconciliation before more units can be fulfilled. No earlier transaction was rewritten.');
      }
      const {grossMinor,discountMinor,taxMinor,chargesMinor,chargeTaxMinor,revenueMinor,totalMinor}=priceCalculator.monetaryPortion(snapshot,snapshot.quantity,before,quantity);
      const posted = await ledger.postInTransaction(client, ctx, {
        postingDate: at.slice(0, 10), sourceKey: `sales-fulfillment:${input.idempotencyKey}:${line.id}:${requested.locationId}`,
        description: `Fulfill ${quantity} units on ${order.order_number}`, sourceType: 'sale_fulfillment',
        sourceRecordType: 'sales_order', sourceRecordId: salesOrderId, currency: order.currency,
        metadata: { movementId: physical.movementId, salesOrderId, salesOrderLineId: line.id,
          allocationVersion:2,revenueMinor, grossMinor,discountMinor,taxMinor,chargesMinor,chargeTaxMinor,totalMinor,quantity,cogsMinor: preparedCost.totalCostMinor },
        lines: [
          { accountKey: 'ACCOUNTS_RECEIVABLE', debitMinor: totalMinor, customerId: order.customer_id,
            itemId: line.item_id, skuId: line.sku_id, locationId: requested.locationId },
          { accountKey: 'SALES_REVENUE', creditMinor: revenueMinor, customerId: order.customer_id,
            itemId: line.item_id, skuId: line.sku_id, locationId: requested.locationId },
          { accountKey:'SALES_TAX_PAYABLE',creditMinor:taxMinor,customerId:order.customer_id },
          { accountKey: 'COST_OF_GOODS_SOLD', debitMinor: preparedCost.totalCostMinor, customerId: order.customer_id,
            itemId: line.item_id, skuId: line.sku_id, locationId: requested.locationId },
          { accountKey: 'INVENTORY_ASSET', creditMinor: preparedCost.totalCostMinor, customerId: order.customer_id,
            itemId: line.item_id, skuId: line.sku_id, locationId: requested.locationId },
        ].filter(line=>Number(line.debitMinor||0)!==0||Number(line.creditMinor||0)!==0),
      });
      await costing.commitIssueInTransaction(client, ctx, preparedCost, { journalEntryId: posted.entry.id,
        sourceType: 'sales_order_fulfillment', sourceRecordId: salesOrderId });
      if (quantity === Number(allocation.quantity)) {
        await client.query('DELETE FROM sales_order_allocations WHERE id=$1', [allocation.id]);
      } else {
        await client.query(`UPDATE sales_order_allocations SET quantity=quantity-$2,updated_at=$3 WHERE id=$1`,
          [allocation.id, quantity, nowIso()]);
      }
      await client.query(`UPDATE sales_order_lines SET quantity_fulfilled=quantity_fulfilled+$2,updated_at=$3 WHERE id=$1`,
        [line.id, quantity, nowIso()]);
      fulfilled.push({ lineId: line.id, quantity, locationId: requested.locationId,
        movementId: physical.movementId, revenueMinor,grossMinor,discountMinor,taxMinor,chargesMinor,chargeTaxMinor,totalMinor,unitPriceMinor:Number(line.unit_price_minor),costMinor: preparedCost.totalCostMinor,
        journalEntryId: posted.entry.id });
    }
    const outstanding = await client.query(`SELECT COUNT(*) FILTER (WHERE quantity_fulfilled < quantity_ordered) AS open
      FROM sales_order_lines WHERE sales_order_id=$1 AND workspace_id=$2`, [salesOrderId, ctx.workspaceId]);
    const status = Number(outstanding.rows[0].open) ? 'PARTIALLY_FULFILLED' : 'FULFILLED';
    await client.query(`UPDATE sales_orders SET status=$3,updated_at=$4,version=version+1,
      completed_at=CASE WHEN $3='FULFILLED' THEN $4 ELSE completed_at END WHERE id=$1 AND workspace_id=$2`,
    [salesOrderId, ctx.workspaceId, status, nowIso()]);
    const invoiceResult = await client.query(`SELECT * FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND sales_order_id=$2 FOR UPDATE`, [ctx.workspaceId, salesOrderId]);
    let invoice = invoiceResult.rows[0];
    if (!invoice) {
      const invoiceId = newId('arinvoice');
      const invoiceNumber = await numbered(client, ctx.workspaceId, 'accounting_customer_invoices', 'INV');
      await client.query(`INSERT INTO accounting_customer_invoices
        (id,workspace_id,invoice_number,customer_id,sales_order_id,issue_date,status,currency,subtotal_minor,
         discount_minor,tax_minor,total_minor,balance_minor,source_key,created_by_user_id,created_at,updated_at,opened_at)
        VALUES($1,$2,$3,$4,$5,$6,'OPEN',$7,0,0,0,0,0,$8,$9,$10,$10,$10)`,
      [invoiceId, ctx.workspaceId, invoiceNumber, order.customer_id, salesOrderId, at.slice(0, 10), order.currency,
        `sales-order:${salesOrderId}`, ctx.actorId, nowIso()]);
      invoice = { id: invoiceId, invoice_number: invoiceNumber };
    }
    const revenueAccount = await accountId(client, ctx.workspaceId, 'SALES_REVENUE');
    const count = await client.query(`SELECT COUNT(*) AS count FROM accounting_customer_invoice_lines WHERE invoice_id=$1`, [invoice.id]);
    let lineNumber = Number(count.rows[0].count);
    let fulfillmentTotal = 0,fulfillmentGross=0,fulfillmentDiscount=0,fulfillmentTax=0,fulfillmentCharges=0;
    for (const line of fulfilled) {
      lineNumber += 1; fulfillmentTotal += line.totalMinor;fulfillmentGross+=line.grossMinor;fulfillmentDiscount+=line.discountMinor;fulfillmentTax+=line.taxMinor;fulfillmentCharges+=line.chargesMinor;
      await client.query(`INSERT INTO accounting_customer_invoice_lines
        (id,workspace_id,invoice_id,line_number,description,quantity,unit_price_minor,line_total_minor,
         revenue_account_id,sku_id,sales_order_line_id,created_at,pricing_snapshot,charges_minor)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
      [newId('arline'), ctx.workspaceId, invoice.id, lineNumber, `Fulfillment on ${order.order_number}`,
        line.quantity, line.unitPriceMinor, line.revenueMinor, revenueAccount,
        (await requireRow(client, 'SELECT sku_id FROM sales_order_lines WHERE id=$1', [line.lineId], 'Sales line missing.')).sku_id,
        line.lineId, nowIso(),JSON.stringify({grossMinor:line.grossMinor,discountMinor:line.discountMinor,taxMinor:line.taxMinor,chargesMinor:line.chargesMinor,chargeTaxMinor:line.chargeTaxMinor,totalMinor:line.totalMinor}),line.chargesMinor]);
    }
    await client.query(`UPDATE accounting_customer_invoices SET subtotal_minor=subtotal_minor+$4,discount_minor=discount_minor+$5,tax_minor=tax_minor+$6,total_minor=total_minor+$2,
      balance_minor=balance_minor+$2,charges_minor=charges_minor+$7,updated_at=$3 WHERE id=$1`, [invoice.id, fulfillmentTotal, nowIso(),fulfillmentGross,fulfillmentDiscount,fulfillmentTax,fulfillmentCharges]);
    let appliedDepositMinor = 0;
    const depositRows = await client.query(`SELECT p.*,
        COALESCE((SELECT SUM(a.amount_minor) FROM accounting_payment_allocations a
          WHERE a.workspace_id=p.workspace_id AND a.payment_id=p.id),0)::bigint AS allocated_minor
      FROM accounting_payments p
      WHERE p.workspace_id=$1 AND p.sales_order_id=$2 AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED'
      ORDER BY p.payment_date,p.created_at,p.id FOR UPDATE OF p`, [ctx.workspaceId, salesOrderId]);
    let invoiceState = (await client.query(`SELECT * FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [ctx.workspaceId, invoice.id])).rows[0];
    for (const payment of depositRows.rows) {
      const available = Number(payment.amount_minor) - Number(payment.allocated_minor);
      const applied = Math.min(available, Number(invoiceState.balance_minor));
      if (applied <= 0) continue;
      const depositPosted = await ledger.postInTransaction(client, ctx, {
        postingDate: at.slice(0, 10),
        sourceKey: `deposit-applied:${invoice.id}:${payment.id}:${payment.allocated_minor}:${applied}`,
        description: `Apply customer deposit to ${invoice.invoice_number}`,
        sourceType: 'customer_deposit_applied', sourceRecordType: 'customer_invoice',
        sourceRecordId: invoice.id, currency: invoiceState.currency,
        lines: [
          { accountKey: 'CUSTOMER_DEPOSITS', debitMinor: applied, customerId: order.customer_id },
          { accountKey: 'ACCOUNTS_RECEIVABLE', creditMinor: applied, customerId: order.customer_id },
        ],
      });
      await client.query(`INSERT INTO accounting_payment_allocations
        (id,workspace_id,payment_id,customer_invoice_id,supplier_bill_id,amount_minor,created_at)
        VALUES($1,$2,$3,$4,NULL,$5,$6)`,
      [newId('payalloc'), ctx.workspaceId, payment.id, invoice.id, applied, nowIso()]);
      const balanceMinor = Number(invoiceState.balance_minor) - applied;
      const invoiceStatus = balanceMinor === 0 ? 'PAID' : 'PARTIALLY_PAID';
      await client.query(`UPDATE accounting_customer_invoices SET balance_minor=$2::bigint,status=$3,updated_at=$4,
        paid_at=CASE WHEN $2::bigint=0::bigint THEN $4 ELSE paid_at END WHERE id=$1`,
      [invoice.id, balanceMinor, invoiceStatus, nowIso()]);
      invoiceState = { ...invoiceState, balance_minor: balanceMinor, status: invoiceStatus,
        deposit_journal_entry_id: depositPosted.entry.id };
      appliedDepositMinor += applied;
    }
    await event(client, 'sales_order_events', null, { workspaceId: ctx.workspaceId, recordId: salesOrderId,
      type: 'fulfilled', detail: { status, lines: fulfilled, invoiceId: invoice.id }, actorId: ctx.actorId,
      key: `${input.idempotencyKey}:event`, at: nowIso() });
    const result = { salesOrderId, status, invoiceId: invoice.id, invoiceNumber: invoice.invoice_number,
      fulfillmentTotalMinor: fulfillmentTotal, appliedDepositMinor, lines: fulfilled };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
}

async function fulfillSalesOrder(database, rawContext, salesOrderId, input) {
  return database.transaction((client)=>fulfillSalesOrderInTransaction(client,rawContext,salesOrderId,input),
    { isolation: 'READ COMMITTED', retrySafe: true });
}

async function cancelSalesOrderInTransaction(client,rawContext,salesOrderId,input){
  const ctx=requireContext(rawContext);
  await requirePermission(client,ctx,access.OPERATE,'cancel sales orders');
  const operation=await beginOperation(client,ctx,'sales_order.cancel',input.idempotencyKey);
  if(operation.replayed)return {...operation.result,replayed:true};
  const order=await requireRow(client,`SELECT * FROM sales_orders WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
    [salesOrderId,ctx.workspaceId],'That sales order was not found.');
  if(order.status==='FULFILLED')throw new ValidationError('A fully fulfilled sales order cannot be cancelled. Process a return instead.');
  if(order.status!=='CANCELLED'){
    if(!(await client.query('SELECT 1 FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2 AND quantity_fulfilled>0 LIMIT 1',[ctx.workspaceId,salesOrderId])).rows.length){
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['pricing:'+ctx.workspaceId]);
      await client.query('UPDATE stockchief_runtime.pricing_redemptions SET released_at=now() WHERE workspace_id=$1 AND sales_order_id=$2 AND released_at IS NULL',[ctx.workspaceId,salesOrderId]);
    }
    await client.query(`DELETE FROM sales_order_allocations WHERE workspace_id=$1 AND sales_order_line_id IN
      (SELECT id FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2)`,[ctx.workspaceId,salesOrderId]);
    const at=nowIso();
    await client.query(`UPDATE sales_orders SET status='CANCELLED',cancelled_by_user_id=$3,cancelled_at=$4,
      cancel_reason=$5,updated_at=$4,version=version+1 WHERE id=$1 AND workspace_id=$2`,
    [salesOrderId,ctx.workspaceId,ctx.actorId,at,trimOrNull(input.reason)||'Cancelled']);
    await event(client,'sales_order_events',null,{workspaceId:ctx.workspaceId,recordId:salesOrderId,
      type:'cancelled',detail:{reason:trimOrNull(input.reason)||'Cancelled'},actorId:ctx.actorId,
      key:`${input.idempotencyKey}:event`,at});
  }
  const result={salesOrderId,status:'CANCELLED'};
  await completeOperation(client,operation,result);
  return {...result,replayed:false};
}

async function cancelSalesOrder(database,rawContext,salesOrderId,input){
  return transaction(database,(client)=>cancelSalesOrderInTransaction(client,rawContext,salesOrderId,input));
}

async function synchronizeSalesOrderInTransaction(client,rawContext,salesOrderId,input){
  const ctx=requireContext(rawContext);
  if(!Array.isArray(input.lines)||!input.lines.length)throw new ValidationError('A sales-order snapshot needs at least one line.');
  await requirePermission(client,ctx,access.OPERATE,'synchronize sales orders');
  const operation=await beginOperation(client,ctx,'sales_order.synchronize',input.idempotencyKey);
  if(operation.replayed)return {...operation.result,replayed:true};
  const order=await requireRow(client,`SELECT * FROM sales_orders WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
    [salesOrderId,ctx.workspaceId],'That sales order was not found.');
  if(['FULFILLED','CANCELLED'].includes(order.status))throw new ValidationError('A completed sales order cannot be rewritten from a provider snapshot.');
  const current=(await client.query(`SELECT * FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2
    ORDER BY created_at,id FOR UPDATE`,[ctx.workspaceId,salesOrderId])).rows;
  const promotions=require('../pricing/postgres-promotions');
  if(input.currency&&input.currency!==order.currency)throw new ValidationError('A provider update cannot silently change an order currency.');
  const syncedInput={...input,customerId:order.customer_id,currency:order.currency,lines:input.lines,discountMinor:input.discountMinor??Number(order.discount_minor),taxMinor:input.taxMinor??Number(order.tax_minor)};
  const synchronizedQuote=await promotions.prepareQuote(client,ctx,syncedInput,{lock:true});
  if(synchronizedQuote.violations.length)throw new ValidationError('The accepted order snapshot needs a pricing safeguard review.');
  const identities=new Set(),used=new Set(),desired=[];
  for(const [index,line] of input.lines.entries()){
    await requireRow(client,'SELECT id FROM skus WHERE id=$1 AND workspace_id=$2 AND is_active=1',
      [line.skuId,ctx.workspaceId],`Sales-order line ${index+1} has an unavailable SKU.`);
    const quantity=positiveInteger(line.quantity,`Sales-order line ${index+1} quantity`);
    const externalLineId=trimOrNull(line.externalLineId),identity=externalLineId?'external:'+externalLineId:'sku:'+line.skuId;
    if(identities.has(identity))throw new ValidationError('Distinct provider lines need distinct external line identities.');identities.add(identity);
    const exact=externalLineId?current.find(row=>row.external_line_id===externalLineId):null;
    const candidates=exact?[exact]:current.filter(row=>!used.has(row.id)&&!row.external_line_id&&row.sku_id===line.skuId);
    if(candidates.length>1)throw new ValidationError('This older order has ambiguous duplicate lines; reconcile their external identities before applying the update.');
    const prior=candidates[0]||null;
    if(prior){
      if(prior.sku_id!==line.skuId||used.has(prior.id))throw new ValidationError('A provider line identity cannot be reassigned to a different product.');
      used.add(prior.id);
      if(quantity<Number(prior.quantity_fulfilled))throw new ValidationError('A channel update cannot reduce fulfilled units.');
      if(Number(prior.quantity_fulfilled)>0){
        const historical=(await client.query(`SELECT coalesce(sum((metadata::jsonb->>'grossMinor')::bigint),0) AS gross,coalesce(sum((metadata::jsonb->>'discountMinor')::bigint),0) AS discount,coalesce(sum((metadata::jsonb->>'taxMinor')::bigint),0) AS tax,coalesce(sum((metadata::jsonb->>'chargesMinor')::bigint),0) AS charges FROM accounting_journal_entries WHERE workspace_id=$1 AND source_type='sale_fulfillment' AND metadata::jsonb->>'salesOrderLineId'=$2`,[ctx.workspaceId,prior.id])).rows[0];
        const next=synchronizedQuote.lines[index];
        const historicalPortion=priceCalculator.monetaryPortion(next,quantity,0,Number(prior.quantity_fulfilled));
        for(const [key,column]of [['grossMinor','gross'],['discountMinor','discount'],['taxMinor','tax'],['chargesMinor','charges']]){
          const part=historicalPortion[key]||0;
          if(part!==Number(historical[column]))throw new ValidationError('This channel update would change fulfilled historical amounts. Its evidence needs an accounting review.');
        }
      }
    }
    desired.push({...line,externalLineId,quantity,id:prior?.id||newId('sol'),existing:Boolean(prior)});
  }
  if(current.some(row=>!used.has(row.id)&&Number(row.quantity_fulfilled)>0))throw new ValidationError('A channel update cannot remove a fulfilled line.');
  await client.query(`DELETE FROM sales_order_allocations WHERE workspace_id=$1 AND sales_order_line_id IN
    (SELECT id FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2)`,[ctx.workspaceId,salesOrderId]);
  const at=nowIso();
  for(const line of current.filter(row=>!used.has(row.id)))await client.query('DELETE FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2 AND id=$3',[ctx.workspaceId,salesOrderId,line.id]);
  for(const line of desired){
    const price=nonNegativeMinor(line.unitPriceMinor,'Sales-order line price');
    if(line.existing)await client.query(`UPDATE sales_order_lines SET quantity_ordered=$4,unit_price_minor=$5,external_line_id=$6,updated_at=$7 WHERE workspace_id=$1 AND sales_order_id=$2 AND id=$3`,[ctx.workspaceId,salesOrderId,line.id,line.quantity,price,line.externalLineId,at]);
    else await client.query(`INSERT INTO sales_order_lines(id,workspace_id,sales_order_id,sku_id,quantity_ordered,quantity_fulfilled,unit_price_minor,created_at,updated_at,external_line_id) VALUES($1,$2,$3,$4,$5,0,$6,$7,$7,$8)`,[line.id,ctx.workspaceId,salesOrderId,line.skuId,line.quantity,price,at,line.externalLineId]);
  }
  await promotions.saveQuote(client,ctx,salesOrderId,synchronizedQuote,desired.map(line=>line.id));
  await event(client,'sales_order_events',null,{workspaceId:ctx.workspaceId,recordId:salesOrderId,
    type:'synchronized',detail:{source:trimOrNull(input.source)||'provider'},actorId:ctx.actorId,
    key:`${input.idempotencyKey}:event`,at});
  const confirmed=await confirmSalesOrderInTransaction(client,ctx,salesOrderId,
    {idempotencyKey:`${input.idempotencyKey}:confirm`});
  const result={salesOrderId,status:confirmed.status,shortage:confirmed.shortage};
  await completeOperation(client,operation,result);
  return {...result,replayed:false};
}

async function synchronizeSalesOrder(database,rawContext,salesOrderId,input){
  return transaction(database,(client)=>synchronizeSalesOrderInTransaction(client,rawContext,salesOrderId,input));
}

async function reviseDraftSalesOrderLineInTransaction(client,rawContext,salesOrderId,input){
  const ctx=requireContext(rawContext);
  await requirePermission(client,ctx,access.OPERATE,'revise a draft sales order');
  const operation=await beginOperation(client,ctx,'sales_order.revise_draft_line',input.idempotencyKey);
  if(operation.replayed)return {...operation.result,replayed:true};
  const order=await requireRow(client,`SELECT id,status,version FROM sales_orders
    WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,salesOrderId],
  'That sales order was not found.');
  if(order.status!=='DRAFT')throw new ValidationError('Only a draft customer order can be revised without reallocating stock.');
  if(Number(order.version)!==Number(input.expectedVersion))
    throw new ValidationError('This order changed after review. Ask again before changing it.');
  const line=await requireRow(client,`SELECT id,quantity_ordered,unit_price_minor FROM sales_order_lines
    WHERE workspace_id=$1 AND sales_order_id=$2 AND sku_id=$3 FOR UPDATE`,
  [ctx.workspaceId,salesOrderId,input.skuId],'That product is not on this draft customer order.');
  if(Number(line.quantity_ordered)!==Number(input.expectedQuantity)||
    Number(line.unit_price_minor)!==Number(input.expectedUnitPriceMinor))
    throw new ValidationError('This order line changed after review. Ask again before changing it.');
  const quantity=positiveInteger(input.quantity,'Draft order quantity');
  const unitPriceMinor=nonNegativeMinor(input.unitPriceMinor,'Draft order unit price');
  const promotions=require('../pricing/postgres-promotions'),revision=await promotions.revisionQuote(client,ctx,salesOrderId,{skuId:input.skuId,quantity,unitPriceMinor,priceOverride:input.priceOverride??true},{lock:true});
  if(input.pricingQuoteHash&&input.pricingQuoteHash!==promotions.quoteHash(revision.quote))throw new ValidationError('The draft pricing changed after approval. Review the complete price again.');
  const at=nowIso();
  await client.query(`UPDATE sales_order_lines SET quantity_ordered=$2,unit_price_minor=$3,updated_at=$4
    WHERE id=$1`,[line.id,quantity,unitPriceMinor,at]);
  await promotions.saveQuote(client,ctx,salesOrderId,revision.quote,revision.lineIds);
  await client.query(`UPDATE sales_orders SET version=version+1,updated_at=$3
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,salesOrderId,at]);
  await event(client,'sales_order_events',null,{workspaceId:ctx.workspaceId,recordId:salesOrderId,
    type:'draft_line_revised',detail:{skuId:input.skuId,quantity,unitPriceMinor},actorId:ctx.actorId,
    key:`${input.idempotencyKey}:event`,at});
  const result={salesOrderId,lineId:line.id,skuId:input.skuId,quantity,unitPriceMinor:revision.quote.lines.find(l=>l.skuId===input.skuId).unitPriceMinor,pricing:revision.quote,status:'DRAFT'};
  await completeOperation(client,operation,result);
  return {...result,replayed:false};
}

async function reviseDraftSalesOrderLine(database,rawContext,salesOrderId,input){
  return transaction(database,(client)=>reviseDraftSalesOrderLineInTransaction(client,rawContext,salesOrderId,input));
}

async function recordPaymentInTransaction(client, rawContext, input) {
  const providerSystem=rawContext?.systemSource==='payment_provider';
  const ctx=providerSystem
    ?{workspaceId:rawContext.workspaceId,actorId:null}
    :requireContext(rawContext);
  if(!ctx.workspaceId)throw new ValidationError('A workspace is required.');
  const direction = input.direction;
  if (!['CUSTOMER_RECEIPT', 'SUPPLIER_PAYMENT'].includes(direction)) throw new ValidationError('Payment direction is invalid.');
    if(providerSystem){
      if(direction!=='CUSTOMER_RECEIPT'||!rawContext.providerEventId||!rawContext.providerRequestId){
        throw new ValidationError('A verified provider event is required for a system payment.');
      }
      await requireRow(client,`SELECT id FROM payment_provider_events
        WHERE id=$1 AND workspace_id=$2 AND request_id=$3 AND processed_at IS NULL FOR UPDATE`,
      [rawContext.providerEventId,ctx.workspaceId,rawContext.providerRequestId],
      'That provider payment event is not available for posting.');
      ctx.verifiedProviderReceipt=true;
    }else await requirePermission(client, ctx, access.RECORD_PAYMENTS, 'record payments');
    const operation = await beginOperation(client, ctx, `payment.${direction.toLowerCase()}`, input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const amountMinor = positiveInteger(input.amountMinor, 'Payment amount');
    const paymentDate = dateOnly(input.paymentDate || nowIso().slice(0, 10), 'Payment date');
    const customer = direction === 'CUSTOMER_RECEIPT'
      ? await requireRow(client, 'SELECT id FROM customers WHERE id=$1 AND workspace_id=$2',
        [input.customerId, ctx.workspaceId], 'That customer was not found.') : null;
    const supplier = direction === 'SUPPLIER_PAYMENT'
      ? await requireRow(client, 'SELECT id FROM suppliers WHERE id=$1 AND workspace_id=$2',
        [input.supplierId, ctx.workspaceId], 'That supplier was not found.') : null;
    const target = direction === 'CUSTOMER_RECEIPT'
      ? await requireRow(client, `SELECT * FROM accounting_customer_invoices
        WHERE id=$1 AND workspace_id=$2 AND customer_id=$3 FOR UPDATE`,
      [input.customerInvoiceId, ctx.workspaceId, customer.id], 'That customer invoice was not found.')
      : await requireRow(client, `SELECT * FROM accounting_supplier_bills
        WHERE id=$1 AND workspace_id=$2 AND supplier_id=$3 FOR UPDATE`,
      [input.supplierBillId, ctx.workspaceId, supplier.id], 'That supplier bill was not found.');
    if (!['OPEN', 'PARTIALLY_PAID'].includes(target.status)) throw new ValidationError('That document is not open for payment.');
    if (amountMinor > Number(target.balance_minor)) throw new ValidationError('Payment exceeds the outstanding balance.');
    const sourceKey = input.sourceKey || `${direction.toLowerCase()}:${input.idempotencyKey}`;
    const posted = await ledger.postInTransaction(client, ctx, { postingDate: paymentDate,
      sourceKey: `journal:${sourceKey}`, description: direction === 'CUSTOMER_RECEIPT' ? 'Customer payment' : 'Supplier payment',
      sourceType: direction === 'CUSTOMER_RECEIPT' ? 'customer_payment' : 'supplier_payment',
      sourceRecordType: direction === 'CUSTOMER_RECEIPT' ? 'customer_invoice' : 'supplier_bill',
      sourceRecordId: target.id, currency: input.currency || target.currency,
      lines: direction === 'CUSTOMER_RECEIPT' ? [
        { accountKey: 'CASH', debitMinor: amountMinor, customerId: customer.id },
        { accountKey: 'ACCOUNTS_RECEIVABLE', creditMinor: amountMinor, customerId: customer.id },
      ] : [
        { accountKey: 'ACCOUNTS_PAYABLE', debitMinor: amountMinor, supplierId: supplier.id },
        { accountKey: 'CASH', creditMinor: amountMinor, supplierId: supplier.id },
      ],
    });
    const cashAccountId = await accountId(client, ctx.workspaceId, 'CASH');
    const id = newId('payment');
    const paymentNumber = await numbered(client, ctx.workspaceId, 'accounting_payments', direction === 'CUSTOMER_RECEIPT' ? 'RCPT' : 'PAY');
    const at = nowIso();
    await client.query(`INSERT INTO accounting_payments
      (id,workspace_id,payment_number,direction,customer_id,supplier_id,payment_date,amount_minor,currency,method,
       reference,sales_order_id,status,cash_account_id,journal_entry_id,source_key,created_by_user_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'POSTED',$13,$14,$15,$16,$17)`,
    [id, ctx.workspaceId, paymentNumber, direction, customer?.id || null, supplier?.id || null,
      paymentDate, amountMinor, input.currency || target.currency, input.method || null, input.reference || null,
      input.salesOrderId || null, cashAccountId, posted.entry.id, sourceKey, ctx.actorId, at]);
    await client.query(`INSERT INTO accounting_payment_allocations
      (id,workspace_id,payment_id,customer_invoice_id,supplier_bill_id,amount_minor,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [newId('payalloc'), ctx.workspaceId, id, direction === 'CUSTOMER_RECEIPT' ? target.id : null,
      direction === 'SUPPLIER_PAYMENT' ? target.id : null, amountMinor, at]);
    const balanceMinor = Number(target.balance_minor) - amountMinor;
    const status = balanceMinor === 0 ? 'PAID' : 'PARTIALLY_PAID';
    const table = direction === 'CUSTOMER_RECEIPT' ? 'accounting_customer_invoices' : 'accounting_supplier_bills';
    await client.query(`UPDATE ${table} SET balance_minor=$2::bigint,status=$3,updated_at=$4,
      paid_at=CASE WHEN $2::bigint=0::bigint THEN $4 ELSE paid_at END WHERE id=$1`,
    [target.id, balanceMinor, status, at]);
    const result = { paymentId: id, paymentNumber, direction, amountMinor, balanceMinor, status,
      journalEntryId: posted.entry.id };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
}

async function recordPayment(database, rawContext, input) {
  return transaction(database, (client) => recordPaymentInTransaction(client, rawContext, input));
}

async function recordCustomerDeposit(database, rawContext, input) {
  const providerSystem = rawContext?.systemSource === 'payment_provider';
  const ctx = providerSystem ? { workspaceId: rawContext.workspaceId, actorId: null } : requireContext(rawContext);
  if (!ctx.workspaceId) throw new ValidationError('A workspace is required.');
  return transaction(database, async (client) => {
    if (providerSystem) {
      if (!rawContext.providerEventId || !rawContext.providerRequestId) {
        throw new ValidationError('A verified provider event is required for a system deposit.');
      }
      await requireRow(client, `SELECT id FROM payment_provider_events
        WHERE id=$1 AND workspace_id=$2 AND request_id=$3 AND processed_at IS NULL FOR UPDATE`,
      [rawContext.providerEventId, ctx.workspaceId, rawContext.providerRequestId],
      'That provider deposit event is not available for posting.');
      ctx.verifiedProviderReceipt=true;
    } else await requirePermission(client, ctx, access.RECORD_PAYMENTS, 'record customer deposits');
    const operation = await beginOperation(client, ctx, 'payment.customer_deposit', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const amountMinor = positiveInteger(input.amountMinor, 'Deposit amount');
    const paymentDate = dateOnly(input.paymentDate || nowIso().slice(0, 10), 'Payment date');
    const order = await requireRow(client, `SELECT * FROM sales_orders
      WHERE id=$1 AND workspace_id=$2 AND customer_id=$3 FOR UPDATE`,
    [input.salesOrderId, ctx.workspaceId, input.customerId], 'That sales order was not found for this customer.');
    const posted = await ledger.postInTransaction(client, ctx, {
      postingDate: paymentDate, sourceKey: `journal:${input.sourceKey || input.idempotencyKey}`,
      description: `Customer deposit for ${order.order_number}`, sourceType: 'customer_deposit',
      sourceRecordType: 'sales_order', sourceRecordId: order.id, currency: input.currency || order.currency,
      lines: [
        { accountKey: 'CASH', debitMinor: amountMinor, customerId: order.customer_id },
        { accountKey: 'CUSTOMER_DEPOSITS', creditMinor: amountMinor, customerId: order.customer_id },
      ],
    });
    const cashAccountId = await accountId(client, ctx.workspaceId, 'CASH');
    const id = newId('payment');
    const paymentNumber = await numbered(client, ctx.workspaceId, 'accounting_payments', 'RCPT');
    const at = nowIso();
    await client.query(`INSERT INTO accounting_payments
      (id,workspace_id,payment_number,direction,customer_id,supplier_id,payment_date,amount_minor,currency,method,
       reference,sales_order_id,status,cash_account_id,journal_entry_id,source_key,created_by_user_id,created_at)
      VALUES($1,$2,$3,'CUSTOMER_RECEIPT',$4,NULL,$5,$6,$7,$8,$9,$10,'POSTED',$11,$12,$13,$14,$15)`,
    [id, ctx.workspaceId, paymentNumber, order.customer_id, paymentDate, amountMinor, input.currency || order.currency,
      input.method || null, input.reference || null, order.id, cashAccountId, posted.entry.id,
      input.sourceKey || `customer_deposit:${input.idempotencyKey}`, ctx.actorId, at]);
    const result = { paymentId: id, paymentNumber, direction: 'CUSTOMER_RECEIPT', amountMinor,
      salesOrderId: order.id, status: 'POSTED', journalEntryId: posted.entry.id };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
  });
}

function recordCustomerPayment(database, ctx, input) {
  return recordPayment(database, ctx, { ...input, direction: 'CUSTOMER_RECEIPT' });
}

function recordSupplierPayment(database, ctx, input) {
  return recordPayment(database, ctx, { ...input, direction: 'SUPPLIER_PAYMENT' });
}

function recordSupplierPaymentInTransaction(client, ctx, input) {
  return recordPaymentInTransaction(client, ctx, { ...input, direction: 'SUPPLIER_PAYMENT' });
}

module.exports = {
  createPurchaseOrder,
  createPurchaseOrderInTransaction,
  reviseDraftPurchaseOrderLine,
  reviseDraftPurchaseOrderLineInTransaction,
  reviseDraftPurchaseOrderReference,
  approvePurchaseOrder,
  placePurchaseOrder,
  cancelPurchaseOrder,
  cancelPurchaseOrderInTransaction,
  receivePurchaseOrder,
  receivePurchaseOrderInTransaction,
  recordSupplierInvoice,
  previewSupplierInvoice:(database,ctx,input)=>recordSupplierInvoice(database,ctx,input,{preview:true}),
  editDraftSalesOrder,
  createSalesOrder,
  createSalesOrderInTransaction,
  confirmSalesOrder,
  confirmSalesOrderInTransaction,
  fulfillSalesOrder,
  fulfillSalesOrderInTransaction,
  cancelSalesOrder,
  cancelSalesOrderInTransaction,
  synchronizeSalesOrder,
  synchronizeSalesOrderInTransaction,
  reviseDraftSalesOrderLine,
  reviseDraftSalesOrderLineInTransaction,
  recordCustomerPayment,
  recordCustomerDeposit,
  recordSupplierPayment,
  recordSupplierPaymentInTransaction,
};

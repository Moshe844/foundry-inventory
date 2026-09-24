'use strict';

const crypto = require('node:crypto');
const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError, InvariantError } = require('../domain/errors');
const access = require('../actions/permissions');
const inventory = require('../domain/postgres-inventory-engine');
const ledger = require('../accounting/postgres-ledger');
const costing = require('../accounting/postgres-costing');

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00.000Z`))) {
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
      if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0)) {
        throw new ValidationError(`Line ${index + 1} unit cost is invalid.`);
      }
      const locationId = line.destinationLocationId || input.destinationLocationId;
      await requireRow(client, 'SELECT id FROM locations WHERE id=$1 AND workspace_id=$2 AND is_active=1',
        [locationId, ctx.workspaceId], `Purchase-order line ${index + 1} needs an active destination location.`);
      resolved.push({ sku, supplierItem, unitsPer, purchaseUnits, quantityUnits, unitCost,
        locationId, description: trimOrNull(line.description) || supplierItem?.supplier_description || sku.name,
        purchaseUnit: trimOrNull(line.purchaseUnit) || supplierItem?.purchase_unit || 'unit',
        supplierSku: trimOrNull(line.supplierSku) || supplierItem?.supplier_sku || null,
        notes: trimOrNull(line.notes) });
    }
    const id = newId('po');
    const poNumber = trimOrNull(input.poNumber) || await numbered(client, ctx.workspaceId, 'purchase_orders', 'PO');
    const orderDate = dateOnly(input.orderDate || at.slice(0, 10), 'Order date');
    await client.query(`INSERT INTO purchase_orders
      (id,workspace_id,po_number,supplier_id,status,order_date,expected_date,expected_date_source,
       destination_location_id,currency,notes,source,source_detail,created_by_user_id,integrity_hash,created_at,updated_at)
      VALUES($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
    [id, ctx.workspaceId, poNumber, supplier.id, orderDate, input.expectedDate || null,
      input.expectedDate ? 'manual' : 'unknown', input.destinationLocationId || null,
      input.currency || supplier.currency || 'USD', trimOrNull(input.notes), input.source || 'manual',
      JSON.stringify(input.sourceDetail || {}), ctx.actorId, crypto.createHash('sha256').update(JSON.stringify(resolved)).digest('hex'), at]);
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
      const posted = await ledger.postInTransaction(client, ctx, {
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
        totalCostMinor, journalEntryId: posted.entry.id, sourceType: 'purchase_order_receipt', sourceRecordId: receiptId });
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
        journalEntryId: posted.entry.id, totalCostMinor, overBy });
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

async function recordSupplierInvoice(database, rawContext, input) {
  const ctx = requireContext(rawContext);
  if (!Array.isArray(input.lines) || !input.lines.length) throw new ValidationError('A supplier invoice needs at least one line.');
  return transaction(database, async (client) => {
    await requirePermission(client, ctx, access.MANAGE_ACCOUNTING, 'record supplier invoices');
    const operation = await beginOperation(client, ctx, 'supplier_invoice.record', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const supplier = await requireRow(client, 'SELECT * FROM suppliers WHERE id=$1 AND workspace_id=$2',
      [input.supplierId, ctx.workspaceId], 'That supplier was not found.');
    const issueDate = dateOnly(input.issueDate || nowIso().slice(0, 10), 'Supplier invoice date');
    const purchaseOrder = input.purchaseOrderId ? await requireRow(client, `SELECT * FROM purchase_orders
      WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [input.purchaseOrderId, ctx.workspaceId], 'That purchase order was not found.') : null;
    if (purchaseOrder && purchaseOrder.supplier_id !== supplier.id) throw new ValidationError('The supplier invoice does not match the purchase order supplier.');
    const prepared = [];
    let subtotal = 0;
    let matchStatus = purchaseOrder ? 'MATCHED' : 'NOT_MATCHED';
    const differences = [];
    const journalLines = [];
    for (const [index, line] of input.lines.entries()) {
      const quantity = Number(line.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) throw new ValidationError(`Supplier invoice line ${index + 1} quantity is invalid.`);
      const unitCostMinor = nonNegativeMinor(line.unitCostMinor, `Supplier invoice line ${index + 1} cost`);
      const lineTotalMinor = Math.round(quantity * unitCostMinor);
      let purchaseLine = null;
      if (line.purchaseOrderLineId) {
        purchaseLine = await requireRow(client, `SELECT * FROM purchase_order_lines
          WHERE id=$1 AND purchase_order_id=$2 AND workspace_id=$3`,
        [line.purchaseOrderLineId, input.purchaseOrderId, ctx.workspaceId],
        `Supplier invoice line ${index + 1} does not match this purchase order.`);
        const billed = await client.query(`SELECT COALESCE(SUM(bl.quantity),0) AS quantity
          FROM accounting_supplier_bill_lines bl JOIN accounting_supplier_bills b ON b.id=bl.bill_id
          WHERE bl.workspace_id=$1 AND bl.purchase_order_line_id=$2 AND b.status IN ('OPEN','PARTIALLY_PAID','PAID')`,
        [ctx.workspaceId, purchaseLine.id]);
        if (Number(billed.rows[0].quantity) + quantity > Number(purchaseLine.quantity_received_units)) {
          matchStatus = 'EXCEPTION';
          differences.push({ line: index + 1, kind: 'invoice_ahead_of_receipt',
            received: Number(purchaseLine.quantity_received_units),
            previouslyBilled: Number(billed.rows[0].quantity), billed: quantity });
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
      prepared.push({ ...line, quantity, unitCostMinor, lineTotalMinor, purchaseLine });
      journalLines.push({ accountKey: purchaseLine ? 'RECEIVED_NOT_INVOICED' : 'OPERATING_EXPENSE',
        debitMinor: lineTotalMinor, supplierId: supplier.id, skuId: line.skuId || purchaseLine?.sku_id || null,
        memo: line.description });
    }
    const taxMinor = nonNegativeMinor(input.taxMinor || 0, 'Supplier invoice tax');
    if (taxMinor) journalLines.push({ accountKey: 'SALES_TAX_RECOVERABLE', debitMinor: taxMinor, supplierId: supplier.id });
    const totalMinor = subtotal + taxMinor;
    journalLines.push({ accountKey: 'ACCOUNTS_PAYABLE', creditMinor: totalMinor, supplierId: supplier.id });
    const billId = newId('apbill');
    const sourceKey = input.sourceKey || `supplier-invoice:${supplier.id}:${input.supplierInvoiceNumber || input.idempotencyKey}`;
    const posted = matchStatus === 'EXCEPTION' ? null : await ledger.postInTransaction(client, ctx, {
      postingDate: issueDate, sourceKey: `journal:${sourceKey}`,
      description: `Supplier invoice ${input.supplierInvoiceNumber || ''}`.trim(),
      sourceType: 'supplier_invoice', sourceRecordType: 'supplier_bill', sourceRecordId: billId,
      currency: input.currency || purchaseOrder?.currency || supplier.currency || 'USD', lines: journalLines,
    });
    const status = matchStatus === 'EXCEPTION' ? 'DISPUTED' : 'OPEN';
    const billNumber = trimOrNull(input.billNumber) || await numbered(client, ctx.workspaceId, 'accounting_supplier_bills', 'BILL');
    const at = nowIso();
    await client.query(`INSERT INTO accounting_supplier_bills
      (id,workspace_id,bill_number,supplier_id,purchase_order_id,purchase_receipt_id,supplier_invoice_number,
       issue_date,due_date,status,match_status,currency,subtotal_minor,tax_minor,total_minor,balance_minor,journal_entry_id,
       source_key,exception_detail,notes,created_by_user_id,created_at,updated_at,opened_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17,$18,$19,$20,$21,$21,
        CASE WHEN $10='OPEN' THEN $21 ELSE NULL END)`,
    [billId, ctx.workspaceId, billNumber, supplier.id, input.purchaseOrderId || null,
      input.purchaseReceiptId || null, input.supplierInvoiceNumber || null, issueDate, input.dueDate || null,
      status, matchStatus, input.currency || purchaseOrder?.currency || supplier.currency || 'USD', subtotal,
      taxMinor, totalMinor, posted?.entry.id || null, sourceKey, JSON.stringify({ differences }),
      trimOrNull(input.notes), ctx.actorId, at]);
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

async function createSalesOrderInTransaction(client, rawContext, input) {
  const ctx = requireContext(rawContext);
  if (!Array.isArray(input.lines) || !input.lines.length) throw new ValidationError('A sales order needs at least one line.');
    await requirePermission(client, ctx, access.OPERATE, 'create sales orders');
    const operation = await beginOperation(client, ctx, 'sales_order.create', input.idempotencyKey);
    if (operation.replayed) return { ...operation.result, replayed: true };
    const customer = await requireRow(client, 'SELECT * FROM customers WHERE id=$1 AND workspace_id=$2 AND record_state=$3',
      [input.customerId, ctx.workspaceId, 'ACTIVE'], 'Choose an active customer from this inventory.');
    if ((input.deliveryMethod || 'SHIP') !== 'PICKUP' && !trimOrNull(input.shipToAddress || customer.shipping_address)) {
      throw new ValidationError('A delivery destination is required before creating a shipped or business-delivered order.');
    }
    const at = nowIso();
    const id = newId('so');
    const orderNumber = trimOrNull(input.orderNumber) || await numbered(client, ctx.workspaceId, 'sales_orders', 'SO');
    await client.query(`INSERT INTO sales_orders
      (id,workspace_id,customer_id,order_number,order_date,needed_by,fulfillment_location_id,delivery_method,
       ship_to_address,ship_to_source,notes,reference,currency,discount_minor,tax_minor,status,version,
       created_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'DRAFT',1,$16,$17,$17)`,
    [id, ctx.workspaceId, customer.id, orderNumber, dateOnly(input.orderDate || at.slice(0, 10), 'Order date'),
      input.neededBy || null, input.fulfillmentLocationId || null, input.deliveryMethod || 'SHIP',
      input.shipToAddress || customer.shipping_address || null, input.shipToAddress ? 'order' : 'customer',
      trimOrNull(input.notes), trimOrNull(input.reference), input.currency || 'USD',
      nonNegativeMinor(input.discountMinor || 0, 'Discount'), nonNegativeMinor(input.taxMinor || 0, 'Tax'), ctx.actorId, at]);
    const lineIds = [];
    for (const [index, line] of input.lines.entries()) {
      await requireRow(client, `SELECT id FROM skus WHERE id=$1 AND workspace_id=$2 AND is_active=1`,
        [line.skuId, ctx.workspaceId], `Sales-order line ${index + 1} has an unavailable SKU.`);
      const lineId = newId('sol'); lineIds.push(lineId);
      await client.query(`INSERT INTO sales_order_lines
        (id,workspace_id,sales_order_id,sku_id,quantity_ordered,quantity_fulfilled,unit_price_minor,notes,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,$8)`,
      [lineId, ctx.workspaceId, id, line.skuId, positiveInteger(line.quantity, `Sales-order line ${index + 1} quantity`),
        nonNegativeMinor(line.unitPriceMinor, `Sales-order line ${index + 1} price`), trimOrNull(line.notes), at]);
    }
    await event(client, 'sales_order_events', null, { workspaceId: ctx.workspaceId, recordId: id,
      type: 'created', detail: { lineCount: lineIds.length }, actorId: ctx.actorId,
      key: `${input.idempotencyKey}:event`, at });
    const result = { salesOrderId: id, orderNumber, status: 'DRAFT', lineIds };
    await completeOperation(client, operation, result);
    return { ...result, replayed: false };
}

async function createSalesOrder(database, rawContext, input) {
  return transaction(database, (client) => createSalesOrderInTransaction(client, rawContext, input));
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
      const revenueMinor = quantity * Number(line.unit_price_minor);
      const posted = await ledger.postInTransaction(client, ctx, {
        postingDate: at.slice(0, 10), sourceKey: `sales-fulfillment:${input.idempotencyKey}:${line.id}:${requested.locationId}`,
        description: `Fulfill ${quantity} units on ${order.order_number}`, sourceType: 'sale_fulfillment',
        sourceRecordType: 'sales_order', sourceRecordId: salesOrderId, currency: order.currency,
        metadata: { movementId: physical.movementId, salesOrderId, salesOrderLineId: line.id,
          revenueMinor, cogsMinor: preparedCost.totalCostMinor },
        lines: [
          { accountKey: 'ACCOUNTS_RECEIVABLE', debitMinor: revenueMinor, customerId: order.customer_id,
            itemId: line.item_id, skuId: line.sku_id, locationId: requested.locationId },
          { accountKey: 'SALES_REVENUE', creditMinor: revenueMinor, customerId: order.customer_id,
            itemId: line.item_id, skuId: line.sku_id, locationId: requested.locationId },
          { accountKey: 'COST_OF_GOODS_SOLD', debitMinor: preparedCost.totalCostMinor, customerId: order.customer_id,
            itemId: line.item_id, skuId: line.sku_id, locationId: requested.locationId },
          { accountKey: 'INVENTORY_ASSET', creditMinor: preparedCost.totalCostMinor, customerId: order.customer_id,
            itemId: line.item_id, skuId: line.sku_id, locationId: requested.locationId },
        ],
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
        movementId: physical.movementId, revenueMinor, costMinor: preparedCost.totalCostMinor,
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
    let fulfillmentTotal = 0;
    for (const line of fulfilled) {
      lineNumber += 1; fulfillmentTotal += line.revenueMinor;
      await client.query(`INSERT INTO accounting_customer_invoice_lines
        (id,workspace_id,invoice_id,line_number,description,quantity,unit_price_minor,line_total_minor,
         revenue_account_id,sku_id,sales_order_line_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [newId('arline'), ctx.workspaceId, invoice.id, lineNumber, `Fulfillment on ${order.order_number}`,
        line.quantity, Math.round(line.revenueMinor / line.quantity), line.revenueMinor, revenueAccount,
        (await requireRow(client, 'SELECT sku_id FROM sales_order_lines WHERE id=$1', [line.lineId], 'Sales line missing.')).sku_id,
        line.lineId, nowIso()]);
    }
    await client.query(`UPDATE accounting_customer_invoices SET subtotal_minor=subtotal_minor+$2,total_minor=total_minor+$2,
      balance_minor=balance_minor+$2,updated_at=$3 WHERE id=$1`, [invoice.id, fulfillmentTotal, nowIso()]);
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
  const desired=new Map();
  for(const [index,line] of input.lines.entries()){
    await requireRow(client,'SELECT id FROM skus WHERE id=$1 AND workspace_id=$2 AND is_active=1',
      [line.skuId,ctx.workspaceId],`Sales-order line ${index+1} has an unavailable SKU.`);
    const quantity=positiveInteger(line.quantity,`Sales-order line ${index+1} quantity`);
    const prior=desired.get(line.skuId);
    desired.set(line.skuId,{skuId:line.skuId,quantity:quantity+(prior?.quantity||0),
      unitPriceMinor:line.unitPriceMinor??prior?.unitPriceMinor});
  }
  await client.query(`DELETE FROM sales_order_allocations WHERE workspace_id=$1 AND sales_order_line_id IN
    (SELECT id FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2)`,[ctx.workspaceId,salesOrderId]);
  const at=nowIso();
  for(const line of current){
    const next=desired.get(line.sku_id);
    if(!next){
      if(Number(line.quantity_fulfilled)>0)await client.query(`UPDATE sales_order_lines
        SET quantity_ordered=quantity_fulfilled,updated_at=$2 WHERE id=$1`,[line.id,at]);
      else await client.query('DELETE FROM sales_order_lines WHERE id=$1',[line.id]);
      continue;
    }
    if(next.quantity<Number(line.quantity_fulfilled))throw new ValidationError('A provider snapshot cannot reduce an order below what was already fulfilled.');
    await client.query(`UPDATE sales_order_lines SET quantity_ordered=$2,unit_price_minor=COALESCE($3,unit_price_minor),
      updated_at=$4 WHERE id=$1`,[line.id,next.quantity,next.unitPriceMinor===undefined?null:
        nonNegativeMinor(next.unitPriceMinor,'Sales-order line price'),at]);
    desired.delete(line.sku_id);
  }
  for(const line of desired.values())await client.query(`INSERT INTO sales_order_lines
    (id,workspace_id,sales_order_id,sku_id,quantity_ordered,quantity_fulfilled,unit_price_minor,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,0,$6,$7,$7)`,[newId('sol'),ctx.workspaceId,salesOrderId,line.skuId,line.quantity,
    nonNegativeMinor(line.unitPriceMinor,'Sales-order line price'),at]);
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
  approvePurchaseOrder,
  placePurchaseOrder,
  receivePurchaseOrder,
  receivePurchaseOrderInTransaction,
  recordSupplierInvoice,
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
  recordCustomerPayment,
  recordCustomerDeposit,
  recordSupplierPayment,
  recordSupplierPaymentInTransaction,
};

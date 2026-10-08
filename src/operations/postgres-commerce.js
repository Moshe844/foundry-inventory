'use strict';

const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const access = require('../actions/permissions');

async function actor(database, workspaceId, actorId) {
  const result = await database.query('SELECT id,role,permissions FROM users WHERE id=$1 AND workspace_id=$2',
    [actorId, workspaceId]);
  if (!result.rows.length) throw new ValidationError('The acting user does not belong to this inventory.');
  return result.rows[0];
}

async function requirePermission(database, ctx, permission, what) {
  access.assertCan(await actor(database, ctx.workspaceId, ctx.actorId), permission, what);
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new ValidationError(`${label} must be a whole number above zero.`);
  return number;
}

async function createSupplierInTransaction(client, ctx, input) {
  await requirePermission(client, ctx, access.MANAGE_SUPPLIERS, 'add suppliers');
  const name = trimOrNull(input.name);
  if (!name) throw new ValidationError('Supplier name is required.');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`supplier:${ctx.workspaceId}:${name.toLowerCase()}`]);
  const duplicate=await client.query('SELECT id FROM suppliers WHERE workspace_id=$1 AND lower(name)=lower($2)',
    [ctx.workspaceId,name]);
  if(duplicate.rows.length)throw new ValidationError('A supplier with that name already exists.');
  const id=newId('sup'); const at=nowIso();
  await client.query(`INSERT INTO suppliers
    (id,workspace_id,name,code,contact_name,email,phone,notes,status,default_lead_time_days,
     minimum_order_amount,currency,payment_terms,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11,$12,$13,$13)`,
  [id,ctx.workspaceId,name,trimOrNull(input.code),trimOrNull(input.contactName),trimOrNull(input.email),
    trimOrNull(input.phone),trimOrNull(input.notes),input.defaultLeadTimeDays?positiveInteger(input.defaultLeadTimeDays,'Lead time'):null,
    input.minimumOrderAmount?Number(input.minimumOrderAmount):null,trimOrNull(input.currency)||'USD',
    trimOrNull(input.paymentTerms),at]);
  return {id,name};
}

async function createSupplier(database, ctx, input) {
  return database.transaction((client)=>createSupplierInTransaction(client,ctx,input),
    {isolation:'SERIALIZABLE',retrySafe:true});
}

async function linkSupplierItemInTransaction(client,ctx,input){
  await requirePermission(client,ctx,access.MANAGE_SUPPLIERS,'link supplier products');
  const supplierId=trimOrNull(input.supplierId);const skuId=trimOrNull(input.skuId);
  if(!supplierId||!skuId)throw new ValidationError('Choose one existing supplier and one exact SKU.');
  const supplier=(await client.query(`SELECT id,status FROM suppliers WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
    [ctx.workspaceId,supplierId])).rows[0];
  const sku=(await client.query(`SELECT s.id FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
      WHERE s.workspace_id=$1 AND s.id=$2 AND s.is_active=1 AND i.is_active=1`,[ctx.workspaceId,skuId])).rows[0];
  if(!supplier||supplier.status!=='active'||!sku)throw new ValidationError(
    'The supplier and active product must both belong to this inventory.');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
    [`supplier-product:${ctx.workspaceId}:${skuId}`]);
  const current=(await client.query(`SELECT * FROM supplier_items
    WHERE workspace_id=$1 AND supplier_id=$2 AND sku_id=$3 FOR UPDATE`,
  [ctx.workspaceId,supplierId,skuId])).rows[0]||null;
  if(input.expectAbsent&&current)throw new ValidationError(
    'This supplier-product link was added after review. Ask again before changing its terms.');
  if(input.expectedUpdatedAt&&new Date(current?.updated_at||0).toISOString()!==
    new Date(input.expectedUpdatedAt).toISOString())throw new ValidationError(
    'The supplier-product terms changed after review. Ask again before approving.');
  const text=(name,fallback)=>Object.hasOwn(input,name)?trimOrNull(input[name]):fallback;
  const whole=(name,fallback,min,max,nullable=false)=>{if(!Object.hasOwn(input,name))return fallback;
    if(input[name]==null||String(input[name]).trim()===''){
      if(nullable)return null;throw new ValidationError(`${name} is required.`);}
    const value=Number(input[name]);if(!Number.isSafeInteger(value)||value<min||value>max)
      throw new ValidationError(`${name} must be a whole number from ${min} to ${max}.`);return value;};
  const cost=Object.hasOwn(input,'lastUnitCost')?(input.lastUnitCost==null||String(input.lastUnitCost).trim()===''
    ?null:Number(input.lastUnitCost)):
    current?.last_unit_cost==null?null:Number(current.last_unit_cost);
  if(cost!==null&&(!Number.isFinite(cost)||cost<0||Math.abs(Math.round(cost*100)-cost*100)>1e-6))
    throw new ValidationError('Unit cost must be a non-negative amount with no more than two decimals.');
  const value={supplierSku:text('supplierSku',current?.supplier_sku||null),
    purchaseUnit:text('purchaseUnit',current?.purchase_unit||'unit')||'unit',
    unitsPerPurchaseUnit:whole('unitsPerPurchaseUnit',Number(current?.units_per_purchase_unit||1),1,100000),
    lastUnitCost:cost,leadTimeDays:whole('leadTimeDays',current?.lead_time_days==null?null:Number(current.lead_time_days),0,365,true),
    minimumOrderQuantity:whole('minimumOrderQuantity',current?.minimum_order_quantity==null?null:Number(current.minimum_order_quantity),0,100000,true),
    orderMultiple:whole('orderMultiple',current?.order_multiple==null?null:Number(current.order_multiple),1,100000,true),
    isPreferred:Object.hasOwn(input,'isPreferred')?[true,1,'true','1'].includes(input.isPreferred):Boolean(current?.is_preferred),
    notes:text('notes',current?.notes||null)};
  if(value.isPreferred)await client.query(`UPDATE supplier_items SET is_preferred=0,updated_at=$3
    WHERE workspace_id=$1 AND sku_id=$2 AND supplier_id<>$4 AND is_preferred=1`,
  [ctx.workspaceId,skuId,nowIso(),supplierId]);
  const at=nowIso();const id=current?.id||newId('supitem');
  const result=await client.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,supplier_sku,purchase_unit,
    units_per_purchase_unit,last_unit_cost,last_cost_at,lead_time_days,minimum_order_quantity,order_multiple,
    is_preferred,is_active,notes,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15,$15)
    ON CONFLICT(workspace_id,supplier_id,sku_id) DO UPDATE SET supplier_sku=EXCLUDED.supplier_sku,
      purchase_unit=EXCLUDED.purchase_unit,units_per_purchase_unit=EXCLUDED.units_per_purchase_unit,
      last_unit_cost=EXCLUDED.last_unit_cost,last_cost_at=EXCLUDED.last_cost_at,
      lead_time_days=EXCLUDED.lead_time_days,minimum_order_quantity=EXCLUDED.minimum_order_quantity,
      order_multiple=EXCLUDED.order_multiple,is_preferred=EXCLUDED.is_preferred,is_active=1,
      notes=EXCLUDED.notes,updated_at=EXCLUDED.updated_at RETURNING id,supplier_id,sku_id,is_active`,
  [id,ctx.workspaceId,supplierId,skuId,value.supplierSku,value.purchaseUnit,value.unitsPerPurchaseUnit,
    value.lastUnitCost,value.lastUnitCost===null?null:at,value.leadTimeDays,
    value.minimumOrderQuantity,value.orderMultiple,value.isPreferred?1:0,value.notes,current?.created_at||at]);
  return result.rows[0];
}

async function linkSupplierItem(database,ctx,input){return database.transaction(
  client=>linkSupplierItemInTransaction(client,ctx,input),{isolation:'SERIALIZABLE',retrySafe:true});}

async function createCustomerInTransaction(client,ctx,input){
  await requirePermission(client, ctx, access.OPERATE, 'add customers');
  const name=trimOrNull(input.name);
  if(!name)throw new ValidationError('Customer name is required.');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`customer:${ctx.workspaceId}:${name.toLowerCase()}`]);
  const duplicate=await client.query('SELECT id FROM customers WHERE workspace_id=$1 AND lower(name)=lower($2)',
    [ctx.workspaceId,name]);
  if(duplicate.rows.length)throw new ValidationError('A customer with that name already exists.');
  const id=newId('customer'); const at=nowIso();
  await client.query(`INSERT INTO customers
    (id,workspace_id,name,company,email,phone,shipping_address,record_state,notes,created_by_user_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,$9,$10,$10)`,
  [id,ctx.workspaceId,name,trimOrNull(input.company),trimOrNull(input.email),trimOrNull(input.phone),
    trimOrNull(input.shippingAddress),trimOrNull(input.notes),ctx.actorId,at]);
  return {id,name};
}

async function createCustomer(database, ctx, input) {
  return database.transaction((client)=>createCustomerInTransaction(client,ctx,input),
    {isolation:'SERIALIZABLE',retrySafe:true});
}

async function suppliers(database, workspaceId) {
  const result=await database.query(`SELECT s.*,
      COALESCE(po.order_count,0)::integer AS order_count,
      COALESCE(b.balance_minor,0)::bigint AS balance_minor
    FROM suppliers s
    LEFT JOIN LATERAL (SELECT COUNT(*) AS order_count FROM purchase_orders po
      WHERE po.workspace_id=s.workspace_id AND po.supplier_id=s.id) po ON true
    LEFT JOIN LATERAL (SELECT SUM(balance_minor) AS balance_minor FROM accounting_supplier_bills b
      WHERE b.workspace_id=s.workspace_id AND b.supplier_id=s.id
        AND b.status IN ('OPEN','PARTIALLY_PAID','DISPUTED')) b ON true
    WHERE s.workspace_id=$1 AND s.status='active'
    ORDER BY lower(s.name)`,[workspaceId]);
  return result.rows.map((row)=>({...row,order_count:Number(row.order_count),balance_minor:Number(row.balance_minor)}));
}

async function customers(database, workspaceId) {
  const result=await database.query(`SELECT c.*,
      COALESCE(so.order_count,0)::integer AS order_count,
      COALESCE(i.balance_minor,0)::bigint AS balance_minor
    FROM customers c
    LEFT JOIN LATERAL (SELECT COUNT(*) AS order_count FROM sales_orders so
      WHERE so.workspace_id=c.workspace_id AND so.customer_id=c.id) so ON true
    LEFT JOIN LATERAL (SELECT SUM(balance_minor) AS balance_minor FROM accounting_customer_invoices i
      WHERE i.workspace_id=c.workspace_id AND i.customer_id=c.id AND i.status IN ('OPEN','PARTIALLY_PAID')) i ON true
    WHERE c.workspace_id=$1 AND c.record_state='ACTIVE'
    ORDER BY lower(c.name)`,[workspaceId]);
  return result.rows.map((row)=>({...row,order_count:Number(row.order_count),balance_minor:Number(row.balance_minor)}));
}

async function catalogue(database, workspaceId) {
  const result=await database.query(`SELECT s.id,s.code,s.variant_label,i.name AS item_name,
      CASE WHEN COALESCE(s.variant_label,'')='' THEN i.name ELSE i.name||' / '||s.variant_label END AS display_name,
      p.amount_minor,p.currency,COALESCE(b.on_hand,0)::bigint AS on_hand,
      COALESCE(a.committed,0)::bigint AS committed
    FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    LEFT JOIN LATERAL (SELECT amount_minor,currency FROM sku_prices sp WHERE sp.workspace_id=s.workspace_id
      AND sp.sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1) p ON true
    LEFT JOIN (SELECT workspace_id,sku_id,SUM(on_hand) AS on_hand FROM balances GROUP BY workspace_id,sku_id) b
      ON b.workspace_id=s.workspace_id AND b.sku_id=s.id
    LEFT JOIN (SELECT sol.workspace_id,sol.sku_id,SUM(soa.quantity) AS committed
      FROM sales_order_allocations soa JOIN sales_order_lines sol ON sol.id=soa.sales_order_line_id
      GROUP BY sol.workspace_id,sol.sku_id) a ON a.workspace_id=s.workspace_id AND a.sku_id=s.id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1
    ORDER BY lower(i.name),s.position,s.id`,[workspaceId]);
  return result.rows.map((row)=>({...row,amount_minor:row.amount_minor===null?null:Number(row.amount_minor),
    on_hand:Number(row.on_hand),committed:Number(row.committed),available:Number(row.on_hand)-Number(row.committed)}));
}

async function locations(database, workspaceId) {
  return (await database.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 ORDER BY lower(name)`,
    [workspaceId])).rows;
}

async function purchaseOrders(database, workspaceId) {
  const result=await database.query(`SELECT po.*,s.name AS supplier_name,
      COUNT(pol.id)::integer AS line_count,
      COALESCE(SUM(pol.line_total),0) AS total,
      COALESCE(SUM(pol.quantity_units),0)::bigint AS ordered_units,
      COALESCE(SUM(pol.quantity_units-pol.quantity_received_units),0)::bigint AS units_outstanding,
      COUNT(pol.id) FILTER (WHERE pol.unit_cost IS NOT NULL)::integer AS priced_line_count,
      COALESCE((SELECT SUM(balance_minor) FROM accounting_supplier_bills b
        WHERE b.workspace_id=po.workspace_id AND b.purchase_order_id=po.id AND b.status<>'VOID'),0)::bigint AS balance_minor
    FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id AND s.workspace_id=po.workspace_id
    LEFT JOIN purchase_order_lines pol ON pol.purchase_order_id=po.id AND pol.workspace_id=po.workspace_id
    WHERE po.workspace_id=$1 GROUP BY po.id,s.name ORDER BY po.created_at DESC,po.id DESC`,[workspaceId]);
  return result.rows.map((row)=>({...row,line_count:Number(row.line_count),total:Number(row.total),
    ordered_units:Number(row.ordered_units),units_outstanding:Number(row.units_outstanding),
    priced_line_count:Number(row.priced_line_count),balance_minor:Number(row.balance_minor)}));
}

async function purchaseOrder(database, workspaceId, id) {
  const header=await database.query(`SELECT po.*,s.name AS supplier_name,s.email AS supplier_email
    FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id AND s.workspace_id=po.workspace_id
    WHERE po.workspace_id=$1 AND po.id=$2`,[workspaceId,id]);
  if(!header.rows.length)throw new NotFoundError('That purchase order was not found.');
  const [lines,receipts,bills,events]=await Promise.all([
    database.query(`SELECT pol.*,i.name AS item_name,i.tracking_mode,i.unit_label,s.code,s.variant_label,l.name AS location_name
      FROM purchase_order_lines pol JOIN skus s ON s.id=pol.sku_id JOIN items i ON i.id=s.item_id
      LEFT JOIN locations l ON l.id=pol.destination_location_id
      WHERE pol.workspace_id=$1 AND pol.purchase_order_id=$2 ORDER BY pol.line_number`,[workspaceId,id]),
    database.query(`SELECT * FROM purchase_order_receipts WHERE workspace_id=$1 AND purchase_order_id=$2 ORDER BY received_at DESC,id DESC`,[workspaceId,id]),
    database.query(`SELECT b.*,COALESCE((SELECT SUM(amount_minor) FROM accounting_payment_allocations a
      WHERE a.workspace_id=b.workspace_id AND a.supplier_bill_id=b.id),0)::bigint AS paid_minor
      FROM accounting_supplier_bills b WHERE b.workspace_id=$1 AND b.purchase_order_id=$2 ORDER BY issue_date DESC,id DESC`,[workspaceId,id]),
    database.query(`SELECT * FROM purchase_order_events WHERE workspace_id=$1 AND purchase_order_id=$2 ORDER BY created_at DESC,id DESC`,[workspaceId,id]),
  ]);
  return {order:header.rows[0],lines:lines.rows,receipts:receipts.rows,bills:bills.rows.map((row)=>({...row,
    total_minor:Number(row.total_minor),balance_minor:Number(row.balance_minor),paid_minor:Number(row.paid_minor)})),events:events.rows};
}

async function salesOrders(database, workspaceId) {
  const result=await database.query(`SELECT so.*,c.name AS customer_name,
      COUNT(sol.id)::integer AS line_count,
      COALESCE(SUM(sol.quantity_ordered),0)::bigint AS units_ordered,
      COALESCE(SUM(sol.quantity_fulfilled),0)::bigint AS units_fulfilled,
      COALESCE(SUM(sol.quantity_ordered*sol.unit_price_minor),0)::bigint AS total_minor,
      COALESCE((SELECT SUM(balance_minor) FROM accounting_customer_invoices i
        WHERE i.workspace_id=so.workspace_id AND i.sales_order_id=so.id AND i.status<>'VOID'),0)::bigint AS balance_minor
    FROM sales_orders so JOIN customers c ON c.id=so.customer_id AND c.workspace_id=so.workspace_id
    LEFT JOIN sales_order_lines sol ON sol.sales_order_id=so.id AND sol.workspace_id=so.workspace_id
    WHERE so.workspace_id=$1 GROUP BY so.id,c.name ORDER BY so.created_at DESC,so.id DESC`,[workspaceId]);
  return result.rows.map((row)=>({...row,line_count:Number(row.line_count),units_ordered:Number(row.units_ordered),
    units_fulfilled:Number(row.units_fulfilled),total_minor:Number(row.total_minor),balance_minor:Number(row.balance_minor)}));
}

async function salesOrder(database, workspaceId, id) {
  const header=await database.query(`SELECT so.*,c.name AS customer_name,c.email AS customer_email
    FROM sales_orders so JOIN customers c ON c.id=so.customer_id AND c.workspace_id=so.workspace_id
    WHERE so.workspace_id=$1 AND so.id=$2`,[workspaceId,id]);
  if(!header.rows.length)throw new NotFoundError('That sales order was not found.');
  const [lines,invoices,shipments,events,paymentRequests,paymentTerms,orderReceipts]=await Promise.all([
    database.query(`SELECT sol.*,i.id AS item_id,i.name AS item_name,i.tracking_mode,i.unit_label,s.code,s.variant_label,
      COALESCE((SELECT SUM(quantity) FROM sales_order_allocations a WHERE a.sales_order_line_id=sol.id),0)::bigint AS allocated
      ,COALESCE((SELECT SUM(rl.quantity_authorized) FROM customer_return_lines rl
        JOIN customer_returns r ON r.id=rl.customer_return_id
        WHERE rl.sales_order_line_id=sol.id AND r.status<>'CANCELLED'),0)::bigint AS quantity_returned
      FROM sales_order_lines sol JOIN skus s ON s.id=sol.sku_id JOIN items i ON i.id=s.item_id
      WHERE sol.workspace_id=$1 AND sol.sales_order_id=$2 ORDER BY sol.created_at,sol.id`,[workspaceId,id]),
    database.query(`SELECT i.*,COALESCE((SELECT SUM(amount_minor) FROM accounting_payment_allocations a
      WHERE a.workspace_id=i.workspace_id AND a.customer_invoice_id=i.id),0)::bigint AS paid_minor
      FROM accounting_customer_invoices i WHERE i.workspace_id=$1 AND i.sales_order_id=$2 ORDER BY issue_date DESC,id DESC`,[workspaceId,id]),
    database.query(`SELECT * FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2 ORDER BY created_at DESC,id DESC`,[workspaceId,id]),
    database.query(`SELECT * FROM sales_order_events WHERE workspace_id=$1 AND sales_order_id=$2 ORDER BY created_at DESC,id DESC`,[workspaceId,id]),
    database.query(`SELECT request.*,effect.status AS effect_status,effect.error_message AS effect_error_message
      FROM payment_requests request LEFT JOIN stockchief_runtime.provider_effects effect
        ON effect.workspace_id=request.workspace_id AND effect.kind='payment.request.create'
        AND effect.payload->>'requestId'=request.id
      WHERE request.workspace_id=$1 AND request.sales_order_id=$2 ORDER BY request.created_at DESC,request.id DESC`,[workspaceId,id]),
    database.query(`SELECT * FROM customer_payment_terms
      WHERE workspace_id=$1 AND (customer_id=$2 OR customer_id IS NULL)
      ORDER BY (customer_id IS NULL),updated_at DESC,id DESC LIMIT 1`,[workspaceId,header.rows[0].customer_id]),
    database.query(`SELECT COALESCE(SUM(amount_minor),0)::bigint AS received_minor
      FROM accounting_payments WHERE workspace_id=$1 AND sales_order_id=$2
        AND direction='CUSTOMER_RECEIPT' AND status='POSTED'`,[workspaceId,id]),
  ]);
  const allocations=(await database.query(`SELECT a.*,l.name AS location_name FROM sales_order_allocations a
    JOIN sales_order_lines sol ON sol.id=a.sales_order_line_id JOIN locations l ON l.id=a.location_id
    WHERE a.workspace_id=$1 AND sol.sales_order_id=$2 ORDER BY sol.created_at,l.name`,[workspaceId,id])).rows;
  const byLine=new Map(); for(const row of allocations){if(!byLine.has(row.sales_order_line_id))byLine.set(row.sales_order_line_id,[]);byLine.get(row.sales_order_line_id).push(row);}
  const mappedLines=lines.rows.map((row)=>({...row,allocated:Number(row.allocated),
    quantity_returned:Number(row.quantity_returned),allocations:byLine.get(row.id)||[]}));
  const terms=paymentTerms.rows[0]||null;
  const orderTotalMinor=Math.max(0,mappedLines.reduce((sum,row)=>sum+Number(row.quantity_ordered)*Number(row.unit_price_minor),0)
    -Number(header.rows[0].discount_minor||0)+Number(header.rows[0].tax_minor||0));
  const requiredDepositMinor=terms?.kind==='DEPOSIT'?(terms.deposit_minor==null
    ?Math.round(orderTotalMinor*Number(terms.deposit_percent||0)/100):Math.min(orderTotalMinor,Number(terms.deposit_minor))):0;
  return {order:header.rows[0],lines:mappedLines,
    invoices:invoices.rows.map((row)=>({...row,total_minor:Number(row.total_minor),balance_minor:Number(row.balance_minor),
      paid_minor:Number(row.paid_minor)})),shipments:shipments.rows,events:events.rows,
    paymentTerms:terms,orderTotalMinor,requiredDepositMinor,
    depositDueMinor:Math.max(0,requiredDepositMinor-Number(orderReceipts.rows[0].received_minor)),
    paymentRequests:paymentRequests.rows.map((row)=>({...row,amount_minor:Number(row.amount_minor),paid_minor:Number(row.paid_minor)}))};
}

module.exports={createSupplier,createSupplierInTransaction,linkSupplierItem,linkSupplierItemInTransaction,
  createCustomer,createCustomerInTransaction,suppliers,customers,catalogue,locations,purchaseOrders,purchaseOrder,salesOrders,salesOrder};
require('../commercial/enforcement').guardExports(module.exports,0,1,{createSupplier:'purchasing.suppliers',createSupplierInTransaction:'purchasing.suppliers',
  linkSupplierItem:'purchasing.suppliers',linkSupplierItemInTransaction:'purchasing.suppliers',
  createCustomer:'sales_orders.core',createCustomerInTransaction:'sales_orders.core'});

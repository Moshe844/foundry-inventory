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

function supplierItemValues(input,current){
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
    isPreferred:Object.hasOwn(input,'isPreferred')?[true,1,'true','1'].includes(input.isPreferred):Boolean(Number(current?.is_preferred)),
    notes:text('notes',current?.notes||null)};

 return value;
}
async function linkSupplierItemsInTransaction(client,ctx,inputs){
 if(!inputs.length)return [];
 if(inputs.length>1000)throw new ValidationError('Link at most 1,000 supplier products per batch.');
 await requirePermission(client,ctx,access.MANAGE_SUPPLIERS,'link supplier products');
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['supplier-links:'+ctx.workspaceId]);
 const unique=new Map();for(const input of inputs){const supplierId=trimOrNull(input.supplierId),skuId=trimOrNull(input.skuId);if(!supplierId||!skuId)throw new ValidationError('Choose one existing supplier and one exact SKU.');
  const key=JSON.stringify([supplierId,skuId]),prior=unique.get(key);if(prior){for(const [name,value]of Object.entries(input))if(Object.hasOwn(prior,name)&&prior[name]!==value)throw new ValidationError('Conflicting supplier-product terms need review.');unique.set(key,{...prior,...input});}else unique.set(key,{...input,supplierId,skuId});}inputs=[...unique.values()];
 const pairs=inputs.map(i=>({supplier_id:i.supplierId,sku_id:i.skuId}));
 const valid=(await client.query(`SELECT x.supplier_id,x.sku_id FROM jsonb_to_recordset($2::jsonb) AS x(supplier_id text,sku_id text)
  JOIN suppliers p ON p.workspace_id=$1 AND p.id=x.supplier_id AND p.status='active'
  JOIN skus s ON s.workspace_id=$1 AND s.id=x.sku_id AND s.is_active=1 JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1`,[ctx.workspaceId,JSON.stringify(pairs)])).rows;
 if(valid.length!==pairs.length)throw new ValidationError('The supplier and active product must both belong to this inventory.');
 const current=(await client.query(`SELECT p.* FROM supplier_items p JOIN jsonb_to_recordset($2::jsonb) AS x(supplier_id text,sku_id text) ON p.supplier_id=x.supplier_id AND p.sku_id=x.sku_id WHERE p.workspace_id=$1 FOR UPDATE OF p`,[ctx.workspaceId,JSON.stringify(pairs)])).rows;
 const indexed=new Map(current.map(r=>[JSON.stringify([r.supplier_id,r.sku_id]),r])),at=nowIso(),preferred=new Map();
 const rows=inputs.map(input=>{const prior=indexed.get(JSON.stringify([input.supplierId,input.skuId]));
  if(input.expectAbsent&&prior)throw new ValidationError('This supplier-product link was added after review. Ask again before changing its terms.');
  if(input.expectedUpdatedAt&&new Date(prior?.updated_at||0).toISOString()!==new Date(input.expectedUpdatedAt).toISOString())throw new ValidationError('The supplier-product terms changed after review. Ask again before approving.');
  const value=supplierItemValues(input,prior);if(value.isPreferred){if(preferred.has(input.skuId)&&preferred.get(input.skuId)!==input.supplierId)throw new ValidationError('Choose one preferred supplier per product.');preferred.set(input.skuId,input.supplierId);}
  return {id:prior?.id||newId('supitem'),supplier_id:input.supplierId,sku_id:input.skuId,supplier_sku:value.supplierSku,purchase_unit:value.purchaseUnit,units_per_purchase_unit:value.unitsPerPurchaseUnit,last_unit_cost:value.lastUnitCost,last_cost_at:value.lastUnitCost===null?null:at,lead_time_days:value.leadTimeDays,minimum_order_quantity:value.minimumOrderQuantity,order_multiple:value.orderMultiple,is_preferred:value.isPreferred?1:0,notes:value.notes,created_at:prior?.created_at||at};
 });
 if(preferred.size)await client.query(`UPDATE supplier_items p SET is_preferred=0,updated_at=$3 FROM jsonb_to_recordset($2::jsonb) AS x(sku_id text,supplier_id text) WHERE p.workspace_id=$1 AND p.sku_id=x.sku_id AND p.supplier_id<>x.supplier_id AND p.is_preferred=1`,[ctx.workspaceId,JSON.stringify([...preferred].map(([sku_id,supplier_id])=>({sku_id,supplier_id}))),at]);
 const result=await client.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,supplier_sku,purchase_unit,units_per_purchase_unit,last_unit_cost,last_cost_at,lead_time_days,minimum_order_quantity,order_multiple,is_preferred,is_active,notes,created_at,updated_at)
  SELECT x.id,$1,x.supplier_id,x.sku_id,x.supplier_sku,x.purchase_unit,x.units_per_purchase_unit,x.last_unit_cost,x.last_cost_at,x.lead_time_days,x.minimum_order_quantity,x.order_multiple,x.is_preferred,1,x.notes,x.created_at,$3
  FROM jsonb_to_recordset($2::jsonb) AS x(id text,supplier_id text,sku_id text,supplier_sku text,purchase_unit text,units_per_purchase_unit bigint,last_unit_cost numeric,last_cost_at text,lead_time_days bigint,minimum_order_quantity bigint,order_multiple bigint,is_preferred bigint,notes text,created_at text)
  ON CONFLICT(workspace_id,supplier_id,sku_id) DO UPDATE SET supplier_sku=EXCLUDED.supplier_sku,purchase_unit=EXCLUDED.purchase_unit,units_per_purchase_unit=EXCLUDED.units_per_purchase_unit,last_unit_cost=EXCLUDED.last_unit_cost,last_cost_at=EXCLUDED.last_cost_at,lead_time_days=EXCLUDED.lead_time_days,minimum_order_quantity=EXCLUDED.minimum_order_quantity,order_multiple=EXCLUDED.order_multiple,is_preferred=EXCLUDED.is_preferred,is_active=1,notes=EXCLUDED.notes,updated_at=EXCLUDED.updated_at RETURNING id,supplier_id,sku_id,is_active`,[ctx.workspaceId,JSON.stringify(rows),at]);
 return result.rows;
}
async function linkSupplierItemInTransaction(client,ctx,input){return (await linkSupplierItemsInTransaction(client,ctx,[input]))[0];}

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

async function catalogue(database, workspaceId, {limit=null,search='',ids=null,trackingMode=null}={}) {
  // Immediately after a bulk import the planner can still estimate one item
  // per tenant and repeatedly scan that tenant's entire item index. Keep the
  // unique-ID lookup as a boundary, then enforce tenant/activity outside it.
  const result=await database.query(`WITH selected AS (SELECT s.*,i.name AS item_name,i.tracking_mode FROM skus s
    JOIN LATERAL (SELECT name,workspace_id,is_active,tracking_mode FROM items WHERE id=s.item_id OFFSET 0) i
      ON i.workspace_id=s.workspace_id AND i.is_active=1
    WHERE s.workspace_id=$1 AND s.is_active=1
      AND ($2::text[] IS NULL OR s.id=ANY($2::text[]))
      AND ($3='' OR position(lower($3) in lower(s.code||' '||i.name||' '||coalesce(s.variant_label,'')))>0)
      AND ($5::text IS NULL OR i.tracking_mode=$5)
    ORDER BY lower(i.name),s.position,s.id LIMIT $4)
    SELECT s.id,s.code,s.variant_label,s.item_name,s.weight_grams,s.tracking_mode,
      CASE WHEN coalesce(s.variant_label,'')='' THEN s.item_name ELSE s.item_name||' / '||s.variant_label END AS display_name,
      p.amount_minor,p.currency,coalesce(b.on_hand,0)::bigint AS on_hand,coalesce(a.committed,0)::bigint AS committed
    FROM selected s LEFT JOIN LATERAL(SELECT amount_minor,currency FROM sku_prices p
      WHERE p.workspace_id=$1 AND p.sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)p ON true
    LEFT JOIN LATERAL(SELECT sum(on_hand) AS on_hand FROM balances WHERE workspace_id=$1 AND sku_id=s.id)b ON true
    LEFT JOIN LATERAL(SELECT sum(a.quantity) AS committed FROM sales_order_allocations a JOIN sales_order_lines l
      ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id WHERE l.workspace_id=$1 AND l.sku_id=s.id)a ON true`,
    [workspaceId,ids,String(search).slice(0,120),limit,trackingMode]);
  const positions=(await database.query(`SELECT b.sku_id,b.location_id,b.on_hand,coalesce(a.committed,0) AS committed
    FROM balances b LEFT JOIN LATERAL(SELECT sum(a.quantity) AS committed FROM sales_order_allocations a
      JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id
      WHERE a.workspace_id=$1 AND l.sku_id=b.sku_id AND a.location_id=b.location_id)a ON true
    WHERE b.workspace_id=$1 AND b.sku_id=ANY($2::text[])`,[workspaceId,result.rows.map(r=>r.id)])).rows,bySku=new Map();
  for(const r of positions){if(!bySku.has(r.sku_id))bySku.set(r.sku_id,[]);bySku.get(r.sku_id).push({location_id:r.location_id,onHand:Number(r.on_hand),committed:Number(r.committed),available:Number(r.on_hand)-Number(r.committed)});}
  return result.rows.map(r=>({...r,amount_minor:r.amount_minor==null?null:Number(r.amount_minor),on_hand:Number(r.on_hand),committed:Number(r.committed),available:Number(r.on_hand)-Number(r.committed),positions:bySku.get(r.id)||[]}));
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
      COALESCE(so.pricing_total_minor,(COALESCE(SUM(sol.quantity_ordered*sol.unit_price_minor),0)-COALESCE(so.discount_minor,0)+COALESCE(so.tax_minor,0)))::bigint AS total_minor,
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
  const orderTotalMinor=header.rows[0].pricing_total_minor===null?Math.max(0,mappedLines.reduce((sum,row)=>sum+Number(row.quantity_ordered)*Number(row.unit_price_minor),0)
    -Number(header.rows[0].discount_minor||0)+Number(header.rows[0].tax_minor||0)):Number(header.rows[0].pricing_total_minor);
  const requiredDepositMinor=terms?.kind==='DEPOSIT'?(terms.deposit_minor==null
    ?Math.round(orderTotalMinor*Number(terms.deposit_percent||0)/100):Math.min(orderTotalMinor,Number(terms.deposit_minor))):0;
  return {order:header.rows[0],lines:mappedLines,
    invoices:invoices.rows.map((row)=>({...row,total_minor:Number(row.total_minor),balance_minor:Number(row.balance_minor),
      paid_minor:Number(row.paid_minor)})),shipments:shipments.rows,events:events.rows,
    paymentTerms:terms,orderTotalMinor,requiredDepositMinor,
    depositDueMinor:Math.max(0,requiredDepositMinor-Number(orderReceipts.rows[0].received_minor)),
    paymentRequests:paymentRequests.rows.map((row)=>({...row,amount_minor:Number(row.amount_minor),paid_minor:Number(row.paid_minor)}))};
}

module.exports={linkSupplierItemsInTransaction,createSupplier,createSupplierInTransaction,linkSupplierItem,linkSupplierItemInTransaction,
  createCustomer,createCustomerInTransaction,suppliers,customers,catalogue,locations,purchaseOrders,purchaseOrder,salesOrders,salesOrder};
require('../commercial/enforcement').guardExports(module.exports,0,1,{createSupplier:'purchasing.suppliers',createSupplierInTransaction:'purchasing.suppliers',
  linkSupplierItem:'purchasing.suppliers',linkSupplierItemInTransaction:'purchasing.suppliers',linkSupplierItemsInTransaction:'purchasing.suppliers',
  createCustomer:'sales_orders.core',createCustomerInTransaction:'sales_orders.core'});

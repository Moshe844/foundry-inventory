'use strict';

// The model chooses a relational plan, never SQL. Only these reviewed read
// models and operators can reach the database. Aggregation precedes pagination.
const { ValidationError } = require('../domain/errors');
const { escapeLike } = require('../lib/util');
const destinations = require('../product-brain/destinations');

const COMMITTED = `SELECT sol.sku_id, a.location_id, a.quantity FROM sales_order_allocations a
 JOIN sales_order_lines sol ON sol.id=a.sales_order_line_id AND sol.workspace_id=@w
 JOIN sales_orders so ON so.id=sol.sales_order_id AND so.workspace_id=@w
 WHERE a.workspace_id=@w AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
 UNION ALL SELECT kc.component_sku_id, a.location_id, a.quantity FROM sales_order_kit_allocations a
 JOIN sales_order_kit_components kc ON kc.id=a.kit_component_id AND kc.workspace_id=@w
 JOIN sales_order_lines sol ON sol.id=kc.sales_order_line_id AND sol.workspace_id=@w
 JOIN sales_orders so ON so.id=sol.sales_order_id AND so.workspace_id=@w
 WHERE a.workspace_id=@w AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')`;
const CTE = `WITH committed AS (${COMMITTED}), incoming AS (
 SELECT l.sku_id, SUM(MAX(0,l.quantity_units-l.quantity_received_units)) quantity
 FROM purchase_order_lines l JOIN purchase_orders po ON po.id=l.purchase_order_id AND po.workspace_id=@w
 WHERE l.workspace_id=@w AND po.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED') GROUP BY l.sku_id),
 stock AS (SELECT s.item_id, s.id sku_id,
 COALESCE((SELECT SUM(on_hand) FROM balances WHERE sku_id=s.id AND workspace_id=@w),0) on_hand,
 COALESCE((SELECT SUM(quantity) FROM committed WHERE sku_id=s.id),0) committed,
 COALESCE((SELECT quantity FROM incoming WHERE sku_id=s.id),0) incoming
 FROM skus s WHERE s.workspace_id=@w AND s.is_active=1),
 product_stock AS (SELECT item_id,SUM(on_hand) on_hand,SUM(committed) committed,SUM(incoming) incoming,COUNT(*) variants
 FROM stock GROUP BY item_id)`;

const REGISTRY = {
 products: {
  description: 'One row per product (not SKU). Active and archived catalogue, network-wide stock. status is the inventory screen status.',
  href: '/inventory',
  sql: `SELECT i.id,i.name product,i.base_code code,i.description,i.unit_label unit,i.tracking_mode tracking,
   i.is_active active,i.has_variants has_variants,f.category,
   COALESCE(p.variants,0) variants,COALESCE(p.on_hand,0) on_hand,
   COALESCE(p.committed,0) committed,MAX(0,COALESCE(p.on_hand,0)-COALESCE(p.committed,0)) available,
   COALESCE(p.incoming,0) incoming,
   EXISTS(SELECT 1 FROM movements m WHERE m.item_id=i.id AND m.workspace_id=@w) has_history,
   CASE WHEN i.is_active=0 THEN 'Archived'
    WHEN p.on_hand>0 AND p.on_hand-p.committed<=0 THEN 'All committed'
    WHEN p.on_hand>0 THEN 'In stock' WHEN p.incoming>0 THEN 'On the way'
    WHEN NOT EXISTS(SELECT 1 FROM movements m WHERE m.item_id=i.id AND m.workspace_id=@w) THEN 'None yet'
    ELSE 'Out of stock' END status,i.created_at
   FROM items i LEFT JOIN product_stock p ON p.item_id=i.id
   LEFT JOIN catalogue_item_facts f ON f.item_id=i.id AND f.workspace_id=@w WHERE i.workspace_id=@w`,
  text: ['product','code','description','unit','tracking','category','status','created_at'],
  number: ['active','has_variants','variants','on_hand','committed','available','incoming','has_history'],
  defaults: ['product','code','on_hand','available','incoming','status'],
 },
 variants: {
  description: 'One row per actual SKU. Variant options and arbitrary supplied facts are available as attribute:<exact field name>. Never invent absent attributes.',
  href: '/inventory',
  sql: `SELECT s.id,s.item_id,i.name product,s.code sku,s.variant_label variant,s.barcode,
   s.is_active active,i.tracking_mode tracking,i.unit_label unit,
   COALESCE(st.on_hand,0) on_hand,COALESCE(st.committed,0) committed,
   MAX(0,COALESCE(st.on_hand,0)-COALESCE(st.committed,0)) available,
   COALESCE(st.incoming,0) incoming FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=@w
   LEFT JOIN stock st ON st.sku_id=s.id WHERE s.workspace_id=@w`,
  text: ['product','sku','variant','barcode','tracking','unit'],
  number: ['active','on_hand','committed','available','incoming'],
  defaults: ['product','sku','variant','on_hand','available'],
 },
 positions: {
  description: 'One row per recorded SKU/location balance; absent balances are not evidence of recorded stock. Quantities at a named location, not product totals.',
  href: '/inventory',
  sql: `SELECT s.id,s.item_id,i.name product,s.code sku,l.name location,l.kind location_kind,b.on_hand,
   COALESCE((SELECT SUM(quantity) FROM committed c WHERE c.sku_id=s.id AND c.location_id=l.id),0) committed,
   MAX(0,b.on_hand-COALESCE((SELECT SUM(quantity) FROM committed c WHERE c.sku_id=s.id AND c.location_id=l.id),0)) available
   FROM balances b JOIN skus s ON s.id=b.sku_id AND s.workspace_id=@w
   JOIN items i ON i.id=s.item_id AND i.workspace_id=@w
   JOIN locations l ON l.id=b.location_id AND l.workspace_id=@w
   WHERE b.workspace_id=@w AND i.is_active=1 AND s.is_active=1`,
  text: ['product','sku','location','location_kind'], number: ['on_hand','committed','available'],
  defaults: ['product','sku','location','on_hand','available'],
 },
 movements: {
  description: 'One immutable stock-ledger movement per row. quantity_delta is signed, operation describes the recorded event. Filter occurred_at explicitly for date windows.',
  // The stock ledger has no page of its own; its records are inventory's, and
  // an address the product brain does not know is a dataset no member can
  // read. '/movements' hid this dataset from every planner call.
  href: '/inventory',
  sql: `SELECT m.id,i.name product,s.code sku,l.name location,m.operation,m.quantity_delta,m.occurred_at
   FROM movements m JOIN items i ON i.id=m.item_id AND i.workspace_id=@w
   JOIN skus s ON s.id=m.sku_id AND s.workspace_id=@w
   JOIN locations l ON l.id=m.location_id AND l.workspace_id=@w WHERE m.workspace_id=@w`,
  text: ['product','sku','location','operation','occurred_at'], number: ['quantity_delta'],
  defaults: ['product','sku','location','operation','quantity_delta','occurred_at'],
 },
 locations: {
  description: 'Recorded locations including archived ones.', href: '/locations',
  sql: 'SELECT id,name location,kind,barcode,is_active active,created_at FROM locations WHERE workspace_id=@w',
  text: ['location','kind','barcode','created_at'], number: ['active'], defaults: ['location','kind','active'],
 },
 customers: {
  description: 'Recorded customers; record_state distinguishes ACTIVE, PROVISIONAL and ARCHIVED.', href: '/sales/customers',
  sql: 'SELECT id,name customer,company,email,phone,record_state,created_at FROM customers WHERE workspace_id=@w',
  text: ['customer','company','email','phone','record_state','created_at'], number: [], defaults: ['customer','company','record_state'],
 },
 suppliers: {
  description: 'Recorded supplier identities.', href: '/purchasing/suppliers',
  sql: "SELECT id,name supplier,email,phone,(status='active') active,created_at FROM suppliers WHERE workspace_id=@w",
  text: ['supplier','email','phone','created_at'], number: ['active'], defaults: ['supplier','email','active'],
 },
 purchase_orders: {
  description: 'One row per purchase order, not order line; DRAFT is not ordered stock.', href: '/purchasing/orders',
  sql: `SELECT po.id,po.po_number order_number,s.name supplier,po.status,po.order_date,po.expected_date,
    po.currency,po.created_at FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id AND s.workspace_id=@w WHERE po.workspace_id=@w`,
  text: ['order_number','supplier','status','order_date','expected_date','currency','created_at'], number: [],
  defaults: ['order_number','supplier','status','expected_date'],
 },
 sales_orders: {
  description: 'One row per customer sales order; order status is not proof of payment.', href: '/sales/orders',
  sql: `SELECT so.id,so.order_number,c.name customer,so.status,so.order_date,so.needed_by,so.currency,so.created_at
   FROM sales_orders so JOIN customers c ON c.id=so.customer_id AND c.workspace_id=@w WHERE so.workspace_id=@w`,
  text: ['order_number','customer','status','order_date','needed_by','currency','created_at'], number: [],
  defaults: ['order_number','customer','status','needed_by'],
 },
 /*
  * The other half of the business. Order lines, bills, invoices, payments,
  * shipments, returns, reorder settings and supplier items were not
  * queryable at all: "show this customer's recent purchases" could only
  * count orders, and "below reorder point" had nothing to read. Same
  * allow-list, same @w discipline, money in minor units named as such.
  */
 purchase_order_lines: {
  description: 'One row per line of a purchase order: product, quantities ordered and received in inventory units, unit_cost per inventory unit. Join by order_number; outstanding = quantity_units - quantity_received.', href: '/purchasing/orders',
  sql: `SELECT l.id,po.po_number order_number,s2.name supplier,po.status order_status,po.expected_date,i.name product,sk.code sku,sk.variant_label variant,
    l.purchase_unit,l.units_per_purchase_unit,l.quantity_purchase_units,l.quantity_units,l.quantity_received_units quantity_received,
    (l.quantity_units-l.quantity_received_units) outstanding,l.unit_cost,l.line_total,l.created_at
   FROM purchase_order_lines l JOIN purchase_orders po ON po.id=l.purchase_order_id AND po.workspace_id=@w
   JOIN suppliers s2 ON s2.id=po.supplier_id AND s2.workspace_id=@w
   JOIN skus sk ON sk.id=l.sku_id AND sk.workspace_id=@w JOIN items i ON i.id=sk.item_id AND i.workspace_id=@w WHERE l.workspace_id=@w`,
  text: ['order_number','supplier','order_status','expected_date','product','sku','variant','purchase_unit','created_at'],
  number: ['units_per_purchase_unit','quantity_purchase_units','quantity_units','quantity_received','outstanding','unit_cost','line_total'],
  defaults: ['order_number','supplier','product','quantity_units','quantity_received','unit_cost'],
 },
 sales_order_lines: {
  description: 'One row per line of a customer sales order: product, quantity ordered and fulfilled, unit_price_minor in minor units (cents). line_value_minor = quantity_ordered × unit_price_minor. Join by order_number; "what a customer bought" is this dataset filtered by customer.', href: '/sales/orders',
  sql: `SELECT l.id,so.order_number,c.name customer,so.status order_status,so.order_date,i.name product,sk.code sku,sk.variant_label variant,
    l.quantity_ordered,l.quantity_fulfilled,(l.quantity_ordered-l.quantity_fulfilled) unfulfilled,l.unit_price_minor,
    (l.quantity_ordered*COALESCE(l.unit_price_minor,0)) line_value_minor,l.created_at
   FROM sales_order_lines l JOIN sales_orders so ON so.id=l.sales_order_id AND so.workspace_id=@w
   JOIN customers c ON c.id=so.customer_id AND c.workspace_id=@w
   JOIN skus sk ON sk.id=l.sku_id AND sk.workspace_id=@w JOIN items i ON i.id=sk.item_id AND i.workspace_id=@w WHERE l.workspace_id=@w`,
  text: ['order_number','customer','order_status','order_date','product','sku','variant','created_at'],
  number: ['quantity_ordered','quantity_fulfilled','unfulfilled','unit_price_minor','line_value_minor'],
  defaults: ['order_number','customer','order_date','product','quantity_ordered','unit_price_minor'],
 },
 bills: {
  description: 'One row per supplier bill (accounts payable). Amounts are minor units (cents); balance_minor is what is still owed; status OPEN/PAID/VOID; overdue when due_date is past and balance_minor > 0.', href: '/accounting/payables',
  sql: `SELECT b.id,b.bill_number,s.name supplier,po.po_number order_number,b.supplier_invoice_number,b.issue_date,b.due_date,b.status,b.match_status,b.currency,
    b.subtotal_minor,b.tax_minor,b.total_minor,b.balance_minor,b.paid_at,b.created_at
   FROM accounting_supplier_bills b JOIN suppliers s ON s.id=b.supplier_id AND s.workspace_id=@w
   LEFT JOIN purchase_orders po ON po.id=b.purchase_order_id AND po.workspace_id=@w WHERE b.workspace_id=@w`,
  text: ['bill_number','supplier','order_number','supplier_invoice_number','issue_date','due_date','status','match_status','currency','paid_at','created_at'],
  number: ['subtotal_minor','tax_minor','total_minor','balance_minor'],
  defaults: ['bill_number','supplier','due_date','status','total_minor','balance_minor'],
 },
 invoices: {
  description: 'One row per customer invoice (accounts receivable). Amounts are minor units (cents); balance_minor is what the customer still owes; status OPEN/PAID/VOID.', href: '/accounting/receivables',
  sql: `SELECT v.id,v.invoice_number,c.name customer,so.order_number,v.issue_date,v.due_date,v.status,v.currency,
    v.subtotal_minor,v.discount_minor,v.tax_minor,v.total_minor,v.balance_minor,v.paid_at,v.created_at
   FROM accounting_customer_invoices v JOIN customers c ON c.id=v.customer_id AND c.workspace_id=@w
   LEFT JOIN sales_orders so ON so.id=v.sales_order_id AND so.workspace_id=@w WHERE v.workspace_id=@w`,
  text: ['invoice_number','customer','order_number','issue_date','due_date','status','currency','paid_at','created_at'],
  number: ['subtotal_minor','discount_minor','tax_minor','total_minor','balance_minor'],
  defaults: ['invoice_number','customer','due_date','status','total_minor','balance_minor'],
 },
 payments: {
  description: 'One row per recorded payment, in or out. direction CUSTOMER_PAYMENT (money in) or SUPPLIER_PAYMENT (money out); amount_minor in minor units (cents); status POSTED or VOID. party is the customer or supplier.', href: '/accounting',
  sql: `SELECT p.id,p.payment_number,p.direction,COALESCE(c.name,s.name) party,p.payment_date,p.amount_minor,p.currency,p.method,p.reference,p.status,p.created_at
   FROM accounting_payments p LEFT JOIN customers c ON c.id=p.customer_id AND c.workspace_id=@w
   LEFT JOIN suppliers s ON s.id=p.supplier_id AND s.workspace_id=@w WHERE p.workspace_id=@w`,
  text: ['payment_number','direction','party','payment_date','currency','method','reference','status','created_at'],
  number: ['amount_minor'],
  defaults: ['payment_number','direction','party','payment_date','amount_minor','status'],
 },
 shipments: {
  description: 'One row per outbound customer shipment: order, carrier, tracking, status, dates. delivered_at is set only when delivery was recorded.', href: '/sales/shipments',
  sql: `SELECT sh.id,sh.shipment_number,so.order_number,c.name customer,sh.status,l.name ship_from,sh.carrier,sh.service,sh.tracking_number,sh.tracking_status,
    sh.package_count,sh.shipping_cost_minor,sh.shipped_at,sh.expected_delivery_date,sh.promised_date,sh.delivered_at,sh.created_at
   FROM sales_shipments sh JOIN sales_orders so ON so.id=sh.sales_order_id AND so.workspace_id=@w
   JOIN customers c ON c.id=so.customer_id AND c.workspace_id=@w
   LEFT JOIN locations l ON l.id=sh.ship_from_location_id AND l.workspace_id=@w WHERE sh.workspace_id=@w`,
  text: ['shipment_number','order_number','customer','status','ship_from','carrier','service','tracking_number','tracking_status','shipped_at','expected_delivery_date','promised_date','delivered_at','created_at'],
  number: ['package_count','shipping_cost_minor'],
  defaults: ['shipment_number','order_number','customer','status','carrier','shipped_at','delivered_at'],
 },
 returns: {
  description: 'One row per customer return line: order, customer, product, quantities authorized, received, restocked and scrapped, the return status and reason.', href: '/sales/returns',
  sql: `SELECT rl.id,r.return_number,so.order_number,c.name customer,r.status,r.resolution,r.reason,i.name product,sk.code sku,sk.variant_label variant,
    rl.quantity_authorized,rl.quantity_received,rl.quantity_restocked,rl.quantity_scrapped,rl.condition_note,r.created_at,r.received_at,r.completed_at
   FROM customer_return_lines rl JOIN customer_returns r ON r.id=rl.customer_return_id AND r.workspace_id=@w
   JOIN sales_orders so ON so.id=r.sales_order_id AND so.workspace_id=@w JOIN customers c ON c.id=so.customer_id AND c.workspace_id=@w
   JOIN skus sk ON sk.id=rl.sku_id AND sk.workspace_id=@w JOIN items i ON i.id=sk.item_id AND i.workspace_id=@w WHERE rl.workspace_id=@w`,
  text: ['return_number','order_number','customer','status','resolution','reason','product','sku','variant','condition_note','created_at','received_at','completed_at'],
  number: ['quantity_authorized','quantity_received','quantity_restocked','quantity_scrapped'],
  defaults: ['return_number','customer','product','quantity_received','status','reason'],
 },
 reorder_settings: {
  description: 'One row per reorder rule: product (and location when the rule is per place), reorder_point, target_stock, safety_stock, lead_time_days, preferred supplier. below_reorder_point is 1 when current available stock is at or under the reorder point.', href: '/purchasing/replenishment',
  sql: `SELECT rp.id,i.name product,sk.code sku,sk.variant_label variant,l.name location,rp.reorder_point,rp.target_stock,rp.safety_stock,rp.default_order_quantity,rp.lead_time_days,
    s.name preferred_supplier,rp.source,COALESCE(st.on_hand,0) on_hand,MAX(0,COALESCE(st.on_hand,0)-COALESCE(st.committed,0)) available,
    CASE WHEN rp.reorder_point IS NOT NULL AND MAX(0,COALESCE(st.on_hand,0)-COALESCE(st.committed,0))<=rp.reorder_point THEN 1 ELSE 0 END below_reorder_point,rp.updated_at
   FROM reorder_policies rp JOIN skus sk ON sk.id=rp.sku_id AND sk.workspace_id=@w JOIN items i ON i.id=sk.item_id AND i.workspace_id=@w
   LEFT JOIN locations l ON l.id=rp.location_id AND l.workspace_id=@w LEFT JOIN suppliers s ON s.id=rp.preferred_supplier_id AND s.workspace_id=@w
   LEFT JOIN stock st ON st.sku_id=sk.id WHERE rp.workspace_id=@w`,
  text: ['product','sku','variant','location','preferred_supplier','source','updated_at'],
  number: ['reorder_point','target_stock','safety_stock','default_order_quantity','lead_time_days','on_hand','available','below_reorder_point'],
  defaults: ['product','location','reorder_point','target_stock','available','below_reorder_point'],
 },
 supplier_items: {
  description: 'One row per supplier-product link: what a supplier sells, in which pack (purchase_unit of units_per_purchase_unit), last_unit_cost per inventory unit, lead time, minimum order, preferred (1/0). "Which supplier is cheapest for X" is this dataset filtered by product, sorted by last_unit_cost.', href: '/purchasing/suppliers',
  sql: `SELECT si.id,s.name supplier,i.name product,sk.code sku,sk.variant_label variant,si.supplier_sku,si.purchase_unit,si.units_per_purchase_unit,si.last_unit_cost,si.last_cost_at,
    si.lead_time_days,si.minimum_order_quantity,si.order_multiple,si.is_preferred preferred,si.is_active active,si.updated_at
   FROM supplier_items si JOIN suppliers s ON s.id=si.supplier_id AND s.workspace_id=@w
   JOIN skus sk ON sk.id=si.sku_id AND sk.workspace_id=@w JOIN items i ON i.id=sk.item_id AND i.workspace_id=@w WHERE si.workspace_id=@w`,
  text: ['supplier','product','sku','variant','supplier_sku','purchase_unit','last_cost_at','updated_at'],
  number: ['units_per_purchase_unit','last_unit_cost','lead_time_days','minimum_order_quantity','order_multiple','preferred','active'],
  defaults: ['supplier','product','purchase_unit','units_per_purchase_unit','last_unit_cost','lead_time_days'],
 },
};

function catalogue(db, workspaceId, membership) {
 const attributes = db.prepare(`SELECT DISTINCT name FROM item_options WHERE workspace_id=@w
  UNION SELECT DISTINCT j.key name FROM catalogue_sku_facts f,json_each(f.facts) j WHERE f.workspace_id=@w
  UNION SELECT DISTINCT j.key name FROM catalogue_item_facts f,json_each(f.facts) j WHERE f.workspace_id=@w`).all({w:workspaceId}).map(r=>r.name);
 const numericAttributes = new Set(db.prepare(`SELECT name FROM (
  SELECT j.key name,j.type FROM catalogue_sku_facts f,json_each(f.facts) j WHERE f.workspace_id=@w
  UNION ALL SELECT j.key name,j.type FROM catalogue_item_facts f,json_each(f.facts) j WHERE f.workspace_id=@w
  UNION ALL SELECT o.name,'text' type FROM item_options o WHERE o.workspace_id=@w
 ) GROUP BY name HAVING SUM(type IN ('integer','real'))>0 AND SUM(type NOT IN ('integer','real','null'))=0`).all({w:workspaceId}).map(r=>`attribute:${r.name}`));
 return Object.fromEntries(Object.entries(REGISTRY).filter(([,d])=>!membership || destinations.contract(d.href,membership).allowed)
  .map(([key,d])=>{
    const extra=key==='variants'?attributes.map(a=>`attribute:${a}`):[];
    return [key,{...d,text:[...d.text,...extra.filter(a=>!numericAttributes.has(a))],number:[...d.number,...extra.filter(a=>numericAttributes.has(a))],fields:[...d.text,...d.number,...extra]}];
  }));
}
const OPERATORS = ['eq','ne','lt','lte','gt','gte','contains','is_missing','is_present'];
const AGGREGATES = ['count','sum','average','minimum','maximum','count_distinct'];
function promptCatalogue(catalog) {
 return Object.entries(catalog).map(([key,d])=>`${key}: ${d.description}\n Text/date fields: ${d.text.join(', ')}. Numeric/boolean (0/1) fields: ${d.number.join(', ')}. Additional fields: ${d.fields.filter(f=>f.startsWith('attribute:')).join(', ') || 'none'}`).join('\n');
}
function execute(db, workspaceId, plan, options={}) {
 const catalog = options.catalog || catalogue(db,workspaceId,options.membership);
 const d = catalog[plan.dataset];
 // Every refusal here used to be the same sentence, so "Find customer John
 // Smith" read as "could not be verified safely" and nobody could tell that
 // the planner had asked for a field the customers dataset does not have.
 // The reason is said where it is known.
 const fail = (reason) => {throw new ValidationError(reason || 'That lookup could not be verified safely. Please clarify which records and measure you want.');};
 if (!d || !Array.isArray(plan.filters) || plan.filters.length>12 || !Array.isArray(plan.fields) || plan.fields.length>12 || !Array.isArray(plan.groupBy) || plan.groupBy.length>3) fail();
 if (options.membership && !destinations.contract(d.href,options.membership).allowed) fail(`Your role does not include viewing ${plan.dataset.replace(/_/g,' ')}. Ask an inventory owner if you need that access.`);
 const params={w:workspaceId}; let paramIndex=0;
 function bind(value){const key=`p${paramIndex++}`;params[key]=value;return `@${key}`;}
 function field(name){
  if (!d.fields.includes(name)) fail(`I tried to read a detail called “${String(name).slice(0,60)}” and ${plan.dataset.replace(/_/g,' ')} records do not have one. What I can read about them: ${d.fields.filter(f=>!f.startsWith('attribute:')).join(', ')}. Ask again naming one of those.`);
  if (!name.startsWith('attribute:')) return `r."${name}"`;
  const key=bind(name.slice(10));
  // Exact arbitrary owner-supplied keys, parameterized rather than interpolated.
  return `COALESCE((SELECT ov.value FROM sku_option_values ov JOIN item_options o ON o.id=ov.option_id WHERE ov.sku_id=r.id AND o.workspace_id=@w AND o.name=${key}),
   (SELECT j.value FROM catalogue_sku_facts f,json_each(f.facts) j WHERE f.sku_id=r.id AND f.workspace_id=@w AND j.key=${key}),
   (SELECT j.value FROM catalogue_item_facts f,json_each(f.facts) j WHERE f.item_id=r.item_id AND f.workspace_id=@w AND j.key=${key}))`;
 }
 if (!['all','any'].includes(plan.filterMode)) fail();
 const predicates=plan.filters.map(f=>{
  const expr=field(f.field);if(!OPERATORS.includes(f.operator)) fail(`I tried to compare ${String(f.field).replace(/_/g,' ')} using “${String(f.operator).slice(0,30)}”, which is not a comparison I can make. I can check equals, not equal, less than, greater than, contains, missing and present. Ask again in those terms.`);
  if(f.operator==='is_missing')return `${expr} IS NULL`;
  if(f.operator==='is_present')return `${expr} IS NOT NULL`;
  if(typeof f.value!=='string'&&typeof f.value!=='number')fail();
  if(d.number.includes(f.field)&&typeof f.value!=='number')fail(`${String(f.field).replace(/_/g,' ')} is a number, and “${String(f.value).slice(0,40)}” is not one. Give me the figure to compare against.`);
  if(f.operator==='contains'){
   if(d.number.includes(f.field))fail();return `${expr} LIKE ${bind(`%${escapeLike(f.value)}%`)} ESCAPE '\\' COLLATE NOCASE`;
  }
  const op={eq:'=',ne:'<>',lt:'<',lte:'<=',gt:'>',gte:'>='}[f.operator];
  return `${expr} ${op} ${bind(f.value)}${typeof f.value==='string'?' COLLATE NOCASE':''}`;
 });
 const where=predicates.length?predicates.join(plan.filterMode==='any'?' OR ':' AND '):'1=1';
 const source=`${CTE}, records AS (${d.sql})`;
 const total=db.prepare(`${source} SELECT COUNT(*) n FROM records r WHERE ${where}`).get(params).n;
 /*
  * "Supplier = Acme" finding nothing when the supplier is Acme Trade Supply,
  * or "product containing sweaters" when the product is Children's Sweater,
  * is the reader's exactness, not the person's. Before saying "no match",
  * the same lookup is tried once with those filters loosened — equality
  * becomes contains, a plural becomes its singular — and if that finds the
  * records, the answer says how they were matched.
  */
 if(!total&&!options._relaxed){
  const relaxed=plan.filters.map(f=>{
   if(!d.text.includes(f.field)||typeof f.value!=='string')return f;
   if(f.operator==='eq')return {...f,operator:'contains'};
   if(f.operator==='contains'&&/(?:es|s)$/i.test(f.value)&&f.value.length>3)return {...f,value:f.value.replace(/(?:es|s)$/i,'')};
   return f;
  });
  if(JSON.stringify(relaxed)!==JSON.stringify(plan.filters)){
   const again=execute(db,workspaceId,{...plan,filters:relaxed},{...options,_relaxed:true});
   if(again.totalMatches>0){
    // Only the filters that had to be loosened are mentioned: a name that
    // matched exactly all along is not an approximation.
    const exact=(f)=>(again.rows||[]).some(r=>String(r[f.field]??'').toLowerCase()===String(f.value).toLowerCase());
    const how=relaxed.map((f,i)=>[f,plan.filters[i]]).filter(([f,o])=>f!==o&&!exact(o)).map(([f,o])=>`“${o.value}” as part of the ${f.field.replace(/_/g,' ')}`).join(' and ');
    return {...again,answer:how?`${again.answer} (Matched ${how}.)`:again.answer};
   }
  }
 }
 // A bill, a line, a payment or a shipment is one of many for the same
 // party; a named customer with three orders is not an ambiguity to resolve.
 const transactional=['purchase_order_lines','sales_order_lines','bills','invoices','payments','shipments','returns','movements'].includes(plan.dataset);
 if (plan.entityScope === 'single' && !transactional) {
  const identity = ['variants','positions'].includes(plan.dataset) ? 'item_id' : 'id';
  const candidates=db.prepare(`${source} SELECT DISTINCT r.${identity} FROM records r WHERE ${where} LIMIT 2`).all(params);
  if(candidates.length>1){
   const label=d.defaults[0];
   const choices=db.prepare(`${source} SELECT DISTINCT r."${label}" label FROM records r WHERE ${where} LIMIT 8`).all(params).map(r=>r.label);
   return {plan:{intent:'record_query'},answer:`Which ${plan.dataset==='variants'||plan.dataset==='positions'?'product':plan.dataset.replace(/_/g,' ')} do you mean? I found ${choices.join(', ')}. Please give the full name or SKU.`,needsClarification:true,supported:false,rows:[],columns:[],rowCount:0,isAction:false,answerMode:'verified'};
  }
 }
 const aggregate=plan.aggregate;
 if(aggregate!==''&&!AGGREGATES.includes(aggregate))fail();
 if(plan.metrics!==undefined&&(!Array.isArray(plan.metrics)||plan.metrics.length>6))fail();
 if(aggregate&&plan.metrics?.length)fail();
 const metrics=plan.metrics?.length?plan.metrics:aggregate?[{operation:aggregate,field:plan.measure}]:[];
 const legacy=Boolean(aggregate);
 let columns,select,group='',answer;
 const metricInfo=[];
 if(metrics.length){
  const expressions=plan.groupBy.map(field);
  columns=[...plan.groupBy];
  for(const metric of metrics){
   if(!AGGREGATES.includes(metric.operation))fail();
   const key=legacy?'value':metric.operation==='count'?'count':`${metric.operation}:${metric.field}`;
   if(columns.includes(key))fail();
   let expression,knownExpression;
   if(metric.operation==='count')expression='COUNT(*)';
   else{
    const expr=field(metric.field);
    if(metric.operation!=='count_distinct'&&!d.number.includes(metric.field))fail();
    expression=metric.operation==='count_distinct'?`COUNT(DISTINCT ${expr})`:`${{sum:'SUM',average:'AVG',minimum:'MIN',maximum:'MAX'}[metric.operation]}(${expr})`;
    knownExpression=`COUNT(${expr})`;
   }
   columns.push(key);expressions.push(expression);
   metricInfo.push({...metric,key,knownExpression});
  }
  // Every grouped measure also carries its underlying record count. It must
  // not be confused with a sum, an inventory quantity or a distinct count.
  if(plan.groupBy.length){columns.push('matching_records');expressions.push('COUNT(*)');group=` GROUP BY ${plan.groupBy.map(field).join(',')}`;}
  select=expressions.map((expr,i)=>`${expr} AS "c${i}"`).join(',');
  select+=metricInfo.map((m,i)=>m.knownExpression?`,${m.knownExpression} AS "known${i}"`:'').join('');
 }else{
  if(plan.groupBy.length)fail();
  columns=plan.fields.length?plan.fields:d.defaults;
  select=columns.map((f,i)=>`${field(f)} AS "c${i}"`).join(',');
 }
 const limit=Number.isInteger(plan.limit)&&plan.limit>=1&&plan.limit<=50?plan.limit:25;
 let order='';
 if(plan.sortField){
  const index=columns.indexOf(plan.sortField);if(index<0)fail();
  if(!['asc','desc'].includes(plan.sortDirection))fail();
  order=` ORDER BY "c${index}" ${plan.sortDirection.toUpperCase()}`;
 }
 const sql=`${source} SELECT ${select} FROM records r WHERE ${where}${group}${order}`;
 const groupCount=group?db.prepare(`SELECT COUNT(*) n FROM (${sql})`).get(params).n:null;
 const raw=db.prepare(`${sql} LIMIT ${limit}`).all(params);
 // Money is money on the page: balance_minor 11250 is $112.50.
 const money=(n,c)=>{try{return new Intl.NumberFormat('en-US',{style:'currency',currency:c||'USD'}).format(Number(n)/100);}catch{return `${(Number(n)/100).toFixed(2)} ${c}`;}};
 const plainRows=raw.map(r=>Object.fromEntries(columns.map((c,i)=>[c,r[`c${i}`]])));
 const rows=metrics.length?plainRows:plainRows.map(r=>Object.fromEntries(Object.entries(r).map(([c,v])=>/_minor$/.test(c)?[c.replace(/_minor$/,''),typeof v==='number'?money(v,r.currency):v]:[c,v])));
 if(!metrics.length)columns=columns.map(c=>c.replace(/_minor$/,''));
 const noun=plan.dataset.replace(/_/g,' ');
 // "No bills with issue date ≥ 2026-09-01" is a date, not a misspelling.
 const textSearch=plan.filters.some(f=>d.text.includes(f.field)&&['eq','contains'].includes(f.operator)&&typeof f.value==='string'&&!/^\d{4}-\d{2}-\d{2}/.test(f.value));
 const display=value=>value===null||value===undefined?'not recorded':typeof value==='number'?value.toLocaleString('en-US'):String(value);
 const metricText=(row,index)=>metricInfo.map((m,i)=>{
  const label=m.operation==='count'?noun:`${{sum:'Total',average:'Average',minimum:'Minimum',maximum:'Maximum',count_distinct:'Distinct count'}[m.operation]} ${m.field.replace(/_minor$/,'').replace(/_/g,' ').replace(/^attribute:/,'')}`;
  const inMoney=/_minor$/.test(String(m.field))&&['sum','average','minimum','maximum'].includes(m.operation)&&typeof row[m.key]==='number';
  const base=`${label}: ${inMoney?money(row[m.key],row.currency):display(row[m.key])}`;
  const n=raw[index][`known${i}`],matched=group?row.matching_records:total;
  return n!==undefined&&n<matched?`${base} (${matched-n} records have no recorded value; incomplete measure)`:base;
 }).join(' · ');
 // A total over nothing is not "not recorded": it is that nothing matched.
 const filterText=plan.filters.length?`with ${plan.filters.map(f=>`${f.field.replace(/_/g,' ').replace(/^attribute:/,'')} ${{eq:'=',ne:'≠',lt:'<',lte:'≤',gt:'>',gte:'≥',contains:'containing',is_missing:'missing',is_present:'present'}[f.operator]||f.operator}${f.value===null||f.value===undefined?'':` “${f.value}”`}`).join(plan.filterMode==='any'?' or ':' and ')}`:'at all';
 if(metrics.length&&!group&&!total&&!(legacy&&aggregate==='count'))answer=`No ${noun} on record ${filterText}, so there is nothing to total. That is a search result, not a failure.`;
 else if(metrics.length&&!group)answer=legacy&&aggregate==='count'
  ? `${display(rows[0].value)} ${noun} match your question.`
  : `${metricText(rows[0],0)}. Based on ${total.toLocaleString('en-US')} matching ${noun}.`;
 else if(group)answer=`By ${plan.groupBy.map(f=>f.replace(/_/g,' ')).join(' / ')}:\n${rows.map((r,i)=>`${plan.groupBy.map(f=>r[f]??'Not recorded').join(' / ')} — ${metricText(r,i)} (${r.matching_records} matching ${noun})`).join('\n')}${groupCount>limit?`\nShowing the first ${limit} of ${groupCount} groups.`:''}`;
 // No match is said as a no-match, with what was looked for: "0 matching
 // customers" tells nobody whether John Smith is absent or misspelt.
 else if(!total)answer=`No ${noun} on record ${plan.filters.length?`with ${plan.filters.map(f=>`${f.field.replace(/_/g,' ').replace(/^attribute:/,'')} ${{eq:'=',ne:'≠',lt:'<',lte:'≤',gt:'>',gte:'≥',contains:'containing',is_missing:'missing',is_present:'present'}[f.operator]||f.operator}${f.value===null||f.value===undefined?'':` “${f.value}”`}`).join(plan.filterMode==='any'?' or ':' and ')}`:'at all'}. That is a search result, not a failure${textSearch?' — check the spelling, or try part of the name':''}.`;
 else answer=`${total} matching ${noun}.${total?` ${rows.map(r=>`${r[columns[0]]??'Not recorded'}${columns.length>1?` (${columns.slice(1).map(c=>`${c.replace(/_/g,' ')}: ${r[c]??'not recorded'}`).join(', ')})`:''}`).join('; ')}.`:''}${total>limit?` Showing the first ${limit}; the total includes all matches.`:''}`;
 return {plan:{intent:'record_query',...plan},answer,rows,columns,rowCount:rows.length,totalMatches:total,supported:true,isAction:false,answerMode:'verified',handoff:null};
}
module.exports={REGISTRY,OPERATORS,AGGREGATES,catalogue,promptCatalogue,execute};

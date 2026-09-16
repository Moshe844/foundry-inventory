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
  href: '/movements',
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
  description: 'Recorded customers; record_state distinguishes ACTIVE, PROVISIONAL and ARCHIVED.', href: '/customers',
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
 const fail = () => {throw new ValidationError('That lookup could not be verified safely. Please clarify which records and measure you want.');};
 if (!d || !Array.isArray(plan.filters) || plan.filters.length>12 || !Array.isArray(plan.fields) || plan.fields.length>12 || !Array.isArray(plan.groupBy) || plan.groupBy.length>3) fail();
 if (options.membership && !destinations.contract(d.href,options.membership).allowed) fail();
 const params={w:workspaceId}; let paramIndex=0;
 function bind(value){const key=`p${paramIndex++}`;params[key]=value;return `@${key}`;}
 function field(name){
  if (!d.fields.includes(name)) fail();
  if (!name.startsWith('attribute:')) return `r."${name}"`;
  const key=bind(name.slice(10));
  // Exact arbitrary owner-supplied keys, parameterized rather than interpolated.
  return `COALESCE((SELECT ov.value FROM sku_option_values ov JOIN item_options o ON o.id=ov.option_id WHERE ov.sku_id=r.id AND o.workspace_id=@w AND o.name=${key}),
   (SELECT j.value FROM catalogue_sku_facts f,json_each(f.facts) j WHERE f.sku_id=r.id AND f.workspace_id=@w AND j.key=${key}),
   (SELECT j.value FROM catalogue_item_facts f,json_each(f.facts) j WHERE f.item_id=r.item_id AND f.workspace_id=@w AND j.key=${key}))`;
 }
 if (!['all','any'].includes(plan.filterMode)) fail();
 const predicates=plan.filters.map(f=>{
  const expr=field(f.field);if(!OPERATORS.includes(f.operator)) fail();
  if(f.operator==='is_missing')return `${expr} IS NULL`;
  if(f.operator==='is_present')return `${expr} IS NOT NULL`;
  if(typeof f.value!=='string'&&typeof f.value!=='number')fail();
  if(d.number.includes(f.field)&&typeof f.value!=='number')fail();
  if(f.operator==='contains'){
   if(d.number.includes(f.field))fail();return `${expr} LIKE ${bind(`%${escapeLike(f.value)}%`)} ESCAPE '\\' COLLATE NOCASE`;
  }
  const op={eq:'=',ne:'<>',lt:'<',lte:'<=',gt:'>',gte:'>='}[f.operator];
  return `${expr} ${op} ${bind(f.value)}${typeof f.value==='string'?' COLLATE NOCASE':''}`;
 });
 const where=predicates.length?predicates.join(plan.filterMode==='any'?' OR ':' AND '):'1=1';
 const source=`${CTE}, records AS (${d.sql})`;
 const total=db.prepare(`${source} SELECT COUNT(*) n FROM records r WHERE ${where}`).get(params).n;
 if (plan.entityScope === 'single') {
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
 const rows=raw.map(r=>Object.fromEntries(columns.map((c,i)=>[c,r[`c${i}`]])));
 const noun=plan.dataset.replace(/_/g,' ');
 const display=value=>value===null||value===undefined?'not recorded':typeof value==='number'?value.toLocaleString('en-US'):String(value);
 const metricText=(row,index)=>metricInfo.map((m,i)=>{
  const label=m.operation==='count'?noun:`${{sum:'Total',average:'Average',minimum:'Minimum',maximum:'Maximum',count_distinct:'Distinct count'}[m.operation]} ${m.field.replace(/_/g,' ').replace(/^attribute:/,'')}`;
  const base=`${label}: ${display(row[m.key])}`;
  const n=raw[index][`known${i}`],matched=group?row.matching_records:total;
  return n!==undefined&&n<matched?`${base} (${matched-n} records have no recorded value; incomplete measure)`:base;
 }).join(' · ');
 if(metrics.length&&!group)answer=legacy&&aggregate==='count'
  ? `${display(rows[0].value)} ${noun} match your question.`
  : `${metricText(rows[0],0)}. Based on ${total.toLocaleString('en-US')} matching ${noun}.`;
 else if(group)answer=`By ${plan.groupBy.map(f=>f.replace(/_/g,' ')).join(' / ')}:\n${rows.map((r,i)=>`${plan.groupBy.map(f=>r[f]??'Not recorded').join(' / ')} — ${metricText(r,i)} (${r.matching_records} matching ${noun})`).join('\n')}${groupCount>limit?`\nShowing the first ${limit} of ${groupCount} groups.`:''}`;
 else answer=`${total} matching ${noun}.${total?` ${rows.map(r=>`${r[columns[0]]??'Not recorded'}${columns.length>1?` (${columns.slice(1).map(c=>`${c.replace(/_/g,' ')}: ${r[c]??'not recorded'}`).join(', ')})`:''}`).join('; ')}.`:''}${total>limit?` Showing the first ${limit}; the total includes all matches.`:''}`;
 return {plan:{intent:'record_query',...plan},answer,rows,columns,rowCount:rows.length,totalMatches:total,supported:true,isAction:false,answerMode:'verified',handoff:null};
}
module.exports={REGISTRY,OPERATORS,AGGREGATES,catalogue,promptCatalogue,execute};

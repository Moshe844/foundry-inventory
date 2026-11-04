'use strict';

// Templates are report definitions over the same governed catalogue used by
// manual and Ask reports. No sample customer, currency or amount is embedded.
const templates=Object.freeze([
  {key:'sales-by-item',name:'Sales by item',description:'Posted sales by product and currency.',definition:{dataset:'posted_sales_activity',groups:['product','currency'],aggregate:'sum',measure:'revenue_minor',sort:'total',chart:'bar'}},
  {key:'profit-by-customer',name:'Profit by customer',description:'Posted gross profit by customer and currency.',definition:{dataset:'posted_sales_activity',groups:['customer','currency'],aggregate:'sum',measure:'gross_profit_minor',sort:'total',chart:'bar'}},
  {key:'stock-by-location',name:'Stock value by location',description:'Recorded cost value at each location.',definition:{dataset:'inventory_valuation',groups:['location','currency'],aggregate:'sum',measure:'book_cost_minor',sort:'total',chart:'bar'}},
  {key:'supplier-spend',name:'Supplier spend',description:'Posted supplier bills by supplier and currency.',definition:{dataset:'supplier_bills',groups:['supplier','currency'],aggregate:'sum',measure:'total_minor',sort:'total',chart:'bar',filters:[{field:'is_posted',operator:'equals',value:'yes'}]}},
  {key:'slow-movers',name:'Slow movers',description:'Stock positions by time since their last recorded sale.',definition:{dataset:'stock_recency',columns:['product','sku','location','on_hand','days_since_sale','last_sold_on'],sort:'days_since_sale',direction:'desc',chart:'table'}},
  {key:'returns-by-reason',name:'Returns by reason',description:'Customer returns grouped by their saved reason.',definition:{dataset:'customer_returns',groups:['reason'],aggregate:'count',sort:'count',chart:'bar'}},
  {key:'inventory-aging',name:'Inventory aging',description:'Time since the latest recorded receipt, with current cost value.',definition:{dataset:'inventory_receipt_age',columns:['product','sku','location','costed_units','book_cost_minor','currency','days_since_last_receipt'],sort:'days_since_last_receipt',direction:'desc',chart:'table'}},
  {key:'purchase-history',name:'Purchase history',description:'Ordered units by supplier and order date.',definition:{dataset:'purchase_order_lines',groups:['supplier','order_date'],aggregate:'sum',measure:'ordered_units',sort:'order_date',direction:'desc',chart:'table'}},
]);

const sourceNames=Object.freeze({catalogue:'Items',stock:'Stock levels and locations',inventory_valuation:'Stock value',stock_recency:'Sales recency',inventory_receipt_age:'Receipt recency',sales_orders:'Sales orders',sales_order_lines:'Sales order lines',posted_sales_activity:'Posted sales and product cost',customers:'Customers',customer_invoices:'Invoices',payments:'Payments',purchase_orders:'Purchase orders',purchase_order_lines:'Purchase order lines',suppliers:'Suppliers',movements:'Stock receipts and adjustments',customer_returns:'Customer returns',supplier_returns:'Supplier returns',shipments:'Shipments',profit_activity:'Sales, cost and expenses',expenses:'Operating expenses',tax_activity:'Sales tax',inventory_cost_movements:'Stock cost changes',supplier_bills:'Supplier bills',payment_requests:'Payment requests',mail:'Business messages',shipment_rates:'Carrier rates',shipping_label_activity:'Shipping labels',shipment_tracking:'Tracking events',transfers:'Stock transfers',low_stock:'Low stock',replenishment_rules:'Reorder settings',journal_lines:'General ledger lines',imports:'Import history',attention:'Items needing attention',warehouse_waves:'Picking and packing',provider_effects:'Connected system operations',connection_events:'Connection events',connections:'Connected systems'});
// How the source chooser is arranged. A source not named here still appears, under Other.
const sourceAreas=Object.freeze([['Sales',['posted_sales_activity','sales_orders','sales_order_lines','customers','customer_returns','payment_requests']],['Stock',['stock','inventory_valuation','catalogue','low_stock','stock_recency','inventory_receipt_age','movements','inventory_cost_movements','transfers','replenishment_rules']],['Buying',['purchase_orders','purchase_order_lines','suppliers','supplier_bills','supplier_returns']],['Money',['profit_activity','expenses','customer_invoices','payments','tax_activity','journal_lines']],['Shipping',['shipments','shipment_tracking','shipping_label_activity','shipment_rates','warehouse_waves']]]);
function groupedSources(datasets){const placed=new Set(sourceAreas.flatMap(([,keys])=>keys)),byKey=new Map(datasets.map(entry=>[entry.key,entry]));const areas=sourceAreas.map(([area,keys])=>({area,sources:keys.map(key=>byKey.get(key)).filter(Boolean)}));areas.push({area:'Other',sources:datasets.filter(entry=>!placed.has(entry.key))});return areas.filter(row=>row.sources.length);}
const friendlyField=field=>({sku:'SKU',cogs_minor:'Cost of goods sold',gross_profit_minor:'Gross profit',revenue_minor:'Sales',book_cost_minor:'Stock value',ordered_units:'Units ordered',on_hand:'On hand',days_since_sale:'Days since sale',last_sold_on:'Last sale',days_since_last_receipt:'Days since latest receipt',last_received_on:'Latest receipt',posting_date:'Date',is_posted:'Posted'}[field]||field.replace(/_minor$/,'').replaceAll('_',' ').replace(/^./,c=>c.toUpperCase()));
const fieldArea=(field)=>/^(product|sku|variant|barcode|category|unit|tracking)$/.test(field)?'Items':
  /^(customer|company|email|city)$/.test(field)?'Customers':
  /^(supplier)$/.test(field)?'Suppliers':
  /^(location|on_hand|costed_units|book_cost_minor|days_since_sale|days_since_last_receipt)$/.test(field)?'Stock':
  /_date$|_on$|^as_of$/.test(field)?'Dates':
  /minor$|profit|cost|revenue|tax/.test(field)?'Money':'Records';
function fieldsFor(dataset){const groups=new Map();for(const [key,type] of Object.entries(dataset.fields)){const area=fieldArea(key);if(!groups.has(area))groups.set(area,[]);groups.get(area).push({key,label:friendlyField(key),type});}return [...groups].map(([area,fields])=>({area,fields}));}
// What the builder page needs to offer only choices this source can answer.
function schema(dataset,{currency=null,periods={}}={}){return {fields:Object.fromEntries(Object.entries(dataset.fields).map(([key,type])=>[key,{label:friendlyField(key),type}])),metrics:Object.fromEntries(Object.entries(dataset.metrics||{}).map(([key,metric])=>[key,{label:metric.label,currencySensitive:Boolean(metric.currencySensitive)}])),filterValues:dataset.filterValues||{},moneyCompleteness:dataset.moneyCompleteness||{},currency,periods};}
function template(key){return templates.find(row=>row.key===key)||null;}
// Exact standard requests use a governed definition without a model round trip.
// Additional filters, dates or follow-up instructions stay with the full planner.
function standardDefinition(message,currency){
 const match=String(message||'').trim().match(/^(?:show\s+)?sales,?\s+cost(?:s)?\s+(?:and|&)\s+(?:gross\s+)?profit\s+by\s+(?:product|item|sku)(?:\s+in\s+([A-Z]{3}))?[.!?]?$/i);
 if(!match)return null;
 const money=(match[1]||currency).toUpperCase();
 return {dataset:'composed',title:'Sales, cost and profit by product',dimension:'sku',metrics:[['sales','revenue_minor'],['cost','cogs_minor'],['profit','gross_profit_minor']].map(([alias,measure])=>({alias,dataset:'posted_sales_activity',aggregate:'sum',measure,filters:[{field:'currency',operator:'equals',value:money}]})),columns:[],groups:[],aggregate:'sum',measure:'',filters:[],chart:'table',sort:'profit',direction:'desc'};
}
module.exports={templates,sourceNames,groupedSources,friendlyField,fieldsFor,schema,template,standardDefinition};

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

const sourceNames=Object.freeze({catalogue:'Items',stock:'Stock levels and locations',inventory_valuation:'Stock value',stock_recency:'Sales recency',inventory_receipt_age:'Receipt recency',sales_orders:'Sales orders',sales_order_lines:'Sales order lines',posted_sales_activity:'Posted sales and product cost',customers:'Customers',customer_invoices:'Invoices',payments:'Payments',purchase_orders:'Purchase orders',purchase_order_lines:'Purchase order lines',suppliers:'Suppliers',movements:'Stock receipts and adjustments',customer_returns:'Customer returns',supplier_returns:'Supplier returns',shipments:'Shipments',profit_activity:'Sales, cost and expenses',expenses:'Operating expenses'});
const friendlyField=field=>({sku:'SKU',cogs_minor:'Cost of goods sold',gross_profit_minor:'Gross profit',revenue_minor:'Sales',book_cost_minor:'Stock value',ordered_units:'Units ordered',on_hand:'On hand',days_since_sale:'Days since sale',last_sold_on:'Last sale',days_since_last_receipt:'Days since latest receipt',last_received_on:'Latest receipt',posting_date:'Posting date',is_posted:'Posted'}[field]||field.replace(/_minor$/,'').replaceAll('_',' ').replace(/^./,c=>c.toUpperCase()));
const fieldArea=(field)=>/^(product|sku|variant|barcode|category|unit|tracking)$/.test(field)?'Items':
  /^(customer|company|email|city)$/.test(field)?'Customers':
  /^(supplier)$/.test(field)?'Suppliers':
  /^(location|on_hand|costed_units|book_cost_minor|days_since_sale|days_since_last_receipt)$/.test(field)?'Stock':
  /_date$|_on$|^as_of$/.test(field)?'Dates':
  /minor$|profit|cost|revenue|tax/.test(field)?'Money':'Records';
function fieldsFor(dataset){const groups=new Map();for(const [key,type] of Object.entries(dataset.fields)){const area=fieldArea(key);if(!groups.has(area))groups.set(area,[]);groups.get(area).push({key,label:friendlyField(key),type});}return [...groups].map(([area,fields])=>({area,fields}));}
function template(key){return templates.find(row=>row.key===key)||null;}
module.exports={templates,sourceNames,friendlyField,fieldsFor,template};

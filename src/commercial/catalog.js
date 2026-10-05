'use strict';

const { ValidationError } = require('../domain/errors');

const CAPABILITIES = Object.freeze([
  ['identity.core','Identity and account security','foundation','SELLABLE',false],
  ['workspace.core','Workspaces and team access','foundation','SELLABLE',false],
  ['inventory.core','Products, SKUs and inventory ledger','inventory','SELLABLE',false],
  ['inventory.multi_location','Multi-location inventory','inventory','SELLABLE',false],
  ['inventory.lot_serial','Lot and serial tracking','inventory','SELLABLE',false],
  ['inventory.counts','Physical counts and reconciliation','inventory','SELLABLE',false],
  ['inventory.transfers','Inventory transfers','inventory','SELLABLE',false],
  ['inventory.kits','Kits and bills of material','inventory','DISABLED',false],
  ['purchasing.core','Purchasing and purchase orders','purchasing','SELLABLE',false],
  ['purchasing.suppliers','Suppliers and supplier SKUs','purchasing','SELLABLE',false],
  ['purchasing.invoices','Supplier invoices and payables','purchasing','SELLABLE',true],
  ['receiving.core','Purchase receiving','purchasing','SELLABLE',false],
  ['sales_orders.core','Sales orders and commitments','sales','SELLABLE',false],
  ['fulfillment.core','Fulfillment and reservations','sales','SELLABLE',false],
  ['returns.core','Customer and supplier returns','sales','SELLABLE',false],
  ['shipping.workflow','Manual shipping workflow','shipping','SELLABLE',false],
  ['shipping.rates','Carrier rates','shipping','CONDITIONAL',true],
  ['shipping.labels','Carrier labels','shipping','CONDITIONAL',true],
  ['shipping.tracking','Shipment tracking','shipping','CONDITIONAL',true],
  ['shipping.automation','Automated shipping within authority','shipping','CONDITIONAL',true],
  ['payments.customer','Merchant customer payments','payments','CONDITIONAL',true],
  ['accounting.core','Operational accounting ledger','accounting','SELLABLE',false],
  ['accounting.reports','Accounting reports','accounting','SELLABLE',false],
  ['accounting.sync','QuickBooks and Xero synchronization','accounting','CONDITIONAL',true],
  ['accounting.explanations','Evidence-backed accounting explanations','accounting','SELLABLE',true],
  ['ask.lookup','Ask StockChief business questions','intelligence','SELLABLE',true],
  ['ask.prepare_actions','Ask StockChief prepared actions','intelligence','SELLABLE',true],
  ['communications.email_ingestion','Business mailbox monitoring','communications','CONDITIONAL',true],
  ['communications.ai_drafts','AI communication drafts','communications','SELLABLE',true],
  ['communications.send_approved','Approved email sending','communications','CONDITIONAL',true],
  ['communications.auto_send','Automatic sending within authority','communications','CONDITIONAL',true],
  ['connections.commerce','Commerce connections','connections','CONDITIONAL',true],
  ['connections.accounting','Accounting connections','connections','CONDITIONAL',true],
  ['connections.custom_api','Custom API and event feeds','connections','SELLABLE',true],
  ['imports.spreadsheet','Spreadsheet import with preview','migration','SELLABLE',false],
  ['documents.extraction','Document and page extraction','migration','DISABLED',true],
  ['migration.assisted','Assisted system migration','migration','CONDITIONAL',true],
  ['planning.basic','Demand and stockout planning','planning','SELLABLE',true],
  ['planning.transfer_before_buy','Transfer-before-buy optimization','planning','SELLABLE',true],
  ['automation.transfers','Automatic transfers within authority','automation','SELLABLE',true],
  ['automation.purchasing','Automatic purchasing within authority','automation','SELLABLE',true],
  ['authority.advanced','Advanced authority policies','automation','SELLABLE',true],
  ['adaptive_optimization','Adaptive optimization','planning','DISABLED',true],
  ['operations.alerts','Operational alerts and Needs You','operations','SELLABLE',true],
  ['support.priority','Priority support','support','SELLABLE',true],
  ['integrations.custom','Custom integrations','connections','CONDITIONAL',true],
  ['api.public','Public API','connections','SELLABLE',true],
  ['sales_orders','Sales orders compatibility key','compatibility','SELLABLE',false],
  ['purchasing','Purchasing compatibility key','compatibility','SELLABLE',false],
  ['suppliers','Suppliers compatibility key','compatibility','SELLABLE',false],
  ['receiving.manual','Receiving compatibility key','compatibility','SELLABLE',false],
  ['replenishment.basic','Replenishment compatibility key','compatibility','SELLABLE',true],
  ['accounting.basic','Accounting compatibility key','compatibility','SELLABLE',false],
  ['ask_stockchief','Ask compatibility key','compatibility','SELLABLE',true],
  ['merchant_payments','Merchant payments compatibility key','compatibility','CONDITIONAL',true],
  ['needs_you','Needs You compatibility key','compatibility','SELLABLE',false],
  ['connection.email','Email connection compatibility key','compatibility','CONDITIONAL',true],
  ['connection.commerce','Commerce connection compatibility key','compatibility','CONDITIONAL',true],
  ['connection.accounting','Accounting connection compatibility key','compatibility','CONDITIONAL',true],
  ['email.auto_extract','Email extraction compatibility key','compatibility','CONDITIONAL',true],
  ['email.response_generation','AI reply compatibility key','compatibility','SELLABLE',true],
  ['documents.process','Document processing compatibility key','compatibility','DISABLED',true],
  ['forecasting.basic','Forecasting compatibility key','compatibility','SELLABLE',true],
]);

const METERS = Object.freeze([
  ['workspaces','Inventories','STRUCTURAL',true,true],
  ['members','People','STRUCTURAL',true,true],
  ['locations','Locations','STRUCTURAL',true,true],
  ['connections','Connections','STRUCTURAL',true,true],
  ['business_communications','Business communications processed','USAGE',true,false],
  ['document_pages','Document pages processed','USAGE',true,false],
  ['intelligent_operations','StockChief intelligent operations','USAGE',true,false],
  ['external_events','External orders and operating events','USAGE',true,false],
  ['shipments_managed','Shipments managed','USAGE',true,false],
  ['automatic_actions','Automatic actions completed','USAGE',true,false],
  ['accounting_syncs','Accounting synchronization runs','USAGE',true,false],
  ['api_events','API events processed','USAGE',true,false],
  ['processing_units','Legacy business processing units','USAGE',false,false],
]);

const capabilityMap = new Map(CAPABILITIES.map((row) => [row[0], {
  key:row[0],label:row[1],category:row[2],readiness:row[3],variableCost:row[4],
}]));
const meterMap = new Map(METERS.map((row) => [row[0], {
  key:row[0],label:row[1],kind:row[2],customerVisible:row[3],critical:row[4],
}]));

function capability(key) { return capabilityMap.get(String(key || '').trim()) || null; }
function meter(key) { return meterMap.get(String(key || '').trim()) || null; }
function assertCapabilityKey(key) {
  const found=capability(key);
  if(!found)throw new ValidationError('Choose a registered StockChief capability.');
  return found;
}
function assertMeterKey(key) {
  const found=meter(key);
  if(!found)throw new ValidationError(`Choose a registered StockChief usage meter${key?`: ${key}`:''}.`);
  return found;
}

module.exports={CAPABILITIES,METERS,capability,meter,assertCapabilityKey,assertMeterKey};

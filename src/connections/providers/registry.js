'use strict';

const shopify = require('./shopify');
const square = require('./square');
const clover = require('./clover');
const woocommerce = require('./woocommerce');
const bigcommerce = require('./bigcommerce');
const gmail = require('./gmail');
const microsoft365 = require('./microsoft365');
const quickbooks = require('./quickbooks');
const xero = require('./xero');
const supplierEmail = require('./supplier-email');
const launchPolicy = require('../launch-policy');

const adapters = Object.freeze({ shopify, square, clover, woocommerce, bigcommerce, gmail, microsoft365,
  quickbooks, xero, supplier_email:supplierEmail });

const generic = Object.freeze({
  type: 'reference_webhook', name: 'Your own software', mark: 'API', category: 'business', authMode: 'token',
  description: 'A till, ERP or in-house system your developer can point at StockChief. You get an API key and a documented address to send events to.',
  provides: ['sales', 'customer orders', 'fulfillment', 'returns', 'receipts and transfers'],
  available: true,
});

const future = Object.freeze([
  { type: 'erp_future', name: 'An ERP not listed here', mark: 'ERP', category: 'business', available: true,
    integrationMode: 'custom_contract',
    description: 'Name the system and StockChief sets up a connection for it using the same events as everything else. A ready-made connector is added once that system has been certified.',
    provides: ['sales, orders, fulfillment, returns, receipts, transfers, adjustments, products and locations'] },
]);

function get(type) { return adapters[type] || null; }
function withInventoryCapabilities(meta,adapter){
 const capabilities=typeof adapter?.discover==='function'&&Array.isArray(adapter.catalogueCapabilities)
  ?[...adapter.catalogueCapabilities]:[];
 return {...meta,inventoryCapabilities:capabilities,initialInventoryImport:capabilities.some(c=>['products','skus','stock'].includes(c))};
}
function catalog(ctx,authorizationOptions) { return [shopify.metadata(), square.metadata(authorizationOptions), clover.metadata(), woocommerce.metadata(), bigcommerce.metadata(), generic,
  ...future, gmail.metadata(), microsoft365.metadata(), quickbooks.metadata(), xero.metadata()]
  .map(meta=>launchPolicy.metadata(withInventoryCapabilities(meta,get(meta.type)),ctx)); }
function inventorySources(ctx,options){return catalog(ctx,options).filter(meta=>meta.initialInventoryImport);}

module.exports = { get, catalog, generic,inventorySources,withInventoryCapabilities };

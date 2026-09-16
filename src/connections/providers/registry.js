'use strict';

const shopify = require('./shopify');
const square = require('./square');
const clover = require('./clover');
const woocommerce = require('./woocommerce');
const gmail = require('./gmail');
const microsoft365 = require('./microsoft365');
const quickbooks = require('./quickbooks');
const xero = require('./xero');
const supplierEmail = require('./supplier-email');

const adapters = Object.freeze({ shopify, square, clover, woocommerce, gmail, microsoft365,
  quickbooks, xero, supplier_email:supplierEmail });

const generic = Object.freeze({
  type: 'reference_webhook', name: 'Custom business system', mark: 'API', category: 'business', authMode: 'token',
  description: 'Connect a custom POS, ERP, or internal system with a StockChief API key and documented event endpoint.',
  provides: ['sales', 'customer orders', 'fulfillment', 'returns', 'receipts and transfers'],
  available: true,
});

const future = Object.freeze([
  { type: 'erp_future', name: 'Any ERP or business system', mark: 'ERP', category: 'business', available: true,
    integrationMode: 'custom_contract',
    description: 'Connect a bespoke ERP now through StockChief’s verified event contract; packaged adapters are added only after their provider-specific certification passes.',
    provides: ['sales, orders, fulfillment, returns, receipts, transfers, adjustments, products and locations'] },
]);

function get(type) { return adapters[type] || null; }
function catalog() { return [shopify.metadata(), square.metadata(), clover.metadata(), woocommerce.metadata(), generic,
  ...future, gmail.metadata(), microsoft365.metadata(), quickbooks.metadata(), xero.metadata()]; }

module.exports = { get, catalog, generic };

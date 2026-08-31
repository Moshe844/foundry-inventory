'use strict';

const shopify = require('./shopify');
const square = require('./square');
const clover = require('./clover');
const woocommerce = require('./woocommerce');
const gmail = require('./gmail');
const microsoft365 = require('./microsoft365');

const adapters = Object.freeze({ shopify, square, clover, woocommerce, gmail, microsoft365 });

const generic = Object.freeze({
  type: 'reference_webhook', name: 'Custom business system', mark: 'API', category: 'business', authMode: 'token',
  description: 'Connect a custom POS, ERP, or internal system with a Foundry API key and documented event endpoint.',
  provides: ['sales', 'customer orders', 'fulfillment', 'returns', 'receipts and transfers'],
  available: true,
});

const future = Object.freeze([
  { type: 'erp_future', name: 'More ERP connectors', mark: 'ERP', category: 'business', available: false,
    description: 'Additional packaged ERP connections will use the same Foundry event contract.', provides: ['future ERP activity'],
    unavailableReason: 'Use Custom business system today; more packaged ERP connectors are planned.' },
]);

function get(type) { return adapters[type] || null; }
function catalog() { return [shopify.metadata(), square.metadata(), clover.metadata(), woocommerce.metadata(), generic,
  ...future, gmail.metadata(), microsoft365.metadata()]; }

module.exports = { get, catalog, generic };

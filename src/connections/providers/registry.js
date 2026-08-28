'use strict';

const shopify = require('./shopify');
const square = require('./square');
const clover = require('./clover');
const woocommerce = require('./woocommerce');

const adapters = Object.freeze({ shopify, square, clover, woocommerce });

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
  { type: 'gmail', name: 'Gmail', mark: 'G', category: 'supplier', available: false,
    description: 'Supplier messages and attachments from Gmail.', provides: ['supplier communication'],
    unavailableReason: 'Supplier mailbox authorization belongs to the supplier-communication pass.' },
  { type: 'microsoft365', name: 'Microsoft 365', mark: 'M365', category: 'supplier', available: false,
    description: 'Supplier messages and attachments from Microsoft 365.', provides: ['supplier communication'],
    unavailableReason: 'Supplier mailbox authorization belongs to the supplier-communication pass.' },
]);

function get(type) { return adapters[type] || null; }
function catalog() { return [shopify.metadata(), square.metadata(), clover.metadata(), woocommerce.metadata(), generic, ...future]; }

module.exports = { get, catalog, generic };

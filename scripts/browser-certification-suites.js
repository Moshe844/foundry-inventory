'use strict';

// Keep the acceptance coverage of the reference app on the database and routes
// used by production. Provider fixtures exercise the real app boundary.
const workflows = {
  signupAndOnboarding: ['public-signup-plans', 'signup-product-ui', 'auth-http',
    'new-account-first-day', 'onboarding-experience', 'onboarding-file-formats'],
  inventoryAndIsolation: ['settings-integrity', 'browser-ui', 'inventory-navigation-browser', 'workspaces-ui',
    'catalog-full-ui', 'inventory-engine', 'transfers-ui', 'existing-stock-costs-ui'],
  importsAndCutover: ['imports-ui', 'erp-cutover-ui', 'erp-cutover-application'],
  decisionsAndAutomation: ['home-ui', 'autopilot-ui', 'adaptive-goal-controller',
    'ask-workflow-bridge-ui', 'operations-ui', 'standing-authority-scope', 'runtime',
    'external-job-lease', 'native-goal-write-queue', 'storage-import-priority'],
  purchasingSalesAndAccounting: ['commerce-ui', 'business-workflows', 'purchase-order-read-state',
    'accounting-ledger', 'completion-money-ui', 'reporting-ui', 'agent-customer-email-orders'],
  paymentsAndFulfilment: ['subscription-guarantee', 'customer-settings-controls', 'payments-ui', 'commercial-lifecycle-ui', 'customer-returns-ui',
    'supplier-returns-ui', 'shipping-ui', 'warehouse-waves-ui', 'warehouse-pages'],
  connectionsAndMail: ['connection-popup-return', 'connector-events', 'shopify-production-pilot', 'shopify-scope-handoff', 'shopify-webhooks',
    'square-webhooks', 'square-shared-webhook', 'mail-ui'],
};

const pathFor = name => `tests/postgres/${name}.test.js`;
const browser = Object.values(workflows).flat().map(pathFor);
const liveAi = [pathFor('ask-live-capability-probe')];

module.exports = { browser, liveAi };

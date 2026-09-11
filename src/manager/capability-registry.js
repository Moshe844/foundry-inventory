'use strict';

/** Compatibility adapter: capability truth lives in product-brain/catalog. */
const { canonical } = require('../product-brain/registry');

const CAPABILITIES = Object.freeze(canonical.managerCapabilities().map((entry) => Object.freeze(entry)));
const byId = new Map(CAPABILITIES.map((entry) => [entry.id, entry]));

function get(id) { return byId.get(id) || null; }
function list() { return CAPABILITIES.map((entry) => ({ ...entry, examples: [...entry.examples] })); }

function defaultForIntent(intentClass) {
  const preferred = {
    QUESTION: 'manager.answer', EXPLANATION: 'manager.explain', INVENTORY_ACTION: 'inventory.record-movement',
    CATALOG_CHANGE: 'catalog.manage', IMPORT: 'data.import-file', PHYSICAL_EVENT: 'events.record-physical-fact',
    PURCHASING_REQUEST: 'purchasing.manage', POLICY_CHANGE: 'rules.manage', SALES_ORDER: 'sales.manage-orders',
    OPERATING_INSTRUCTION: 'rules.manage', INVESTIGATION_REQUEST: 'inventory.investigate',
    CONFIGURATION_CHANGE: 'catalog.manage', STOP: 'manager.pause-automation',
  };
  return preferred[intentClass] || '';
}

function publicPrompt() {
  return CAPABILITIES.map((entry) => `- ${entry.id}: ${entry.description} Safety: ${entry.safety}`).join('\n');
}

module.exports = { CAPABILITIES, get, list, defaultForIntent, publicPrompt };

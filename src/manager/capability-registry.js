'use strict';

/**
 * The things the inventory manager can actually do.
 *
 * Natural language is deliberately kept out of this registry. A capability is
 * a stable business operation, not a sentence pattern. The model selects one
 * of these operations; its handler then resolves records and uses the existing
 * deterministic service. Adding another way of asking must therefore never
 * require another route or another regular expression.
 */
const CAPABILITIES = [
  {
    id: 'sales.manage-orders', intentClass: 'SALES_ORDER', handler: 'sales_order',
    description: 'Create, change, allocate, fulfill, cancel or inspect customer sales orders and committed demand.',
    examples: ['a customer ordered 40', 'add 10 to their order', 'ship 20', 'cancel that line', 'what is backordered'],
    safety: 'Uses the structured Sales Order service; commitments never impersonate physical stock movements.',
  },
  {
    id: 'inventory.record-movement', intentClass: 'INVENTORY_ACTION', handler: 'inventory_action',
    description: 'Record or propose receipts, sales/issues, transfers, counts/corrections, locations, products or variants.',
    examples: ['stock arrived', 'we sold some units', 'move stock', 'correct this count', 'add a product'],
    safety: 'All consequential changes use the action preview and inventory engine.',
  },
  {
    id: 'catalog.transform-internal-codes', intentClass: 'CATALOG_CHANGE', handler: 'catalog_code_change',
    description: 'Change existing customer-owned product or SKU identifiers in bulk or individually, including prefix transformations.',
    examples: ['make every code beginning TS begin ME', 'replace the ABC prefix with XYZ'],
    safety: 'Previews every affected code, checks collisions, then requires owner approval.',
  },
  {
    id: 'catalog.remove-imported-records', intentClass: 'CATALOG_CHANGE', handler: 'document_removal',
    description: 'Remove or roll back products created by a previously applied file or document.',
    examples: ['undo the products from the last PDF', 'remove items added by that spreadsheet'],
    safety: 'Previews provenance and quantities; approval preserves the audit trail.',
  },
  {
    id: 'catalog.manage', intentClass: 'CATALOG_CHANGE', handler: 'inventory_action',
    description: 'Create, archive or change products, variants, locations and customer terminology.',
    examples: ['add another warehouse', 'create a size variant', 'remove this zero-stock SKU', 'call locations branches'],
    safety: 'Uses a grounded preview before changing catalogue records.',
  },
  {
    id: 'purchasing.manage', intentClass: 'PURCHASING_REQUEST', handler: 'purchasing',
    description: 'Prepare or inspect replenishment, supplier orders, purchase orders and receiving.',
    examples: ['order what is needed', 'buy 20 from this supplier', 'receive that purchase order'],
    safety: 'Supplier rules and authority gates remain deterministic; sending or placing needs authority.',
  },
  {
    id: 'supplier.map-code', intentClass: 'CONFIGURATION_CHANGE', handler: 'supplier_code_mapping',
    description: 'Map a supplier or vendor code to the customer internal product code.',
    examples: ['their code V-10 is our code TS-10'],
    safety: 'Shows the exact supplier and internal records before approval.',
  },
  {
    id: 'rules.manage', intentClass: 'OPERATING_INSTRUCTION', handler: 'operating_instruction',
    description: 'Create, update or remove lasting stock, replenishment, supplier, transfer, purchasing, protection, timing or authority rules.',
    examples: ['reorder below 20', 'keep 10 here', 'never spend over 500', 'remove that rule'],
    safety: 'Writes the same structured settings as the UI and requires confirmation for authority.',
  },
  {
    id: 'events.record-physical-fact', intentClass: 'PHYSICAL_EVENT', handler: 'physical_event',
    description: 'Record a physical count, delivery, damage, return, found stock or other observed inventory fact.',
    examples: ['I counted 7', 'the delivery arrived damaged'],
    safety: 'Matches evidence to records; discrepancies never silently change inventory.',
  },
  {
    id: 'inventory.investigate', intentClass: 'INVESTIGATION_REQUEST', handler: 'investigation',
    description: 'Investigate a discrepancy or explain why physical inventory and records differ.',
    examples: ['investigate this mismatch', 'why is the count off'],
    safety: 'Creates evidence-backed investigation work without inventing a correction.',
  },
  {
    id: 'data.import-file', intentClass: 'IMPORT', handler: 'attachment_required',
    description: 'Read or import an attached spreadsheet, PDF, document, image or text file.',
    examples: ['import this spreadsheet', 'read the supplier PDF'],
    safety: 'The file is interpreted and previewed before any operational change.',
  },
  {
    id: 'manager.answer', intentClass: 'QUESTION', handler: 'ask',
    description: 'Answer a question about current inventory, catalogue totals, prices, sales, purchasing, settings, history or how to use Foundry.',
    examples: ['how many items are in inventory', 'where is this item', 'what is low', 'how do I receive stock'],
    safety: 'Read-only.',
  },
  {
    id: 'connections.manage', intentClass: 'CONFIGURATION_CHANGE', handler: 'connection_management',
    description: 'Inspect, map, pause, resume or configure external connections and their trusted record mappings.',
    examples: ['map external SKU 8473 to Black Small', 'stop trusting the Downtown POS', 'resume that connection'],
    safety: 'Uses workspace-scoped connection and mapping records; never mutates inventory directly.',
  },
  {
    id: 'manager.explain', intentClass: 'EXPLANATION', handler: 'ask',
    description: 'Explain a current recommendation, decision, refusal or calculation.',
    examples: ['why did you recommend this', 'why was that blocked'],
    safety: 'Read-only and grounded in recorded evidence.',
  },
  {
    id: 'manager.pause-automation', intentClass: 'STOP', handler: 'autopilot_pause',
    description: 'Pause or stop automatic consequential work.',
    examples: ['pause', 'stop handling things automatically'],
    safety: 'Reversible and never changes inventory.',
  },
];

const byId = new Map(CAPABILITIES.map((entry) => [entry.id, Object.freeze(entry)]));

function get(id) { return byId.get(id) || null; }
function list() { return CAPABILITIES.map((entry) => ({ ...entry, examples: [...entry.examples] })); }

function defaultForIntent(intentClass) {
  const preferred = {
    QUESTION: 'manager.answer', EXPLANATION: 'manager.explain', INVENTORY_ACTION: 'inventory.record-movement',
    CATALOG_CHANGE: 'catalog.manage', IMPORT: 'data.import-file', PHYSICAL_EVENT: 'events.record-physical-fact',
    PURCHASING_REQUEST: 'purchasing.manage', POLICY_CHANGE: 'rules.manage',
    SALES_ORDER: 'sales.manage-orders',
    OPERATING_INSTRUCTION: 'rules.manage', INVESTIGATION_REQUEST: 'inventory.investigate',
    CONFIGURATION_CHANGE: 'catalog.manage', STOP: 'manager.pause-automation',
  };
  return preferred[intentClass] || '';
}

function publicPrompt() {
  return CAPABILITIES.map((entry) =>
    `- ${entry.id}: ${entry.description} Safety: ${entry.safety}`
  ).join('\n');
}

module.exports = { CAPABILITIES, get, list, defaultForIntent, publicPrompt };

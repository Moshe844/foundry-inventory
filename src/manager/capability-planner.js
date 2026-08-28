'use strict';

const { createProviderForTier } = require('../ai/provider');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');
const managerContext = require('./context');
const capabilities = require('./capability-registry');

const INTENT_CLASSES = [
  'QUESTION', 'INVENTORY_ACTION', 'CATALOG_CHANGE', 'IMPORT', 'PHYSICAL_EVENT',
  'PURCHASING_REQUEST', 'SALES_ORDER', 'POLICY_CHANGE', 'INVESTIGATION_REQUEST',
  'OPERATING_INSTRUCTION', 'CONFIGURATION_CHANGE', 'EXPLANATION', 'STOP', 'UNKNOWN',
];

const PARAMETER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['fromText', 'toText', 'transformMode', 'documentReference'],
  properties: {
    fromText: { type: 'string' },
    toText: { type: 'string' },
    transformMode: { type: 'string', enum: ['', 'exact', 'prefix'] },
    documentReference: { type: 'string' },
  },
};

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  // Production output must name the actual executable capability. Otherwise a
  // model can satisfy the schema with only the old coarse intent class and the
  // request falls back into the very generic route this planner replaces.
  required: ['capabilityId', 'intentClass', 'confidence', 'goal', 'reason',
    'resolvedReference', 'clarifyingQuestion', 'parameters'],
  properties: {
    capabilityId: { type: 'string', enum: capabilities.CAPABILITIES.map((entry) => entry.id) },
    intentClass: { type: 'string', enum: INTENT_CLASSES },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    goal: { type: 'string' },
    reason: { type: 'string' },
    resolvedReference: { type: 'string' },
    clarifyingQuestion: { type: 'string' },
    parameters: PARAMETER_SCHEMA,
  },
};

// Compatibility is explicit and one-way: old scripted/provider responses can
// still be consumed, but the schema sent to production never makes capability
// selection optional.
const LEGACY_PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['intentClass', 'confidence', 'reason', 'resolvedReference', 'clarifyingQuestion'],
  properties: {
    intentClass: { type: 'string', enum: INTENT_CLASSES },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string' }, resolvedReference: { type: 'string' },
    clarifyingQuestion: { type: 'string' },
  },
};

const SYSTEM = `You are the planning boundary for an inventory manager.

Choose the ONE registered business capability that can achieve the person's
requested outcome. Choose by meaning, not by matching example wording. The
same capability must be selected for paraphrases, different grammar, spelling
errors and reordered clauses.

Registered capabilities:
${capabilities.publicPrompt()}

Rules:
- Never invent records, quantities, identifiers, authority or facts.
- Do not design a new mutation. The selected deterministic handler owns all
  lookup, validation, preview, approval, execution and audit work.
- Ask one concrete clarifying question only when a fact needed to choose the
  capability is genuinely missing. Record-specific ambiguity is left to the
  grounded handler, which can show the real candidates.
- A request to change customer-owned product/SKU codes is
  catalog.transform-internal-codes. A vendor-to-internal mapping is
  supplier.map-code. Keep those meanings separate.
- For catalog.transform-internal-codes, extract the old text into fromText, the
  replacement into toText, and exact or prefix into transformMode. "Every",
  "all", "begins with", "starts with", or "first letters" means prefix.
- For catalog.remove-imported-records, put any named file or document in
  documentReference. "Last", "newest" or "earlier upload" can remain in the
  goal; the handler resolves it from the workspace.
- Removing or archiving one named existing product/SKU is catalog.manage, even
  when the person says it was added by mistake. Use
  catalog.remove-imported-records only when the requested scope is explicitly
  a PDF, spreadsheet, upload, import or other stored document.
- Use the durable conversation only for a genuine follow-up. Never let an old
  record override a product or order explicitly named in the current message.
- If none of the registered capabilities can achieve the outcome, choose the
  nearest read-only manager.answer capability and explain the exact missing
  business capability in reason. Do not claim a known capability is
  unsupported merely because the wording is unfamiliar.`;

function safeRows(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function workspaceSnapshot(db, ctx) {
  const workspaceId = ctx.workspaceId;
  return {
    durable: managerContext.snapshot(db, ctx),
    products: safeRows(db, `SELECT i.name, i.base_code AS baseCode, s.variant_label AS variant, s.code
      FROM items i JOIN skus s ON s.item_id = i.id AND s.workspace_id = i.workspace_id
      WHERE i.workspace_id = ? AND i.is_active = 1 AND s.is_active = 1
      ORDER BY i.name, s.position LIMIT 120`, [workspaceId]),
    locations: safeRows(db, 'SELECT name, kind FROM locations WHERE workspace_id = ? AND is_active = 1 ORDER BY name', [workspaceId]),
    suppliers: safeRows(db, 'SELECT name FROM suppliers WHERE workspace_id = ? AND is_active = 1 ORDER BY name', [workspaceId]),
    purchaseOrders: safeRows(db, `SELECT po_number AS poNumber, status FROM purchase_orders
      WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20`, [workspaceId]),
    salesOrders: safeRows(db, `SELECT so.order_number AS orderNumber, so.status, c.name AS customer
      FROM sales_orders so JOIN customers c ON c.id = so.customer_id
      WHERE so.workspace_id = ? ORDER BY so.created_at DESC LIMIT 30`, [workspaceId]),
    appliedDocuments: safeRows(db, `SELECT source_name AS sourceName, applied_at AS appliedAt FROM setup_documents
      WHERE workspace_id = ? AND status = 'APPLIED' ORDER BY applied_at DESC, created_at DESC LIMIT 20`, [workspaceId]),
  };
}

async function plan(db, ctx, message, options = {}) {
  const provider = options.provider || createProviderForTier('fast');
  const response = await provider.complete({
    system: SYSTEM,
    prompt: `Current workspace and conversation:\n${JSON.stringify(workspaceSnapshot(db, ctx))}\n\nOwner request:\n${message}`,
    schema: PLAN_SCHEMA,
    // Keep the established boundary name. Consumers that only know the older
    // intent wire still return a valid answer; capable providers return the
    // more precise operation and parameters as well.
    schemaName: 'manager_intent',
  });
  const result = validate(toWireSchema(PLAN_SCHEMA), response.data, { key: 'manager-capability-plan-wire' });
  let data;
  if (result.ok) data = result.data;
  else {
    const legacy = validate(toWireSchema(LEGACY_PLAN_SCHEMA), response.data, { key: 'manager-capability-legacy-wire' });
    if (!legacy.ok) throw new Error('Foundry could not reliably plan that request.');
    data = legacy.data;
  }
  const capabilityId = data.capabilityId || capabilities.defaultForIntent(data.intentClass);
  const capability = capabilities.get(capabilityId);
  return {
    ...data,
    capabilityId,
    goal: data.goal || message,
    parameters: data.parameters || { fromText: '', toText: '', transformMode: '', documentReference: '' },
    intentClass: capability ? capability.intentClass : data.intentClass,
    handler: capability ? capability.handler : '',
  };
}

module.exports = { PARAMETER_SCHEMA, PLAN_SCHEMA, LEGACY_PLAN_SCHEMA, SYSTEM, workspaceSnapshot, plan };

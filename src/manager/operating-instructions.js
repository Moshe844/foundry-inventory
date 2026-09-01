'use strict';

/**
 * Teach-once operating instructions.
 *
 * A model may extract typed values and customer wording. It never returns a
 * database id and it never writes. This module resolves every named entity
 * against the current workspace, snapshots the exact changes, and applies
 * that snapshot only after explicit approval through the same services used
 * by Settings.
 */

const crypto = require('node:crypto');
const config = require('../config');
const { createProviderForTier } = require('../ai/provider');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');
const { newId, nowIso } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const resolver = require('../actions/resolver');
const reorderPolicies = require('../purchasing/policy-service');
const suppliers = require('../purchasing/supplier-service');
const automationPolicies = require('../autopilot/policy-service');
const preferences = require('../autopilot/preferences');
const modes = require('../autopilot/modes');
const operatingGuards = require('../domain/operating-guards');
const managerEvents = require('./events');
const reactions = require('./reactions');

const DOMAINS = [
  'replenishment', 'location_stock', 'supplier_assignment', 'supplier_terms',
  'transfer_authority', 'purchase_authority', 'operating_preference', 'hard_limits',
  'stock_protection', 'supplier_communication',
];

// All fields are required because providers are more reliable with a closed,
// fixed shape. Empty string / -1 / false means “not stated”; it does not mean
// clear. The `operation` field is the only way to remove something.
const CHANGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [
    'domain', 'operation', 'itemText', 'variantText', 'locationText', 'sourceLocationText',
    'supplierText', 'reorderPoint', 'targetStock', 'safetyStock', 'locationMinimum',
    'locationTarget', 'leadTimeDays', 'unitsPerPurchaseUnit', 'minimumOrderQuantity',
    'orderMultiple', 'maximumQuantity', 'maximumValue', 'cooldownHours', 'daysOfStock',
    'purchaseUnit', 'contactName', 'email', 'orderingMethod',
    'preferTransferBeforePurchasing', 'approvalRequired', 'guardAction', 'guardMode', 'guardMetric',
    'guardComparator', 'guardThreshold', 'guardReleaseCondition', 'guardReleaseThreshold',
  ],
  properties: {
    domain: { type: 'string', enum: DOMAINS },
    operation: { type: 'string', enum: ['set', 'remove'] },
    itemText: { type: 'string' }, variantText: { type: 'string' },
    locationText: { type: 'string' }, sourceLocationText: { type: 'string' },
    supplierText: { type: 'string' },
    reorderPoint: { type: 'integer' }, targetStock: { type: 'integer' },
    safetyStock: { type: 'integer' }, locationMinimum: { type: 'integer' },
    locationTarget: { type: 'integer' }, leadTimeDays: { type: 'integer' },
    unitsPerPurchaseUnit: { type: 'integer' }, minimumOrderQuantity: { type: 'integer' },
    orderMultiple: { type: 'integer' }, maximumQuantity: { type: 'integer' },
    maximumValue: { type: 'number' }, cooldownHours: { type: 'integer' },
    daysOfStock: { type: 'integer' }, purchaseUnit: { type: 'string' },
    contactName: { type: 'string' }, email: { type: 'string' }, orderingMethod: { type: 'string' },
    prepareCommunications: { type: 'boolean' }, autoSendEnabled: { type: 'boolean' },
    autoSendLimit: { type: 'number' }, priceTolerancePercent: { type: 'number' },
    quantityTolerancePercent: { type: 'number' }, watchSupplier: { type: 'boolean' }, trustedSender: { type: 'string' },
    preferTransferBeforePurchasing: { type: 'boolean' }, approvalRequired: { type: 'boolean' },
    guardAction: { type: 'string', enum: ['', 'issue'] },
    guardMode: { type: 'string', enum: ['', 'block', 'warn'] },
    guardMetric: { type: 'string', enum: ['', 'network_on_hand', 'location_on_hand'] },
    guardComparator: { type: 'string', enum: ['', 'below', 'at_or_below'] },
    guardThreshold: { type: 'integer' },
    guardReleaseCondition: { type: 'string', enum: ['', 'on_order', 'stock_recovered', 'manual'] },
    guardReleaseThreshold: { type: 'integer' },
  },
};

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['understood', 'summary', 'changes', 'clarifyingQuestion', 'unsupportedReason'],
  properties: {
    understood: { type: 'boolean' },
    summary: { type: 'string' },
    changes: { type: 'array', minItems: 0, maxItems: 20, items: CHANGE_SCHEMA },
    clarifyingQuestion: { type: 'string' },
    unsupportedReason: { type: 'string' },
  },
};

const SYSTEM = `You translate one business owner's lasting inventory operating instruction into typed settings.
Return only the schema. Extract what was explicitly said; do not invent values, records, authority, or defaults.

Use replenishment for reorder point, order-up-to target, network safety stock, and product lead time.
Use location_stock for a location minimum/keep-back and a desired location target.
Use supplier_assignment to make a named supplier preferred for a product.
Use supplier_terms for supplier contact, ordering method, lead time, purchase unit, units per purchase unit, MOQ, and order multiple.
Use supplier_communication for watched supplier senders, preparing supplier messages, automatic send limits,
price-change tolerance, and quantity-change tolerance. Preparing is not sending. Automatic sending requires a
stated supplier and maximum value. Supplier communication never grants authority to change inventory.
To stop one supplier-communication capability, use operation remove and set only the matching boolean true:
autoSendEnabled for automatic sending, prepareCommunications for preparation, or watchSupplier for mailbox
watching. Use operation remove with all three false only when the owner explicitly asks to remove the entire
supplier communication setup. This identifies what to remove; it never means enable it.
Use transfer_authority only when the owner explicitly permits automatic transfers without approval; maximumQuantity must be stated.
Use purchase_authority only when the owner explicitly permits automatic purchase-order approval; maximumValue and supplier must be stated.
Use operating_preference for transfer-before-buying or target days of stock.
Use hard_limits for a workspace cooldown.
Use stock_protection when the owner wants to block outgoing sales/issues or receive a warning at a stock threshold.
The guardAction is issue. Use network_on_hand unless a location was named. "Below" is below; "at or below"
is inclusive. Set guardMode to block for a hard stop and warn when the owner says to only warn or notify them.
If the owner says sales may resume after more is ordered, guardReleaseCondition is on_order.
If sales may resume only after stock is received/recovered, use stock_recovered and extract the stated recovery
level, or use the guard threshold when no separate recovery level was stated. Use manual only when the owner
explicitly wants an owner to release the block. A customer order or sale leaving inventory is an issue; a
supplier/replenishment order is purchasing. Ask a concise clarification only when the instruction truly does
not distinguish those two meanings.

A lasting stock threshold is supported even when no supplier or automatic-work authority exists yet.
Always extract an explicitly stated reorder point, target, safety level, location floor, or location target.
Those settings decide when work is needed; they do not themselves grant permission to move stock, approve an order,
or contact a supplier. Do not reject a stock rule merely because carrying out future work may still require a supplier,
evidence, or approval. The deterministic manager handles those boundaries later.

Numbers not stated are -1. Text not stated is an empty string. Boolean fields are meaningful only in their matching domain.
“Prepare” is not permission to send or place an order. “Automatically place/approve” is authority and must be purchase_authority.
When identity or a necessary limit is missing, set a concise clarifyingQuestion. Never guess.`;

const json = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const nonnegative = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function emptyChange() {
  return {
    operation: 'set', itemText: '', variantText: '', locationText: '', sourceLocationText: '', supplierText: '',
    reorderPoint: -1, targetStock: -1, safetyStock: -1, locationMinimum: -1, locationTarget: -1,
    leadTimeDays: -1, unitsPerPurchaseUnit: -1, minimumOrderQuantity: -1, orderMultiple: -1,
    maximumQuantity: -1, maximumValue: -1, cooldownHours: -1, daysOfStock: -1,
    purchaseUnit: '', contactName: '', email: '', orderingMethod: '',
    prepareCommunications: false, autoSendEnabled: false, autoSendLimit: -1,
    priceTolerancePercent: -1, quantityTolerancePercent: -1, watchSupplier: false, trustedSender: '',
    preferTransferBeforePurchasing: false, approvalRequired: true,
    guardAction: '', guardMode: '', guardMetric: '', guardComparator: '', guardThreshold: -1,
    guardReleaseCondition: '', guardReleaseThreshold: -1,
  };
}

function editDistance(left, right) {
  const a = String(left || '').toLowerCase();
  const b = String(right || '').toLowerCase();
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = old;
    }
  }
  return row[b.length];
}

function containsVocabulary(text, words) {
  const tokens = String(text || '').toLowerCase().match(/[a-z]+/g) || [];
  return tokens.some((token) => words.some((word) => token === word
    || (token.length >= 5 && word.length >= 5 && Math.abs(token.length - word.length) <= 2 && editDistance(token, word) <= 2)));
}

/**
 * Deterministic recovery for the stock-protection domain.
 *
 * The model is useful for varied wording, but it is not allowed to declare a
 * supported safety rule impossible. This compiler recognises the rule's
 * general semantic parts — a stock comparison, a blocked outgoing operation,
 * and a release condition — then leaves product/location identity to the same
 * workspace resolver used everywhere else. It contains no product names,
 * supplier names or fixed quantities.
 */
function compileStockProtection(instruction) {
  const text = String(instruction || '').trim();
  const lower = text.toLowerCase();
  const block = /\b(block|stop|prevent|disallow|refuse|pause)\b/.test(lower);
  const threshold = lower.match(/\b(at\s+or\s+below|no\s+more\s+than|at\s+most|less\s+than|fewer\s+than|below|under)\s+(\d+)\b/);
  if (!block || !threshold) return null;
  const untilAt = lower.indexOf('until');
  const beforeUntil = untilAt >= 0 ? lower.slice(0, untilAt) : lower;
  const afterUntil = untilAt >= 0 ? lower.slice(untilAt + 5) : '';
  const explicitlyOutgoing = /\b(sale|sales|sell|selling|customer\s+orders?|outgoing\s+orders?|issues?|issuing|fulfil|fulfill|ship|shipping)\b/.test(beforeUntil);
  const orderingAfter = containsVocabulary(afterUntil, ['order', 'ordered', 'reorder', 'reordered', 'purchase', 'purchased']);
  const twoSidedOrder = /\borders?\b/.test(beforeUntil) && orderingAfter;
  if (!explicitlyOutgoing && !twoSidedOrder) return null;
  let releaseCondition = '';
  if (orderingAfter) releaseCondition = 'on_order';
  else if (containsVocabulary(afterUntil, ['receive', 'received', 'restock', 'restocked', 'replenish', 'replenished', 'recover', 'recovered'])) releaseCondition = 'stock_recovered';
  else if (/\b(owner|manually|manual)\b/.test(afterUntil)) releaseCondition = 'manual';
  if (!releaseCondition) return null;
  const guardThreshold = Number(threshold[2]);
  const inclusive = /^(at\s+or\s+below|no\s+more\s+than|at\s+most)$/.test(threshold[1]);
  return {
    understood: true,
    summary: 'Protect outgoing stock at the stated threshold',
    clarifyingQuestion: '', unsupportedReason: '',
    changes: [{
      ...emptyChange(), domain: 'stock_protection', guardAction: 'issue', guardMode: 'block',
      guardMetric: 'network_on_hand', guardComparator: inclusive ? 'at_or_below' : 'below',
      guardThreshold, guardReleaseCondition: releaseCondition,
      guardReleaseThreshold: releaseCondition === 'stock_recovered' ? guardThreshold : -1,
    }],
  };
}

function compileSupplierCommunication(instruction) {
  const text = String(instruction || '').trim();
  const lower = text.toLowerCase();
  if (!/(watch\s+(?:emails?|messages?)|prepare\s+supplier|automatically\s+send|you\s+can\s+send|price\s+(?:increase|change))/.test(lower)) return null;
  const named = text.match(/watch\s+(?:emails?|messages?)\s+from\s+(.+?)(?:\.|,|$)/i)
    || text.match(/^(?:for\s+)?(.+?)(?:,?\s+(?:prepare|automatically|you\s+can|never|always))/i);
  const supplierText = named?.[1]?.trim() || '';
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  const amount = text.match(/(?:under|up\s+to|limit(?:\s+is)?)\s*\$\s*([\d,.]+)/i);
  const tolerance = text.match(/(?:price\s+(?:increase|change)[^\d]{0,25})(\d+(?:\.\d+)?)\s*%/i)
    || text.match(/(\d+(?:\.\d+)?)\s*%[^.]{0,30}price/i);
  const change = { ...emptyChange(), domain: 'supplier_communication', supplierText,
    trustedSender: email, watchSupplier: /watch\s+(?:emails?|messages?)/i.test(text),
    prepareCommunications: /prepare/i.test(text),
    autoSendEnabled: /(?:automatically\s+send|you\s+can\s+send)/i.test(text),
    autoSendLimit: amount ? Number(amount[1].replaceAll(',', '')) : -1,
    priceTolerancePercent: tolerance ? Number(tolerance[1]) : -1 };
  return { understood: true, summary: `Configure supplier communication${supplierText ? ` for ${supplierText}` : ''}`,
    changes: [change], clarifyingQuestion: change.autoSendEnabled && change.autoSendLimit < 0
      ? 'What is the most Foundry may send to this supplier without asking?' : '', unsupportedReason: '' };
}

function supplierMatch(db, workspaceId, name) {
  const clean = String(name || '').trim().toLowerCase();
  if (!clean) return { ok: false, question: 'Which supplier should this apply to?' };
  const rows = suppliers.listSuppliers(db, workspaceId, { includeInactive: false });
  const exact = rows.filter((row) => row.name.toLowerCase() === clean);
  const partial = exact.length ? exact : rows.filter((row) => row.name.toLowerCase().includes(clean) || clean.includes(row.name.toLowerCase()));
  if (partial.length === 1) return { ok: true, value: partial[0] };
  if (partial.length > 1) return { ok: false, question: `Which supplier do you mean: ${partial.map((r) => r.name).join(' or ')}?` };
  return { ok: false, question: `There is no supplier called “${name}” in this inventory. Add it first, then teach Foundry the rule.` };
}

function needsSku(domain) {
  return ['replenishment', 'location_stock', 'supplier_assignment', 'supplier_terms', 'stock_protection'].includes(domain);
}

function resolveChange(db, workspaceId, raw, instruction) {
  const out = { ...raw };
  const questions = [];
  if (needsSku(raw.domain)) {
    const sku = raw.itemText || raw.variantText
      ? resolver.resolveSku(db, workspaceId, raw.itemText, raw.variantText)
      : resolver.clarifySkuFromInstruction(db, workspaceId, instruction);
    if (!sku || !sku.ok) questions.push(sku?.message || 'Which product or variant should this rule apply to?');
    else {
      out.skuId = sku.value.id;
      out.itemId = sku.value.item_id;
      out.displayName = `${sku.value.item_name || sku.value.name}${sku.value.variant_label ? ` / ${sku.value.variant_label}` : ''}`;
    }
  }
  if (raw.domain === 'location_stock' || raw.domain === 'stock_protection' || (raw.domain === 'transfer_authority' && raw.locationText)) {
    if (raw.domain === 'stock_protection' && !raw.locationText) {
      // No place was named: this is deliberately a network-level guard.
    } else {
    const location = resolver.resolveLocation(db, workspaceId, raw.locationText, { role: 'location' });
    if (!location.ok) questions.push(location.message);
    else { out.locationId = location.value.id; out.locationName = location.value.name; }
    }
  }
  if (raw.domain === 'transfer_authority' && raw.sourceLocationText) {
    const source = resolver.resolveLocation(db, workspaceId, raw.sourceLocationText, { role: 'source location' });
    if (!source.ok) questions.push(source.message);
    else { out.sourceLocationId = source.value.id; out.sourceLocationName = source.value.name; }
  }
  if (['supplier_assignment', 'supplier_terms', 'purchase_authority', 'supplier_communication'].includes(raw.domain)) {
    const supplier = supplierMatch(db, workspaceId, raw.supplierText);
    if (!supplier.ok) questions.push(supplier.question);
    else { out.supplierId = supplier.value.id; out.supplierName = supplier.value.name; }
  }
  if (raw.domain === 'transfer_authority' && raw.operation === 'set' && !positive(raw.maximumQuantity)) {
    questions.push('What is the most Foundry may transfer automatically in one action?');
  }
  if (raw.domain === 'purchase_authority' && raw.operation === 'set' && !positive(raw.maximumValue)) {
    questions.push('What is the most Foundry may commit on one supplier order without asking?');
  }
  if (raw.domain === 'supplier_communication' && raw.operation === 'set'
      && raw.autoSendEnabled && !positive(raw.autoSendLimit)) {
    questions.push('What is the most Foundry may send to this supplier without asking?');
  }
  if (raw.domain === 'supplier_communication' && raw.watchSupplier && out.supplierId) {
    const supplier = suppliers.getSupplier(db, workspaceId, out.supplierId);
    const mailbox = supplier.watchedConnectorId
      ? db.prepare(`SELECT id, display_name FROM workspace_connectors WHERE workspace_id = ? AND id = ?
          AND provider_type IN ('gmail','microsoft365','supplier_email') AND status = 'connected'`).get(workspaceId, supplier.watchedConnectorId)
      : db.prepare(`SELECT id, display_name FROM workspace_connectors WHERE workspace_id = ?
          AND provider_type IN ('gmail','microsoft365','supplier_email') AND status = 'connected'
          ORDER BY created_at LIMIT 1`).get(workspaceId);
    if (!mailbox) questions.push('Connect Gmail or Microsoft 365 first. Which mailbox should watch this supplier?');
    else { out.connectorId = mailbox.id; out.connectorName = mailbox.display_name; }
  }
  if (raw.domain === 'stock_protection' && raw.operation === 'set') {
    const guardMode = raw.guardMode || (raw.guardReleaseCondition ? 'block' : '');
    out.guardMode = guardMode;
    if (raw.guardAction !== 'issue') questions.push('Should this block outgoing sales/issues, or supplier purchase orders?');
    if (!['block', 'warn'].includes(guardMode)) questions.push('Should Foundry block outgoing stock at the limit, or only warn you?');
    if (nonnegative(raw.guardThreshold) === null) questions.push('At what on-hand quantity should Foundry warn or block outgoing stock?');
    if (guardMode === 'block' && !raw.guardReleaseCondition) questions.push('What should release the block: a placed supplier order, received stock, or an owner changing the rule?');
  }
  return { change: out, questions };
}

function describe(change) {
  const subject = change.displayName || change.supplierName || 'this inventory';
  if (change.operation === 'remove') {
    if (change.domain === 'supplier_communication') {
      if (change.autoSendEnabled) return `Stop automatically sending supplier messages to ${subject}; keep its other communication settings.`;
      if (change.prepareCommunications) return `Stop preparing routine supplier messages for ${subject}; keep its other communication settings.`;
      if (change.watchSupplier) return `Stop watching supplier messages from ${subject}; keep its other communication settings.`;
    }
    return `Stop using the ${change.domain.replaceAll('_', ' ')} rule for ${subject}.`;
  }
  switch (change.domain) {
    case 'replenishment': {
      const values = [];
      if (nonnegative(change.reorderPoint) !== null) values.push(`reorder at ${change.reorderPoint}`);
      if (nonnegative(change.targetStock) !== null) values.push(`bring the network position to ${change.targetStock}`);
      if (nonnegative(change.safetyStock) !== null) values.push(`safety stock ${change.safetyStock}`);
      if (nonnegative(change.leadTimeDays) !== null) values.push(`lead time ${change.leadTimeDays} days`);
      return `${subject}: ${values.join('; ')}.`;
    }
    case 'location_stock': return `${subject} at ${change.locationName}: keep at least ${change.locationMinimum}${nonnegative(change.locationTarget) !== null ? ` and replenish toward ${change.locationTarget}` : ''}.`;
    case 'supplier_assignment': return `${change.supplierName} becomes the preferred supplier for ${subject}.`;
    case 'supplier_terms': return `Remember the stated purchasing terms for ${subject} from ${change.supplierName}.`;
    case 'supplier_communication': {
      const parts = [];
      if (change.watchSupplier) parts.push(`watch approved messages from ${change.trustedSender || change.supplierName}`);
      if (change.prepareCommunications) parts.push('prepare routine supplier messages');
      if (change.autoSendEnabled) parts.push(`send routine orders up to $${change.autoSendLimit}`);
      if (nonnegative(change.priceTolerancePercent) !== null) parts.push(`ask above a ${change.priceTolerancePercent}% price change`);
      return `${change.supplierName}: ${parts.join('; ')}.`;
    }
    case 'transfer_authority': return `Foundry may automatically transfer no more than ${change.maximumQuantity} units per action${change.locationName ? ` involving ${change.locationName}` : ''}; all safety checks still apply.`;
    case 'purchase_authority': return `Foundry may automatically approve routine replenishment orders from ${change.supplierName} up to $${change.maximumValue}; anything else still needs approval.`;
    case 'operating_preference': return change.preferTransferBeforePurchasing ? 'Try an internal transfer before buying more.' : `Aim for ${change.daysOfStock} days of stock.`;
    case 'hard_limits': return `Wait at least ${change.cooldownHours} hours before repeating automatic work on the same item.`;
    case 'stock_protection': {
      const scope = change.locationName ? ` at ${change.locationName}` : ' across this inventory';
      const boundary = operatingGuards.describeBoundary({
        comparator: change.guardComparator || 'below',
        threshold: change.guardThreshold,
      });
      if (change.guardMode === 'warn') {
        return `${subject}: warn when on-hand stock is ${boundary.blockedWhen}${scope}. Outgoing stock remains allowed.`;
      }
      const release = change.guardReleaseCondition === 'on_order'
        ? 'until a supplier order is placed'
        : change.guardReleaseCondition === 'stock_recovered'
          ? `until on-hand stock recovers to ${nonnegative(change.guardReleaseThreshold) ?? change.guardThreshold}`
          : 'until an owner changes the rule';
      return `${subject}: block outgoing sales/issues that would leave stock ${boundary.blockedWhen}${scope}, ${release}. `
        + boundary.permittedExplanation;
    }
    default: return 'Update this operating rule.';
  }
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id, workspaceId: row.workspace_id, createdByUserId: row.created_by_user_id,
    statedAs: row.stated_as, source: row.source || 'owner_instruction', summary: row.summary, changes: json(row.changes, []),
    resolvedChanges: json(row.resolved_changes, []), questions: json(row.questions, []),
    status: row.status, integrityHash: row.integrity_hash,
    appliedRecords: json(row.applied_records, []), approvedAt: row.approved_at,
    removedAt: row.removed_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function get(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM operating_instruction_proposals WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) throw new NotFoundError('That operating instruction is not in this inventory.');
  return hydrate(row);
}

/**
 * The control for the question currently shown to the owner.
 *
 * A finite structured field should be answered with its real supported values,
 * not an empty textbox. Open-ended identity, quantity, supplier and location
 * questions intentionally remain free text. This is derived from the pending
 * change and its first unresolved question, so release-condition buttons never
 * appear for an unrelated rule.
 */
function clarificationFor(proposal) {
  if (!proposal || proposal.status !== 'PENDING' || !proposal.questions.length) return null;
  const question = proposal.questions[0];
  const changeIndex = proposal.resolvedChanges.findIndex((change) =>
    change.domain === 'stock_protection'
      && change.operation === 'set'
      && !change.guardReleaseCondition
  );
  if (changeIndex >= 0 && /what should release the block/i.test(question)) {
    const change = proposal.resolvedChanges[changeIndex];
    const threshold = nonnegative(change.guardThreshold);
    return {
      question,
      kind: 'choice',
      field: 'guardReleaseCondition',
      changeIndex,
      choices: [
        {
          value: 'on_order',
          label: 'Supplier order placed',
          answerText: 'Release the block when a supplier order is placed.',
        },
        {
          value: 'stock_recovered',
          label: threshold === null ? 'Stock received' : `Stock is back to ${threshold}`,
          answerText: threshold === null
            ? 'Release the block when on-hand stock has recovered.'
            : `Release the block when on-hand stock has recovered to ${threshold}.`,
        },
        {
          value: 'manual',
          label: 'Owner releases it',
          answerText: 'Only an owner changing or removing the rule releases the block.',
        },
      ],
    };
  }
  return { question, kind: 'text', choices: [] };
}

function list(db, workspaceId, { status = null } = {}) {
  const clause = status ? ' AND status = ?' : '';
  return db.prepare(`SELECT * FROM operating_instruction_proposals WHERE workspace_id = ?${clause} ORDER BY created_at DESC, rowid DESC`)
    .all(workspaceId, ...(status ? [status] : [])).map(hydrate);
}

async function interpret(db, ctx, membership, instruction, options = {}) {
  const clean = String(instruction || '').trim().slice(0, 2000);
  if (!clean) throw new ValidationError('Tell Foundry how you want this inventory run.');
  // Connected installations always use the closed AI schema so supplier names,
  // wording and policy changes are not encoded as phrase lists. The narrow
  // compiler is retained only as an offline compatibility fallback.
  const offlineFallback = !options.provider && !config.ai.configured
    ? compileSupplierCommunication(clean) : null;
  if (!offlineFallback && !options.provider && !config.ai.configured) throw new ValidationError('Foundry needs its model connection to read that instruction.');
  const provider = offlineFallback ? null : options.provider || createProviderForTier('standard');
  const catalogue = db.prepare(
    `SELECT i.name, s.code, s.variant_label FROM skus s JOIN items i ON i.id = s.item_id
      WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1 ORDER BY i.name, s.position`
  ).all(ctx.workspaceId);
  const locationRows = db.prepare("SELECT name FROM locations WHERE workspace_id = ? AND is_active = 1 ORDER BY name").all(ctx.workspaceId);
  const supplierRows = suppliers.listSuppliers(db, ctx.workspaceId).map((s) => ({ name: s.name }));
  const response = offlineFallback ? { data: offlineFallback } : await provider.complete({
    system: SYSTEM,
    prompt: `Instruction:\n${clean}\n\nReal variants:\n${JSON.stringify(catalogue)}\n\nReal locations:\n${JSON.stringify(locationRows)}\n\nReal suppliers:\n${JSON.stringify(supplierRows)}`,
    schema: SCHEMA, schemaName: 'operating_instruction',
  });
  const checked = validate(toWireSchema(SCHEMA), response.data, { key: 'operating-instruction-wire' });
  const interpreted = checked.ok && checked.data.understood && checked.data.changes.length
    ? checked.data
    : compileStockProtection(clean);
  if (!interpreted) {
    throw new ValidationError(checked.data?.unsupportedReason || 'Foundry could not turn that into a safe operating rule.');
  }
  const resolved = interpreted.changes.map((change) => resolveChange(db, ctx.workspaceId, change, clean));
  const questions = [...new Set([interpreted.clarifyingQuestion, ...resolved.flatMap((r) => r.questions)].filter(Boolean))];
  const resolvedChanges = resolved.map((r) => r.change);
  const snapshot = { statedAs: clean, changes: interpreted.changes, resolvedChanges };
  const now = nowIso();
  const id = newId('oin');
  db.prepare(
    `INSERT INTO operating_instruction_proposals
       (id, workspace_id, created_by_user_id, stated_as, summary, changes, resolved_changes,
        questions, status, integrity_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`
  ).run(id, ctx.workspaceId, ctx.actorId, clean, interpreted.summary || 'Operating rule change',
    JSON.stringify(interpreted.changes), JSON.stringify(resolvedChanges), JSON.stringify(questions), hash(snapshot), now, now);
  return get(db, ctx.workspaceId, id);
}

/**
 * Start stock protection from the product answer alone.
 *
 * The setup UI has already established the domain. Re-asking a language model
 * to infer that domain from a one-word product such as "Snacks" is both less
 * reliable and less safe than checking the real catalogue here. Remaining
 * threshold/action/release details stay as explicit questions.
 */
function parseStockProtectionAnswer(value) {
  const text = String(value || '').trim();
  const warning = /\b(?:only\s+)?warn(?:\s+(?:me|us))?\b|\bnotify(?:\s+(?:me|us))?\b/i.test(text);
  const blocking = /\b(?:block|stop|prevent|refuse)\b/i.test(text);
  const structured = text.match(/^(.+?)\s*(?:,\s*|\s+)(?:at\s+(?:a\s+)?quantity\s+(?:of\s+)?|at\s+or\s+below\s+|at\s+|below\s+|under\s+)(\d+)\b/i)
    || text.match(/^(.+?)\s*,\s*(\d+)\b/i);
  let productText = structured?.[1]?.trim() || text;
  const threshold = structured ? Number(structured[2]) : -1;
  productText = productText
    .replace(/\s*(?:,|\s)\s*(?:only\s+)?(?:warn|notify)(?:\s+(?:me|us))?\s*$/i, '')
    .replace(/\s*(?:,|\s)\s*(?:block|stop|prevent|refuse)(?:\s+outgoing\s+stock)?\s*$/i, '')
    .trim();
  return { productText, threshold, guardMode: warning ? 'warn' : blocking ? 'block' : '' };
}

function proposeStockProtectionAnswer(db, ctx, membership, answer, statedAs) {
  const parsed = parseStockProtectionAnswer(answer);
  const cleanProduct = String(parsed.productText || '').trim().slice(0, 300);
  if (!cleanProduct) throw new ValidationError('Enter the product Foundry should protect.');
  const cleanStatement = String(statedAs || cleanProduct).trim().slice(0, 2000);
  const change = {
    ...emptyChange(), domain: 'stock_protection', itemText: cleanProduct,
    guardAction: 'issue', guardMode: parsed.guardMode,
    guardMetric: 'network_on_hand', guardComparator: parsed.guardMode === 'warn' ? 'at_or_below' : 'below',
    guardThreshold: parsed.threshold,
    guardReleaseCondition: parsed.guardMode === 'warn' ? 'stock_recovered' : '',
    guardReleaseThreshold: parsed.guardMode === 'warn' ? parsed.threshold : -1,
  };
  const resolved = resolveChange(db, ctx.workspaceId, change, cleanStatement);
  const changes = [change];
  const resolvedChanges = [resolved.change];
  const questions = [...new Set(resolved.questions.filter(Boolean))];
  const snapshot = { statedAs: cleanStatement, changes, resolvedChanges };
  const now = nowIso();
  const id = newId('oin');
  db.prepare(
    `INSERT INTO operating_instruction_proposals
       (id, workspace_id, created_by_user_id, stated_as, summary, changes, resolved_changes,
        questions, status, integrity_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`
  ).run(
    id, ctx.workspaceId, ctx.actorId, cleanStatement,
    parsed.guardMode === 'warn' ? `Warn when ${cleanProduct} is low` : `Protect ${cleanProduct} from low stock`,
    JSON.stringify(changes), JSON.stringify(resolvedChanges), JSON.stringify(questions),
    hash(snapshot), now, now
  );
  return get(db, ctx.workspaceId, id);
}

function proposeStockProtectionProduct(db, ctx, membership, productText, statedAs) {
  return proposeStockProtectionAnswer(db, ctx, membership, productText, statedAs);
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function applyChange(db, ctx, membership, change) {
  if (change.domain === 'replenishment') {
    if (change.operation === 'remove') {
      reorderPolicies.clearPolicy(db, ctx, membership, change.skuId);
      return { kind: 'reorder_policy', skuId: change.skuId, removed: true };
    }
    const result = reorderPolicies.setPolicy(db, ctx, membership, change.skuId, compact({
      reorderPoint: nonnegative(change.reorderPoint) ?? undefined,
      targetStock: nonnegative(change.targetStock) ?? undefined,
      safetyStock: nonnegative(change.safetyStock) ?? undefined,
      leadTimeDays: nonnegative(change.leadTimeDays) ?? undefined,
      source: 'foundry', notes: `Taught through Tell Foundry: ${change.displayName}`,
    }));
    return { kind: 'reorder_policy', id: result.id, skuId: change.skuId };
  }
  if (change.domain === 'location_stock') {
    const result = reorderPolicies.setLocationPolicy(db, ctx, membership, change.skuId, change.locationId, {
      minimum: change.operation === 'remove' ? null : nonnegative(change.locationMinimum),
      target: change.operation === 'remove' ? null : nonnegative(change.locationTarget),
      source: 'foundry',
    });
    return { kind: 'location_policy', skuId: change.skuId, locationId: change.locationId, ...result };
  }
  if (change.domain === 'supplier_assignment' || change.domain === 'supplier_terms') {
    if (change.operation === 'remove') {
      const linked = suppliers.suppliersForSku(db, ctx.workspaceId, change.skuId, { includeInactive: true })
        .find((row) => row.supplierId === change.supplierId);
      if (linked) suppliers.unlinkItem(db, ctx, membership, linked.id);
      return { kind: 'supplier_item', supplierId: change.supplierId, skuId: change.skuId, removed: true };
    }
    const current = suppliers.suppliersForSku(db, ctx.workspaceId, change.skuId, { includeInactive: true })
      .find((row) => row.supplierId === change.supplierId);
    const linked = suppliers.linkItem(db, ctx, membership, compact({
      supplierId: change.supplierId, skuId: change.skuId,
      supplierSku: current?.supplierSku, lastUnitCost: current?.lastUnitCost,
      purchaseUnit: change.purchaseUnit || current?.purchaseUnit || 'unit',
      unitsPerPurchaseUnit: positive(change.unitsPerPurchaseUnit) || current?.unitsPerPurchaseUnit || 1,
      leadTimeDays: nonnegative(change.leadTimeDays) ?? current?.leadTimeDays,
      minimumOrderQuantity: nonnegative(change.minimumOrderQuantity) ?? current?.minimumOrderQuantity,
      orderMultiple: positive(change.orderMultiple) || current?.orderMultiple,
      isPreferred: change.domain === 'supplier_assignment' ? true : (current?.isPreferred || false), isActive: true,
      notes: change.orderingMethod || current?.notes,
    }));
    if (change.contactName || change.email || change.leadTimeDays >= 0) {
      suppliers.updateSupplier(db, ctx, membership, change.supplierId, compact({
        contactName: change.contactName || undefined, email: change.email || undefined,
        defaultLeadTimeDays: nonnegative(change.leadTimeDays) ?? undefined,
      }));
    }
    if (change.domain === 'supplier_assignment') {
      reorderPolicies.setPolicy(db, ctx, membership, change.skuId, { preferredSupplierId: change.supplierId, source: 'foundry' });
    }
    return { kind: 'supplier_item', id: linked.id, supplierId: change.supplierId, skuId: change.skuId };
  }
  if (change.domain === 'supplier_communication') {
    if (change.operation === 'remove') {
      const targeted = change.autoSendEnabled || change.prepareCommunications || change.watchSupplier;
      const updates = compact({
        autoSendEnabled: !targeted || change.autoSendEnabled ? false : undefined,
        prepareCommunications: !targeted || change.prepareCommunications ? false : undefined,
        watchedConnectorId: !targeted || change.watchSupplier ? null : undefined,
      });
      suppliers.updateSupplier(db, ctx, membership, change.supplierId, updates);
      if (!targeted || change.watchSupplier) {
        db.prepare(`UPDATE connection_email_rules SET is_active = 0, updated_at = ?
          WHERE workspace_id = ? AND supplier_id = ? AND is_active = 1`)
          .run(nowIso(), ctx.workspaceId, change.supplierId);
      }
      return { kind: 'supplier_communication', supplierId: change.supplierId, removed: true,
        capability: change.autoSendEnabled ? 'automatic_sending'
          : change.prepareCommunications ? 'preparation'
            : change.watchSupplier ? 'mailbox_watching' : 'all' };
    }
    const updated = suppliers.updateSupplier(db, ctx, membership, change.supplierId, compact({
      watchedConnectorId: change.connectorId || undefined,
      prepareCommunications: change.prepareCommunications ? true : undefined,
      autoSendEnabled: change.autoSendEnabled ? true : undefined,
      autoSendLimit: positive(change.autoSendLimit) ?? undefined,
      priceTolerancePercent: nonnegative(change.priceTolerancePercent) ?? undefined,
      quantityTolerancePercent: nonnegative(change.quantityTolerancePercent) ?? undefined,
    }));
    if (change.watchSupplier && change.connectorId) {
      const sender = change.trustedSender || updated.email;
      if (!sender) throw new ValidationError(`${updated.name} needs an ordering email before Foundry can watch it.`);
      require('../connections/service').addEmailRule(db, ctx, change.connectorId, {
        senderPattern: sender, supplierId: updated.id, documentMode: 'supplier_documents',
      });
    }
    return { kind: 'supplier_communication', supplierId: updated.id, connectorId: change.connectorId || null };
  }
  if (change.domain === 'transfer_authority' || change.domain === 'purchase_authority') {
    const transfer = change.domain === 'transfer_authority';
    const actionType = transfer ? 'transfer' : 'approve_purchase_order';
    const matchesScope = (policy) => policy.allowedActionTypes.includes(actionType)
      && (!change.supplierId || policy.supplierScope.includes(change.supplierId))
      && (!change.itemId || policy.itemScope.includes(change.itemId))
      && (!change.locationId || policy.locationScope.includes(change.locationId));
    if (change.operation === 'remove') {
      for (const policy of automationPolicies.list(db, ctx.workspaceId, { activeOnly: true })) {
        if (matchesScope(policy)) automationPolicies.disable(db, ctx, membership, policy.id, 'Removed through Tell Foundry');
      }
      return { kind: 'automation_policy', removed: true, domain: change.domain };
    }
    const conditions = transfer
      ? [automationPolicies.CONDITIONS.DESTINATION_STOCKOUT_RISK, automationPolicies.CONDITIONS.SOURCE_ABOVE_SAFETY,
          automationPolicies.CONDITIONS.NO_CONFLICTING_TRANSFER, automationPolicies.CONDITIONS.SUFFICIENT_HISTORY]
      : [automationPolicies.CONDITIONS.REPLENISHMENT_EVIDENCE, automationPolicies.CONDITIONS.MOQ_ORDER_MULTIPLE_COMPLIANT,
          automationPolicies.CONDITIONS.NO_DUPLICATE_INCOMING_DEMAND, automationPolicies.CONDITIONS.PRICE_WITHIN_POLICY];
    const definition = {
      name: transfer ? 'Taught automatic transfers' : `Taught purchasing limit — ${change.supplierName}`,
      description: 'Approved through Tell Foundry.',
      allowedActionTypes: [transfer ? 'transfer' : 'approve_purchase_order'],
      scope: { managedBy: 'tell_foundry' },
      itemScope: change.itemId ? [change.itemId] : [],
      locationScope: [change.sourceLocationId, change.locationId].filter(Boolean),
      supplierScope: change.supplierId ? [change.supplierId] : [], conditions,
      maximumQuantity: transfer ? change.maximumQuantity : null,
      maximumValue: transfer ? null : change.maximumValue,
      thresholds: transfer ? {} : { maxUnitPriceChangePercent: 0 },
    };
    const previous = automationPolicies.list(db, ctx.workspaceId, { activeOnly: true })
      .find((policy) => policy.scope?.managedBy === 'tell_foundry' && matchesScope(policy));
    const proposal = previous
      ? automationPolicies.revise(db, ctx, membership, previous.id, definition)
      : automationPolicies.propose(db, ctx, membership, definition);
    const approved = automationPolicies.approve(db, ctx, membership, proposal.id, { expectedHash: proposal.integrityHash });
    // The owner explicitly authorised automatic work in this instruction. The
    // mode switch is the same persisted mode used by Automatic work; every
    // other active policy was already separately approved.
    modes.setMode(db, ctx, membership, modes.MODES.POLICY_AUTOMATED);
    return { kind: 'automation_policy', id: approved.id, version: approved.version };
  }
  if (change.domain === 'operating_preference') {
    if (change.operation === 'remove') {
      const key = change.daysOfStock >= 0 ? preferences.KEYS.TARGET_DAYS_OF_STOCK.key : preferences.KEYS.PREFER_TRANSFER_BEFORE_PURCHASING.key;
      preferences.clear(db, ctx, membership, key); return { kind: 'preference', key, removed: true };
    }
    const def = change.daysOfStock >= 0 ? preferences.KEYS.TARGET_DAYS_OF_STOCK : preferences.KEYS.PREFER_TRANSFER_BEFORE_PURCHASING;
    const value = change.daysOfStock >= 0 ? change.daysOfStock : change.preferTransferBeforePurchasing;
    preferences.set(db, ctx, membership, { key: def.key, value, source: 'instruction', statedAs: change.statedAs });
    return { kind: 'preference', key: def.key };
  }
  if (change.domain === 'hard_limits') {
    if (change.operation === 'remove') throw new ValidationError('Set a replacement cooldown in Automatic work rather than removing the hard safety limit.');
    const current = modes.limits(db, ctx.workspaceId);
    modes.setLimits(db, ctx, membership, { ...current, cooldownHours: change.cooldownHours });
    return { kind: 'hard_limits', cooldownHours: change.cooldownHours };
  }
  if (change.domain === 'stock_protection') {
    if (change.operation === 'remove') {
      const rows = operatingGuards.list(db, ctx.workspaceId, { activeOnly: true, skuId: change.skuId })
        .filter((row) => !change.locationId || row.locationId === change.locationId);
      for (const row of rows) operatingGuards.disable(db, ctx, membership, row.id);
      return { kind: 'stock_guard', skuId: change.skuId, locationId: change.locationId || null, removed: true };
    }
    const guard = operatingGuards.set(db, ctx, membership, {
      skuId: change.skuId, locationId: change.locationId || null,
      actionType: change.guardAction,
      enforcementMode: change.guardMode || 'block',
      metric: change.locationId ? 'location_on_hand' : (change.guardMetric || 'network_on_hand'),
      comparator: change.guardComparator || 'below', threshold: change.guardThreshold,
      releaseCondition: change.guardReleaseCondition,
      releaseThreshold: nonnegative(change.guardReleaseThreshold) ?? change.guardThreshold,
      source: 'foundry', statedAs: change.statedAs,
    });
    return { kind: 'stock_guard', id: guard.id, skuId: guard.skuId, locationId: guard.locationId };
  }
  throw new ValidationError('Foundry does not have a structured setting for that instruction.');
}

function approve(db, ctx, membership, id, expectedHash) {
  const proposal = get(db, ctx.workspaceId, id);
  if (proposal.status === 'APPROVED') return proposal;
  if (proposal.status !== 'PENDING') throw new ValidationError('That instruction is no longer waiting for approval.');
  if (proposal.questions.length) throw new ValidationError(proposal.questions[0]);
  if (expectedHash && expectedHash !== proposal.integrityHash) throw new ValidationError('This instruction changed since you reviewed it. Open it again before approving.');
  const applied = [];
  db.transaction(() => {
    for (const change of proposal.resolvedChanges) applied.push(applyChange(db, ctx, membership, { ...change, statedAs: proposal.statedAs }));
    const targetKey = (change) => {
      if (change.domain === 'replenishment') return `replenishment:${change.skuId}`;
      if (change.domain === 'location_stock') return `location:${change.skuId}:${change.locationId}`;
      if (['supplier_assignment', 'supplier_terms'].includes(change.domain)) return `supplier:${change.supplierId}:${change.skuId}`;
      if (change.domain === 'supplier_communication') return `supplier-communication:${change.supplierId}`;
      if (change.domain === 'purchase_authority') return `purchase-authority:${change.supplierId || '*'}`;
      if (change.domain === 'transfer_authority') return `transfer-authority:${change.sourceLocationId || '*'}:${change.locationId || '*'}`;
      if (change.domain === 'operating_preference') return `preference:${change.daysOfStock >= 0 ? 'days' : 'transfer-first'}`;
      if (change.domain === 'hard_limits') return 'hard-limits:cooldown';
      if (change.domain === 'stock_protection') return `stock-guard:${change.skuId}:${change.locationId || '*'}:${change.guardAction}`;
      return null;
    };
    const replaced = new Set(proposal.resolvedChanges.map(targetKey).filter(Boolean));
    for (const previous of list(db, ctx.workspaceId, { status: 'APPROVED' })) {
      if (previous.id === proposal.id) continue;
      if (previous.resolvedChanges.some((change) => replaced.has(targetKey(change)))) {
        db.prepare("UPDATE operating_instruction_proposals SET status = 'SUPERSEDED', updated_at = ? WHERE id = ? AND workspace_id = ?")
          .run(nowIso(), previous.id, ctx.workspaceId);
      }
    }
    const now = nowIso();
    db.prepare(`UPDATE operating_instruction_proposals SET status = 'APPROVED', applied_records = ?, approved_by_user_id = ?, approved_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(JSON.stringify(applied), ctx.actorId, now, now, id, ctx.workspaceId);
  }).immediate();
  for (const record of applied) {
    const type = record.kind === 'automation_policy' ? managerEvents.TYPES.AUTHORITY_UPDATED
      : ['supplier_item', 'supplier_communication'].includes(record.kind) ? managerEvents.TYPES.SUPPLIER_UPDATED
        : managerEvents.TYPES.REORDER_POLICY_UPDATED;
    reactions.publishAndReact(db, ctx.workspaceId, type, { instructionId: id, ...record }, { idempotencyKey: `${type}:instruction:${id}:${record.kind}:${record.id || record.skuId || record.key || 'workspace'}` });
  }
  return get(db, ctx.workspaceId, id);
}

function cancel(db, ctx, id) {
  const proposal = get(db, ctx.workspaceId, id);
  if (proposal.status !== 'PENDING') return proposal;
  db.prepare("UPDATE operating_instruction_proposals SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND workspace_id = ?")
    .run(nowIso(), id, ctx.workspaceId);
  return get(db, ctx.workspaceId, id);
}

async function answer(db, ctx, membership, id, value, options = {}) {
  const proposal = get(db, ctx.workspaceId, id);
  if (proposal.status !== 'PENDING' || !proposal.questions.length) {
    throw new ValidationError('That instruction is not waiting for an answer.');
  }
  const clean = String(value || '').trim().slice(0, 500);
  if (!clean) throw new ValidationError('Enter the missing detail so Foundry can continue the same instruction.');
  const clarification = clarificationFor(proposal);
  const selected = clarification && clarification.kind === 'choice'
    ? clarification.choices.find((choice) => choice.value === clean)
    : null;
  if (selected && clarification.field === 'guardReleaseCondition') {
    const changes = proposal.changes.map((change, index) => index === clarification.changeIndex
      ? {
          ...change,
          guardReleaseCondition: selected.value,
          guardReleaseThreshold: selected.value === 'stock_recovered'
            ? (nonnegative(change.guardThreshold) ?? -1)
            : -1,
        }
      : change);
    const statedAs = `${proposal.statedAs}\nClarification: ${selected.answerText}`;
    const resolved = changes.map((change) => resolveChange(db, ctx.workspaceId, change, statedAs));
    const questions = [...new Set(resolved.flatMap((entry) => entry.questions).filter(Boolean))];
    const resolvedChanges = resolved.map((entry) => entry.change);
    const snapshot = { statedAs, changes, resolvedChanges };
    const now = nowIso();
    const continuedId = newId('oin');
    db.prepare(
      `INSERT INTO operating_instruction_proposals
         (id, workspace_id, created_by_user_id, stated_as, summary, changes, resolved_changes,
          questions, status, integrity_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`
    ).run(
      continuedId, ctx.workspaceId, ctx.actorId, statedAs, proposal.summary,
      JSON.stringify(changes), JSON.stringify(resolvedChanges), JSON.stringify(questions),
      hash(snapshot), now, now
    );
    db.prepare("UPDATE operating_instruction_proposals SET status = 'SUPERSEDED', updated_at = ? WHERE id = ? AND workspace_id = ?")
      .run(now, proposal.id, ctx.workspaceId);
    return get(db, ctx.workspaceId, continuedId);
  }
  const continued = await interpret(db, ctx, membership,
    `${proposal.statedAs}\nClarification: ${clean}`, options);
  db.prepare("UPDATE operating_instruction_proposals SET status = 'SUPERSEDED', updated_at = ? WHERE id = ? AND workspace_id = ?")
    .run(nowIso(), proposal.id, ctx.workspaceId);
  return continued;
}

/**
 * Continue a pending rule with a catalogue record selected by the owner.
 * This path is deliberately model-free: the browser posts a SKU id, it is
 * workspace-scoped here, and the original structured change is re-resolved.
 */
function selectProduct(db, ctx, membership, id, skuId) {
  const proposal = get(db, ctx.workspaceId, id);
  if (proposal.status !== 'PENDING' || !proposal.questions.length) {
    throw new ValidationError('That instruction is not waiting for a product.');
  }
  const sku = db.prepare(
    `SELECT s.id, s.code, s.variant_label, i.name AS item_name
       FROM skus s JOIN items i ON i.id = s.item_id AND i.workspace_id = s.workspace_id
      WHERE s.workspace_id = ? AND s.id = ? AND s.is_active = 1 AND i.is_active = 1`
  ).get(ctx.workspaceId, skuId);
  if (!sku) throw new ValidationError('Choose a product from this inventory.');

  let replaced = false;
  const changes = proposal.changes.map((change, index) => {
    if (replaced || !needsSku(change.domain) || proposal.resolvedChanges[index]?.skuId) return change;
    replaced = true;
    return { ...change, itemText: sku.item_name, variantText: sku.variant_label || '' };
  });
  if (!replaced) throw new ValidationError('That instruction is not waiting for a product.');

  const statedAs = `${proposal.statedAs}\nProduct selected: ${sku.item_name}${sku.variant_label ? ` — ${sku.variant_label}` : ''}`;
  const resolved = changes.map((change) => resolveChange(db, ctx.workspaceId, change, statedAs));
  const questions = [...new Set(resolved.flatMap((entry) => entry.questions).filter(Boolean))];
  const resolvedChanges = resolved.map((entry) => entry.change);
  const snapshot = { statedAs, changes, resolvedChanges };
  const now = nowIso();
  const continuedId = newId('oin');
  db.prepare(
    `INSERT INTO operating_instruction_proposals
       (id, workspace_id, created_by_user_id, stated_as, summary, changes, resolved_changes,
        questions, status, integrity_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`
  ).run(
    continuedId, ctx.workspaceId, ctx.actorId, statedAs, proposal.summary,
    JSON.stringify(changes), JSON.stringify(resolvedChanges), JSON.stringify(questions),
    hash(snapshot), now, now
  );
  db.prepare("UPDATE operating_instruction_proposals SET status = 'SUPERSEDED', updated_at = ? WHERE id = ? AND workspace_id = ?")
    .run(now, proposal.id, ctx.workspaceId);
  return get(db, ctx.workspaceId, continuedId);
}

function remove(db, ctx, membership, id) {
  const proposal = get(db, ctx.workspaceId, id);
  if (proposal.status !== 'APPROVED') throw new ValidationError('Only an active learned instruction can be removed.');
  for (const record of proposal.appliedRecords) {
    if (record.kind === 'automation_policy' && record.id) automationPolicies.disable(db, ctx, membership, record.id, 'Removed from learned instructions');
    else if (record.kind === 'reorder_policy' && record.skuId) reorderPolicies.clearPolicy(db, ctx, membership, record.skuId);
    else if (record.kind === 'location_policy') reorderPolicies.setLocationPolicy(db, ctx, membership, record.skuId, record.locationId, { minimum: null, target: null });
    else if (record.kind === 'supplier_item' && record.id) suppliers.unlinkItem(db, ctx, membership, record.id);
    else if (record.kind === 'preference' && record.key) preferences.clear(db, ctx, membership, record.key);
    else if (record.kind === 'stock_guard' && record.id) operatingGuards.disable(db, ctx, membership, record.id);
  }
  const now = nowIso();
  db.prepare("UPDATE operating_instruction_proposals SET status = 'REMOVED', removed_by_user_id = ?, removed_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
    .run(ctx.actorId, now, now, id, ctx.workspaceId);
  return get(db, ctx.workspaceId, id);
}

/**
 * Repeated approval may earn a suggestion, never authority. The suggested
 * ceiling is the largest action the owner actually approved; no broader value
 * is inferred. The resulting row follows the normal review/approve path.
 */
function suggestFromRepeatedApproval(db, ctx, item) {
  if (!item || !item.approvedByUserId) return null;
  const action = item.recommendedAction || {};
  const purchasing = ['purchase_preparation', 'replenishment_plan'].includes(item.category)
    && action.supplierId && Number(action.value || action.subtotal) > 0;
  const transfer = item.category === 'balance_transfer' && Number(action.quantity) > 0;
  if (!purchasing && !transfer) return null;
  const rows = db.prepare(
    `SELECT recommended_action FROM work_items
      WHERE workspace_id = ? AND category = ? AND approved_by_user_id IS NOT NULL
      ORDER BY approved_at DESC LIMIT 20`
  ).all(ctx.workspaceId, item.category).map((row) => json(row.recommended_action, {}));
  const comparable = rows.filter((entry) => purchasing
    ? entry.supplierId === action.supplierId && Number(entry.value || entry.subtotal) > 0
    : entry.fromLocationId === action.fromLocationId && entry.toLocationId === action.toLocationId && Number(entry.quantity) > 0);
  if (comparable.length < 3) return null;
  const signature = purchasing ? `purchase:${action.supplierId}` : `transfer:${action.fromLocationId}:${action.toLocationId}`;
  const existing = db.prepare(
    `SELECT id FROM operating_instruction_proposals WHERE workspace_id = ? AND source = 'repeated_approval_suggestion'
      AND stated_as = ? AND status IN ('PENDING','APPROVED') LIMIT 1`
  ).get(ctx.workspaceId, signature);
  if (existing) return get(db, ctx.workspaceId, existing.id);

  const base = {
    operation: 'set', itemText: '', variantText: '', locationText: '', sourceLocationText: '', supplierText: '',
    reorderPoint: -1, targetStock: -1, safetyStock: -1, locationMinimum: -1, locationTarget: -1,
    leadTimeDays: -1, unitsPerPurchaseUnit: -1, minimumOrderQuantity: -1, orderMultiple: -1,
    maximumQuantity: -1, maximumValue: -1, cooldownHours: -1, daysOfStock: -1,
    purchaseUnit: '', contactName: '', email: '', orderingMethod: '',
    preferTransferBeforePurchasing: false, approvalRequired: true,
    guardAction: '', guardMetric: '', guardComparator: '', guardThreshold: -1,
    guardReleaseCondition: '', guardReleaseThreshold: -1,
  };
  let change;
  let summary;
  if (purchasing) {
    let supplier = null;
    try { supplier = suppliers.getSupplier(db, ctx.workspaceId, action.supplierId); } catch { /* stale supplier */ }
    const maximumValue = Math.max(...comparable.map((entry) => Number(entry.value || entry.subtotal)));
    change = { ...base, domain: 'purchase_authority', supplierId: action.supplierId,
      supplierName: supplier?.name || action.supplierName || 'this supplier', maximumValue };
    summary = `Suggestion: handle similar ${change.supplierName} orders up to $${maximumValue} automatically?`;
  } else {
    const maximumQuantity = Math.max(...comparable.map((entry) => Number(entry.quantity)));
    change = { ...base, domain: 'transfer_authority', maximumQuantity,
      sourceLocationId: action.fromLocationId, sourceLocationName: action.fromLocationName,
      locationId: action.toLocationId, locationName: action.toLocationName };
    summary = `Suggestion: handle similar transfers up to ${maximumQuantity} units automatically?`;
  }
  const id = newId('oin'); const now = nowIso();
  const snapshot = { statedAs: signature, changes: [change], resolvedChanges: [change] };
  db.prepare(
    `INSERT INTO operating_instruction_proposals
       (id, workspace_id, created_by_user_id, stated_as, source, summary, changes, resolved_changes,
        questions, status, integrity_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'repeated_approval_suggestion', ?, ?, ?, '[]', 'PENDING', ?, ?, ?)`
  ).run(id, ctx.workspaceId, ctx.actorId, signature, summary, JSON.stringify([change]), JSON.stringify([change]), hash(snapshot), now, now);
  return get(db, ctx.workspaceId, id);
}

module.exports = { DOMAINS, CHANGE_SCHEMA, SCHEMA, SYSTEM, interpret, proposeStockProtectionAnswer, proposeStockProtectionProduct, resolveChange, describe, clarificationFor, get, list, approve, cancel, answer, selectProduct, remove, suggestFromRepeatedApproval };

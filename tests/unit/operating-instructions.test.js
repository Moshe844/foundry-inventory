'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const authService = require('../../src/domain/auth-service');
const operating = require('../../src/manager/operating-instructions');
const reorderPolicies = require('../../src/purchasing/policy-service');
const supplierService = require('../../src/purchasing/supplier-service');
const communications = require('../../src/purchasing/supplier-communications');
const poService = require('../../src/purchasing/po-service');
const automationPolicies = require('../../src/autopilot/policy-service');
const modes = require('../../src/autopilot/modes');
const workItems = require('../../src/autopilot/work-items');
const runner = require('../../src/autopilot/runner');
const inventory = require('../../src/domain/inventory-engine');
const operatingGuards = require('../../src/domain/operating-guards');
const attention = require('../../src/attention/attention-engine');
const needsYou = require('../../src/manager/needs-you-inbox');
const { makeDatabase, cleanupAll, seedWorkspace, makeVariantItem } = require('../helpers');
const { seedAuthorityWorkspace, balanceAt } = require('../helpers/autopilot-authority-fixture');

test.after(cleanupAll);

const provider = (data) => ({ complete: async () => ({ data }) });
const blank = () => ({
  operation: 'set', itemText: '', variantText: '', locationText: '', sourceLocationText: '', supplierText: '',
  reorderPoint: -1, targetStock: -1, safetyStock: -1, locationMinimum: -1, locationTarget: -1,
  leadTimeDays: -1, unitsPerPurchaseUnit: -1, minimumOrderQuantity: -1, orderMultiple: -1,
  maximumQuantity: -1, maximumValue: -1, cooldownHours: -1, daysOfStock: -1,
  purchaseUnit: '', contactName: '', email: '', orderingMethod: '',
  preferTransferBeforePurchasing: false, approvalRequired: true,
  guardAction: '', guardMode: '', guardMetric: '', guardComparator: '', guardThreshold: -1,
  guardReleaseCondition: '', guardReleaseThreshold: -1,
});
const read = (changes, summary = 'Operating rule') => ({ understood: true, summary, changes, clarifyingQuestion: '', unsupportedReason: '' });

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Teach Once Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeVariantItem(db, workspace.ctx, {
    name: 'Everyday Shirt', baseCode: 'SHIRT',
    options: [{ name: 'Colour', values: 'Black, White' }, { name: 'Size', values: 'Small, Large' }],
  });
  const blackSmall = item.skus.find((sku) => /Black.*Small/.test(sku.variant_label));
  return { db, workspace, membership, item, blackSmall, ctx: workspace.ctx };
}

test('an arbitrary plain-language replenishment instruction previews, then updates the real reorder policy', async () => {
  const env = setup();
  const proposal = await operating.interpret(env.db, env.ctx, env.membership,
    'For the small black shirt, start replenishing at forty seven and restore the network to seventy three.', {
      provider: provider(read([{ ...blank(), domain: 'replenishment', itemText: 'Everyday Shirt', variantText: 'Black Small', reorderPoint: 47, targetStock: 73 }], 'Black Small replenishment')),
    });

  assert.equal(reorderPolicies.effectivePolicy(env.db, env.workspace.workspaceId, env.blackSmall.id).isSet, false, 'preview is inert');
  const approved = operating.approve(env.db, env.ctx, env.membership, proposal.id, proposal.integrityHash);
  const actual = reorderPolicies.effectivePolicy(env.db, env.workspace.workspaceId, env.blackSmall.id);
  assert.equal(approved.status, 'APPROVED');
  assert.equal(actual.reorderPoint, 47);
  assert.equal(actual.targetStock, 73);
  assert.equal(actual.source, 'foundry');
});

test('changing a taught rule updates the same structured setting instead of creating an AI-only rule', async () => {
  const env = setup();
  reorderPolicies.setPolicy(env.db, env.ctx, env.membership, env.blackSmall.id, { reorderPoint: 40, targetStock: 70 });
  const proposal = await operating.interpret(env.db, env.ctx, env.membership, 'Raise its trigger to 52.', {
    provider: provider(read([{ ...blank(), domain: 'replenishment', itemText: 'Everyday Shirt', variantText: 'Black Small', reorderPoint: 52 }], 'Change trigger')),
  });
  operating.approve(env.db, env.ctx, env.membership, proposal.id, proposal.integrityHash);
  const rows = env.db.prepare('SELECT * FROM reorder_policies WHERE workspace_id = ? AND sku_id = ? AND location_id IS NULL').all(env.workspace.workspaceId, env.blackSmall.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reorder_point, 52);
  assert.equal(rows[0].target_stock, 70, 'unspecified fields survive the conversational edit');
});

test('location trigger and target persist in the real location policy row', async () => {
  const env = setup();
  const proposal = await operating.interpret(env.db, env.ctx, env.membership, 'Keep the shop above 11 and restore it to 24.', {
    provider: provider(read([{ ...blank(), domain: 'location_stock', itemText: 'Everyday Shirt', variantText: 'Black Small', locationText: 'Downtown Store', locationMinimum: 11, locationTarget: 24 }], 'Downtown floor')),
  });
  operating.approve(env.db, env.ctx, env.membership, proposal.id, proposal.integrityHash);
  assert.deepEqual(reorderPolicies.locationPolicies(env.db, env.workspace.workspaceId, env.blackSmall.id)
    .map(({ minimum, target, locationName }) => ({ minimum, target, locationName })),
  [{ minimum: 11, target: 24, locationName: 'Downtown Store' }]);
});

test('supplier assignment and purchasing terms use the existing supplier-item relationship', async () => {
  const env = setup();
  const supplier = supplierService.createSupplier(env.db, env.ctx, env.membership, { name: 'Northstar Textiles' });
  const proposal = await operating.interpret(env.db, env.ctx, env.membership, 'Use Northstar for the Black Small line in cases of 6, minimum 4 cases, 9 day lead time.', {
    provider: provider(read([
      { ...blank(), domain: 'supplier_assignment', itemText: 'Everyday Shirt', variantText: 'Black Small', supplierText: 'Northstar Textiles' },
      { ...blank(), domain: 'supplier_terms', itemText: 'Everyday Shirt', variantText: 'Black Small', supplierText: 'Northstar Textiles', purchaseUnit: 'case', unitsPerPurchaseUnit: 6, minimumOrderQuantity: 4, leadTimeDays: 9 },
    ], 'Northstar terms')),
  });
  operating.approve(env.db, env.ctx, env.membership, proposal.id, proposal.integrityHash);
  const linked = supplierService.suppliersForSku(env.db, env.workspace.workspaceId, env.blackSmall.id)[0];
  assert.equal(linked.supplierId, supplier.id);
  assert.equal(linked.isPreferred, true);
  assert.equal(linked.purchaseUnit, 'case');
  assert.equal(linked.unitsPerPurchaseUnit, 6);
  assert.equal(linked.minimumOrderQuantity, 4);
  assert.equal(linked.leadTimeDays, 9);
});

test('stopping automatic supplier email removes only that authority', async () => {
  const env = setup();
  const supplier = supplierService.createSupplier(env.db, env.ctx, env.membership, {
    name: 'Northstar Textiles', email: 'orders@northstar.test', prepareCommunications: true,
    autoSendEnabled: true, autoSendLimit: 500,
  });
  const proposal = await operating.interpret(env.db, env.ctx, env.membership,
    'Stop automatically sending orders to Northstar Textiles.', {
      provider: provider(read([{ ...blank(), domain: 'supplier_communication', operation: 'remove',
        supplierText: 'Northstar Textiles', prepareCommunications: false,
        autoSendEnabled: true, autoSendLimit: -1, priceTolerancePercent: -1,
        quantityTolerancePercent: -1, watchSupplier: false, trustedSender: '' }], 'Stop automatic sending')),
    });
  assert.match(operating.describe(proposal.resolvedChanges[0]), /keep its other communication settings/i);
  operating.approve(env.db, env.ctx, env.membership, proposal.id, proposal.integrityHash);
  const updated = supplierService.getSupplier(env.db, env.workspace.workspaceId, supplier.id);
  assert.equal(updated.autoSendEnabled, false);
  assert.equal(updated.prepareCommunications, true);
  assert.equal(updated.autoSendLimitMinor, 50000, 'the remembered limit remains available if authority is restored');
});

test('authority sentences create approved, versioned policies only after proposal approval', async () => {
  const env = setup();
  const supplier = supplierService.createSupplier(env.db, env.ctx, env.membership, { name: 'Northstar Textiles' });
  const proposal = await operating.interpret(env.db, env.ctx, env.membership, 'Handle eligible Northstar orders up to 425 dollars.', {
    provider: provider(read([{ ...blank(), domain: 'purchase_authority', supplierText: 'Northstar Textiles', maximumValue: 425 }], 'Northstar authority')),
  });
  assert.equal(automationPolicies.list(env.db, env.workspace.workspaceId).length, 0);
  operating.approve(env.db, env.ctx, env.membership, proposal.id, proposal.integrityHash);
  const [policy] = automationPolicies.list(env.db, env.workspace.workspaceId, { activeOnly: true });
  assert.equal(policy.maximumValue, 425);
  assert.deepEqual(policy.supplierScope, [supplier.id]);
  assert.deepEqual(policy.allowedActionTypes, ['approve_purchase_order']);
});

test('removing a learned instruction in Settings removes its underlying rule', async () => {
  const env = setup();
  const proposal = await operating.interpret(env.db, env.ctx, env.membership, 'At 31, restore Black Small to 66.', {
    provider: provider(read([{ ...blank(), domain: 'replenishment', itemText: 'Everyday Shirt', variantText: 'Black Small', reorderPoint: 31, targetStock: 66 }], 'Stock rule')),
  });
  operating.approve(env.db, env.ctx, env.membership, proposal.id, proposal.integrityHash);
  operating.remove(env.db, env.ctx, env.membership, proposal.id);
  assert.equal(reorderPolicies.effectivePolicy(env.db, env.workspace.workspaceId, env.blackSmall.id).isSet, false);
  assert.equal(operating.get(env.db, env.workspace.workspaceId, proposal.id).status, 'REMOVED');
});

test('a generic stock-protection instruction blocks outgoing stock until a supplier order is placed', async () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, {
    skuId: env.blackSmall.id, locationId: env.workspace.main.id, quantity: 12, reasonCode: 'purchase',
  });
  const proposal = await operating.interpret(env.db, env.ctx, env.membership,
    'Protect this variant from outgoing orders once stock is under the floor; release it after replenishment is ordered.', {
      provider: provider(read([{ ...blank(), domain: 'stock_protection', itemText: 'Everyday Shirt',
        variantText: 'Black Small', guardAction: 'issue', guardMode: 'block', guardMetric: 'network_on_hand',
        guardComparator: 'below', guardThreshold: 10, guardReleaseCondition: 'on_order' }], 'Protect Black Small sales')),
    });
  assert.equal(operatingGuards.list(env.db, env.workspace.workspaceId, { activeOnly: true }).length, 0, 'the preview grants nothing');
  operating.approve(env.db, env.ctx, env.membership, proposal.id, proposal.integrityHash);
  const [rule] = operatingGuards.list(env.db, env.workspace.workspaceId, { activeOnly: true });
  assert.equal(rule.threshold, 10);
  assert.equal(rule.releaseCondition, 'on_order');

  inventory.issue(env.db, env.ctx, {
    skuId: env.blackSmall.id, locationId: env.workspace.main.id, quantity: 2, reasonCode: 'sold',
  });
  assert.throws(() => inventory.issue(env.db, env.ctx, {
    skuId: env.blackSmall.id, locationId: env.workspace.main.id, quantity: 1, reasonCode: 'sold',
  }), (error) => error.code === 'operating_guard' && /supplier order/.test(error.message));

  const supplier = supplierService.createSupplier(env.db, env.ctx, env.membership, { name: 'Replenishment Partner' });
  supplierService.linkItem(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, skuId: env.blackSmall.id, isPreferred: true,
    purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 4,
  });
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, lines: [{ skuId: env.blackSmall.id, quantityUnits: 8 }],
  });
  poService.approve(env.db, env.ctx, env.membership, order.id, { expectedHash: order.integrityHash });
  assert.doesNotThrow(() => inventory.issue(env.db, env.ctx, {
    skuId: env.blackSmall.id, locationId: env.workspace.main.id, quantity: 1, reasonCode: 'sold',
  }));

  operating.remove(env.db, env.ctx, env.membership, proposal.id);
  assert.equal(operatingGuards.list(env.db, env.workspace.workspaceId, { activeOnly: true }).length, 0);
});

test('a stock-protection rule warns once at its real boundary and clears when its stated release happens', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, {
    skuId: env.blackSmall.id, locationId: env.workspace.main.id, quantity: 21, reasonCode: 'purchase',
  });
  operatingGuards.set(env.db, env.ctx, env.membership, {
    skuId: env.blackSmall.id, actionType: 'issue', metric: 'network_on_hand',
    comparator: 'below', threshold: 20, releaseCondition: 'on_order',
    source: 'tell_foundry', statedAs: 'Never let this fall below twenty.',
  });

  attention.evaluate(env.db, env.workspace.workspaceId, { trigger: 'before-boundary' });
  assert.equal(attention.listAttention(env.db, env.workspace.workspaceId, {
    category: 'stock_protection_boundary',
  }).length, 0, '21 is still above a below-20 boundary');

  inventory.issue(env.db, env.ctx, {
    skuId: env.blackSmall.id, locationId: env.workspace.main.id, quantity: 1, reasonCode: 'sold',
  });
  attention.evaluate(env.db, env.workspace.workspaceId, {
    trigger: 'inventory.issued', scope: { skuIds: [env.blackSmall.id] },
  });
  attention.evaluate(env.db, env.workspace.workspaceId, {
    trigger: 'replayed-event', scope: { skuIds: [env.blackSmall.id] },
  });

  const [warning] = attention.listAttention(env.db, env.workspace.workspaceId, {
    category: 'stock_protection_boundary',
  });
  assert.ok(warning);
  assert.equal(warning.severity, 'important');
  assert.match(warning.title, /protected stock limit/i);
  assert.equal(warning.metrics.onHand, 20);
  assert.equal(warning.metrics.protectedMinimum, 20);
  assert.equal(needsYou.inbox(env.db, env.workspace.workspaceId)
    .filter((entry) => entry.id === `finding:${warning.attentionId}`).length, 1,
  'repeated evaluation produces one current Needs You item');

  assert.throws(() => inventory.issue(env.db, env.ctx, {
    skuId: env.blackSmall.id, locationId: env.workspace.main.id, quantity: 1, reasonCode: 'sold',
  }), (error) => error.code === 'operating_guard');

  const supplier = supplierService.createSupplier(env.db, env.ctx, env.membership, { name: 'Boundary Supply' });
  supplierService.linkItem(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, skuId: env.blackSmall.id, isPreferred: true,
    purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 3,
  });
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, lines: [{ skuId: env.blackSmall.id, quantityUnits: 10 }],
  });
  poService.approve(env.db, env.ctx, env.membership, order.id, { expectedHash: order.integrityHash });
  attention.evaluate(env.db, env.workspace.workspaceId, {
    trigger: 'purchase_order.placed', scope: { skuIds: [env.blackSmall.id] },
  });
  assert.equal(attention.listAttention(env.db, env.workspace.workspaceId, {
    category: 'stock_protection_boundary',
  }).length, 0, 'the current warning leaves Needs You once the configured release is true');
});

test('an inclusive stock-protection limit keeps the configured limit distinct from the lowest permitted balance everywhere', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, {
    skuId: env.blackSmall.id, locationId: env.workspace.main.id, quantity: 9, reasonCode: 'purchase',
  });
  operatingGuards.set(env.db, env.ctx, env.membership, {
    skuId: env.blackSmall.id, actionType: 'issue', metric: 'network_on_hand',
    comparator: 'at_or_below', threshold: 8, releaseCondition: 'on_order',
    source: 'tell_foundry', statedAs: 'Do not allow stock to reach eight or less.',
  });

  attention.evaluate(env.db, env.workspace.workspaceId, {
    trigger: 'operating_guard.updated', scope: { skuIds: [env.blackSmall.id] },
  });
  const [warning] = attention.listAttention(env.db, env.workspace.workspaceId, {
    category: 'stock_protection_boundary',
  });
  assert.ok(warning);
  assert.match(warning.title, /one unit from its protected stock limit/i);
  assert.match(warning.conciseSummary, /9 on hand.*next outgoing unit would reach the configured limit of 8/i);
  assert.doesNotMatch(warning.conciseSummary, /protected limit 9/i);
  assert.deepEqual(warning.evidence.slice(0, 3).map(({ label, value }) => [label, value]), [
    ['On hand now', '9'],
    ['Configured protected limit', '8'],
    ['Lowest permitted balance', '9'],
  ]);

  const inboxItem = needsYou.inbox(env.db, env.workspace.workspaceId)
    .find((entry) => entry.id === `finding:${warning.attentionId}`);
  assert.match(inboxItem.why, /next outgoing unit would reach the blocked boundary/i);

  assert.throws(() => inventory.issue(env.db, env.ctx, {
    skuId: env.blackSmall.id, locationId: env.workspace.main.id, quantity: 1, reasonCode: 'sold',
  }), (error) => error.code === 'operating_guard'
    && /configured limit is 8/.test(error.message)
    && /lowest permitted balance is 9/.test(error.message));
});

test('a model cannot incorrectly reject a supported threshold-based outgoing-order guard', async () => {
  const env = setup();
  const proposal = await operating.interpret(env.db, env.ctx, env.membership,
    'Can you make when Everyday Shirt - Black / Small reaches less than 13 it should block you from doing more orders on it until you ordreded more', {
      provider: provider({ understood: false, summary: '', changes: [], clarifyingQuestion: '', unsupportedReason: 'No matching setting.' }),
    });
  assert.equal(proposal.status, 'PENDING');
  assert.equal(proposal.questions.length, 0);
  assert.equal(proposal.resolvedChanges[0].domain, 'stock_protection');
  assert.equal(proposal.resolvedChanges[0].skuId, env.blackSmall.id);
  assert.equal(proposal.resolvedChanges[0].guardThreshold, 13, 'the stated value is extracted rather than fixed in code');
  assert.equal(proposal.resolvedChanges[0].guardReleaseCondition, 'on_order');
  assert.match(operating.describe(proposal.resolvedChanges[0]), /below 13/);
});

test('a clarification answer continues the same learned rule instead of making the owner retype it', async () => {
  const env = setup();
  const rejected = provider({ understood: false, summary: '', changes: [], clarifyingQuestion: '', unsupportedReason: 'No matching setting.' });
  const first = await operating.interpret(env.db, env.ctx, env.membership,
    'When Everyday Shirt reaches less than 9, block more customer orders until more is ordered.', { provider: rejected });
  assert.equal(first.questions.length, 1);
  const continued = await operating.answer(env.db, env.ctx, env.membership, first.id, 'Black Small', { provider: rejected });
  assert.equal(continued.questions.length, 0);
  assert.equal(continued.resolvedChanges[0].skuId, env.blackSmall.id);
  assert.match(continued.statedAs, /Clarification: Black Small/);
  assert.equal(operating.get(env.db, env.workspace.workspaceId, first.id).status, 'SUPERSEDED');
});

test('finite rule questions expose field-specific choices and apply the selected structured value', async () => {
  const env = setup();
  const missingRelease = read([{
    ...blank(), domain: 'stock_protection', itemText: 'Everyday Shirt', variantText: 'Black Small',
    guardAction: 'issue', guardMode: 'block', guardMetric: 'network_on_hand', guardComparator: 'below', guardThreshold: 10,
  }], 'Protect Black Small');
  const proposal = await operating.interpret(env.db, env.ctx, env.membership,
    'Block outgoing Black Small sales below 10.', { provider: provider(missingRelease) });
  const clarification = operating.clarificationFor(proposal);

  assert.equal(clarification.kind, 'choice');
  assert.deepEqual(
    clarification.choices.map(({ value, label }) => ({ value, label })),
    [
      { value: 'on_order', label: 'Supplier order placed' },
      { value: 'stock_recovered', label: 'Stock is back to 10' },
      { value: 'manual', label: 'Owner releases it' },
    ]
  );
  const continued = await operating.answer(
    env.db, env.ctx, env.membership, proposal.id, 'stock_recovered',
    { provider: { complete: async () => { throw new Error('a structured choice must not need a model'); } } }
  );
  assert.deepEqual(continued.questions, []);
  assert.equal(continued.resolvedChanges[0].guardReleaseCondition, 'stock_recovered');
  assert.equal(continued.resolvedChanges[0].guardReleaseThreshold, 10);
  assert.match(continued.statedAs, /Clarification: Release the block when on-hand stock has recovered to 10/);
  assert.equal(operating.get(env.db, env.workspace.workspaceId, proposal.id).status, 'SUPERSEDED');

  const openEnded = { ...proposal, resolvedChanges: [{ ...blank(), domain: 'transfer_authority' }],
    questions: ['What is the most Foundry may transfer automatically in one action?'] };
  assert.equal(operating.clarificationFor(openEnded).kind, 'text');
  assert.deepEqual(operating.clarificationFor(openEnded).choices, []);
});

test('purchase orders get one prepared communication and ordering only queues it without pretending to send', () => {
  const env = setup();
  const supplier = supplierService.createSupplier(env.db, env.ctx, env.membership, { name: 'Northstar Textiles', email: 'orders@northstar.test' });
  supplierService.linkItem(env.db, env.ctx, env.membership, { supplierId: supplier.id, skuId: env.blackSmall.id, isPreferred: true, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 4 });
  const order = poService.createOrder(env.db, env.ctx, env.membership, { supplierId: supplier.id, lines: [{ skuId: env.blackSmall.id, quantityUnits: 10 }] });
  let messages = communications.forOrder(env.db, env.workspace.workspaceId, order.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].status, 'PREPARED');
  poService.approve(env.db, env.ctx, env.membership, order.id, { expectedHash: order.integrityHash });
  communications.queueForOrder(env.db, env.workspace.workspaceId, order.id);
  messages = communications.forOrder(env.db, env.workspace.workspaceId, order.id);
  assert.equal(messages.length, 1, 'repeated queueing is idempotent');
  assert.equal(messages[0].status, 'QUEUED');
  assert.equal(messages[0].sentAt, null);
});

test('three similar approvals create one suggestion and no authority until that suggestion is approved', () => {
  const env = setup();
  for (let index = 0; index < 3; index += 1) {
    const { item } = workItems.upsert(env.db, env.workspace.workspaceId, {
      category: 'balance_transfer', idempotencyKey: `repeat-transfer-${index}`,
      recommendedAction: { quantity: 3 + index, fromLocationId: env.workspace.main.id, fromLocationName: env.workspace.main.name, toLocationId: env.workspace.store.id, toLocationName: env.workspace.store.name },
      executionStatus: workItems.STATUS.WAITING_FOR_APPROVAL,
    });
    runner.approveWorkItem(env.db, env.ctx, env.membership, item.id);
  }
  const suggestions = operating.list(env.db, env.workspace.workspaceId, { status: 'PENDING' })
    .filter((entry) => entry.source === 'repeated_approval_suggestion');
  assert.equal(suggestions.length, 1);
  assert.equal(automationPolicies.list(env.db, env.workspace.workspaceId).length, 0, 'suggestion grants nothing');
  operating.approve(env.db, env.ctx, env.membership, suggestions[0].id, suggestions[0].integrityHash);
  assert.equal(automationPolicies.list(env.db, env.workspace.workspaceId, { activeOnly: true })[0].maximumQuantity, 5);
});

test('pause retains every taught rule while execution remains stopped, and resume restores the same authority', async () => {
  const env = setup();
  const proposal = await operating.interpret(env.db, env.ctx, env.membership, 'You may move no more than four units between my two sites.', {
    provider: provider(read([{ ...blank(), domain: 'transfer_authority', sourceLocationText: 'Main Warehouse', locationText: 'Downtown Store', maximumQuantity: 4 }], 'Transfer authority')),
  });
  operating.approve(env.db, env.ctx, env.membership, proposal.id, proposal.integrityHash);
  modes.pause(env.db, env.ctx, env.membership, 'test');
  assert.equal(modes.executionState(env.db, env.workspace.workspaceId).allowed, false);
  assert.equal(automationPolicies.list(env.db, env.workspace.workspaceId, { activeOnly: true }).length, 1);
  modes.resume(env.db, env.ctx, env.membership);
  assert.equal(automationPolicies.list(env.db, env.workspace.workspaceId, { activeOnly: true }).length, 1);
});

test('approving a taught transfer boundary immediately reconsiders real pending evidence and executes only inside it', async () => {
  const { db } = makeDatabase();
  const env = seedAuthorityWorkspace(db, { requiredQuantity: 5, workspaceName: 'Taught Transfer Event' });
  const beforeSource = balanceAt(env, env.source.id);
  const beforeDestination = balanceAt(env, env.destination.id);
  const proposal = await operating.interpret(db, env.ctx, env.membership,
    'For routine site balancing, Foundry may move at most five units between Downtown and Main without asking.', {
      provider: provider(read([{ ...blank(), domain: 'transfer_authority', sourceLocationText: env.source.name, locationText: env.destination.name, maximumQuantity: 5 }], 'Five-unit transfer authority')),
    });
  operating.approve(db, env.ctx, env.membership, proposal.id, proposal.integrityHash);
  assert.equal(balanceAt(env, env.source.id), beforeSource - 5);
  assert.equal(balanceAt(env, env.destination.id), beforeDestination + 5);
  const policy = automationPolicies.list(db, env.workspace.workspaceId, { activeOnly: true })[0];
  assert.equal(policy.maximumQuantity, 5);
  assert.equal(modes.get(db, env.workspace.workspaceId).mode, modes.MODES.POLICY_AUTOMATED);
});

test('a taught transfer boundary does not resize work outside the limit and leaves one approval in Needs You', async () => {
  const { db } = makeDatabase();
  const env = seedAuthorityWorkspace(db, { requiredQuantity: 6, workspaceName: 'Taught Boundary Event' });
  const before = balanceAt(env, env.destination.id);
  const proposal = await operating.interpret(db, env.ctx, env.membership, 'Handle transfers up to five between the sites.', {
    provider: provider(read([{ ...blank(), domain: 'transfer_authority', sourceLocationText: env.source.name, locationText: env.destination.name, maximumQuantity: 5 }], 'Five-unit boundary')),
  });
  operating.approve(db, env.ctx, env.membership, proposal.id, proposal.integrityHash);
  assert.equal(balanceAt(env, env.destination.id), before, 'the six-unit need was not trimmed to fit authority');
  const waiting = workItems.list(db, env.workspace.workspaceId, { status: workItems.STATUS.WAITING_FOR_APPROVAL });
  assert.equal(waiting.filter((item) => item.category === 'balance_transfer').length, 1);
  assert.equal(waiting.find((item) => item.category === 'balance_transfer').recommendedAction.quantity, 6);
});

test('pause keeps a newly taught policy inert and resume safely replays the eligible management turn', async () => {
  const { db } = makeDatabase();
  const env = seedAuthorityWorkspace(db, { requiredQuantity: 5, workspaceName: 'Paused Taught Event' });
  modes.pause(db, env.ctx, env.membership, 'Owner paused before teaching');
  const before = balanceAt(env, env.destination.id);
  const proposal = await operating.interpret(db, env.ctx, env.membership, 'You may move at most five units between these locations.', {
    provider: provider(read([{ ...blank(), domain: 'transfer_authority', sourceLocationText: env.source.name, locationText: env.destination.name, maximumQuantity: 5 }], 'Paused transfer authority')),
  });
  operating.approve(db, env.ctx, env.membership, proposal.id, proposal.integrityHash);
  assert.equal(balanceAt(env, env.destination.id), before);
  modes.resume(db, env.ctx, env.membership);
  require('../../src/manager/reactions').publishAndReact(db, env.workspace.workspaceId,
    require('../../src/manager/events').TYPES.FOUNDRY_RESUMED, { change: 'resumed' }, { idempotencyKey: `resume:test:${env.workspace.workspaceId}` });
  assert.equal(balanceAt(env, env.destination.id), before + 5);
});

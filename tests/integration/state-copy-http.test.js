'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const {
  makeDatabase, cleanupAll, seedWorkspace, signIn, plain, csrfFrom, makeQuantityItem,
} = require('../helpers');
const authService = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const itemService = require('../../src/domain/item-service');
const supplierService = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const presenter = require('../../src/autopilot/presenter');
const planner = require('../../src/autopilot/planner');
const workItems = require('../../src/autopilot/work-items');
const { localDateKey, addLocalDays } = require('../../src/lib/calendar');

test.after(cleanupAll);

async function base(name = 'State Copy Co') {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: name });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const app = createApp({ db: store.db, env: 'test', sessionSecret: `state-copy-${name}` });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Cotton Tee' });
  inventory.receive(store.db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.main.id, quantity: 56,
  });
  const supplier = supplierService.createSupplier(store.db, workspace.ctx, membership, {
    name: 'ABC Apparel', defaultLeadTimeDays: 2,
  });
  supplierService.linkItem(store.db, workspace.ctx, membership, {
    supplierId: supplier.id, skuId: item.skuId, purchaseUnit: 'case',
    unitsPerPurchaseUnit: 12, lastUnitCost: 3, isPreferred: true,
  });
  return { ...store, workspace, membership, app, agent, item, supplier };
}

function preparation(env, order) {
  const made = workItems.upsert(env.db, env.workspace.workspaceId, {
    category: 'purchase_preparation', source: 'replenishment',
    affectedEntities: { supplierId: env.supplier.id, supplierName: env.supplier.name },
    recommendedAction: { actionType: 'prepare_purchase_order', supplierId: env.supplier.id,
      supplierName: env.supplier.name, lines: [{ skuId: env.item.skuId }] },
    approvalRequirement: 'NONE', executionStatus: workItems.STATUS.DETECTED,
    priority: 60, urgency: 'normal', confidence: 'high',
    idempotencyKey: `state-copy-preparation:${order.id}`,
  }).item;
  return workItems.transition(env.db, env.workspace.workspaceId, made.id, workItems.STATUS.COMPLETED, {
    purchaseOrderId: order.id, verificationStatus: 'VERIFIED',
    outcome: { poNumber: order.poNumber, lines: 1, subtotal: order.subtotal },
  });
}

function detailFor(env, item) {
  return presenter.describeCompleted(
    item,
    new Set(),
    presenter.currentOrderForWork(env.db, env.workspace.workspaceId, item)
  ).detail;
}

test('completed PO cards follow draft, placed, partially received and completed state', async () => {
  const env = await base('PO Lifecycle Co');
  let order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 2, unitCost: 3 }],
  });
  const item = preparation(env, order);

  assert.match(detailFor(env, item), /PO-1001 is a draft — 24 units prepared, nothing on order/);
  const draftInbox = require('../../src/manager/needs-you-inbox').inbox(env.db, env.workspace.workspaceId);
  assert.ok(draftInbox.some((entry) => /PO-1001.*ready to send/.test(entry.title)),
    'the draft counted on Home also appears in Needs you');

  order = poService.approve(env.db, env.workspace.ctx, env.membership, order.id, {
    expectedHash: order.integrityHash, markOrdered: true,
  });
  assert.match(detailFor(env, item), /PO-1001 placed — 24 units outstanding/);
  assert.doesNotMatch(detailFor(env, item), /Waiting for you to approve/);

  receiving.receive(env.db, env.workspace.ctx, env.membership, order.id, {
    idempotencyKey: 'partial-state-copy',
    lines: [{ lineId: order.lines[0].id, quantityUnits: 12, locationId: env.workspace.main.id }],
  });
  assert.match(detailFor(env, item), /PO-1001 partially received — 12 units received, 12 units outstanding/);

  receiving.receive(env.db, env.workspace.ctx, env.membership, order.id, {
    idempotencyKey: 'complete-state-copy',
    lines: [{ lineId: order.lines[0].id, quantityUnits: 12, locationId: env.workspace.main.id }],
  });
  assert.match(detailFor(env, item), /PO-1001 completed — all 24 units received/);
  env.db.close();
});

test('completed replenishment leads with live position and readable live verification', async () => {
  const env = await base('Completed Plan Co');
  let order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 2, unitCost: 3 }],
  });
  order = poService.approve(env.db, env.workspace.ctx, env.membership, order.id, {
    expectedHash: order.integrityHash, markOrdered: true,
  });

  const created = workItems.upsert(env.db, env.workspace.workspaceId, {
    category: 'replenishment_plan', source: 'replenishment',
    sourceEvidence: [{ label: 'Lead time', value: '13 days', note: 'measured' }],
    affectedEntities: { skuId: env.item.skuId, itemId: env.item.itemId, displayName: 'Cotton Tee' },
    recommendedAction: {
      actionType: 'replenishment_plan', skuId: env.item.skuId, decision: 'purchase',
      transfers: [], purchase: null,
      prepared: { units: 24, orders: [{ poId: order.id, poNumber: order.poNumber }] },
      reorderPoint: 60, target: 80, onHandTotal: 56, onOrder: 0, networkPosition: 56,
      byLocation: [{ locationId: env.workspace.main.id, locationName: 'Main Warehouse', onHand: 56, need: 0 }],
      after: { byLocation: [{ locationId: env.workspace.main.id, locationName: 'Main Warehouse', before: 56, after: 56 }], onHandAfterMoves: 56 },
      explanation: 'The recorded position was at or below the reorder point.',
    },
    approvalRequirement: 'REQUIRED', executionStatus: workItems.STATUS.WAITING_FOR_APPROVAL,
    priority: 65, urgency: 'normal', confidence: 'high', idempotencyKey: 'completed-plan-state-copy',
  }).item;
  const completed = workItems.transition(env.db, env.workspace.workspaceId, created.id, workItems.STATUS.COMPLETED, {
    purchaseOrderId: order.id, verificationStatus: 'VERIFIED',
    outcome: { purchaseOrderId: order.id, checks: [{ kind: 'purchase', poNumber: order.poNumber, status: 'ORDERED', ok: true }] },
  });

  // The supplier is now configured differently. Finished work must label its
  // 13-day evidence as historical instead of presenting it as today's value.
  supplierService.updateSupplier(env.db, env.workspace.ctx, env.membership, env.supplier.id, {
    defaultLeadTimeDays: 15,
  });

  const response = await env.agent.get(`/autopilot/work/${completed.id}`);
  const page = plain(response.text).replace(/\s+/g, ' ');
  assert.match(page, /Current result: 56 on hand \+ 24 on order = inventory position 80\./);
  assert.match(page, /Position when this plan was made/);
  assert.match(page, /Inventory position at plan creation/);
  assert.doesNotMatch(page, /Position now/);
  assert.match(page, /Lead time used when plan was created 13 days/);
  assert.doesNotMatch(page, /After approving this/);
  assert.match(page, /Verified current state: PO-1001 is placed; 24 units are on order; on-hand is 56\./);
  assert.doesNotMatch(response.text, />\s*svg\s*Verified current state/i);
  assert.doesNotMatch(page, /Approving places it|Waiting for approval|Nothing has been ordered yet/);
  env.db.close();
});

test('future deliveries stay on the horizon; due deliveries become actionable', async () => {
  const env = await base('Delivery State Co');
  const today = localDateKey();
  const future = addLocalDays(Date.now(), 2);
  let order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id, expectedDate: future,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 2, unitCost: 3 }],
  });
  order = poService.approve(env.db, env.workspace.ctx, env.membership, order.id, {
    expectedHash: order.integrityHash, markOrdered: true,
  });
  const reminder = workItems.upsert(env.db, env.workspace.workspaceId, {
    category: 'receiving_followup', source: 'purchase_order',
    affectedEntities: { purchaseOrderId: order.id, supplierName: env.supplier.name },
    recommendedAction: { actionType: 'receive_delivery', purchaseOrderId: order.id,
      poNumber: order.poNumber, supplierName: env.supplier.name, expectedDate: today,
      outstandingUnits: 24, late: false },
    approvalRequirement: 'REQUIRED', executionStatus: workItems.STATUS.WAITING_FOR_APPROVAL,
    priority: 50, urgency: 'normal', confidence: 'high',
    idempotencyKey: workItems.keyFor('receiving_followup', { purchaseOrderId: order.id }),
  }).item;

  assert.equal(presenter.deliveryState(env.db, env.workspace.workspaceId, reminder).actionable, false);
  assert.equal(presenter.whatFoundryPrepared(env.db, env.workspace.workspaceId)
    .some((entry) => entry.id === reminder.id), false);
  assert.equal(planner.plan(env.db, env.workspace.workspaceId).receiving.length, 0,
    'a future expected date is not a receiving job');
  const horizon = presenter.whatsNext(env.db, env.workspace.workspaceId);
  assert.match(horizon[0].title, /PO-1001 expected .* from ABC Apparel/);
  assert.equal(horizon[0].detail, '24 units outstanding.');
  const futurePage = plain((await env.agent.get(`/purchasing/orders/${order.id}`)).text).replace(/\s+/g, ' ');
  assert.match(futurePage, /Report an early delivery/);
  assert.match(futurePage, new RegExp(`Expected ${future}`));
  assert.doesNotMatch(futurePage, /It all arrived — book it in/);

  env.db.prepare('UPDATE purchase_orders SET expected_date = ? WHERE id = ?').run(today, order.id);
  const due = presenter.deliveryState(env.db, env.workspace.workspaceId, reminder);
  assert.equal(due.actionable, true);
  assert.equal(due.title, 'PO-1001 from ABC Apparel is due today');
  assert.equal(planner.plan(env.db, env.workspace.workspaceId).receiving.length, 1);
  const duePage = plain((await env.agent.get(`/purchasing/orders/${order.id}`)).text).replace(/\s+/g, ' ');
  assert.match(duePage, /It all arrived — book it in/);
  assert.doesNotMatch(duePage, /Report an early delivery/);

  const home = await env.agent.get('/');
  await env.agent.post('/autopilot/run').type('form').send({ _csrf: csrfFrom(home.text) });
  const after = plain((await env.agent.get('/')).text).replace(/\s+/g, ' ');
  assert.match(after, /Check complete — no new work found\./,
    'finding the same due-delivery work again is not new work');
  env.db.close();
});

test('superseded work contains no reusable approval copy', async () => {
  const env = await base('Superseded Copy Co');
  const order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 2, unitCost: 3 }],
  });
  const made = workItems.upsert(env.db, env.workspace.workspaceId, {
    category: 'purchase_approval', source: 'purchase_policy', purchaseOrderId: order.id,
    affectedEntities: { purchaseOrderId: order.id },
    recommendedAction: { actionType: 'approve_purchase_order', purchaseOrderId: order.id,
      poNumber: order.poNumber, supplierName: env.supplier.name },
    approvalRequirement: 'REQUIRED', executionStatus: workItems.STATUS.WAITING_FOR_APPROVAL,
    priority: 70, urgency: 'normal', confidence: 'high', idempotencyKey: 'superseded-copy',
  }).item;
  workItems.transition(env.db, env.workspace.workspaceId, made.id, workItems.STATUS.SUPERSEDED, {
    verificationStatus: 'NOT_APPLICABLE',
    outcome: { supersededByWorkItemId: 'replacement-plan' },
  });
  const text = presenter.explain(env.db, env.workspace.workspaceId, made.id).paragraphs.join(' ');
  assert.match(text, /replaced before it ran/);
  assert.match(text, /Current order state: PO-1001 is a draft/);
  assert.doesNotMatch(text, /Approving places it|waiting to be placed|Waiting for approval/);
  env.db.close();
});

test('Check now reports no new work while preserving the current Needs you count', async () => {
  const env = await base('Check Banner Co');
  // One real outbound event moves readiness out of the separate setup prompt.
  inventory.issue(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 1, reasonCode: 'sold',
  });
  workItems.upsert(env.db, env.workspace.workspaceId, {
    category: 'discrepancy_review', source: 'test',
    affectedEntities: { displayName: 'Cotton Tee' },
    recommendedAction: { message: 'Review the unexplained difference.' },
    approvalRequirement: 'REQUIRED', executionStatus: workItems.STATUS.WAITING_FOR_APPROVAL,
    priority: 90, urgency: 'soon', confidence: 'high', idempotencyKey: 'existing-needs-copy',
  });

  const home = await env.agent.get('/');
  const response = await env.agent.post('/autopilot/run').type('form').send({ _csrf: csrfFrom(home.text) });
  assert.equal(response.status, 303);
  const after = plain((await env.agent.get('/')).text).replace(/\s+/g, ' ');
  assert.match(after, /Check complete — no new work found\. 1 existing item still needs you\./);
  assert.doesNotMatch(after, /Nothing needs doing/);
  env.db.close();
});

test('demand readiness counts stock positions, not products', async () => {
  const env = await base('Variant Wording Co');
  const made = itemService.createItem(env.db, env.workspace.ctx, {
    name: 'Six-way Tee', baseCode: 'SWT', trackingMode: 'quantity', hasVariants: true,
    options: [{ name: 'Size', values: 'XS, S, M, L, XL, XXL' }],
  });
  const variants = repo.listSkusForItem(env.db, env.workspace.workspaceId, made.itemId);
  for (const sku of variants.slice(0, 2)) {
    inventory.receive(env.db, env.workspace.ctx, { skuId: sku.id, locationId: env.workspace.main.id, quantity: 2 });
    inventory.issue(env.db, env.workspace.ctx, { skuId: sku.id, locationId: env.workspace.main.id, quantity: 1, reasonCode: 'sold' });
  }
  const readiness = require('../../src/manager/readiness').assess(env.db, env.workspace.workspaceId);
  assert.match(readiness.notes.join(' '), /stock positions selling/);
  assert.doesNotMatch(readiness.notes.join(' '), /products selling/);
  env.db.close();
});

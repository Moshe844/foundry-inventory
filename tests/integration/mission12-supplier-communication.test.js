'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const authService = require('../../src/domain/auth-service');
const repo = require('../../src/domain/repository');
const inventory = require('../../src/domain/inventory-engine');
const suppliers = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const connections = require('../../src/connections/service');
const ingestion = require('../../src/connections/event-ingestion');
const needsYou = require('../../src/manager/needs-you-inbox');
const gmail = require('../../src/connections/providers/gmail');
const microsoft365 = require('../../src/connections/providers/microsoft365');
const operatingInstructions = require('../../src/manager/operating-instructions');
const supplierCommunications = require('../../src/purchasing/supplier-communications');
const receiving = require('../../src/purchasing/receiving-service');
const sales = require('../../src/sales/sales-order-service');
const credentials = require('../../src/connections/credentials');
const modes = require('../../src/autopilot/modes');
const operationsLog = require('../../src/domain/operations-log');
const providerService = require('../../src/connections/provider-service');
const mailboxScheduler = require('../../src/connections/mailbox-scheduler');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

test('the mailbox scheduler wakes often enough to honor a one-minute cadence', () => {
  assert.ok(mailboxScheduler.DEFAULT_WAKE_MS <= 15_000);
});

function setup() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Supplier Operations' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Black Small', baseCode: 'BLK-S' });
  inventory.receive(store.db, workspace.ctx, { skuId: item.skuId, locationId: workspace.store.id, quantity: 7 });
  const supplier = suppliers.createSupplier(store.db, workspace.ctx, membership, { name: 'ABC Apparel',
    email: 'orders@abc.test', priceTolerancePercent: 5, quantityTolerancePercent: 0 });
  suppliers.linkItem(store.db, workspace.ctx, membership, { supplierId: supplier.id, skuId: item.skuId,
    supplierSku: 'ABC-BLK-S', purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 6.5 });
  const order = poService.createOrder(store.db, workspace.ctx, membership, { supplierId: supplier.id,
    destinationLocationId: workspace.store.id, lines: [{ skuId: item.skuId, quantityPurchaseUnits: 24, unitCost: 6.5 }] });
  const email = connections.create(store.db, workspace.ctx, membership, { providerType: 'supplier_email',
    displayName: 'Supplier Inbox' });
  connections.addEmailRule(store.db, workspace.ctx, email.connection.id, {
    senderPattern: 'orders@abc.test', supplierId: supplier.id, documentMode: 'supplier_documents',
  });
  const auth = { connectorId: email.connection.id, workspaceId: workspace.workspaceId,
    actorId: workspace.ownerId, accountId: workspace.accountId, providerType: 'supplier_email',
    displayName: 'Supplier Inbox' };
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'mission12-supplier-test' });
  return { ...store, workspace, membership, item, supplier, order, email, auth, app };
}

function message(env, id, subject, facts, bodyText = '') {
  return ingestion.ingest(env.db, env.auth, { eventId: id, type: 'supplier_document.received',
    occurredAt: '2026-08-30T12:00:00Z', data: { messageId: id, threadId: 'thread-po-1',
      sender: 'orders@abc.test', subject, bodyText, facts } });
}

test('trusted acknowledgement matches PO, records price history, and invoice never receives stock', () => {
  const env = setup();
  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id);
  const result = message(env, 'ack-1', `Order acknowledgement ${env.order.poNumber}`, {
    poNumber: env.order.poNumber, supplierOrderNumber: 'ABC-900',
    lines: [{ supplierSku: 'ABC-BLK-S', confirmedQuantity: 24, unitPrice: 6.75 }],
  });
  assert.equal(result.accepted, true);
  assert.equal(env.db.prepare('SELECT status FROM supplier_documents').get().status, 'MATCHED');
  assert.equal(env.db.prepare('SELECT unit_cost FROM supplier_price_history').get().unit_cost, 6.75);
  assert.equal(env.db.prepare('SELECT confirmed_units FROM purchase_order_line_expectations').get().confirmed_units, 24);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before);

  message(env, 'invoice-1', `Invoice 884 for ${env.order.poNumber}`, { poNumber: env.order.poNumber,
    invoiceNumber: '884', lines: [{ supplierSku: 'ABC-BLK-S', quantity: 24, unitPrice: 6.75 }] });
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before,
    'invoice evidence is never physical receiving');
  env.db.close();
});

test('price outside tolerance creates one clear Needs You and replay cannot duplicate evidence', () => {
  const env = setup();
  const facts = { poNumber: env.order.poNumber, invoiceNumber: '885',
    lines: [{ supplierSku: 'ABC-BLK-S', quantity: 24, unitPrice: 7.25 }] };
  message(env, 'invoice-high-1', `Invoice 885 ${env.order.poNumber}`, facts);
  message(env, 'invoice-high-resend', `Invoice 885 ${env.order.poNumber}`, facts);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM supplier_documents').get().n, 1);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM connection_issues WHERE issue_type = ?').get('SUPPLIER_DOCUMENT_REVIEW').n, 1);
  const item = needsYou.inbox(env.db, env.workspace.workspaceId).find((entry) => /needs your decision/i.test(entry.title));
  assert.match(item.happened, /6\.5 to 7\.25/);
  env.db.close();
});

test('price discrepancy gives direct accept or keep-original decisions without receiving stock', async () => {
  const env = setup();
  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id);
  message(env, 'invoice-price-decision-1', `Invoice 991 ${env.order.poNumber}`, {
    poNumber: env.order.poNumber, invoiceNumber: '991',
    lines: [{ supplierSku: 'ABC-BLK-S', quantity: 24, unitPrice: 7.25 }],
  });
  const issue = env.db.prepare(`SELECT * FROM connection_issues
    WHERE workspace_id = ? AND issue_type = 'SUPPLIER_DOCUMENT_REVIEW' AND status = 'OPEN'`)
    .get(env.workspace.workspaceId);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const page = await agent.get(`/settings/connections/${env.email.connection.id}`);
  const text = plain(page.text);
  assert.match(text, /Accept supplier changes/i);
  assert.match(text, /Keep original purchase order/i);
  const accepted = await agent.post(`/settings/connections/${env.email.connection.id}/supplier-document-decision`)
    .type('form').send({ _csrf: csrfFrom(page.text), issueId: issue.id, decision: 'accept' });
  assert.equal(accepted.status, 303);
  assert.equal(env.db.prepare('SELECT unit_cost FROM purchase_order_lines WHERE purchase_order_id = ?')
    .get(env.order.id).unit_cost, 7.25);
  assert.equal(env.db.prepare('SELECT status FROM connection_issues WHERE id = ?').get(issue.id).status, 'RESOLVED');
  assert.equal(env.db.prepare('SELECT status FROM supplier_documents WHERE document_reference = ?').get('991').status, 'MATCHED');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before);
  env.db.close();
});

test('keeping the original PO rejects a supplier discrepancy without changing it', async () => {
  const env = setup();
  message(env, 'invoice-price-keep-1', `Invoice 992 ${env.order.poNumber}`, {
    poNumber: env.order.poNumber, invoiceNumber: '992',
    lines: [{ supplierSku: 'ABC-BLK-S', quantity: 24, unitPrice: 7.25 }],
  });
  const issue = env.db.prepare(`SELECT * FROM connection_issues
    WHERE workspace_id = ? AND issue_type = 'SUPPLIER_DOCUMENT_REVIEW' AND status = 'OPEN'`)
    .get(env.workspace.workspaceId);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const page = await agent.get(`/settings/connections/${env.email.connection.id}`);
  const kept = await agent.post(`/settings/connections/${env.email.connection.id}/supplier-document-decision`)
    .type('form').send({ _csrf: csrfFrom(page.text), issueId: issue.id, decision: 'keep_original' });
  assert.equal(kept.status, 303);
  assert.equal(env.db.prepare('SELECT unit_cost FROM purchase_order_lines WHERE purchase_order_id = ?')
    .get(env.order.id).unit_cost, 6.5);
  assert.equal(env.db.prepare('SELECT status FROM supplier_documents WHERE document_reference = ?').get('992').status, 'IGNORED');
  assert.equal(env.db.prepare('SELECT status FROM connection_issues WHERE id = ?').get(issue.id).status, 'RESOLVED');
  env.db.close();
});

test('partial shipment updates incoming expectations and ETA without changing on-hand', () => {
  const env = setup();
  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id);
  message(env, 'ship-1', `Shipment notice ${env.order.poNumber}`, { poNumber: env.order.poNumber,
    expectedArrivalDate: '2026-09-04', lines: [{ supplierSku: 'ABC-BLK-S', shippedQuantity: 12,
      backorderedQuantity: 12, expectedArrivalDate: '2026-09-04' }] }, '12 shipping now; 12 backordered.');
  const expectation = env.db.prepare('SELECT * FROM purchase_order_line_expectations').get();
  assert.equal(expectation.shipping_units, 12);
  assert.equal(expectation.backordered_units, 12);
  assert.equal(poService.get(env.db, env.workspace.workspaceId, env.order.id).expectedDate, '2026-09-04');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before);
  env.db.close();
});

test('delivery confirmation asks for physical receiving instead of increasing inventory', () => {
  const env = setup();
  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id);
  message(env, 'delivery-1', `Delivery confirmation ${env.order.poNumber}`, { poNumber: env.order.poNumber }, '24 units delivered.');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before);
  assert.ok(needsYou.inbox(env.db, env.workspace.workspaceId).some((entry) => /says .* was delivered/i.test(entry.title)));
  env.db.close();
});

test('an approved plain message is visible history but creates no inventory or Needs You work', () => {
  const env = setup();
  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id);
  message(env, 'plain-1', '', {}, 'testing');
  const captured = env.db.prepare(`SELECT * FROM connection_email_messages
    WHERE workspace_id = ? AND external_message_id = ?`).get(env.workspace.workspaceId, 'plain-1');
  assert.equal(captured.classification, 'supplier_message');
  assert.equal(captured.processing_status, 'RECORDED');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM connection_email_attachments WHERE message_id = ?')
    .get(captured.id).n, 0);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before);
  assert.ok(!needsYou.inbox(env.db, env.workspace.workspaceId)
    .some((entry) => entry.id.includes(captured.id) || /testing/i.test(entry.title)));
  env.db.close();
});

test('mailbox polling ignores every sender the owner did not approve', async () => {
  const env = setup();
  const connectorId = connectTestGmail(env);
  const result = await providerService.syncMailbox(env.db, env.workspace.workspaceId, connectorId, { adapter: {
    refreshCredentials: async (current) => ({ credentials: current, refreshed: false }),
    poll: async () => ({ messages: [{ messageId: 'unrelated-1', sender: 'newsletter@example.test',
      subject: 'Weekly news', bodyText: 'Nothing about purchasing.', receivedAt: new Date().toISOString(), attachments: [] }] }),
  } });
  assert.equal(result.messages, 0);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM connection_email_messages
    WHERE workspace_id = ? AND external_message_id = ?`).get(env.workspace.workspaceId, 'unrelated-1').n, 0);
  assert.ok(!needsYou.inbox(env.db, env.workspace.workspaceId).some((entry) => /newsletter/i.test(entry.title)));
  env.db.close();
});

test('a changed supplier ETA explains the customer-order consequence', () => {
  const env = setup();
  const customerOrder = sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'ABC School', orderDate: '2026-08-30', neededBy: '2026-09-02',
    fulfillmentLocationId: env.workspace.store.id,
    lines: [{ skuId: env.item.skuId, quantity: 20, unitPriceMinor: 1500 }],
  });
  sales.confirm(env.db, env.workspace.ctx, customerOrder.id);
  poService.approve(env.db, env.workspace.ctx, env.membership, env.order.id);
  message(env, 'eta-risk-1', `Shipment notice ${env.order.poNumber}`, {
    poNumber: env.order.poNumber, expectedArrivalDate: '2026-09-04',
    lines: [{ supplierSku: 'ABC-BLK-S', shippedQuantity: 24, expectedArrivalDate: '2026-09-04' }],
  }, 'Delivery is now expected September 4.');
  const risk = needsYou.inbox(env.db, env.workspace.workspaceId)
    .find((entry) => entry.id.startsWith(`sales-order:${customerOrder.id}:`));
  assert.ok(risk);
  assert.match(risk.title, /ABC School.*2026-09-02.*too late/i);
  assert.match(risk.why, /24 incoming unit\(s\).*2026-09-04.*after/i);
  env.db.close();
});

test('a supplier reply without a PO number stays attached to the original PO thread', () => {
  const env = setup();
  message(env, 'thread-ack-1', `Order acknowledgement ${env.order.poNumber}`, {
    poNumber: env.order.poNumber, lines: [{ supplierSku: 'ABC-BLK-S', confirmedQuantity: 24, unitPrice: 6.5 }],
  });
  message(env, 'thread-reply-1', 'Re: your order', {
    lines: [{ supplierSku: 'ABC-BLK-S', shippedQuantity: 12, backorderedQuantity: 12,
      expectedArrivalDate: '2026-09-06' }],
  }, 'We can ship 12 now and the remaining 12 next week.');
  const reply = env.db.prepare(`SELECT * FROM supplier_documents d JOIN connection_email_messages m ON m.id = d.message_id
    WHERE d.workspace_id = ? AND m.external_message_id = ?`).get(env.workspace.workspaceId, 'thread-reply-1');
  assert.equal(reply.purchase_order_id, env.order.id);
  assert.equal(reply.status, 'MATCHED');
  env.db.close();
});

test('unknown supplier SKU offers one-step matching and future documents reuse it', async () => {
  const env = setup();
  message(env, 'unknown-supplier-sku-1', `Shipment notice ${env.order.poNumber}`, {
    poNumber: env.order.poNumber,
    lines: [{ supplierSku: 'ABC-NEW-S', shippedQuantity: 24, expectedArrivalDate: '2026-09-04' }],
  });
  const issue = env.db.prepare(`SELECT * FROM connection_issues
    WHERE workspace_id = ? AND issue_type = 'SUPPLIER_DOCUMENT_REVIEW' AND status = 'OPEN'`)
    .get(env.workspace.workspaceId);
  const candidate = JSON.parse(issue.candidate_matches).find((entry) => entry.kind === 'supplier_sku');
  assert.equal(candidate.supplierSku, 'ABC-NEW-S');
  assert.equal(candidate.supplierId, env.supplier.id);

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const page = await agent.get(`/settings/connections/${env.email.connection.id}`);
  assert.match(plain(page.text), /What is ABC-NEW-S in Foundry/i);
  assert.match(plain(page.text), /Save match for future emails/i);
  const saved = await agent.post(`/settings/connections/${env.email.connection.id}/supplier-sku-map`)
    .type('form').send({ _csrf: csrfFrom(page.text), issueId: issue.id,
      supplierSku: 'ABC-NEW-S', skuId: env.item.skuId });
  assert.equal(saved.status, 303);
  assert.equal(env.db.prepare('SELECT status FROM connection_issues WHERE id = ?').get(issue.id).status, 'RESOLVED');
  assert.equal(suppliers.itemsForSupplier(env.db, env.workspace.workspaceId, env.supplier.id)[0].supplierSku,
    'ABC-NEW-S');

  message(env, 'unknown-supplier-sku-2', `Shipment notice ${env.order.poNumber}`, {
    poNumber: env.order.poNumber,
    lines: [{ supplierSku: 'ABC-NEW-S', shippedQuantity: 24, expectedArrivalDate: '2026-09-05' }],
  }, 'Updated shipment notice for the newly matched supplier SKU.');
  const future = env.db.prepare(`SELECT d.* FROM supplier_documents d
    JOIN connection_email_messages m ON m.id = d.message_id
    WHERE d.workspace_id = ? AND m.external_message_id = ?`).get(env.workspace.workspaceId, 'unknown-supplier-sku-2');
  assert.equal(future.status, 'MATCHED');
  assert.deepEqual(JSON.parse(future.discrepancies), []);
  env.db.close();
});

test('a late PO prepares one restrained follow-up and never duplicates it that day', () => {
  const env = setup();
  suppliers.updateSupplier(env.db, env.workspace.ctx, env.membership, env.supplier.id, {
    watchedConnectorId: env.email.connection.id, prepareCommunications: true, followUpDays: 2,
  });
  poService.approve(env.db, env.workspace.ctx, env.membership, env.order.id);
  env.db.prepare(`UPDATE purchase_orders SET ordered_at = ?, expected_date = ?, expected_date_source = 'manual'
    WHERE id = ?`).run('2026-08-20T12:00:00.000Z', '2026-08-25', env.order.id);
  const first = supplierCommunications.prepareDueFollowups(env.db, env.workspace.workspaceId,
    { now: Date.parse('2026-08-30T12:00:00.000Z') });
  const replay = supplierCommunications.prepareDueFollowups(env.db, env.workspace.workspaceId,
    { now: Date.parse('2026-08-30T14:00:00.000Z') });
  assert.equal(first.length, 1);
  assert.equal(first[0].messageKind, 'late_delivery_follow_up');
  assert.match(first[0].subject, new RegExp(env.order.poNumber));
  assert.equal(replay.length, 0);
  env.db.close();
});

test('delivery evidence becomes stock only after physical receiving uses the existing engine', () => {
  const env = setup();
  poService.approve(env.db, env.workspace.ctx, env.membership, env.order.id);
  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id);
  message(env, 'delivery-receive-1', `Delivery confirmation ${env.order.poNumber}`,
    { poNumber: env.order.poNumber }, '24 units delivered.');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before);
  const line = poService.get(env.db, env.workspace.workspaceId, env.order.id).lines[0];
  const received = receiving.receive(env.db, env.workspace.ctx, env.membership, env.order.id, {
    idempotencyKey: 'mission12-physical-receipt',
    lines: [{ lineId: line.id, quantityUnits: 24, locationId: env.workspace.store.id }],
  });
  assert.equal(received.replayed, false);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before + 24);
  assert.equal(poService.get(env.db, env.workspace.workspaceId, env.order.id).status, 'RECEIVED');
  env.db.close();
});

test('Gmail and Microsoft 365 produce normal OAuth authorization-code URLs', () => {
  const old = { gmailId: process.env.GMAIL_CLIENT_ID, gmailSecret: process.env.GMAIL_CLIENT_SECRET,
    msId: process.env.MICROSOFT365_CLIENT_ID, msSecret: process.env.MICROSOFT365_CLIENT_SECRET };
  process.env.GMAIL_CLIENT_ID = 'gmail-client'; process.env.GMAIL_CLIENT_SECRET = 'gmail-secret';
  process.env.MICROSOFT365_CLIENT_ID = 'ms-client'; process.env.MICROSOFT365_CLIENT_SECRET = 'ms-secret';
  try {
    const google = new URL(gmail.authorizationUrl({ state: 'safe-state', input: { redirectUri: 'https://foundry.test/callback' } }).url);
    assert.equal(google.hostname, 'accounts.google.com');
    assert.equal(google.searchParams.get('response_type'), 'code');
    assert.match(google.searchParams.get('scope'), /gmail\.readonly/);
    assert.match(google.searchParams.get('prompt'), /select_account/);
    const microsoft = new URL(microsoft365.authorizationUrl({ state: 'safe-state', input: { redirectUri: 'https://foundry.test/callback' } }).url);
    assert.equal(microsoft.hostname, 'login.microsoftonline.com');
    assert.equal(microsoft.searchParams.get('response_type'), 'code');
    assert.match(microsoft.searchParams.get('scope'), /Mail\.Read/);
    assert.equal(microsoft.searchParams.get('prompt'), 'select_account');
  } finally {
    if (old.gmailId === undefined) delete process.env.GMAIL_CLIENT_ID; else process.env.GMAIL_CLIENT_ID = old.gmailId;
    if (old.gmailSecret === undefined) delete process.env.GMAIL_CLIENT_SECRET; else process.env.GMAIL_CLIENT_SECRET = old.gmailSecret;
    if (old.msId === undefined) delete process.env.MICROSOFT365_CLIENT_ID; else process.env.MICROSOFT365_CLIENT_ID = old.msId;
    if (old.msSecret === undefined) delete process.env.MICROSOFT365_CLIENT_SECRET; else process.env.MICROSOFT365_CLIENT_SECRET = old.msSecret;
  }
});

test('an explicitly trusted delivery confirmation uses replay-safe physical receiving', () => {
  const env = setup();
  suppliers.updateSupplier(env.db, env.workspace.ctx, env.membership, env.supplier.id, {
    trustedDeliveryReceipt: true,
  });
  poService.approve(env.db, env.workspace.ctx, env.membership, env.order.id);
  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id);
  const facts = { poNumber: env.order.poNumber,
    lines: [{ supplierSku: 'ABC-BLK-S', quantity: 24 }] };
  message(env, 'trusted-delivery-1', `Delivery confirmation ${env.order.poNumber}`, facts, '24 units delivered.');
  message(env, 'trusted-delivery-1', `Delivery confirmation ${env.order.poNumber}`, facts, '24 units delivered.');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before + 24);
  assert.equal(poService.get(env.db, env.workspace.workspaceId, env.order.id).status, 'RECEIVED');
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM connection_issues
    WHERE workspace_id = ? AND issue_type = 'PHYSICAL_RECEIPT_CONFIRMATION' AND status = 'OPEN'`)
    .get(env.workspace.workspaceId).n, 0);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM purchase_order_receipts
    WHERE workspace_id = ?`).get(env.workspace.workspaceId).n, 1);
  env.db.close();
});

test('supplier settings expose the complete communication profile behind advanced disclosure', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const page = await agent.get(`/suppliers/${env.supplier.id}`);
  const text = plain(page.text);
  assert.match(text, /Preferred ordering method/i);
  assert.match(text, /Supplier minimum order value/i);
  assert.match(text, /Payment \/ reference terms/i);
  assert.match(text, /Trusted delivery confirmation/i);
  assert.match(text, /refuses unknown items, missing quantities, over-receipts, lots, serials/i);
  env.db.close();
});

test('mailbox timing is honored by the unattended scheduler and transient failures stay understandable', async () => {
  const env = setup();
  const connectorId = connectTestGmail(env);
  const old = new Date(Date.now() - 61_000).toISOString();
  env.db.prepare(`UPDATE workspace_connectors SET config = ?, expected_interval_minutes = 3,
    last_synced_at = ? WHERE id = ?`).run(JSON.stringify({ mailboxCheckMinutes: 1 }), old, connectorId);
  const originalPoll = gmail.poll;
  gmail.poll = async () => ({ messages: [] });
  try {
    const [result] = await mailboxScheduler.runDue(env.db, { now: Date.now() });
    assert.equal(result.ok, true);
    assert.notEqual(env.db.prepare('SELECT last_synced_at FROM workspace_connectors WHERE id = ?')
      .get(connectorId).last_synced_at, old);
    const row = env.db.prepare('SELECT * FROM workspace_connectors WHERE id = ?').get(connectorId);
    const problem = mailboxScheduler.failureDetails(row, Object.assign(new Error('fetch failed'), { transient: true }), Date.now());
    assert.match(problem.title, /cannot currently reach/i);
    assert.doesNotMatch(problem.detail, /fetch failed/i);
  } finally { gmail.poll = originalPoll; env.db.close(); }
});

test('Tell Foundry proposes and applies supplier sending authority through the same supplier settings', async () => {
  const env = setup();
  const proposal = await operatingInstructions.interpret(env.db, env.workspace.ctx, env.membership,
    'ABC Apparel, you can send orders under $500 without asking me.');
  assert.equal(proposal.status, 'PENDING');
  assert.match(proposal.summary, /supplier communication/i);
  operatingInstructions.approve(env.db, env.workspace.ctx, env.membership, proposal.id, proposal.integrityHash);
  const supplier = suppliers.getSupplier(env.db, env.workspace.workspaceId, env.supplier.id);
  assert.equal(supplier.autoSendEnabled, true);
  assert.equal(supplier.autoSendLimitMinor, 50000);
  env.db.close();
});

function connectTestGmail(env, supplierChanges = {}) {
  const connectorId = env.email.connection.id;
  env.db.prepare(`UPDATE workspace_connectors SET provider_type = 'gmail', display_name = 'Purchasing Gmail',
    status = 'connected', setup_status = 'CONNECTED', paused_at = NULL WHERE id = ?`).run(connectorId);
  credentials.put(env.db, env.workspace.workspaceId, connectorId, 'provider', {
    accessToken: 'test-token', refreshToken: 'test-refresh', mailbox: 'buyer@example.test',
    expiresAt: Date.now() + 60 * 60_000,
  });
  suppliers.updateSupplier(env.db, env.workspace.ctx, env.membership, env.supplier.id, {
    watchedConnectorId: connectorId, prepareCommunications: true, autoSendEnabled: true,
    autoSendLimit: 500, ...supplierChanges,
  });
  modes.setMode(env.db, env.workspace.ctx, env.membership, modes.MODES.POLICY_AUTOMATED);
  return connectorId;
}

test('routine PO under the approved limit sends once through the watched mailbox', async () => {
  const env = setup();
  connectTestGmail(env);
  const originalSend = gmail.send;
  let sent = 0;
  gmail.send = async ({ message: outgoing }) => {
    sent += 1;
    assert.match(outgoing.subject, new RegExp(env.order.poNumber));
    return { externalMessageId: 'gmail-message-1', externalThreadId: 'gmail-thread-1' };
  };
  try {
    poService.approve(env.db, env.workspace.ctx, env.membership, env.order.id);
    await supplierCommunications.dispatchAutomaticForOrder(env.db, env.workspace.workspaceId, env.order.id);
    await supplierCommunications.dispatchAutomaticForOrder(env.db, env.workspace.workspaceId, env.order.id);
    assert.equal(sent, 1, 'replaying automatic dispatch does not send a duplicate');
    assert.equal(supplierCommunications.forOrder(env.db, env.workspace.workspaceId, env.order.id)[0].status, 'SENT');
  } finally { gmail.send = originalSend; env.db.close(); }
});

test('PO above the supplier send limit waits in Needs You and sends nothing', async () => {
  const env = setup();
  connectTestGmail(env, { autoSendLimit: 100 });
  const originalSend = gmail.send;
  let sent = 0;
  gmail.send = async () => { sent += 1; return {}; };
  try {
    poService.approve(env.db, env.workspace.ctx, env.membership, env.order.id);
    await supplierCommunications.dispatchAutomaticForOrder(env.db, env.workspace.workspaceId, env.order.id);
    assert.equal(sent, 0);
    assert.equal(supplierCommunications.forOrder(env.db, env.workspace.workspaceId, env.order.id)[0].status, 'QUEUED');
    assert.ok(needsYou.inbox(env.db, env.workspace.workspaceId).some((entry) => entry.id.startsWith('connection:')
      && new RegExp(env.order.poNumber).test(entry.title)));
  } finally { gmail.send = originalSend; env.db.close(); }
});

test('automatic supplier sending refuses missing prices and supplier minimum violations', async (t) => {
  await t.test('missing price', async () => {
    const env = setup();
    connectTestGmail(env);
    env.db.prepare(`UPDATE purchase_order_lines SET unit_cost = NULL, line_total = NULL
      WHERE purchase_order_id = ?`).run(env.order.id);
    const originalSend = gmail.send; let sent = 0;
    gmail.send = async () => { sent += 1; return {}; };
    try {
      poService.approve(env.db, env.workspace.ctx, env.membership, env.order.id);
      await supplierCommunications.dispatchAutomaticForOrder(env.db, env.workspace.workspaceId, env.order.id);
      assert.equal(sent, 0);
      assert.ok(needsYou.inbox(env.db, env.workspace.workspaceId)
        .some((entry) => /needs a price/i.test(entry.title)));
    } finally { gmail.send = originalSend; env.db.close(); }
  });

  await t.test('supplier minimum', async () => {
    const env = setup();
    connectTestGmail(env);
    suppliers.updateSupplier(env.db, env.workspace.ctx, env.membership, env.supplier.id,
      { minimumOrderAmount: 500 });
    const originalSend = gmail.send; let sent = 0;
    gmail.send = async () => { sent += 1; return {}; };
    try {
      poService.approve(env.db, env.workspace.ctx, env.membership, env.order.id);
      await supplierCommunications.dispatchAutomaticForOrder(env.db, env.workspace.workspaceId, env.order.id);
      assert.equal(sent, 0);
      assert.ok(needsYou.inbox(env.db, env.workspace.workspaceId)
        .some((entry) => /below .*minimum order/i.test(entry.title)));
    } finally { gmail.send = originalSend; env.db.close(); }
  });
});

test('paused Foundry cannot send a prepared supplier message', async () => {
  const env = setup();
  connectTestGmail(env);
  poService.approve(env.db, env.workspace.ctx, env.membership, env.order.id);
  modes.pause(env.db, env.workspace.ctx, env.membership, 'Testing the stop boundary.');
  const communication = supplierCommunications.forOrder(env.db, env.workspace.workspaceId, env.order.id)[0];
  await assert.rejects(
    supplierCommunications.sendThroughMailbox(env.db, env.workspace.workspaceId, communication.id, env.workspace.ownerId),
    /paused/i
  );
  assert.notEqual(supplierCommunications.forOrder(env.db, env.workspace.workspaceId, env.order.id)[0].status, 'SENT');
  env.db.close();
});

test('matched supplier evidence appears as meaningful purchasing Activity', () => {
  const env = setup();
  message(env, 'activity-ack-1', `Order acknowledgement ${env.order.poNumber}`, {
    poNumber: env.order.poNumber, lines: [{ supplierSku: 'ABC-BLK-S', confirmedQuantity: 24, unitPrice: 6.5 }],
  });
  const timeline = operationsLog.timeline(env.db, env.workspace.workspaceId, { stream: 'purchasing' });
  const activity = timeline.events.find((entry) => entry.id.startsWith('supplier-document:'));
  assert.match(activity.title, new RegExp(`ABC Apparel.*${env.order.poNumber}`));
  assert.match(activity.detail, /no action is needed/i);
  env.db.close();
});

test('the unattended mailbox scheduler renews an expiring push watch', async () => {
  const env = setup();
  const connectorId = connectTestGmail(env);
  credentials.put(env.db, env.workspace.workspaceId, connectorId, 'provider', {
    accessToken: 'test-token', refreshToken: 'test-refresh', mailbox: 'buyer@example.test',
    expiresAt: Date.now() + 60 * 60_000, deliveryMode: 'push', watchExpiration: Date.now() + 60_000,
  });
  const originalRenew = gmail.renewWebhooks;
  const originalOrigin = process.env.FOUNDRY_PUBLIC_URL;
  let renewed = 0;
  process.env.FOUNDRY_PUBLIC_URL = 'https://foundry.example.test';
  gmail.renewWebhooks = async ({ credentials: current }) => {
    renewed += 1;
    return { credentials: { ...current, watchExpiration: Date.now() + 6 * 24 * 60 * 60_000 } };
  };
  try {
    const result = await providerService.maintainMailboxWatch(env.db, env.workspace.workspaceId, connectorId);
    assert.equal(result.renewed, true);
    assert.equal(renewed, 1);
    assert.ok(Number(credentials.get(env.db, env.workspace.workspaceId, connectorId, 'provider').watchExpiration)
      > Date.now() + 5 * 24 * 60 * 60_000);
  } finally {
    gmail.renewWebhooks = originalRenew;
    if (originalOrigin === undefined) delete process.env.FOUNDRY_PUBLIC_URL;
    else process.env.FOUNDRY_PUBLIC_URL = originalOrigin;
    env.db.close();
  }
});

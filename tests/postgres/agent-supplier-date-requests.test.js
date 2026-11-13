'use strict';

process.env.NODE_ENV = 'test';
process.env.FOUNDRY_PUBLIC_URL = 'https://stockchief.example.test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const dates = require('../../src/purchasing/agent-supplier-date-requests');
const links = require('../../src/purchasing/supplier-order-link');
const jobs = require('../../src/operations/postgres-job-queue');
const ownership = require('../../src/operations/postgres-workflow-ownership');
const outbound = require('../../src/connections/postgres-outbound-mail');
const assistant = require('../../src/assistant/postgres-service');
const modes = require('../../src/autopilot/job-modes');
const { fixture } = require('../helpers/agent-claim-fixture');

test('supplier date requests are gated, taught on Growth, and rechecked before sending', { timeout: 300000 }, async t => {
  const f = await fixture(t, 'growth', { qc: false });
  const { db, ctx, workflows } = f;
  const supplierId = 'fixture-supplier', email = 'damage@example.test';
  await db.query('UPDATE suppliers SET prepare_communications=1 WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId, supplierId]);
  const handlers = require('../../src/operations/postgres-runtime-handlers').create({ get: () => f.provider });
  const kind = 'agent.mail.supplier_date_request.v1';
  const run = (jobKind = kind) => jobs.processOne(db, { [jobKind]: handlers[jobKind] }, { owner: 'supplier-date-requests' });
  const rule = { supplierId, expectedRecipient: email, connectorId: f.connectorId, confirmed: 'yes' };

  async function purchase({ sent = true, supplier = supplierId, recipient = email } = {}) {
    const order = await workflows.createPurchaseOrder(db, ctx, {
      supplierId: supplier, destinationLocationId: f.location.id, idempotencyKey: randomUUID(),
      lines: [{ skuId: f.item.skuIds[0], quantityUnits: 4, unitCost: 1 }],
    });
    const purchaseOrderId = order.purchaseOrderId;
    await workflows.approvePurchaseOrder(db, ctx, purchaseOrderId, { idempotencyKey: randomUUID() });
    await workflows.placePurchaseOrder(db, ctx, purchaseOrderId, { idempotencyKey: randomUUID() });
    if (sent) {
      await db.transaction(c => outbound.queueInTransaction(c, ctx, {
        recipientKind: 'supplier', recipientId: supplier, recipientEmail: recipient, connectorId: f.connectorId,
        purchaseOrderId, subject: 'Purchase order ' + order.poNumber, body: 'Please confirm the order.',
      }, randomUUID()));
      assert.equal((await run('provider.effect')).status, 'COMPLETED');
    }
    const link = await db.transaction(c => links.issue(c, ctx.workspaceId, purchaseOrderId, recipient, process.env.FOUNDRY_PUBLIC_URL));
    const token = new URL(link).pathname.split('/').at(-1);
    await links.submit(db, token, 'confirm', null);
    const work = (await db.query('SELECT id FROM work_items WHERE workspace_id=$1 AND idempotency_key=$2',
      [ctx.workspaceId, 'business-outcome:purchase:' + purchaseOrderId])).rows[0];
    return { id: work.id, token };
  }

  async function refresh(order) {
    await ownership.refresh(db, ctx.workspaceId, order.id);
    const { outcome } = (await db.query('SELECT outcome FROM work_items WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId, order.id])).rows[0];
    return typeof outcome === 'string' ? JSON.parse(outcome) : outcome;
  }

  const first = await purchase();
  await f.subscribe('starter');
  assert.match((await f.browser.get(dates.path).expect(200)).text, /require Growth, Pro or Custom/);
  await assert.rejects(dates.configure(db, ctx, rule), /requires the Growth plan/);
  assert.equal((await refresh(first)).followUps.length, 0);
  assert.equal(await run(), null);

  await f.subscribe('growth');
  await assert.rejects(dates.configure(db, ctx, rule), /approve a matching example/);
  const firstDraft = (await refresh(first)).followUps[0];
  assert(firstDraft?.proposalId);
  assert.equal(await run(), null);
  const approval = await assistant.executeProposal(db, ctx, firstDraft.proposalId);
  assert.equal(await run('agent.mail.purchase_followup.v1'), null);
  const sample = await run();
  assert.equal(sample?.status, 'COMPLETED', JSON.stringify(sample?.lastError));
  assert.match(f.sent.at(-1).body, /expected delivery date for purchase order/);
  const page = await f.browser.get(dates.path + '?supplierId=' + supplierId).expect(200);
  assert.match(page.text, /Approved example from this mailbox/);
  await f.browser.post(dates.path).type('form').send({
    _csrf: f.csrf(page.text), ...rule, exampleId: approval.result.communicationId,
  }).expect(303);

  const next = await purchase();
  const [repeatOutcome] = await Promise.all([refresh(next), refresh(next)]);
  assert(repeatOutcome.followUps[0]?.effectId, JSON.stringify(repeatOutcome));
  const repeated = await run();
  assert.equal(repeated?.status, 'COMPLETED', JSON.stringify(repeated?.lastError));
  assert.match(f.sent.at(-1).body, /expected delivery date for purchase order/);
  assert.equal((await refresh(next)).followUps.length, 1);
  assert.equal(await run(), null);

  const noPrior = await purchase({ sent: false });
  assert.match((await refresh(noPrior)).nextAction, /Send a message about this purchase/);
  assert.equal(await run(), null);
  const outdated = await purchase();
  assert((await refresh(outdated)).followUps[0]?.effectId);
  const before = f.sent.length;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await links.submit(db, outdated.token, 'confirm', tomorrow);
  await run();
  assert.equal(f.sent.length, before);

  await modes.save(db, ctx, dates.job, { mode: 'ask', revision: 0 });
  const ask = await purchase();
  assert((await refresh(ask)).followUps[0]?.proposalId);
  await modes.save(db, ctx, dates.job, { mode: 'watch', revision: 1 });
  const watch = await purchase();
  assert.equal((await refresh(watch)).followUps.length, 0);
  await modes.save(db, ctx, dates.job, { mode: 'inherit', revision: 2 });

  for (const plan of ['pro', 'enterprise']) {
    await f.subscribe(plan);
    const recipient = plan + '@example.test';
    const supplier = await require('../../src/operations/postgres-commerce').createSupplier(db, ctx, {
      name: plan + ' date request supplier', email: recipient, currency: 'USD',
    });
    await dates.configure(db, ctx, { ...rule, supplierId: supplier.id, expectedRecipient: recipient });
    assert.equal((await dates.activeRule(db, ctx.workspaceId, supplier.id)).example_id, null);
    const order = await purchase({ supplier: supplier.id, recipient });
    assert((await refresh(order)).followUps[0]?.effectId);
    assert.equal((await run())?.status, 'COMPLETED');
    assert.equal(f.sent.at(-1).recipient, recipient);
  }

  const downgrade = await purchase();
  assert((await refresh(downgrade)).followUps[0]?.effectId);
  await f.subscribe('starter');
  const preDowngrade = f.sent.length;
  await run();
  assert.equal(f.sent.length, preDowngrade);
});

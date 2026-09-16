'use strict';

/*
 * The money on the document, and the money in the books.
 *
 * A real proforma for 800 pairs of shoes read: $21,390.00 of goods, $5,411.00
 * of sea freight, $83.00 of insurance and $280.00 credited back for samples —
 * $26,604.00, exactly the total the document itself stated. StockChief read all
 * four lines, showed all four on the proposal screen, posted the goods, and
 * dropped the other $5,214.00: the only place it knew how to keep a charge
 * was on a purchase order, and "this is stock I already have" creates none.
 *
 * The owner saw an inventory value five thousand dollars short of what they
 * had paid, next to an Expenses section that said nothing at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { fakeProvider } = require('../helpers/fake-provider');
const { makeDatabase, cleanupAll, seedWorkspace, signIn, csrfFrom, plain } = require('../helpers');
const authService = require('../../src/domain/auth-service');
const documentCosts = require('../../src/accounting/document-costs');
const ledger = require('../../src/accounting/ledger');
const reports = require('../../src/accounting/reports');
const { newId, nowIso } = require('../../src/lib/util');

test.after(cleanupAll);

const TODAY = new Date().toISOString().slice(0, 10);

/** The charges exactly as they came off the real proforma. */
const CHARGES = [
  { label: 'Sea freight for 800 pairs DDP to door', kind: 'freight', amountMinor: 541100 },
  { label: 'Insurance', kind: 'insurance', amountMinor: 8300 },
  { label: 'Deducted 8 pairs sample cost', kind: 'discount', amountMinor: -28000 },
];

async function setup() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'HalFi Shoes' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  require('../../src/accounting/automatic').ensure(store.db, workspace.workspaceId, { actorId: workspace.ctx.actorId });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'doc-costs', aiProvider: fakeProvider({}) });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  return { ...store, workspace, ctx: workspace.ctx, membership, agent };
}

/** An applied opening-stock document, the way the real import left one. */
function appliedProforma(env, { charges = CHARGES, openingStock = true } = {}) {
  const id = newId('sdoc');
  const interpretation = {
    documentNumber: '2026042902PI', supplierName: 'Chongqing Langchi Shoes Co., Ltd.',
    currency: 'USD', documentDate: TODAY, charges, documentTotalMinor: 2660400,
  };
  const result = {
    products: 5, variants: 47, openingStock, units: 800, openingValueMinor: 2139000,
    charges, documentTotalMinor: 2660400, supplier: 'Chongqing Langchi Shoes Co., Ltd.',
  };
  env.db.prepare(`INSERT INTO setup_documents
      (id, workspace_id, uploaded_by_user_id, source_name, source_mime, source_content,
       extracted_text, content_hash, interpretation, result, status, created_at, applied_at)
    VALUES (?, ?, ?, ?, 'application/pdf', ?, ?, ?, ?, ?, 'APPLIED', ?, ?)`)
    .run(id, env.workspace.workspaceId, env.ctx.actorId, 'PI-2026042902PI.pdf',
      Buffer.from('proforma'), 'Proforma invoice 2026042902PI',
      `hash-${id}`, JSON.stringify(interpretation), JSON.stringify(result), nowIso(), nowIso());
  return id;
}

test('every charge on the document is kept, and adds up to the total the document states', async () => {
  const env = await setup();
  appliedProforma(env);
  documentCosts.backfill(env.db, env.workspace.workspaceId);

  const [doc] = documentCosts.forWorkspace(env.db, env.workspace.workspaceId);
  assert.equal(doc.documentNumber, '2026042902PI');
  assert.equal(doc.goodsMinor, 2139000, 'the goods');
  assert.equal(doc.chargesMinor, 521400, 'freight plus insurance less the sample credit');
  assert.equal(doc.addsUpMinor, 2660400);
  assert.equal(doc.differsFromStatedMinor, 0, 'and it matches what the document itself totals');
  assert.deepEqual(doc.charges.map((c) => c.label), CHARGES.map((c) => c.label),
    'in the document’s own words, in its own order');
  assert.equal(doc.unrecordedMinor, 521400, 'none of it is in the books yet');
  env.db.close();
});

test('nothing is spread across the products, and nothing is posted on its own', async () => {
  const env = await setup();
  appliedProforma(env);
  documentCosts.backfill(env.db, env.workspace.workspaceId);

  const posted = env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_journal_entries
    WHERE workspace_id = ?`).get(env.workspace.workspaceId).n;
  assert.equal(posted, 0, 'reading a charge is not recording it');
  const [doc] = documentCosts.forWorkspace(env.db, env.workspace.workspaceId);
  for (const charge of doc.charges) {
    assert.equal(charge.status, 'UNRECORDED');
    assert.ok(CHARGES.some((c) => c.amountMinor === charge.amountMinor),
      'the amount is the document’s, not a share of it divided by 800');
  }
  env.db.close();
});

test('backfilling twice does not double the freight', async () => {
  const env = await setup();
  appliedProforma(env);
  documentCosts.backfill(env.db, env.workspace.workspaceId);
  documentCosts.backfill(env.db, env.workspace.workspaceId);
  const [doc] = documentCosts.forWorkspace(env.db, env.workspace.workspaceId);
  assert.equal(doc.charges.length, 3);
  assert.equal(doc.chargesMinor, 521400);
  env.db.close();
});

test('recorded as expenses, the money reaches the books in the accounts it belongs to', async () => {
  const env = await setup();
  const documentId = appliedProforma(env);
  documentCosts.backfill(env.db, env.workspace.workspaceId);

  const done = documentCosts.settle(env.db, env.ctx, env.membership,
    { documentId, treatment: 'expense' });
  assert.equal(done.netMinor, 521400);

  const lines = env.db.prepare(`SELECT jl.debit_minor, jl.credit_minor, aa.system_key
    FROM accounting_journal_lines jl JOIN accounting_accounts aa ON aa.id = jl.account_id
    WHERE jl.entry_id = ?`).all(done.entry.id);
  const by = (key) => lines.find((line) => line.system_key === key);
  assert.equal(by('SHIPPING_EXPENSE').debit_minor, 541100, 'freight is shipping');
  assert.equal(by('INSURANCE_EXPENSE').debit_minor, 8300, 'insurance is insurance');
  assert.equal(by('OPERATING_EXPENSE').credit_minor, 28000,
    'a credit on the document reduces the cost rather than becoming income');
  assert.equal(by('OPENING_BALANCE_EQUITY').credit_minor, 521400,
    'against the same equity the goods on this document went to');

  const debits = lines.reduce((sum, line) => sum + line.debit_minor, 0);
  const credits = lines.reduce((sum, line) => sum + line.credit_minor, 0);
  assert.equal(debits, credits, 'and it balances');

  assert.equal(documentCosts.unrecordedTotal(env.db, env.workspace.workspaceId).amountMinor, 0);
  env.db.close();
});

test('recorded as part of what the stock cost, it lands in inventory value instead', async () => {
  const env = await setup();
  const documentId = appliedProforma(env);
  documentCosts.backfill(env.db, env.workspace.workspaceId);

  const done = documentCosts.settle(env.db, env.ctx, env.membership,
    { documentId, treatment: 'stock_value' });
  const lines = env.db.prepare(`SELECT jl.debit_minor, jl.credit_minor, aa.system_key
    FROM accounting_journal_lines jl JOIN accounting_accounts aa ON aa.id = jl.account_id
    WHERE jl.entry_id = ?`).all(done.entry.id);
  const inventory = lines.filter((line) => line.system_key === 'INVENTORY_ASSET');
  const net = inventory.reduce((sum, line) => sum + line.debit_minor - line.credit_minor, 0);
  assert.equal(net, 521400, 'the whole $5,214.00 is what the stock cost');
  assert.equal(lines.find((line) => line.system_key === 'OPENING_BALANCE_EQUITY').credit_minor, 521400);

  const balance = reports.balanceSheet(env.db, env.workspace.workspaceId, { asOf: TODAY });
  const held = balance.assets.find((a) => a.system_key === 'INVENTORY_ASSET');
  assert.equal(held.net_minor, 521400, 'and the balance sheet shows it');
  env.db.close();
});

test('the same decision twice records it once', async () => {
  const env = await setup();
  const documentId = appliedProforma(env);
  documentCosts.backfill(env.db, env.workspace.workspaceId);
  documentCosts.settle(env.db, env.ctx, env.membership, { documentId, treatment: 'expense' });
  assert.throws(() => documentCosts.settle(env.db, env.ctx, env.membership,
    { documentId, treatment: 'expense' }), /already been recorded/i);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_journal_entries
    WHERE workspace_id = ?`).get(env.workspace.workspaceId).n, 1);
  env.db.close();
});

test('charges on a document that made a purchase order are not posted a second time', async () => {
  /*
   * They already ride on that order and reach the books through the
   * supplier's bill. Posting them here as well would count the same freight
   * twice, which is the failure this whole file exists to stop.
   */
  const env = await setup();
  const documentId = appliedProforma(env, { openingStock: false });
  documentCosts.backfill(env.db, env.workspace.workspaceId);
  assert.throws(() => documentCosts.settle(env.db, env.ctx, env.membership,
    { documentId, treatment: 'expense' }), /already carried on the purchase order/i);
  env.db.close();
});

test('the Money page shows the breakdown, the shortfall, and the choice', async () => {
  const env = await setup();
  appliedProforma(env);

  const page = await env.agent.get('/money');
  assert.equal(page.status, 200);
  const text = plain(page.text);

  assert.match(text, /\$5,214\.00 read off your documents and not in your books/);
  assert.match(text, /Sea freight for 800 pairs DDP to door/);
  assert.match(text, /\$5,411\.00/);
  assert.match(text, /Insurance/);
  assert.match(text, /\$83\.00/);
  assert.match(text, /Deducted 8 pairs sample cost/);
  assert.match(text, /\$26,604\.00/, 'and what the document totals');
  assert.match(text, /Part of what this stock cost/);
  assert.match(text, /A separate expense/);

  // Chosen from the page, it posts and says so.
  const chosen = await env.agent.post(`/accounting/document-costs/${
    documentCosts.forWorkspace(env.db, env.workspace.workspaceId)[0].documentId}`)
    .type('form').send({ _csrf: csrfFrom(page.text), treatment: 'expense' });
  assert.equal(chosen.status, 303);
  const after = plain((await env.agent.get('/money')).text);
  assert.match(after, /Every cost on your documents is in your books/);
  assert.match(after, /recorded as an expense/);
  env.db.close();
});

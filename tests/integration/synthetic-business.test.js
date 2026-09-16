'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const dataMode = require('../../src/synthetic/data-mode');
const requestSpec = require('../../src/synthetic/request-spec');
const { makeDatabase, cleanupAll, seedWorkspace, csrfFrom, plain, signIn } = require('../helpers');
const { fakeUnderstandingProvider, buildUnderstanding } = require('../helpers/fake-provider');

test.after(cleanupAll);

const EXACT_REQUEST = 'Create a realistic established company with 400 products, 2,000 SKUs, 20 suppliers and 12 months of realistic operating history. It should feel like a real company, not toy data.';
const REAL_BUSINESS_REQUEST = `I run a footwear and apparel business. We sell shoes, shirts, pants, jackets and accessories in different sizes, colors and styles.

We currently keep inventory in a main warehouse and several stores. I want StockChief to help me properly set up and manage the entire operation, including products, stock, purchasing, suppliers, transfers between locations, sales, receiving and replenishment.

I don't have everything organized perfectly yet. Walk me through what you need from me, figure out what you safely can from the information I provide, and don't make me answer questions that aren't necessary yet.

I want StockChief eventually handling as much routine inventory work as possible, but never invent real business facts that I haven't provided.`;
const AMBIGUOUS_TYPED_RECORDS = 'I sell shoes, loafer size 35 38, foe size 35, 20, quantity for lafoer both siezes, 30 quantity for foe both sizes 15';

async function post(agent, path, body, formPath) {
  const page = await agent.get(formPath);
  return agent.post(path).type('form').send({ _csrf: csrfFrom(page.text), ...body });
}

async function understand(agent, description) {
  const started = await post(agent, '/foundry/understand', { description }, '/foundry/describe');
  assert.equal(started.status, 303);
  const jobId = started.headers.location.split('/').pop();
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = await agent.get(`/api/foundry/jobs/${jobId}`).set('Accept', 'application/json');
    if (status.body.redirectTo) return status.body.redirectTo;
    if (status.body.status === 'failed') throw new Error(status.body.error);
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('synthetic understanding job did not finish');
}

test('range requests use representative midpoints instead of every lower bound', () => {
  assert.deepEqual(requestSpec.parse('Generate 300-500 products, 1,500-2,500 SKUs, 10-30 suppliers and 6-12 months of history.'), {
    products: 400, skus: 2000, suppliers: 20, historyMonths: 9,
  });
});

test('production mode remains authoritative even if a request asks for generated records', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  assert.deepEqual(dataMode.context(db, workspace.workspaceId, EXACT_REQUEST), {
    mode: 'production', allowed: false, reason: 'production_workspace_requires_evidence',
  });
});

test('Test environment authority does not depend on synthetic keywords', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  db.prepare("UPDATE workspaces SET data_mode = 'synthetic' WHERE id = ?").run(workspace.workspaceId);
  assert.deepEqual(dataMode.context(db, workspace.workspaceId, 'Make it behave like an established real company.'), {
    mode: 'synthetic', allowed: true, reason: 'synthetic_workspace_setup',
  });
});

test('an explicitly created Test environment keeps realistic synthetic intent through execution', { timeout: 240000 }, async () => {
  const store = makeDatabase();
  const first = seedWorkspace(store.db, { workspaceName: 'Real Business' });
  const provider = fakeUnderstandingProvider(buildUnderstanding({
    businessDescription: EXACT_REQUEST,
    likelyLocations: [{ name: 'Main Warehouse', kind: 'warehouse', certainty: 'inferred_confidently' }],
  }));
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'synthetic-authority', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, first.account.email, first.account.password);

  const created = await post(agent, '/inventories', { name: 'Scale Rehearsal', dataMode: 'synthetic' }, '/inventories/new');
  assert.equal(created.status, 303);
  const workspace = store.db.prepare("SELECT * FROM workspaces WHERE name = 'Scale Rehearsal'").get();
  assert.equal(workspace.data_mode, 'synthetic', 'the workspace row, not request wording, owns the mode');

  const proposalUrl = await understand(agent, EXACT_REQUEST);
  const proposal = await agent.get(proposalUrl);
  const proposalText = plain(proposal.text);
  assert.match(proposalText, /This is a synthetic test environment/);
  assert.match(proposalText, /Configure structure and generate synthetic data/);
  assert.doesNotMatch(proposalText, /no products, stock or serial numbers are invented/i);
  assert.match(provider.calls[0].system, /WORKSPACE EXECUTION MODE \(authoritative\): synthetic/);

  const configured = await agent.post(`${proposalUrl}/configure`).type('form')
    .send({ _csrf: csrfFrom(proposal.text) });
  assert.equal(configured.status, 303);
  if (!/\/foundry\/ready\//.test(configured.headers.location || '')) {
    const failed = plain((await agent.get(configured.headers.location)).text);
    assert.fail(`configuration returned to ${configured.headers.location}: ${failed.slice(0, 1200)}`);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(workspace.id).n, 400);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ?').get(workspace.id).n, 2000);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM suppliers WHERE workspace_id = ?').get(workspace.id).n, 20);
  assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(workspace.id).n >= 2000);
  assert.equal(store.db.prepare('SELECT data_mode FROM workspaces WHERE id = ?').get(workspace.id).data_mode, 'synthetic');
});

test('real-business onboarding grounds facts and asks for source records before reversible settings', { timeout: 30000 }, async () => {
  const store = makeDatabase();
  const seeded = seedWorkspace(store.db, { workspaceName: 'Footwear Business' });
  const provider = fakeUnderstandingProvider(buildUnderstanding({
    businessType: 'Footwear and apparel retail',
    inventoryExamples: ['Shoes', 'Shirts', 'Pants', 'Jackets', 'Accessories'],
    variantDimensions: [
      { name: 'Size', exampleValues: ['S', 'M', 'L', 'XL', 'US 9', 'US 10'] },
      { name: 'Color', exampleValues: ['Black', 'White', 'Navy'] },
      { name: 'Style', exampleValues: ['Slim fit', 'Regular fit', 'High-top', 'Low-top'] },
    ],
    locationModel: {
      summary: 'One warehouse and two stores.', multipleLocations: true,
      transfersExpected: true, certainty: 'inferred_confidently',
    },
    likelyLocations: [
      { name: 'Main Warehouse', kind: 'warehouse', certainty: 'inferred_confidently' },
      { name: 'Store 1', kind: 'store', certainty: 'assumed_safely' },
      { name: 'Store 2', kind: 'store', certainty: 'assumed_safely' },
    ],
    recommendedConfiguration: {
      trackingMode: 'quantity', usesVariants: true, allowNegativeStock: false,
      summary: 'Size, color and style variants across three locations.',
    },
  }));
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'real-grounding', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, seeded.account.email, seeded.account.password);

  const proposalPath = await understand(agent, REAL_BUSINESS_REQUEST);
  const proposal = await agent.get(proposalPath);
  assert.equal(proposal.status, 200);
  const text = plain(proposal.text);
  assert.match(text, /What StockChief understood/i);
  assert.match(text, /What StockChief needs next/i);
  assert.match(text, /Where are your real product and stock records today/i);
  assert.match(text, /You do not need to clean or reorganize anything first/i);
  assert.match(text, /Enter records in StockChief/i);
  assert.match(text, /Upload inventory files/i);
  assert.match(text, /Connect a business system/i);
  assert.match(text, /Use email attachments/i);
  assert.doesNotMatch(text, /Choose where my records are/i);
  assert.match(proposal.text, /<summary>What StockChief knows \/ Why StockChief decided this<\/summary>/i);
  assert.doesNotMatch(proposal.text, /<details[^>]*open[^>]*>[^]*What StockChief knows \/ Why StockChief decided this/i);
  assert.doesNotMatch(text, /Save the safe structure|Choose where my records are/i);
  assert.match(text, /Verified fact/i);
  assert.match(text, /Safe structural inference/i);
  assert.match(text, /Provisional default/i);
  assert.match(text, /Missing business fact/i);
  assert.match(text, /Authority decision/i);
  assert.doesNotMatch(text, /Store 1|Store 2|US 9|US 10|Black, White, Navy|Slim fit|High-top/i);
  assert.doesNotMatch(text, /Should any locations|Do any product lines need batch/i);

  const stored = store.db.prepare('SELECT payload FROM foundry_understandings WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(seeded.workspaceId);
  const understanding = JSON.parse(stored.payload);
  assert.deepEqual(understanding.likelyLocations.map((location) => location.name), [],
    '"a main warehouse" establishes structure but is not a verified business name');
  assert.equal(understanding.locationModel.multipleLocations, true);
  assert.ok(understanding.variantDimensions.every((dimension) => dimension.exampleValues.length === 0));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(seeded.workspaceId).n, 0);
});

test('a contradictory model flag cannot turn a business description into owner inventory records', { timeout: 30000 }, async () => {
  const description = "We wholesale children's shoes. Every style comes in colors and sizes. We keep stock in Brooklyn and New Jersey.";
  const store = makeDatabase();
  const seeded = seedWorkspace(store.db, { workspaceName: 'Description Is Not Stock' });
  const provider = fakeUnderstandingProvider(buildUnderstanding({
    businessDescription: description,
    ownerProvidedInventory: {
      hasRecords: true,
      lines: [],
      ambiguities: ['No specific product, variant value, quantity, or location record was supplied.'],
    },
    recommendedConfiguration: {
      trackingMode: 'quantity', usesVariants: true, allowNegativeStock: false,
      summary: 'Products require color and size variant support.',
    },
  }));
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'description-not-records', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, seeded.account.email, seeded.account.password);

  const proposalPath = await understand(agent, description);
  const text = plain((await agent.get(proposalPath)).text);
  assert.match(text, /Where are your real product and stock records today/i);
  assert.match(text, /Enter records in StockChief/i);
  assert.match(text, /Upload inventory files/i);
  assert.match(text, /Connect a business system/i);
  assert.match(text, /Use email attachments/i);
  assert.doesNotMatch(text, /Choose where my records are/i);
  assert.doesNotMatch(text, /You entered inventory records here|Create these exact inventory records/i);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(seeded.workspaceId).n, 0);
});

test('typed owner inventory is evidence and asks only for genuinely unclear details', { timeout: 30000 }, async () => {
  const store = makeDatabase();
  const seeded = seedWorkspace(store.db, { workspaceName: 'Typed Inventory' });
  const provider = fakeUnderstandingProvider(buildUnderstanding({
    businessDescription: AMBIGUOUS_TYPED_RECORDS,
    inventoryExamples: ['shoes', 'loafer', 'foe'],
    ownerProvidedInventory: {
      hasRecords: true,
      lines: [
        { productName: 'loafer', variantLabel: '35', quantity: 0, quantityKnown: false, locationName: '', sourceText: 'loafer size 35 38' },
        { productName: 'loafer', variantLabel: '38', quantity: 0, quantityKnown: false, locationName: '', sourceText: 'loafer size 35 38' },
        { productName: 'foe', variantLabel: '35', quantity: 0, quantityKnown: false, locationName: '', sourceText: 'foe size 35' },
      ],
      ambiguities: [
        'Confirm whether “foe” is the intended product name.',
        'Confirm which quantities belong to each size and whether they are totals or per-size quantities.',
      ],
    },
    variantDimensions: [{ name: 'size', exampleValues: ['35', '38'] }],
    likelyLocations: [],
    recommendedConfiguration: {
      trackingMode: 'quantity', usesVariants: true, allowNegativeStock: false,
      summary: 'Products are counted separately by size.',
    },
  }));
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'typed-ambiguous', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, seeded.account.email, seeded.account.password);

  const proposalPath = await understand(agent, AMBIGUOUS_TYPED_RECORDS);
  const proposal = await agent.get(proposalPath);
  const text = plain(proposal.text);
  assert.match(text, /You entered inventory records here/i);
  assert.match(text, /Your message is the source/i);
  assert.match(text, /did not guess the unclear parts/i);
  assert.match(text, /whether “foe” is the intended product name/i);
  assert.match(text, /Quantity physically on hand/i);
  assert.match(text, /Where it is/i);
  assert.match(text, /Create these exact inventory records/i);
  assert.doesNotMatch(text, /Where are your real product and stock records today/i);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(seeded.workspaceId).n, 0);
});

test('clear typed owner inventory creates only the approved products variants and opening stock', { timeout: 30000 }, async () => {
  const description = 'I have Loafer size 35: 20 units and Loafer size 38: 30 units at Main Warehouse.';
  const store = makeDatabase();
  const seeded = seedWorkspace(store.db, { workspaceName: 'Clear Typed Inventory' });
  const provider = fakeUnderstandingProvider(buildUnderstanding({
    businessDescription: description,
    inventoryExamples: ['Loafer'],
    ownerProvidedInventory: {
      hasRecords: true,
      lines: [
        { productName: 'Loafer', variantLabel: '35', quantity: 20, quantityKnown: true, locationName: 'Main Warehouse', sourceText: 'Loafer size 35: 20 units' },
        { productName: 'Loafer', variantLabel: '38', quantity: 30, quantityKnown: true, locationName: 'Main Warehouse', sourceText: 'Loafer size 38: 30 units at Main Warehouse' },
      ],
      ambiguities: [],
    },
    variantDimensions: [{ name: 'Size', exampleValues: ['35', '38'] }],
    likelyLocations: [{ name: 'Main Warehouse', kind: 'warehouse', certainty: 'verified_fact' }],
    recommendedConfiguration: {
      trackingMode: 'quantity', usesVariants: true, allowNegativeStock: false,
      summary: 'Loafers are counted separately by size.',
    },
  }));
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'typed-clear', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, seeded.account.email, seeded.account.password);

  const proposalPath = await understand(agent, description);
  const proposal = await agent.get(proposalPath);
  assert.match(plain(proposal.text), /Review the exact inventory records you gave StockChief/i);
  const configured = await agent.post(`${proposalPath}/configure`).type('form').send({
    _csrf: csrfFrom(proposal.text), owner_records_present: '1', owner_record_count: '2',
    owner_product_0: 'Loafer', owner_variant_0: '35', owner_quantity_0: '20', owner_location_0: 'Main Warehouse',
    owner_product_1: 'Loafer', owner_variant_1: '38', owner_quantity_1: '30', owner_location_1: 'Main Warehouse',
  });
  assert.equal(configured.status, 303);
  assert.match(configured.headers.location, /\/foundry\/ready\//);
  const ready = await agent.get(configured.headers.location);
  assert.match(plain(ready.text), /1 product and 2 variants created exactly as approved/i);
  assert.match(plain(ready.text), /50 units recorded as opening stock/i);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(seeded.workspaceId).n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ?').get(seeded.workspaceId).n, 2);
  assert.equal(store.db.prepare('SELECT SUM(on_hand) AS n FROM balances WHERE workspace_id = ?').get(seeded.workspaceId).n, 50);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(seeded.workspaceId).n, 2);
});

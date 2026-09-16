'use strict';

/**
 * StockChief over HTTP: the first-run experience, authorization, the approval
 * flow, refresh recovery, and change management.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const planApplier = require('../../src/foundry/plan-applier');
const onboardingPaths = require('../../src/onboarding/paths');
const repo = require('../../src/domain/repository');
const { openDatabase } = require('../../src/db');
const { makeDatabase, cleanupAll, seedWorkspace, csrfFrom, plain, signIn } = require('../helpers');
const {
  fakeProvider,
  fakeUnderstandingProvider,
  buildUnderstanding,
  buildQuestion,
} = require('../helpers/fake-provider');

test.after(cleanupAll);

const SHOE_UNDERSTANDING = buildUnderstanding({
  businessDescription: "We wholesale children's shoes in colors Navy and Cream, sizes 4 and 5, at Brooklyn Warehouse and New Jersey Warehouse.",
  variantDimensions: [
    { name: 'Color', exampleValues: ['Navy', 'Cream'] },
    { name: 'Size', exampleValues: ['4', '5'] },
  ],
  likelyLocations: [
    { name: 'Brooklyn Warehouse', kind: 'warehouse', certainty: 'inferred_confidently' },
    { name: 'New Jersey Warehouse', kind: 'warehouse', certainty: 'inferred_confidently' },
  ],
  locationModel: { summary: 'Two warehouses.', multipleLocations: true, transfersExpected: true, certainty: 'inferred_confidently' },
  terminology: { item: 'Style', location: 'Warehouse', serialUnit: '', lot: '', variant: '' },
  recommendedConfiguration: {
    trackingMode: 'quantity',
    usesVariants: true,
    allowNegativeStock: false,
    summary: 'Each colour and size is counted separately at each warehouse.',
  },
  unresolvedDecisions: [buildQuestion()],
  recommendations: [
    {
      title: 'Track low stock by size',
      noticed: 'You sell each style in several sizes.',
      recommendation: 'Watch stock at the size level, not the style level.',
      whyItMatters: 'A style can look healthy while the sizes people buy are gone.',
      scope: 'configuration',
      confidence: 'high',
    },
  ],
});

function setup({ provider, empty = true } = {}) {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  if (empty) {
    // A fresh StockChief workspace: drop the locations seedWorkspace creates.
    store.db.prepare('DELETE FROM locations WHERE workspace_id = ?').run(workspace.workspaceId);
  }
  const app = createApp({
    db: store.db,
    env: 'test',
    sessionSecret: 'foundry-http-test',
    aiProvider: provider || fakeUnderstandingProvider(SHOE_UNDERSTANDING),
  });
  return { ...store, workspace, app };
}

async function post(agent, path, body, formPath) {
  const page = await agent.get(formPath);
  return agent.post(path).type('form').send({ _csrf: csrfFrom(page.text), ...body });
}

/**
 * Reading a business is a background job now, so tests follow it the way the
 * browser does: post, land on the progress page, poll until it redirects.
 */
/**
 * Answers the three understanding passes from the shoe fixture, and anything
 * else with the response the test is really about.
 */
function understandingThen(request, other) {
  if (request.schemaName === 'inventory_understanding_records') {
    return { ownerProvidedInventory: { hasRecords: false, lines: [], ambiguities: [] } };
  }
  if (request.schemaName === 'inventory_understanding_advice') {
    return {
      statedRequirements: SHOE_UNDERSTANDING.statedRequirements,
      recommendations: SHOE_UNDERSTANDING.recommendations,
      unresolvedDecisions: [],
    };
  }
  if (request.schemaName === 'inventory_understanding_core') {
    const {
      statedRequirements, recommendations, unresolvedDecisions, ownerProvidedInventory, ...core
    } = SHOE_UNDERSTANDING;
    return core;
  }
  return other;
}

async function understand(agent, description = 'We wholesale shoes in colors Navy and Cream, sizes 4 and 5, at Brooklyn Warehouse and New Jersey Warehouse.') {
  const started = await post(agent, '/foundry/understand', { description }, '/foundry/describe');
  if (started.status !== 303) return started;
  assert.match(started.headers.location, /^\/foundry\/thinking\//, 'the POST must not block');

  const jobId = started.headers.location.split('/').pop();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await agent.get(`/api/foundry/jobs/${jobId}`).set('Accept', 'application/json');
    if (status.body.redirectTo) {
      return { status: 303, headers: { location: status.body.redirectTo }, jobId };
    }
    if (status.body.status === 'failed') return { status: 400, jobId, error: status.body.error };
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('job never finished');
}

test('a new account is handed to StockChief, not an empty dashboard', async () => {
  const { app, workspace } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  // Overview answers for itself now — it says the inventory is empty and
  // points at StockChief, rather than silently sending you there.
  const home = await agent.get('/');
  assert.equal(home.status, 200);
  assert.match(plain(home.text), /This inventory is empty/);
  assert.match(plain(home.text), /Set it up with StockChief/);

  // The first decision is now how they manage inventory today. Sending someone
  // with a spreadsheet straight to "describe your business" was asking them to
  // retype what their file already says.
  const front = await agent.get('/foundry');
  assert.equal(front.status, 303);
  assert.equal(front.headers.location, '/onboarding');

  const chooser = plain((await agent.get('/onboarding')).text);
  assert.match(chooser, /Where should StockChief get your inventory from/);
  assert.match(chooser, /Enter it in StockChief/);
  assert.match(chooser, /Move from files/);
  assert.match(chooser, /maps and reconciles them before cutover/);
  assert.match(chooser, /Connect another system/);
  assert.match(chooser, /Use several sources/);

  // Starting Fresh is the Mission 2 experience, reached deliberately and
  // otherwise unchanged.
  const describe = plain((await agent.get('/foundry/describe')).text);
  assert.match(describe, /Give StockChief what you already have/);
  assert.match(describe, /Understand my inventory/);
  assert.match(describe, /Set it up manually/);
});

test('the whole approval flow works end to end over HTTP', async () => {
  const { app, db, workspace } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const understood = await understand(
    agent,
    "We wholesale children's shoes in colors Navy and Cream, sizes 4 and 5, at Brooklyn Warehouse and New Jersey Warehouse."
  );
  assert.equal(understood.status, 303);
  assert.match(understood.headers.location, /^\/foundry\/proposal\//);

  const proposalPath = understood.headers.location;
  const proposal = plain((await agent.get(proposalPath)).text);
  assert.match(proposal, /Here's how I'd organize your inventory/);
  assert.match(proposal, /Color → Size|Color/);
  assert.match(proposal, /Brooklyn Warehouse/);
  assert.match(proposal, /New Jersey Warehouse/);
  assert.match(proposal, /Where are your real product and stock records today/);
  assert.doesNotMatch(proposal, /One thing worth deciding|Let StockChief decide/);
  assert.match(proposal, /What StockChief understood/);
  assert.match(proposal, /What StockChief needs next/);
  assert.match(proposal, /Enter records in StockChief/);
  assert.match(proposal, /Upload inventory files/);
  assert.match(proposal, /Connect a business system/);
  assert.match(proposal, /Use email attachments/);
  assert.doesNotMatch(proposal, /Choose where my records are/);
  assert.match(proposal, /What StockChief knows \/ Why StockChief decided this/);
  assert.doesNotMatch(proposal, /What starts working after this setup|Save the safe structure/);

  const understandingId = proposalPath.split('/').pop();
  const configured = await post(
    agent,
    `/foundry/proposal/${understandingId}/configure`,
    {},
    proposalPath
  );
  assert.equal(configured.status, 303);
  assert.match(configured.headers.location, /^\/foundry\/ready\//);

  const ready = plain((await agent.get(configured.headers.location)).text);
  assert.match(ready, /Your inventory setup is ready/);
  assert.match(ready, /No products or stock were created/);
  assert.match(ready, /Next: add your products and starting quantities/);
  assert.match(ready, /2 warehouses configured/);
  assert.match(ready, /Physical adjustments require a reason/);

  // The engine really was configured.
  const configuration = planApplier.getConfiguration(db, workspace.workspaceId);
  assert.equal(configuration.configurationVersion, 1);
  assert.equal(configuration.terminology.location, 'Warehouse');
  assert.deepEqual(
    repo.listLocations(db, workspace.workspaceId).map((l) => l.name).sort(),
    ['Brooklyn Warehouse', 'New Jersey Warehouse']
  );
  // The reversible safe default was applied without interrogating the owner.
  assert.equal(configuration.operationalDefaults.allowNegativeStock, false);

  const staleDescribe = await agent.get('/foundry/describe');
  assert.equal(staleDescribe.status, 303);
  assert.equal(staleDescribe.headers.location, '/inventory/describe');

  const emptyInventory = await agent.get('/inventory/table');
  const emptyText = plain(emptyInventory.text);
  assert.match(emptyText, /Your setup is ready\. Now add your products/);
  assert.match(emptyInventory.text, /href="\/inventory\/describe"/);
  assert.match(emptyText, /Tell StockChief what you sell/);
  assert.match(emptyInventory.text, /href="\/inventory\/new">Add one manually/);

  const configuredHome = plain((await agent.get('/foundry')).text);
  assert.match(configuredHome, /Setup is finished\. Your products are the next step/);
});

test('a reviewed proposal continues directly to every chosen record source without losing its description', async () => {
  const cases = [
    ['spreadsheet', '/onboarding/migrations/new', 'spreadsheet'],
    ['software', '/onboarding/system', 'software'],
    ['mailbox', '/onboarding/mailbox', 'undecided'],
  ];

  for (const [choice, destination, storedPath] of cases) {
    const { app, db, workspace } = setup();
    const agent = request.agent(app);
    await signIn(agent, workspace.account.email, workspace.account.password);

    const description = `We wholesale shoes; continue using the ${choice} source.`;
    const understood = await understand(agent, description);
    const proposalPath = understood.headers.location;
    const understandingId = proposalPath.split('/').pop();
    const selected = await post(
      agent,
      `/foundry/proposal/${understandingId}/source`,
      { recordSource: choice },
      proposalPath
    );

    assert.equal(selected.status, 303);
    assert.equal(selected.headers.location, destination);
    const state = onboardingPaths.get(db, workspace.workspaceId);
    assert.equal(state.path, storedPath);
    assert.equal(state.status, 'collecting');
    assert.equal(state.describedAs, description);
  }
});

test('proposal never silently drops a stated requirement that is outside configured axes', async () => {
  const description = [
    'We sell general merchandise with multiple products and SKUs.',
    'Products can have variants such as Size, Color, Material, and customization options.',
    'We keep inventory in multiple locations.',
    'We must preserve supplier-provided compliance certificates and require customer approval before customized orders are released.',
  ].join(' ');
  const interpreted = buildUnderstanding({
    businessDescription: description,
    variantDimensions: [
      { name: 'Size', exampleValues: [] },
      { name: 'Color', exampleValues: [] },
      { name: 'Material', exampleValues: [] },
    ],
    recommendedConfiguration: {
      trackingMode: 'quantity', usesVariants: true, allowNegativeStock: false,
      summary: 'StockChief can support Size, Color, Material variants.',
    },
    statedRequirements: [
      {
        sourceText: 'customization options',
        understanding: 'Products also need customization choices.',
        semanticRole: 'resolvable_requirement',
        status: 'needs_detail',
        nextStep: 'Provide the actual customization fields.',
      },
    ],
  });
  const { app, workspace } = setup({ provider: fakeUnderstandingProvider(interpreted) });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const understood = await understand(agent, description);
  const response = await agent.get(understood.headers.location);
  const proposal = plain(response.text);

  assert.match(proposal, /Review the exact requirement mapping \(\d+\)/);
  assert.match(proposal, /Every citation comes from your words/i);
  assert.match(proposal, /All \d+ explicit statements are preserved and sorted by purpose below/i);
  assert.match(proposal, /Ready to support|Needs information from your records/);
  assert.match(response.text, /<summary>What you told StockChief<\/summary>/);
  assert.doesNotMatch(response.text, /<details[^>]*open[^>]*>\s*<summary>What you told StockChief/i);
  assert.match(response.text, /<details class="rm-work" style="margin:0">\s*<summary>[\s\S]*?Needs information from your records/);
  assert.doesNotMatch(response.text, /<details[^>]*open[^>]*>\s*<summary>[\s\S]*?Needs information from your records/i);
  assert.match(proposal, /You do not confirm these in this list/);
  assert.match(proposal, /Context and instructions/);
  assert.match(proposal, /Nothing here needs confirmation/);
  assert.match(response.text, /href="#record-source-choices"/);
  assert.match(response.text, /id="record-source-choices"/);
  assert.match(proposal, /Size, Color, Material, and customization options/);
  assert.match(proposal, /Products also need customization choices/);
  assert.match(proposal, /supplier-provided compliance certificates and require customer approval before customized orders are released/);
  assert.match(proposal, /Needs information/);
  assert.doesNotMatch(proposal, /biometric chain of custody/);
});

test('a first stock report is read, previewed, and becomes configured inventory on one approval', async () => {
  const interpretation = {
    documentType: 'stock_report',
    goodsHaveArrived: true,
    referencedOrderNumber: '',
    businessDescription: 'This stock report establishes children’s shoes as size variants from Step & Style Wholesale in Brooklyn Warehouse.',
    unitLabel: 'pair',
    supplierName: 'Step & Style Wholesale', supplierCodeLabel: 'Supplier Code', supplierEmail: 'sales@example.com',
    documentNumber: 'INV-2026-0816', documentDate: '2026-08-16', paymentTerms: 'Net 15', currency: 'USD',
    destinationName: 'Brooklyn Warehouse', destinationAddress: '78 Distribution Ave, Brooklyn, NY 11222',
    lines: [
      { styleName: 'Kids Classic Loafer', color: 'Black', variantDimension: 'Size', size: '23', supplierSku: 'SH-101-BLK', description: 'Kids Classic Loafer - Black', quantity: 12, unitCost: 11.5 },
      { styleName: 'Kids Classic Loafer', color: 'Black', variantDimension: 'Size', size: '24', supplierSku: 'SH-101-BLK', description: 'Kids Classic Loafer - Black', quantity: 10, unitCost: 11.5 },
      { styleName: 'Boys Dress Oxford', color: 'Brown', variantDimension: 'Size', size: '28', supplierSku: 'SH-204-BRN', description: 'Boys Dress Oxford - Brown', quantity: 8, unitCost: 14.75 },
    ],
    charges: [], documentTotal: 371, warnings: [],
  };
  const understanding = buildUnderstanding({
    businessDescription: interpretation.businessDescription,
    variantDimensions: [{ name: 'Size', exampleValues: ['23', '24', '28'] }],
    likelyLocations: [{ name: 'Brooklyn Warehouse', kind: 'warehouse', certainty: 'inferred_confidently' }],
    recommendedConfiguration: { trackingMode: 'quantity', usesVariants: true, allowNegativeStock: false, summary: 'Each shoe size is counted separately.' },
  });
  const { statedRequirements, recommendations, unresolvedDecisions, ...core } = understanding;
  const { app, db, workspace } = setup({
    provider: fakeProvider([
      interpretation, core, { statedRequirements, recommendations, unresolvedDecisions },
    ]),
  });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const page = await agent.get('/foundry/describe');
  const started = await agent.post('/foundry/understand')
    .field('_csrf', csrfFrom(page.text))
    .attach('source', Buffer.from('Code,Style,Color,Size,Qty,Cost\nSH-101-BLK,Kids Classic Loafer,Black,23,12,11.50\n'), {
      filename: 'mock_shoe_inventory_invoice.csv', contentType: 'text/csv',
    });
  assert.equal(started.status, 303);

  const jobId = started.headers.location.split('/').pop();
  let proposalPath;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await agent.get(`/api/foundry/jobs/${jobId}`).set('Accept', 'application/json');
    if (status.body.redirectTo) { proposalPath = status.body.redirectTo; break; }
    if (status.body.status === 'failed') assert.fail(status.body.error);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(proposalPath);

  const proposalPage = await agent.get(proposalPath);
  const proposal = plain(proposalPage.text);
  assert.match(proposal, /What StockChief read from mock_shoe_inventory_invoice.csv/);
  assert.match(proposal, /INV-2026-0816/);
  assert.match(proposal, /30 pairs · 2 styles · 3 variants/);
  assert.match(proposal, /SH-101-BLK/);
  assert.match(proposalPage.text, /name="supplierCodeLabel"[^>]*value="Supplier Code"/);
  assert.match(proposal, /This file calls the vendor's product identifier Supplier Code/);
  assert.match(proposal, /You will not have to map them again|recognize them as the same field/);
  assert.match(proposal, /Set up and add 30 pairs to stock/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(workspace.workspaceId).n, 0);

  const understandingId = proposalPath.split('/').pop();
  const configured = await agent.post(`/foundry/proposal/${understandingId}/configure`)
    .type('form').send({ _csrf: csrfFrom(proposalPage.text), supplierCodeLabel: 'Style #' });
  assert.equal(configured.status, 303);

  const ready = plain((await agent.get(configured.headers.location)).text);
  assert.match(ready, /mock_shoe_inventory_invoice.csv is now inventory truth/);
  assert.match(ready, /30 pairs received into Brooklyn Warehouse/);
  assert.match(ready, /This file called the vendor identifier Supplier Code/);
  assert.match(ready, /StockChief will call it Style #/);
  assert.match(ready, /recognize alternate headings on future documents/);
  assert.match(ready, /Purchase order INV-2026-0816 recorded, approved, and fully received/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(workspace.workspaceId).n, 2);
  assert.equal(db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?').get(workspace.workspaceId).n, 30);
  const savedSupplier = db.prepare('SELECT item_code_label, item_code_aliases FROM suppliers WHERE workspace_id = ?').get(workspace.workspaceId);
  assert.equal(savedSupplier.item_code_label, 'Style #');
  assert.ok(JSON.parse(savedSupplier.item_code_aliases).includes('Supplier Code'));

  const replayed = await agent.post(`/foundry/proposal/${understandingId}/configure`)
    .type('form').send({ _csrf: csrfFrom(proposalPage.text) });
  assert.equal(replayed.status, 303);
  assert.equal(replayed.headers.location, configured.headers.location);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(workspace.workspaceId).n, 3);
});

test('after configuring, the console uses the customer terminology', async () => {
  const { app, workspace } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const understood = await understand(agent);
  const understandingId = understood.headers.location.split('/').pop();
  await post(agent, `/foundry/proposal/${understandingId}/configure`, {}, understood.headers.location);

  const locations = plain((await agent.get('/locations')).text);
  assert.match(locations, /Brooklyn Warehouse/);

  // A configured workspace lands on StockChief's guided home, whether or not it has
  // products yet. Customer terminology belongs to the traditional overview, so
  // that is where it is checked.
  const home = plain((await agent.get('/')).text);
  assert.match(home, /Getting StockChief ready/);

  const overview = plain((await agent.get('/overview')).text);
  assert.match(overview, /Ask StockChief about your inventory/);
  assert.match(overview, /2 warehouses/i);
});

test('staff cannot apply a configuration; owners can', async () => {
  const { app, db, workspace } = setup();
  const staffEmail = workspace.staffEmail;

  const staffAgent = request.agent(app);
  await signIn(staffAgent, staffEmail, 'password123');
  const understood = await understand(staffAgent);
  const understandingId = understood.headers.location.split('/').pop();

  const refused = await post(
    staffAgent,
    `/foundry/proposal/${understandingId}/configure`,
    {},
    understood.headers.location
  ).then((res) => res).catch((err) => err);
  assert.equal(planApplier.isConfigured(db, workspace.workspaceId), false, 'staff must not be able to configure');

  const ownerAgent = request.agent(app);
  await signIn(ownerAgent, workspace.account.email, workspace.account.password);
  const applied = await post(
    ownerAgent,
    `/foundry/proposal/${understandingId}/configure`,
    {},
    `/foundry/proposal/${understandingId}`
  );
  assert.equal(applied.status, 303);
  assert.equal(planApplier.isConfigured(db, workspace.workspaceId), true);
});

test('one workspace cannot see or use another workspace StockChief work', async () => {
  const store = makeDatabase();
  const a = seedWorkspace(store.db, { workspaceName: 'Acme' });
  const b = seedWorkspace(store.db, { workspaceName: 'Beacon' });
  const app = createApp({
    db: store.db,
    env: 'test',
    sessionSecret: 'foundry-tenancy-test',
    aiProvider: fakeUnderstandingProvider(SHOE_UNDERSTANDING),
  });

  const agentA = request.agent(app);
  await signIn(agentA, a.account.email, a.account.password);
  const understood = await understand(agentA);
  const understandingId = understood.headers.location.split('/').pop();
  await post(agentA, `/foundry/proposal/${understandingId}/configure`, {}, understood.headers.location);

  const agentB = request.agent(app);
  await signIn(agentB, b.account.email, b.account.password);

  const proposal = await agentB.get(`/foundry/proposal/${understandingId}`);
  assert.equal(proposal.status, 303, "B is bounced rather than shown A's proposal");
  assert.equal(proposal.headers.location, '/foundry');

  // The POST is bounced back with an error flash rather than doing anything —
  // what matters is that nothing in B's workspace changed.
  await post(agentB, `/foundry/proposal/${understandingId}/configure`, {}, '/foundry/describe');
  assert.equal(planApplier.isConfigured(store.db, b.workspaceId), false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM foundry_plans WHERE workspace_id = ?').get(b.workspaceId).n, 0);
  assert.equal(
    repo.listLocations(store.db, b.workspaceId).some((l) => l.name === 'Brooklyn Warehouse'),
    false
  );
});

test('a bad description is refused with a message, not a crash', async () => {
  const { app, workspace } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const res = await post(agent, '/foundry/understand', { description: 'stuff' }, '/foundry/describe');
  assert.equal(res.status, 400);
  assert.match(plain(res.text), /Add an invoice, spreadsheet, Word document, or PDF/);
});

test('a provider failure is reported calmly and configures nothing', async () => {
  const failing = fakeProvider(new Error('provider exploded'));
  const { app, db, workspace } = setup({ provider: failing });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const res = await understand(agent);

  // The job fails; the progress page turns into the setup page with a message.
  assert.equal(res.status, 400);
  const page = await agent.get(`/foundry/thinking/${res.jobId}`);
  assert.match(plain(page.text), /could not finish reading|try again/i);

  assert.equal(planApplier.isConfigured(db, workspace.workspaceId), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM foundry_plans').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM foundry_understandings').get().n, 0);
});

test('choosing manual setup keeps the console and stops the redirect', async () => {
  const { app, db, workspace } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const res = await post(agent, '/foundry/manual', {}, '/foundry/describe');
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/locations');

  const home = await agent.get('/');
  assert.equal(home.status, 200, 'the overview is reachable again');
  assert.equal(planApplier.getConfiguration(db, workspace.workspaceId).configurationVersion, 0);
});

test('the configuration survives a refresh and a restart', async () => {
  const { app, db, workspace, databasePath } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const understood = await understand(agent);
  const understandingId = understood.headers.location.split('/').pop();
  const configured = await post(agent, `/foundry/proposal/${understandingId}/configure`, {}, understood.headers.location);

  // Refresh: the same URL renders the same thing.
  const first = plain((await agent.get(configured.headers.location)).text);
  const second = plain((await agent.get(configured.headers.location)).text);
  assert.match(second, /Your inventory setup is ready/);
  assert.equal(first.includes('2 warehouses configured'), second.includes('2 warehouses configured'));

  const foundryHome = plain((await agent.get('/foundry')).text);
  assert.match(foundryHome, /How you're set up/);
  assert.match(foundryHome, /Setup is finished\. Your products are the next step/);
  db.close();

  // Restart: a brand new handle and application over the same file.
  const reopened = openDatabase(databasePath);
  const restarted = createApp({ db: reopened, env: 'test', sessionSecret: 'foundry-http-test' });
  const agent2 = request.agent(restarted);
  await signIn(agent2, workspace.account.email, workspace.account.password);

  const afterRestart = plain((await agent2.get('/foundry')).text);
  assert.match(afterRestart, /How you're set up/);
  assert.match(afterRestart, /Warehouse/);
  assert.equal(planApplier.getConfiguration(reopened, workspace.workspaceId).configurationVersion, 1);
  reopened.close();
});

test('a change is proposed, shown with its impact, and only applied on confirmation', async () => {
  const changeResponse = {
    kind: 'add_locations',
    summary: 'Add a Queens Warehouse alongside the two you already have.',
    whatWillChange: ['A third warehouse becomes available for stock.'],
    existingInventoryAffected: 'None — the new location starts empty.',
    migrationRequired: false,
    reversible: true,
    recommendation: 'Add it now and move stock when you are ready.',
    locations: [{ name: 'Queens Warehouse', kind: 'warehouse' }],
    terminology: { item: '', location: '', serialUnit: '', lot: '', variant: '' },
    allowNegativeStock: null,
    whyNotSupported: null,
  };

  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  store.db.prepare('DELETE FROM locations WHERE workspace_id = ?').run(workspace.workspaceId);
  const app = createApp({
    db: store.db,
    env: 'test',
    sessionSecret: 'foundry-change-test',
    // Understanding is read in three passes, so the fixture answers the schema
    // it is asked for rather than counting calls.
    aiProvider: fakeProvider((request) => understandingThen(request, changeResponse)),
  });

  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  const understood = await understand(agent);
  const understandingId = understood.headers.location.split('/').pop();
  await post(agent, `/foundry/proposal/${understandingId}/configure`, {}, understood.headers.location);

  const proposed = await post(agent, '/foundry/change', { request: 'We opened another warehouse in Queens' }, '/foundry');
  assert.equal(proposed.status, 303);
  assert.match(proposed.headers.location, /^\/foundry\/change\//);

  const review = plain((await agent.get(proposed.headers.location)).text);
  assert.match(review, /Here's what would change/);
  assert.match(review, /Queens Warehouse/);
  assert.match(review, /Nothing has been applied yet/);
  assert.match(review, /Migration Not required/);
  assert.match(review, /Existing stock Untouched/);

  // Not applied until confirmed.
  assert.equal(
    repo.listLocations(store.db, workspace.workspaceId).some((l) => l.name === 'Queens Warehouse'),
    false
  );

  const planId = proposed.headers.location.split('/').pop();
  const applied = await post(agent, `/foundry/change/${planId}/apply`, {}, proposed.headers.location);
  assert.equal(applied.status, 303);
  assert.equal(
    repo.listLocations(store.db, workspace.workspaceId).some((l) => l.name === 'Queens Warehouse'),
    true
  );
  assert.equal(planApplier.getConfiguration(store.db, workspace.workspaceId).configurationVersion, 2);
});

test('an unsupported change is explained, not faked', async () => {
  const unsupported = {
    kind: 'not_supported',
    summary: 'StockChief cannot forecast demand or suggest reorder quantities yet.',
    whatWillChange: [],
    existingInventoryAffected: 'Nothing.',
    migrationRequired: false,
    reversible: true,
    recommendation: 'Keep using your own judgement for reordering for now.',
    locations: [],
    terminology: { item: '', location: '', serialUnit: '', lot: '', variant: '' },
    allowNegativeStock: null,
    whyNotSupported: 'The engine has no forecasting or purchasing features.',
  };

  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  store.db.prepare('DELETE FROM locations WHERE workspace_id = ?').run(workspace.workspaceId);
  const app = createApp({
    db: store.db,
    env: 'test',
    sessionSecret: 'foundry-unsupported-test',
    aiProvider: fakeProvider((request) => understandingThen(request, unsupported)),
  });

  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  const understood = await understand(agent);
  const understandingId = understood.headers.location.split('/').pop();
  await post(agent, `/foundry/proposal/${understandingId}/configure`, {}, understood.headers.location);

  const before = planApplier.getConfiguration(store.db, workspace.workspaceId).configurationVersion;
  const res = await post(agent, '/foundry/change', { request: 'Forecast what I should reorder next month' }, '/foundry');

  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/foundry#conversation');
  assert.equal(planApplier.getConfiguration(store.db, workspace.workspaceId).configurationVersion, before);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM foundry_plans WHERE kind = 'change'").get().n, 0);

  const home = plain((await agent.get('/foundry')).text);
  assert.match(home, /cannot forecast demand/);
});

test('reading a business does not block the request', async () => {
  const { app, workspace } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const started = Date.now();
  const res = await post(agent, '/foundry/understand', { description: 'We wholesale shoes in two warehouses.' }, '/foundry/describe');
  const elapsed = Date.now() - started;

  assert.equal(res.status, 303);
  assert.match(res.headers.location, /^\/foundry\/thinking\//);
  assert.ok(elapsed < 2000, `the POST returned in ${elapsed}ms — it must not wait on the model`);
});

test('the progress page reports the real stage and works without JavaScript', async () => {
  // A provider that never resolves, so the job stays mid-flight.
  const pending = {
    name: 'slow',
    model: 'slow',
    async complete() {
      return new Promise(() => {});
    },
  };
  const { app, workspace } = setup({ provider: pending });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const started = await post(agent, '/foundry/understand', { description: 'We wholesale shoes in two warehouses.' }, '/foundry/describe');
  const jobId = started.headers.location.split('/').pop();

  const page = await agent.get(started.headers.location);
  assert.equal(page.status, 200);
  const text = plain(page.text);
  assert.match(text, /StockChief is reading your inventory/);
  assert.match(page.text, /class="rm-intake-thinking"/);
  assert.doesNotMatch(page.text, /class="rm-thinking"/);
  assert.match(text, /Reading your operation/);
  assert.match(text, /Working out what to recommend/);
  // No-JS fallback so the page still progresses on its own.
  assert.match(page.text, /http-equiv="refresh"/);

  const status = await agent.get(`/api/foundry/jobs/${jobId}`).set('Accept', 'application/json');
  assert.equal(status.status, 200);
  assert.ok(['queued', 'running'].includes(status.body.status));
  assert.equal(status.body.redirectTo, null);
});

test('a job belongs to one workspace only', async () => {
  const store = makeDatabase();
  const a = seedWorkspace(store.db, { workspaceName: 'Acme' });
  const b = seedWorkspace(store.db, { workspaceName: 'Beacon' });
  const app = createApp({
    db: store.db,
    env: 'test',
    sessionSecret: 'foundry-job-tenancy',
    aiProvider: { name: 'slow', model: 'slow', async complete() { return new Promise(() => {}); } },
  });

  const agentA = request.agent(app);
  await signIn(agentA, a.account.email, a.account.password);
  const started = await post(agentA, '/foundry/understand', { description: 'We wholesale shoes in two warehouses.' }, '/foundry/describe');
  const jobId = started.headers.location.split('/').pop();

  const agentB = request.agent(app);
  await signIn(agentB, b.account.email, b.account.password);

  const poll = await agentB.get(`/api/foundry/jobs/${jobId}`).set('Accept', 'application/json');
  assert.equal(poll.status, 404, "B must not be able to watch A's job");

  const page = await agentB.get(`/foundry/thinking/${jobId}`);
  assert.equal(page.status, 303);
  assert.equal(page.headers.location, '/foundry');
});

test('an unknown job sends the customer back rather than hanging', async () => {
  const { app, workspace } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const page = await agent.get('/foundry/thinking/job_does_not_exist');
  assert.equal(page.status, 303);
  assert.equal(page.headers.location, '/foundry');

  const poll = await agent.get('/api/foundry/jobs/job_does_not_exist').set('Accept', 'application/json');
  assert.equal(poll.status, 404);
});

test('the polling endpoint refuses anonymous callers', async () => {
  const { app } = setup();
  const res = await request(app).get('/api/foundry/jobs/job_anything').set('Accept', 'application/json');
  assert.equal(res.status, 401);
});

test('the axes you described during setup are waiting on the new-item form', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Headbands Co' });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'prefill' });

  // The configuration a business like "size: 0-6 months / colour: white, red"
  // produces. Typing all of that again on the next screen is what makes a
  // working setup feel like it did nothing.
  store.db.prepare(
    `INSERT INTO workspace_configuration (workspace_id, configured_at, configuration_version, terminology,
       operational_defaults, inventory_model, updated_at)
     VALUES (?, datetime('now'), 1, '{}', '{}', ?, datetime('now'))`
  ).run(
    workspace.workspaceId,
    JSON.stringify({
      primaryArchetype: 'quantity',
      usesVariants: true,
      variantDimensions: [
        { name: 'Size', exampleValues: ['0-6 months', '6-12 months', '12-24 months'] },
        { name: 'Colour', exampleValues: ['White', 'Red', 'Blue', 'Purple', 'Green'] },
      ],
    })
  );

  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  const html = (await agent.get('/inventory/new')).text;

  assert.match(html, /name="options\[0\]\[name\]"[^>]*value="Size"/);
  assert.match(html, /value="0-6 months, 6-12 months, 12-24 months"/);
  assert.match(html, /name="options\[1\]\[name\]"[^>]*value="Colour"/);
  assert.match(html, /value="White, Red, Blue, Purple, Green"/);
  assert.match(html, /name="hasVariants"[^>]*checked/);
  assert.match(plain(html), /Filled in from what you told StockChief/);
});

test('any business gets its own axes back, whatever they are', async () => {
  // Nothing in the prefill knows about clothing, headbands or sizes. It reads
  // whatever axes that workspace's own configuration recorded, so a coffee
  // roaster gets roast and grind exactly as a headband wholesaler gets size and
  // colour. This test exists to keep it that way.
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Roastery' });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'prefill-other' });

  store.db.prepare(
    `INSERT INTO workspace_configuration (workspace_id, configured_at, configuration_version, terminology,
       operational_defaults, inventory_model, updated_at)
     VALUES (?, datetime('now'), 1, '{}', '{}', ?, datetime('now'))`
  ).run(
    workspace.workspaceId,
    JSON.stringify({
      primaryArchetype: 'quantity',
      usesVariants: true,
      variantDimensions: [
        { name: 'Roast', exampleValues: ['Light', 'Medium', 'Dark'] },
        { name: 'Grind', exampleValues: ['Whole bean', 'Filter', 'Espresso'] },
      ],
    })
  );

  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  const html = (await agent.get('/inventory/new')).text;

  assert.match(html, /name="options\[0\]\[name\]"[^>]*value="Roast"/);
  assert.match(html, /value="Light, Medium, Dark"/);
  assert.match(html, /name="options\[1\]\[name\]"[^>]*value="Grind"/);
  assert.match(html, /value="Whole bean, Filter, Espresso"/);
  assert.doesNotMatch(html, /months/i, 'no other business’s wording leaks in');
});

test('a workspace that described no options still gets a blank form', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Plain Co' });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'prefill-none' });

  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  const html = (await agent.get('/inventory/new')).text;

  assert.doesNotMatch(html, /name="hasVariants"[^>]*checked/, 'nothing was described, so nothing is suggested');
  assert.doesNotMatch(plain(html), /Filled in from what you told StockChief/);
});

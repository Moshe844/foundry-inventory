'use strict';

/**
 * Importing over HTTP, as a browser actually does it.
 *
 * A real upload is a multipart request, so these tests send one — that is the
 * only way to know the file arrives intact, the CSRF token survives alongside
 * it, and the preview renders from the stored rows rather than from anything
 * held in memory between requests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const authService = require('../../src/domain/auth-service');
const planService = require('../../src/imports/plan-service');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, csrfFrom, plain, signIn } = require('../helpers');
const scenarios = require('../helpers/scenarios');

test.after(cleanupAll);

function setup() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Import Co' });
  scenarios.configure(store.db, workspace.workspaceId, {
    inventoryModel: { primaryArchetype: 'quantity', usesVariants: true },
  });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'imports-http-test' });
  return { ...store, workspace, app };
}

const CSV = [
  'Item Name,SKU,Warehouse,Qty On Hand',
  'Copper Elbow,CE-050,Main Warehouse,140',
  'Copper Tee,CE-075,Main Warehouse,86',
].join('\n');

/** A real .xlsx, written by SheetJS rather than by the code under test. */
function workbook(rows) {
  const XLSX = require('xlsx');
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Stock');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

async function upload(agent, token, { buffer, filename, contentType }) {
  return agent
    .post('/imports')
    .field('_csrf', token)
    .attach('file', buffer, { filename, contentType });
}

test('a csv upload becomes a preview that creates nothing yet', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  const session = await signIn(agent, env.workspace.account.email);
  const token = await session.token('/imports');

  const posted = await upload(agent, token, {
    buffer: Buffer.from(CSV, 'utf8'),
    filename: 'stock.csv',
    contentType: 'text/csv',
  });
  assert.equal(posted.status, 302);
  assert.match(posted.headers.location, /^\/imports\/imp_/);

  const page = await agent.get(posted.headers.location);
  assert.equal(page.status, 200);
  const text = plain(page.text);
  assert.match(text, /create 2 products/);
  assert.match(text, /226 units/);
  assert.match(text, /Qty On Hand/);           // the mapping is shown, column by column

  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
});

test('an xlsx upload survives the round trip byte for byte', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  const session = await signIn(agent, env.workspace.account.email);
  const token = await session.token('/imports');

  const posted = await upload(agent, token, {
    buffer: workbook([
      ['Item', 'Warehouse', 'Qty'],
      ['Copper Elbow', 'Main Warehouse', 12],
    ]),
    filename: 'stock.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  assert.equal(posted.status, 302);

  const id = posted.headers.location.split('/').pop();
  const plan = planService.get(env.db, env.workspace.workspaceId, id);
  assert.equal(plan.sourceKind, 'xlsx');
  assert.equal(plan.recordsDetected, 1);
  assert.equal(plan.recordsValid, 1);
});

test('an upload without a CSRF token is refused', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email);

  const posted = await agent
    .post('/imports')
    .field('_csrf', 'not-the-token')
    .attach('file', Buffer.from(CSV, 'utf8'), { filename: 'stock.csv', contentType: 'text/csv' });

  // A rejected POST redirects with the reason, the way every other form does.
  assert.equal(posted.status, 303);
  assert.match(plain((await agent.get('/')).text), /session expired/i);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM import_plans').get().n, 0);
});

test('approve then run imports it, and a second run does not import it again', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  const session = await signIn(agent, env.workspace.account.email);
  const token = await session.token('/imports');

  const posted = await upload(agent, token, {
    buffer: Buffer.from(CSV, 'utf8'),
    filename: 'stock.csv',
    contentType: 'text/csv',
  });
  const path = posted.headers.location;
  const id = path.split('/').pop();

  const preview = await agent.get(path);
  const previewToken = csrfFrom(preview.text);
  const hash = /name="integrityHash" value="([^"]+)"/.exec(preview.text)[1];

  const approved = await agent
    .post(`${path}/approve`)
    .type('form')
    .send({ _csrf: previewToken, integrityHash: hash });
  assert.equal(approved.status, 302);

  const ran = await agent.post(`${path}/run`).type('form').send({ _csrf: previewToken });
  assert.equal(ran.status, 302);

  const after = await agent.get(path);
  const text = plain(after.text);
  assert.match(text, /2 products created/);
  assert.match(text, /226 units established/);
  assert.match(text, /Verified against your inventory/);

  // The browser's back button, then submit again.
  const again = await agent.post(`${path}/run`).type('form').send({ _csrf: previewToken });
  assert.equal(again.status, 302);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM movements').get().n, 2);
  assert.equal(
    env.db.prepare('SELECT COUNT(*) AS n FROM import_executions WHERE import_id = ?').get(id).n,
    1
  );
});

test('running before approving is refused', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  const session = await signIn(agent, env.workspace.account.email);
  const token = await session.token('/imports');

  const posted = await upload(agent, token, {
    buffer: Buffer.from(CSV, 'utf8'),
    filename: 'stock.csv',
    contentType: 'text/csv',
  });
  const path = posted.headers.location;
  const preview = await agent.get(path);

  const ran = await agent
    .post(`${path}/run`)
    .type('form')
    .send({ _csrf: csrfFrom(preview.text) });
  assert.equal(ran.status, 303);
  assert.match(plain((await agent.get(path)).text), /Approve the import before running it/);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM import_executions').get().n, 0);
});

test('correcting a column re-reads the file and withdraws the approval', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  const session = await signIn(agent, env.workspace.account.email);
  const token = await session.token('/imports');

  // "Amount" is pricing wording, so Foundry leaves it out — and a person can
  // say that it is in fact the quantity.
  const posted = await upload(agent, token, {
    buffer: Buffer.from(['Item,Warehouse,Amount', 'Copper Elbow,Main Warehouse,30'].join('\n'), 'utf8'),
    filename: 'stock.csv',
    contentType: 'text/csv',
  });
  const path = posted.headers.location;
  const id = path.split('/').pop();

  const before = planService.get(env.db, env.workspace.workspaceId, id);
  assert.equal(before.fieldMappings.quantity, undefined);

  const preview = await agent.get(path);
  const corrected = await agent
    .post(`${path}/mapping`)
    .type('form')
    .send({ _csrf: csrfFrom(preview.text), col_0: 'name', col_1: 'location', col_2: 'quantity' });
  assert.equal(corrected.status, 302);

  const after = planService.get(env.db, env.workspace.workspaceId, id);
  assert.equal(after.fieldMappings.quantity, 2);
  assert.equal(after.approvalStatus, 'AWAITING_APPROVAL');
  const [row] = planService.rowsFor(env.db, id, { limit: 5 });
  assert.equal(row.parsed.quantity, 30);
});

test('an import belongs to one inventory and is invisible from another', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  const session = await signIn(agent, env.workspace.account.email);
  const token = await session.token('/imports');

  const posted = await upload(agent, token, {
    buffer: Buffer.from(CSV, 'utf8'),
    filename: 'stock.csv',
    contentType: 'text/csv',
  });
  const path = posted.headers.location;

  // A second account, with its own inventory, cannot fetch it by id.
  const outsider = request.agent(env.app);
  authService.registerAccount(env.db, {
    workspaceName: 'Someone Else',
    name: 'Ida Outsider',
    email: 'outsider-import@example.test',
    password: 'password123',
  });
  await signIn(outsider, 'outsider-import@example.test');

  const stolen = await outsider.get(path);
  assert.equal(stolen.status, 404);
});

test('a read-only member cannot reach the import screens', async () => {
  const env = setup();
  const viewer = authService.createTeamMember(
    env.db,
    env.workspace.ctx,
    { role: 'owner' },
    { name: 'Vic Viewer', email: 'viewer-import@example.test', password: 'password123', role: 'staff' }
  );
  env.db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(['VIEW']), viewer.id);

  const agent = request.agent(env.app);
  const session = await signIn(agent, 'viewer-import@example.test');
  const page = await agent.get('/imports');
  assert.equal(page.status, 200);
  assert.match(plain(page.text), /read-only access/);

  const posted = await agent
    .post('/imports')
    .field('_csrf', await session.token('/imports'))
    .attach('file', Buffer.from(CSV, 'utf8'), { filename: 'stock.csv', contentType: 'text/csv' });
  assert.equal(posted.status, 303);
  assert.match(plain((await agent.get('/imports')).text), /do not have permission/i);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM import_plans').get().n, 0);
});

test('pasted data with no header row is still read as data', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  const session = await signIn(agent, env.workspace.account.email);
  const token = await session.token('/imports');

  const posted = await agent
    .post('/imports')
    .type('form')
    .send({
      _csrf: token,
      pasted: 'Copper Elbow\tMain Warehouse\t140\nCopper Tee\tMain Warehouse\t86',
      defaultLocationId: '',
    });
  assert.equal(posted.status, 302);

  const id = posted.headers.location.split('/').pop();
  const plan = planService.get(env.db, env.workspace.workspaceId, id);
  // Both lines are records; neither was mistaken for a header.
  assert.equal(plan.recordsDetected, 2);
  assert.match(plan.assumptions.join(' '), /no header row/);
});

test('the progress endpoint reports from what is written, not what is hoped', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  const session = await signIn(agent, env.workspace.account.email);
  const token = await session.token('/imports');

  const posted = await upload(agent, token, {
    buffer: Buffer.from(CSV, 'utf8'),
    filename: 'stock.csv',
    contentType: 'text/csv',
  });
  const path = posted.headers.location;

  const idle = await agent.get(`${path}/progress`);
  assert.deepEqual(idle.body, { status: 'NONE' });

  const preview = await agent.get(path);
  const previewToken = csrfFrom(preview.text);
  await agent.post(`${path}/approve`).type('form').send({ _csrf: previewToken });
  await agent.post(`${path}/run`).type('form').send({ _csrf: previewToken });

  const done = await agent.get(`${path}/progress`);
  assert.equal(done.body.status, 'SUCCEEDED');
  assert.equal(done.body.percent, 100);
  assert.equal(done.body.rowsImported, 2);
  assert.equal(done.body.unitsEstablished, 226);
});

test('a spreadsheet handed to the Ask Foundry box becomes an import preview', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  const session = await signIn(agent, env.workspace.account.email);
  const token = await session.token('/actions');

  // The person put their file in the "do something" box rather than the import
  // screen. That is not a mistake worth an error message.
  const posted = await agent
    .post('/actions/ask')
    .field('_csrf', token)
    .attach('file', Buffer.from(CSV, 'utf8'), { filename: 'stock.csv', contentType: 'text/csv' });

  assert.equal(posted.status, 303);
  assert.match(posted.headers.location, /^\/imports\/imp_/);

  const preview = await agent.get(posted.headers.location);
  assert.match(plain(preview.text), /create 2 products/);
  // Read, not imported.
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
});

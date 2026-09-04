'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, cleanupAll, seedWorkspace, signIn } = require('../helpers');
const { configure } = require('../helpers/scenarios');

test.after(cleanupAll);

test('the global Tell Foundry link always points at an input that exists', async () => {
  const { db, app } = makeApp();
  const workspace = seedWorkspace(db);
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  // A manually-created inventory has the command on the action page, not on
  // the traditional overview. The shell must not point to a missing fragment.
  const manualHome = (await agent.get('/')).text;
  assert.match(manualHome, /href="\/actions#action-instruction"/);
  assert.match(manualHome, /href="\/guide"[^>]*>[^<]*.*How do I use Foundry\?/s);
  assert.match((await agent.get('/actions')).text, /id="action-instruction"/);

  // Once Foundry is configured, its universal command lives on Foundry Home.
  configure(db, workspace.workspaceId);
  const foundryHome = (await agent.get('/')).text;
  assert.match(foundryHome, /href="\/#tell-foundry"/);
  assert.match(foundryHome, /href="\/guide"/);
  assert.match(foundryHome, /id="tell-foundry"/);
  assert.match(foundryHome, /id="ask-question"/);

  const guide = (await agent.get('/guide')).text;
  assert.match(guide, /How do I use Foundry\?/);
  assert.match(guide, /Record a sale/);
  assert.match(guide, /Control what Foundry may do automatically/);

  const support = (await agent.get('/support')).text;
  assert.match(support, /Help and support/);
  assert.match(support, /Never send passwords, OAuth secrets, or API keys/);
});

/**
 * The sidebar must highlight the page you are actually on.
 *
 * Found by clicking, not by a test: opening Home lit Inventory, and opening
 * Connections lit Settings. Both came from a page reusing another destination's
 * key — "/" renders a view that calls itself 'overview' when Foundry has not
 * been configured, and the connections routes were still labelling themselves
 * 'settings' from when they lived inside that page.
 *
 * A wrong highlight is not cosmetic. The sidebar is the product's answer to
 * "where am I", and an answer that is confidently wrong is worse than none.
 */
test('the sidebar highlights the page you are on, and only that page', async () => {
  const { db, app } = makeApp();
  const workspace = seedWorkspace(db);
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  /** The labels of every sidebar entry currently marked active. */
  const activeOn = async (path) => {
    const html = (await agent.get(path)).text;
    const sidebar = html.split('<nav class="nav"')[1].split('</nav>')[0];
    return (sidebar.match(/<a[^>]*class="nav-item is-active"[\s\S]*?<\/a>/g) || [])
      .map((anchor) => (anchor.match(/<span>([^<]+)<\/span>/) || [])[1])
      .filter(Boolean);
  };

  // Unconfigured: "/" is still Home, whichever view it renders underneath.
  assert.deepEqual(await activeOn('/'), ['Home'], 'Home lights Home, not Inventory');

  // And configured, where "/" renders the other view entirely.
  configure(db, workspace.workspaceId);
  assert.deepEqual(await activeOn('/'), ['Home']);

  assert.deepEqual(await activeOn('/inventory'), ['Inventory']);
  assert.deepEqual(await activeOn('/needs-you'), ['Needs you']);
  assert.deepEqual(await activeOn('/activity'), ['Activity']);
  assert.deepEqual(await activeOn('/settings'), ['Settings']);
  assert.deepEqual(await activeOn('/settings/connections'), ['Connections'],
    'Connections is its own destination, not a corner of Settings');

  /*
   * A page that belongs to a section lights that section.
   *
   * The sidebar used to name every department: Sales, Fulfilment, Mail,
   * Purchasing, Accounting. Each of those is now part of something the owner
   * recognises as a job rather than a module, and the highlight has to agree
   * with that, or the nav says one thing and the page says another.
   */
  assert.deepEqual(await activeOn('/purchasing'), ['Inventory'],
    'buying stock is how inventory arrives');
  assert.deepEqual(await activeOn('/orders'), ['Orders']);
  assert.deepEqual(await activeOn('/sales'), ['Orders'],
    'the older address is the same page and lights the same entry');
  assert.deepEqual(await activeOn('/fulfilment'), ['Orders'],
    'picking and shipping are what happens to an order');
  assert.deepEqual(await activeOn('/mail'), ['Orders'],
    'mail is about an order or a supplier, never a department of its own');
  assert.deepEqual(await activeOn('/money'), ['Money']);
  assert.deepEqual(await activeOn('/accounting'), ['Money']);
});

test('the sidebar offers what an owner does, not what the software contains', async () => {
  const { db, app } = makeApp();
  const workspace = seedWorkspace(db);
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  configure(db, workspace.workspaceId);

  const html = (await agent.get('/')).text;
  const sidebar = html.split('<nav class="nav"')[1].split('</nav>')[0];
  const labels = (sidebar.match(/<a[^>]*class="nav-item[^"]*"[\s\S]*?<\/a>/g) || [])
    .map((anchor) => (anchor.match(/<span>([^<]+)<\/span>/) || [])[1])
    .filter(Boolean);

  assert.deepEqual(labels, ['Home', 'Needs you', 'Inventory', 'Orders', 'Money', 'Activity',
    'Connections', 'Settings']);

  // The departments that were folded in are gone from the sidebar and still
  // reachable: consolidating is not the same as removing.
  for (const gone of ['Sales', 'Fulfilment', 'Mail', 'Purchasing', 'Accounting']) {
    assert.ok(!labels.includes(gone), `${gone} should no longer be its own department`);
  }
  for (const path of ['/fulfilment', '/mail', '/purchasing']) {
    assert.equal((await agent.get(path)).status, 200, `${path} must still work`);
  }
});

/**
 * "Review" is not a decision.
 *
 * Needs you exists so somebody can decide something. A button that says Review
 * has told them to go and look, which is the one thing they already know they
 * have to do. Every entry the inbox can produce names the decision instead.
 */
test('every Needs you action names the decision rather than inviting a look', () => {
  const source = require('node:fs').readFileSync(
    require.resolve('../../src/manager/needs-you-inbox'), 'utf8'
  );
  const labels = (source.match(/actionLabel: [^\n]+/g) || []).join('\n');
  assert.doesNotMatch(labels, /'Review /, 'no generic Review label survives');
  assert.doesNotMatch(labels, /`Review /, 'including the interpolated ones');
});

test('what was folded into a section is reachable from inside it', async () => {
  /*
   * The risk in consolidating a navigation is that it stops being simpler and
   * starts being emptier: five departments vanish from the sidebar and nobody
   * can find them again. So each one has to be one click from the entry that
   * now owns it, on a workspace with no data at all — the first morning is
   * exactly when somebody is looking for what the product can do.
   */
  const { db, app } = makeApp();
  const workspace = seedWorkspace(db);
  configure(db, workspace.workspaceId);
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const bodyOf = async (path) => {
    const html = (await agent.get(path)).text;
    return html.split('<main')[1] || html;
  };

  const orders = await bodyOf('/orders');
  assert.match(orders, /href="\/fulfilment"/, 'picking and shipping live under Orders');
  assert.match(orders, /href="\/mail"/, 'customer mail lives under Orders');

  assert.match(await bodyOf('/inventory'), /href="\/purchasing"/,
    'ordering and suppliers live under Inventory');
});

/*
 * Settings is a hub, and a hub you cannot come back from is a dead end.
 *
 * Nine pages open out of Settings and none of them led back, so returning
 * meant clicking Settings in the sidebar again, every time. The obvious fix —
 * a fixed "Back to Settings" on each of those pages — would be wrong half the
 * time: Locations is also reached from a product, Suppliers from a purchase
 * order. So the link follows where somebody actually came from, and these are
 * the two halves of that.
 */
test('a page opened from Settings offers the way back, and one opened elsewhere does not', async () => {
  const { db, app } = makeApp();
  const workspace = seedWorkspace(db);
  /*
   * One listening server for the whole test, not supertest's default of a
   * fresh ephemeral port per request. The referer a browser sends is absolute
   * and the same-origin check is real, so every request here has to arrive on
   * the host the previous page was served from — which is exactly what a
   * browser does and what supertest, left alone, does not.
   */
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const agent = request.agent(server);
  await signIn(agent, workspace.account.email, workspace.account.password);
  configure(db, workspace.workspaceId);

  const origin = `${base}/settings`;
  for (const path of ['/locations', '/suppliers', '/imports', '/foundry', '/purchasing/setup']) {
    const opened = (await agent.get(path).set('Referer', origin)).text;
    assert.match(opened, /class="page-back" href="\/settings"/,
      `${path} opened from Settings should lead back to Settings`);
    assert.match(opened, /Back to Settings/);
  }

  // Reached from a purchase order instead, it must not claim they came from
  // Settings — including after an earlier visit that did.
  const elsewhere = (await agent.get('/suppliers').set('Referer', `${base}/purchasing`)).text;
  assert.ok(!/class="page-back"/.test(elsewhere),
    'a back link to a page somebody has not been is worse than none');

  // Settings itself never offers to go back to itself.
  const settings = (await agent.get('/settings').set('Referer', origin)).text;
  assert.ok(!/class="page-back" href="\/settings"/.test(settings));
  server.close();
});

test('saving on a page opened from Settings keeps the way back', async () => {
  /*
   * A form post redirects to the same page, so the referer becomes the page
   * itself and the trail from Settings would be lost — at the exact moment
   * somebody has finished what they came to do.
   */
  const { db, app } = makeApp();
  const workspace = seedWorkspace(db);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const agent = request.agent(server);
  await signIn(agent, workspace.account.email, workspace.account.password);
  configure(db, workspace.workspaceId);

  await agent.get('/locations').set('Referer', `${base}/settings`);
  const afterSaving = (await agent.get('/locations').set('Referer', `${base}/locations`)).text;
  assert.match(afterSaving, /class="page-back" href="\/settings"/);
  server.close();
});

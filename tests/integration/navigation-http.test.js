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
  assert.deepEqual(await activeOn('/purchasing'), ['Purchasing']);
  assert.deepEqual(await activeOn('/activity'), ['Activity']);
  assert.deepEqual(await activeOn('/settings'), ['Settings']);
  assert.deepEqual(await activeOn('/settings/connections'), ['Connections'],
    'Connections is its own destination, not a corner of Settings');
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

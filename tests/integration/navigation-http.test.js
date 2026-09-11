'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, cleanupAll, seedWorkspace, signIn } = require('../helpers');
const { configure } = require('../helpers/scenarios');
const workItems = require('../../src/autopilot/work-items');

test.after(cleanupAll);

/*
 * Telling Foundry something is one box, and the link to it always works.
 *
 * There used to be two: "Ask Foundry" answered questions on one page and
 * "Tell Foundry" carried instructions from somewhere else, and the shell had
 * to guess which of them a given workspace could use — which is how a global
 * button came to point at a fragment that did not exist on the page it opened.
 *
 * There is one line now, at one address, and it is the same for every
 * workspace whether or not Foundry has been configured.
 */
test('the line is one address, and the box it promises is on it', async () => {
  const { db, app } = makeApp();
  const workspace = seedWorkspace(db);
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const manualHome = (await agent.get('/')).text;
  assert.match(manualHome, /href="\/ask"/, 'the chrome offers the line');

  // Once Foundry is configured, the same link goes to the same place.
  configure(db, workspace.workspaceId);
  assert.match((await agent.get('/')).text, /href="\/ask"/);

  const line = (await agent.get('/ask')).text;
  assert.match(line, /<textarea[^>]*id="ask-question"/, 'and the box is actually there');
  assert.match(line, /action="\/foundry\/tell"/, 'posting to the router that reads a sentence');

  const guide = (await agent.get('/guide')).text;
  assert.match(guide, /How do I use Foundry\?/);
  assert.match(guide, /Record a sale/);
  assert.match(guide, /Control what Foundry may do automatically/);

  const support = (await agent.get('/support')).text;
  assert.match(support, /Help and support/);
  assert.match(support, /Never send passwords, OAuth secrets, or API keys/);
});

/**
 * The chrome must say where you are, and never say it wrongly.
 *
 * This used to be a sidebar of eight departments, and the bug it was written
 * for was a wrong highlight: opening Home lit Inventory, opening Connections
 * lit Settings. An answer to "where am I" that is confidently wrong is worse
 * than none at all.
 *
 * There are three states now, because there are three things somebody does in
 * a day: read the brief, settle what is waiting, say something. Everything
 * else is reached from a story or by asking, and marks nothing — which is not
 * a gap. Those pages carry their own name and their own way back, and a rail
 * that claimed one of three states while you were reading an order would be
 * the same confident lie in a smaller frame.
 */
test('the rail marks the state you are in, and only that one', async () => {
  const { db, app } = makeApp();
  const workspace = seedWorkspace(db);
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  /** The labels of every rail entry currently marked current. */
  const activeOn = async (path) => {
    const html = (await agent.get(path)).text;
    const rail = html.split('<header class="rm-rail"')[1].split('</header>')[0];
    return (rail.match(/<a[^>]*class="rm-tab is-on"[\s\S]*?<\/a>/g) || [])
      .map((anchor) => anchor.replace(/<[^>]*>/g, '').replace(/\d+/g, '').trim())
      .filter(Boolean);
  };

  // Unconfigured: "/" is still the brief, whichever view it renders underneath.
  assert.deepEqual(await activeOn('/'), ['Brief']);

  // And configured, where "/" has a whole operation to report on.
  configure(db, workspace.workspaceId);
  assert.deepEqual(await activeOn('/'), ['Brief']);

  assert.deepEqual(await activeOn('/needs-you'), ['Needs you']);
  assert.deepEqual(await activeOn('/ask'), ['Ask']);

  /*
   * Everything that used to be a department marks nothing, and that is the
   * design: these are places you arrive at from a story, not states you live
   * in. Each one still has to be a working address.
   */
  for (const path of ['/inventory', '/orders', '/purchasing', '/money', '/activity',
    '/fulfilment', '/mail', '/settings', '/settings/connections']) {
    assert.deepEqual(await activeOn(path), [], `${path} claims no state`);
    assert.equal((await agent.get(path)).status, 200, `${path} must still work`);
  }
});

test('the chrome offers three states, not a directory of departments', async () => {
  const { db, app } = makeApp();
  const workspace = seedWorkspace(db);
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  configure(db, workspace.workspaceId);

  const html = (await agent.get('/')).text;
  const rail = html.split('<header class="rm-rail"')[1].split('</header>')[0];
  const labels = (rail.match(/<a[^>]*class="rm-tab[^"]*"[\s\S]*?<\/a>/g) || [])
    .map((anchor) => anchor.replace(/<[^>]*>/g, '').replace(/\d+/g, '').trim())
    .filter(Boolean);

  assert.deepEqual(labels, ['Brief', 'Needs you', 'Ask']);

  /*
   * Consolidating is not removing. Every department that came off the rail is
   * still a working address, and every one of them is listed at /everything —
   * which is the page that makes this arrangement honest rather than merely
   * emptier.
   */
  const vault = (await agent.get('/everything')).text;
  for (const path of ['/fulfilment', '/mail', '/purchasing', '/orders', '/inventory/table',
    '/accounting/books', '/activity', '/settings']) {
    assert.equal((await agent.get(path)).status, 200, `${path} must still work`);
    assert.match(vault, new RegExp(`href="${path.replace(/\//g, '\\/')}"`),
      `${path} is listed with everything else`);
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

  assert.match(await bodyOf('/inventory'), /href="\/purchasing/,
    'ordering and suppliers live under what you hold');

  /*
   * Mail is no longer a department, and no longer something Orders links to as
   * one. What a customer was told is a line of their order's own story, and
   * the whole mailbox is listed with everything else.
   */
  assert.match(await bodyOf('/everything'), /href="\/mail"/,
    'the mailbox is still reachable, just not as a department');
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

  // Reached from Purchasing instead, it must replace the older Settings trail
  // with the journey the person is actually on now.
  const elsewhere = (await agent.get('/suppliers').set('Referer', `${base}/purchasing`)).text;
  assert.match(elsewhere, /class="page-back" href="\/purchasing"/);
  assert.match(elsewhere, /Back to Purchasing/,
    'the most recent real hub replaces an older remembered origin');

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

test('a decision opened from Needs you returns to the decision inbox', async () => {
  const { db, app } = makeApp();
  const workspace = seedWorkspace(db);
  configure(db, workspace.workspaceId);
  const item = workItems.upsert(db, workspace.workspaceId, {
    category: 'attention_review', source: 'navigation-test',
    sourceEvidence: [{ label: 'Difference', value: 3 }],
    affectedEntities: { displayName: 'Count difference' },
    recommendedAction: { actionType: 'review' },
    approvalRequirement: 'REQUIRED',
    executionStatus: workItems.STATUS.WAITING_FOR_APPROVAL,
    idempotencyKey: 'navigation:return-to-needs-you',
  }).item;
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const agent = request.agent(server);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const fromInbox = (await agent.get(`/autopilot/work/${item.id}`)
    .set('Referer', `${base}/needs-you`)).text;
  assert.match(fromInbox, /class="page-back" href="\/needs-you"/);
  assert.match(fromInbox, /Back to Needs you/);

  const briefAgent = request.agent(server);
  await signIn(briefAgent, workspace.account.email, workspace.account.password);
  const fromBrief = (await briefAgent.get(`/autopilot/work/${item.id}`)
    .set('Referer', `${base}/`)).text;
  assert.match(fromBrief, /class="page-back" href="\/"/);
  assert.match(fromBrief, /Back to Brief/,
    'a decision opened from the owner brief returns to the owner brief');

  const purchasingAgent = request.agent(server);
  await signIn(purchasingAgent, workspace.account.email, workspace.account.password);
  const fromPurchasing = (await purchasingAgent.get(`/autopilot/work/${item.id}`)
    .set('Referer', `${base}/purchasing`)).text;
  assert.match(fromPurchasing, /class="page-back" href="\/purchasing"/);
  assert.match(fromPurchasing, /Back to Purchasing/,
    'a decision opened from the purchasing plan returns to that plan');

  const fromPurchaseOrderAgent = request.agent(server);
  await signIn(fromPurchaseOrderAgent, workspace.account.email, workspace.account.password);
  const fromPurchaseOrder = (await fromPurchaseOrderAgent.get(`/autopilot/work/${item.id}`)
    .set('Referer', `${base}/purchasing/orders/po_exact_record`)).text;
  assert.match(fromPurchaseOrder, /class="page-back" href="\/purchasing\/orders\/po_exact_record"/);
  assert.match(fromPurchaseOrder, /Back to Purchase order/,
    'a decision opened from an exact PO returns to that exact record');

  const directAgent = request.agent(server);
  await signIn(directAgent, workspace.account.email, workspace.account.password);
  const direct = (await directAgent.get(`/autopilot/work/${item.id}`)).text;
  assert.match(direct, /class="page-back" href="\/autopilot"/,
    'a direct/bookmarked decision keeps the safe Automatic work fallback');
  server.close();
});

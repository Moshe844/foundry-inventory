'use strict';

/**
 * The sidebar is three ways of working — Brief, Needs you, Ask StockChief —
 * and, under them, four quiet doors to the records: Inventory, Purchasing,
 * Orders, Money. Four is the whole list. Products, locations, receiving,
 * transfers, suppliers, fulfilment, mail and books stay contextual, and
 * this test fails the day one of them is added to the sidebar.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const { makeDatabase, seedWorkspace, cleanupAll, signIn } = require('../helpers');

test.after(cleanupAll);

test('the sidebar is three tabs and exactly four Browse doors, with the current one marked', async () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const app = createApp({ db, env: 'test', sessionSecret: 'sidebar' });
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const page = await agent.get('/purchasing');
  const rail = page.text.slice(page.text.indexOf('<header class="rm-rail">'), page.text.indexOf('</header>'));
  const tabs = [...rail.matchAll(/class="rm-tab[^"]*"[^>]*href="([^"]+)"/g)].map((m) => m[1]).filter((h) => h !== '/logout');
  assert.deepEqual(tabs, ['/', '/needs-you', '/ask'], 'the three ways of working, and nothing else at that weight');
  const browse = rail.slice(rail.indexOf('<nav class="rm-rooms"'), rail.indexOf('</nav>', rail.indexOf('<nav class="rm-rooms"')));
  assert.match(browse, /aria-label="Browse"/);
  assert.match(browse, />Browse<\/span>/);
  const doors = [...browse.matchAll(/class="rm-room[^"]*"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(doors, ['/inventory', '/purchasing', '/orders', '/money'], 'four doors, no more');
  assert.match(browse, /class="rm-room is-on" href="\/purchasing" aria-current="page"/);
  for (const never of ['/locations', '/purchasing/receive', '/transfers', '/suppliers', '/fulfilment', '/messages', '/accounting/books', '/inventory/table']) {
    assert.ok(!doors.includes(never), `${never} stays contextual, not in the sidebar`);
  }
});

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

test('the sidebar has five business sections and separate account navigation, with Buy marked current', async () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const app = createApp({ db, env: 'test', sessionSecret: 'sidebar' });
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const page = await agent.get('/purchasing');
  const {sidebar,anchors}=require('../helpers/navigation-html'),rail=sidebar(page.text);
  const primary=/<nav class="sc-primary"[^>]*>([\s\S]*?)<\/nav>/.exec(rail)[1],account=/<nav class="sc-account-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(rail)[1];
  const doors=anchors(primary).map(a=>a.href);
  assert.deepEqual(doors,['/','/orders','/inventory','/purchasing/orders','/money']);
  assert.deepEqual(anchors(primary).filter(a=>a.current).map(a=>a.label),['Buy']);
  assert.deepEqual(anchors(account).map(a=>a.label),['Reports','Settings']);
  for (const never of ['/locations', '/purchasing/receive', '/transfers', '/suppliers', '/fulfilment', '/messages', '/accounting/books', '/inventory/table']) {
    assert.ok(!doors.includes(never), `${never} stays contextual, not in the sidebar`);
  }
});

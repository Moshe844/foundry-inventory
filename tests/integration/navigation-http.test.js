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
});

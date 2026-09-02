'use strict';

/*
 * The mailbox as a place to work.
 *
 * These prove the two things the pages promise: that every message says why it
 * was sorted where it was, and that Foundry does not pretend it can answer any
 * of them yet.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const connections = require('../../src/connections/service');
const ingestion = require('../../src/connections/email-ingestion');
const inbox = require('../../src/connections/reply-inbox');
const needsYou = require('../../src/manager/needs-you-inbox');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

let sequence = 0;

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const created = connections.create(db, workspace.ctx, membership, {
    providerType: 'supplier_email', displayName: 'Shop Mailbox',
  });
  const app = createApp({ db, env: 'test', sessionSecret: 'reply-inbox' });
  return { db, workspace, app, connectorId: created.connection.id };
}

function arrive(env, { sender = 'jo@abcschool.test', subject = null, body = null, attachments = [] } = {}) {
  sequence += 1;
  const result = ingestion.capture(env.db,
    { workspaceId: env.workspace.workspaceId, connectorId: env.connectorId },
    { occurredAt: '2026-08-20T09:00:00.000Z',
      data: { messageId: `http-${sequence}`, sender, subject, bodyText: body, attachments } });
  return result.actionRecordId;
}

test('the three drawers work, and every message says why it is in one', async () => {
  const env = setup();
  arrive(env, { subject: 'Our order', body: 'Hi — can you confirm the new delivery date?' });
  arrive(env, { sender: 'no-reply@ups.com', subject: 'Delivery status notification' });

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const needsReply = await agent.get('/mail');
  assert.equal(needsReply.status, 200);
  let text = plain(needsReply.text);
  assert.match(text, /Needs a reply/);
  assert.match(text, /jo@abcschool\.test/);
  assert.match(text, /can you.*waiting on an answer/i, 'the list shows the reason it was sorted here');
  assert.doesNotMatch(text, /no-reply@ups\.com/, 'a robot is not in the reply drawer');

  const handled = await agent.get('/mail?show=handled');
  text = plain(handled.text);
  assert.match(text, /no-reply@ups\.com/);
  assert.match(text, /automatic address/);

  const waiting = await agent.get('/mail?show=waiting');
  assert.match(plain(waiting.text), /You are not waiting on anybody/);
});

test('answering a message moves it out of the way without losing it', async () => {
  const env = setup();
  const id = arrive(env, { subject: 'Our order', body: 'Can you confirm the date?' });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const page = await agent.get('/mail');
  const answered = await agent.post(`/mail/${id}/state`).type('form')
    .send({ _csrf: csrfFrom(page.text), state: 'WAITING', returnTo: '/mail?show=waiting' });
  assert.equal(answered.status, 303);
  assert.equal(answered.headers.location, '/mail?show=waiting');

  assert.deepEqual(inbox.counts(env.db, env.workspace.workspaceId),
    { NEEDS_REPLY: 0, WAITING: 1, HANDLED: 0 });
  const stillThere = plain((await agent.get('/mail?show=waiting')).text);
  assert.match(stillThere, /Our order/, 'answered is not deleted');
  assert.match(stillThere, /You put this here/, 'the record says a person decided this');
  assert.match(plain((await agent.get('/mail')).text), /Nobody is waiting on you/);
});

test('a message page shows what arrived and offers only the three drawers', async () => {
  const env = setup();
  const id = arrive(env, { subject: 'Damaged cartons', body: 'Two boxes arrived crushed. Can you replace them?' });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const page = await agent.get(`/mail/${id}`);
  assert.equal(page.status, 200);
  const text = plain(page.text);
  assert.match(text, /Damaged cartons/);
  assert.match(text, /Two boxes arrived crushed/);
  assert.match(text, /Needs a reply/);
  assert.match(text, /I answered — waiting on them/);
  assert.match(text, /Handled, nothing needed/);
  assert.match(text, /Foundry cannot write the reply for you yet/,
    'the page admits what it cannot do rather than leaving somebody hunting');

  // Giving a reason keeps it with the message.
  const moved = await agent.post(`/mail/${id}/state`).type('form').send({
    _csrf: csrfFrom(page.text), state: 'HANDLED', reason: 'Phoned them — replacements are on the way.',
  });
  assert.equal(moved.status, 303);
  assert.match(plain((await agent.get(`/mail/${id}`)).text), /Phoned them — replacements are on the way/);
});

test('unanswered mail reaches Needs You, oldest first, and leaves when answered', async () => {
  const env = setup();
  const older = arrive(env, { subject: 'Older question', body: 'Can you confirm?' });
  arrive(env, { subject: 'Newer question', body: 'Can you confirm?' });
  const spare = [];
  for (const n of [1, 2]) spare.push(arrive(env, { subject: `Spare ${n}`, body: 'Can you confirm?' }));
  env.db.prepare('UPDATE connection_email_messages SET received_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 60 * 24 * 3600_000).toISOString(), older);

  let entries = needsYou.inbox(env.db, env.workspace.workspaceId)
    .filter((entry) => entry.id.startsWith('unanswered-mail:'));
  assert.equal(entries.length, 3, 'four are waiting; Needs You shows three and points at the rest');
  assert.ok(entries.some((entry) => entry.id === `unanswered-mail:${older}`),
    'the one that has waited longest is always among them');
  assert.ok(!entries.some((entry) => entry.id === `unanswered-mail:${spare[1]}`),
    'the newest is the one left off');

  const oldest = entries.find((entry) => entry.id === `unanswered-mail:${older}`);
  const fresh = entries.find((entry) => entry.id !== `unanswered-mail:${older}`);
  assert.ok(oldest.priority > fresh.priority, 'two months waiting outranks this morning');
  assert.ok(oldest.priority < 90, 'but a late reply never outranks something urgent');
  assert.match(oldest.href, /^\/mail\//);
  assert.match(oldest.why, /waiting on an answer/);
  assert.match(oldest.recommendation, /4 messages are waiting/);

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const page = await agent.get('/mail');
  await agent.post(`/mail/${older}/state`).type('form')
    .send({ _csrf: csrfFrom(page.text), state: 'HANDLED' });

  entries = needsYou.inbox(env.db, env.workspace.workspaceId)
    .filter((entry) => entry.id.startsWith('unanswered-mail:'));
  assert.equal(entries.length, 3, 'answering the oldest lets the one it was hiding through');
  assert.ok(!entries.some((entry) => entry.id === `unanswered-mail:${older}`));
});

test('the nav badge counts only what needs a reply, and survives a workspace with no mail', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  assert.match((await agent.get('/mail')).text, /href="\/mail"/, 'Mail has its own place in the nav');

  arrive(env, { subject: 'One', body: 'Can you confirm?' });
  arrive(env, { subject: 'Two', body: 'Can you confirm?' });
  arrive(env, { sender: 'no-reply@ups.com', subject: 'Filed away' });

  const home = await agent.get('/');
  assert.equal(home.status, 200);
  assert.equal(inbox.counts(env.db, env.workspace.workspaceId).NEEDS_REPLY, 2);
  /*
   * Anchored on the badge itself. An earlier version of this looked for "Mail"
   * followed by a 2 anywhere nearby and passed against the coordinates inside
   * the nav icon's SVG path, which proves nothing at all.
   */
  const badge = home.text.slice(home.text.indexOf('href="/mail"'));
  assert.match(badge.slice(0, 400), /<span class="nav-count" aria-label="2 waiting">2<\/span>/,
    'the badge counts the two that need answering, not the three that arrived');
});

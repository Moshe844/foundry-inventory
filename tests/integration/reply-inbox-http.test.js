'use strict';

/*
 * The mailbox as a place to work.
 *
 * These prove the two things the pages promise: that every message says why it
 * was sorted where it was, and that StockChief does not pretend it can answer any
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
const sales = require('../../src/sales/sales-order-service');
const suppliers = require('../../src/purchasing/supplier-service');
const { makeDatabase, cleanupAll, seedWorkspace, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

let sequence = 0;

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  sales.createCustomer(db, workspace.ctx, { name: 'Jo at ABC School', email: 'jo@abcschool.test' });
  suppliers.createSupplier(db, workspace.ctx, membership, {
    name: 'UPS Notifications', email: 'no-reply@ups.com',
  });
  const created = connections.create(db, workspace.ctx, membership, {
    providerType: 'supplier_email', displayName: 'Shop Mailbox',
  });
  const app = createApp({ db, env: 'test', sessionSecret: 'reply-inbox' });
  return { db, workspace, membership, app, connectorId: created.connection.id };
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
  assert.match(text, /Jo at ABC School/);
  assert.match(text, /can you.*waiting on an answer/i, 'the list shows the reason it was sorted here');
  assert.doesNotMatch(text, /no-reply@ups\.com/, 'a robot is not in the reply drawer');

  const handled = await agent.get('/mail?show=handled');
  text = plain(handled.text);
  assert.match(text, /UPS Notifications/);
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
  assert.match(text, /StockChief can draft this from what it holds about/,
    'the page offers the draft rather than leaving somebody hunting');

  // Giving a reason keeps it with the message.
  const moved = await agent.post(`/mail/${id}/state`).type('form').send({
    _csrf: csrfFrom(page.text), state: 'HANDLED', reason: 'Phoned them — replacements are on the way.',
  });
  assert.equal(moved.status, 303);
  assert.match(plain((await agent.get(`/mail/${id}`)).text), /Phoned them — replacements are on the way/);
});

test('every unanswered customer or supplier message reaches Needs You, oldest first, and leaves when answered', async () => {
  const env = setup();
  const older = arrive(env, { subject: 'Older question', body: 'Can you confirm?' });
  arrive(env, { subject: 'Newer question', body: 'Can you confirm?' });
  const spare = [];
  for (const n of [1, 2]) spare.push(arrive(env, { subject: `Spare ${n}`, body: 'Can you confirm?' }));
  env.db.prepare('UPDATE connection_email_messages SET received_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 60 * 24 * 3600_000).toISOString(), older);

  let entries = needsYou.inbox(env.db, env.workspace.workspaceId)
    .filter((entry) => entry.id.startsWith('unanswered-mail:'));
  assert.equal(entries.length, 4, 'every unanswered business message is visible in Needs You');
  assert.ok(entries.some((entry) => entry.id === `unanswered-mail:${older}`),
    'the one that has waited longest is always among them');
  assert.ok(entries.some((entry) => entry.id === `unanswered-mail:${spare[1]}`),
    'the newest is visible too');

  const oldest = entries.find((entry) => entry.id === `unanswered-mail:${older}`);
  const fresh = entries.find((entry) => entry.id !== `unanswered-mail:${older}`);
  assert.ok(oldest.priority > fresh.priority, 'two months waiting outranks this morning');
  assert.ok(oldest.priority < 90, 'but a late reply never outranks something urgent');
  assert.match(oldest.href, /^\/mail\//);
  assert.match(oldest.why, /waiting on an answer/);
  assert.equal(oldest.actionLabel, 'Reply to message');
  assert.match(oldest.href, /#reply$/);

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const page = await agent.get('/mail');
  await agent.post(`/mail/${older}/state`).type('form')
    .send({ _csrf: csrfFrom(page.text), state: 'HANDLED' });

  entries = needsYou.inbox(env.db, env.workspace.workspaceId)
    .filter((entry) => entry.id.startsWith('unanswered-mail:'));
  assert.equal(entries.length, 3, 'answering the oldest removes only that message');
  assert.ok(!entries.some((entry) => entry.id === `unanswered-mail:${older}`));
});

test('unanswered mail is counted by Needs you, not by a mail badge of its own', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  /*
   * There is no sidebar any more — the chrome carries the three things
   * somebody does in a day — but the rule this was written for is unchanged
   * and is now stronger: mail is not a state you live in, so it appears
   * nowhere in the chrome, and what needs a person reaches them on the desk.
   */
  const chrome = (await agent.get('/mail')).text.split('<header class="rm-rail"')[1].split('</header>')[0];
  assert.ok(!chrome.includes('href="/mail"'),
    'Mail is not a department; it reaches the owner through Needs you');

  arrive(env, { subject: 'One', body: 'Can you confirm?' });
  arrive(env, { subject: 'Two', body: 'Can you confirm?' });
  arrive(env, { sender: 'no-reply@ups.com', subject: 'Filed away' });

  const home = await agent.get('/');
  assert.equal(home.status, 200);
  assert.equal(inbox.counts(env.db, env.workspace.workspaceId).NEEDS_REPLY, 2);
  /*
   * The number the owner sees is the Needs you badge, and it has to include
   * these — otherwise consolidating the sidebar would have made unanswered
   * mail invisible rather than better placed.
   */
  const needsYou = require('../../src/manager/needs-you-inbox').inbox(env.db, env.workspace.workspaceId);
  const mailEntries = needsYou.filter((entry) => entry.id.startsWith('unanswered-mail:'));
  assert.equal(mailEntries.length, 2, 'both unanswered messages are decisions waiting on the owner');
  const chromeOnHome = home.text.split('<header class="rm-rail"')[1].split('</header>')[0];
  const badge = chromeOnHome.slice(chromeOnHome.indexOf('href="/needs-you"'));
  assert.match(badge.slice(0, 600), new RegExp(`aria-label="${needsYou.length} waiting"`),
    'the Needs you badge is the one number, and it counts the mail too');
});

test('a short known-contact email is actionable, while unrelated mailbox mail never enters StockChief', async () => {
  const env = setup();
  const id = arrive(env, { subject: 'Checking in', body: 'Waiting to hear back from you.' });
  assert.equal(inbox.get(env.db, env.workspace.workspaceId, id).reply_state, 'NEEDS_REPLY',
    'StockChief does not silently file a human customer message because its wording missed a phrase list');

  arrive(env, {
    sender: 'newsletter@unrelated.test', subject: 'Weekly offers', body: 'Save ten percent today.',
  });
  assert.equal(inbox.counts(env.db, env.workspace.workspaceId).NEEDS_REPLY, 1,
    'unrelated connector evidence cannot enter the visible mail queue');

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const desk = await agent.get('/needs-you');
  assert.match(plain(desk.text), /Reply to Jo at ABC School/);
  assert.match(plain(desk.text), /Reply to message/);
  assert.doesNotMatch(plain(desk.text), /newsletter@unrelated\.test/);

  const message = await agent.get(`/mail/${id}`);
  assert.match(message.text, /href="#reply"[^>]*>Reply now</);
  assert.match(message.text, /id="reply"/);
  assert.doesNotMatch(plain((await agent.get('/mail')).text), /Not for StockChief/);
});

test('a reply is drafted, read, and sent from the message page', async () => {
  const env = setup();
  const id = arrive(env, { subject: 'Our order', body: 'Can you confirm the date?' });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  let page = await agent.get(`/mail/${id}`);
  assert.match(plain(page.text), /Draft a reply/);

  const written = await agent.post(`/mail/${id}/draft`)
    .type('form').send({ _csrf: csrfFrom(page.text), action: 'write' });
  assert.equal(written.status, 303);

  page = await agent.get(`/mail/${id}`);
  let text = plain(page.text);
  assert.match(text, /The reply/);
  assert.match(text, /nothing has been sent/);
  /*
   * Whether a model wrote this or the records alone did, the same two things
   * must hold: there is a reply, and it is editable before it goes. Which of
   * the two produced it is a unit-test concern, and asserting on the wording
   * here would make this test depend on a model being reachable.
   */
  assert.match(page.text, /name="body"/, 'it is editable before it goes');
  const drafted = require('../../src/connections/reply-drafting')
    .getDraft(env.db, env.workspace.workspaceId, id);
  assert.ok(drafted.body && drafted.body.trim().length > 20, 'a reply was actually written');
  assert.equal(drafted.sentAt, null, 'and it has not gone anywhere');
  assert.doesNotMatch(drafted.body, /SO-\d/, 'this sender has no order, so none is named');

  // Editing it is saving, not sending.
  const saved = await agent.post(`/mail/${id}/draft`).type('form').send({
    _csrf: csrfFrom(page.text), action: 'save',
    subject: 'Re: Our order', body: 'It is going out today and I will send tracking.',
  });
  assert.equal(saved.status, 303);
  const stored = require('../../src/connections/reply-drafting')
    .getDraft(env.db, env.workspace.workspaceId, id);
  assert.match(stored.body, /going out today/);
  assert.equal(stored.source, 'person');
  assert.equal(stored.sentAt, null, 'saving is not sending');
  assert.equal(inbox.get(env.db, env.workspace.workspaceId, id).reply_state, 'NEEDS_REPLY');
});

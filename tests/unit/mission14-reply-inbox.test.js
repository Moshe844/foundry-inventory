'use strict';

/*
 * Which mail still owes somebody an answer.
 *
 * The claim under test is that "Foundry processed this" and "a person is
 * waiting on you" are different facts, and that Foundry's guess about the
 * second one is always explainable and always overrulable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const triage = require('../../src/connections/reply-triage');
const inbox = require('../../src/connections/reply-inbox');
const connections = require('../../src/connections/service');
const ingestion = require('../../src/connections/email-ingestion');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const created = connections.create(db, workspace.ctx, membership, {
    providerType: 'supplier_email', displayName: 'Shop Mailbox',
  });
  return { db, workspace, ctx: workspace.ctx, connectorId: created.connection.id };
}

let sequence = 0;
function arrive(env, { sender = 'jo@abcschool.test', subject = null, body = null, attachments = [] } = {}) {
  sequence += 1;
  const result = ingestion.capture(env.db,
    { workspaceId: env.workspace.workspaceId, connectorId: env.connectorId },
    { occurredAt: `2026-08-${String((sequence % 28) + 1).padStart(2, '0')}T09:00:00.000Z`,
      data: { messageId: `ext-${sequence}`, sender, subject, bodyText: body, attachments } });
  return inbox.get(env.db, env.workspace.workspaceId, result.actionRecordId);
}

test('a question lands in Needs a reply, and says which words made it one', () => {
  const asked = triage.judge({ sender: 'jo@abcschool.test', subject: 'Our order',
    bodyText: 'Hi — can you confirm the new delivery date?' });
  assert.equal(asked.state, 'NEEDS_REPLY');
  assert.match(asked.reason, /can you/, 'the reason quotes what it actually saw');

  const marked = triage.judge({ sender: 'jo@abcschool.test', subject: 'Where is my order?', bodyText: 'Thanks.' });
  assert.equal(marked.state, 'NEEDS_REPLY');
  assert.match(marked.reason, /asks a question/);
});

test('a filed document owes nobody an answer', () => {
  const verdict = triage.judge({
    sender: 'orders@abc.test', subject: 'Invoice 8832', bodyText: 'Please find attached.',
    attachmentCount: 1, processingStatus: 'MATCHED',
  });
  assert.equal(verdict.state, 'HANDLED');
  assert.match(verdict.reason, /took what it needed/);
});

test('a robot is not a conversation', () => {
  for (const sender of ['no-reply@shopify.com', 'donotreply@ups.com', 'notifications@stripe.com',
    'MAILER-DAEMON@mail.test']) {
    const verdict = triage.judge({ sender, subject: 'Can you confirm?', bodyText: 'When will you collect?' });
    assert.equal(verdict.state, 'HANDLED', `${sender} should not open a conversation`);
    assert.match(verdict.reason, /automatic address/);
  }
  const away = triage.judge({ sender: 'jo@abcschool.test', subject: 'Automatic reply: Out of office',
    bodyText: 'I am away until Monday. Can you contact my colleague?' });
  assert.equal(away.state, 'HANDLED');
});

test('a bare file is a delivery; a long note is a conversation', () => {
  const dropped = triage.judge({ sender: 'jo@abc.test', subject: 'Packing slip',
    bodyText: 'Attached.', attachmentCount: 1 });
  assert.equal(dropped.state, 'HANDLED');
  assert.match(dropped.reason, /file with no question/);

  // Deliberately free of complaint words and question marks, so this exercises
  // the length fallback rather than one of the sharper signals.
  const written = triage.judge({ sender: 'jo@abc.test', subject: 'About the shirts',
    bodyText: 'We took delivery this morning and the team has started sorting them onto '
      + 'the shelves. The sizing runs a little small compared with what we stocked last '
      + 'season, so we are rethinking how we display them in the shop.' });
  assert.equal(written.state, 'NEEDS_REPLY');
  assert.match(written.reason, /has not assumed this is finished/);
});

test('a quoted thread is not counted as somebody writing to you', () => {
  const body = ['Thanks.', '', 'On Tuesday Jo wrote:',
    '> Here is a very long quoted message that goes on at some length about ',
    '> the delivery schedule and the state of the cartons and much else besides,',
    '> easily long enough to look like prose if nobody cut the quote off first.'].join('\n');
  const verdict = triage.judge({ sender: 'jo@abc.test', subject: 'Re: delivery', bodyText: body });
  assert.equal(verdict.state, 'HANDLED', 'only the new words count');
});

test('captured mail is sorted on arrival and the drawers add up', () => {
  const env = setup();
  const asking = arrive(env, { subject: 'Our order', body: 'Can you confirm the date?' });
  const filed = arrive(env, { subject: 'Packing slip', body: 'Attached.',
    attachments: [{ filename: 'slip.pdf', extractedText: 'x' }] });
  const robot = arrive(env, { sender: 'no-reply@ups.com', subject: 'Delivery status notification' });

  assert.equal(asking.reply_state, 'NEEDS_REPLY');
  assert.equal(filed.reply_state, 'HANDLED');
  assert.equal(robot.reply_state, 'HANDLED');
  assert.equal(asking.decidedByPerson, false, 'Foundry decided this one, not a person');

  assert.deepEqual(inbox.counts(env.db, env.workspace.workspaceId),
    { NEEDS_REPLY: 1, WAITING: 0, HANDLED: 2 });
  assert.equal(inbox.list(env.db, env.workspace.workspaceId, 'NEEDS_REPLY').length, 1);
  assert.throws(() => inbox.list(env.db, env.workspace.workspaceId, 'SOMEDAY'), /three drawers/);
});

test('a person can overrule Foundry, and their decision is attributed and kept', () => {
  const env = setup();
  const message = arrive(env, { subject: 'Packing slip', body: 'Attached.',
    attachments: [{ filename: 'slip.pdf', extractedText: 'x' }] });
  assert.equal(message.reply_state, 'HANDLED');

  const moved = inbox.setState(env.db, env.ctx, message.id, 'NEEDS_REPLY',
    'They shorted us two cartons and I have to ask about it.');
  assert.equal(moved.reply_state, 'NEEDS_REPLY');
  assert.equal(moved.decidedByPerson, true);
  assert.match(moved.reply_reason, /shorted us two cartons/);

  // Foundry does not get to re-decide what a person decided.
  assert.throws(() => inbox.rejudge(env.db, env.ctx, message.id), /You already decided/);

  const waiting = inbox.setState(env.db, env.ctx, message.id, 'WAITING');
  assert.equal(waiting.reply_state, 'WAITING');
  assert.match(waiting.reply_reason, /waiting on them/i);
  assert.deepEqual(inbox.counts(env.db, env.workspace.workspaceId),
    { NEEDS_REPLY: 0, WAITING: 1, HANDLED: 0 });
});

test('Foundry can look again at a message nobody has ruled on', () => {
  const env = setup();
  const message = arrive(env, { subject: 'Packing slip', body: 'Attached.',
    attachments: [{ filename: 'slip.pdf', extractedText: 'x' }] });
  env.db.prepare('UPDATE connection_email_messages SET body_text = ? WHERE id = ?')
    .run('Can you send the missing two cartons?', message.id);
  const again = inbox.rejudge(env.db, env.ctx, message.id);
  assert.equal(again.reply_state, 'NEEDS_REPLY');
  assert.equal(again.decidedByPerson, false);
});

test('the oldest unanswered message comes first, because it is the one that becomes a phone call', () => {
  const env = setup();
  const first = arrive(env, { subject: 'Older', body: 'Can you confirm?' });
  const second = arrive(env, { subject: 'Newer', body: 'Can you confirm?' });
  env.db.prepare('UPDATE connection_email_messages SET received_at = ? WHERE id = ?')
    .run('2026-07-01T09:00:00.000Z', first.id);
  env.db.prepare('UPDATE connection_email_messages SET received_at = ? WHERE id = ?')
    .run('2026-08-20T09:00:00.000Z', second.id);

  const queue = inbox.oldestUnanswered(env.db, env.workspace.workspaceId);
  assert.equal(queue[0].subject, 'Older');
  assert.equal(inbox.list(env.db, env.workspace.workspaceId, 'NEEDS_REPLY')[0].subject, 'Newer',
    'reading your mail is newest first; chasing what is overdue is oldest first');
});

test('one inventory never sees another inventory mail', () => {
  const first = setup();
  const second = setup();
  const mine = arrive(first, { subject: 'Ours', body: 'Can you confirm?' });
  arrive(second, { subject: 'Theirs', body: 'Can you confirm?' });

  assert.equal(inbox.list(first.db, first.workspace.workspaceId, 'NEEDS_REPLY').length, 1);
  assert.equal(inbox.list(first.db, first.workspace.workspaceId, 'NEEDS_REPLY')[0].subject, 'Ours');
  assert.throws(() => inbox.get(first.db, second.workspace.workspaceId, mine.id), /not in this inventory/);
});

test('a complaint needs a reply even when nobody phrased it as a question', () => {
  /*
   * Every one of these was filed as handled by the first version of the
   * judgement, which only looked for questions. A complaint is short precisely
   * because somebody is annoyed, and it is the most expensive mail to miss.
   */
  const complaints = [
    'We still have not received the order that was due last Tuesday.',
    'Two of the cartons arrived damaged.',
    'This is the wrong size, we ordered medium.',
    'The invoice is overdue and still outstanding.',
    'We were overcharged on the last delivery.',
  ];
  for (const body of complaints) {
    const verdict = triage.judge({ sender: 'jo@abcschool.test', subject: 'Our order', bodyText: body });
    assert.equal(verdict.state, 'NEEDS_REPLY', `should need a reply: ${body}`);
    assert.match(verdict.reason, /complaint does not have to be phrased as a question/);
  }
});

test('"please" is a request, except when it introduces an attachment', () => {
  const asked = triage.judge({ sender: 'dispatch@courier.test', subject: 'Attempted delivery',
    bodyText: 'We attempted delivery. Please rebook via the link.' });
  assert.equal(asked.state, 'NEEDS_REPLY');
  assert.match(asked.reason, /asked you to do something/);

  for (const body of ['Please find attached our invoice.', 'Please note our office closes at 4pm.',
    'Please do not reply to this message.', 'We are pleased to announce our new range.']) {
    assert.equal(triage.judge({ sender: 'jo@abc.test', subject: 'Notice', bodyText: body }).state,
      'HANDLED', `should not read as a request: ${body}`);
  }
});

test('ordinary mail that needs nothing is left alone', () => {
  /*
   * The other half of the bargain. An inbox that flags everything is one
   * nobody opens, so these must stay filed.
   */
  const quiet = [
    'Hi, just confirming we received the shipment today. All good, thanks!',
    'Sounds good, go ahead.',
    'Payment of 1,240.00 has been sent today. Reference INV-8832.',
    'Our spring range is now available. Browse at our site.',
    'ok',
  ];
  for (const body of quiet) {
    assert.equal(triage.judge({ sender: 'jo@abc.test', subject: 'Note', bodyText: body }).state,
      'HANDLED', `should stay filed: ${body}`);
  }
});

test('no pattern in the judgement carries a stray control character', () => {
  /*
   * Written after a shell-escaping slip put two literal backspace bytes into
   * the "please" pattern, where a word boundary should have been. It still
   * compiled, still ran, and silently matched nothing, which is the worst kind
   * of broken. A regex is hard enough to read without invisible characters in
   * it.
   */
  const hasControl = (value) => [...String(value)]
    .some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });

  for (const pattern of [triage.PLEASE, triage.NO_REPLY_SENDER, triage.AUTOMATIC_SUBJECT]) {
    assert.equal(hasControl(pattern.source), false, `control character inside ${pattern.source}`);
  }
  for (const phrase of [...triage.ASKING, ...triage.PROBLEM]) {
    assert.equal(hasControl(phrase), false, `control character inside "${phrase}"`);
  }
  assert.match(triage.PLEASE.source, /\\bplease\\b/, 'the word boundaries survived');
});

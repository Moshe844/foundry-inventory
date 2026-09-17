'use strict';

/**
 * The bridge between one message and the ledger.
 *
 * The dispatcher that carries a message out is long and has many endings — a
 * proposal page, a drafted order, a question, a refusal, a flash — and every
 * ending is a redirect. So a turn is opened before the dispatcher runs and
 * each goal is settled from where the dispatcher sent the person, which is
 * the one fact every ending shares. The Ask page settles its own goals with
 * the sentence it said and what it read, because it is the one ending that
 * knows.
 *
 * A message with several goals runs the first through the dispatcher and
 * keeps the rest in the session as a queue. Every page then offers the next
 * one, or lets the person leave the rest undone — recorded as such. Nothing
 * asked is dropped without a row saying what became of it.
 */

const crypto = require('node:crypto');
const ledger = require('./ledger');
const { understand, referentNote, resolvePronouns } = require('./understand');

function conversationId(req) {
  if (!req.session) return 'default';
  if (!req.session.assistantConversationId) req.session.assistantConversationId = crypto.randomUUID();
  return req.session.assistantConversationId;
}

/** Forgets the conversation: the next message starts a new one. */
function newConversation(req) {
  if (!req.session) return;
  delete req.session.assistantConversationId;
  delete req.session.assistantQueue;
  delete req.session.assistantOpenGoal;
}

/**
 * Opens (or continues) a turn for this request and installs the settlement
 * hook. Returns the message the dispatcher should carry: the first goal's
 * text when the message held several.
 */
async function begin(req, res, message, options = {}) {
  if (!req.session || !req.ctx || !message) return message;
  const convo = conversationId(req);
  const channel = options.channel || 'tell';
  let goal;
  let turn;
  const continuing = req.body && req.body.assistantGoal ? ledger.getGoal(req.db, req.ctx.workspaceId, String(req.body.assistantGoal)) : null;
  if (continuing && continuing.status === 'pending') {
    // A queued goal, submitted by the person from the "continue" offer.
    goal = continuing;
    turn = ledger.getTurn(req.db, req.ctx.workspaceId, goal.turnId);
    dequeue(req, goal.id);
    message = goal.text;
  } else {
    const referents = ledger.recentReferents(req.db, req.ctx, convo);
    const understanding = await understand(message, {
      provider: options.provider, referents, previousQuestion: options.previousQuestion || null, signal: options.signal,
      // An answer to a clarification is one thing by definition; it is never split.
      noSplit: Boolean(options.noSplit),
    });
    // "Them" and "there" in an instruction mean what the conversation was
    // just about. The rewritten sentence is what the readers see; the
    // person's own words are what the ledger keeps.
    const subjects = ledger.lastSubjects(req.db, req.ctx, convo);
    const pronouns = ['change', 'send', 'report', 'unclear'].includes(understanding.goals[0].kind)
      ? resolvePronouns(understanding.goals[0].text, subjects) : { text: understanding.goals[0].text, swaps: [] };
    turn = ledger.openTurn(req.db, req.ctx, { conversationId: convo, channel, message, understanding: { ...understanding, pronouns: pronouns.swaps }, goals: understanding.goals });
    goal = turn.goals[0];
    if (turn.goals.length > 1) {
      req.session.assistantQueue = {
        turnId: turn.id, total: turn.goals.length, queryConversation: channel === 'ask',
        goals: turn.goals.slice(1).map((g) => ({ id: g.id, text: g.text })),
      };
      message = goal.text;
    }
    if (pronouns.swaps.length) message = pronouns.text;
    req.assistantReferentNote = [referentNote(understanding.referents), ...pronouns.swaps.map((s) => `“${s.word}” means ${s.meaning}`)].filter(Boolean).join('; ');
    // The last thing prepared is what "actually, make it 15" is about: a
    // correction to a proposal is work for the action reader, not a question.
    const last = ledger.lastSettled(req.db, req.ctx, convo);
    const correctable = last && (last.status === 'needs_approval' || (last.status === 'clarify' && ['change', 'send'].includes(last.kind)));
    req.assistantCorrection = correctable && /^\s*(?:actually|no,?\s|make (?:it|that)|change (?:it|that)|instead|rather|sorry|oops|not \d)/i.test(message)
      ? { of: last, text: resolvePronouns(last.text, subjects).text } : null;
  }
  req.assistantTurn = turn;
  req.assistantGoal = goal;
  // The Ask page settles its own goal with what it said; everything else is
  // settled from where the person was sent.
  req.session.assistantOpenGoal = { goalId: goal.id, message };
  const redirect = res.redirect.bind(res);
  res.redirect = (...args) => {
    const url = String(args[args.length - 1] || '');
    try { settleFromRedirect(req, goal.id, url); } catch (err) { console.error('[foundry] could not settle the assistant goal', err); }
    return redirect(...args);
  };
  return message;
}

function dequeue(req, goalId) {
  const queue = req.session && req.session.assistantQueue;
  if (!queue) return;
  queue.goals = queue.goals.filter((g) => g.id !== goalId);
  if (!queue.goals.length) delete req.session.assistantQueue;
}

/** The pending flashes this request has queued, newest last. */
function pendingFlash(req) {
  return (req.session && req.session.flash) || [];
}

/** What a redirect target says became of the goal. */
function settleFromRedirect(req, goalId, url) {
  // A route that already said what became of the goal is not second-guessed.
  if (req.assistantSettled === goalId) return;
  const path = url.split('?')[0];
  const flash = pendingFlash(req);
  const lastFlash = flash[flash.length - 1] || null;
  const handed = req.session && req.session.pendingActionQuestion;
  // The Ask page decides for itself, with the sentence it says.
  if (path === '/ask') return;
  let outcome = null;
  if (/^\/actions\/(?:plan\/)?[A-Za-z0-9_-]+$/.test(path) && !/\/(?:location-required)$/.test(path)) {
    outcome = { status: 'needs_approval', resultHref: url, resultLabel: 'Review and approve', said: 'Prepared for your approval. Nothing has changed yet.' };
    supersede(req, url);
  } else if (path === '/actions' && handed) {
    // The actions page reads this goal back from the ledger and shows it
    // above the question, so the two pages never disagree about what was asked.
    handed.goalId = goalId;
    outcome = handed.unsupported
      ? { status: 'refused', said: handed.unsupported, resultHref: handed.where ? handed.where.href : null, resultLabel: handed.where ? handed.where.label : null }
      : { status: 'clarify', said: handed.question || '', resultHref: '/actions', resultLabel: 'Answer the question' };
  } else if (/^\/purchasing\/orders\/[A-Za-z0-9_-]+$/.test(path)) {
    outcome = { status: 'drafted', resultHref: url, resultLabel: 'Open the draft order', said: lastFlash ? lastFlash.message : 'Drafted. Nothing is ordered until you approve it.' };
    noteFromUrl(req, 'purchase_order', path, lastFlash);
  } else if (/^\/(?:pricing\/proposals|import-removals|supplier-code-mappings|foundry\/proposal|imports|operating-instructions|pricing\/purchase-costs)\b/.test(path)
    || /\/receive(?:\?|$)/.test(url)) {
    outcome = { status: 'needs_approval', resultHref: url, resultLabel: 'Review it', said: lastFlash ? lastFlash.message : 'Prepared for your review. Nothing has changed yet.' };
  } else if (/^\/(?:messages|communications|mailbox|sales\/[A-Za-z0-9_-]+\/(?:email|message))/.test(path)) {
    outcome = { status: 'drafted', resultHref: url, resultLabel: 'Open the draft', said: lastFlash ? lastFlash.message : 'Drafted, not sent. Nothing goes out until you send it.' };
  } else if (path === '/needs-you' || path.startsWith('/needs-you/')) {
    outcome = { status: 'handed', resultHref: url, resultLabel: 'See it in Needs you', said: lastFlash ? lastFlash.message : 'Recorded and placed in Needs you.' };
  } else if (lastFlash && (lastFlash.type === 'error' || lastFlash.type === 'warn' || lastFlash.type === 'warning')) {
    outcome = { status: 'failed', said: lastFlash.message };
  } else if (lastFlash && lastFlash.type === 'success') {
    outcome = { status: 'done', said: lastFlash.message, resultHref: url === '/' ? null : url };
  } else {
    outcome = { status: 'handed', resultHref: url, resultLabel: 'Opened', said: lastFlash ? lastFlash.message : '' };
  }
  ledger.settle(req.db, req.ctx, goalId, outcome);
  if (req.session) delete req.session.assistantOpenGoal;
}

/**
 * "Actually, make it 15" prepared a new proposal; the earlier one it corrects
 * is withdrawn, so there is one thing to approve and not two. The earlier
 * goal records that it was replaced.
 */
function supersede(req, url) {
  const earlier = req.assistantCorrection && req.assistantCorrection.of;
  if (!earlier || !earlier.resultHref || earlier.resultHref === url) return;
  const match = /^\/actions\/([A-Za-z0-9_-]+)$/.exec(earlier.resultHref.split('?')[0]);
  if (!match) return;
  try {
    const proposals = require('../actions/proposal-service');
    const old = proposals.get(req.db, req.ctx.workspaceId, match[1]);
    if (old && old.status === 'AWAITING_APPROVAL') {
      proposals.cancel(req.db, req.ctx, match[1], 'superseded');
      ledger.settle(req.db, req.ctx, earlier.id, { status: 'replaced', said: 'Withdrawn: you changed it, and the corrected version replaced this one.', resultHref: null, resultLabel: null });
      req.flash('info', 'The earlier version was withdrawn; this corrected one replaces it.');
    }
  } catch (err) { console.error('[foundry] could not withdraw the corrected proposal', err); }
}

/** A PO number in the flash becomes a referent a later "that PO" can find. */
function noteFromUrl(req, kind, path, flash) {
  const refId = path.split('/').pop();
  const label = flash && /\b(PO-\d+)\b/.exec(flash.message) ? /\b(PO-\d+)\b/.exec(flash.message)[1] : refId;
  if (req.assistantTurn) ledger.noteReferent(req.db, req.ctx, req.assistantTurn.id, { kind, refId, label, href: path });
}

/** A route settles the goal itself, in its own words; the redirect then leaves it alone. */
function settleNow(req, outcome) {
  const goal = req.assistantGoal;
  if (!goal) return null;
  req.assistantSettled = goal.id;
  if (req.session) delete req.session.assistantOpenGoal;
  return ledger.settle(req.db, req.ctx, goal.id, outcome);
}

/** Called by a route that knows the record it made, so "that PO" resolves. */
function remember(req, referent) {
  if (!req.assistantTurn || !referent) return;
  ledger.noteReferent(req.db, req.ctx, req.assistantTurn.id, referent);
}

/**
 * The Ask page's own settlement: the goal whose message this page is
 * answering gets the sentence said and what was read.
 */
function settleAsk(req, question, outcome) {
  const open = req.session && req.session.assistantOpenGoal;
  if (!open || open.message !== question) return null;
  delete req.session.assistantOpenGoal;
  return ledger.settle(req.db, req.ctx, open.goalId, outcome);
}

/**
 * An answer to a question continues the goal the question belonged to.
 * The actions page's reply forms post here rather than to the dispatcher,
 * so the goal would otherwise stay 'needs an answer' after the answer made
 * a plan. The same settlement hook is installed for the same goal.
 */
function resume(req, res) {
  const handed = req.session && req.session.pendingActionQuestion;
  const goalId = handed && handed.goalId;
  if (!goalId || !req.ctx) return;
  req.assistantGoal = ledger.getGoal(req.db, req.ctx.workspaceId, goalId) || null;
  if (!req.assistantGoal) return;
  req.assistantTurn = ledger.getTurn(req.db, req.ctx.workspaceId, req.assistantGoal.turnId);
  const redirect = res.redirect.bind(res);
  res.redirect = (...args) => {
    const url = String(args[args.length - 1] || '');
    try { settleFromRedirect(req, goalId, url); } catch (err) { console.error('[foundry] could not settle the assistant goal', err); }
    return redirect(...args);
  };
}

/** The queue for the page chrome: what is still to do from the last message. */
function queued(req) {
  const queue = req.session && req.session.assistantQueue;
  if (!queue || !queue.goals.length) return null;
  return { next: queue.goals[0], remaining: queue.goals.length, total: queue.total, queryConversation: queue.queryConversation };
}

/** The person chose to leave the rest undone; the ledger says so. */
function skipQueue(req) {
  const queue = req.session && req.session.assistantQueue;
  if (!queue) return 0;
  let n = 0;
  for (const goal of queue.goals) {
    ledger.settle(req.db, req.ctx, goal.id, { status: 'skipped', said: 'You chose not to continue with this.' });
    n += 1;
  }
  delete req.session.assistantQueue;
  return n;
}

module.exports = { conversationId, newConversation, begin, resume, settleFromRedirect, settleAsk, settleNow, remember, queued, skipQueue };

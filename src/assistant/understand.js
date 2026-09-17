'use strict';

/**
 * One understanding of a message: what is being asked, in how many parts,
 * and what earlier things it refers to.
 *
 * Before this, one sentence could be read six times by six readers with six
 * vocabularies, and "draft an email to Acme and move 5 elbows to the store"
 * was whichever half the first reader noticed. Here the message is split
 * into goals once — in code when the person listed them, by one bounded
 * model call when they are folded into a sentence — and each goal is then
 * carried through the existing pipeline on its own, recorded in the ledger
 * from the moment it is understood.
 *
 * This never decides what to do about a goal. It says how many there are,
 * what each one is roughly for, and which earlier record "that PO" means.
 */

const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');
const { createProviderForTier } = require('../ai/provider');
const config = require('../config');
const intentService = require('../actions/intent-service');
const ledger = require('./ledger');

const KIND_SCHEMA = { type: 'string', enum: ledger.GOAL_KINDS };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['continuesPrevious', 'goals'],
  properties: {
    continuesPrevious: { type: 'boolean' },
    goals: {
      type: 'array', maxItems: 12,
      items: {
        type: 'object', additionalProperties: false, required: ['kind', 'text'],
        properties: { kind: KIND_SCHEMA, text: { type: 'string', maxLength: 2000 } },
      },
    },
  },
};

const SYSTEM = `You split one message to a small-business inventory assistant into the separate things the person wants, and nothing else.
Each goal's text is copied verbatim from the message (a contiguous span, trimmed), in the order written, and together the goals cover everything the person asked for. One thing asked once is one goal, however long. Do not split a single change that names several products or places. Do not add goals that are not in the message, and do not rephrase.
kind: lookup (a question, or a request to show or find records), change (record or change stock, orders, prices, products, suppliers), send (draft, write or send a message or email), communication (a message, call or email that was received or needs handling), instruction (a standing rule for how StockChief should behave), report (something that already happened being reported), navigate (asking to be taken to a page), unsupported (something an inventory assistant plainly does not do, such as payroll), unclear (you cannot tell).
continuesPrevious is true only when the message answers or refines the previous question shown; otherwise false.`;

// "…and reorder…", "…and I shouldn't…", "…and when…": a second thing starts
// after "and" when what follows is a verb, a subject or a condition. A verb
// missing from this list meant the sentence was never split, and one reader
// read both halves as one — the movement was lost inside a rule, or the
// other way round.
const CONJUNCTION = /\b(?:and then|then|and also|also|after that|as well as|plus)\b|,\s*and\b|\band\s+(?:please\s+|also\s+)?(?:draft|write|send|email|message|chase|remind|contact|ask|move|transfer|ship|receive|book|issue|order|reorder|restock|replenish|buy|purchase|pay|record|count|adjust|correct|create|add|set|make|prepare|raise|change|update|rename|call|show|list|find|check|tell|notify|alert|warn|let|block|stop|pause|prevent|never|don'?t|do\s+not|archive|delete|remove|cancel|how|what|which|where|when|whenever|if|once|i|we|you)\b/i;
const REFERENT_WORDS = [
  [/\b(?:that|the|this|its)\s+(?:po|purchase\s+order|order\s+(?:we|you)\s+(?:just\s+)?(?:drafted|wrote|made|raised))\b/i, ['purchase_order']],
  [/\b(?:that|the|this)\s+(?:email|draft|message|reply|note)\b/i, ['message']],
  [/\b(?:that|the|this)\s+(?:proposal|change|transfer|move|correction|adjustment|receipt)\b/i, ['proposal', 'plan']],
  [/\b(?:that|the|this)\s+(?:sales\s+order|customer\s+order|so)\b/i, ['sales_order']],
  [/\b(?:that|the|this)\s+(?:price\s+change|new\s+price)\b/i, ['price_change']],
  [/\b(?:that|the|this)\s+(?:product|item|sku)\b/i, ['product']],
  [/\b(?:that|the|this)\s+customer\b/i, ['customer']],
  [/\b(?:that|the|this)\s+supplier\b/i, ['supplier']],
];

/*
 * The nouns that make a sentence about a communication rather than stock.
 * "I received an email from Acme" is not a receipt of goods, and "send 5
 * cases to the store" is not a message; the object decides.
 */
const COMMUNICATION = /\b(?:e-?mails?|messages?|texts?|calls?|voicemails?|letters?|quotes?|quotations?|replies|reply|invoice\s+from|statement\s+from)\b/i;
const STOCK_OBJECT = /\b\d+\s*(?:x\s*)?(?:units?|cases?|boxes?|pallets?|pcs|pieces|bags?|rolls?|kg|g|lbs?)\b|\b(?:units?|stock|inventory|skus?|cases?|boxes?|pallets?)\b/i;

function guessKind(text) {
  const t = String(text || '').trim();
  if (/^(?:go to|open|take me to|show me the page|where is the)\b/i.test(t)) return 'navigate';
  if (COMMUNICATION.test(t) && !STOCK_OBJECT.test(t)) {
    if (/^(?:draft|write|compose|email|e-mail|send|message|reply|text|forward)\b/i.test(t)) return 'send';
    if (/^(?:how|what|which|who|where|when|why|is|are|do|does|did|can|could|should|show|list|find|any)\b/i.test(t) || /\?\s*$/.test(t)) return 'lookup';
    // "I received an email about pricing": a communication, not stock.
    return 'communication';
  }
  if (/^send\b/i.test(t) && STOCK_OBJECT.test(t)) return 'change';
  if (/^(?:draft|write|compose|email|e-mail|send|message|reply|text)\b/i.test(t)) return 'send';
  if (/^(?:always|never|from now on|whenever|every time|only ever|do not ever|don't ever)\b/i.test(t) || /\b(?:policy|standing rule)\b/i.test(t)) return 'instruction';
  if (/^(?:we|i|they|the customer|a customer|the supplier)\s+(?:sold|received|got|counted|found|paid|returned|shipped|delivered)\b/i.test(t)
    || /\b(?:arrived|came in|has been delivered|was delivered)\b/i.test(t)) return 'report';
  if (/^(?:please\s+)?(?:move|transfer|receive|issue|adjust|correct|set|change|update|create|add|order|buy|purchase|archive|delete|remove|make|configure|record|rename|approve|cancel|ship|pick|pay|book|raise|prepare|write a purchase order)\b/i.test(t)) return 'change';
  if (/^(?:how|what|which|who|where|when|why|is|are|do|does|did|can|could|should|show|list|find|look up|tell me|give me|count|any|anything)\b/i.test(t) || /\?\s*$/.test(t)) return 'lookup';
  return 'unclear';
}

/** Which earlier records the message points at, by the words a person uses. */
function resolveReferents(message, referents = []) {
  const found = [];
  for (const [phrase, kinds] of REFERENT_WORDS) {
    const match = phrase.exec(String(message || ''));
    if (!match) continue;
    const referent = referents.find((r) => kinds.includes(r.kind));
    if (referent) found.push({ phrase: match[0], kind: referent.kind, refId: referent.refId, label: referent.label, href: referent.href });
  }
  return found;
}

/*
 * "Move 10 of them there" after "how many trail ration pack at the store?"
 *
 * The question planner reads pronouns against the previous question; the
 * action reader did not, and answered "there is nothing called ‘them
 * there’". The subjects of the last answered turn — the one product and the
 * one place it was about — are what "them" and "there" mean, and the
 * sentence is rewritten with them before the reader sees it. Only when
 * there is exactly one candidate for each word; otherwise the pronoun is
 * left for the reader to ask about.
 */
function resolvePronouns(message, subjects = {}) {
  let text = String(message || '');
  const swaps = [];
  const moving = /\b(?:move|transfer|send|ship|put|take|bring|receive|issue|sell|sold|order|buy)\b/i.test(text);
  if (!moving) return { text, swaps };
  if (subjects.product && /\b(?:them|those|these|it|that (?:product|item|one)|this (?:product|item|one))\b/i.test(text)) {
    text = text.replace(/(\bof\s+)?\b(?:them|those|these|it|that (?:product|item|one)|this (?:product|item|one))\b/i, () => subjects.product);
    swaps.push({ word: 'them', meaning: subjects.product });
  }
  if (subjects.location && /\b(?:there|that place|that location|the same place)\b/i.test(text)) {
    text = text.replace(/(\s*)\b(to|into|at|from)?\s*\b(?:there|that place|that location|the same place)\b/i, (m, lead, prep) => `${lead || ' '}${prep || 'to'} ${subjects.location}`);
    swaps.push({ word: 'there', meaning: subjects.location });
  }
  return { text: text.replace(/\s{2,}/g, ' ').trim(), swaps };
}

/** The referents as a sentence a reader prompt can carry: “that PO” = PO-1024. */
function referentNote(resolved = []) {
  if (!resolved.length) return '';
  const guard = require('../ai/guard');
  return resolved.map((r) => `“${r.phrase}” means ${guard.recordValue(r.label)}${r.href ? ` (${r.href})` : ''}`).join('; ');
}

/**
 * Every goal must be a verbatim span of the message, in order, and no goal
 * may be a duplicate. Anything else is a rephrasing, and a rephrased goal
 * would be carried through the pipeline in words the person never used.
 */
function verbatim(message, goals) {
  const text = String(message || '');
  let cursor = 0;
  const out = [];
  for (const goal of goals) {
    const span = String(goal.text || '').trim();
    if (!span) return null;
    const at = text.indexOf(span, cursor);
    if (at < 0) return null;
    cursor = at + span.length;
    out.push({ kind: ledger.GOAL_KINDS.includes(goal.kind) ? goal.kind : guessKind(span), text: span });
  }
  return out.length ? out : null;
}

/**
 * Splits a message into goals.
 *
 * A listed message (numbered, semicolons, lines) is split in code. A sentence
 * that joins two requests with "and then", "also", ", and <verb>" is split
 * by one small model call whose answer is checked to be verbatim spans that
 * cover the message; on any doubt the whole message is one goal, which is
 * exactly what happened before this existed.
 */
async function understand(message, options = {}) {
  const clean = String(message || '').trim();
  const referents = resolveReferents(clean, options.referents || []);
  /*
   * A list is several goals only when its lines are different kinds of
   * thing. Twenty lines of "move …" are one plan, and the plan machinery
   * already reads them together; a price list under a heading is one
   * instruction; six numbered questions are one multi-part question. A
   * question followed by a change, or a change followed by an email, are
   * separate goals that would otherwise be read by one reader that only
   * knows one of them.
   */
  const listed = intentService.enumeratedClauses(clean);
  if (listed.length > 1) {
    const kinds = listed.map(guessKind);
    const mixed = new Set(kinds).size > 1 && kinds.every((k) => k !== 'unclear') && !/:\s*$/.test(listed[0]);
    if (mixed) return { continuesPrevious: false, goals: listed.map((text, i) => ({ kind: kinds[i], text })), referents, how: 'list' };
  }
  if (!options.noSplit && CONJUNCTION.test(clean) && clean.length <= 2000 && (options.provider || config.ai.configured)) {
    try {
      const provider = options.provider || createProviderForTier('fast');
      const response = await provider.complete({
        system: SYSTEM,
        prompt: JSON.stringify({ message: clean, previous: options.previousQuestion || null }),
        schema: SCHEMA, schemaName: 'assistant_understanding', signal: options.signal,
      });
      const checked = validate(toWireSchema(SCHEMA), response.data, { key: 'assistant-understanding' });
      const goals = checked.ok ? verbatim(clean, checked.data.goals) : null;
      // Two questions in one sentence are one multi-part question: the
      // planner answers every part together, and "how many are on order"
      // split off on its own has lost what it was asking about.
      if (goals && goals.length > 1 && !goals.every((goal) => goal.kind === 'lookup')) {
        return { continuesPrevious: checked.data.continuesPrevious === true, goals, referents, how: 'model' };
      }
    } catch {
      // One goal is the safe reading; the pipeline that follows asks its own questions.
    }
  }
  return { continuesPrevious: false, goals: [{ kind: guessKind(clean), text: clean }], referents, how: 'single' };
}

module.exports = { SCHEMA, SYSTEM, understand, guessKind, resolveReferents, resolvePronouns, referentNote, verbatim };

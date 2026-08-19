'use strict';

/**
 * Ask Foundry — the language half.
 *
 * The model's entire job is to choose one intent from a fixed list and fill in a
 * handful of bounded parameters. It is not given a database, a table name, or a
 * query language, so "the AI wrote a bad query" is not a failure mode that
 * exists here: the worst it can produce is a supported question about the wrong
 * thing, which the person can see and correct.
 *
 * A question Foundry cannot answer is answered honestly as such. Guessing at an
 * intent to avoid saying "I can't" is how a tool starts lying.
 */

const { createProviderForTier } = require('../ai/provider');
const config = require('../config');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');
const queryService = require('./query-service');
const { requireText } = require('../lib/util');
const { ValidationError } = require('../domain/errors');

const MAX_QUESTION = 400;

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'entityQuery', 'locationQuery', 'windowDays', 'limit', 'unsupportedReason'],
  properties: {
    intent: { type: 'string', enum: queryService.INTENTS },
    // The product or line the person named, in their own words. '' if none.
    entityQuery: { type: 'string' },
    // The place they named. '' if none.
    locationQuery: { type: 'string' },
    windowDays: { type: 'integer' },
    limit: { type: 'integer' },
    // Only when intent is 'unsupported': what Foundry cannot do, in one line.
    unsupportedReason: { type: 'string' },
  },
};

const SYSTEM = `You translate a question about inventory into a lookup plan.

You choose one intent and fill in its parameters. You do not answer the question
— Foundry queries its own records and answers from what it finds.

Intents:
- stock_level: how much of something there is, in total.
- stock_by_location: where something is held, broken down by place.
- movement_history: what happened to something recently.
- recent_adjustments: stock corrections and counts.
- expiring_soon: lots approaching their expiry date.
- idle_stock: things on hand that have not been issued for a while.
- top_moving: what is selling or being used most.
- attention_summary: what needs attention right now.
- replenishment: what they should buy or reorder, and how much.
- on_order: what is already ordered and not yet arrived, or what is due to
  arrive in a period.
- late_orders: purchase orders past their expected arrival date.
- last_cost: what they last paid for something.
- suppliers_for_item: who sells something, or which supplier to use for it.
- foundry_activity: what Foundry itself has been doing — "what did you do",
  "what have you handled today", "what did you get done", "what did you
  create from that invoice", or "what did setup create".
- foundry_why: why Foundry did something — "why did you move those tights",
  "why did you order that". Put what they named in entityQuery.
- stop_automation: they want Foundry to stop doing something by itself —
  "stop moving stock", "don't do that automatically any more".
- action: they are telling Foundry to DO something to their stock — move,
  transfer, receive, issue, remove, adjust, correct a count, add a location.
  Not a question about records; a request to change them. Only things that
  change stock: Foundry cannot contact anyone, so "email the supplier" or
  "chase that order" is unsupported, not an action.
- unsupported: anything else.

Rules:
- entityQuery is the product wording the person used, verbatim and minimal
  ("navy oxfords", "yoghurt"). Use '' when they named nothing.
- locationQuery is the place they named, or ''.
- windowDays is the period they implied. Default 30. "This week" is 7.
- limit is how many rows to return. Default 10.
- Choose 'action' for anything that would change stock — Foundry can do that,
  just not from this page, and it hands the request over.
- Foundry now keeps suppliers, purchase orders and replenishment, so questions
  about buying, incoming stock, lead times, what something cost and who sells
  it all have real answers. Use the purchasing intents for those.
- Choose 'unsupported' only for things Foundry genuinely cannot do at all:
  selling prices, profit, invoices, payments, accounting, customer orders,
  forecasting beyond current usage, or contacting a supplier or customer by any
  means — Foundry drafts purchase orders but never sends or chases them. Put one plain sentence in
  unsupportedReason saying what it cannot do.
- unsupportedReason must be '' for every other intent.`;

function planPrompt(question, context) {
  const vocabulary = context.stockNoun ? `They call their stock "${context.stockNoun}".` : '';
  const locations = (context.locationNames || []).slice(0, 12).join(', ');
  return `${vocabulary}${locations ? ` Their locations: ${locations}.` : ''}

Question: ${question}`;
}

/** Turns a question into a validated plan. Never returns unbounded free text. */
async function plan(question, options = {}) {
  const clean = requireText(question, 'Question', { max: MAX_QUESTION });
  if (!options.provider && !config.ai.configured) {
    throw new ValidationError('Ask Foundry needs an AI provider configured before it can read questions.');
  }

  const provider = options.provider || createProviderForTier('standard');
  const response = await provider.complete({
    system: SYSTEM,
    prompt: planPrompt(clean, options.context || {}),
    schema: PLAN_SCHEMA,
    schemaName: 'foundry_query_plan',
  });

  const result = validate(toWireSchema(PLAN_SCHEMA), response.data, { key: 'query-plan-wire' });
  if (!result.ok) {
    return queryService.normalisePlan({
      intent: 'unsupported',
      unsupportedReason: 'Foundry could not work out what that question was asking for.',
    });
  }

  // Whatever came back, it is bounded before it reaches the executor.
  return queryService.normalisePlan(result.data);
}

/** The whole path: question → plan → deterministic lookup → grounded answer. */
async function ask(db, workspaceId, question, options = {}) {
  const queryPlan = await plan(question, options);
  const result = queryService.execute(db, workspaceId, queryPlan, { question: String(question).trim() });
  return { question: String(question).trim(), ...result };
}

module.exports = {
  PLAN_SCHEMA,
  SYSTEM,
  MAX_QUESTION,
  plan,
  ask,
};

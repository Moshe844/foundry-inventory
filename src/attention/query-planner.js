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
- inventory_summary: how many active products, tracked variants, units and
  locations the inventory contains, or a general inventory overview.
- stock_level: how much of something there is, in total.
- stock_by_location: where something is held, broken down by place.
- movement_history: what happened to something recently.
- recent_adjustments: stock corrections and counts.
- expiring_soon: lots approaching their expiry date.
- idle_stock: things on hand that have not been issued for a while.
- top_moving: what is selling or being used most.
- attention_summary: what needs attention right now.
- replenishment: what they should buy or reorder, and how much.
- why_low: why a named product is low, short, running out or below its level —
  "why is this low", "why are we short of navy oxfords", "how did we get so low
  on rope", "should I be worried about yoghurt". They are asking for the
  reasoning, not the number. Put the product in entityQuery.
- on_order: what is already ordered and not yet arrived, or what is due to
  arrive in a period.
- late_orders: purchase orders past their expected arrival date.
- supplier_order_status: whether a supplier confirmed an order, what is still
  outstanding from a supplier, or why a named PO is late. Put the supplier or
  PO number in entityQuery.
- supplier_document_changes: what a supplier changed on an invoice,
  acknowledgement, shipment notice or other document. Put the supplier,
  PO number, invoice/reference or subject wording in entityQuery.
- supplier_price_changes: supplier price increases in a period. Put the named
  supplier in entityQuery, or '' for every supplier.
- last_cost: what they last paid for something.
- suppliers_for_item: who sells something, or which supplier to use for it.
- selling_price: the current customer selling price of a product or variant.
- sales_summary: how many customer sales orders are open, committed,
  backordered/waiting for stock or fulfilled.
- books_health: whether anything is wrong with the books — missing supplier
  bills, overdue money in or out, payments that look duplicated, sales with no
  payment recorded, stock with no proven cost. "Is anything wrong?", "check my
  books", "did I miss anything", "is everything correct". Not a request for a
  figure: use profit_and_loss, cash_position or the aging intents for those.
- financial_summary: overall financial health, financial pulse, or how the
  business is doing financially.
- business_health: a whole-business briefing combining inventory, customer
  orders, purchasing, suppliers, connections and money — "how are we doing?".
- cash_pressure: why cash is low or where operational cash pressure comes from.
- customer_orders_at_risk: which customer orders may miss their requested date.
- stock_coverage: whether current and incoming stock covers open customer orders.
- supplier_risk: which suppliers or late supplier orders are causing problems.
- next_attention: what is most likely to need the owner's attention next, or
  whether there is anything to worry about.
- profit_and_loss: revenue, gross profit, net profit, loss, expenses, margin,
  or a profit-and-loss question.
- balance_sheet: assets, liabilities, equity, or balance sheet.
- cash_position: cash or bank book balance.
- receivables_aging: customer invoices, who owes money, AR or receivables aging.
- payables_aging: supplier bills, what the business owes, AP or payables aging.
- inventory_valuation: inventory value at cost or cost valuation.
- sales_tax_summary: sales tax collected, recoverable, payable or liability.
- bills_due: supplier bills due soon or in a named period.
- customer_payments: how much a named customer paid. Put the customer in entityQuery.
- supplier_spend: purchase volume and payments for a named supplier. Put the supplier in entityQuery.
- product_profitability: which product has the most gross profit.
- location_profitability: which location has the most gross profit.
- financial_comparison: why profit changed or comparison with the prior period.
- slow_inventory_value: money tied up in slow or idle inventory.
- connection_summary: which external connections are connected, disconnected,
  stale, or need attention.
- connection_last_event: the last activity or event received from a named
  external connection. Put the connection name in entityQuery.
- connection_mapping_issues: products or locations from a named connection that
  still need a Foundry mapping. Put the provider or connection in entityQuery.
- connection_diagnostics: why a named connection's activity is missing or not
  showing. Put the provider or connection in entityQuery.
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
  change stock. Supplier communication requests are handled through the
  supplier and purchase-order workflows, not this stock-action intent.
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
  tax filing, payroll, automatic bill payment without authority, or forecasting beyond available evidence. Foundry can answer
  financial questions from its posted ledger and can prepare, send and
  follow up supplier messages according to its recorded authority. Put one plain sentence in
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
  if (/\b(?:how are we doing|how is (?:my|our|the) business|business briefing|business right now|overall business)\b/i.test(clean)
      && !/\bfinancial(?:ly)?\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'business_health', windowDays: 30 });
  }
  if (/\bwhy\b.*\b(?:cash|money)\b.*\b(?:low|short|down|tight)|\bwhy\b.*\b(?:low|short|tight)\b.*\b(?:cash|money)\b|\bwhat(?:'s| is) (?:using|hurting|draining) (?:our|my) cash\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'cash_pressure', windowDays: 30 });
  }
  if (/\bwhich\b.*\bcustomer orders?\b.*\b(?:risk|late|miss)|\bcustomer orders?\b.*\bat risk\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'customer_orders_at_risk' });
  }
  if (/\b(?:enough|sufficient) (?:stock|inventory)\b.*\b(?:cover|fulfill|fulfil)|\bcover\b.*\b(?:customer orders?|demand)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'stock_coverage' });
  }
  if (/\bwhich suppliers?\b.*\b(?:problem|risk|late|delay)|\bsuppliers?\b.*\bcausing problems?\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'supplier_risk' });
  }
  if (/\bwhat\b.*\b(?:attention next|need attention next)|\banything\b.*\b(?:worry|concern)|\bwhat should i worry about\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'next_attention' });
  }
  if (/\bwhy\s+did\s+(?:keeper|foundry|you|we)\s+(?:order|buy|reorder)\b/i.test(clean)) {
    const entityQuery = clean.replace(/^.*?\b(?:order|buy|reorder)\b/i, '')
      .replace(/[?.!]+$/g, '').trim();
    return queryService.normalisePlan({ intent: 'foundry_why', entityQuery });
  }
  if (/\b(?:which|what)\s+product\b.*\b(?:profit|money|margin)|\bmost\s+profitable\s+product/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'product_profitability', windowDays: /year/i.test(clean) ? 365 : 30 });
  }
  if (/\b(?:which|what)\s+location\b.*\b(?:profit|money|margin)|\bmost\s+profitable\s+location/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'location_profitability', windowDays: /year/i.test(clean) ? 365 : 30 });
  }
  if (/\b(?:why\s+(?:was|is)\s+profit|what\s+changed|compare).*(?:last|prior|month|period)|\bsince\s+last\s+month/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'financial_comparison', windowDays: /week/i.test(clean) ? 7 : 30 });
  }
  if (/\b(?:money|cash|value)\b.*\b(?:tied\s+up|slow|idle)\b.*\b(?:inventory|stock)|\bslow\s+inventory\s+value/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'slow_inventory_value', windowDays: /year/i.test(clean) ? 365 : 90 });
  }
  if (/\bhow\s+much\b.*\b(?:customer|school|client)?\s*paid\b/i.test(clean)) {
    const entityQuery = clean.replace(/\b(?:how|much|did|has|have|customer|client|paid|pay|me|us|this|month|year|week)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    return queryService.normalisePlan({ intent: 'customer_payments', entityQuery, windowDays: /year/i.test(clean) ? 365 : 30 });
  }
  if (/\bhow\s+much\b.*\b(?:spend|spent|purchases?|bought)\b.*\b(?:with|from)\b/i.test(clean)) {
    const entityQuery = clean.replace(/^.*?\b(?:with|from)\b/i, '').replace(/\b(?:this|month|year|week)\b/gi, ' ').trim();
    return queryService.normalisePlan({ intent: 'supplier_spend', entityQuery, windowDays: /year/i.test(clean) ? 365 : 30 });
  }
  if (/\bbills?\b.*\bdue\b|\bwhat\s+is\s+due\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'bills_due', windowDays: /week/i.test(clean) ? 7 : 30 });
  }
  if (/\bbills?\b.*\b(?:pay|owe)\b|\bwhat\s+(?:do\s+)?we\s+owe\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'payables_aging' });
  }
  if (/\b(?:profit\s*(?:and|&)\s*loss|p\s*&\s*l|gross\s+profit|net\s+(?:profit|income)|revenue|operating\s+expenses?|margin)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'profit_and_loss', windowDays: /this\s+week/i.test(clean) ? 7 : /this\s+year/i.test(clean) ? 365 : 30 });
  }
  if (/\b(?:balance\s+sheet|assets?\s+and\s+liabilit|equity)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'balance_sheet' });
  }
  if (/\b(?:cash\s+(?:position|balance)|how\s+much\s+cash|bank\s+balance)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'cash_position' });
  }
  if (/\b(?:accounts?\s+receivable|a\s*\/\s*r|who\s+owes|customer\s+invoices?|receivables?\s+aging)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'receivables_aging' });
  }
  if (/\b(?:accounts?\s+payable|a\s*\/\s*p|bills?\s+(?:to\s+pay|due)|what\s+(?:do\s+)?we\s+owe|payables?\s+aging)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'payables_aging' });
  }
  if (/\b(?:inventory\s+(?:value|valuation)|value\s+of\s+(?:my|our|the)\s+inventory|stock\s+value)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'inventory_valuation' });
  }
  if (/\b(?:sales\s+tax|tax\s+(?:payable|liability|collected|recoverable))\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'sales_tax_summary' });
  }
  if (/\b(?:financial\s+(?:summary|health|pulse)|how\s+(?:is|are)\s+(?:the\s+)?business\s+doing)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'financial_summary', windowDays: 30 });
  }
  if (/\b(?:how many|number of|count of|total)\s+(?:active\s+)?(?:items?|products?|skus?|variants?)\b.*\b(?:inventory|catalog(?:ue)?)\b/i.test(clean)
      || /\b(?:inventory|catalog(?:ue)?)\s+(?:summary|overview)\b/i.test(clean)
      || /\bwhat(?:'s| is)\s+in\s+(?:my|our|the)\s+inventory\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'inventory_summary' });
  }
  if (/\b(?:what|which)\s+connections?\b.*\b(?:attention|connected|status|problem)|\bconnections?\s+(?:need|needs|status)/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'connection_summary' });
  }
  if (/\b(?:last|latest|most recent)\s+(?:event|activity)\b.*\b(?:connection|pos|feed|email)|\bwhat\s+was\s+the\s+last\s+event\b/i.test(clean)) {
    const entityQuery = clean.replace(/\b(?:what|was|the|last|latest|most|recent|event|activity|received|from|connection)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    return queryService.normalisePlan({ intent: 'connection_last_event', entityQuery });
  }
  if (/\b(?:which|what)\b.*\b(?:products?|skus?|locations?)\b.*\b(?:unmapped|not\s+mapped|aren'?t\s+mapped|isn'?t\s+mapped|need(?:s|ing)?\s+(?:a\s+)?match)|\b(?:unmapped|mapping\s+issues?)\b/i.test(clean)) {
    const entityQuery = clean.replace(/\b(?:which|what|products?|skus?|locations?|are|is|aren'?t|isn'?t|not|unmapped|mapped|mapping|issues?|need|needs|a|match)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    return queryService.normalisePlan({ intent: 'connection_mapping_issues', entityQuery });
  }
  if (/\bwhy\b.*\b(?:shopify|square|woocommerce|pos|sales?|orders?|connection|events?)\b.*\b(?:not|didn'?t|aren'?t|missing|show(?:ing)?|arriv(?:e|ing))\b/i.test(clean)) {
    const entityQuery = clean.replace(/\b(?:why|are|is|did|do|does|aren'?t|isn'?t|didn'?t|doesn'?t|not|today'?s?|sales?|orders?|events?|show|showing|arrive|arriving|missing|from|the|my)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    return queryService.normalisePlan({ intent: 'connection_diagnostics', entityQuery });
  }
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

'use strict';

/**
 * Ask StockChief — the language half.
 *
 * Production chat interprets meaning into a composable, reviewed read plan.
 * Legacy single-intent planning remains available for offline integrations.
 * Neither path lets model-generated SQL or factual prose reach the answer.
 *
 * A question StockChief cannot answer is answered honestly as such. Guessing at an
 * intent to avoid saying "I can't" is how a tool starts lying.
 */

const { createProviderForTier } = require('../ai/provider');
const config = require('../config');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');
const queryService = require('./query-service');
const phrasing = require('./answer-phrasing');
const { requireText } = require('../lib/util');
const { ValidationError } = require('../domain/errors');
const productNavigation = require('../product-brain/navigation');
const { canonical: productBrain } = require('../product-brain/registry');
const destinationContracts = require('../product-brain/destinations');
const semanticQuery = require('./semantic-query');

const MAX_QUESTION = 2000;

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
    // Only when intent is 'unsupported': what StockChief cannot do, in one line.
    unsupportedReason: { type: 'string' },
  },
};

const SYSTEM = `You translate a question about inventory into a lookup plan.

You choose one intent and fill in its parameters. You do not answer the question
— StockChief queries its own records and answers from what it finds.

Intents:
- inventory_summary: how many active products, tracked variants, units and
  locations the inventory contains, or a general inventory overview.
- kit_definition: what components and quantities make up a named kit/BOM, or
  which kits are configured. Put the kit name or SKU in entityQuery.
- stock_level: how much of something there is, in total.
- stock_by_location: where something is held, broken down by place.
- movement_history: what happened to something recently.
- recent_adjustments: stock corrections and counts.
- expiring_soon: lots approaching their expiry date.
- idle_stock: things on hand that have not been issued for a while.
- top_moving: what is selling or being used most.
- top_customers: which customers ordered the most, ranked from recorded sales
  orders. Put a named customer in entityQuery only when one was supplied.
- attention_summary: what needs attention right now.
- replenishment: what they should buy or reorder, and how much.
- never_stocked: active catalogue products that show "None yet" because no
  stock movement has ever been recorded for them. This is different from a
  previously stocked product whose current quantity has fallen to zero.
- out_of_stock: previously stocked products whose total current quantity is
  zero across all locations.
- demand_forecast: expected demand over a future period, calculated from
  recorded demand history. This is an estimate with evidence and confidence,
  not a promise. Use 90 days for a quarter and 365 for a year.
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
- shipment_status: where a customer parcel or order is now, whether it arrived,
  its tracking number, or its carrier-confirmed delivery evidence. Put the
  order number, shipment number, customer or tracking number in entityQuery.
- shipping_exceptions: which customer shipments are delayed, lost, returned,
  damaged, or otherwise have a carrier exception.
- shipping_costs: what customers paid for shipping versus outbound postage,
  voids/refunds, carrier adjustments and return postage.
- carrier_performance: which carrier is late most often or has the strongest
  on-time history, using only promised dates and confirmed deliveries.
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
- period_profit_and_customer_cash: reconcile profit for a period with total
  customer cash received for that period. Use this when no particular sale,
  order, customer, or product is named.
- sale_profit_and_payment: explain a particular sale's price, exact product
  cost and gross profit together with whether the customer paid and what they
  still owe. Put any order, customer or product words in entityQuery.
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
  still need a StockChief mapping. Put the provider or connection in entityQuery.
- connection_diagnostics: why a named connection's activity is missing or not
  showing. Put the provider or connection in entityQuery.
- foundry_activity: what StockChief itself has been doing — "what did you do",
  "what have you handled today", "what did you get done", "what did you
  create from that invoice", or "what did setup create".
- foundry_why: why StockChief did something — "why did you move those tights",
  "why did you order that". Put what they named in entityQuery.
- stop_automation: they want StockChief to stop doing something by itself —
  "stop moving stock", "don't do that automatically any more".
- action: they are telling StockChief to DO something rather than asking it
  something — move, transfer, receive, issue, adjust, correct a count, add a
  location, pay a supplier, email a customer, delete the whole inventory.
  Anything phrased as an instruction belongs here, even when it is polite or
  begins "can you". This used to be limited to things that change stock, so a
  request to delete an inventory or send an email had nowhere to go and came
  back as "StockChief cannot do that" — which was untrue both times. StockChief has
  a separate reader for carrying instructions out; your job is only to notice
  that this is one.
- unsupported: anything else.

Rules:
- entityQuery is the product wording the person used, verbatim and minimal
  ("navy oxfords", "yoghurt"). Use '' when they named nothing.
- locationQuery is the place they named, or ''.
- windowDays is the period they implied. Default 30. "This week" is 7.
- limit is how many rows to return. Default 10.
- Choose 'action' for anything that would change stock or records; StockChief
  hands it to its instruction reader.
- Buying, incoming stock, lead times, what something cost and who sells it are
  the purchasing intents; they have real answers.
- This is a list of lookups, not of StockChief's abilities: it also emails
  customers and suppliers, keeps books, deletes inventories and takes
  payments. Never say it cannot do something because no lookup here matches;
  if nothing matches, ask what evidence or measure the person needs.
- Choose 'unsupported' only when the product contract below says the
  capability is not available; then put one plain sentence in
  unsupportedReason. For every other intent unsupportedReason is ''.

Authoritative product contract (the model may interpret it but may not override it):
${productBrain.capabilityPrompt()}`;

/*
 * The same prompt, cut to the intents a question can use.
 *
 * The intent list is parsed from SYSTEM above once, so there is one place
 * the descriptions live; a scoped prompt keeps the preamble and the rules,
 * lists only the intents handed to it, and carries the product contract in
 * its short form (what is available, what is not and why) rather than
 * every capability's description.
 */
const INTENT_BLOCK = SYSTEM.slice(SYSTEM.indexOf('Intents:\n') + 'Intents:\n'.length, SYSTEM.indexOf('\nRules:'));
const INTENT_DESCRIPTIONS = Object.fromEntries(INTENT_BLOCK.split(/\n(?=- [a-z_]+: )/).map((entry) => {
  const m = /^- ([a-z_]+): ([\s\S]*)$/.exec(entry.trim());
  return m ? [m[1], m[2].replace(/\s*\n\s+/g, ' ').trim()] : null;
}).filter(Boolean));
const PREAMBLE = SYSTEM.slice(0, SYSTEM.indexOf('Intents:\n'));
const RULES = SYSTEM.slice(SYSTEM.indexOf('\nRules:') + 1, SYSTEM.indexOf('Authoritative product contract'));

function systemFor(intentIds) {
  const wanted = Array.isArray(intentIds) && intentIds.length ? intentIds : Object.keys(INTENT_DESCRIPTIONS);
  const lines = wanted.filter((id) => INTENT_DESCRIPTIONS[id]).map((id) => `- ${id}: ${INTENT_DESCRIPTIONS[id]}`);
  return `${PREAMBLE}Intents:\n${lines.join('\n')}\n${RULES}Authoritative product contract (the model may interpret it but may not override it):\n${productBrain.capabilityPrompt({ compact: true })}`;
}

function planPrompt(question, context) {
  const vocabulary = context.stockNoun ? `They call their stock "${context.stockNoun}".` : '';
  const locations = (context.locationNames || []).slice(0, 12).join(', ');
  return `${vocabulary}${locations ? ` Their locations: ${locations}.` : ''}

Question: ${question}`;
}

/** Turns a question into a validated plan. Never returns unbounded free text. */
async function plan(question, options = {}) {
  const clean = requireText(question, 'Question', { max: MAX_QUESTION });
  /* A natural owner question can span two accounting columns. Preserve the
     whole request for the deterministic joined read model instead of letting
     a single-intent classifier answer only the profit or only the payment. */
  const asksSaleEconomics = /\b(?:profit|margin|cost|made|make|earn(?:ed|ing)?)\b/i.test(clean);
  const asksCustomerPayment = /\b(?:paid|payment|pay|owe|owing|received)\b/i.test(clean);
  const namesOneSale = /\bSO[-\s]?\d+\b/i.test(clean)
    || /\b(?:this|that|last|latest|specific)\s+(?:sale|order)\b/i.test(clean)
    || /\b(?:on|from|for)\s+(?:the\s+)?[^?.]{1,60}\s+(?:sale|order)\b/i.test(clean);
  if (asksSaleEconomics && asksCustomerPayment
      && /\b(?:sale|order|customers?|sold|product|item)\b/i.test(clean)) {
    return queryService.normalisePlan({
      intent: namesOneSale ? 'sale_profit_and_payment' : 'period_profit_and_customer_cash',
      entityQuery: namesOneSale ? clean : '',
      windowDays: /this\s+week/i.test(clean) ? 7 : /this\s+year/i.test(clean) ? 365 : 30,
    });
  }
  /*
   * Balance questions outrank purchase-volume questions.  An owner can ask for
   * both the remaining supplier balance and the payments behind it in one
   * sentence; sending that to supplier_spend loses the payable proof and its
   * exact destination.  Match the financial relationship, not one sample
   * wording or supplier name.
   */
  if (/\b(?:what|how much)\b.*\b(?:we|i)\b.*\b(?:still\s+)?owe\b|\b(?:remaining|open|outstanding)\b.*\b(?:supplier|bill|balance)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'payables_aging', entityQuery: clean });
  }
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

  // Shipping questions are resolved before the general financial/order
  // patterns so “what did customers pay for shipping?” cannot become a broad
  // customer-payment answer and “where is order 10582?” cannot become search.
  if (/\b(?:which|what)\s+carrier\b.*\b(?:late|reliable|on[ -]?time|best|worst)|\bcarrier\b.*\b(?:late most|performance|reliability)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'carrier_performance',
      windowDays: /\byear\b/i.test(clean) ? 365 : /\bweek\b/i.test(clean) ? 7 : 90 });
  }
  if (/\b(?:shipping|postage|delivery)\b.*\b(?:cost|costs|costing|spent|spend|paid|charge|charged|margin|refund|void|adjustment)\b|\b(?:paid|charge|charged|spent|spend)\b.*\b(?:shipping|postage|delivery)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'shipping_costs',
      windowDays: /\byear\b/i.test(clean) ? 365 : /\bweek\b/i.test(clean) ? 7 : 30 });
  }
  if (/\b(?:what(?:'s| is)|which|any)\b.*\b(?:shipment|package|parcel|delivery|order)\b.*\b(?:delay|late|lost|damage|exception|problem|stuck|returned)|\bwhat(?:'s| is) delayed\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'shipping_exceptions',
      windowDays: /\btoday\b/i.test(clean) ? 1 : /\bweek\b/i.test(clean) ? 7 : 30 });
  }
  if (/\bwhere\b.*\b(?:order|shipment|package|parcel|delivery)\b|\b(?:did|has|have|is)\b.*\b(?:package|parcel|order|shipment)\b.*\b(?:arrive|arrived|delivered|ship|shipped)|\b(?:track|tracking|status)\b.*\b(?:order|shipment|package|parcel)\b/i.test(clean)) {
    const entityQuery = clean.replace(/\b(?:where|is|are|did|has|have|the|my|our|order|shipment|package|parcel|delivery|arrive|arrived|delivered|ship|shipped|track|tracking|status|for|of|please)\b/gi, ' ')
      .replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim();
    return queryService.normalisePlan({ intent: 'shipment_status', entityQuery });
  }

  if (/\bnone\s+yet\b|\bnever\s+(?:been\s+)?stocked\b|\b(?:no|zero)\s+(?:stock|stocks|inventory)\s+yet\b|\b(?:do(?:es)?n['’]?t|do(?:es)?\s+not|haven['’]?t|hasn['’]?t)\s+(?:have|had|got)\s+(?:any\s+)?(?:stock|stocks|inventory)\s+yet\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'never_stocked' });
  }
  if (/\bout\s+of\s+stock\b|\bnothing\s+in\s+stock\b|\b(?:everything|all).*\bshow(?:s|ing)?\s+(?:as\s+)?empty\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'out_of_stock' });
  }
  if (/\b(run(ning)?\s+out|stock\s*out|about\s+to\s+run|likely\s+to\s+run)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'likely_stockouts' });
  }
  if (/\b(?:what|how much)\b.*\bdemand\b.*\b(?:next|future|forecast|quarter|year|month)\b|\bforecast\b.*\bdemand\b/i.test(clean)) {
    const windowDays = /\b(?:quarter|3\s*months?)\b/i.test(clean) ? 90
      : /\byear\b/i.test(clean) ? 365 : 30;
    return queryService.normalisePlan({ intent: 'demand_forecast', windowDays });
  }
  if (/\bwhat\s+(should|do)\s+i\s+(order|buy|purchase)\b|\border\s+this\s+(week|month)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'what_to_order' });
  }
  if (/\b(overstock|over\s*stocked|too\s+much\s+stock|excess\s+(stock|inventory))\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'overstocked' });
  }
  if (/\breduce\s+(inventory|stock)\b|\b(free\s+up|less)\s+(cash|stock|inventory)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'reduce_inventory' });
  }
  if (/\b(most\s+reliable|best)\s+supplier\b|\bwhich\s+supplier\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'most_reliable_supplier' });
  }
  if (/\breorder\s+(settings?|points?|rules?)\b|\bare\s+my\s+(settings|levels)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'reorder_settings_review' });
  }
  if (/\bwhy\b.*\bdemand\b|\bdemand\b.*\b(increasing|rising|falling|dropping|changing)\b/i.test(clean)) {
    const entityQuery = clean
      .replace(/\b(?:why|do|you|think|that|the|is|are|for|our|my|demand|increasing|rising|falling|dropping|changing|going|up|down)\b/gi, ' ')
      .replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim();
    return queryService.normalisePlan({ intent: 'demand_explanation', entityQuery });
  }
  if (/\bhow\s+much\s+stock\s+should\b|\b(?:should|could|can)\s+(?:we|i)\s+(?:rebalance|move|transfer)\b|\b(?:what|how)\b.*\b(?:rebalance|move|transfer)\b/i.test(clean)) {
    const entityQuery = clean
      .replace(/\b(?:how|much|stock|inventory|should|shall|does|do|need|needs|to|keep|hold|carry|at|in|the|a|we|i|move|transfer|rebalance|between|from)\b/gi, ' ')
      .replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim();
    return queryService.normalisePlan({ intent: 'location_stock_advice', entityQuery });
  }
  if (/\bwhich suppliers?\b.*\b(?:problem|risk|late|delay)|\bsuppliers?\b.*\bcausing problems?\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'supplier_risk' });
  }
  if (/\bwhat\b.*\b(?:attention next|need attention next)|\banything\b.*\b(?:worry|concern)|\bwhat should i worry about\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'next_attention' });
  }
  if (/\bwhy\b.*\b(?:buy(?:ing)?|order(?:ing)?|reorder(?:ing)?|purchas(?:e|ing)|replenish(?:ing|ment)?)\b/i.test(clean)) {
    const entityQuery = clean.replace(
      /^.*?\b(?:buy(?:ing)?|order(?:ing)?|reorder(?:ing)?|purchas(?:e|ing)|replenish(?:ing|ment)?)\b/i, ''
    )
      .replace(/[?.!]+$/g, '').trim();
    return queryService.normalisePlan({ intent: 'foundry_why', entityQuery });
  }
  if (/\b(?:which|what)\s+product\b.*\b(?:profit|money|margin)|\bmost\s+profitable\s+product/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'product_profitability', windowDays: /year/i.test(clean) ? 365 : 30 });
  }
  if (/\b(?:which|what)\s+customers?\b.*\b(?:order|buy|spend).*(?:most|largest|highest)|\btop\s+customers?\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'top_customers', windowDays: /year/i.test(clean) ? 365 : 30 });
  }
  if (/\b(?:what|how much)\b.*\b(?:do|did|are)\s+(?:we|i)\s+charg(?:e|ed|ing)\b|\b(?:current|selling|retail|sale)\s+price\b/i.test(clean)) {
    const entityQuery = clean.replace(/\b(?:what|how|much|do|did|are|we|i|charge|charged|charging|current|selling|retail|sale|price|for|these|this)\b/gi, ' ')
      .replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim();
    return queryService.normalisePlan({ intent: 'selling_price', entityQuery });
  }
  if (/\b(?:should|do you recommend)\b.*\b(?:raise|lower|change|set)\b.*\b(?:price|prices|pricing)\b|\bwhat\b.*\b(?:price|prices|pricing)\b.*\b(?:should|recommend)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'unsupported',
      unsupportedReason: 'StockChief can show and set recorded selling prices, but it does not yet calculate a recommended selling price.' });
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
  // "How much is our stock worth?" without saying cost or selling price gets
  // both figures; saying one gets that one.
  const asksWorth = /\b(?:how\s+much\s+(?:is|are)\s+(?:all\s+)?(?:my|our|the)?\s*(?:stock|inventory)\s+worth|(?:stock|inventory)\b[^.?!]{0,40}\b(?:in\s+(?:dollars|money|\$)|worth)|(?:value|worth)\s+of\s+(?:all\s+)?(?:my|our|the)\s+(?:stock|inventory)|(?:inventory|stock)\s+(?:value|valuation))\b/i.test(clean);
  // "Valuation" is the accounting word for the cost figure.
  const saysBasis = /\b(?:cost|paid|book|valuation|selling|retail|sale\s+price|sell\s+for)\b/i.test(clean);
  if (asksWorth && !saysBasis) return queryService.normalisePlan({ intent: 'stock_worth' });
  if (asksWorth && /\b(?:selling|retail|sale\s+price|sell\s+for)\b/i.test(clean)) return queryService.normalisePlan({ intent: 'inventory_selling_value' });
  if (asksWorth) return queryService.normalisePlan({ intent: 'inventory_valuation' });
  if (/\b(?:sales\s+tax|tax\s+(?:payable|liability|collected|recoverable))\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'sales_tax_summary' });
  }
  if (/\b(?:financial\s+(?:summary|health|pulse)|how\s+(?:is|are)\s+(?:the\s+)?business\s+doing)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'financial_summary', windowDays: 30 });
  }
  if (/\b(?:kit|kits|bom|bill\s+of\s+materials|components?)\b/i.test(clean)
      && /\b(?:what|which|show|list|contain|contains|inside|make\s+up|configured)\b/i.test(clean)) {
    const entityQuery = clean
      .replace(/\b(?:what(?:'s|\s+is)?|which|show|list|me|the|components?|parts?|are|is|in|inside|does|do|contain|contains|make|up|of|a|an|kit|kits|bom|bill|materials|configured)\b/gi, ' ')
      .replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim();
    return queryService.normalisePlan({ intent: 'kit_definition', entityQuery });
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
    throw new ValidationError('Ask StockChief needs an AI provider configured before it can read questions.');
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
      unsupportedReason: 'StockChief could not work out what that question was asking for.',
    });
  }

  // Whatever came back, it is bounded before it reaches the executor.
  return queryService.normalisePlan(result.data);
}

/** The whole path: question → plan → deterministic lookup → grounded answer. */
/** Questions with one right reading, planned without a model. */
function directPlan(db, workspaceId, question) {
  const clean = String(question || '').trim();
  const asksWorth = /\b(?:how\s+much\s+(?:is|are)\s+(?:all\s+)?(?:my|our|the)?\s*(?:stock|inventory)\s+worth|(?:stock|inventory)\b[^.?!]{0,40}\b(?:in\s+(?:dollars|money|\$)|worth)|(?:value|worth)\s+of\s+(?:all\s+)?(?:my|our|the)\s+(?:stock|inventory))\b/i.test(clean);
  let scoped = false;
  try {
    const places = db.prepare('SELECT name FROM locations WHERE workspace_id = ?').all(workspaceId).map((r) => String(r.name || '').toLowerCase());
    const said = clean.toLowerCase();
    scoped = productNavigation.mentionsProduct(db, workspaceId, clean)
      || places.some((name) => name && (said.includes(name) || name.split(/\s+/).some((w) => w.length > 3 && new RegExp(`\\b${w}s?\\b`).test(said))));
  } catch { scoped = false; }
  if (asksWorth && !scoped && !/\b(?:cost|paid|book|valuation|selling|retail|sale\s+price|sell\s+for)\b/i.test(clean)) return queryService.normalisePlan({ intent: 'stock_worth' });
  // "List the open purchase orders with their totals" — the open orders to
  // suppliers, each with what it comes to.
  const asksOpenPurchaseOrders = /\b(?:list|show|what are|which are|give me|get me|all)\b[^.?!]{0,30}\b(?:open|outstanding|pending|current)\s+(?:purchase\s+orders?|pos?\b|supplier\s+orders?)|\b(?:open|outstanding)\s+(?:purchase\s+orders?|pos)\b[^.?!]{0,30}\b(?:totals?|amounts?|values?|worth)\b/i.test(clean);
  if (asksOpenPurchaseOrders && !scoped && !/\b(?:late|overdue|due|from\s+[A-Z])\b/.test(clean)) return queryService.normalisePlan({ intent: 'open_purchase_orders' });
  // "What did we sell last week?" is the sales summary for that window; "a list
  // of all products with their prices" is every selling price.
  const soldWhen = /^\s*(?:so\s+)?what\s+(?:did|have)\s+we\s+(?:sell|sold)(?:\s+(?:last|this|in\s+the\s+last)\s+(?:week|month|7\s+days|30\s+days|quarter|year))?\s*\??\s*$/i.exec(clean);
  // "Which products are we losing money on?" reads the profitability list
  // from the bottom; the executor sees the question and knows which end.
  if (/\b(?:which|what)\s+(?:products?|items?|lines?)\b[^.?!]{0,30}\b(?:los(?:e|es|ing)\s+(?:us\s+)?money|unprofitable|below\s+cost|under\s+cost|negative\s+margin|lowest\s+margin|worst\s+margin)\b/i.test(clean) && !scoped) {
    return queryService.normalisePlan({ intent: 'product_profitability', windowDays: /year/i.test(clean) ? 365 : 30, limit: 10 });
  }
  if (soldWhen && !scoped) {
    const windowDays = /month|30/i.test(clean) ? 30 : /quarter/i.test(clean) ? 90 : /year/i.test(clean) ? 365 : 7;
    return queryService.normalisePlan({ intent: 'sales_summary', windowDays });
  }
  if (/\b(?:list|show|give\s+me)\b[^.?!]{0,20}\b(?:all\s+(?:the\s+|our\s+)?|every\s+|our\s+|the\s+)?products?\b[^.?!]{0,20}\b(?:with\s+)?(?:their\s+)?(?:selling\s+)?prices\b/i.test(clean) && !/\b(?:cost|purchase|supplier)\b/i.test(clean)) {
    return queryService.normalisePlan({ intent: 'selling_price', entityQuery: '', limit: 200 });
  }
  /*
   * Three readings a model got wrong in the live suite, each with one right
   * answer: telling StockChief to stop acting on its own is an automation
   * control, not a stock action; what we charge is the selling price on
   * file; what demand will be is the forecasting engine. Read here first.
   */
  const control = /\b(?:stop|pause|halt|quit|cease|no\s+more|don'?t|do\s+not|never)\b[^.?!]{0,60}\b(?:by\s+yourself|on\s+your\s+own|yourself|automatically|autonomously|without\s+(?:asking|approval|me|my\s+ok(?:ay)?)|autopilot|automation|auto-?pilot)\b/i.test(clean)
    || /\b(?:turn|switch)\s+(?:off|down)\s+(?:the\s+)?(?:autopilot|automation|auto-?pilot|automatic\s+\w+)\b/i.test(clean)
    || /\b(?:stop|pause)\s+(?:the\s+)?(?:autopilot|automation|automatic\s+(?:ordering|transfers?|purchasing|moves?|actions?))\b/i.test(clean);
  if (control && !/\b(?:how\s+do\s+i|where\s+do\s+i|can\s+i)\b/i.test(clean)) return queryService.normalisePlan({ intent: 'stop_automation' });
  const charge = /^\s*(?:so\s+)?(?:what|how\s+much)\s+(?:do|did|should|are|is)\s+we\s+(?:charge|charging|sell(?:ing)?|ask|asking)\b(?:\s+(?:for|on))?\s*(.*?)\s*(?:\s+for)?\s*\??\s*$/i.exec(clean)
    || /^\s*(?:what(?:'s|\s+is|\s+are)\s+(?:the\s+|our\s+)?(?:selling|retail|list|sale)\s+prices?\s+(?:of|for|on)\s+)(.*?)\s*\??\s*$/i.exec(clean);
  if (charge && !/\b(?:cost|paid|pay|supplier|margin|profit)\b/i.test(clean)) {
    const subject = charge[1].replace(/^(?:for|on)\s+/i, '').replace(/\b(?:these|those|them|it|this|that|each|per\s+unit|a\s+unit)\b/gi, '').trim();
    return queryService.normalisePlan({ intent: 'selling_price', entityQuery: subject, limit: subject ? 50 : 200 });
  }
  /*
   * "How many Navy 4 do we have?" and "what did we pay our supplier for
   * these?" came back from the planner as unsupported — the two most
   * ordinary questions in the room. They have one reading each.
   */
  const howMany = /^\s*(?:so\s+)?(?:how\s+many|how\s+much)\s+(.+?)\s+(?:do\s+we\s+have|have\s+we\s+got|are\s+there|is\s+there|do\s+we\s+hold|are\s+(?:in\s+stock|on\s+hand|left)|is\s+(?:in\s+stock|on\s+hand|left)|in\s+stock|on\s+hand)\b(?:\s+(?:in\s+stock|on\s+hand|left|in\s+total|altogether|overall|right\s+now|now|today|at\s+the\s+moment))*(?:\s+(?:at|in)\s+(?:the\s+)?([^?]+?))?\s*\??\s*$/i.exec(clean);
  if (howMany && !/\b(?:sold|sell|order|ordered|owe|worth|cost|paid|customers?|suppliers?|orders?)\b/i.test(clean)) {
    const places = db.prepare('SELECT name FROM locations WHERE workspace_id = ?').all(workspaceId).map((r) => String(r.name));
    const isPlace = (words) => places.find((name) => name.toLowerCase() === String(words || '').trim().toLowerCase()) || '';
    let subject = howMany[1].replace(/^(?:of\s+)?(?:the|our|my)\s+/i, '').trim();
    // "…do we have at Main Warehouse" or "…navy 4 at Main Warehouse do we have".
    let place = isPlace(howMany[2]);
    const at = !place && /^(.*?)\s+(?:at|in)\s+(?:the\s+)?(.+)$/i.exec(subject);
    if (at && isPlace(at[2])) { place = isPlace(at[2]); subject = at[1].trim(); }
    if (howMany[2] && !place) return null;
    if (subject && !/\b(?:products?|items?|skus?|lines?|things|units)\b$/i.test(subject)) {
      return queryService.normalisePlan({ intent: 'stock_level', entityQuery: subject, locationQuery: place });
    }
  }
  const paid = /^\s*(?:so\s+)?(?:what|how\s+much)\s+(?:did|do|have)\s+we\s+(?:last\s+)?(?:pay|paid)\b(?:\s+(?:our|the)\s+suppliers?)?\s+(?:for\s+)?(.*?)\s*(?:\s+last\s+time)?\s*\??\s*$/i.exec(clean)
    || /^\s*(?:what(?:'s|\s+is|\s+was)\s+(?:the\s+|our\s+)?(?:last|latest|unit|purchase)\s+cost\s+(?:of|for)\s+)(.*?)\s*\??\s*$/i.exec(clean)
    || /^\s*(?:how\s+much\s+(?:did|does)\s+)(.+?)\s+cost\s+us\s*\??\s*$/i.exec(clean);
  if (paid && !/\b(?:charge|sell|selling|customers?|invoices?|bills?|owe|total|in\s+total|last\s+(?:week|month|year))\b/i.test(clean)) {
    const subject = paid[1].replace(/\b(?:these|those|them|it|this|that)\b/gi, '').replace(/^(?:the|our|my)\s+/i, '').trim();
    return queryService.normalisePlan({ intent: 'last_cost', entityQuery: subject });
  }
  const forecast = /\b(?:forecast|demand|projected|projection|expected\s+sales|how\s+many\s+will\s+we\s+(?:sell|need)|how\s+much\s+will\s+we\s+(?:sell|need)|what\s+will\s+we\s+(?:sell|need))\b/i.test(clean)
    && /\b(?:next|coming|upcoming|this|the\s+next)\s+(?:week|month|quarter|year|season|\d+\s+(?:days|weeks|months))\b|\bforecast\b|\bdemand\b/i.test(clean);
  if (forecast && !scoped && !/\b(?:order|buy|purchase|reorder|price|charge)\b/i.test(clean)) {
    const windowDays = /quarter|3\s+months|90/i.test(clean) ? 90 : /year|12\s+months/i.test(clean) ? 365 : /week|7\s+days/i.test(clean) ? 7 : 30;
    return queryService.normalisePlan({ intent: 'demand_forecast', windowDays });
  }
  return null;
}

async function ask(db, workspaceId, question, options = {}) {
  const navigation = await productNavigation.resolveNatural(
    db, workspaceId, options.membership || null, question,
    { brain: options.productBrain, provider: options.provider,
      actorId: options.actorId, currentHref: options.currentHref }
  );
  if (navigation) return productNavigation.asQueryResult(question, navigation);

  const useSemantic = options.semantic !== false && (options.provider || config.ai.configured);
  // A few questions have one right reading and no need of a model: they are
  // answered from the closed form, so the answer is the same every time.
  const direct = directPlan(db, workspaceId, question);
  // General knowledge — "what does FIFO mean?" — is answered as such and
  // labelled, with no lookup and no record values in the prompt.
  const general = require('../assistant/general-knowledge');
  const generalFirst = !direct && useSemantic && general.looksGeneral(db, workspaceId, question);
  if (generalFirst) {
    const said = await general.answer(question, { provider: options.provider || createProviderForTier('fast') });
    if (said.answer && !said.needsRecords) return finishAsk(question, general.asResult(question, said.answer), options);
  }
  let rawResult = direct
    ? queryService.execute(db, workspaceId, direct, { question: String(question).trim(), membership: options.membership || null })
    : useSemantic
    ? await semanticQuery.ask(db, workspaceId, question, {
      ...options, provider: options.provider || createProviderForTier('standard'),
      intentSystem: SYSTEM, intentSystemFor: systemFor, legacySchema: PLAN_SCHEMA,
      legacyPlan: (text, response) => plan(text, {...options,provider:{complete:async()=>response}}),
    })
    : queryService.execute(db, workspaceId, await plan(question, options), {
      question: String(question).trim(), membership: options.membership || null,
    });
  // The planner asked "which product?" of a question that names none:
  // it is general knowledge, and is answered as that rather than bounced.
  if (!direct && useSemantic && !generalFirst && rawResult && rawResult.needsClarification && !rawResult.isAction
      && general.looksGeneral(db, workspaceId, question)) {
    const said = await general.answer(question, { provider: options.provider || createProviderForTier('fast') });
    if (said.answer && !said.needsRecords) rawResult = general.asResult(question, said.answer);
  }
  return finishAsk(question, rawResult, options);
}

/** Access checks and hand-off hrefs, the same for every answer. */
async function finishAsk(question, rawResult, options = {}) {
  const brain = options.productBrain || productBrain;
  const result = { ...rawResult };
  if (result.handoff && options.membership) {
    const access = destinationContracts.contract(result.handoff.href, options.membership, { brain });
    if (!access.allowed) result.handoff = null;
    else result.handoff = { ...result.handoff,
      href: productNavigation.handoffHref(result.handoff.href, result.handoff.label,
        `/ask?q=${encodeURIComponent(String(question).trim())}`) };
  }
  if (Array.isArray(result.rows) && options.membership) {
    result.rows = result.rows.map((row) => {
      if (!row || !row.href) return row;
      const access = destinationContracts.contract(row.href, options.membership, { brain });
      if (access.allowed) return row;
      const safe = { ...row };
      delete safe.href;
      return safe;
    });
  }
  if (result.sections && options.membership) {
    result.sections = result.sections.map(section => ({...section,
      handoff: section.handoff && destinationContracts.contract(section.handoff.href,options.membership,{brain}).allowed ? section.handoff : null,
      rows: section.rows.map(row => {
        if (!row.href || destinationContracts.contract(row.href,options.membership,{brain}).allowed) return row;
        const safe={...row};delete safe.href;return safe;
      }),
    }));
  }

  /*
   * The wording, once the figures are settled.
   *
   * The deterministic answer is already complete and is the statement of
   * record. Cosmetic rephrasing must never sit between a person and figures
   * StockChief has already read locally. Callers may explicitly opt into it for a
   * non-blocking surface; Ask StockChief returns the proved answer immediately.
   */
  let spoken = null;
  if (options.phraseAnswers === true && result.answerMode !== 'verified') {
    try {
      spoken = await phrasing.phrase(String(question).trim(), result, options);
    } catch {
      spoken = null;
    }
  }

  return { question: String(question).trim(), ...result, spoken };
}

module.exports = {
  __directPlan: directPlan,
  PLAN_SCHEMA,
  SYSTEM,
  systemFor,
  INTENT_DESCRIPTIONS,
  MAX_QUESTION,
  plan,
  ask,
};

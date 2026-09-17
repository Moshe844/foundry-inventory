'use strict';

/**
 * A question that is about neither this business's records nor StockChief.
 *
 * "What does FIFO mean?" and "what is a sensible safety stock for something
 * that sells 60 a month?" used to come back as "which product do you mean?"
 * — the planner could only think in lookups. They are answered here by the
 * model as general knowledge, with no tool calls, no record values in the
 * prompt, and a label on the page saying exactly that: general knowledge,
 * not read from your records. If the question does turn out to need the
 * records, the model says so and the planner is asked instead.
 */

const { createProviderForTier } = require('../ai/provider');
const { validate } = require('../foundry/validator');

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answer', 'needsRecords'],
  properties: {
    answer: { type: 'string', maxLength: 2500 },
    // true when a good answer would need this business's own figures.
    needsRecords: { type: 'boolean' },
  },
};

const SYSTEM = `You answer a general question for the owner of a small stock-holding business, in plain words: two to six short sentences, no headings, no bullet points, no marketing.
You have NO access to their records — stock, orders, suppliers, customers, money — and must never pretend to. Do not invent figures about their business. General examples and rules of thumb are fine, said as such.
If the question can only be answered well with their own figures, set needsRecords to true and, in answer, say in one sentence what would be needed and how to ask for it (for example, "ask 'how many gloves do we have' to get the figure").`;

const GENERAL = /\b(?:what\s+(?:does|do)\s+\w+\s+(?:mean|stand\s+for)|what(?:'s|\s+is)\s+(?:a|an|the\s+difference|the\s+point\s+of|meant\s+by)\b|define\b|explain\s+(?!how\s+(?:do|to)\b)|difference\s+between|rule\s+of\s+thumb|sensible|typical|reasonable|normal(?:ly)?|usual(?:ly)?|formula|best\s+practice|good\s+practice|should\s+(?:i|we)\s+(?:be|use|keep|hold)|how\s+(?:do|does)\s+(?:most|other|small)\s+(?:businesses|shops|companies|people)|in\s+general|generally|pros\s+and\s+cons|advantages?|disadvantages?|why\s+(?:do|does|would|is)\s+(?:a|an|the|it|people|businesses)\b|what\s+(?:is|are)\s+(?:fifo|lifo|fefo|safety\s+stock|lead\s+time|reorder\s+point|eoq|cogs|gross\s+margin|net\s+profit|weighted\s+average|landed\s+cost|drop\s*shipping|consignment|a\s+bill\s+of\s+materials|a\s+sku|a\s+lot|a\s+batch)\b)/i;

/** Whether the words alone say this is general knowledge, not a lookup or an instruction. */
function looksGeneral(db, workspaceId, question) {
  const text = String(question || '').trim();
  if (!text || !GENERAL.test(text)) return false;
  try {
    const navigation = require('../product-brain/navigation');
    if (navigation.mentionsProduct(db, workspaceId, text)) return false;
  } catch { /* no catalogue */ }
  // A named place, order or party makes it about the records.
  if (/\b(?:PO|SO|SHP|RMA|BILL|INV)-\d+\b/i.test(text)) return false;
  if (/\b(?:my|our)\s+(?:stock|inventory|orders?|suppliers?|customers?|sales|bills?|invoices?|warehouse|store|van|products?)\b/i.test(text) && !/\b(?:in\s+general|generally|sensible|typical|rule\s+of\s+thumb)\b/i.test(text)) return false;
  return true;
}

/**
 * @returns {{answer:string, needsRecords:boolean}}
 */
async function answer(question, options = {}) {
  const provider = options.provider || createProviderForTier('fast');
  const response = await provider.complete({ system: SYSTEM, prompt: `Question: ${String(question).trim()}`, schema: SCHEMA, schemaName: 'assistant_general_knowledge', maxTokens: 900 });
  const checked = validate(SCHEMA, response.data, { key: 'assistant-general-knowledge' });
  if (!checked.ok) return { answer: '', needsRecords: true };
  return { answer: String(checked.data.answer || '').trim(), needsRecords: Boolean(checked.data.needsRecords) };
}

/** The shape the Ask page expects, labelled. */
function asResult(question, text) {
  return {
    question, answer: text, general: true, rows: [], columns: [], rowCount: 0, supported: true, isAction: false, needsClarification: false, handoff: null,
    plan: { intent: 'general_knowledge', entityQuery: '', locationQuery: '' }, interpretation: 'general knowledge, not read from your records', spoken: null, answerMode: 'general',
  };
}

module.exports = { looksGeneral, answer, asResult, SCHEMA, SYSTEM, GENERAL };

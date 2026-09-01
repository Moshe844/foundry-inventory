'use strict';

/**
 * The sentence an accountant would say, from numbers Foundry already proved.
 *
 * Answers were assembled from templates, so they read like column headings:
 * "Fulfilled units: 8. 0 open sales orders; 0 units committed and 0 waiting for
 * stock." Correct, and not how anyone speaks. The figures are the part that
 * must never be invented; the wording around them is not.
 *
 * So the split is strict, and it is the same one the attention brief already
 * uses: the numbers come from the deterministic answer, and a model may only
 * arrange words around them. Every number in what it returns must already
 * appear in the verified answer — otherwise the sentence is thrown away and the
 * deterministic one is used, which is also what happens with no provider, a
 * failed call, or a slow one. A phrasing layer that can change a figure is not
 * a phrasing layer.
 *
 * The evidence always follows, unchanged. This adds a sentence; it never
 * replaces the statement of record.
 */

const config = require('../config');
const interpretation = require('./interpretation-service');
const { createProviderForTier } = require('../ai/provider');

const SYSTEM = `You are an experienced accountant talking to the owner of a small business.

You are given a question, and the verified answer to it as figures and rows.
Write one or two short sentences that answer the question the way a person
would say it out loud.

Rules that are not style preferences:
- Use only numbers that appear in the material you are given. Never calculate a
  new one, never round, never estimate, never combine two figures into a third.
- If the answer to the question is a single number, lead with it.
- Do not add advice, caveats, or encouragement. The detail that follows your
  sentence already carries those.
- Do not mention Foundry, yourself, or that you are answering a question.
- Plain words. No accounting jargon unless the question used it.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sentence'],
  properties: { sentence: { type: 'string', maxLength: 320 } },
};

/** Every number the phrasing is allowed to use: the ones already answered. */
function permittedFrom(result) {
  const permitted = new Set();
  const collect = (value) => {
    for (const raw of String(value === null || value === undefined ? '' : value)
      .match(/-?\d[\d,]*\.?\d*/g) || []) permitted.add(raw.replace(/,/g, ''));
  };
  collect(result.answer);
  for (const row of result.rows || []) for (const value of Object.values(row)) collect(value);
  return permitted;
}

function promptFor(question, result) {
  const rows = (result.rows || []).slice(0, 12)
    .map((row) => (result.columns || Object.keys(row))
      .filter((column) => column !== 'href')
      .map((column) => `${column}: ${row[column]}`).join(', '))
    .join('\n');
  return [
    `Question: ${question}`,
    '',
    `Verified answer: ${result.answer}`,
    rows ? `\nThe figures behind it:\n${rows}` : '',
  ].join('\n');
}

/**
 * @returns {Promise<string|null>} a sentence, or null to keep the deterministic answer.
 */
async function phrase(question, result, options = {}) {
  if (!question || !result || !result.answer) return null;
  if (options.deterministicOnly) return null;
  if (!options.provider && !config.ai.configured) return null;

  const provider = options.provider || createProviderForTier('fast');
  let response;
  try {
    response = await provider.complete({
      system: SYSTEM,
      prompt: promptFor(question, result),
      schema: SCHEMA,
      schemaName: 'answer_phrasing',
    });
  } catch {
    return null;
  }

  const sentence = response && response.data && typeof response.data.sentence === 'string'
    ? response.data.sentence.trim()
    : '';
  if (!sentence) return null;

  // The whole guarantee: a number it was not given is a number it made up.
  if (!interpretation.numbersAreGrounded(sentence, permittedFrom(result))) return null;
  if (interpretation.FORBIDDEN.some((pattern) => pattern.test(sentence))) return null;
  return sentence;
}

module.exports = { phrase, permittedFrom, SYSTEM };

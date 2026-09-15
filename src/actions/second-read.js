'use strict';

/**
 * Asking again, more simply, when the first read came back with nothing.
 *
 * Reading an instruction is a hard question: pick one of thirteen operations,
 * and fill in a product, a variant, a location, a quantity, a lot code, a
 * supplier. A reader that is unsure of any part of that can return no usable
 * line at all, and what the person then saw was "Could you say a little more
 * about what you want Foundry to do?" — a shrug, after a sentence that was
 * perfectly clear.
 *
 * Twenty ways of asking to delete an inventory were tried against the full
 * read. Seventeen landed. The three that did not were not badly phrased; the
 * reader simply had a lot to decide at once and came back empty, and it was a
 * different three each run.
 *
 * So this asks a much easier question instead: of these operations, which one
 * is this sentence about, or none of them? No fields, no records, no
 * extraction — one choice. A reader that could not fill in a whole instruction
 * can still answer that, which is why this recovers the shrug rather than
 * papering over it with a list of phrasings somebody thought of in advance.
 *
 * It never carries anything out. It only decides what was being asked, and
 * everything after it is the same code that handles a first-time read.
 */

const { createProviderForTier } = require('../ai/provider');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['operation', 'confidence', 'because'],
  properties: {
    operation: { type: 'string' },
    confidence: { type: 'string', enum: ['certain', 'likely', 'unsure'] },
    because: { type: 'string' },
  },
};

const SYSTEM = `You are told one sentence a person typed into an inventory system, and a list of
the things that system can do. Say which single one the sentence is asking for.

Answer with the operation name exactly as listed, or "none" when the sentence is not asking for
any of them. Do not extract products, quantities, locations or any other detail — the only
question is which operation was meant.

Set confidence to certain when the sentence plainly asks for that operation, likely when it is
the best reading of a sentence that could be read another way, and unsure when you are guessing.
because is one short line quoting what in the sentence made you choose it.`;

/**
 * What was this asking for?
 *
 * Returns null when the answer is "none", when the reader is unsure, or when
 * anything goes wrong. A guess about what somebody meant is worse than the
 * honest question they were going to be asked anyway.
 */
async function whichOperation(text, operations, options = {}) {
  try {
    const provider = options.provider || createProviderForTier('fast');
    const response = await provider.complete({
      system: SYSTEM,
      prompt: `The system can do:\n${operations.map((name) => `- ${name}`).join('\n')}\n- none\n\n`
        + `The person typed:\n${text}`,
      schema: SCHEMA,
      schemaName: 'which_operation',
      signal: options.signal,
    });
    const result = validate(toWireSchema(SCHEMA), response.data, { key: 'which-operation-wire' });
    if (!result.ok) return null;

    const { operation, confidence, because } = result.data;
    if (!operations.includes(operation)) return null;
    if (confidence === 'unsure') return null;
    return { operation, confidence, because };
  } catch {
    /*
     * No second opinion available. The person gets the ordinary question,
     * which is exactly where they would have been without this.
     */
    return null;
  }
}

module.exports = { SCHEMA, SYSTEM, whichOperation };

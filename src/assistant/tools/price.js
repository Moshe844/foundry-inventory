'use strict';

/** Write: a selling-price instruction read into price-change proposals for review. */
const { define } = require('./index');
const priceChanges = require('../../pricing/price-changes');
const permissions = require('../../actions/permissions');

define({
  id: 'price.change', kind: 'write', permission: permissions.ADMIN, verb: 'change selling prices',
  description: 'Reads a selling-price instruction — one product, a list, every product, or a percentage over a group — into price-change proposals. Nothing changes until they are approved.',
  input: {
    type: 'object', additionalProperties: false, required: ['instruction'],
    properties: { instruction: { type: 'string', minLength: 1, maxLength: 12000 } },
  },
  async handler(db, ctx, membership, input, options = {}) {
    const text = input.instruction;
    if (priceChanges.matchesPercentInstruction(text)) {
      const batch = priceChanges.interpretPercent(db, ctx, text);
      return { kind: 'batch', proposals: batch.proposals, unpriced: batch.unpriced, pct: batch.pct, direction: batch.direction };
    }
    if (!priceChanges.matchesInstruction(text)) return { kind: 'not_a_price_change' };
    if (priceChanges.matchesEveryProductInstruction(text)) return { kind: 'batch', proposals: priceChanges.interpretEvery(db, ctx, text) };
    if (priceChanges.matchesBulkInstruction(text)) return { kind: 'batch', proposals: await priceChanges.interpretMany(db, ctx, text, options) };
    return { kind: 'proposal', proposal: await priceChanges.interpret(db, ctx, text, options) };
  },
});

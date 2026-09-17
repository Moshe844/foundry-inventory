'use strict';

/** Write: an instruction read into a proposal (or a plan, a question, a refusal). Nothing runs here; approval is on the actions page. */
const { define } = require('./index');
const actionService = require('../../actions/action-service');
const permissions = require('../../actions/permissions');

define({
  id: 'action.prepare', kind: 'write', permission: permissions.OPERATE, verb: 'prepare a change to your stock or catalogue',
  description: 'Reads an instruction (a move, a count, a new product, an order from a supplier) into a reviewable proposal, plan or draft order, a question, or a refusal. Never carries anything out.',
  input: {
    type: 'object', additionalProperties: false, required: ['instruction'],
    properties: {
      instruction: { type: 'string', minLength: 1, maxLength: 12000 },
      previewOnly: { type: 'boolean' },
    },
  },
  handler(db, ctx, membership, input, options = {}) {
    return actionService.interpret(db, ctx, membership, input.instruction, { ...options, previewOnly: Boolean(input.previewOnly || options.previewOnly) });
  },
});

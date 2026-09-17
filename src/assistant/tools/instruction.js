'use strict';

/** Write: a standing rule ("reorder gloves below 20") read into an operating instruction awaiting approval. */
const { define } = require('./index');
const operating = require('../../manager/operating-instructions');
const permissions = require('../../actions/permissions');

define({
  id: 'instruction.remember', kind: 'write', permission: permissions.OPERATE, verb: 'set a standing rule',
  description: 'Reads a lasting instruction about how the inventory should be run into a reviewable operating instruction. Not in force until approved.',
  input: {
    type: 'object', additionalProperties: false, required: ['instruction'],
    properties: { instruction: { type: 'string', minLength: 1, maxLength: 2000 } },
  },
  handler(db, ctx, membership, input, options = {}) {
    return operating.interpret(db, ctx, membership, input.instruction, options);
  },
});

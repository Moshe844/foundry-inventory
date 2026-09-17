'use strict';

/** Read: a question in the person's words, planned (with a model when needed) and answered from records. */
const { define } = require('./index');
const queryPlanner = require('../../attention/query-planner');
const permissions = require('../../actions/permissions');

define({
  id: 'question.ask', kind: 'read', permission: permissions.VIEW, verb: 'answer that question',
  description: 'Answers a question about the business in plain words: plans the lookups (in code where the shape is known, otherwise with a model), runs them, and returns the answer with the records behind it. Never writes.',
  input: {
    type: 'object', additionalProperties: false, required: ['question'],
    properties: { question: { type: 'string', minLength: 1, maxLength: 4000 } },
  },
  handler(db, ctx, membership, input, options = {}) {
    return queryPlanner.ask(db, ctx.workspaceId, input.question, { ...options, membership: membership || options.membership || null, actorId: ctx.actorId });
  },
});

'use strict';

/** Read: one of the specialised lookups (stock level, on order, forecast, profit and loss, …). */
const { define } = require('./index');
const queryService = require('../../attention/query-service');
const permissions = require('../../actions/permissions');

define({
  id: 'lookup.run', kind: 'read', permission: permissions.VIEW, verb: 'look that up',
  description: 'Runs one specialised lookup by intent, scoped to a product and/or place and a window of days. Never writes.',
  input: {
    type: 'object', additionalProperties: false, required: ['intent'],
    properties: {
      intent: { type: 'string', enum: queryService.INTENTS },
      entityQuery: { type: 'string', maxLength: 200 },
      locationQuery: { type: 'string', maxLength: 200 },
      windowDays: { type: 'integer', minimum: 1, maximum: 3650 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      question: { type: 'string', maxLength: 2000 },
    },
  },
  handler(db, ctx, membership, input) {
    return queryService.execute(db, ctx.workspaceId, queryService.normalisePlan(input), { question: input.question || '', membership: membership || null });
  },
});

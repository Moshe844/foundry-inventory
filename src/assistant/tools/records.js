'use strict';

/** Read: one lookup against a registered dataset, with the record registry's own allow-list. */
const { define } = require('./index');
const records = require('../../attention/record-query');
const permissions = require('../../actions/permissions');

const string = { type: 'string', maxLength: 2000 };
const INPUT = {
  type: 'object', additionalProperties: false,
  required: ['dataset'],
  properties: {
    dataset: { type: 'string', enum: Object.keys(records.REGISTRY) },
    entityScope: { type: 'string', enum: ['single', 'set'] },
    fields: { type: 'array', maxItems: 12, items: string },
    filters: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['field', 'operator'],
      properties: { field: string, operator: { type: 'string', enum: records.OPERATORS }, value: { type: ['string', 'number', 'null'] } } } },
    filterMode: { type: 'string', enum: ['all', 'any'] },
    aggregate: { type: 'string', enum: ['', ...records.AGGREGATES] },
    measure: string,
    metrics: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['operation', 'field'],
      properties: { operation: { type: 'string', enum: records.AGGREGATES }, field: string } } },
    groupBy: { type: 'array', maxItems: 3, items: string },
    sortField: string,
    sortDirection: { type: 'string', enum: ['asc', 'desc'] },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
};

define({
  id: 'records.query', kind: 'read', permission: permissions.VIEW, verb: 'read your records',
  description: 'Reads one registered dataset (products, positions, order lines, bills, payments, …) with filters, measures and grouping. Never writes.',
  input: INPUT,
  handler(db, ctx, membership, input, options = {}) {
    const plan = { entityScope: 'set', fields: [], filters: [], filterMode: 'all', aggregate: '', measure: '', metrics: [], groupBy: [], sortField: '', sortDirection: 'asc', limit: 25, ...input };
    return records.execute(db, ctx.workspaceId, plan, { membership: membership || null, question: options.question || '' });
  },
});

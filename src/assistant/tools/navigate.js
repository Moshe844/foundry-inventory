'use strict';

/** Navigate: where in StockChief a sentence points, from the product brain. */
const { define } = require('./index');
const navigation = require('../../product-brain/navigation');
const permissions = require('../../actions/permissions');

define({
  id: 'navigate.resolve', kind: 'navigate', permission: permissions.VIEW, verb: 'find the page for that',
  description: 'Resolves "take me to purchasing", "open PO-1013", "everything about copper elbow" to a page the person may open, or says why not. Never opens it.',
  input: {
    type: 'object', additionalProperties: false, required: ['text'],
    properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } },
  },
  handler(db, ctx, membership, input, options = {}) {
    return navigation.resolveNatural(db, ctx.workspaceId, membership || null, input.text, { ...options, actorId: ctx.actorId });
  },
});

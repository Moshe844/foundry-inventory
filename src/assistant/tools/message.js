'use strict';

/** Draft: a message to a customer or supplier, prepared and never sent from here. */
const { define } = require('./index');
const outbound = require('../../actions/outbound-message');
const permissions = require('../../actions/permissions');

define({
  id: 'message.draft', kind: 'draft', permission: permissions.OPERATE, verb: 'draft a message',
  description: 'Prepares a message to a named customer or supplier as a draft. Sending is a separate, explicit step on the message page.',
  input: {
    type: 'object', additionalProperties: false, required: ['recipientText', 'body'],
    properties: {
      recipientText: { type: 'string', maxLength: 200 },
      body: { type: 'string', maxLength: 8000 },
      instruction: { type: 'string', maxLength: 4000 },
    },
  },
  handler(db, ctx, membership, input) {
    return outbound.prepare(db, ctx, { recipientText: input.recipientText, body: input.body, instruction: input.instruction || '' });
  },
});

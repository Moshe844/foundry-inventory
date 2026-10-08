'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const control = require('../../src/assistant/postgres-control-plane');
const registry = require('../../src/assistant/postgres-capability-registry').registry;

test('return guidance includes governed return lifecycle rather than generic receipt', () => {
  const actions = control.relevantActions(registry,
    'The customer wants to return one of the picked-up washers. Which location should quarantine it, '+
    'and what steps are possible before a refund?');
  const names = actions.map((action) => action.name);
  assert.ok(names.includes('customer_return.request'));
  assert.ok(names.includes('customer_return.authorize'));
  assert.ok(names.includes('customer_return.receive'));
  assert.ok(names.includes('customer_return.inspect'));
  assert.ok(names.includes('customer_return.refund'));
  assert.ok(!names.includes('inventory.receive'));
});

test('read synthesis shows applicable registered actions without executing one', async () => {
  let prompt;
  const provider = { async complete(input) {
    prompt = JSON.parse(input.prompt);
    return { data: { answer: 'Request the return, authorize it, receive into quarantine, then inspect before deciding a refund.',
      supported: true, usedSteps: [0], additionalReads: [] } };
  } };
  const executed = [{ step: { contract: registry.get('read.locations') }, args: {},
    result: { status: 'ANSWERED', answer: 'One location matched.',
      rows: [{ name: 'Quarantine' }], columns: ['name'] } }];
  const result = await control.synthesizeReads(provider,
    'How can we handle a customer return and refund safely?', executed, { catalogue: registry });
  assert.equal(result[0].result.status, 'ANSWERED');
  assert.ok(prompt.availableActions.some((action) => action.action === 'customer return refund'));
  assert.ok(prompt.availableActions.every((action) => !Object.hasOwn(action, 'name')));
  assert.equal(prompt.completedActions.length, 0);
});

test('explicit read-only intent removes every write from planning while preserving discovery', () => {
  assert.equal(control.explicitlyReadOnly('Explain the return process. No change yet.'), true);
  assert.equal(control.explicitlyReadOnly('Do not change anything; which step comes next?'), true);
  assert.equal(control.explicitlyReadOnly('Create the return and do not change the shipping address.'), false);
  const scoped = control.readOnlyCatalogue(registry);
  assert.equal(scoped.get('customer_return.request'), null);
  assert.ok(scoped.get('read.capabilities'));
  assert.ok(scoped.get('read.locations'));
});

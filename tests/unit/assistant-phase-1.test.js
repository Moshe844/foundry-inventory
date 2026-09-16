'use strict';

/**
 * Truthful states everywhere.
 *
 * A change that ran but whose re-read disagreed with the plan is not "done";
 * a model that failed says one of four plain things; a search that found
 * nothing is a search result; a follow-up that leans on a record the earlier
 * turn never found says so.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const engine = require('../../src/domain/inventory-engine');
const authService = require('../../src/domain/auth-service');
const proposals = require('../../src/actions/proposal-service');
const execution = require('../../src/actions/execution-service');
const verification = require('../../src/actions/verification');
const inbox = require('../../src/manager/needs-you-inbox');
const records = require('../../src/attention/record-query');
const semantic = require('../../src/attention/semantic-query');
const anthropic = require('../../src/ai/providers/anthropic');
const { makeDatabase, seedWorkspace, makeQuantityItem, makeVariantItem, cleanupAll, signIn, plain } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeVariantItem(db, workspace.ctx);
  const navy4 = item.byLabel('Navy / 4');
  engine.receive(db, workspace.ctx, { skuId: navy4.id, locationId: workspace.main.id, quantity: 48 });
  return { db, workspace, membership, ctx: workspace.ctx, navy4 };
}

function receiveProposal(env, quantity = 10) {
  const built = proposals.build(env.db, env.ctx, {
    actionType: 'receive', item: "Children's Sweater", variant: 'Navy 4', lotCode: '', serials: [],
    sourceLocation: '', destinationLocation: 'Downtown Store', quantity, adjustmentTarget: null, reasonCode: '',
  });
  assert.ok(built.ok, built.question || built.unsupported);
  return proposals.persist(env.db, env.ctx, built.proposal, { instruction: 'test' });
}

/** Runs a body with verification forced to disagree, then restores it. */
function withFailedVerification(body) {
  const real = verification.verify;
  verification.verify = () => ({ verified: false, checks: [], problems: ['Stock at destination: expected 10, found 4'] });
  try { return body(); } finally { verification.verify = real; }
}

test('an execution whose re-read disagrees is recorded, alerted and listed in Needs you — never as plain success', async () => {
  const env = setup();
  const proposal = receiveProposal(env);
  execution.approve(env.db, env.ctx, env.membership, proposal.proposalId);
  const result = withFailedVerification(() => execution.execute(env.db, env.ctx, env.membership, proposal.proposalId));
  assert.equal(result.verified, false);

  const events = env.db.prepare('SELECT event FROM action_events WHERE proposal_id = ? ORDER BY rowid').all(proposal.proposalId).map((r) => r.event);
  assert.ok(events.includes('SUCCEEDED_UNVERIFIED'), events.join(','));

  const alert = env.db.prepare("SELECT * FROM operational_alerts WHERE kind = 'action.unverified'").get();
  assert.ok(alert, 'whoever runs the server is told');
  assert.match(alert.detail, /expected 10, found 4/);

  const entry = inbox.inbox(env.db, env.workspace.workspaceId, env.membership).find((e) => e.id === `unverified:${result.executionId}`);
  assert.ok(entry, 'the person whose stock it is is told');
  assert.match(entry.title, /does not match what was expected/);
  assert.match(entry.happened, /expected 10, found 4/);
  assert.equal(entry.href, `/actions/${proposal.proposalId}`);

  const app = createApp({ db: env.db, env: 'test', sessionSecret: 'phase-1' });
  const agent = request.agent(app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const list = plain((await agent.get('/actions')).text);
  assert.match(list, /ran, not verified/);
  assert.doesNotMatch(list, /\bsucceeded\b/);
  const detail = plain((await agent.get(`/actions/${proposal.proposalId}`)).text);
  assert.match(detail, /Done, but the result does not match what was expected/);
  assert.match(detail, /expected 10, found 4/);
});

test('a plan records each line by what its own check found', () => {
  const env = setup();
  const proposal = receiveProposal(env, 3);
  execution.approve(env.db, env.ctx, env.membership, proposal.proposalId);
  const result = execution.execute(env.db, env.ctx, env.membership, proposal.proposalId);
  assert.equal(result.verified, true);
  const events = env.db.prepare('SELECT event FROM action_events WHERE proposal_id = ? ORDER BY rowid').all(proposal.proposalId).map((r) => r.event);
  assert.ok(events.includes('SUCCEEDED'));
  assert.ok(!events.includes('SUCCEEDED_UNVERIFIED'));
  assert.equal(env.db.prepare("SELECT COUNT(*) n FROM operational_alerts WHERE kind = 'action.unverified'").get().n, 0);
});

test('the model provider fails in one of four plain sentences, never in its own vocabulary', () => {
  const said = anthropic.SAID;
  for (const status of [429, 500, 529]) {
    const err = anthropic.translateError(Object.assign(new Error('Overloaded'), { status }));
    assert.equal(err.message, said.busy, String(status));
  }
  const timedOut = anthropic.translateError(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }));
  assert.equal(timedOut.message, said.tooLong);
  assert.equal(timedOut.code, 'ai_timeout');
  for (const sentence of Object.values(said)) {
    assert.match(sentence, /Nothing changed/);
    assert.doesNotMatch(sentence, /model|token|JSON|provider|schema/i);
  }
});

test('a refused lookup says why: unknown field, impossible comparison, wrong kind of value, or no match', () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  makeQuantityItem(db, w.ctx, { name: 'Copper Elbow', baseCode: 'CE' });
  const base = { dataset: 'products', entityScope: 'set', fields: [], filterMode: 'all', aggregate: '', measure: '', metrics: [], groupBy: [], sortField: '', sortDirection: 'asc', limit: 25 };
  const attempt = (filters) => { try { return records.execute(db, w.workspaceId, { ...base, filters }, {}).answer; } catch (err) { return err.message; } };
  assert.match(attempt([{ field: 'colour', operator: 'eq', value: 'red' }]), /a detail called “colour” and products records do not have one. What I can read about them: /);
  assert.match(attempt([{ field: 'product', operator: 'regex', value: 'x' }]), /compare product using “regex”, which is not a comparison I can make/);
  assert.match(attempt([{ field: 'on_hand', operator: 'gt', value: 'lots' }]), /on hand is a number, and “lots” is not one/);
  assert.match(attempt([{ field: 'product', operator: 'contains', value: 'John Smith' }]), /No products on record with product containing “John Smith”. That is a search result, not a failure/);
});

test('a follow-up that leans on a record the earlier turn never found is told so', async () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const plan = (filters, dataset) => ({ decision: 'answer', interpretation: 'x', clarification: '', continuesPrevious: true, unsupportedReason: '', nearest: '', parts: [{
    question: 'q', intent: 'record_query', entityQuery: '', locationQuery: '', windowDays: 30, limit: 10, unsupportedReason: '', recordQuery: {
      dataset, entityScope: 'set', fields: [], filters, filterMode: 'all', aggregate: '', measure: '', metrics: [], groupBy: [], sortField: '', sortDirection: 'asc', limit: 25 } }] });
  const previous = { workspaceId: w.workspaceId, question: 'Find customer John Smith.', rowCount: 0, clarification: null,
    semanticPlan: plan([{ field: 'customer', operator: 'contains', value: 'John Smith' }], 'customers') };
  const provider = { async complete() { return { data: plan([{ field: 'customer', operator: 'contains', value: 'John Smith' }], 'sales_orders') }; } };
  const result = await semantic.ask(db, w.workspaceId, "Show me this customer's recent orders.", { provider, conversation: previous, intentSystem: '', legacySchema: { type: 'object' } });
  assert.equal(result.needsClarification, true);
  assert.match(result.answer, /Your earlier question found no customer matching “John Smith”, so there is no “this customer” to look at yet/);
});

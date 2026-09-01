'use strict';

/**
 * The line between the figures and the words around them.
 *
 * Answers were assembled from templates and read like column headings —
 * "Fulfilled units: 8. 0 open sales orders; 0 units committed" — correct, and
 * not how anyone speaks. A model may now arrange the sentence, and may not
 * touch a number: every figure in what it returns must already appear in the
 * verified answer, or the sentence is discarded.
 *
 * That is the whole guarantee, so it is tested against a model that behaves and
 * several that do not. No network: each provider here is a stub.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const phrasing = require('../../src/attention/answer-phrasing');

const RESULT = {
  answer: 'Fulfilled units: 8. 1 open sales order; 34 units committed and 16 waiting for stock.',
  rows: [
    { measure: 'Ordered units', value: 50 },
    { measure: 'Committed units', value: 34 },
    { measure: 'Fulfilled units', value: 8 },
  ],
  columns: ['measure', 'value'],
};

const saying = (sentence) => ({ complete: async () => ({ data: { sentence } }) });

test('a sentence built from the verified figures is used', async () => {
  const spoken = await phrasing.phrase('how many have shipped?', RESULT,
    { provider: saying('You have shipped 8 units, with 34 more committed.') });
  assert.equal(spoken, 'You have shipped 8 units, with 34 more committed.');
});

test('a number that was never given is refused', async () => {
  // 12 appears nowhere in the answer or its rows. Neither does a total someone
  // arrived at by adding two figures that were given.
  for (const invented of [
    'About 12 units have shipped.',
    'You have shipped 8 units, so 42 remain outstanding.',
  ]) {
    assert.equal(await phrasing.phrase('how many have shipped?', RESULT, { provider: saying(invented) }), null,
      `refused: ${invented}`);
  }
});

test('every figure it was given may be used, including from the rows', async () => {
  // 50 is in the rows but not in the answer sentence. It is still a fact.
  const spoken = await phrasing.phrase('how many have shipped?', RESULT,
    { provider: saying('8 of the 50 units ordered have shipped.') });
  assert.equal(spoken, '8 of the 50 units ordered have shipped.');
});

test('language a bookkeeper would not use is refused', async () => {
  assert.equal(await phrasing.phrase('how many have shipped?', RESULT,
    { provider: saying('8 shipped. Someone is stealing your stock.') }), null);
  assert.equal(await phrasing.phrase('how many have shipped?', RESULT,
    { provider: saying('I have transferred 8 units for you.') }), null);
});

test('a failed or empty call leaves the computed answer alone', async () => {
  const broken = { complete: async () => { throw new Error('provider down'); } };
  assert.equal(await phrasing.phrase('how many have shipped?', RESULT, { provider: broken }), null);

  const empty = { complete: async () => ({ data: { sentence: '   ' } }) };
  assert.equal(await phrasing.phrase('how many have shipped?', RESULT, { provider: empty }), null);

  assert.equal(await phrasing.phrase('how many have shipped?', RESULT,
    { deterministicOnly: true }), null, 'and it can be turned off outright');
});

test('the figures a phrasing may use are exactly those already answered', () => {
  const permitted = phrasing.permittedFrom(RESULT);
  for (const given of ['8', '1', '34', '16', '50']) {
    assert.ok(permitted.has(given), `${given} was given`);
  }
  assert.ok(!permitted.has('42'), 'a sum of two given figures is not itself given');
  assert.ok(!permitted.has('12'), 'and neither is a number from nowhere');
});

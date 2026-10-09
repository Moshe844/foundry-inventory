'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {analysisUsageKey}=require('../../src/imports/usage-key');

test('one import submission is idempotent without barring later previews of the same source',()=>{
  const source='same-file-sha256';
  const first=analysisUsageKey(source,'form-one');
  assert.equal(first,analysisUsageKey(source,'form-one'));
  assert.notEqual(first,analysisUsageKey(source,'form-two'));
  assert.notEqual(first,analysisUsageKey('different-file-sha256','form-one'));
  assert.notEqual(analysisUsageKey(source),analysisUsageKey(source));
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compare}=require('../../src/accounting/postgres-integration-sync');
test('accounting parity accounts for both books and requires explicit equal currencies',()=>{
  const local={currency:'USD',accounts:[{id:'cash',code:'1000',balanceMinor:100}]};
  const external={currency:'USD',accounts:[{externalId:'bank',balanceMinor:100},{externalId:'other',balanceMinor:70}]};
  const mappings=[{foundry_account_id:'cash',external_id:'bank'}];
  assert.deepEqual(compare(local,external,mappings),[{kind:'UNMAPPED_EXTERNAL_ACCOUNT',externalId:'other',externalMinor:70}]);
  external.accounts[1].balanceMinor=0;assert.deepEqual(compare(local,external,mappings),[]);
  delete external.currency;assert.equal(compare(local,external,mappings)[0].kind,'CURRENCY_MISMATCH');
  external.currency='JPY';assert.equal(compare(local,external,mappings)[0].kind,'CURRENCY_MISMATCH');
  assert(compare({currency:'USD',accounts:[]},{currency:'USD',accounts:[{externalId:'bank',balanceMinor:1}]},[]).length);
});

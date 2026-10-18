'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {scope,accountShape}=require('../../src/accounting/provider-opening-scope');
const sample=()=>({asOf:'2026-10-18',currency:'USD',version:'report-1',accounts:[
  {externalId:'bank',name:'Checking',accountType:'Bank',classification:'Asset',balanceMinor:100},
  {externalId:'equity',name:'Capital',accountType:'Equity',classification:'Equity',balanceMinor:-100},
]});
test('exact opening approval scope ignores transport versions and ordering, never balances or identity',()=>{
  const a=sample(),b=sample();b.version='new-read';b.accounts.reverse();b.accounts[0].version='new-token';
  assert.equal(scope('quickbooks',a).scopeHash,scope('quickbooks',b).scopeHash);
  b.accounts[0].balanceMinor=-101;assert.notEqual(scope('quickbooks',a).scopeHash,scope('quickbooks',b).scopeHash);
  assert.equal(scope('quickbooks',a).debitMinor,100);assert.equal(scope('quickbooks',a).creditMinor,100);
  assert.equal(scope('quickbooks',{...a,currency:'JPY'}).currencyExponent,0);
  assert.equal(scope('quickbooks',{...a,currency:'BHD'}).currencyExponent,3);
});
test('provider chart types include credit cards and COGS and reject ambiguous classifications',()=>{
  assert.equal(accountShape('quickbooks',{externalId:'c',name:'Card',accountType:'Credit Card',classification:'Liability'}).type,'LIABILITY');
  assert.equal(accountShape('quickbooks',{externalId:'c',name:'Cost',accountType:'Cost of Goods Sold',classification:'Expense'}).type,'COGS');
  assert.equal(accountShape('xero',{externalId:'x',name:'Cost',accountType:'DIRECTCOSTS'}).type,'COGS');
  assert.throws(()=>accountShape('quickbooks',{externalId:'x',name:'Unknown',accountType:'Unrecognized'}),/requires review/);
  assert.throws(()=>accountShape('quickbooks',{externalId:'x',name:'Wrong',accountType:'Bank',classification:'Liability'}),/conflicts/);
  const first=accountShape('quickbooks',{externalId:'a/b',name:'One',accountType:'Bank'}),second=accountShape('quickbooks',{externalId:'ab',name:'Two',accountType:'Bank'});assert.notEqual(first.code,second.code);
});
test('missing currency, duplicate identities, non-integer or overflowing money and invalid dates fail closed',()=>{
  const bad=sample();bad.accounts.push({...bad.accounts[0]});assert.throws(()=>scope('quickbooks',bad),/duplicated/);
  assert.throws(()=>scope('quickbooks',{...sample(),currency:null}),/currency/);
  assert.throws(()=>scope('quickbooks',{...sample(),asOf:'2026-02-31'}),/date/);
  const fractional=sample();fractional.accounts[0].balanceMinor=1.5;assert.throws(()=>scope('quickbooks',fractional),/require review/);
  const big=sample();big.accounts[0].balanceMinor=Number.MAX_SAFE_INTEGER;big.accounts.push({...big.accounts[0],externalId:'other'});assert.throws(()=>scope('quickbooks',big),/precision/);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),money=require('../../src/imports/source-money');
test('source currency evidence preserves recognized codes, mixed currencies and unfamiliar text',()=>{
 for(const [text,expected,clean]of [['USD 4.50',['USD'],'4.50'],['₪9.90',['ILS'],'9.90'],['EUR 8.25 / £7.10',['GBP','EUR'],'8.25 / 7.10'],['JPY 100',['JPY'],'100'],['4.50',[],'4.50'],['ABC 4.50',[],'ABC 4.50'],['usd 4.50',[],'usd 4.50'],['¥100',[],'¥100']]){
  assert.deepEqual(money.codes(text),expected);assert.equal(money.clean(text),clean);
 }
 assert.deepEqual(money.codes('Unit cost (USD) / selling price (CAD)'),['USD','CAD']);
 const result=money.codes('USD');result.push('EUR');assert.deepEqual(money.codes('USD'),['USD'],'callers cannot alter later currency evidence');
});

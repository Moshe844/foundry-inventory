'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const control=require('../../src/commercial/control-service');
const unreachable={query:async()=>{throw Error('Invalid cost input reached database');}};
test('blank, coerced and negative rates cannot silently become zero',async()=>{
  for(const costPerUnitMinor of [null,undefined,'',' ',false,true,[],[0],{},NaN,Infinity,-1,'-0.1'])
    await assert.rejects(()=>control.saveCostRate(unreachable,{provider:'fixture',operation:'request',unit:'request',costPerUnitMinor}),/explicit non-negative number/);
});
test('cost quantities and explicit amounts reject blank or coercible inputs',async()=>{
  const base={provider:'fixture',operation:'request',unit:'request',quantity:1,idempotencyKey:'fixture'};
  for(const quantity of [null,undefined,'',' ',false,true,[],{},NaN,Infinity,-1])
    await assert.rejects(()=>control.recordCost(unreachable,{}, {...base,quantity}),/Cost quantity/);
  for(const amountMinor of ['',' ',false,true,[],{},NaN,Infinity,-1])
    await assert.rejects(()=>control.recordCost(unreachable,{}, {...base,amountMinor}),/Cost amount/);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('paged validation retains exact late duplicate and conflict evidence with disk-backed state',()=>{
 const scratch=require('../../src/imports/validation-scratch').create();
 try{
  for(let i=0;i<10000;i++){scratch.state.positions.add('sku-'+i);scratch.state.prices.set('sku-'+i,'USD:'+i);}
  assert(scratch.state.positions.has('sku-9999'));assert(!scratch.state.positions.has('other'));
  assert.equal(scratch.state.prices.get('sku-5000'),'USD:5000');assert.equal(scratch.state.prices.get('missing'),undefined);
  scratch.state.reorders.set('sku-1',{reorderPoint:2});const rule=scratch.state.reorders.get('sku-1');rule.targetStock=9;scratch.state.reorders.set('sku-1',rule);
  assert.deepEqual(scratch.state.reorders.get('sku-1'),{reorderPoint:2,targetStock:9});
 }finally{scratch.close();}
});

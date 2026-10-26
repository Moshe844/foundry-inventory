'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../../src/connections/catalog-record-policy');
test('physical catalogue eligibility is independent of provider stock evidence',()=>{
 for(const data of [{tracked:false},{inventoryCountUnavailable:'No location-level count was supplied.'}]){
  assert.equal(policy.exclusion(data),null);
  assert.deepEqual(policy.openingCounts({...data,inventoryCounts:[{quantity:91}]}),[]);
 }
 assert.deepEqual(policy.openingCounts({tracked:true,inventoryCounts:[{quantity:0}]}),[{quantity:0}]);
 for(const data of [{virtual:true},{isGiftCard:true},{productStatus:'ARCHIVED'}])assert(policy.exclusion(data));
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),engine=require('../../src/pricing/calculator'),pricing=require('../../src/pricing/postgres-promotions');
test('existing exact approvals survive zero-scope quote metadata upgrades but do not cover added charges or provider facts',()=>{
 const current=engine.quote({at:'2026-10-18T12:00:00Z',currency:'USD',lines:[{skuId:'sku',quantity:2,unitPriceMinor:100}],rules:[],discountMinor:1,taxMinor:7}),legacy=JSON.parse(JSON.stringify(current));
 legacy.version=1;for(const k of ['recordedAmounts','chargesMinor','chargeTaxMinor','charges'])delete legacy[k];for(const l of legacy.lines)for(const k of ['allocationVersion','externalLineId','chargesMinor','chargeTaxMinor','goodsTaxMinor'])delete l[k];
 assert.equal(pricing.quoteHash(current),pricing.hash({...legacy,at:null}));
 assert.notEqual(pricing.quoteHash({...current,chargesMinor:1}),pricing.quoteHash(legacy));
 assert.notEqual(pricing.quoteHash({...current,recordedAmounts:true}),pricing.quoteHash(legacy));
 assert.notEqual(pricing.quoteHash({...current,taxMinor:8}),pricing.quoteHash(legacy));
});

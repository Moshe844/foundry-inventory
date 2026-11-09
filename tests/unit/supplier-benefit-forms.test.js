'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),service=require('../../src/purchasing/agent-supplier-benefits');
test('supplier agreement forms retain original currency precision, exact percentages and explicit case-price units',()=>{
 const input={currency:'USD',basis:'net_spend',benefit:'percentage',method:'retroactive',rounding:'half_up',tiersText:'1000.25 | 5.25\n2000.00 | 10'};
 assert.deepEqual(service.formTerms(input).tiers,[{threshold:'100025',rateBasisPoints:525},{threshold:'200000',rateBasisPoints:1000}]);
 assert.equal(service.formTerms({...input,currency:'JPY',tiersText:'1000 | 5'}).tiers[0].threshold,'1000');assert.equal(service.formTerms({...input,currency:'KWD',tiersText:'1000.125 | 5'}).tiers[0].threshold,'1000125');
 const cases=service.formTerms({...input,basis:'stock_units',benefit:'unit_price',pricePerUnits:'12',tiersText:'24 | 95.00'});assert.equal(cases.pricePerUnits,'12');assert.deepEqual(cases.tiers,[{threshold:'24',unitPriceMinor:'9500'}]);
 for(const invalid of [{rounding:''},{method:''},{tiersText:'0 | 5.001'},{tiersText:'0 | 101'},{tiersText:'0 | 5 | 10'},{currency:'JPY',tiersText:'1000.25 | 5'}])assert.throws(()=>service.formTerms({...input,...invalid}));
 assert.throws(()=>service.formTerms({...input,basis:'stock_units',benefit:'unit_price',pricePerUnits:'',tiersText:'24 | 95.00'}));
});
test('large supplier totals display exact currency values without floating point rounding',()=>{
 assert.equal(service.displayMoney('9007199254740993','USD'),'$90,071,992,547,409.93');assert.equal(service.displayMoney('12345','KWD'),'KWD 12.345');assert.equal(service.displayMoney('12345','JPY'),'¥12,345');assert.equal(service.displayMoney('1','USD'),'$0.01');assert.equal(service.displayMoney('-1','USD'),'-$0.01');
});

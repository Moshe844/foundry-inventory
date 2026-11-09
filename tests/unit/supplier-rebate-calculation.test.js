'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{normalize,calculate}=require('../../src/purchasing/supplier-rebate-calculation');
const spend={basis:'net_spend',benefit:'percentage',method:'retroactive',rounding:'half_up',tiers:[{threshold:'0',rateBasisPoints:100},{threshold:'50000',rateBasisPoints:300}]};
test('rebate tiers distinguish retrospective rewards from progressive bands at the exact contract threshold',()=>{
 assert.equal(calculate(spend,{netMinor:'100000'}).potentialBenefitMinor,'3000');
 assert.equal(calculate({...spend,method:'incremental'},{netMinor:'100000'}).potentialBenefitMinor,'2000');
 assert.equal(calculate(spend,{netMinor:'50000'}).potentialBenefitMinor,'1500');
 assert.equal(calculate({...spend,method:'incremental'},{netMinor:'50000'}).potentialBenefitMinor,'500');
 const below=calculate({...spend,tiers:spend.tiers.slice(1)},{netMinor:'49999'});assert.equal(below.potentialBenefitMinor,'0');assert.equal(below.remainingToNext,'1');assert.equal(below.tier,null);
});
test('quantity volume discounts use exact stock units and actual aggregate purchase value without negative claims',()=>{
 const contract={basis:'stock_units',benefit:'unit_price',method:'retroactive',rounding:'half_up',pricePerUnits:'1',tiers:[{threshold:'50',unitPriceMinor:'900'}]};
 assert.equal(calculate(contract,{netMinor:'150000',quantity:'70.5'}).potentialBenefitMinor,'86550');
 assert.equal(calculate(contract,{netMinor:'100',quantity:'70.5'}).potentialBenefitMinor,'0');
 const pending=calculate(contract,{netMinor:'100000',quantity:'49.999999'});assert.equal(pending.tier,null);assert.equal(pending.remainingToNext,'0.000001');
 assert.equal(calculate({...contract,benefit:'percentage',tiers:[{threshold:'50',rateBasisPoints:250}]},{netMinor:'100000',quantity:'50'}).potentialBenefitMinor,'2500');
 const cases={...contract,pricePerUnits:'12',tiers:[{threshold:'24',unitPriceMinor:'9500'}]};assert.equal(calculate(cases,{netMinor:'20000',quantity:'24'}).potentialBenefitMinor,'1000','A $95 case of 12 keeps its exact price rather than rounding a per-piece cost');
});
test('minor-currency arithmetic and agreed rounding stay exact above JavaScript safe integers',()=>{
 const huge={...spend,tiers:[{threshold:'0',rateBasisPoints:100}]};assert.equal(calculate(huge,{netMinor:'9007199254741000'}).potentialBenefitMinor,'90071992547410');
 const half={...spend,tiers:[{threshold:'0',rateBasisPoints:5000}]};assert.equal(calculate(half,{netMinor:'1'}).potentialBenefitMinor,'1');assert.equal(calculate({...half,rounding:'floor'},{netMinor:'1'}).potentialBenefitMinor,'0');
 const unit={basis:'stock_units',benefit:'unit_price',method:'retroactive',rounding:'half_up',pricePerUnits:'1',tiers:[{threshold:'0',unitPriceMinor:'500000'}]};assert.equal(calculate(unit,{netMinor:'2',quantity:'0.000001'}).potentialBenefitMinor,'1');assert.equal(calculate({...unit,rounding:'floor'},{netMinor:'2',quantity:'0.000001'}).potentialBenefitMinor,'2');
 assert.equal(calculate(spend,{netMinor:'0'}).potentialBenefitMinor,'0');
});
test('ambiguous or worsening terms, unsafe numbers and unsupported quantity methods require review',()=>{
 for(const input of [{...spend,method:null},{...spend,rounding:null},{...spend,tiers:[]},{...spend,tiers:[{threshold:'2',rateBasisPoints:100},{threshold:'1',rateBasisPoints:200}]},{...spend,tiers:[{threshold:'0',rateBasisPoints:200},{threshold:'1',rateBasisPoints:100}]},{...spend,tiers:[{threshold:'0',rateBasisPoints:10001}]},{...spend,basis:'stock_units',method:'incremental'},{...spend,benefit:'unit_price'}])assert.throws(()=>normalize(input));
 for(const totals of [{netMinor:'-1'},{netMinor:'1.1'},{netMinor:'1e5'},{netMinor:9007199254741000},{netMinor:'9223372036854775808'},{netMinor:'1',quantity:'0.1234567'},{netMinor:'1',quantity:100000000000.1}])assert.throws(()=>calculate(spend,totals));
});

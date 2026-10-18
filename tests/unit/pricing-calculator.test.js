'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),engine=require('../../src/pricing/calculator');
const at='2026-10-16T12:00:00.000Z',base={at,currency:'USD',customerId:'customer',lines:[{skuId:'a',quantity:3,unitPriceMinor:101,costUnitMinor:50},{skuId:'b',quantity:2,unitPriceMinor:200,costUnitMinor:100}]};
const promotion=(id,discount,rest={})=>({id,kind:'promotion',name:id,currency:'USD',discount,stacking:'stack',...rest});
test('fractional service invoices use the same rounded promotions and fail closed on missing margin evidence',()=>{
 const service={...base,allowFractionalQuantities:true,lines:[{skuId:null,quantity:0.125,unitPriceMinor:1001}]},offer=promotion('service',{type:'percent',value:1000});
 const quoted=engine.quote({...service,rules:[offer]});assert.equal(quoted.subtotalMinor,125);assert.equal(quoted.discountMinor,13);assert.equal(quoted.totalMinor,112);
 const guard={id:'margin',kind:'guard',name:'Business margin',currency:'USD',minimumMarginBps:1000};assert.equal(engine.quote({...service,rules:[guard]}).violations[0].kind,'missing_cost_evidence');
 assert.throws(()=>engine.quote({...service,allowFractionalQuantities:false}),/Quantity/);assert.throws(()=>engine.quote({...service,lines:[{...service.lines[0],quantity:0.0000001}]}),/decimal/);
 assert.equal(engine.quote({...service,rules:[promotion('unit',{type:'fixed_unit',value:101})]}).discountMinor,13);
});
test('customer specificity, shared quantity and explicit negotiated rates have a documented deterministic precedence',()=>{
 const general={id:'first',kind:'price_list',name:'Retail',currency:'USD',entries:[{skuId:'a',minQuantity:1,unitPriceMinor:70}]},specific={...general,id:'second',name:'Contract',scope:{customerIds:['customer']},entries:[{skuId:'a',minQuantity:1,unitPriceMinor:90},{skuId:'a',minQuantity:3,unitPriceMinor:80}]};
 assert.equal(engine.quote({...base,rules:[general,specific]}).lines[0].unitPriceMinor,80,'A negotiated customer rate wins a same-priority general rate, even when it is higher');
 assert.equal(engine.quote({...base,rules:[{...general,priority:10},specific]}).lines[0].unitPriceMinor,70,'An explicit priority outranks specificity');
 const q=engine.quote({...base,lines:[{skuId:'a',quantity:1,unitPriceMinor:101},{skuId:'a',quantity:2,unitPriceMinor:101}],rules:[specific]});assert.deepEqual(q.lines.map(l=>l.unitPriceMinor),[80,80]);assert.equal(engine.quote({...base,lines:[{...base.lines[0],unitPriceMinor:60,priceOverride:true}],rules:[specific]}).lines[0].unitPriceMinor,60);
 assert.throws(()=>engine.validateRule({...general,scope:null}),/scope/);assert.throws(()=>engine.validateRule({...general,silentOverride:true}),/unsupported/);
});
test('tiered customer price lists, explicit selection, schedules and currency eligibility are deterministic',()=>{
 const rule={id:'wholesale',version:4,kind:'price_list',name:'Negotiated rates',currency:'USD',scope:{customerIds:['customer']},entries:[{skuId:'a',minQuantity:1,unitPriceMinor:90},{skuId:'a',minQuantity:3,unitPriceMinor:75}]};
 const q=engine.quote({...base,rules:[rule]});assert.equal(q.lines[0].unitPriceMinor,75);assert.equal(q.lines[0].priceSource.version,4);assert.equal(q.totalMinor,625);
 assert.equal(engine.quote({...base,customerId:'other',rules:[rule]}).totalMinor,703);assert.throws(()=>engine.quote({...base,customerId:'other',priceListId:'wholesale',rules:[rule]}),/not applicable/);
 const timed=promotion('window',{type:'percent',value:1000},{startsAt:at,endsAt:'2026-10-17T12:00:00Z'});assert.equal(engine.quote({...base,rules:[timed]}).discountMinor,70);assert.equal(engine.quote({...base,at:'2026-10-17T12:00:00Z',rules:[timed]}).discountMinor,0);
 assert.equal(engine.quote({...base,rules:[{...timed,currency:'EUR'}]}).discountMinor,0);
});
test('stacking, exclusions, coupon scopes, fixed discounts and exact tax allocation share one total',()=>{
 const rules=[promotion('percent',{type:'percent',value:1000},{priority:20}),promotion('coupon',{type:'fixed_order',value:100},{priority:10,code:'SAVE',scope:{skuIds:['a']}})];
 const q=engine.quote({...base,rules,codes:['save'],taxMinor:17});assert.equal(q.discountMinor,170);assert.equal(q.totalMinor,550);assert.equal(q.lines.reduce((n,l)=>n+l.taxMinor,0),17);
 assert.equal(engine.quote({...base,rules:[{...rules[0],stacking:'exclusive'},rules[1]],codes:['SAVE']}).applied.length,1);
 assert.equal(engine.quote({...base,rules:[{...rules[0],excludes:['coupon']},rules[1]],codes:['SAVE']}).applied.length,1);
 assert.equal(engine.quote({...base,rules:[{...rules[1],maxRedemptions:1,redemptions:1}],codes:['SAVE']}).discountMinor,0);
 assert.equal(engine.quote({...base,rules:[promotion('unit',{type:'fixed_unit',value:5})]}).discountMinor,25);
 assert.equal(engine.quote({...base,rules:[promotion('line',{type:'fixed_line',value:5})]}).discountMinor,10);
});
test('bundle offers require the actual products and never invent qualifying units',()=>{
 const offer=promotion('pair',{type:'bundle',value:250,items:[{skuId:'a',quantity:1},{skuId:'b',quantity:1}]});
 const q=engine.quote({...base,rules:[offer]});assert.equal(q.discountMinor,102);assert.equal(q.totalMinor,601);
 assert.equal(engine.quote({...base,lines:[base.lines[0]],rules:[offer]}).discountMinor,0);
});
test('margin guards and discount caps do not treat missing cost as zero',()=>{
 const guard={id:'guard',name:'Margin protection',kind:'guard',currency:'USD',minimumMarginBps:6000,maximumDiscountBps:1000};
 const q=engine.quote({...base,rules:[guard,promotion('sale',{type:'percent',value:5000})]});assert(q.violations.some(v=>v.kind==='minimum_margin'));assert(q.violations.some(v=>v.kind==='discount_limit'));
 assert(engine.quote({...base,lines:[{...base.lines[0],costUnitMinor:null}],rules:[guard]}).violations.some(v=>v.kind==='missing_cost_evidence'));
});
test('allocation and historical partial quantities conserve pennies over hundreds of uneven cases',()=>{
 for(let n=1;n<=400;n++){const weights=[n%7,n%11,n%13],total=n*17;if(weights.every(v=>v===0))continue;const allocated=engine.allocate(total,weights);assert.equal(allocated.reduce((a,b)=>a+b,0),total);assert.deepEqual(engine.allocate(total,weights),allocated);
  const quantity=n%17+1,unitPortions=Array.from({length:quantity},(_,i)=>engine.portion(total,quantity,i,1));assert.equal(unitPortions.reduce((a,b)=>a+b,0),total);}
});
test('invalid prices, unsupported precision, excessive discount and arithmetic overflow fail closed',()=>{
 assert.throws(()=>engine.quote({...base,discountMinor:704}),/exceeds/);assert.throws(()=>engine.quote({...base,lines:[{skuId:'a',quantity:2,unitPriceMinor:Number.MAX_SAFE_INTEGER}]}),/range/);
 assert.throws(()=>engine.validateRule({kind:'guard',name:'Guard',currency:'JPY'}),/precision|supported/);assert.throws(()=>engine.quote({...base,rules:[promotion('bad',{type:'percent',value:10001})]}),/range/);
 assert.throws(()=>engine.portion(100,2,1,2),/exceeds/);
});

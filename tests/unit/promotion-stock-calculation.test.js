'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),calc=require('../../src/purchasing/promotion-stock-calculation');
const raw={supplierId:'s',locationId:'l',reference:'Summer',skuIds:['sku'],orderByDate:'2026-01-01',arrivalDate:'2026-01-02',startsOn:'2026-01-03',endsOn:'2026-01-10',upliftPercent:'100'};
const row={skuId:'sku',issued:'90',issueEvents:2,onHand:'3',committed:'5',incoming:'2',unitsPerPurchaseUnit:'6',orderMultiple:'2',minimumOrderQuantity:'3',unitCostMinor:'125'};
test('promotion estimates apply explicit uplift only on promotion days and preserve supplier packs, minimums and exact money',()=>{
 const p=calc.calculate(calc.input(raw),'2026-01-01',[row]);assert.equal(p.coverageDays,10);assert.equal(p.promotionDays,8);assert.equal(p.rows[0].expectedUnits,18);assert.equal(p.rows[0].quantityUnits,24);assert.equal(p.rows[0].purchaseUnits,4);assert.equal(p.totalMinor,3000);
 const uncovered=calc.calculate(calc.input({...raw,upliftPercent:'0'}),'2026-01-01',[{...row,onHand:'0',incoming:'0',committed:'5'}]);assert.equal(uncovered.rows[0].neededUnits,15);assert.equal(uncovered.rows[0].uncoveredCommittedUnits,5);
 const free=calc.calculate(calc.input(raw),'2026-01-01',[{...row,unitCostMinor:'0'}]);assert.equal(free.rows[0].quantityUnits,24);assert.equal(free.totalMinor,0);
});
test('promotion inputs refuse invented demand, absent assumptions, invalid dates and inexact quantities',()=>{
 for(const change of [{upliftPercent:''},{upliftPercent:'1001'},{upliftPercent:'1.5'},{arrivalDate:'2026-01-04'},{startsOn:'2026-02-30'},{skuIds:['sku','sku']}])assert.throws(()=>calc.input({...raw,...change}));
 for(const change of [{issueEvents:1},{issued:'1.5'},{unitsPerPurchaseUnit:'0'},{unitCostMinor:'9007199254740992'}])assert.throws(()=>calc.calculate(calc.input(raw),'2026-01-01',[{...row,...change}]));
 assert.throws(()=>calc.calculate(calc.input(raw),'2026-01-11',[row]),/ended/);assert.equal(calc.calculate(calc.input(raw),'2026-01-05',[row]).promotionDays,6);
});

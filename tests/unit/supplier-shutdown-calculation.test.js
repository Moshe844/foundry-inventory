'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{input,calculate}=require('../../src/purchasing/supplier-shutdown-calculation');
const raw={supplierId:'known',locationId:'warehouse',reference:'Checked shutdown notice',skuIds:['a'],lastOrderDate:'2026-11-20',closedFrom:'2026-11-21',closedThrough:'2026-12-10',nextArrivalDate:'2026-12-21',extraCoverDays:'0'};
const row={skuId:'a',issued:'90',issueEvents:3,onHand:'10',committed:'4',incoming:'6',unitsPerPurchaseUnit:'12',orderMultiple:'1',minimumOrderQuantity:'2',unitCostMinor:'95'};
test('shutdown coverage uses exact demand, promises, incoming stock and whole supplier packs',()=>{
 const p=calculate(input(raw),'2026-11-21',[row]);assert.equal(p.coverageDays,30);assert.equal(p.deadlinePassed,true);assert.equal(p.rows[0].expectedUnits,30);assert.equal(p.rows[0].availableUnits,12);assert.equal(p.rows[0].neededUnits,18);assert.equal(p.rows[0].purchaseUnits,2);assert.equal(p.rows[0].quantityUnits,24);assert.equal(p.totalMinor,2280);
 const shortage=calculate(input(raw),'2026-11-21',[{...row,onHand:'0',incoming:'0',committed:'5'}]);assert.equal(shortage.rows[0].neededUnits,35);assert.equal(shortage.rows[0].quantityUnits,36);
 assert.equal(calculate(input(raw),'2026-11-21',[{...row,onHand:'100'}]).totalMinor,0);
});
test('shutdown planning never supplies missing dates, coverage, demand or supplier pack facts',()=>{
 for(const patch of [{closedFrom:'2026-02-30'},{nextArrivalDate:'2026-11-20'},{extraCoverDays:''},{skuIds:['a','a']},{lastOrderDate:''}])assert.throws(()=>input({...raw,...patch}));
 for(const patch of [{issueEvents:1},{unitsPerPurchaseUnit:'0'},{orderMultiple:''},{minimumOrderQuantity:null},{issued:'-1'},{onHand:'0.5'},{unitCostMinor:'9007199254740991'}])assert.throws(()=>calculate(input(raw),'2026-11-21',[{...row,...patch}]));
});

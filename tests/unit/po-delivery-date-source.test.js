'use strict';const test=require('node:test'),assert=require('node:assert/strict'),source=require('../../src/purchasing/po-delivery-date-source');
test('delivery-date authority needs every explicit limit and checks individual and total calendar shifts across leap days',()=>{
 const caps=source.caps({maximumShiftDays:'2',maximumTotalShiftDays:'10',maximumFutureDays:'30'}),p={currentDate:'2028-02-28',originalDate:'2028-02-20',proposedDate:'2028-03-01'};
 assert.equal(source.within(p,caps,'2028-02-28'),true);assert.equal(source.within(p,{...caps,maximumShiftDays:1},'2028-02-28'),false);assert.equal(source.within(p,{...caps,maximumTotalShiftDays:9},'2028-02-28'),false);
 assert.equal(source.within({...p,currentDate:null,originalDate:null},caps,'2028-02-28'),false);assert.equal(source.within({...p,currentDate:null,originalDate:null},{...caps,allowFirstDate:true},'2028-02-28'),true);assert.equal(source.within(p,caps,'2028-03-02'),false);
 for(const input of [{},{maximumShiftDays:'2',maximumFutureDays:'30'},{maximumShiftDays:'1.5',maximumTotalShiftDays:'10',maximumFutureDays:'30'},{maximumShiftDays:'366',maximumTotalShiftDays:'10',maximumFutureDays:'30'}])assert.throws(()=>source.caps(input));
});
test('a supplier date scope preserves supplier identity, receiving warehouse, currency and exact purchase-unit profiles',()=>{
 const product={skuId:'one',code:'ONE',unit:'unit',precision:0,purchaseUnit:'case',unitsPerPurchaseUnit:'12'},scope={supplierId:'supplier',supplierEmail:'supplier@example.test',destinationLocationId:'warehouse',currency:'USD',products:[product,{...product,skuId:'two',code:'TWO'}]};
 assert.equal(source.covers(scope,{...scope,products:[product]}),true);for(const changed of [{supplierEmail:'different@example.test'},{destinationLocationId:'another'},{currency:'EUR'},{products:[{...product,unitsPerPurchaseUnit:'24'}]},{products:[{...product,code:'CHANGED'}]}])assert.equal(source.covers(scope,{...scope,...changed}),false);
});

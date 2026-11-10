'use strict';const test=require('node:test'),assert=require('node:assert/strict'),n=require('../../src/documents/product-source-native');
test('source measurements convert exactly without rounding, guessing separators or changing stock-unit meaning',()=>{
 assert.equal(n.quantity('1.25','kg','mass').value,1250);assert.equal(n.quantity('2','in','length').value,'50.8');assert.equal(n.quantity('5','in','length').value,127);assert.equal(n.quantity('1,25','kg','mass').value,1250);assert(n.quantity('1,250','kg','mass').problem);assert.equal(n.quantity('0.5','g','mass').value,'0.5');assert(n.quantity('4','kg','width').problem);
});
test('barcode normalization preserves leading zeros and rejects invalid GTIN check digits',()=>{assert.equal(n.barcode('0 12345 67890 5').value,'012345678905');assert(n.barcode('012345678906').problem);assert.equal(n.barcode('SUP-ABC-1').value,'SUP-ABC-1');assert(n.barcode('1.2345E+12').problem);});
test('conflicting measurements hold every peer and carton counts cannot create native unit weights',()=>{
 const snapshot={item:{id:'i',name:'Item',base_code:'X',unit_label:'unit',is_active:1},skus:[{id:'s',code:'X',is_active:1}]};const f={id:'1',kind:'mass',value:'1',unit:'kg',subject:'X',perUnit:'',basis:'product_net',quote:'X Net weight: 1 kg'};
 const rows=n.classify([f,{...f,id:'2',value:'2',quote:'X Net weight: 2 kg'}],snapshot);assert(rows.every(r=>r.problem&&r.native.problem));assert.match(n.classify([{...f,basis:'carton'}],snapshot)[0].native.problem,/carton/);
 const measured={...snapshot,item:{...snapshot.item,unit_label:'kg'}};assert.match(n.classify([f],measured)[0].native.problem,/one kg/);
});

'use strict';const test=require('node:test'),assert=require('node:assert/strict'),{classify}=require('../../src/imports/document-rows');
test('document totals and charges are retained across table columns, languages and values without consuming product identities',()=>{
 for(const label of ['Grand total','סה״כ לתשלום','Total général','מע״מ 17%'])for(let column=0;column<5;column++){
  const first={sourceRow:2,cells:['CODE-A','Named part','7','4.20','29.40']},second={sourceRow:3,cells:['CODE-B','Other part','13','5.10','66.30']},cells=Array(5).fill('');cells[column]=label;if(column!==4)cells[4]='₪95.70';const footer={sourceRow:4,cells},roles=classify({rows:[first,second,footer]},{code:0,name:1,quantity:2,unitCost:3});assert.equal(roles.get(4)?.kind,/מע״מ/.test(label)?'charge':'total',label+' at '+column);assert.equal(roles.get(4).label,label);assert.equal(roles.productCount,2);
 }
 const real={sourceRow:4,cells:['GENUINE-PART','Grand total','3','8.00','24.00']},roles=classify({rows:[{sourceRow:2,cells:['A','One','7']},{sourceRow:3,cells:['B','Two','2']},real]},{code:0,name:1,quantity:2});assert.equal(roles.has(4),false,'A separately coded product named like a total remains a product');
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{classify}=require('../../src/imports/document-rows');

test('150000 mixed-business stock rows retain explicit identity, document choices and footer review',t=>{
 const names=['Coffee','Phone case','Hex bolt','Grand total','Lotion','Freight'],rows=[];
 for(let i=0;i<150000;i++)rows.push({sourceRow:i+2,cells:[`${names[Math.floor(i/30)%names.length]} ${Math.floor(i/30)}`,`SKU-${Math.floor(i/3)}`,'NJ-Main','1','4.50','USD','Source '+i]});
 rows.push({sourceRow:150002,cells:['','', 'Grand total','150000']},{sourceRow:150003,cells:['Unfamiliar delivery summary','','','150000']});
 const mappings={name:0,code:1,location:2,quantity:3,unitCost:4,currency:5},started=performance.now();
 const result=classify({rows},mappings);
 assert.equal(result.productCount,150000);assert.equal(result.size,2);
 assert.equal(result.get(150002).kind,'total');assert.equal(result.get(150003).kind,'uncertain');
 t.diagnostic(JSON.stringify({products:5000,skus:50000,stockRows:150000,classificationMs:performance.now()-started}));
 const reviewed=classify({rows:rows.slice(-3)},mappings,{precedingProducts:149999,precedingStrongProducts:149999,rowRoles:{150001:'document',150003:'product'}});
 assert.equal(reviewed.get(150001).kind,'note');assert.equal(reviewed.get(150001).label,rows[149999].cells[0]);
 assert.equal(reviewed.get(150002).kind,'total');assert.equal(reviewed.has(150003),false);assert.equal(reviewed.productCount,150000);
 const tracked=classify({rows:[{sourceRow:160000,cells:['Total','','','2','','','','LOT-42']},{sourceRow:160001,cells:['Freight','','','1','','','SN-42','']}]},
  {...mappings,serial:6,lotCode:7},{precedingProducts:2,precedingStrongProducts:2,inDocumentTail:true});
 assert.equal(tracked.size,0);assert.equal(tracked.productCount,4);assert.equal(tracked.inDocumentTail,false);
});

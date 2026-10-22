'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const roles=require('../../src/imports/document-rows'),fields=require('../../src/imports/fields');
const mappings={code:0,name:1,quantity:2};
const source=values=>({rows:values.map((cells,index)=>({sourceRow:index+2,cells}))});

test('unfamiliar tail labels are held for review without a vocabulary of particular files or languages',()=>{
 const sheet=source([['AA-7','Brass fitting','6'],['BB-9','Ceramic fitting','8'],['','Grand total','14'],['','סיכום יחידות','14'],['','Στοιχεία: 2',''],['','Owner checked ✓','']]);
 const result=roles.classify(sheet,mappings);
 assert.equal(result.get(4).kind,'total');
 for(const row of [5,6,7])assert.equal(result.get(row).kind,'uncertain');
 const reviewed=roles.classify(sheet,mappings,{rowRoles:{5:'document',6:'document',7:'document'}});
 assert([...reviewed.values()].every(row=>row.kind!=='uncertain'));
});
test('a product with explicit identity and an unusual name survives totals and table restarts',()=>{
 const sheet=source([['A-1','Bolt','1'],['B-2','Nut','2'],['','Total','3'],['SUM-4','Total','4'],['','A product without its code','5']]);
 const result=roles.classify(sheet,mappings);assert(!result.has(5));assert.equal(result.get(6).kind,'uncertain');
 const choice=roles.classify(sheet,mappings,{rowRoles:{6:'product'}});assert(!choice.has(6));
 const names=roles.classify(source([['','Apples','1'],['','Pears','2'],['','Peaches','3']]),mappings);
 assert.equal(names.size,0,'a table of name-only products is not treated as document information');
});
test('document context survives bounded validation pages',()=>{
 const first=roles.classify(source([['Z-8','Valve','8'],['Y-6','Hose','6'],['','Total','14']]),mappings);
 const next=roles.classify({rows:[{sourceRow:502,cells:['','ملخص','14']}]},mappings,{precedingProducts:first.productCount,precedingStrongProducts:first.strongProductCount,inDocumentTail:first.inDocumentTail});
 assert.equal(next.get(502).kind,'uncertain');
});
test('explicit units and foreign unit prices keep a stable meaning even when a model proposes ignoring them',async()=>{
 const sheet={columns:['SKU','Product','Qty','Unit','Unit price (₪)','Unfamiliar flag'].map((name,index)=>({name,index})),rows:[{sourceRow:2,cells:['UM-4','Knife','0','knives','₪9.90','enabled']}]};
 const guessed=fields.guessMappings(sheet.columns,sheet.rows);assert(guessed.confident.includes('unitLabel'));assert(guessed.confident.includes('sellingPrice'));
 const result=await require('../../src/imports/mapping-service').proposeMappings(sheet,{provider:{complete:async()=>({data:{columns:[{index:3,field:'ignore',axisName:''},{index:4,field:'ignore',axisName:''}],detectedType:'inventory',note:''}})}});
 assert.equal(result.aiUsed,true);assert.equal(result.mappings.unitLabel,3);assert.equal(result.mappings.sellingPrice,4);
});
test('OCR heading fragments join within their real geometric neighborhood',()=>{
 const merge=require('../../src/imports/ocr-headings').merge;
 const input=[{text:'SKU',x:0,right:30,height:18},{text:'Product',x:180,right:238,height:18},{text:'name',x:265,right:305,height:18},{text:'Qty',x:500,right:530,height:18},{text:'on hand',x:550,right:610,height:18},{text:'Unit',x:800,right:832,height:18},{text:'cost',x:850,right:884,height:18}];
 assert.deepEqual(merge(input).map(c=>c.text),['SKU','Product name','Qty on hand','Unit cost']);
 assert.equal(merge([{text:'SKU',x:0,right:30,height:18},{text:'Part no',x:500,right:560,height:18}]).length,2);
});
test('retry progress names a new attempt and a queued import identifies the inventory it waits for',()=>{
 const present=require('../../src/imports/postgres-progress').present;
 const base={id:'fixture',records_valid:4000,records_detected:4000,plan_status:'READY',job_status:'RUNNING',lease_expires_at:2000,database_now:1000};
 const retry=present({...base,job_result:{importProgress:{stage:'processing',processedRows:0,totalRows:4000,attempt:2}}});assert.match(retry.stageLabel,/Attempt 2/);assert.equal(retry.attempt,2);
 assert.match(present({...base,job_status:'PENDING',waiting_for_import:true}).stageLabel,/running import in this inventory/);
});

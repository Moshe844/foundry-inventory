'use strict';const test=require('node:test'),assert=require('assert/strict'),identity=require('../../src/imports/source-identity');
test('paged identity evidence retains relationships across arbitrary batch boundaries',()=>{
 const mappings={code:0,name:1},proposal={variantColumns:[{name:'Texture',index:2},{name:'Grade',index:3}]},rows=Array.from({length:2507},(_,i)=>({sourceRow:i+2,cells:['GROUP-'+i%103,'Product '+i%103,i%2?'Smooth':'Rough',String(i%9)]}));
 const expected=identity.bases({rows},mappings,proposal),state=identity.accumulator(mappings,proposal);for(let start=0;start<rows.length;start+=137)state.add(rows.slice(start,start+137));assert.deepEqual(state.finish(),expected);assert.equal(expected.length,103);
});
test('disk-backed family discovery retains late ambiguity and missing-option evidence',()=>{
 const mappings={code:0,name:1},proposal={variantColumns:[{name:'Size',index:2}]};
 const rows=Array.from({length:10000},(_,i)=>({sourceRow:i+2,cells:['GROUP-'+i%500,'Product '+i%500,String(Math.floor(i/500))]}));
 rows.push({sourceRow:10002,cells:['GROUP-499','Different name','Another']},{sourceRow:10003,cells:['GROUP-498','Product 498','']});
 const memory=identity.accumulator(mappings,proposal);memory.add(rows);
 assert.deepEqual(identity.bases({rows},mappings,proposal),memory.finish());assert.equal(memory.finish().length,498);
});
test('reused product bases derive stable option SKUs across validation pages; duplicate SKUs stay duplicates',()=>{const mappings={code:0,name:1,variant1:2},proposal={axisNames:{variant1:'Size'}};const fields=require('../../src/imports/fields');const axis=fields.VARIANT_FIELDS[0];delete mappings.variant1;mappings[axis]=2;proposal.axisNames={[axis]:'Size'};const rows=Array.from({length:1001},(_,i)=>({sourceRow:i+2,cells:['BASE','Product',i%2?'Small':'Large']}));assert.deepEqual(identity.bases({rows},mappings,proposal),['base']);assert.equal(identity.derived('BASE',identity.options(rows[0],mappings,proposal)),'BASE-LARGE');assert.equal(identity.derived('BASE',identity.options(rows[1000],mappings,proposal)),'BASE-LARGE');assert.deepEqual(identity.bases({rows:rows.filter((r,i)=>i%2)},mappings,proposal),[]);const differentlyNamed=[rows[0],{...rows[1],cells:['BASE','Unrelated product','Small']}];assert.deepEqual(identity.bases({rows:differentlyNamed},mappings,proposal),[]);});

test('Shopify option name and value pairs produce named variants rather than six axes',async()=>{
 const headers=['Product','SKU','Option1 Name','Option1 Value','Option2 Name','Option2 Value','Option3 Name','Option3 Value','Barcode'];const sheet={columns:headers.map((name,index)=>({name,index})),rows:[{sourceRow:2,cells:['Shirt','SHIRT-S-BLUE','Size','S','Color','Blue','Fabric','Cotton','001234567890']}]};
 const proposal=await require('../../src/imports/mapping-service').proposeMappings(sheet,{allowModel:false});assert.equal(proposal.mappings.option1Name,2);assert.equal(proposal.mappings.option2Name,4);assert.equal(proposal.mappings.option3Name,6);assert.equal(proposal.mappings.barcode,8);
 assert.deepEqual(identity.options(sheet.rows[0],proposal.mappings,proposal),[{name:'Size',value:'S'},{name:'Color',value:'Blue'},{name:'Fabric',value:'Cotton'}]);
});

test('an unavailable AI column reader preserves manual mapping without exposing internal codes',async()=>{
 const sheet={columns:[{name:'Unfamiliar heading',index:0}],rows:[{sourceRow:2,cells:['Product A']}]};
 const provider={generateStructured:async()=>{throw Error('CERTIFICATION_WINDOW_CLOSED');}};
 const result=await require('../../src/imports/mapping-service').proposeMappings(sheet,{provider,forceModel:true});
 assert.match(result.aiError,/AI column reader is unavailable/);assert.doesNotMatch(result.aiError,/CERTIFICATION/);assert(result.mappings);
});

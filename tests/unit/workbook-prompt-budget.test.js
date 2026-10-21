'use strict';const test=require('node:test'),assert=require('node:assert/strict'),relations=require('../../src/imports/workbook-relations'),parser=require('../../src/imports/parser');
test('compact source profiles retain every sheet, header and diverse sample independently of input names',()=>{
 const rows=[['Unfamiliar reference','Late flag'],...Array.from({length:130},(_,i)=>['PART-'+i,i===129?'Yes':'No'])],book={sheets:[{name:'Unfamiliar source',...parser.tabulate(rows)}]},profiles=relations.profile(book),before=JSON.stringify(profiles),packed=relations.compactProfile(profiles,{sampleCharacters:12});
 assert.equal(JSON.stringify(profiles),before);assert.equal(packed.worksheets.length,1);assert.equal(packed.strings[packed.worksheets[0][1]],'Unfamiliar source');assert.equal(packed.worksheets[0][2],130);
 for(const [i,c]of packed.worksheets[0][3].entries()){assert.equal(c[0],i);assert.equal(packed.strings[c[1]],profiles[0].columns[i].name);assert.equal(c[2],profiles[0].columns[i].distinct);}
 assert.deepEqual(packed.worksheets[0][3][1][3].map(i=>packed.strings[i]),['No','Yes']);
});
test('workbook interpretation fits the existing provider allowance before its single call and rejects impossible bounds',async()=>{
 const book={sheets:[{name:'Strange parts',...parser.tabulate([['Reference','Name'],['AX-7','Vessel']])}]},contract={baseSheet:0,joins:[],fields:[{field:'code',source:{sheet:0,column:0}},{field:'name',source:{sheet:0,column:1}}],variants:[],stock:{total:null,locations:[]},coverage:[{sheet:0,role:'inventory',reason:'Current catalogue.'}]};let calls=0,observed;
 const provider={promptByteAllowance:async request=>request.maxOutputTokens===2000?10000:0,complete:async request=>{calls++;observed=request;return {data:contract};}};
 const result=await relations.interpret(book,{provider});assert.equal(calls,1);assert.equal(observed.maxOutputTokens,2000);assert.equal(result.sourceRows,1);assert.equal(result.sheet.rows[0].cells[result.mappings.code],'AX-7');
 await assert.rejects(relations.interpret(book,{provider:{...provider,promptByteAllowance:async()=>1}}),/complete source description/);assert.equal(calls,1,'An inadmissible prompt makes no paid attempt');
 await relations.interpret(book,{provider:{...provider,promptByteAllowance:async()=>10000}});assert.equal(observed.maxOutputTokens,8000,'Complex relationship output may use a larger response only when the same dollar bound permits it');assert.equal(require('../../src/commercial/model').POLICIES.import_mapping.maxOutputTokens,8000);
});

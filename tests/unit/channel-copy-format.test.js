'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),service=require('../../src/catalog/agent-channel-copy');
test('downloaded CSV preserves literal quotes and newlines while preventing spreadsheet formula cells',()=>{
 const text=service.csv([{sku:'=HYPERLINK("bad")',channel:' \t@danger',title:'-1+2',description:'Literal "quote"\nand newline',problem:null},{sku:'held',problem:'Needs review'}]);
 assert.match(text,/"' \t@danger"/);assert.match(text,/"'=HYPERLINK\(""bad""\)"/);assert.match(text,/"'-1\+2"/);assert.match(text,/"Literal ""quote""\nand newline"/);assert.doesNotMatch(text,/held/);
});
test('title length counts Unicode characters and absent descriptions do not invent features',()=>{
 const source={scope:{channel_name:'Our store',title_limit:40,description_style:'paragraph'},products:[{id:'x',code:'SKU-1',name:'🧵'.repeat(40),options:[],description:null}]};
 const row=service.compose(source)[0];assert.equal(row.problem,null);assert.equal(row.title,'🧵'.repeat(40));assert.equal(row.description,'🧵'.repeat(40)+'\n\nProduct code: SKU-1');
 source.products[0].name+='x';assert.match(service.compose(source)[0].problem,/Title exceeds/);
});

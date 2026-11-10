'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),service=require('../../src/catalog/agent-channel-copy');
test('downloaded CSV preserves literal quotes and newlines while preventing spreadsheet formula cells',()=>{
 const text=service.csv([{sku:'=HYPERLINK("bad")',channel:' \t@danger',title:'-1+2',description:'Literal "quote"\nand newline',problem:null},{sku:'held',problem:'Needs review'}]);
 assert.match(text,/"' \t@danger"/);assert.match(text,/"'=HYPERLINK\(""bad""\)"/);assert.match(text,/"'-1\+2"/);assert.match(text,/"Literal ""quote""\nand newline"/);assert.match(text,/held/);assert.match(text,/Needs review/);
});
test('AI output validation requires exact SKU coverage, source quotations and variant identity',()=>{
 const writer=require('../../src/catalog/channel-copy-writer'),source={scope:{channel_name:'Our store',title_limit:80,description_limit:500},products:[{id:'x',code:'SKU-1',name:'Cotton shirt',options:[{name:'Size',value:'XL'}],description:'Woven cotton.'}]};
 const data={rows:[{skuId:'x',title:'Cotton shirt XL',description:'Woven cotton. Size XL.',evidence:['Woven cotton.'],problem:''}]};assert.equal(writer.validate(source,data)[0].sku,'SKU-1');
 assert.throws(()=>writer.validate(source,{rows:[]}),/every requested/);assert.match(writer.validate(source,{rows:[{...data.rows[0],title:'Cotton shirt'}]})[0].title,/XL/);assert.throws(()=>writer.validate(source,{rows:[{...data.rows[0],evidence:['invented']}]}),/source facts/);
});

test('unsupported qualitative claims cannot pass a source-grounded copy review',()=>{
 const writer=require('../../src/catalog/channel-copy-writer'),source={scope:{channel_name:'Store',title_limit:80,description_limit:500},products:[{id:'x',code:'X',name:'Printer',description:'USB printer. Labels not included.',options:[]}]};
 assert.throws(()=>writer.validate(source,{rows:[{skuId:'x',title:'Printer',description:'Ideal for printing labels efficiently.',evidence:['USB printer.'],problem:''}]}),/qualitative benefit/);
});

test('short variant values are preserved as identities rather than substrings of ordinary words',()=>{
 const writer=require('../../src/catalog/channel-copy-writer'),source={scope:{channel_name:'Store',title_limit:80,description_limit:500},products:[{id:'x',code:'LINEN-L',name:'Linen shirt',options:[{name:'Size',value:'L'}]}]};
 const row=writer.validate(source,{rows:[{skuId:'x',title:'Linen shirt',description:'Linen shirt.',evidence:['Linen shirt'],problem:''}]})[0];assert.equal(row.title,'Linen shirt — L');assert.match(row.description,/\nL$/);
});

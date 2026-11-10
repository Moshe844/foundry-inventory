'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp'),images=require('../../src/ai/image-input'),budget=require('../../src/commercial/model-cost-budget'),table=require('../../src/imports/handwritten-table');
const picture=()=>sharp({create:{width:800,height:600,channels:3,background:'#ffffff'}}).png().toBuffer();
test('all PDF pages are checked, non-stock cover pages are retained, and differing later-page columns are combined without loss',async()=>{
 const PDF=require('pdfkit'),doc=new PDF(),chunks=[];doc.on('data',b=>chunks.push(b));const ended=new Promise(r=>doc.on('end',r));doc.text('Cover page');doc.addPage().text('Count page A');doc.addPage().text('Count page B');doc.end();await ended;let n=0;
 const result=await table.parse(Buffer.concat(chunks),{purpose:'count',providerForPage:()=>({complete:async()=>({data:++n===1?{pageKind:'no_stock_rows',pageNote:'Cover with no inventory rows',documentKind:'unknown',complete:true,columns:[],rows:[]}:{pageKind:'table',pageNote:'',documentKind:'count',complete:true,columns:n===2?[{field:'code',heading:'SKU'},{field:'quantity',heading:'Count'}]:[{field:'quantity',heading:'Count'},{field:'code',heading:'SKU'},{field:'lotCode',heading:'Lot'}],rows:[{cells:n===2?['A','12']:['2','B','LOT-2'],uncertain:false,note:''}]}})})});
 assert.equal(n,3);assert.equal(result.handwriting.pages,3);assert.equal(result.handwriting.observations[0].pageKind,'no_stock_rows');assert.equal(result.sheets[0].rows.length,2);assert.equal(result.sheets[0].rows[1].cells[result.mappings.code],'B');assert.equal(result.sheets[0].rows[1].cells[result.mappings.lotCode],'LOT-2');
});
test('existing HEIC and multipage TIFF originals use the bounded decoder and send every page to the reader',async()=>{
 const fs=require('node:fs'),path=require('node:path');for(const [file,pages]of [['stock-count.heic',1],['two-count-pages.tiff',2],['oriented-count.tiff',1]]){let calls=0;const result=await table.parse(fs.readFileSync(path.join(__dirname,'../fixtures/image-codecs',file)),{purpose:'count',providerForPage:()=>({complete:async request=>{images.inspect(request.prompt);return {data:{documentKind:'count',complete:true,columns:[{field:'code',heading:'SKU'},{field:'quantity',heading:'Count'}],rows:[{cells:['COUNT-'+(++calls),'12'],uncertain:false,note:''}]}};}})});assert.equal(calls,pages);assert.equal(result.handwriting.pages,pages);}
});
test('embedded images reserve real visual input above text, normalize actual pixels and reject remote addresses and forged dimensions',async()=>{
 const block=await images.prepare(await picture()),prompt=[block,{type:'text',text:'Read the original count.'}],value=images.inspect(prompt);
 assert.equal(value.text,'Read the original count.');assert(value.imageTokens>2000);
 const p={maxOutputTokens:100},r={system:'Read.',prompt,schema:{}};
 assert(budget.estimateMaximumMinor(r,p,.001,.002).maximumMinor>budget.estimateMaximumMinor({...r,prompt:value.text},p,.001,.002).maximumMinor);
 assert.throws(()=>images.inspect([{type:'image',source:{type:'url',url:'http://127.0.0.1/private'}},{type:'text',text:'Read'}]),/embedded/);
 const forged=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(forged);forged.writeUInt32BE(100000,16);forged.writeUInt32BE(100000,20);
 assert.throws(()=>images.inspect([{type:'image',source:{type:'base64',media_type:'image/png',data:forged.toString('base64')}},{type:'text',text:'Read'}]),/2,048/);
 await assert.rejects(images.prepare(forged),/safely read/);assert.throws(()=>images.inspect(Array(6).fill(block)),/four/);
});
test('a complete source preserves fractional quantities, literal boxes, variants, lots, serials and uncertainty without posting stock',async()=>{
 const data={documentKind:'delivery',complete:true,columns:[{field:'code',heading:'Product'},{field:'quantity',heading:'Received'},{field:'unitLabel',heading:'Unit'},{field:'lotCode',heading:'Batch'},{field:'serial',heading:'Serial'},{field:'variant1',heading:'Size'}],rows:[{cells:['FABRIC','1.25','metres','LOT-A','','large'],uncertain:false,note:''},{cells:['BOXES','3','boxes','','S-01',''],uncertain:true,note:'Confirm last serial digit'}]};
 const result=await table.parse(await picture(),{purpose:'delivery',providerForPage:()=>({complete:async request=>{await request.onValidated(data);return {data};}})});
 assert.equal(result.sheets[0].rows.length,2);assert.equal(result.sheets[0].rows[0].cells[result.mappings.quantity],'1.25');assert.equal(result.sheets[0].rows[1].cells[result.mappings.unitLabel],'boxes');assert.equal(result.sheets[0].rows[1].problems[0].code,'image_identity_uncertain');
 assert.throws(()=>table.checked({...data,complete:false},'delivery'),/completely/);assert.throws(()=>table.checked(data,'count'),/selected count/);assert.throws(()=>table.checked({...data,columns:[...data.columns,data.columns[0]]},'delivery'),/complete product/);
});


test('variant dimensions on different pages retain independent source axes even when both model pages call them variant1',async()=>{
 const PDF=require('pdfkit'),doc=new PDF(),chunks=[];doc.on('data',b=>chunks.push(b));const ended=new Promise(r=>doc.on('end',r));doc.text('Size');doc.addPage().text('Colour');doc.end();await ended;let n=0;
 const value=await table.parse(Buffer.concat(chunks),{purpose:'count',providerForPage:()=>({complete:async()=>({data:{documentKind:'count',complete:true,columns:[{field:'code',heading:'SKU'},{field:'quantity',heading:'Count'},{field:'variant1',heading:++n===1?'Size':'Colour'}],rows:[{cells:['ITEM-'+n,'1',n===1?'Large':'Blue'],uncertain:false,note:''}]}})})});
 assert.equal(value.sheets[0].columns[value.mappings.variant1].name,'Size');assert.equal(value.sheets[0].columns[value.mappings.variant2].name,'Colour');assert.equal(value.sheets[0].rows[0].cells[value.mappings.variant1],'Large');assert.equal(value.sheets[0].rows[0].cells[value.mappings.variant2],'');assert.equal(value.sheets[0].rows[1].cells[value.mappings.variant1],'');assert.equal(value.sheets[0].rows[1].cells[value.mappings.variant2],'Blue');
});


test('an oversized embedded PDF raster refuses the whole count before any model call instead of silently dropping a page',async()=>{
 const image=await sharp({create:{width:3000,height:3000,channels:3,background:'white'}}).png().toBuffer(),PDF=require('pdfkit'),doc=new PDF(),parts=[];doc.on('data',b=>parts.push(b));const ended=new Promise(r=>doc.on('end',r));doc.text('Stock count original.');doc.addPage().text('Important handwritten quantity in the original raster.');doc.image(image,40,150,{width:500});doc.end();await ended;let calls=0;await assert.rejects(table.parse(Buffer.concat(parts),{purpose:'count',providerForPage:()=>{calls++;throw Error('A model must never receive a partial source.');}}),/image|safely|read/i);assert.equal(calls,0);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const codecs=require('../../src/imports/image-codecs'),images=require('../../src/imports/image-table'),fields=require('../../src/imports/fields');
const fixture=name=>fs.readFileSync(path.join(__dirname,'../fixtures/image-codecs',name));

test('HEIC and TIFF use the same OCR contract, retaining zeroes and operational columns',{timeout:120000},async()=>{
 for(const file of ['stock-count.heic','stock-count.tiff','oriented-count.tiff','two-count-pages.tiff']){
  const buffer=fixture(file),original=Buffer.from(buffer),source=await images.parse(buffer);
  assert.deepEqual(buffer,original);assert.equal(source.format,'image');assert.equal(source.sheets.length,file.startsWith('two-')?2:1);
  for(const [index,sheet]of source.sheets.entries()){
   assert.equal(sheet.rows.length,2);const mapping=fields.guessMappings(sheet.columns,sheet.rows).mappings;
   for(const key of ['code','name','quantity','unitCost','reorderPoint','leadTimeDays'])assert.notEqual(mapping[key],undefined,key);
   assert.deepEqual(sheet.rows.map(row=>row.cells[mapping.code]),['CODEC-'+(index?'58':'24')+'-A','CODEC-'+(index?'58':'24')+'-B']);
   assert.deepEqual(sheet.rows.map(row=>row.cells[mapping.name]),['Moss clip','Birch tray']);
   for(const [field,expected]of Object.entries({quantity:['7','0'],unitCost:['1.25','0.00'],reorderPoint:['0','1'],leadTimeDays:['2','3']}))assert.deepEqual(sheet.rows.map(row=>row.cells[mapping[field]]),expected);
  }
 }
});

test('dimensions and page count are checked before decoding pixels, and corrupt data has a plain error',{timeout:30000},async()=>{
 const UTIF=require('utif'),ifd=(width,height)=>({t256:[width],t257:[height],t258:[8,8,8,8],t259:[1],t262:[2],t273:[0],t277:[4],t278:[height],t279:[0]});
 await assert.rejects(codecs.decode(Buffer.from(UTIF.encode([ifd(4000,4000)]))),/12-megapixel/);
 await assert.rejects(codecs.decode(Buffer.from(UTIF.encode(Array.from({length:11},()=>ifd(1,1))))),/10 image pages/);
 await assert.rejects(codecs.decode(Buffer.from(UTIF.encode([ifd(0,400)]))),/invalid dimensions/);
 const corrupt=fixture('stock-count.tiff').subarray(0,5);await assert.rejects(codecs.decode(corrupt),error=>/No readable image|could not be decoded safely/.test(error.message)&&!/RangeError|offset|undefined|UTIF/.test(error.message));
 const huge=Buffer.alloc(20*1024*1024+1);fixture('stock-count.tiff').copy(huge,0,0,4);await assert.rejects(codecs.decode(huge),/20 MB/);
 // Rejections must release the admission slot for later genuine images.
 assert.equal((await codecs.decode(fixture('stock-count.heic'))).frames.length,1);
});

test('the codec queue is bounded and all admitted work releases its slot',{timeout:30000},async()=>{
 const buffer=fixture('stock-count.heic'),admitted=[codecs.decode(buffer),codecs.decode(buffer),codecs.decode(buffer)];
 await assert.rejects(codecs.decode(buffer),/Other image pages/);assert.equal((await Promise.all(admitted)).length,3);
 assert.equal((await codecs.decode(buffer)).frames.length,1);
});

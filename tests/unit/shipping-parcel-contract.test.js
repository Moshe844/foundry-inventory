'use strict';const test=require('node:test'),assert=require('node:assert/strict');
test('parcel options retain print format and signature requirements with strict measurements',()=>{
 const parcel=require('../../src/shipping/parcel-contract');
 assert.deepEqual(parcel.boxes([{weightGrams:'230',lengthMm:'240',widthMm:'180',heightMm:'70'}]),[{weightGrams:230,lengthMm:240,widthMm:180,heightMm:70}]);
 for(const input of [[{weightGrams:0}],[{weightGrams:1,lengthMm:-2,widthMm:2,heightMm:2}],[{weightGrams:2,lengthMm:10}],[]])assert.throws(()=>parcel.boxes(input),/package|weight|dimension/i);
 assert.deepEqual(parcel.options({labelFormat:'ZPL',labelLayout:'4x6',signature:'ADULT'}),{labelFormat:'ZPL',labelLayout:'4x6',signature:'ADULT'});
 assert.equal(parcel.options({printChoice:'PDF:letter'},{signature:'ADULT',labelFormat:'ZPL',labelLayout:'4x6'}).signature,'ADULT');
 assert.throws(()=>parcel.options({labelFormat:'EXE'}),/format/i);assert.throws(()=>parcel.options({labelFormat:'ZPL',labelLayout:'letter'}),/layout|size/i);
});
test('every label and customs document is retained without accepting unsafe download URLs',()=>{
 const parcel=require('../../src/shipping/parcel-contract');
 const result=parcel.documents({labelUrl:'https://labels.example.test/one.pdf',labelUrls:['https://labels.example.test/one.pdf','https://labels.example.test/two.pdf'],labelFormat:'PDF',customsUrls:['https://labels.example.test/customs.pdf']});
 assert.equal(result.length,3);assert.deepEqual(result.map(r=>r.kind),['LABEL','LABEL','CUSTOMS']);
 assert.throws(()=>parcel.documents({labelUrl:'javascript:alert(1)'}),/document|download|URL/i);assert.throws(()=>parcel.documents({labelUrl:'https://user:secret@labels.example.test/file.pdf'}),/document|download|URL/i);
});

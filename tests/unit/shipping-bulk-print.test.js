'use strict';const test=require('node:test'),assert=require('node:assert/strict');
async function sample(){const PDF=require('pdfkit'),pdf=new PDF({size:[288,432],margin:10}),chunks=[];pdf.on('data',d=>chunks.push(d));const done=new Promise(resolve=>pdf.on('end',()=>resolve(Buffer.concat(chunks))));pdf.text('SAMPLE LABEL');pdf.end();return done;}
test('bulk PDF preserves page dimensions and count; ZPL combines labels without any purchase API',{timeout:30000},async()=>{
 const print=require('../../src/shipping/bulk-print'),one=await sample(),documents=[{url:'https://label.example.test/a',format:'PDF'},{url:'https://label.example.test/b',format:'PDF'}];let gets=0;
 const output=await print.build(documents,'PDF',{download:async()=>{gets++;return one;}});assert.equal(gets,2);assert.equal(output.subarray(0,5).toString(),'%PDF-');
 const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs'),loading=pdfjs.getDocument({data:new Uint8Array(output)}),pdf=await loading.promise;assert.equal(pdf.numPages,2);const page=await pdf.getPage(1);assert.deepEqual(page.view,[0,0,288,432]);await loading.destroy();
 const zpl=await print.build([{format:'ZPL',url:'https://labels.example.test/1'},{format:'ZPL',url:'https://labels.example.test/2'}],'ZPL',{download:async()=>Buffer.from('^XA^FO20,20^FDTEST^FS^XZ')});assert.equal((zpl.toString().match(/\^XA/g)||[]).length,2);
 await assert.rejects(print.build(documents,'ZPL',{download:async()=>one}),/different.*format/i);
 await assert.rejects(print.build(documents,'PDF',{download:async()=>Buffer.from('<html>not a label</html>')}),/readable PDF/i);
});

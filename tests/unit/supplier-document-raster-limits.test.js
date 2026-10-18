'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
function documentWithImage(width,height){
 const content='BT /F1 3 Tf 10 40 Td (Supplier invoice total USD 20.00 due 2026-11-15) Tj ET q 10 0 0 10 10 10 cm /Im0 Do Q',pixels=width===2&&height===2?'abcdefghijkl':'x';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> /XObject << /Im0 6 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`];
 let text='%PDF-1.4\n';const offsets=[0];for(const [i,obj]of objects.entries()){offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${obj}\nendobj\n`;}const xref=Buffer.byteLength(text);text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(text);
}
test('external PDF image dimensions fail closed before decoding despite a small page and a readable text layer',{timeout:60000},async()=>{
 const reader=require('../../src/connections/document-reader');
 assert.match(await reader.read({filename:'valid.pdf',buffer:documentWithImage(2,2)}),/20.00/);
 await assert.rejects(()=>reader.read({filename:'large-image.pdf',buffer:documentWithImage(3000,3000)}),/could not read|needs review|stopped/);
});

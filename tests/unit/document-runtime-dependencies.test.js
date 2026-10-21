'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'../..');
function withoutFormats(file,blocked){
 const program=`const Module=require('node:module'),original=Module._load;Module._load=function(name,...args){if(${JSON.stringify(blocked)}.includes(name)){const error=new Error('Unavailable unrelated format');error.code='MODULE_NOT_FOUND';throw error;}return original.call(this,name,...args);};const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',async()=>{const file=JSON.parse(Buffer.concat(chunks).toString());try{const text=await require('./src/foundry/document-text').extractText({filename:file.filename,buffer:Buffer.from(file.base64,'base64')},{maxPages:20,maxTextCharacters:120000});process.stdout.write(JSON.stringify({text}));}catch(error){process.stdout.write(JSON.stringify({code:error.code||error.name}));process.exitCode=1;}});`;
 const result=spawnSync(process.execPath,['-e',program],{cwd:root,input:JSON.stringify({filename:file.filename,base64:file.buffer.toString('base64')}),encoding:'utf8',timeout:60000,windowsHide:true});assert.equal(result.status,0,result.stdout+' '+result.stderr);return JSON.parse(result.stdout).text;
}
test('production installs retain the workbook driver required by real document and import readers',()=>{
 const pkg=require('../../package.json'),lock=require('../../package-lock.json');assert(pkg.dependencies.xlsx);assert(!pkg.devDependencies.xlsx);assert.equal(lock.packages[''].dependencies.xlsx,pkg.dependencies.xlsx);assert(!lock.packages[''].devDependencies.xlsx);assert.notEqual(lock.packages['node_modules/xlsx'].dev,true);assert(lock.packages['node_modules/xlsx'].integrity);
});
test('plain text requires no PDF, workbook, Word, canvas or OCR runtime',()=>{
 const text='Independent document '+randomUUID()+' with exact amount USD 42.75.';assert.equal(withoutFormats({filename:'unfamiliar.txt',buffer:Buffer.from(text)},['xlsx','mammoth','pdfjs-dist/legacy/build/pdf.mjs','@napi-rs/canvas','tesseract.js','@tesseract.js-data/eng']),text);
});
test('text PDFs remain readable when unrelated workbook, Word and OCR formats are unavailable',async()=>{
 const PDF=require('pdfkit'),document=new PDF(),parts=[],ready=new Promise((ok,no)=>{document.on('data',p=>parts.push(p));document.on('end',ok);document.on('error',no);}),reference=randomUUID();document.text('Supplier document '+reference+' Total USD 42.75. No delivery or payment is established.');document.end();await ready;
 const text=withoutFormats({filename:'unfamiliar.pdf',buffer:Buffer.concat(parts)},['xlsx','mammoth','tesseract.js','@tesseract.js-data/eng']);assert(text.includes(reference));assert.match(text,/42.75/);
});
test('workbooks still read every sheet and their actual values after lazy format loading',async()=>{
 const XLSX=require('xlsx'),book=XLSX.utils.book_new(),reference=randomUUID();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Unfamiliar product label','Pieces'],[reference,0]]),'North ledger');XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Reference','Cost'],[reference,42.75]]),'Other records');const text=await require('../../src/foundry/document-text').extractText({filename:'unfamiliar.xlsx',buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx'})});assert.match(text,/North ledger/);assert.match(text,/Other records/);assert.match(text,/42.75/);assert(text.includes(reference));assert.match(text,/\| 0/);
});

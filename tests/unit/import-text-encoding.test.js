'use strict';const test=require('node:test'),assert=require('node:assert/strict'),parser=require('../../src/imports/parser');
const rows=[['SKU','Product name','Quantity','Unit cost','Unit'],['ENC-α7','Écrou large',12,'1,50','boxes'],['ENC-β9','כיסוי מגן',0,'0,00','covers']],text=rows.map(r=>r.join('\t')).join('\r\n');
test('BOM-declared UTF-16 exports preserve columns, non-Latin names, exact numeric text and zeroes in either byte order',()=>{
 for(const bigEndian of [false,true]){const data=Buffer.from(text,'utf16le');if(bigEndian)data.swap16();const buffer=Buffer.concat([Buffer.from(bigEndian?[0xfe,0xff]:[0xff,0xfe]),data]),sheet=parser.parse({buffer,filename:'unfamiliar-export.tsv'}).sheets[0];assert.deepEqual(sheet.columns.map(c=>c.name),rows[0]);assert.deepEqual(sheet.rows.map(r=>r.cells),rows.slice(1).map(row=>row.map(String)));}
});
test('malformed declared encoding cannot silently alter an inventory identity',()=>{
 for(const buffer of [Buffer.from([0xff,0xfe,0x41]),Buffer.from([0xfe,0xff,0xd8,0])])assert.throws(()=>parser.parse({buffer,filename:'stock.csv'}),/encoding/i);
 // Not UTF-8 without a byte-order mark is Excel's Windows text. It is read as
 // that and flagged on the preview, never silently.
 const windows=parser.parse({buffer:Buffer.from('SKU,Name\nA-1,Café\n','latin1'),filename:'stock.csv'});assert.equal(windows.sheets[0].rows[0].cells[1],'Café');assert.match(windows.encodingNote,/Windows text/);
 assert.throws(()=>parser.parse({buffer:Buffer.from([0x53,0,0x4b,0x55]),filename:'stock.csv'}),/could not read this file type/);
});

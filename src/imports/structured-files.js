'use strict';
const {ValidationError}=require('../domain/errors');
const {decodeXml,readZip}=require('./xlsx-reader');
function table(records){
 if(!Array.isArray(records)||!records.length||records.length>1000000||records.some(r=>!r||typeof r!=='object'||Array.isArray(r)))throw new ValidationError('Choose a JSON array of product records, with one object per row.');
 const columns=[...new Set(records.flatMap(r=>Object.keys(r)))];if(columns.length>512||columns.some(c=>['__proto__','constructor','prototype'].includes(c)))throw new ValidationError('This source has unsupported column names or too many columns.');
 if(records.some(r=>Object.values(r).some(v=>v!==null&&typeof v==='object')))throw new ValidationError('This JSON contains nested records. Export a flat product table so no values are silently discarded.');
 return [columns,...records.map(r=>columns.map(c=>r[c]??''))];
}
function json(buffer){let value;try{value=JSON.parse(buffer.toString('utf8'));}catch{throw new ValidationError('That JSON could not be read. Check its formatting; no inventory changed.');}
 if(!Array.isArray(value)){const arrays=Object.values(value||{}).filter(Array.isArray);if(arrays.length!==1)throw new ValidationError('Choose one JSON product list per file.');value=arrays[0];}
 return {sheets:[{name:'Product records',grid:table(value)}]};}
function textXml(value){return decodeXml(String(value).replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();}
function archive(buffer){const zip=readZip(buffer),word=zip.get('word/document.xml');if(word){
  if(word.length>32*1024*1024)throw new ValidationError('That Word table is too large. Export it as CSV or XLSX.');
  const sheets=[];for(const match of word.toString('utf8').matchAll(/<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g)){const grid=[];for(const row of match[1].matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g))grid.push([...row[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map(c=>textXml(c[1])));if(grid.length)sheets.push({name:'Word table '+(sheets.length+1),grid});}if(!sheets.length)throw new ValidationError('That Word document has no readable table.');return {sheets};
 }
 const mime=zip.get('mimetype')?.toString('utf8');if(mime==='application/vnd.oasis.opendocument.spreadsheet'){
  const xml=zip.get('content.xml');if(!xml||xml.length>64*1024*1024)throw new ValidationError('That ODS table is too large. Export it as CSV or XLSX.');const sheets=[];
  for(const sheet of xml.toString('utf8').matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)){const grid=[];for(const row of sheet[2].matchAll(/<table:table-row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)){
   const cells=[];for(const cell of (row[2]||'').matchAll(/<table:table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)){const repeated=Number(/table:number-columns-repeated="(\d+)"/.exec(cell[1])?.[1]||1),body=cell[2]||'',value=body?textXml(body):decodeXml(/office:(?:value|string-value)="([^"]*)"/.exec(cell[1])?.[1]||'');if(repeated>512||cells.length+repeated>512){if(value)throw new ValidationError('This ODS table exceeds 512 columns.');break;}for(let i=0;i<repeated;i++)cells.push(value);}
   if(!cells.some(c=>String(c).trim()))continue;const repeated=Number(/table:number-rows-repeated="(\d+)"/.exec(row[1])?.[1]||1);if(grid.length+repeated>1000001)throw new ValidationError('This ODS table exceeds the import row capacity.');for(let i=0;i<repeated;i++)grid.push([...cells]);}
   if(grid.length)sheets.push({name:decodeXml(/table:name="([^"]*)"/.exec(sheet[1])?.[1]||'Sheet '+(sheets.length+1)),grid});}if(!sheets.length)throw new ValidationError('That ODS workbook has no readable table.');return {sheets};
 }
 if(!zip.get('xl/workbook.xml'))throw new ValidationError('ZIP bundles are not imported as spreadsheets. Upload each CSV separately, or combine them in an XLSX workbook.');return null;
}
module.exports={json,archive,table};

'use strict';

// Keep source offsets rather than millions of arrays and cell strings. Callers
// retain normal read-only Array iteration/slicing semantics; each requested row
// is decoded on demand. The source text and compact offsets are the only data
// retained, including when a column is profiled more than once.
function indexedDelimited(text, delimiter, helpers, {maxRows=5000000}={}) {
 const {SpreadsheetError,locateHeader,looksLikeHeader,nameColumns,maxColumns}=helpers;
 function* records(){
  let cells=[],field='',quoted=false,start=0,sourceRow=1;
  for(let i=0;i<text.length;i++){
   const c=text[i];
   if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else quoted=false;}else field+=c;continue;}
   if(c==='"'&&field===''){quoted=true;continue;}
   if(c===delimiter){cells.push(field);field='';if(cells.length>=maxColumns)throw new SpreadsheetError('This file exceeds the import column capacity. No columns were silently dropped.');continue;}
   if(c==='\r')continue;
   if(c==='\n'){cells.push(field);yield {cells,start,end:i,sourceRow};cells=[];field='';start=i+1;sourceRow++;continue;}
   field+=c;
  }
  if(quoted)throw new SpreadsheetError('This file ends inside a quoted field. No incomplete rows were imported.');
  if(field!==''||cells.length){cells.push(field);yield {cells,start,end:text.length,sourceRow};}
 }
 const sample=[];for(const row of records()){sample.push(row.cells);if(sample.length===26)break;}
 const candidate=locateHeader(sample),headerless=!looksLikeHeader(sample[candidate]),headerRowIndex=headerless?-1:candidate;
 const header=headerless?[]:sample[headerRowIndex]||[],signature=header.map(c=>c.trim().toLowerCase()).join('\0');
 let width=header.length,length=0,droppedBlankRows=0,repeatedHeaderRows=0;
 const used=new Set(),blocks=[],blockSize=16384;
 for(const row of records()){
  if(row.sourceRow<=headerRowIndex)continue;
  width=Math.max(width,row.cells.length);
  if(row.sourceRow===headerRowIndex+1)continue;
  const cells=row.cells.map(c=>c.trim());
  if(cells.every(c=>c==='')){droppedBlankRows++;continue;}
  if(cells.map(c=>c.toLowerCase()).join('\0')===signature){repeatedHeaderRows++;continue;}
  if(length>=maxRows)throw new SpreadsheetError(`This file exceeds the import row capacity of ${maxRows.toLocaleString()} rows. No rows were truncated or imported.`);
  for(let i=0;i<cells.length;i++)if(cells[i]!=='')used.add(i);
  const b=Math.floor(length/blockSize),offset=(length%blockSize)*3;
  if(!blocks[b])blocks[b]=new Uint32Array(blockSize*3);
  blocks[b].set([row.start,row.end,row.sourceRow],offset);length++;
 }
 const kept=nameColumns(header,width).filter(column=>used.has(column.index)||column.original!=='');
 const read=index=>{
  const block=blocks[Math.floor(index/blockSize)],offset=(index%blockSize)*3;
  const cells=helpers.parseDelimited(text.slice(block[offset],block[offset+1]),delimiter)[0]||[];
  return {sourceRow:block[offset+2],cells:kept.map(c=>String(cells[c.index]??'').trim())};
 };
 const target=new Array(length),numeric=key=>typeof key==='string'&&/^(?:0|[1-9]\d*)$/.test(key);
 const rows=new Proxy(target,{
  get(array,key,receiver){if(numeric(key)){const i=Number(key);return i<length?read(i):undefined;}return Reflect.get(array,key,receiver);},
  has(array,key){return numeric(key)?Number(key)<length:Reflect.has(array,key);},
  set(){throw new TypeError('Source rows are read-only. Create a revised preview to change them.');},
  deleteProperty(){throw new TypeError('Source rows are read-only.');},
 });
 return {name:'Pasted data',columns:kept.map((c,index)=>({...c,index,sourceIndex:c.index})),rows,
  preamble:sample.slice(0,Math.max(headerRowIndex,0)).map(row=>row.map(c=>c.trim())),headerRowIndex,headerless,droppedBlankRows,repeatedHeaderRows};
}
module.exports={indexedDelimited};

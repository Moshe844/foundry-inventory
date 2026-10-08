'use strict';

const parser=require('./parser');
const {ValidationError}=require('../domain/errors');

const MAX_PAGES=30;
const MAX_TEXT_ITEMS=50000;

function groupRows(items){
  const rows=[];
  for(const item of items.sort((left,right)=>right.y-left.y||left.x-right.x)){
    let row=rows.find((entry)=>Math.abs(entry.y-item.y)<=3);
    if(!row){row={y:item.y,cells:[]};rows.push(row);}
    row.cells.push(item);
  }
  return rows.sort((left,right)=>right.y-left.y).map((row)=>({y:row.y,
    cells:row.cells.sort((a,b)=>a.x-b.x)}));
}

function anchorColumns(rows){
  const candidates=rows.filter((row)=>row.cells.length>=3).slice(0,30);
  if(!candidates.length)return [];
  const likely=candidates.find((row)=>row.cells.every((item)=>!/^[-+]?\d+(?:[.,]\d+)?$/.test(item.text)))||candidates[0];
  return likely.cells.map((item)=>item.x);
}

function tabulatePage(rows,anchors){
  return rows.map((row)=>{
    const cells=Array(anchors.length).fill('');
    for(const item of row.cells){
      let nearest=0;let distance=Infinity;
      anchors.forEach((x,index)=>{const offset=Math.abs(item.x-x);
        if(offset<distance){nearest=index;distance=offset;}});
      cells[nearest]=cells[nearest]?`${cells[nearest]} ${item.text}`:item.text;
    }
    return cells;
  });
}

function withoutSeparatedFooter(rows){
  const gaps=rows.slice(1).flatMap((row,index)=>row.cells.length>=3&&rows[index].cells.length>=3
    ?[rows[index].y-row.y]:[]).sort((a,b)=>a-b);
  const typical=gaps[Math.floor(gaps.length/2)]||24;
  const firstTable=rows.findIndex((row)=>row.cells.length>=3);
  return rows.filter((row,index)=>index<=firstTable||row.cells.length>1
    ||rows[index-1].y-row.y<=Math.max(40,typical*1.6));
}

async function parse(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.subarray(0,5).toString('ascii')!=='%PDF-')
    throw new ValidationError('That is not a readable PDF inventory file.');
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  let document;
  try{document=await pdfjs.getDocument({data:new Uint8Array(buffer),useSystemFonts:true}).promise;}
  catch{throw new ValidationError('StockChief could not open that PDF. No inventory changed.');}
  if(document.numPages>MAX_PAGES)throw new ValidationError(`Import PDFs are limited to ${MAX_PAGES} pages. Split this source into smaller files.`);
  let combined=null;let totalItems=0;
  for(let pageNumber=1;pageNumber<=document.numPages;pageNumber++){
    const page=await document.getPage(pageNumber);
    const content=await page.getTextContent();
    const items=content.items.map((item)=>({text:String(item.str||'').trim(),
      x:Number(item.transform?.[4]||0),y:Number(item.transform?.[5]||0)})).filter((item)=>item.text);
    totalItems+=items.length;
    if(totalItems>MAX_TEXT_ITEMS)throw new ValidationError('That PDF contains too much text for a safe inventory preview. Split it into smaller files.');
    if(!items.length)throw new ValidationError('This PDF page has no readable text layer. A scan needs OCR review before inventory can be imported; nothing changed.');
    const rows=withoutSeparatedFooter(groupRows(items));const anchors=anchorColumns(rows);
    if(anchors.length<3)throw new ValidationError('StockChief could not identify a tabular inventory layout in this PDF. Nothing changed.');
    const sheet=parser.tabulate(tabulatePage(rows,anchors));
    if(!sheet.rows.length)throw new ValidationError(`PDF page ${pageNumber} has no inventory rows. Nothing changed.`);
    const headings=sheet.columns.map((column)=>column.name.toLowerCase());
    if(!combined)combined={name:'PDF table',...sheet};
    else{
      if(JSON.stringify(headings)!==JSON.stringify(combined.columns.map((column)=>column.name.toLowerCase())))
        throw new ValidationError(`PDF page ${pageNumber} has different columns. Split different tables into separate imports; nothing changed.`);
      const offset=combined.rows.length;
      combined.rows.push(...sheet.rows.map((row,index)=>({...row,sourceRow:offset+index+2})));
    }
  }
  return {sheets:[combined],primarySheet:0,format:'pdf'};
}

module.exports={parse,groupRows,anchorColumns,tabulatePage};

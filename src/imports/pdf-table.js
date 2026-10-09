'use strict';

const parser=require('./parser');
const {ValidationError}=require('../domain/errors');

const MAX_PAGES=30;
const MAX_TEXT_ITEMS=50000;
const MAX_OCR_PAGES=10;
const MAX_PDF_BYTES=32*1024*1024;
const MAX_OCR_PIXELS=12*1000*1000;

async function ocrCanvasRows(canvas,worker){
  const recognised=await worker.recognize(canvas.toBuffer('image/png'),{}, {blocks:true});
  const lines=(recognised.data.blocks||[]).flatMap((block)=>block.paragraphs||[])
    .flatMap((paragraph)=>paragraph.lines||[]);
  return lines.map((line)=>{
    const words=(line.words||[]).filter((word)=>String(word.text||'').trim()&&word.bbox)
      .sort((a,b)=>a.bbox.x0-b.bbox.x0);
    const cells=[];let current=null;
    for(const word of words){
      const height=Math.max(1,word.bbox.y1-word.bbox.y0);
      // A normal word space is much smaller than the gap between table
      // columns. Preserve phrases such as "Desk lamp" as one cell.
      if(!current||word.bbox.x0-current.right>Math.max(16,height*1.1)){
        current={x:word.bbox.x0,right:word.bbox.x1,text:word.text};cells.push(current);
      }else{current.text+=` ${word.text}`;current.right=word.bbox.x1;}
    }
    return {y:canvas.height-(line.bbox.y0+line.bbox.y1)/2,
      cells:cells.map((cell)=>({x:cell.x,text:cell.text}))};
  }).filter((line)=>line.cells.length).sort((a,b)=>b.y-a.y);
}

async function ocrRows(page,worker){
  const {createCanvas}=require('@napi-rs/canvas');
  const viewport=page.getViewport({scale:2});
  if(viewport.width*viewport.height>MAX_OCR_PIXELS)
    throw new ValidationError('That scan is too large to read safely. Try a smaller image or PDF page; no inventory changed.');
  const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
  await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
  return ocrCanvasRows(canvas,worker);
}

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
  const candidates=rows.filter((row)=>row.cells.length>=2).slice(0,30);
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
  if(rows.length<2)return rows;
  const gaps=rows.slice(1).flatMap((row,index)=>row.cells.length>=2&&rows[index].cells.length>=2
    ?[rows[index].y-row.y]:[]).sort((a,b)=>a-b);
  const typical=gaps[Math.floor(gaps.length/2)]||24;
  const firstTable=rows.findIndex((row)=>row.cells.length>=2);
  return rows.filter((row,index)=>index===0||index<=firstTable||row.cells.length>1
    ||rows[index-1].y-row.y<=Math.max(40,typical*1.6));
}

async function parse(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.subarray(0,5).toString('ascii')!=='%PDF-')
    throw new ValidationError('That is not a readable PDF inventory file.');
  if(buffer.length>MAX_PDF_BYTES)
    throw new ValidationError('That PDF is too large for a safe inventory preview. Split it into smaller files; no inventory changed.');
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  let document;
  try{document=await pdfjs.getDocument({data:new Uint8Array(buffer),useSystemFonts:true}).promise;}
  catch{throw new ValidationError('StockChief could not open that PDF. No inventory changed.');}
  if(document.numPages>MAX_PAGES)throw new ValidationError(`Import PDFs are limited to ${MAX_PAGES} pages. Split this source into smaller files.`);
  let combined=null;let totalItems=0;let worker=null;let ocrPages=0;
  try{for(let pageNumber=1;pageNumber<=document.numPages;pageNumber++){
    const page=await document.getPage(pageNumber);
    const content=await page.getTextContent();
    const items=content.items.map((item)=>({text:String(item.str||'').trim(),
      x:Number(item.transform?.[4]||0),y:Number(item.transform?.[5]||0)})).filter((item)=>item.text);
    totalItems+=items.length;
    if(totalItems>MAX_TEXT_ITEMS)throw new ValidationError('That PDF contains too much text for a safe inventory preview. Split it into smaller files.');
    let rows=withoutSeparatedFooter(groupRows(items));
    let anchors=anchorColumns(rows);
    let sheet=anchors.length>=2?parser.tabulate(tabulatePage(rows,anchors)):null;
    // A scan may have a small selectable title while its table remains an
    // image. In that case the presence of *some* PDF text is not evidence that
    // the inventory table was read; OCR the page before giving up.
    if(!sheet?.rows.length){
      if(++ocrPages>MAX_OCR_PAGES)throw new ValidationError(`This scan exceeds the ${MAX_OCR_PAGES}-page OCR safety limit. Upload it in smaller parts; nothing changed.`);
      if(!worker){const {createWorker}=require('tesseract.js');
        const english=require('@tesseract.js-data/eng');
        worker=await createWorker(english.code,1,{langPath:english.langPath,gzip:english.gzip,cacheMethod:'readOnly'});}
      rows=withoutSeparatedFooter(await ocrRows(page,worker));
      anchors=anchorColumns(rows);
      sheet=anchors.length>=2?parser.tabulate(tabulatePage(rows,anchors)):null;
    }
    if(!sheet?.rows.length)throw new ValidationError(`StockChief could not read a product table on PDF page ${pageNumber}. Nothing changed; try a clearer scan.`);
    const headings=sheet.columns.map((column)=>column.name.toLowerCase());
    if(!combined)combined={name:'PDF table',...sheet};
    else{
      if(JSON.stringify(headings)!==JSON.stringify(combined.columns.map((column)=>column.name.toLowerCase())))
        throw new ValidationError(`PDF page ${pageNumber} has different columns. Split different tables into separate imports; nothing changed.`);
      const offset=combined.rows.length;
      combined.rows.push(...sheet.rows.map((row,index)=>({...row,sourceRow:offset+index+2})));
    }
  }}finally{if(worker)await worker.terminate();}
  return {sheets:[combined],primarySheet:0,format:'pdf'};
}

module.exports={parse,groupRows,anchorColumns,tabulatePage,withoutSeparatedFooter,ocrRows,ocrCanvasRows};

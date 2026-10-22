'use strict';

const parser=require('./parser');
const tables=require('./pdf-table');
const {ValidationError}=require('../domain/errors');

const MAX_IMAGE_BYTES=20*1024*1024;
const MAX_PIXELS=12*1000*1000;

function removeTableRules(canvas){
  // Thin, long grid rules can make OCR read an entire table as line art.
  // Remove only geometric rules from the working copy, preserving the
  // original uploaded image and broad filled headings for review.
  const ctx=canvas.getContext('2d'),pixels=ctx.getImageData(0,0,canvas.width,canvas.height),{data}=pixels,w=canvas.width,h=canvas.height,
    dark=(x,y)=>{const i=(y*w+x)*4;return data[i+3]>100&&(data[i]+data[i+1]+data[i+2])/3<180;},marks=[];
  for(const horizontal of [true,false]){
    const outer=horizontal?h:w,inner=horizontal?w:h,minLength=Math.max(40,Math.ceil(inner*.12)),maxThickness=Math.max(2,Math.ceil(Math.max(w,h)*.004)),lines=[];
    for(let at=0;at<outer;at++){const runs=[];let start=-1;for(let n=0;n<=inner;n++){
      if(n<inner&&dark(horizontal?n:at,horizontal?at:n)){if(start<0)start=n;}
      else if(start>=0){if(n-start>=minLength)runs.push({start,end:n});start=-1;}
    }if(runs.length)lines.push({at,runs});}
    for(let i=0;i<lines.length;){let end=i+1;while(end<lines.length&&lines[end].at===lines[end-1].at+1)end++;
      if(lines[end-1].at-lines[i].at+1<=maxThickness)for(const line of lines.slice(i,end))for(const run of line.runs)marks.push({horizontal,at:line.at,...run});i=end;
    }
  }
  const separation=Math.max(2,Math.ceil(Math.max(w,h)*.004)),rules=marks.filter(line=>{
    const intersections=marks.filter(other=>other.horizontal!==line.horizontal&&other.at>=line.start&&other.at<line.end&&line.at>=other.start&&line.at<other.end).map(other=>other.at).sort((a,b)=>a-b);
    return intersections.length>1&&intersections.at(-1)-intersections[0]>separation;
  });
  const margin=Math.max(1,Math.ceil(Math.max(w,h)/2000));
  for(const line of rules)for(let at=Math.max(0,line.at-margin);at<=Math.min((line.horizontal?h:w)-1,line.at+margin);at++)for(let n=Math.max(0,line.start-margin);n<Math.min(line.horizontal?w:h,line.end+margin);n++){const i=((line.horizontal?at:n)*w+(line.horizontal?n:at))*4;data[i]=data[i+1]=data[i+2]=255;data[i+3]=255;}
  ctx.putImageData(pixels,0,0);return rules.length;
}

function darkHeader(canvas){
  const {data}=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height),bands=[];let band=null;
  for(let y=0;y<canvas.height;y++){
    let dark=0;for(let x=0;x<canvas.width;x++){const i=(y*canvas.width+x)*4;if((data[i]+data[i+1]+data[i+2])/3<115)dark++;}
    if(dark/canvas.width>0.45){if(!band)band={top:y,bottom:y};band.bottom=y;}
    else if(band){bands.push(band);band=null;}
  }
  if(band)bands.push(band);
  const merged=[];for(const b of bands){const prior=merged.at(-1);if(prior&&b.top-prior.bottom<=Math.max(2,Math.ceil(canvas.height/200)))prior.bottom=b.bottom;else merged.push({...b});}
  return merged.filter(b=>b.bottom-b.top>=18&&b.bottom-b.top<canvas.height/5);
}
const words=result=>(result.data.blocks||[]).flatMap(b=>b.paragraphs||[]).flatMap(p=>p.lines||[]).flatMap(l=>l.words||[])
  .filter(w=>w.bbox&&String(w.text).trim()&&!/^[|#_=~]+$/.test(w.text));
async function readDarkTable(canvas,worker){
  const {createCanvas}=require('@napi-rs/canvas'),{PSM}=require('tesseract.js');
  const bands=darkHeader(canvas);let wholePageWords=null;
  if(!bands.length){
    // Light tables need the same anchored column reads as dark tables.
    // Discover a real heading from recognized field labels and coordinates.
    await worker.setParameters({tessedit_pageseg_mode:PSM.SPARSE_TEXT});
    const scan=words(await worker.recognize(canvas.toBuffer('image/png'),{}, {blocks:true})),lines=[];wholePageWords=scan;
    for(const word of scan){const mid=(word.bbox.y0+word.bbox.y1)/2,height=word.bbox.y1-word.bbox.y0;let line=lines.find(r=>Math.abs(r.y-mid)<height*.65);if(!line){line={y:mid,words:[]};lines.push(line);}line.words.push(word);}
    for(const line of lines.sort((a,b)=>a.y-b.y)){
      const cells=[];for(const word of line.words.sort((a,b)=>a.bbox.x0-b.bbox.x0)){const previous=cells.at(-1),height=word.bbox.y1-word.bbox.y0;if(previous&&word.bbox.x0-previous.right<height*.65){previous.text+=' '+word.text;previous.right=word.bbox.x1;}else cells.push({text:word.text,right:word.bbox.x1});}
      const found=new Set(cells.flatMap(c=>require('./fields').bestFieldScores(c.text).slice(0,1).map(s=>s.field)));
      if(found.size<3||!found.has('quantity')||!found.has('name')&&!found.has('code'))continue;
      const height=Math.max(...line.words.map(w=>w.bbox.y1-w.bbox.y0));bands.push({top:Math.max(0,Math.min(...line.words.map(w=>w.bbox.y0))-Math.ceil(height*.5)),bottom:Math.min(canvas.height-2,Math.max(...line.words.map(w=>w.bbox.y1))+Math.ceil(height*.5)),light:true});break;
    }
  }
  for(const band of bands){
    const header=createCanvas(canvas.width,band.bottom-band.top+1),ctx=header.getContext('2d');
    ctx.drawImage(canvas,0,band.top,canvas.width,header.height,0,0,header.width,header.height);
    const pixels=ctx.getImageData(0,0,header.width,header.height),data=pixels.data;
    if(!band.light)for(let i=0;i<data.length;i+=4){const v=(data[i]+data[i+1]+data[i+2])/3>160?0:255;data[i]=data[i+1]=data[i+2]=v;}
    ctx.putImageData(pixels,0,0);await worker.setParameters({tessedit_pageseg_mode:PSM.SPARSE_TEXT});
    const labels=words(await worker.recognize(header.toBuffer('image/png'),{}, {blocks:true})).filter(w=>w.confidence>=35).sort((a,b)=>a.bbox.x0-b.bbox.x0),cells=[];
    for(const word of labels){const last=cells.at(-1),height=word.bbox.y1-word.bbox.y0;
      if(last&&word.bbox.x0-last.right<Math.max(6,height*.65)){last.text+=' '+word.text;last.right=word.bbox.x1;}
      else cells.push({x:word.bbox.x0,right:word.bbox.x1,height,text:word.text});}
    cells.splice(0,cells.length,...require('./ocr-headings').merge(cells));
    const found=new Set(cells.flatMap(c=>require('./fields').bestFieldScores(c.text).slice(0,1).map(s=>s.field)));
    if(found.size<3||!found.has('code')&&!found.has('name'))continue;
    const body=createCanvas(canvas.width,canvas.height-band.bottom-1);body.getContext('2d').drawImage(canvas,0,band.bottom+1,canvas.width,body.height,0,0,body.width,body.height);
    const bodyWords=wholePageWords?wholePageWords.filter(w=>w.bbox.y0>band.bottom).map(w=>({...w,bbox:{...w.bbox,y0:w.bbox.y0-band.bottom-1,y1:w.bbox.y1-band.bottom-1}}))
      :words(await worker.recognize(body.toBuffer('image/png'),{}, {blocks:true}));
    const heights=bodyWords.map(w=>w.bbox.y1-w.bbox.y0).sort((a,b)=>a-b),typical=heights[Math.floor(heights.length/2)]||20,rows=[];
    for(const word of bodyWords.sort((a,b)=>(a.bbox.y0+a.bbox.y1)-(b.bbox.y0+b.bbox.y1)||a.bbox.x0-b.bbox.x0)){
      if(word.bbox.y1-word.bbox.y0>typical*2)continue;
      const y=(word.bbox.y0+word.bbox.y1)/2;let row=rows.find(r=>Math.abs(r.y-y)<typical*.7);
      if(!row){row={y,words:[]};rows.push(row);}row.words.push(word);
    }
    const anchors=cells.map(c=>(c.x+c.right)/2);
    const nearest=x=>{let closest=0;for(let i=1;i<anchors.length;i++)if(Math.abs(anchors[i]-x)<Math.abs(anchors[closest]-x))closest=i;return closest;};
    // A dense screenshot can mix pictures and codes in one OCR block. Read an
    // identified code column independently, using its actual glyph bounds,
    // rather than guessing missing identifiers from product names.
    const columnFields=cells.map(c=>require('./fields').bestFieldScores(c.text)[0]?.field),codeColumn=columnFields.indexOf('code');
    const integerFields=new Set(['quantity','reorderPoint','targetStock','safetyStock','leadTimeDays']);
    for(const field of ['code',...integerFields,'unitCost','sellingPrice']){
      const index=columnFields.indexOf(field);if(index<0)continue;
      const observed=bodyWords.filter(w=>nearest((w.bbox.x0+w.bbox.x1)/2)===index);
      {
        const left=Math.max(0,observed.length?Math.min(...observed.map(w=>w.bbox.x0))-5:Math.floor(index?(anchors[index-1]+anchors[index])/2:0)),right=Math.min(body.width,observed.length?Math.max(...observed.map(w=>w.bbox.x1))+5:Math.ceil(index+1<anchors.length?(anchors[index]+anchors[index+1])/2:body.width)),padding=Math.max(12,Math.ceil(typical*.8)),column=createCanvas(right-left+padding*2,body.height),cx=column.getContext('2d');
        cx.fillStyle='#fff';cx.fillRect(0,0,column.width,column.height);cx.drawImage(body,left,0,right-left,body.height,padding,0,right-left,body.height);
        await worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_BLOCK,tessedit_char_whitelist:integerFields.has(field)?'0123456789,.-+':''});
        const reread=words(await worker.recognize(column.toBuffer('image/png'),{}, {blocks:true}));
        for(const row of rows){const aligned=reread.filter(w=>Math.abs((w.bbox.y0+w.bbox.y1)/2-row.y)<typical*.7);
          row.columnEvidence||={};row.columnEvidence[index]=aligned;}
      }
    }
    const grid=rows.sort((a,b)=>a.y-b.y).map(row=>{
      const values=Array(cells.length).fill('');for(const word of row.words.sort((a,b)=>a.bbox.x0-b.bbox.x0)){
        const x=(word.bbox.x0+word.bbox.x1)/2,closest=nearest(x);
        values[closest]+=(values[closest]?' ':'')+word.text;
      }row.originalValues=[...values];for(const [index,evidence] of Object.entries(row.columnEvidence||{}))if(evidence.length)values[index]=evidence.map(w=>w.text).join(' ');return values;});
    for(const field of integerFields){const index=columnFields.indexOf(field);if(index<0)continue;
      for(let i=0;i<grid.length;i++){
        if(!String(grid[i][index]).trim()||/^[-+]?\d+(?:[.,]\d+)?$/.test(grid[i][index]))continue;
        // A narrow column can turn a digit into punctuation. Re-read that
        // actual cell with surrounding whitespace; never infer it from other
        // rows or replace an unreadable/empty source with zero.
        const left=Math.max(0,Math.floor(index?(anchors[index-1]+anchors[index])/2:0)),right=Math.min(body.width,Math.ceil(index+1<anchors.length?(anchors[index]+anchors[index+1])/2:body.width)),top=Math.max(0,Math.floor(rows[i].y-typical*.85)),height=Math.min(body.height-top,Math.ceil(typical*1.7)),cell=createCanvas((right-left)*2,height*2),cx=cell.getContext('2d');
        cx.fillStyle='#fff';cx.fillRect(0,0,cell.width,cell.height);cx.drawImage(body,left,top,right-left,height,0,0,cell.width,cell.height);
        await worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_LINE,tessedit_char_whitelist:'0123456789,.-+'});
        const reading=words(await worker.recognize(cell.toBuffer('image/png'),{}, {blocks:true})).map(w=>w.text).join(' ');
        if(/^[-+]?\d+(?:[.,]\d+)?$/.test(reading))grid[i][index]=reading;
      }
    }
    const numeric=v=>require('./source-money').clean(v).replace(/[$¥,\s]/g,''),valid=v=>/^\d+(?:\.\d+)?$/.test(numeric(v));
    for(const field of ['unitCost','sellingPrice']){
      const index=columnFields.indexOf(field);if(index<0)continue;
      const filled=grid.filter(v=>valid(v[index])),decimalColumn=filled.length>1&&filled.filter(v=>numeric(v[index]).includes('.')).length/filled.length>=.6;
      for(let i=0;i<grid.length;i++){
        const initial=grid[i][index],original=rows[i].originalValues[index];
        if(!(decimalColumn&&valid(initial)&&!numeric(initial).includes('.')||valid(original)&&valid(initial)&&numeric(original)!==numeric(initial)))continue;
        // An isolated high-resolution line provides independent evidence for
        // lost punctuation. Disagreement still requires owner review; never
        // manufacture a decimal from neighboring amounts or a selling price.
        const left=Math.max(0,Math.floor(index?(anchors[index-1]+anchors[index])/2:0)),right=Math.min(body.width,Math.ceil(index+1<anchors.length?(anchors[index]+anchors[index+1])/2:body.width)),top=Math.max(0,Math.floor(rows[i].y-typical*.85)),height=Math.min(body.height-top,Math.ceil(typical*1.7)),cell=createCanvas((right-left)*2,height*2),cx=cell.getContext('2d');
        cx.fillStyle='#fff';cx.fillRect(0,0,cell.width,cell.height);cx.drawImage(body,left,top,right-left,height,0,0,cell.width,cell.height);
        await worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_LINE,tessedit_char_whitelist:'0123456789,.-+$£€¥'});
        const reading=words(await worker.recognize(cell.toBuffer('image/png'),{}, {blocks:true})).map(w=>w.text).join(' ');
        if(valid(reading))grid[i][index]=reading;
        (rows[i].readingProblems||=[]).push({code:'image_money_uncertain',field,readings:[original,initial,reading].filter(Boolean),message:'The image has an uncertain '+(field==='unitCost'?'unit cost':'selling price')+'. Confirm the digits and decimal point against the original before approving.'});
      }
    }
    const table=parser.tabulate([cells.map(c=>c.text),...grid]);
    for(const row of table.rows){const source=rows[row.sourceRow-2],evidence=source?.columnEvidence?.[codeColumn];row.problems=[...(source?.readingProblems||[])];
      if(codeColumn>=0&&(!row.cells[codeColumn]||evidence?.some(w=>w.confidence<60)))row.problems.push({code:'image_identity_uncertain',message:'The image SKU needs confirmation against the original. StockChief will not invent or silently replace it.'});}
    return table;
  }
  return null;
}

function dimensions(buffer){
  if(buffer.length>=24&&buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))
    return {width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)};
  if(buffer.length<4||buffer[0]!==0xff||buffer[1]!==0xd8)return null;
  let at=2;
  while(at+4<buffer.length){
    if(buffer[at++]!==0xff)break;
    while(buffer[at]===0xff)at++;
    const marker=buffer[at++];
    if(marker===0xd9||marker===0xda)break;
    if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
    if(at+2>buffer.length)break;
    const length=buffer.readUInt16BE(at);
    if(length<2||at+length>buffer.length)break;
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
      if(length<7)break;
      return {height:buffer.readUInt16BE(at+3),width:buffer.readUInt16BE(at+5)};
    }
    at+=length;
  }
  return null;
}

async function parse(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length>MAX_IMAGE_BYTES)
    throw new ValidationError('That image is too large for a safe inventory preview. No inventory changed.');
  if(require('./image-codecs').kind(buffer)){
    const decoded=await require('./image-codecs').decode(buffer),{createCanvas,ImageData}=require('@napi-rs/canvas'),sheets=[];
    for(const frame of decoded.frames){
      const source=createCanvas(frame.width,frame.height);source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.pixels),frame.width,frame.height),0,0);
      let image=source;
      if(frame.orientation!==1){image=createCanvas(frame.orientation>=5?frame.height:frame.width,frame.orientation>=5?frame.width:frame.height);const transforms={2:[-1,0,0,1,frame.width,0],3:[-1,0,0,-1,frame.width,frame.height],4:[1,0,0,-1,0,frame.height],5:[0,1,1,0,0,0],6:[0,1,-1,0,frame.height,0],7:[0,-1,-1,0,frame.height,frame.width],8:[0,-1,1,0,0,frame.width]},context=image.getContext('2d');context.setTransform(...transforms[frame.orientation]);context.drawImage(source,0,0);}
      try{const result=await readImage(image,{width:image.width,height:image.height});sheets.push({...result.sheets[0],name:decoded.kind.toUpperCase()+' image '+frame.page});}
      catch(error){if(error instanceof ValidationError)throw new ValidationError('Image page '+frame.page+': '+error.message);throw error;}
    }
    return {sheets,primarySheet:0,format:'image',visualSource:true};
  }
  let size=dimensions(buffer);
  const webp=buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP',gif=/^GIF8[79]a$/.test(buffer.subarray(0,6).toString());
  if(!size&&(webp||gif)){try{const decoded=await require('@napi-rs/canvas').loadImage(buffer);if(decoded.width*decoded.height>MAX_PIXELS)throw new Error('too large');if(gif&&buffer.includes(Buffer.from([0x21,0xff,0x0b])))throw new ValidationError('Animated GIFs may contain several different tables. Export each required frame as PNG before importing.');const converted=require('@napi-rs/canvas').createCanvas(decoded.width,decoded.height);converted.getContext('2d').drawImage(decoded,0,0);buffer=converted.toBuffer('image/png');size=dimensions(buffer);}catch(error){if(error instanceof ValidationError)throw error;throw new ValidationError('This image could not be decoded safely. Export it as PNG or JPEG. No inventory changed.');}}
  if(!size)throw new ValidationError('Choose a readable PNG or JPEG image of an inventory table. No inventory changed.');
  if(Math.min(size.width,size.height)<80||Math.max(size.width,size.height)<200)throw new ValidationError('This image is too small to read reliably. Upload a larger, sharper original or type the rows. No inventory changed.');
  if(!size.width||!size.height||size.width*size.height>MAX_PIXELS)
    throw new ValidationError('That image is too large to read safely. No inventory changed.');
  const {createCanvas,loadImage}=require('@napi-rs/canvas');
  let image;
  try{image=await loadImage(buffer);}catch{
    throw new ValidationError('StockChief could not read that image. No inventory changed.');
  }
  if(image.width!==size.width||image.height!==size.height)
    throw new ValidationError('That image has inconsistent dimensions. No inventory changed.');
  return readImage(image,size);
}

async function readImage(image,size){
  if(Math.min(size.width,size.height)<80||Math.max(size.width,size.height)<200)throw new ValidationError('This image is too small to read reliably. Upload a larger, sharper original or type the rows. No inventory changed.');
  const {createCanvas}=require('@napi-rs/canvas');
  // Small dashboard text needs more pixels for OCR. Bound the working image
  // independently of the original size, and invert uniformly dark heading
  // bands so white-on-colour labels remain readable.
  const scale=Math.max(1,Math.min(3,Math.floor(Math.sqrt(MAX_PIXELS/(size.width*size.height)))));
  const canvas=createCanvas(Math.floor(size.width*scale),Math.floor(size.height*scale));
  const context=canvas.getContext('2d');context.drawImage(image,0,0,canvas.width,canvas.height);
  removeTableRules(canvas);
  const {createWorker}=require('tesseract.js');
  const english=require('@tesseract.js-data/eng');
  const worker=await createWorker(english.code,1,
    {langPath:english.langPath,gzip:english.gzip,cacheMethod:'readOnly'});
  let rows,structured;
  try{structured=await readDarkTable(canvas,worker);if(!structured)rows=tables.withoutSeparatedFooter(await tables.ocrCanvasRows(canvas,worker));}
  finally{await worker.terminate();}
  if(structured?.rows.length)return {sheets:[{name:'Image table',...structured}],primarySheet:0,format:'image'};
  const anchors=tables.anchorColumns(rows);
  if(anchors.length<2)throw new ValidationError('StockChief could not read a product table in that image. No inventory changed.');
  const sheet=parser.tabulate(tables.tabulatePage(rows,anchors));
  if(!sheet.rows.length)throw new ValidationError('StockChief could not read any inventory rows in that image. No inventory changed.');
  return {sheets:[{name:'Image table',...sheet}],primarySheet:0,format:'image'};
}

function isImage(buffer){return Boolean(dimensions(buffer))||Boolean(require('./image-codecs').kind(buffer))||buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP'||/^GIF8[79]a$/.test(buffer.subarray(0,6).toString());}
module.exports={parse,dimensions,isImage,removeTableRules,readStructuredTable:readDarkTable};

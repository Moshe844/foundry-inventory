'use strict';

const parser=require('./parser');
const tables=require('./pdf-table');
const {ValidationError}=require('../domain/errors');

const MAX_IMAGE_BYTES=20*1024*1024;
const MAX_PIXELS=12*1000*1000;

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
  const size=dimensions(buffer);
  if(!size)throw new ValidationError('Choose a readable PNG or JPEG image of an inventory table. No inventory changed.');
  if(!size.width||!size.height||size.width*size.height>MAX_PIXELS)
    throw new ValidationError('That image is too large to read safely. No inventory changed.');
  const {createCanvas,loadImage}=require('@napi-rs/canvas');
  let image;
  try{image=await loadImage(buffer);}catch{
    throw new ValidationError('StockChief could not read that image. No inventory changed.');
  }
  if(image.width!==size.width||image.height!==size.height)
    throw new ValidationError('That image has inconsistent dimensions. No inventory changed.');
  const canvas=createCanvas(size.width,size.height);
  canvas.getContext('2d').drawImage(image,0,0);
  const {createWorker}=require('tesseract.js');
  const english=require('@tesseract.js-data/eng');
  const worker=await createWorker(english.code,1,
    {langPath:english.langPath,gzip:english.gzip,cacheMethod:'readOnly'});
  let rows;
  try{rows=tables.withoutSeparatedFooter(await tables.ocrCanvasRows(canvas,worker));}
  finally{await worker.terminate();}
  const anchors=tables.anchorColumns(rows);
  if(anchors.length<2)throw new ValidationError('StockChief could not read a product table in that image. No inventory changed.');
  const sheet=parser.tabulate(tables.tabulatePage(rows,anchors));
  if(!sheet.rows.length)throw new ValidationError('StockChief could not read any inventory rows in that image. No inventory changed.');
  return {sheets:[{name:'Image table',...sheet}],primarySheet:0,format:'image'};
}

module.exports={parse,dimensions};

'use strict';
// Bounded, embedded source images only. Model input never fetches a supplied URL.
const {ValidationError}=require('../domain/errors');
const {dimensions}=require('../imports/image-table');
const MAX_BYTES=4*1024*1024,MAX_IMAGES=4,MAX_EDGE=2048;
function inspect(prompt){
 if(typeof prompt==='string'||prompt==null)return {text:String(prompt||''),imageTokens:0};
 if(!Array.isArray(prompt)||!prompt.length||prompt.length>MAX_IMAGES+1)throw new ValidationError('Use text and up to four embedded source images.');
 let text='',imageTokens=0,count=0;
 for(const block of prompt){
  if(block?.type==='text'&&typeof block.text==='string'&&Object.keys(block).every(k=>['type','text'].includes(k))){text+=block.text;continue;}
  const s=block?.source;
  if(block?.type!=='image'||Object.keys(block).some(k=>!['type','source'].includes(k))||!s||Object.keys(s).some(k=>!['type','media_type','data'].includes(k))||s.type!=='base64'||!['image/jpeg','image/png'].includes(s.media_type)||typeof s.data!=='string'||s.data.length>Math.ceil(MAX_BYTES/3)*4||!s.data.length||s.data.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(s.data))throw new ValidationError('Use an embedded JPEG or PNG source image. External image addresses are not accepted.');
  const bytes=Buffer.from(s.data,'base64'),d=dimensions(bytes);
  const png=bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
  if(bytes.length>MAX_BYTES||!d||!d.width||!d.height||d.width>MAX_EDGE||d.height>MAX_EDGE||s.media_type!==(png?'image/png':'image/jpeg')||++count>MAX_IMAGES)throw new ValidationError('Prepare a readable image no larger than 2,048 pixels per edge before model reading.');
  // Conservative for both documented Anthropic visual-token schemes: legacy
  // pixels/750 and current 28px patches, plus per-image protocol allowance.
  imageTokens+=Math.ceil(Math.max(d.width*d.height/750,Math.ceil(d.width/28)*Math.ceil(d.height/28)))+2048;
 }
 if(!count||!text.trim())throw new ValidationError('Include the reading instructions and at least one source image.');
 return {text,imageTokens};
}
async function prepare(buffer){
 if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>20*1024*1024)throw new ValidationError('Upload a page photo of up to 20 MB.');
 const png=buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),jpeg=buffer[0]===255&&buffer[1]===216,webp=buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP',gif=/^GIF8[79]a$/.test(buffer.subarray(0,6).toString());
 if(!png&&!jpeg&&!webp&&!gif)throw new ValidationError('Upload a JPEG, PNG, WebP or single-page GIF photo, or a supported PDF/HEIC/TIFF scan.');
 const sharp=require('sharp');let data;
 try{const image=sharp(buffer,{limitInputPixels:12000000,animated:false,failOn:'warning'}),meta=await image.metadata();
  if(!['jpeg','png','webp','gif'].includes(meta.format)||meta.pages&&meta.pages!==1)throw new Error('unsupported');
  data=await image.rotate().resize({width:MAX_EDGE,height:MAX_EDGE,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:95}).toBuffer();
 }catch{throw new ValidationError('That image could not be safely read. Upload a clear single-page JPEG or PNG image.');}
 if(data.length>MAX_BYTES)throw new ValidationError('This image is too large after preparation. Photograph one readable page at a time.');
 return {type:'image',source:{type:'base64',media_type:'image/jpeg',data:data.toString('base64')}};
}
module.exports={inspect,prepare,MAX_BYTES,MAX_IMAGES,MAX_EDGE};

'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const MAX_PAGES=10,MAX_PIXELS=12*1000*1000;
class ImageReadingError extends Error {}
const invalid=message=>{throw new ImageReadingError(message);};
function check(frames){
 if(!frames.length)invalid('No readable image was found in this file.');
 if(frames.length>MAX_PAGES)invalid('This file contains more than 10 image pages. Split it into smaller files.');
 let pixels=0;
 for(const frame of frames){if(!Number.isSafeInteger(frame.width)||!Number.isSafeInteger(frame.height)||frame.width<1||frame.height<1||!Number.isSafeInteger(frame.width*frame.height))invalid('This image has invalid dimensions.');pixels+=frame.width*frame.height;if(pixels>MAX_PIXELS)invalid('The image pages exceed the 12-megapixel reading limit. Upload smaller pages.');}
}
(async()=>{
 const bytes=new Uint8Array(workerData.bytes),frames=[];
 if(bytes.byteLength>20*1024*1024)invalid('This image exceeds the 20 MB reading limit.');
 if(workerData.kind==='heic'){
  const images=await require('heic-decode').all({buffer:bytes});
  try{check(images);for(const [index,image]of images.entries()){const result=await image.decode();if(result.data.byteLength!==result.width*result.height*4)throw Error('The image pixel data is incomplete.');frames.push({width:result.width,height:result.height,orientation:1,page:index+1,pixels:result.data.buffer});}}
  finally{images.dispose();}
 }else if(workerData.kind==='tiff'){
  const tiff=require('utif'),directories=tiff.decode(bytes.buffer),images=directories.map((value,index)=>({value,page:index+1,width:Number(value.t256?.[0]),height:Number(value.t257?.[0])})).filter(frame=>frame.value.t256&&frame.value.t257&&!(Number(frame.value.t254?.[0]||0)&1));
  check(images);
  for(const frame of images){tiff.decodeImage(bytes.buffer,frame.value);const pixels=tiff.toRGBA8(frame.value);if(pixels.byteLength!==frame.width*frame.height*4)throw Error('The image pixel data is incomplete.');const orientation=Number(frame.value.t274?.[0]||1);if(!Number.isSafeInteger(orientation)||orientation<1||orientation>8)throw Error('The image orientation could not be read.');frames.push({width:frame.width,height:frame.height,orientation,page:frame.page,pixels:pixels.buffer});}
 }else throw Error('This image format could not be opened.');
 parentPort.postMessage({frames},frames.map(frame=>frame.pixels));
})().catch(error=>parentPort.postMessage({error:error instanceof ImageReadingError?error.message:'This image could not be decoded safely. Upload a fresh copy or export it as PNG.'}));

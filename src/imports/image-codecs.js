'use strict';
const {Worker}=require('node:worker_threads'),{ValidationError}=require('../domain/errors');
function kind(buffer){
 if(!Buffer.isBuffer(buffer))return null;
 if(buffer.length>=4&&(buffer.subarray(0,4).equals(Buffer.from([0x49,0x49,0x2a,0]))||buffer.subarray(0,4).equals(Buffer.from([0x4d,0x4d,0,0x2a]))))return 'tiff';
 if(buffer.length>=16&&buffer.subarray(4,8).toString()==='ftyp'&&['heic','heix','hevc','hevx','mif1','msf1'].includes(buffer.subarray(8,12).toString()))return 'heic';
 return null;
}
let pending=Promise.resolve(),admitted=0;
async function decode(buffer){
 const format=kind(buffer);if(!format)throw new ValidationError('This HEIC or TIFF file could not be opened. Upload a fresh copy. No inventory changed.');
 if(buffer.length>20*1024*1024)throw new ValidationError('This image exceeds the 20 MB reading limit. No inventory changed.');
 if(admitted>=3)throw new ValidationError('Other image pages are being read. Please try again shortly. No inventory changed.');
 admitted++;const previous=pending;let release;pending=new Promise(resolve=>{release=resolve;});await previous;
 try{
  const bytes=buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength),worker=new Worker(require.resolve('./image-codec-worker'),{workerData:{kind:format,bytes},transferList:[bytes],resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:32,stackSizeMb:4}});
  try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new ValidationError('This image took too long to decode safely. Try smaller, clearer pages. No inventory changed.')),15000);const fail=()=>{clearTimeout(timer);reject(new ValidationError('This image could not be decoded safely. Upload a fresh copy or export it as PNG. No inventory changed.'));};worker.once('error',fail);worker.once('exit',fail);worker.once('message',result=>{clearTimeout(timer);if(result.error)return reject(new ValidationError(result.error+' No inventory changed.'));if(!Array.isArray(result.frames)||!result.frames.length||result.frames.length>10)return fail();let total=0;for(const frame of result.frames){const pixels=frame.width*frame.height;total+=pixels;if(!Number.isSafeInteger(frame.width)||!Number.isSafeInteger(frame.height)||frame.width<1||frame.height<1||!Number.isSafeInteger(total)||total>12000000||!(frame.pixels instanceof ArrayBuffer)||frame.pixels.byteLength!==pixels*4||!Number.isInteger(frame.orientation)||frame.orientation<1||frame.orientation>8)return fail();}resolve({kind:format,frames:result.frames});});});}
  finally{await worker.terminate();}
 }finally{admitted--;release();}
}
module.exports={kind,decode};

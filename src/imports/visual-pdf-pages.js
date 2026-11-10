'use strict';
const {fork}=require('node:child_process'),path=require('node:path'),{ValidationError}=require('../domain/errors');
function read(buffer){return new Promise((resolve,reject)=>{
 const env={};for(const key of ['PATH','SystemRoot','TEMP','TMP','LANG'])if(process.env[key])env[key]=process.env[key];
 const child=fork(path.join(__dirname,'visual-pdf-child.js'),[],{env,execArgv:['--max-old-space-size=240'],windowsHide:true,serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']});let settled=false;
 const finish=(error,pages)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();error?reject(new ValidationError(error)):resolve(pages);},timer=setTimeout(()=>finish('This complete PDF could not be safely rendered within three minutes. Split its pages or use smaller scans.'),180000);
 child.once('error',()=>finish('The PDF reader is unavailable. Your original is retained.'));child.once('exit',()=>finish('The PDF reader stopped before completing the source. Your original is retained.'));
 child.once('message',result=>{const pages=result?.pages;if(Array.isArray(pages)&&pages.length&&pages.length<=30&&pages.every((p,i)=>p.page===i+1&&p.total===pages.length&&p.block?.type==='image'&&p.block.source?.type==='base64'&&typeof p.block.source.data==='string'))finish(null,pages);else finish(result?.error||'This complete PDF could not be safely read.');});
 child.send({buffer},error=>{if(error)finish('The PDF could not be handed to the isolated reader.');});
});}
module.exports={read};

'use strict';
const {fork}=require('node:child_process'),path=require('node:path'),{ValidationError}=require('../domain/errors');
function read(file){return new Promise((resolve,reject)=>{
 const env={};for(const key of ['PATH','SystemRoot','TEMP','TMP','LANG'])if(process.env[key])env[key]=process.env[key];
 const child=fork(path.join(__dirname,'document-reader-child.js'),[],{env,execArgv:['--max-old-space-size=160'],serialization:'advanced',windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});let settled=false;
 const finish=(error,text)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();if(error)reject(error);else resolve(text);};
 const timer=setTimeout(()=>finish(new ValidationError('This document exceeded the safe reading time. Review a smaller document or the original.')),45000);
 child.once('error',()=>finish(new ValidationError('The document reader is unavailable. The original remains saved.')));child.once('exit',()=>finish(new ValidationError('The document reader stopped before completing the attachment. The original needs review.')));
 child.once('message',result=>{if(typeof result?.text==='string'&&result.text.length<=120000)finish(null,result.text);else finish(new ValidationError(typeof result?.error==='string'?result.error:'The document needs review.'));});child.send({filename:file.filename,buffer:file.buffer},error=>{if(error)finish(new ValidationError('The document could not be handed to the bounded reader.'));});
 });}
module.exports={read};

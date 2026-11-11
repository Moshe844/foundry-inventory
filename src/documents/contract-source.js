'use strict';
const {fork}=require('node:child_process'),path=require('node:path'),{ValidationError}=require('../domain/errors');
function read(file){return new Promise((resolve,reject)=>{
 const env={};for(const key of ['PATH','SystemRoot','TEMP','TMP','LANG'])if(process.env[key])env[key]=process.env[key];
 const child=fork(path.join(__dirname,'contract-reader-child.js'),[],{env,execArgv:['--max-old-space-size=240'],serialization:'advanced',windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});let settled=false;
 const finish=(error,pages)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();error?reject(error):resolve(pages);};
 const timer=setTimeout(()=>finish(new ValidationError('This contract could not be completely read within three minutes. Original retained. Split its complete sections or use a clearer source.')),180000);
 child.once('error',()=>finish(new ValidationError('The contract reader is unavailable. Your original is retained.')));child.once('exit',()=>finish(new ValidationError('The contract reader stopped before completing the source. Original retained.')));
 child.once('message',result=>{if(Array.isArray(result?.pages)&&result.pages.length&&result.pages.length<=100&&result.pages.every(p=>Number.isSafeInteger(p.page)&&typeof p.text==='string'&&(p.invoiceText===undefined||typeof p.invoiceText==='string')&&(p.ocrWords===undefined||Array.isArray(p.ocrWords)&&p.ocrWords.length<=200000&&p.ocrWords.every(w=>typeof w.text==='string'&&w.text.length<=10000&&['x0','y0','x1','y1'].every(k=>Number.isFinite(w[k])&&w[k]>=0&&w[k]<=10000))))&&result.pages.every(p=>['nativeWords','rasterRegions'].every(key=>p[key]===undefined||Array.isArray(p[key])&&p[key].length<=200000&&p[key].every(w=>['x0','y0','x1','y1'].every(k=>Number.isFinite(w[k]))&&(key!=='nativeWords'||typeof w.text==='string'))))&&result.pages.reduce((n,p)=>n+(p.ocrWords?.length||0),0)<=200000&&result.pages.reduce((n,p)=>n+(p.invoiceText?.length||0),0)<=2000000&&result.pages.reduce((n,p)=>n+p.text.length,0)<=2000000)finish(null,result.pages);else finish(new ValidationError(result?.error||'This contract could not be read completely. Original retained.'));});
 child.send({filename:file.filename,buffer:file.buffer,invoiceLayout:file.invoiceLayout===true,filingOriginal:file.filingOriginal===true},error=>{if(error)finish(new ValidationError('The original could not be handed to the bounded reader.'));});
 });}
function* chunks(pages){
 let sections=[],length=0;
 const part=()=>({sections,text:sections.map(s=>'[Original page / section '+s.page+', character '+s.start+']\n'+(s.sourceName?'[Source part: '+s.sourceName+']\n':'')+s.text).join('\n\n')});
 for(const page of pages){if(!page.text.trim())continue;for(let start=0;start<page.text.length;){let end=Math.min(start+6000,page.text.length);if(end<page.text.length){const newline=page.text.lastIndexOf('\n',end);if(newline>start+4000)end=newline;}const next={page:page.page,sourceName:page.sourceName||'',start,text:page.text.slice(start,end)};if(length+next.text.length>6000&&sections.length){yield part();sections=[];length=0;}sections.push(next);length+=next.text.length;if(end===page.text.length)break;start=Math.max(start+1,end-512);}}
 if(sections.length)yield part();
}
module.exports={read,chunks};

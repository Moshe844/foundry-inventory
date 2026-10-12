'use strict';
// Durable evidence is authoritative for what was OBSERVED, never for business
// truth or permission. Context/history are disposable views of this journal.
const {createHash}=require('node:crypto');
const bytes=v=>Buffer.byteLength(JSON.stringify(v));
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function screen(value){return value?.screen||value;}
// JSONB object order is not observation order. Rebuild chronology explicitly
// after every database/process boundary; same-millisecond IDs break ties.
function ordered(entries){return entries.map((value,index)=>({value,index})).sort((a,b)=>{
 const time=v=>Date.parse(v.observedAt||v.at)||0,seq=v=>Number((v.id||v.evidenceId||'').split(':').at(-1))||0;
 return time(a.value)-time(b.value)||seq(a.value)-seq(b.value)||a.index-b.index;
}).map(e=>e.value);}
function control(c,{historical=false}={}){
 const out={};
 for(const [key,value]of Object.entries(c)){
  if(value===null||value===undefined||value===''||value===false&&key!=='checked')continue;
  if(historical&&['ref','optionsNextRef'].includes(key))continue;
  out[key]=value;
 }
 return out;
}
function store(h,{id,name,result,at=new Date().toISOString()}){
 const value=result,text=JSON.stringify(value)??'null';
 h.evidence||={};
 if(h.evidence[id]&&h.evidence[id].text!==text)throw new Error('EVIDENCE_ID_CONFLICT');
 // The existing 8 MiB session limit remains enforced transactionally. Never
 // claim durable storage while silently discarding a payload's tail.
 h.evidence[id]={id,name,at,text,truncated:false,sha256:hash(value)};
 return h.evidence[id];
}
function index(h){const entries=Object.values(h.evidence||{});
 return (h.candidate==='codex'?ordered(entries).reverse():entries).map(e=>{
 let value,raw;try{raw=JSON.parse(e.text);value=screen(raw);}catch{}
 return {id:e.id,tool:e.name,at:e.at,sha256:e.sha256||null,sourceTruncated:Boolean(e.truncated),
  ...(raw?.image?{hasImage:true}:{}),
  ...(e.name==='environment_browser'?{url:value?.url,title:value?.title,
   fields:value?.controls?.filter(c=>c.form&&['input','select','textarea'].includes(c.tag)).map(c=>({label:c.label,name:c.name,type:c.type||c.tag}))}: {})};
});}
function retrieve(h,{id,offset=0}){
 const page=require('./evidence').page;
 if(id==='@index')return page({observations:index(h)},id,offset);
 const e=h.evidence?.[id];if(!e)throw new Error('EVIDENCE_NOT_FOUND');
 if(!Number.isSafeInteger(offset)||offset<0)throw new Error('INVALID_EVIDENCE_OFFSET');
 try{const value=JSON.parse(e.text);
  if(value?.image&&offset===0)return {image:value.image,screen:{...value.screen,evidenceId:id,observedAt:e.at,historical:true,untrusted:true,
   sourceTruncated:Boolean(e.truncated),sha256:e.sha256||null,notice:'Historical screenshot and screen. Old control references are not live handles.'}};
  return {...page(value?.image?value.screen:value,id,offset,e.at),sourceTruncated:Boolean(e.truncated),sha256:e.sha256||null};}
 catch(error){if(!e.truncated)throw error;
  // Backward compatibility cannot recreate bytes already discarded by an old
  // version. Disclose that loss explicitly; new observations never truncate.
  return {id,at:e.at,historical:true,untrusted:true,offsetUnit:'character',text:e.text.slice(offset,offset+5000),
   nextOffset:offset+5000<e.text.length?offset+5000:null,sourceTruncated:true};
 }
}
function browserMemory(h,limit=4000){
 const pages=new Map();let order=0;
 for(const e of ordered(Object.values(h.evidence||{}))){
  if(e.name!=='environment_browser')continue;
  let s;try{s=screen(JSON.parse(e.text));}catch{continue;}
  if(!s?.url)continue;
  const key=s.url+(s.partial?':partial:'+s.controls?.map(c=>c.name||c.label).join('|'):''),fields=(s.controls||[])
   .filter(c=>c.form&&['input','select','textarea'].includes(c.tag)&&c.type!=='hidden');
  pages.set(key,{e,s,order:order++,fields});
 }
 // Retain discovered form contracts before repetitive navigation chrome. This
 // is based solely on DOM semantics, never known routes, names or task text.
 const current=h.native?.browserUrl||h.screen?.data?.url;
 const entries=[...pages.values()].sort((a,b)=>b.fields.length-a.fields.length||
  Number(b.s.url===current)-Number(a.s.url===current)||Number(a.s.partial)-Number(b.s.partial)||b.order-a.order);
 const result={historical:true,untrusted:true,actionHandlesValid:false,index:{id:'@index',offset:0},pages:[],omittedPages:0};
 for(const {e,s,fields}of entries){
  const item={evidenceId:e.id,url:s.url,title:s.title,observedAt:e.at,version:e.sha256||hash(s),
   sourceTruncated:Boolean(e.truncated),text:s.text,fields:fields.map(c=>control(c,{historical:true})),
   partial:Boolean(s.partial||s.truncated),pagination:s.pagination};
  const itemLimit=Math.min(2400,limit-bytes(result)-8);
  if(bytes(item)>itemLimit){item.text=s.text?.slice(0,1200);item.fields=[];item.summaryPartial=true;
   for(const c of fields){const field=control(c,{historical:true});
    if(bytes({...item,fields:[...item.fields,field]})>itemLimit)break;item.fields.push(field);}
   item.omittedFields=fields.length-item.fields.length;
  }
  if(bytes({...result,pages:[...result.pages,item]})<=limit)result.pages.push(item);
  else result.omittedPages++;
 }
 return result;
}
module.exports={store,retrieve,index,browserMemory,control,ordered};

'use strict';
// Link destinations can carry a browser session's credentials. The private
// DOM handle remains usable; those bytes never become model-visible facts or
// transferable chat links. This does not authorize navigation or an operation.
function credentialKey(value){
 let key=String(value);try{for(let n=0;n<8;n++){const next=decodeURIComponent(key);if(next===key)break;key=next;}}catch{return true;}
 return /csrf|token|secret|ticket|password|authorization|session|nonce|^state$|^codeverifier$|^codechallenge$|^apikey$/.test(key.replace(/[^a-z0-9]/gi,'').toLowerCase());
}
function transferable(value){
 if(typeof value!=='string')return true;
 let url;try{url=new URL(value,'https://stockchief.invalid');}catch{return false;}
 if(!['http:','https:','mailto:','tel:'].includes(url.protocol)||url.username||url.password)return false;
 return ![...url.searchParams.keys(),...new URLSearchParams(url.hash.slice(1)).keys()].some(credentialKey);
}
function control(value){
 const out={...value};
 if(typeof out.href==='string'&&!transferable(out.href)){out.href=null;out.sessionBoundDestination=true;}
 if(out.form&&typeof out.form.action==='string'&&!transferable(out.form.action))out.form={...out.form,action:null,sessionBoundDestination:true};
 return out;
}
module.exports={control,transferable};

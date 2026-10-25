'use strict';
const fields=require('./fields'),roles=require('./document-rows');
const rtl=/[\u0590-\u05ff\u0600-\u06ff]/u;
const signature=text=>[...String(text).normalize('NFKC').replace(/\s/g,'')].sort().join('');
function score(items){return items.reduce((n,i)=>n+(rtl.test(i.text)?(roles.labelKind(i.text)?4:0)+(fields.bestFieldScores(i.text).length?2:0):0),0);}
async function reconcile(page,OPS,items){
 if(!items.some(i=>rtl.test(i.text)))return {items,sourceOrder:false};
 const list=await page.getOperatorList(),sources=new Map();
 for(let n=0;n<list.fnArray.length;n++)if(list.fnArray[n]===OPS.showText){const text=(list.argsArray[n]?.[0]||[]).filter(g=>g&&typeof g==='object').map(g=>g.unicode||'').join('');if(!rtl.test(text))continue;const key=signature(text),values=sources.get(key)||new Set();values.add(text);sources.set(key,values);}
 const candidates=items.map(item=>{const choices=sources.get(signature(item.text));return rtl.test(item.text)&&choices?.size===1?{...item,text:[...choices][0]}:item;}),sourceScore=score(candidates),displayScore=score(items);
 // Some PDF generators put logical Unicode in their glyph stream while
 // others put visual glyph order there. Never reverse every RTL word. Select
 // a representation only on independent shared header/document-role evidence.
 return sourceScore>displayScore?{items:candidates,sourceOrder:true,sourceScore,displayScore}:{items,sourceOrder:false,sourceScore,displayScore};
}
module.exports={reconcile,signature};

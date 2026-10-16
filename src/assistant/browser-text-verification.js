'use strict';
const {createHash}=require('node:crypto');
// Observation-local line pointers cannot be reused as cross-reload identity.
// Rebase only within an entire, unique, byte-equivalent visible semantic region
// produced by the HOST browser. Never search for an isolated claimed word or
// number, infer a changed value, alter the journal or update live tool handles.
function unchangedLine(previous,current,pointer){
 const match=/^(\/screen)?\/textBlocks\/line(0|[1-9]\d*)$/.exec(pointer);
 if(!match)return {matched:false};
 const old=match[1]?previous.screen:previous,fresh=match[1]?current.screen:current,index=Number(match[2]);
 if(!old?.textBlocks||!fresh?.textBlocks||!Array.isArray(fresh.textRegions))return {matched:false};
 function lines(blocks){const keys=Object.keys(blocks);if(keys.length>9000||keys.some(key=>!/^line(0|[1-9]\d*)$/.test(key)))return null;
  keys.sort((a,b)=>Number(a.slice(4))-Number(b.slice(4)));
  return keys.every((key,i)=>key==='line'+i&&typeof blocks[key]==='string')?keys.map(key=>blocks[key]):null;}
 const before=lines(old.textBlocks),after=lines(fresh.textBlocks);if(!before||!after||index>=before.length)return {matched:false};
 function uniqueStart(haystack,needle){let found=-1;
  for(let start=0;start+needle.length<=haystack.length;start++)if(needle.every((line,i)=>line===haystack[start+i])){
   if(found!==-1)return -1;found=start;
  }return found;
 }
 const matches=new Set();
 for(const region of fresh.textRegions){
  if(!['main','form','table','tr','section','article','fieldset','details','dialog'].includes(region.tag)&&!['main','region','row','group','dialog'].includes(region.role)&&region.kind!=='heading_container'||
   !Number.isSafeInteger(region.firstLine)||!Number.isSafeInteger(region.count)||region.firstLine<0||region.count<2||region.firstLine+region.count>after.length)continue;
  const content=after.slice(region.firstLine,region.firstLine+region.count);
  if(createHash('sha256').update(JSON.stringify(content)).digest('hex')!==region.sha256||uniqueStart(after,content)!==region.firstLine)continue;
  const start=uniqueStart(before,content);
  if(start>=0&&index>=start&&index<start+content.length)matches.add(region.firstLine+index-start);
 }
 if(matches.size!==1)return {matched:false};
 const currentIndex=[...matches][0];return {matched:true,value:after[currentIndex],currentPointer:(match[1]||'')+'/textBlocks/line'+currentIndex};
}
module.exports={unchangedLine};

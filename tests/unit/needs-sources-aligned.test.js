'use strict';
// Needs you gathers its sources with one Promise.all and names the results by
// position. A source added without its name shifts every later result and
// silently drops the last source, so the two lists must stay the same length,
// and every named source must reach the combined list.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');

function topLevelItems(text,start){
  const items=[];let depth=1,cur='',quote=null;
  for(let i=start;i<text.length;i++){const ch=text[i];
    if(quote){cur+=ch;if(ch==='\\'){cur+=text[++i];continue;}if(ch===quote)quote=null;continue;}
    if(ch==="'"||ch==='"'||ch==='`'){quote=ch;cur+=ch;continue;}
    if('([{'.includes(ch))depth++;
    if(')]}'.includes(ch)){depth--;if(depth===0)break;}
    if(ch===','&&depth===1){items.push(cur.trim());cur='';continue;}
    cur+=ch;}
  if(cur.trim())items.push(cur.trim());return items;
}

test('every Needs you source has its own name and reaches the list',()=>{
  const text=fs.readFileSync(path.join(__dirname,'../../src/projections/postgres-service.js'),'utf8');
  const open=']=await Promise.all([',eq=text.indexOf(open,text.indexOf('const [items,notices,'));
  assert(eq>0,'the Needs you source list was not found');
  const start=text.lastIndexOf('const [',eq),names=text.slice(start+7,eq).split(',').map(s=>s.trim());
  const sources=topLevelItems(text,eq+open.length);
  assert.equal(names.length,sources.length,`Needs you names ${names.length} results for ${sources.length} sources`);
  const tail=text.slice(text.indexOf('.concat(deputyTasks',eq)),combined=tail.slice('.concat('.length,tail.indexOf(')')).split(',').map(s=>s.trim());
  assert.deepEqual(names.slice(4).filter(n=>!combined.includes(n)),[],'every named source must reach the combined list');
});

'use strict';
const {createHash}=require('node:crypto');
// Only original, complete host tool results can seed the browser's observed
// paths after a restart. Notebook/model text is never a trusted link source.
function restoreReadLinks(browser,evidence){
 for(const entry of Object.values(evidence||{})){
  if(entry?.truncated||typeof entry?.text!=='string'||createHash('sha256').update(entry.text).digest('hex')!==entry.sha256)continue;
  if(!['business_operations','environment_dataset'].includes(entry.name))continue;
  let result;try{result=JSON.parse(entry.text);}catch{continue;}
  if(entry.name==='business_operations'){
   if(Array.isArray(result?.outcomes))browser.observeReadLinks?.(result.outcomes.filter(o=>o&&typeof o==='object'));
  }
  else browser.observeDatasetLinks?.(result);
 }
}
function paths(evidence){
 const known=new Set(),add=value=>{const path=require('../../src/assistant/agent-navigation-path').localPath(value);
  if(path&&require('./browser-link-evidence').transferable(value))known.add(path);};
 const sink={observeDatasetLinks(result){add(result?.handoff?.href);for(const row of Array.isArray(result?.rows)?result.rows:[])add(row?.href);},
  observeReadLinks(outcomes){for(const outcome of outcomes){if(outcome.result?.status!=='ANSWERED')continue;
   const kind=require('../../src/assistant/postgres-capability-registry').registry.get(outcome.capability)?.kind;
   if(kind==='read')sink.observeDatasetLinks(outcome.result);if(kind==='navigation')add(outcome.result.navigation?.href);
  }}};
 restoreReadLinks(sink,evidence);return [...known];
}
function initialPath(action,{evidence,observedPaths=[],interfacePaths=[],resumedPath=null,fallback=null}={}){
 const opened=action?.action==='open'?require('../../src/assistant/agent-navigation-path').localPath(action.value):null;
 return opened&&[...observedPaths,...interfacePaths,...paths(evidence)].includes(opened)?opened:resumedPath||fallback||observedPaths[0]||'/';
}
module.exports={restoreReadLinks,paths,initialPath};

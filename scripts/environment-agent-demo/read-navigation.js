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
module.exports={restoreReadLinks};

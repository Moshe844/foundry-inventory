'use strict';
const {FIELDS}=require('../../src/assistant/postgres-capability-registry');
function words(value){return String(value||'').replace(/\b[a-z][a-zA-Z]*\b/g,word=>word.replace(/([a-z])([A-Z])/g,'$1 $2')).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
 .map(word=>word.length>4&&word.endsWith('ies')?word.slice(0,-3)+'y':word.length>3&&word.endsWith('s')&&!word.endsWith('ss')?word.slice(0,-1):word);}
function matches(candidate,query){
 const terms=words(query);if(!terms.length)return true;
 const fields=Array.isArray(candidate.fields)?Object.fromEntries(candidate.fields.map(name=>[name,{...FIELDS[name],
  ...(candidate.argumentSchemas?.[name]?{jsonSchema:candidate.argumentSchemas[name]()}:{})}])):candidate.fields||{};
 // Index the actual authorized contract, including generated schemas. No
 // phrase/route aliases or additional inference. Whole tokens prevent "test"
 // matching "latest" and "stock" matching the product name "StockChief".
 const available=new Set(words(JSON.stringify({name:candidate.name,description:candidate.description||candidate.label,fields})));
 return terms.every(term=>available.has(term));
}
module.exports={matches};

'use strict';
const {FIELDS}=require('../../src/assistant/postgres-capability-registry');
function words(value){return String(value||'').replace(/\b[a-z][a-zA-Z]*\b/g,word=>word.replace(/([a-z])([A-Z])/g,'$1 $2')).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
 .map(word=>word.length>4&&word.endsWith('ies')?word.slice(0,-3)+'y':word.length>3&&word.endsWith('s')&&!word.endsWith('ss')?word.slice(0,-1):word);}
function matchTerms(candidate,query){
 const terms=[...new Set(words(query))];
 const fields=Array.isArray(candidate.fields)?Object.fromEntries(candidate.fields.map(name=>[name,{...FIELDS[name],
  ...(candidate.argumentSchemas?.[name]?{jsonSchema:candidate.argumentSchemas[name]()}:{})}])):candidate.fields||{};
 // Index the actual authorized contract, including generated schemas. No
 // phrase/route aliases or additional inference. Whole tokens prevent "test"
 // matching "latest" and "stock" matching the product name "StockChief".
 const available=new Set(words(JSON.stringify({name:candidate.name,description:candidate.description||candidate.label,fields})));
 const title=new Set(words(candidate.name)),description=new Set(words(candidate.description||candidate.label));
 return {terms,matched:terms.filter(term=>available.has(term)),
  directScore:terms.reduce((n,term)=>n+(title.has(term)?8:0)+(description.has(term)?4:0),0)};
}
function matches(candidate,query){const {terms,matched}=matchTerms(candidate,query);return terms.length===matched.length;}
function ranked(candidates,query){
 const scored=candidates.map(candidate=>({candidate,...matchTerms(candidate,query)}));
 const exact=scored.filter(entry=>entry.terms.length===entry.matched.length);
 // Transparent lexical fallback, not an intent/phrase map. Related words in
 // one search must not hide every contract when no contract contains them all.
 const selected=exact.length?exact:scored.filter(entry=>entry.matched.length);
 // Actual names/descriptions carry more relevance than generic argument text.
 // Otherwise registry order makes broad mutation contracts hide the matching
 // read interface behind pagination. Keep every authorized match discoverable.
 selected.sort((a,b)=>b.matched.length-a.matched.length||b.directScore-a.directScore||
  Number(b.candidate.kind==='read')-Number(a.candidate.kind==='read')||a.candidate.name.localeCompare(b.candidate.name));
 return {items:selected.map(entry=>entry.candidate),matchMode:exact.length?'all_terms':'related_terms'};
}
module.exports={matches,ranked};

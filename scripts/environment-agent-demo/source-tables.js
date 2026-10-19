'use strict';
// Host-owned presentation of already authorized canonical record tables.
// No SQL, joins, expressions, model-supplied cell values or business writes.
const {createHash}=require('node:crypto'),{locate}=require('./evidence-presentation');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0,24);
function catalogue(entry){
 if(!['environment_dataset','business_operations'].includes(entry?.name))return [];
 if(!entry||entry.truncated||typeof entry.text!=='string'||createHash('sha256').update(entry.text).digest('hex')!==entry.sha256)throw Error('TABLE_SOURCE_INVALID');
 const original=JSON.parse(entry.text),tables=[];
 function add(result,path){
  if(!result||!Array.isArray(result.columns)||!result.columns.length||result.columns.length>100||
    !result.columns.every(c=>typeof c==='string')||new Set(result.columns).size!==result.columns.length||!Array.isArray(result.rows)||result.rows.length>100)return;
  const display=Array.isArray(result.displayRows)&&result.displayRows.length===result.rows.length;
  const key=display?'displayRows':'rows',rows=result[key],columns=result.columns.filter(c=>rows.every(r=>r&&typeof r==='object'&&!Array.isArray(r)&&Object.hasOwn(r,c)&&(r[c]===null||['string','number','boolean'].includes(typeof r[c]))));
  if(!columns.length)return;
  const pointer=path+'/'+key;
  tables.push({sourceRef:'tb1:'+digest([entry.id,entry.sha256,pointer]),evidenceId:entry.id,path:pointer,columns,
   labels:Object.fromEntries(columns.map(c=>[c,result.columnLabels?.[c]||c])),rows:rows.length,
   extent:result.extent||{returnedRows:rows.length,totalRows:null,complete:false}});
 }
 if(entry.name==='environment_dataset')add(original,'');
 if(entry.name==='business_operations'&&Array.isArray(original?.outcomes))original.outcomes.forEach((o,i)=>add(o?.result,'/outcomes/'+i+'/result'));
 return tables;
}
const escape=value=>String(value).replace(/[\\`*_[\]{}()#+.!|~-]/g,'\\$&').replace(/\r\n?|\n/g,' ');
function materialize(goal,report){
 const claims=[],entries=Object.values(goal.checkpoint?.harness?.evidence||{}),cache=new Map();
 const products=(report.workProducts||[]).map(product=>{
  if(!product.sourceTable)return product;
  const spec=product.sourceTable;let selected=null,entry,invalidSource=false;
  for(const candidate of entries){
   if(!cache.has(candidate.id))try{cache.set(candidate.id,catalogue(candidate));}catch{cache.set(candidate.id,null);}
   if(cache.get(candidate.id)===null){invalidSource=true;continue;}
   const found=cache.get(candidate.id).find(t=>t.sourceRef===spec.sourceRef);if(!found)continue;
   if(selected)throw Error('TABLE_SOURCE_COLLISION');selected=found;entry=candidate;
  }
  if(!selected)throw Error(invalidSource?'TABLE_SOURCE_INVALID':'TABLE_SOURCE_NOT_FOUND');
  if(!Array.isArray(spec.columns)||!spec.columns.length||spec.columns.length>20||new Set(spec.columns).size!==spec.columns.length||spec.columns.some(c=>!selected.columns.includes(c)))throw Error('TABLE_COLUMNS_INVALID');
  const original=JSON.parse(entry.text),rows=locate(original,selected.path).value,indices=spec.rows===null?rows.map((_,i)=>i):spec.rows;
  if(!Array.isArray(indices)||indices.length>100||new Set(indices).size!==indices.length||indices.some(i=>!Number.isSafeInteger(i)||i<0||i>=rows.length))throw Error('TABLE_SELECTION_INVALID');
  const lines=['| '+spec.columns.map(c=>escape(String(selected.labels[c]).replaceAll('_',' ').replace(/([a-z])([A-Z])/g,'$1 $2'))).join(' | ')+' |','| '+spec.columns.map(()=> '---').join(' | ')+' |',
   ...indices.map(i=>'| '+spec.columns.map(c=>escape(rows[i][c]===null?'Not recorded':rows[i][c]===''?'—':rows[i][c])).join(' | ')+' |')];
  const content=lines.join('\n');if(content.length>12000)throw Error('TABLE_DELIVERY_TOO_LARGE');
  // Seal the entire original sequence. A changed row, added record or reordered
  // source must pass the unchanged fresh-source verifier, not a copied label.
  claims.push({evidenceId:entry.id,path:selected.path,value:rows,historical:false});
  if(selected.path.endsWith('/displayRows')){const rawPath=selected.path.slice(0,-'displayRows'.length)+'rows';claims.push({evidenceId:entry.id,path:rawPath,value:locate(original,rawPath).value,historical:false});}
  return{title:product.title,content};
 });
 return{report:{...report,workProducts:products},claims};
}
module.exports={catalogue,materialize};

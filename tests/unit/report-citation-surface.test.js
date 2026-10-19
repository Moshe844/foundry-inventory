'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const refs=require('../../scripts/environment-agent-demo/source-references'),presentation=require('../../scripts/environment-agent-demo/evidence-presentation'),journal=require('../../scripts/environment-agent-demo/observations');
const evidence=(value,name='environment_dataset')=>{const text=JSON.stringify(value);return{id:'report:1',name,text,sha256:createHash('sha256').update(text).digest('hex')};};
function report(){return{config:{dataset:'unknown_report'},columns:['entry','amount','currency','ratio','optional'],provenance:{source:'PostgreSQL',dataset:'unknown_report'},rows:[{entry:2,amount:'7500',currency:'USD',ratio:'45.1',optional:null,unknown:'preserved'},{entry:5,amount:'7500',currency:'CAD',ratio:'45.1',optional:0}],displayRows:[{entry:2,amount:'$75.00',currency:'USD',ratio:'45.10%',optional:null},{entry:5,amount:'CA$75.00',currency:'CAD',ratio:'45.10%',optional:0}],extent:{rowKind:'groups',complete:true,returnedRows:2,totalRows:2}};}
test('formatted report cells have one offered reference while raw calculation data stays lossless',()=>{
 const original=report(),entry=evidence(original),view=refs.present(entry,presentation.project(entry.name,original)),key=view._stockchiefSources.valueField;
 for(let i=0;i<2;i++)for(const column of original.columns){assert.equal(view.rows[i][key]?.[column],undefined);assert(view.displayRows[i][key][column]);assert.equal(refs.resolve([entry],{sourceRef:view.displayRows[i][key][column],value:view.displayRows[i][column]}).path,'/displayRows/'+i+'/'+column);assert.deepEqual(view.rows[i][column],original.rows[i][column]);}
 assert(view.rows[0][key].unknown);assert.equal(view.rows[0].unknown,'preserved');assert.equal(entry.text,JSON.stringify(original));
 const legacy=refs.present(entry,original,{indexRepresentation:true});
 const wrong={sourceRef:legacy.rows[1][key].amount,value:'$75.00'},binding=refs.resolve([entry],wrong);
 assert.equal(binding.path,'/rows/1/amount');assert.equal(presentation.locate(original,binding.path).value,'7500');assert.notDeepEqual(binding.value,presentation.locate(original,binding.path).value,'Recorded raw-ref/display-value mistake must still fail exact verification');
});
test('durable retrieval after restart issues the same formatted bindings as initial delivery',()=>{
 const h={candidate:'codex',evidence:{}},original=report(),entry=journal.store(h,{id:'durable:1',name:'environment_dataset',result:original}),first=refs.present(entry,presentation.project(entry.name,original)),key=first._stockchiefSources.valueField,restarted=JSON.parse(JSON.stringify(h));
 const records=[];let offset=0;do{const page=journal.retrieve(restarted,{id:entry.id,offset});records.push(...page.records);offset=page.nextOffset;}while(offset!==null);
 const at=pointer=>{const record=records.find(r=>r.path===pointer||pointer.startsWith(r.path+'/'));assert(record);return record.path===pointer?record.value:presentation.locate(record.value,pointer.slice(record.path.length)).value;};
 for(let i=0;i<2;i++){const displayed=at('/displayRows/'+i),raw=at('/rows/'+i);assert.deepEqual(displayed[key],first.displayRows[i][key]);assert.equal(raw[key]?.amount,undefined);}
 assert.equal(restarted.evidence[entry.id].text,JSON.stringify(original));
});
test('only canonical report envelopes are preferred; unknown nested customer data and unaligned views stay citable',()=>{
 for(const [value,name,path]of [[{outcomes:[{result:report()}]},'business_operations','/outcomes/0/result'],[{notes:report()},'environment_dataset','/notes'],[{...report(),provenance:{source:'customer'}},'environment_dataset',''],[{...report(),displayRows:[]},'environment_dataset','']]){
  const entry=evidence(value,name),view=refs.present(entry,value),key=view._stockchiefSources.valueField,at=path?presentation.locate(view,path).value:view;
  if(name==='business_operations')assert.equal(at.rows[0][key]?.amount,undefined);else assert(at.rows[0][key].amount);
 }
 const original=report();delete original.displayRows[1].optional;const entry=evidence(original),view=refs.present(entry,original),key=view._stockchiefSources.valueField;assert(view.rows[1][key].optional,'Raw-only fields must remain citable');
});

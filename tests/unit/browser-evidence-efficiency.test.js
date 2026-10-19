'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const refs=require('../../scripts/environment-agent-demo/source-references'),presentation=require('../../scripts/environment-agent-demo/evidence-presentation'),observations=require('../../scripts/environment-agent-demo/observations');
function entry(value){const text=JSON.stringify(value);return{id:'owned:unknown',name:'environment_browser',text,at:new Date(0).toISOString(),sha256:createHash('sha256').update(text).digest('hex')};}
function clean(value){if(Array.isArray(value))return value.map(clean);if(!value||typeof value!=='object')return value;return Object.fromEntries(Object.entries(value).filter(([k])=>!k.startsWith('_stockchief')).map(([k,v])=>[k,clean(v)]));}
test('browser transport coordinates stay intact without competing with unfamiliar field evidence',()=>{
 const original={url:'http://localhost/unfamiliar',text:'Unknown form\nChoose package\n',textBlocks:{line0:'Unknown form',line1:'Choose package'},textRegions:[{firstLine:0,count:2,tag:'form',sha256:'original-hash'}],pagination:{controlsNextRef:'next-live'},controls:[{ref:'live:17',evidencePath:'/controls/0',name:'unexpected_field',label:'Choose package',value:'new',min:'2',options:[{value:'new',label:'Novel choice'}]}]};
 const e=entry(original),view=refs.present(e,presentation.project(e.name,original)),key=view._stockchiefSources.valueField;
 assert.deepEqual(clean(view.textRegions),original.textRegions);assert.deepEqual(clean(view._stockchiefInspectionWindow.page),original.pagination);assert.equal(view.pagination,undefined);assert.equal(view.controls[0].ref,'live:17');assert.equal(view.controls[0].evidencePath,'/controls/0');
 assert.equal(view.textRegions[0][key],undefined);assert.equal(view._stockchiefInspectionWindow[key],undefined);assert.equal(view.controls[0][key].ref,undefined);assert.equal(view.controls[0][key].evidencePath,undefined);
 for(const field of ['name','label','value','min'])assert.equal(refs.resolve([e],{sourceRef:view.controls[0][key][field],value:original.controls[0][field]}).path,'/controls/0/'+field);
 assert.equal(refs.resolve([e],{sourceRef:view.controls[0].options[0][key].label,value:'Novel choice'}).path,'/controls/0/options/0/label');
 const oldRef='fv1:'+createHash('sha256').update(JSON.stringify([e.id,e.sha256,'/controls/0/ref'])).digest('base64url').slice(0,16);
 assert.equal(refs.resolve([e],{sourceRef:oldRef,value:'live:17'}).path,'/controls/0/ref','Previously persisted references retain their original binding');
 assert.deepEqual(JSON.parse(e.text),original);
});
test('paged browser retrieval uses the same compact representation and field bindings as first delivery',()=>{
 const lines=Array.from({length:180},(_,i)=>'Discovered field '+i+' = '+i),original={text:lines.join('\n'),textBlocks:Object.fromEntries(lines.map((s,i)=>['line'+i,s])),controls:[{ref:'live',name:'unknown',value:'0',required:true}]},e=entry(original),h={evidence:{[e.id]:e}},first=refs.present(e,presentation.project(e.name,original));
 let offset=0,pages=0,wire='';do{const page=observations.retrieve(JSON.parse(JSON.stringify(h)),{id:e.id,offset});assert(page.records.length,'Every page advances');assert(Buffer.byteLength(JSON.stringify(page))<6500);wire+=JSON.stringify(page);pages++;offset=page.nextOffset;}while(offset!==null);
 assert(pages>1);assert(!wire.includes('"path":"/text"'),'Do not retrieve the full page again alongside its labelled text');
 for(const [ref,value]of Object.entries(first.textBlocks)){assert(wire.includes(ref));assert(wire.includes(value));assert.equal(refs.resolve([e],{sourceRef:ref,value}).evidenceId,e.id);}
 assert.deepEqual(h.evidence[e.id],e);assert.throws(()=>observations.retrieve(h,{id:'other-workspace:unknown'}),/NOT_FOUND/);
});
test('same Sol model with standard processing preserves hard financial and native output bounds',()=>{
 const models=require('../../scripts/environment-agent-demo/codex-models'),fast=models.getProfile('sol-low-fast'),normal=models.getProfile('sol-low'),wire=require('../../scripts/environment-agent-demo/codex-wire');
 assert.equal(normal.model,fast.model);assert.equal(normal.effort,fast.effort);
 for(const p of [normal,fast]){const limit=models.compactionTokenLimit(p),policy=wire.forProfile(p.id);assert.equal(policy.REQUEST_CEILING_MICRO_USD,300000);assert(limit<=policy.MAX_INPUT_TOKENS);assert(limit*p.prices.input+3000*p.prices.output<=300000);assert.equal(policy.normalize({model:p.model,reasoning:{effort:p.effort},input:[],max_output_tokens:3000}).body.max_output_tokens,3000);}
});
test('historical retrieval still issues original per-control bindings for false and null defaults',()=>{
 const original={text:'Unfamiliar form',textBlocks:{line0:'Unfamiliar form'},controls:[{ref:'live:0',name:'surprise',label:'Novel field',required:false,disabled:false,readOnly:false,min:null,max:null}]},e=entry(original),h={evidence:{[e.id]:e}};
 const result=observations.retrieve(h,{id:e.id,offset:0}),wire=JSON.stringify(result);
 const raw=refs.present(e,original),key=raw._stockchiefSources.valueField;
 for(const field of ['required','disabled','readOnly','min','max']){const sourceRef=raw.controls[0][key][field];assert(wire.includes(sourceRef));assert.equal(refs.resolve([e],{sourceRef,value:original.controls[0][field]}).path,'/controls/0/'+field);}
 assert.deepEqual(JSON.parse(e.text),original);
});

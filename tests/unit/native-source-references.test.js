'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const refs=require('../../scripts/environment-agent-demo/source-references');
function evidence(id,value,name='business_operations'){const text=JSON.stringify(value);return{id,name,text,sha256:createHash('sha256').update(text).digest('hex')};}
test('host references bind each original record, preserve unknown fields, and survive arbitrary projections and durable restart',()=>{
 const original={outcomes:[{result:{rows:[{sku:'one',onHand:22},{sku:'two',onHand:0,unexpectedField:'discovered'}]}}]},e=evidence('owned-goal:1',original);
 const output=refs.present(e,original,{legacy:true}),field=output._stockchiefSources.field;
 const selected=output.outcomes[0].result.rows.filter(r=>r.onHand===0).reverse()[0];
 assert.deepEqual(refs.resolve([JSON.parse(JSON.stringify(e))],{sourceRef:selected[field],path:'/onHand',value:0}),{evidenceId:e.id,path:'/outcomes/0/result/rows/1/onHand',value:0,historical:undefined});
 assert.equal(selected.unexpectedField,'discovered');assert.deepEqual(JSON.parse(e.text),original,'Durable source remains untouched');
 assert.throws(()=>refs.resolve([evidence('other-goal:1',original)],{sourceRef:selected[field],path:'/onHand',value:0}),/NOT_FOUND/);
});
test('different observations with the same object positions retain independent source bindings',()=>{
 const a=evidence('owned:1',{operations:[{description:'Price'},{description:'Recorded prices'},{description:'Read orders'}]},'environment_interfaces');
 const b=evidence('owned:4',{operations:[{description:'Price'},{description:'Prepare an invoice'},{description:'Revise a draft'}]},'environment_interfaces');
 const shown=refs.present(b,JSON.parse(b.text),{legacy:true}),field=shown._stockchiefSources.field;
 for(const row of shown.operations.slice(1)){
  const claim=refs.resolve([a,b],{sourceRef:row[field],path:'/description',value:row.description});assert.equal(claim.evidenceId,b.id);
 }
 assert.notEqual(refs.present(a,JSON.parse(a.text),{legacy:true}).operations[1][field],shown.operations[1][field]);
});
test('invented references, changed source bytes, metadata claims and prototype paths cannot manufacture evidence',()=>{
 const e=evidence('owned:1',{rows:[{quantity:0,_stockchiefSourceRef:'customer data',_stockchiefSources:'also customer data'}]}),out=refs.present(e,JSON.parse(e.text),{legacy:true}),field=out._stockchiefSources_.field,ref=out.rows[0][field];
 assert.equal(field,'_stockchiefSourceRef_');assert.equal(out.rows[0]._stockchiefSourceRef,'customer data');
 assert.equal(refs.metadataClaim(e,'/rows/0/'+field),true);assert.equal(refs.metadataClaim(e,'/rows/0/_stockchiefSourceRef'),false);
 assert.equal(refs.metadataClaim(e,'/_stockchiefSources_/field'),true);
 assert.throws(()=>refs.resolve([e],{sourceRef:'sr1:'+('X'.repeat(24)),path:'/quantity',value:0}),/NOT_FOUND/);
 assert.throws(()=>refs.present({...e,text:'{}'},{}),/INVALID_SOURCE/);
 const forged={...e,text:JSON.stringify({rows:[{quantity:99}]})};assert.throws(()=>refs.resolve([forged],{sourceRef:ref,path:'/quantity',value:99}),/NOT_FOUND/);
 assert.throws(()=>refs.resolve([e],{sourceRef:ref,path:'quantity',value:0}),/INVALID_SOURCE/);
});
test('native constrained output supports source references while preserving legacy v2 and v1 reports',()=>{
 const wire=require('../../scripts/environment-agent-demo/codex-report'),conversation=require('../../src/assistant/agent-conversation');
 const report={version:2,status:'completed',outcome:'answer',answer:'Verified record.',question:null,missingInformation:[],tier:null,reason:null,claims:[{sourceRef:'sr1:'+('A'.repeat(24)),historical:false,values:[{path:'/quantity',value:0}]}],navigation:null,workProducts:[],nextActions:[]};
 assert(new(require('ajv'))({strict:false}).compile(wire.legacySchema)(report));
 assert.equal(new(require('ajv'))({strict:false}).compile(wire.schema)(report),false);
 const decoded=conversation.parse(wire.decode(JSON.stringify(report)));assert.equal(decoded.claims[0].sourceRef,report.claims[0].sourceRef);assert.equal(decoded.claims[0].value,0);
 assert.equal(decoded.claims[0].evidenceId,undefined,'No observation ID is invented by decoding');
 assert.throws(()=>wire.decode(JSON.stringify({...report,claims:[{...report.claims[0],evidenceId:'ambiguous'}]})),/INVALID_NATIVE/);
});
test('new native claims copy complete field bindings and cannot generate either recorded relative-path failure',()=>{
 const wire=require('../../scripts/environment-agent-demo/codex-report'),conversation=require('../../src/assistant/agent-conversation');
 const e=evidence('owned:payments',{outcomes:[{capability:'read.unknown',result:{answer:'Recorded zero',rows:[{amount:0,currency:null,posted:false}]}}]}),shown=refs.present(e,JSON.parse(e.text)),valueField=shown._stockchiefSources.valueField;
 const answer=shown.outcomes[0].result[valueField].answer,report={version:3,status:'completed',outcome:'answer',answer:'Recorded zero',question:null,missingInformation:[],tier:null,reason:null,claims:[{sourceRef:answer,historical:false,value:'Recorded zero'}],navigation:null,workProducts:[],nextActions:[]};
 const validate=new(require('ajv'))({strict:false}).compile(wire.schema);assert(validate(report));const claim=conversation.parse(wire.decode(JSON.stringify(report))).claims[0];
 assert.equal(claim.path,undefined);assert.deepEqual(refs.resolve([e],claim),{evidenceId:e.id,path:'/outcomes/0/result/answer',value:'Recorded zero',historical:false});
 const withPath={...report,claims:[{...report.claims[0],path:'/answer'}]};assert.equal(validate(withPath),false);assert.throws(()=>wire.decode(JSON.stringify(withPath)),/INVALID_NATIVE/);assert.throws(()=>refs.resolve([e],{...claim,path:'/answer'}),/MUST_NOT_SUPPLY_PATH/);
 const row=shown.outcomes[0].result.rows[0];for(const key of ['amount','currency','posted'])assert.equal(refs.resolve([e],{sourceRef:row[valueField][key],value:row[key]}).path,'/outcomes/0/result/rows/0/'+key);
 const screen=evidence('owned:browser',{textBlocks:{line17:'On demand'},controls:[]},'environment_browser'),view=refs.present(screen,JSON.parse(screen.text)),key=view._stockchiefSources.valueField;
 const legacyView=refs.present(screen,JSON.parse(screen.text),{legacy:true});
 assert.equal(legacyView.textBlocks[legacyView._stockchiefSources.field],undefined,'A missing image cannot accidentally select root child objects through a default argument');
 const line={sourceRef:Object.keys(view.textBlocks).find(k=>view.textBlocks[k]==='On demand'),value:'On demand'};assert.match(line.sourceRef,/^fv1:/);assert.equal(refs.resolve([screen],line).path,'/textBlocks/line17');assert.throws(()=>refs.resolve([screen],{...line,path:'/textBlocks/line17'}),/MUST_NOT_SUPPLY_PATH/);
 const oldRef='sr1:'+createHash('sha256').update(JSON.stringify([screen.id,screen.sha256,'/textBlocks'])).digest('base64url').slice(0,24);
 assert.equal(refs.resolve([screen],{sourceRef:oldRef,path:'/line17',value:'On demand'}).path,'/textBlocks/line17','Valid saved legacy bindings survive the old missing-image codec bug without reissuing those anchors');
 assert(refs.metadataClaim(screen,'/textBlocks/'+key+'/line17'));
});
test('actual screenshot text-envelope shape retains the screen binding at its original path',()=>{
 const original={screen:{url:'http://127.0.0.1:7654/unfamiliar',text:'New screen',controls:[{name:'unfamiliar_field',value:'37'}]},image:{base64:'offline-only',mimeType:'image/png'}};
 const e=evidence('owned:screen',original,'environment_browser'),shown=refs.present(e,original),text=shown.screen,field=text._stockchiefSources.valueField;
 const selected=refs.resolve([e],{sourceRef:text[field].url,value:original.screen.url});
 assert.equal(selected.path,'/screen/url');assert.equal(refs.metadataClaim(e,'/screen/_stockchiefSources/field'),true);
 assert.deepEqual(shown.image,original.image);assert.equal(text.controls[0].value,'37');
 const h={evidence:{[e.id]:e}},retrieved=require('../../scripts/environment-agent-demo/observations').retrieve(h,{id:e.id,offset:0});
 assert.equal(retrieved.screen[field].url,text[field].url);assert.equal(retrieved.screen._stockchiefSources.valueField,field);
});

test('sequential screen subsets cannot become a new whole-container assertion or cross-observation join',()=>{
 const wire=require('../../scripts/environment-agent-demo/codex-report'),validate=new(require('ajv'))({strict:false}).compile(wire.schema);
 const earlier=evidence('owned:2',{screen:{textBlocks:Object.fromEntries(Array.from({length:81},(_,i)=>['line'+i,'Earlier field '+i]))}},'environment_browser');
 const later=evidence('owned:3',{screen:{textBlocks:Object.fromEntries(Array.from({length:100},(_,i)=>['line'+i,'Later field '+i]))}},'environment_browser');
 const out=refs.present(later,JSON.parse(later.text)),field=out.screen._stockchiefSources?.valueField||out._stockchiefSources.valueField;
 assert.equal(out.screen[field],undefined,'Container references are not offered as new native factual assertions');
 const [sourceRef,value]=Object.entries(out.screen.textBlocks)[17],report={version:3,status:'completed',outcome:'answer',answer:'A visible field.',question:null,missingInformation:[],tier:null,reason:null,claims:[{sourceRef,value,historical:false}],navigation:null,workProducts:[],nextActions:[]};
 assert(validate(report));assert.equal(refs.resolve([earlier,later],report.claims[0]).evidenceId,later.id);assert.equal(refs.resolve([earlier,later],report.claims[0]).path,'/screen/textBlocks/line17');
 assert.equal(validate({...report,claims:[{...report.claims[0],value:{json:JSON.stringify(Object.fromEntries(Object.entries(out.screen.textBlocks).slice(0,5)))}}]}),false,'An observed subset cannot be asserted as an original container');
 const previousContainerRef='fv1:'+createHash('sha256').update(JSON.stringify([earlier.id,earlier.sha256,'/screen/textBlocks'])).digest('base64url').slice(0,16);
 assert.equal(refs.resolve([earlier,later],{sourceRef:previousContainerRef,value:{legacy:'retained'}}).path,'/screen/textBlocks','Saved version-3 bindings retain their original meaning; no current-data substitution');
 const primitiveArrays=evidence('owned:array',{codes:['a',null,false,0,['nested']],empty:[]}),arrayView=refs.present(primitiveArrays,JSON.parse(primitiveArrays.text)),map=arrayView[arrayView._stockchiefSources.valueField];
 for(const [label,path,value]of [['codes[0]','/codes/0','a'],['codes[1]','/codes/1',null],['codes[2]','/codes/2',false],['codes[3]','/codes/3',0],['codes[4][0]','/codes/4/0','nested']])assert.deepEqual(refs.resolve([primitiveArrays],{sourceRef:map[label],value}),{evidenceId:primitiveArrays.id,path,value,historical:undefined});
 assert.equal(map.empty,undefined,'Empty containers are not synthesized into an absence fact');assert.deepEqual(arrayView.codes,JSON.parse(primitiveArrays.text).codes);
 const colliding=evidence('owned:array-collision',{codes:['array value',['nested value']],'codes[0]':'literal value','codes[1][0]':'literal nested label'}),collisionView=refs.present(colliding,JSON.parse(colliding.text)),collisionMap=collisionView[collisionView._stockchiefSources.valueField];
 for(const [label,path,value]of [['codes[0]','/codes[0]','literal value'],['codes[0]_','/codes/0','array value'],['codes[1][0]','/codes[1][0]','literal nested label'],['codes[1][0]_','/codes/1/0','nested value']])assert.equal(refs.resolve([colliding],{sourceRef:collisionMap[label],value}).path,path,'Literal field names never overwrite generated array bindings');
 const oldReport={...report,claims:[{sourceRef:previousContainerRef,historical:false,value:{json:'{}'}}]};assert.equal(validate(oldReport),false);assert.deepEqual(JSON.parse(wire.decode(JSON.stringify(oldReport))).claims[0].value,{},'Already-saved v3 containers retain decoding, but cannot be newly generated');
});

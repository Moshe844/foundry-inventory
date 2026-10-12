'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const corpus=require('../../scripts/environment-agent-demo/openai-certification-corpus');
const navigation=require('../../scripts/environment-agent-demo/navigation-evidence');
const gates=require('../../scripts/environment-agent-demo/openai-release-gates');
test('100 fresh goals span twelve domains with balanced holdout and explicit browser requirements',()=>{
 const a=corpus.createTasks(),b=corpus.createTasks();assert.equal(a.length,100);assert.equal(new Set(a.map(t=>t.domain)).size,12);
 assert.equal(a.filter(t=>t.holdout).length,25);assert.ok(a.filter(t=>t.browser).length>=30);
 assert.ok(a.filter(t=>t.browser?.edit).length>=4);assert.notEqual(corpus.corpusHash(a),corpus.corpusHash(b));
 assert.ok(a.every(t=>!t.prompt.includes('{')&&!t.prompt.includes('^/')));
 assert.ok(a.filter(t=>t.browser).every(t=>t.prompt.includes('API reads alone do not answer')));
 assert.ok(a.some(t=>t.kind==='reservation')&&a.some(t=>t.kind==='new-po'));
});
function observation(url,controls=[],text='Actual business screen'){return {kind:'browser_observation',screen:{url:'http://127.0.0.1:1234'+url,httpStatus:200,controls,text}};}
function start(action,ref,value){return {kind:'agent_tool_started',name:'environment_browser',sdkToolCallId:'provider-call',input:{action,ref,value}};}
test('Home inspections, refreshes, API reads and host restores never earn navigation credit',()=>{
 for(const action of ['inspect','refresh','back','screenshot'])assert.equal(navigation.score([
  start('inspect'),observation('/'),start(action),observation('/inventory/table')],{route:'^/inventory/table'}).passed,false);
 assert.equal(navigation.score([{kind:'browser_location_restored'},observation('/inventory/table')],{route:'^/inventory/table'}).passed,false);
 assert.equal(navigation.score([{kind:'agent_tool_started',name:'business_operations',sdkToolCallId:'call'},observation('/inventory/table')],{route:'^/inventory/table'}).passed,false);
});
test('browser proof requires prior observed controls, successful navigation and requested form interaction',()=>{
 const field={tag:'input',ref:'field',name:'name',value:''};
 const trace=[start('inspect'),observation('/',[{tag:'a',ref:'link',label:'Create product'}]),start('click','link'),
  observation('/inventory/new',[field]),start('fill','field','trial'),observation('/inventory/new',[{...field,value:'trial'}])];
 assert.equal(navigation.score(trace,{route:'^/inventory/new',form:true,edit:true}).passed,true);
 assert.equal(navigation.score(trace,{route:'^/inventory/new',form:true,edit:true,editFields:'^different_business_field$'}).passed,false);
 assert.equal(navigation.score(trace.slice(0,4),{route:'^/inventory/new',form:true,edit:true}).passed,false);
 const forged=structuredClone(trace);forged[2].input.ref='invented';assert.equal(navigation.score(forged,{route:'^/inventory/new'}).passed,false);
 const failed=structuredClone(trace);failed[3].screen.httpStatus=500;assert.equal(navigation.score(failed,{route:'^/inventory/new'}).passed,false);
});
test('numeric fact matching or a COMPLETED string cannot bypass semantic/browser/safety gates',()=>{
 const task=corpus.createTasks().find(t=>t.browser),result={verifiedOutcome:true,status:'COMPLETED',sourceHash:'frozen',verdict:{checks:{unchanged:true}}};
 const review={task:task.id,sourceHash:'frozen',evidenceHash:'sha',reviewer:'offline reviewer',semanticCorrect:true,scopeComplete:true,safe:true,falseCompletion:false};
 assert.equal(gates.grade(task,result,[],review).pass,false);
 assert.equal(gates.grade({...task,browser:null},result,[],null).pass,false);
 assert.equal(gates.grade({...task,browser:null},result,[],{...review,semanticCorrect:false}).pass,false);
 assert.equal(gates.grade({...task,browser:null},result,[],{...review,falseCompletion:true}).safe,false);
 assert.equal(gates.assess({primary:'openai',tasks:corpus.createTasks(),sourceHash:'frozen',ceilingMicroUsd:1},[],{offline:true,sourceHash:'frozen'}).decision,'NO_GO');
});

test('read-only success cannot hide missing payments, shipping or other consequential outcomes',()=>{
 const tasks=corpus.createTasks(),manifest={primary:'openai',tasks,sourceHash:'frozen',ceilingMicroUsd:100000000};
 const reviews=tasks.map(task=>gates.grade(task,{verifiedOutcome:true,status:'COMPLETED',sourceHash:'frozen',
  verdict:{checks:{safe:true}},changedState:true,injectedFailure:true},[],
  {task:task.id,sourceHash:'frozen',evidenceHash:'private-proof',reviewer:'independent',semanticCorrect:true,scopeComplete:true,safe:true,falseCompletion:false}));
 // Synthetic passing browser verdicts exercise only the release decision here;
 // the preceding tests independently exercise browser evidence validation.
 for(const row of reviews){row.pass=true;row.browser.passed=true;}
 const options={offline:true,sourceHash:'frozen'};
 assert.equal(gates.assess(manifest,reviews,options).decision,'STAGING_ELIGIBLE');
 reviews.find(r=>r.operation==='supplier-payment').pass=false;
 const failed=gates.assess(manifest,reviews,options);
 assert.equal(failed.decision,'NO_GO');assert.ok(failed.reasons.includes('No verified business execution: supplier-payment'));
 assert.equal(gates.assess(manifest,reviews,{...options,offline:false}).decision,'NO_GO');
});
test('OpenAI canonical helper builds a bounded Responses request and never retries malformed output',async()=>{
 let calls=0;
 const provider=require('../../scripts/environment-agent-demo/openai-structured-provider').createStructuredProvider({openaiBaseURL:'http://127.0.0.1:1234/openai/v1',token:'local-token'},
  {fetchImpl:async(url,init)=>{calls++;assert.equal(String(url),'http://127.0.0.1:1234/openai/v1/responses');
   const body=JSON.parse(init.body);assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.max_output_tokens,3000);assert.equal(body.store,false);
   require('../../scripts/environment-agent-demo/protocol').validate('openai',body);
   require('../../scripts/environment-agent-demo/wire-policy').normalize('openai',body);
   return {ok:true,json:async()=>({object:'response',model:body.model,status:'completed',usage:{input_tokens:100,output_tokens:12,input_tokens_details:{cached_tokens:20,cache_write_tokens:30}},
    output:[{type:'message',content:[{type:'output_text',text:calls===1?'{"ok":true}':'broken json'}]}]})};}});
 const request={commercial:true,system:'Return JSON',prompt:'Inspect the given facts',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}};
 assert.deepEqual((await provider.complete(request)).data,{ok:true});
 await assert.rejects(()=>provider.complete(request),e=>e.code==='ai_invalid_output'&&e.usage.inputTokens===50);
 assert.equal(calls,2);await assert.rejects(()=>provider.complete({...request,commercial:false}));assert.equal(calls,2);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const contracts=require('../../scripts/environment-agent-demo/contracts');
const {registry,FIELDS}=require('../../src/assistant/postgres-capability-registry');
const {fit}=require('../../scripts/environment-agent-demo/wire-context');
const wire=require('../../scripts/environment-agent-demo/wire-policy');
test('every advertised numeric field transports losslessly and malformed inputs fail before execution',()=>{
 let covered=0;
 for(const c of registry.list())for(const name of c.fields.filter(n=>['number','integer'].includes(FIELDS[n].type))){
  for(const value of [0,1,13,202,FIELDS[name].type==='integer'?55:3.47]){
   const steps=contracts.operationSteps([{capability:c.name,arguments:[{name,value}],dependsOn:[]}],registry);
   assert.equal(steps[0].arguments[0].value,String(value));covered++;
  }
  for(const value of [null,{},true,NaN,Infinity])assert.throws(()=>contracts.operationSteps([
   {capability:c.name,arguments:[{name,value}],dependsOn:[]}],registry),e=>e.code==='TOOL_CONTRACT_INVALID'&&!e.effectMayHaveOccurred);
 }
 assert.ok(covered>100);
 assert.throws(()=>contracts.operationSteps([{capability:'inventory.receive',arguments:[{name:'quantity',value:1.5}],dependsOn:[]}],registry),/integer/);
 assert.throws(()=>contracts.operationSteps([{capability:'inventory.receive',arguments:[{name:'workspaceId',value:'foreign'}],dependsOn:[]}],registry),/Allowed fields/);
});
test('every discovered dataset schema accepts canonical queries and rejects misspelled filters',()=>{
 const reports=require('../../src/reports/postgres-service'),actor={role:'owner'};
 for(const d of require('../../src/reports/postgres-registry').list(actor)){
  const field=Object.keys(d.fields)[0],spec={dataset:d.key,columns:[field]};
  assert.deepEqual(contracts.datasetSpec(spec,actor),reports.normalize(spec,actor));
  const query=reports.queryContract(d.key,actor);
  assert.ok(query.schema.properties.filters.items.properties.operator.enum.includes('equals'));
  assert.throws(()=>contracts.datasetSpec({...spec,filters:[{field,op:'eq',value:'x'}]},actor),/operator/);
 }
 assert.equal(reports.queryContract('not_registered',actor),null);
 const dimension=require('../../src/reports/postgres-composed').dimensions(actor)[0];
 const combined={dataset:'composed',dimension:dimension.key,metrics:dimension.sources.slice(0,2).map((s,i)=>({dataset:s.key,alias:`measure_${i}`,aggregate:'count'}))};
 assert.deepEqual(contracts.datasetSpec(combined,actor),reports.normalize(combined,actor));
});
test('both wire protocols retain original constraints, learned contracts and complete recent rounds under cost bounds',()=>{
 for(const provider of ['openai','anthropic']){
  const original={role:'user',content:'Inspect records. No messages or changes without approval.'};const history=[original];
  for(let i=0;i<35;i++){
   if(provider==='openai')history.push({type:'reasoning',encrypted_content:'signed-'+i,summary:[]},
    {type:'function_call',call_id:'c'+i,name:'environment_dataset',arguments:'{}'},
    {type:'function_call_output',call_id:'c'+i,output:'Historical data '.repeat(450)});
   else history.push({role:'assistant',content:[{type:'thinking',thinking:'Reasoning '.repeat(100),signature:'signed-'+i},
    {type:'tool_use',id:'c'+i,name:'environment_dataset',input:{}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'c'+i,content:'Historical data '.repeat(450)}]});
  }
  const body={model:wire.MODELS[provider],[provider==='openai'?'input':'messages']:history};
  const result=fit(provider,body,{maxInputTokens:50000,memory:{contracts:[{name:'random_dataset',operator:'equals'}]}});
  assert.ok(result.inputTokens<=50000);assert.ok(result.context.itemsDropped>0);
  const text=JSON.stringify(result.body);assert.match(text,/No messages or changes without approval/);assert.match(text,/random_dataset/);assert.match(text,/c34/);assert.doesNotMatch(text,/signed-0"/);
  assert.deepEqual((provider==='openai'?result.body.input:result.body.messages)[0],original);
  assert.equal(history.length,provider==='openai'?106:71);
  assert.throws(()=>fit(provider,{...body,[provider==='openai'?'input':'messages']:[{role:'user',content:'critical constraints '.repeat(10000)}]}),/CONTEXT_BUDGET_EXHAUSTED/);
 }
});
test('durable memory preserves contracts, corrections and unverified plans without asserting completion',()=>{
 const memory=require('../../scripts/environment-agent-demo/memory'),h={evidence:{}};
 memory.observe(h,'environment_interfaces',{}, {operations:[{name:'random.operation',fields:{quantity:{type:'integer'}},authority:{mode:'explicit_approval'}}]},'e1');
 memory.observe(h,'environment_notebook',{note:'Hypothesis only. Investigate remaining discrepancies.',evidenceIds:['e1']},{},'e2');
 memory.observe(h,'business_operations',{}, {outcomes:[{capability:'random.operation',result:{status:'PREPARED',proposal:{id:'p1'}}}]},'e3');
 h.lastToolError={code:'TOOL_CONTRACT_INVALID',message:'Use operator equals'};
 const packed=memory.working(JSON.parse(JSON.stringify(h)));
 assert.equal(packed.contracts[0].fields.quantity.type,'integer');assert.equal(packed.lastOperations.outcomes[0].status,'PREPARED');
 assert.equal(packed.untrusted,true);assert.match(packed.notebook.note,/Hypothesis/);assert.match(packed.lastToolError.message,/operator/);
 h.notebook.note='"記録'.repeat(1200);h.lastToolError.message='"記録'.repeat(1500);
 for(let i=0;i<180;i++)h.learned['contract'+i]={name:'contract'+i,evidenceId:'observed-'+i,fields:{data:'untrusted'.repeat(800)}};
 assert.ok(require('../../scripts/environment-agent-demo/context').bytes(memory.working(h))<=8500);
});
test('verification retries only transient reads once and never hides persistent or authority failures',async()=>{
 const {freshRead}=require('../../scripts/environment-agent-demo/read-recovery');let n=0,retries=0;
 assert.equal(await freshRead(async()=>{if(++n===1)throw Object.assign(new Error('temporary'),{code:'08006'});return 17;},()=>retries++),17);
 assert.equal(n,2);assert.equal(retries,1);
 for(const code of ['forbidden','rate_limited','23505','TOOL_CONTRACT_INVALID']){
  let calls=0;await assert.rejects(()=>freshRead(async()=>{calls++;throw Object.assign(new Error(code),{code});}),new RegExp(code));assert.equal(calls,1);
 }
 let persistent=0;await assert.rejects(()=>freshRead(async()=>{persistent++;throw Object.assign(new Error('still down'),{code:'08006'});}),/still down/);assert.equal(persistent,2);
 let writes=0;await assert.rejects(()=>require('../../scripts/environment-agent-demo/read-recovery').query({query:async()=>{
  writes++;throw Object.assign(new Error('write interrupted'),{code:'08006'});}},'UPDATE records SET value=1',[]),/write interrupted/);assert.equal(writes,1);
});
test('small structured responses reserve output for the verdict and retain truncation diagnostics and usage',async t=>{
 const http=require('node:http');let seen=[],truncate=false;
 const server=http.createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;
  seen.push(JSON.parse(text));res.setHeader('content-type','application/json');
  res.end(JSON.stringify({id:'offline-response',type:'message',role:'assistant',model:wire.MODELS.anthropic,
   content:truncate?[]:[{type:'text',text:'{"complete":true}'}],stop_reason:truncate?'max_tokens':'end_turn',
   usage:{input_tokens:100,output_tokens:truncate?500:20}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const provider=require('../../scripts/environment-agent-demo/structured-provider').createStructuredProvider({token:'FAKE',anthropicBaseURL:`http://127.0.0.1:${server.address().port}`});
 const request={commercial:true,system:'Verify evidence',prompt:'Synthetic evidence',maxOutputTokens:500,schema:{type:'object',required:['complete'],properties:{complete:{type:'boolean'}},additionalProperties:false}};
 assert.equal((await provider.complete(request)).data.complete,true);assert.equal(seen[0].thinking.type,'disabled');assert.equal(seen[0].max_tokens,500);
 truncate=true;await assert.rejects(()=>provider.complete(request),e=>e.code==='ai_invalid_output'&&e.stopReason==='max_tokens'&&e.usage.outputTokens===500);
 assert.equal(seen.length,2,'adapter performs no hidden retry');
});

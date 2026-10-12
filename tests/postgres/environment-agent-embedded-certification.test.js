'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const fixtures=require('../../scripts/environment-agent-demo/embedded-certification-fixtures');
// Mechanical verifier controls only; these actions NEVER earn model success.
test('private unfamiliar worksheets verify all five schemas, changed forms, tenant isolation and missing execution',async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const browser=await require('playwright').chromium.launch({headless:true});t.after(()=>browser.close());
 for(const task of fixtures.createTasks().filter(t=>t.novel&&t.kind==='read')){
  const f=await fixtures.seed(db,task),inspection=await require('../../scripts/environment-agent-demo/inspection').createInspectionServer({cluster,database:db,ctx:f.ctx});
  const environment=await fixtures.environment(db,f,inspection),ui=await require('../../scripts/environment-agent-demo/browser').createBrowserTools(browser,{origin:environment.origin});
  try{
   const table=require('pg').escapeIdentifier(f.novel.table);
   assert.equal((await inspection.readonly.query(`SELECT * FROM ${table}`)).rows.length,1);
   let screen=await ui.inspect();
   screen=await ui.act({action:'click',ref:screen.controls.find(c=>c.href===f.novel.paths[0]).ref});
   for(const p of f.novel.paths.slice(1))screen=await ui.act({action:'click',ref:screen.controls.find(c=>c.href===p).ref});
   assert.equal((await fixtures.verify(db,f,'A confident answer with no preview')).achieved,false);
   for(let revision=0;revision<2;revision++){
    for(const key of f.novel.family.keys){const field=screen.controls.find(c=>c.name===f.novel.fields[revision][key]);
     screen=await ui.act({action:field.tag==='select'?'select':'fill',ref:field.ref,value:String(f.novel.facts[key])});}
    if(revision)screen=await ui.act({action:'select',ref:screen.controls.find(c=>c.name===f.novel.fields[1].handling).ref,value:f.novel.choice});
    screen=await ui.act({action:'click',ref:screen.controls.find(c=>c.label==='Calculate preview').ref});
   }
   assert.match(screen.text,/Verified worksheet preview/);
   const verified=await fixtures.verify(db,f,'Offline evaluator positive control; separate semantic review is required.');
   assert.equal(verified.achieved,true);assert.ok(Object.values(verified.checks).every(Boolean));
   assert.equal(verified.discovery.formChanges,1);assert.ok(verified.discovery.fieldsBefore.every(k=>!verified.discovery.fieldsAfter.includes(k)));
   assert.equal(JSON.stringify(screen).includes('FOREIGN-NOVEL-CANARY'),false);
   await db.query(`UPDATE ${table} SET capacity=999 WHERE workspace_id=$1`,[f.ctx.workspaceId]);
   assert.equal((await fixtures.verify(db,f,'same')).achieved,false,'unrequested novel-table changes must fail');
  }finally{await ui.close();await environment.close();await inspection.close();}
 }
});

function response(body,item){
 const result={id:'resp_offline',object:'response',created_at:1,status:'completed',model:body.model,output:[item],usage:{input_tokens:200,output_tokens:30}};
 const events=[{type:'response.created',response:{...result,status:'in_progress',output:[]}},
  {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',...(item.type==='function_call'?{arguments:''}:{content:[]})}}];
 if(item.type==='function_call')events.push({type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta:item.arguments},
  {type:'response.function_call_arguments.done',output_index:0,item_id:item.id,arguments:item.arguments});
 else events.push({type:'response.content_part.added',output_index:0,content_index:0,item_id:item.id,part:{type:'output_text',text:'',annotations:[]}},
  {type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:item.content[0].text},
  {type:'response.output_text.done',output_index:0,content_index:0,item_id:item.id,text:item.content[0].text},
  {type:'response.content_part.done',output_index:0,content_index:0,item_id:item.id,part:item.content[0]});
 events.push({type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:result});
 return new Response(events.map((e,i)=>`event: ${e.type}\ndata: ${JSON.stringify({...e,sequence_number:i})}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}
test('actual OpenAI worker inspects real Home through normal runner and relay with fake transport; private fixture data cannot earn a pass',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-embedded-offline-'));
 const {ExperimentBudget}=require('../../scripts/environment-agent-demo/budget'),budget=new ExperimentBudget(path.join(dir,'offline.sqlite'),'offline-embedded');
 t.after(()=>{budget.close();fs.rmSync(dir,{recursive:true,force:true});});
 budget.approve({ceilingMicroUsd:1000000,approvalReference:'SYNTHETIC OFFLINE ONLY',expiresAt:new Date(Date.now()+180000).toISOString()});
 const task=fixtures.createTasks().find(t=>t.novel&&t.kind==='read');let requests=0,privateFixture;
 const adapter={...fixtures,seed:async(db,task)=>{privateFixture=await fixtures.seed(db,task);return privateFixture;}};
 const image=JSON.parse(fs.readFileSync('data/environment-agent-demo/sandbox-certificate.json','utf8')).image;
 const result=await require('../../scripts/environment-agent-demo/run-pilot').attempt({candidate:'openai',helperProvider:'openai',task,budget,
  certificate:{passed:true,testOnly:true,sourceHash:'offline-test',image},credentials:{openai:'FAKE'},outputDirectory:path.join(dir,'attempt'),fixtures:adapter,
  approvalDecision:async()=>{throw new Error('No approval expected in this transport test.');},
  offlineFetch:async(_url,init)=>{
   const body=JSON.parse(init.body);requests++;
   require('../../scripts/environment-agent-demo/protocol').validate('openai',body);
   assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.tools.length,8);
   assert.ok(!init.body.includes(privateFixture.novel.table));
   for(const fields of privateFixture.novel.fields)for(const name of Object.values(fields))assert.ok(!init.body.includes(name));
   assert.ok(!init.body.includes('expectedFacts')&&!init.body.includes('FOREIGN-NOVEL-CANARY'));
   if(requests===1){for(const p of privateFixture.novel.paths)assert.ok(!init.body.includes(p));
    return response(body,{id:'fc_inspect',type:'function_call',call_id:'sdk-inspect',name:'environment_browser',arguments:JSON.stringify({action:'inspect',ref:null,value:null}),status:'completed'});}
   // Bounded Home output may put the link in paged evidence. The worker gets
   // that evidence handle, never a private route map or future field names.
   // Deliberately end incomplete to test grading.
   assert.ok(init.body.includes('evidenceId'));
   for(const p of privateFixture.novel.paths.slice(1))assert.ok(!init.body.includes(p));
   return response(body,{id:'msg_done',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'I have only inspected Home; the worksheet and business goal are not complete.',annotations:[]}]});
  }});
 assert.equal(requests,2,JSON.stringify(result.error));assert.equal(result.providerMode,'OFFLINE_SYNTHETIC');assert.equal(result.verifiedOutcome,false);
 assert.equal(result.unresolvedModelCalls,0,JSON.stringify({error:result.error,interruptions:result.interruptions,calls:budget.db.prepare('SELECT state,detail FROM experiment_calls').all()}));assert.equal(result.actualHumanApprovalResponses,0);assert.equal(result.operatorRescues,0);
 const trace=fs.readFileSync(path.join(dir,'attempt/trace.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(trace.some(e=>e.kind==='agent_tool_started'&&e.sdkToolCallId==='sdk-inspect'));
 assert.ok(trace.some(e=>e.kind==='browser_observation'&&e.screen.text.includes('worksheet')));
 assert.equal(result.verdict.discovery.previewCompleted,false);
});

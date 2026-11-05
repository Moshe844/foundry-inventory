'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('a read-only Ask goal uses one model and one direct database tool, with no browser, sandbox or review loop',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,owner}=f;
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','STOCKCHIEF_CODEX_MODEL_POLICY','STOCKCHIEF_AI_METER'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];});
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';process.env.STOCKCHIEF_AI_METER='credits';process.env.STOCKCHIEF_CODEX_MODEL_POLICY=JSON.stringify({default:{initialTier:'fast',profiles:{fast:'sol-low-fast'}}});
 Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:'Shipping operation fixture',emails:[f.email]})).environment);
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source) VALUES($1,$2,'growth','COMP','CUSTOM','OFFLINE_FIXTURE')",[randomUUID(),owner.accountId]);
 await db.query("UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=1000000,approval_reference='OFFLINE ONLY' WHERE workspace_id=$1",[ctx.workspaceId]);
 await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
 const profile=require('../../scripts/environment-agent-demo/codex-models').getProfile('sol-low-fast');
 for(const [operation,rate]of Object.entries(profile.rates))await db.query("INSERT INTO commercial_cost_rates(id,provider,model,provider_version,operation,unit,cost_per_unit_minor,currency,effective_from,source,pricing_basis,confidence) VALUES($1,'openai',$2,$3,$4,'token',$5,'USD',now(),'OFFLINE SYNTHETIC ONLY','VERIFIED_PUBLIC','HIGH')",[randomUUID(),profile.model,profile.providerVersion,operation,rate/10000]);
 const pilot=require('../../src/assistant/postgres-codex-pilot'),store=require('../../src/assistant/postgres-goal-store');
 await require('../../src/accounting/postgres-manual-invoices').createCustomerInvoice(db,ctx,{customerId:'fixture-customer',issueDate:await require('../../src/lib/business-time').today(db,ctx.workspaceId),description:'Offline receivable regression',quantity:1,unitAmount:'12.50',idempotencyKey:'offline-receivable-regression'});
 let models=0,browsers=0,sandboxes=0;const prompts=[],chatId='chat_followup_memory';const start=await pilot.start(db,ctx,'Show the total stock in each location and the total number of catalogue SKUs',{conversationId:chatId});
 const plan={status:'read',question:'',queries:[{dataset:'stock',groups:['location'],aggregate:'sum',measure:'on_hand'},{dataset:'catalogue',summary:true,aggregate:'count'},{dataset:'customer_invoices',groups:['customer','currency'],summary:false,aggregate:'sum',measure:'balance_minor',filters:[{field:'balance_minor',operator:'greater_than',value:0}],sort:'balance_minor',direction:'desc',topN:100}]},began=performance.now();
 const readOptions={image:'sha256:'+'0'.repeat(64),apiKey:'FAKE',countInput:async()=>({object:'response.input_tokens',input_tokens:300}),
  inspectionPool:{acquire:async()=>{browsers++;throw Error('READ_ONLY_BROWSER_FORBIDDEN');}},sandboxPool:{take:()=>{sandboxes++;throw Error('READ_ONLY_SANDBOX_FORBIDDEN');}},
  fetchImpl:async(_url,init)=>{models++;const body=JSON.parse(init.body);prompts.push(init.body);assert.equal(body.stream,false);assert.match(body.instructions,/Interpret the user's read-only/);
   return new Response(JSON.stringify({id:'resp_offline_read',object:'response',model:body.model,status:'completed',service_tier:'fast',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(plan)}]}],usage:{input_tokens:300,output_tokens:100,input_tokens_details:{cached_tokens:0}}}),{headers:{'content-type':'application/json'}});
  }};
 await pilot.run(db,ctx,start.goalId,readOptions);
 const goal=await store.get(db,ctx,start.goalId);if(goal.status!=='COMPLETED')t.diagnostic(JSON.stringify({status:goal.status,answer:goal.answer,harness:goal.checkpoint.harness?.interruption}));
 assert.equal(goal.status,'COMPLETED');assert.equal(models,1);assert.equal(browsers,0);assert.equal(sandboxes,0);assert.equal(Number(goal.tool_calls),1);assert.equal(goal.checkpoint.harness.verificationCorrections||0,0);assert.match(goal.answer,/Dispatch/);assert.match(goal.answer,/4/);assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.codex_pilot_calls WHERE goal_id=$1',[goal.id])).rows[0].n,1);
 assert.match(goal.answer,/Receiver/);assert.match(goal.answer,/\$12\.50/,'The grouped unpaid balance comes from the actual invoice');
 assert(performance.now()-began<8000,'A simple read must complete within eight seconds after admission with the offline provider');
 t.diagnostic(JSON.stringify({models,browsers,sandboxes,tools:goal.tool_calls,elapsedMs:Math.round(performance.now()-began),paidCalls:0}));
 // A follow-up is read with the conversation it belongs to.
 assert.match(goal.answer,/\| Location \|/i,'Grouped records come back as a real table');
 const followUp=await pilot.start(db,ctx,'just the first one',{conversationId:chatId});
 await pilot.run(db,ctx,followUp.goalId,readOptions);
 assert.match(prompts.at(-1),/Show the total stock in each location/,'The earlier question reaches the interpreter');
 assert.doesNotMatch(prompts[0],/just the first one/);
 const rejected=await store.create(db,ctx,'Offline invalid read projection');
 await db.query("UPDATE stockchief_runtime.assistant_goals SET status='BLOCKED',checkpoint=$2::jsonb WHERE id=$1",[rejected.id,JSON.stringify({runtime:'codex-staging',boundedRead:true,harness:{helperDelivery:{state:'SETTLED'},interruption:{code:'validation_error'}}})]);
 const progress=await store.progress(db,ctx,rejected.id);assert.equal(progress.checkpoint.harness.readQueryInvalid,true);assert.equal(require('../../src/assistant/agent-conversation').state(progress).phase,'failed','The website receives an explained query failure, not an uncertain-operation pause');
});

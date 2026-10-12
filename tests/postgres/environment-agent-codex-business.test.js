'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto'),base='../../scripts/environment-agent-demo/';
const artifactDirectory=process.env.STOCKCHIEF_CODEX_ARTIFACT_DIR||'data/environment-agent-demo/codex-sdk-sol-high';
const goals=require('../../src/assistant/postgres-goal-store');
test('Codex MCP cannot self-approve; canonical execution is idempotent and verified reporting needs no new model call',{timeout:120000},async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-codex-business-'));
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 const cleanup=[];t.after(async()=>{for(const close of cleanup.reverse())await close();await db.close();await cluster.stop();fs.rmSync(tmp,{recursive:true,force:true});});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Offline operator',businessName:'Canonical SDK',email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId},sku='OFFLINE-'+randomUUID().slice(0,8),name='Offline SDK item';
 const prompt=`Create a quantity-tracked product named ${name} with SKU ${sku}. Prepare it for my approval.`;
 let held=await goals.claim(db,ctx,(await goals.create(db,ctx,prompt,{budgetMinor:75})).id);
 const steps=[{capability:'catalog.create_item',arguments:[{name:'search',value:name},{name:'baseCode',value:sku}],dependsOn:[]}];
 const input={stepsJson:JSON.stringify(steps)};
 function attach(verifier){const gateway=require(base+'gateway').createGateway({database:db,ctx,goal:prompt,goalId:held.id,runToken:held.run_token,
  provider:{complete:async()=>{throw Error('NO_PAID_CALLS');}}});
  const session=require(base+'session').createSession({database:db,ctx,goalId:held.id,runToken:held.run_token,candidate:'codex',authorize:gateway.authorize,verifyOutcome:verifier});return {session,gateway};}
 let {session,gateway}=attach();
 const budget=new (require(base+'budget').ExperimentBudget)(path.join(tmp,'budget.db'),'OFFLINE SDK BUSINESS');cleanup.push(()=>budget.close());
 budget.approve({ceilingMicroUsd:2000000,approvalReference:'FAKE PROVIDER ONLY',expiresAt:new Date(Date.now()+120000).toISOString()});
 let calls=0;
 const relay=await require(base+'relay').createRelay({budget,credentials:{openai:'FAKE'},
  commercial:{begin:async c=>c,complete:async()=>{},unknown:async()=>{},release:async()=>{}},
  countCodexInput:async()=>({object:'response.input_tokens',input_tokens:10000}),
  fetchImpl:async(_url,init)=>{const body=JSON.parse(init.body);calls++;
   if(calls===1)return require('../helpers/codex-offline-response')(body,calls,`const t=ALL_TOOLS.find(t=>t.name.endsWith('__business_operations'));text(await tools[t.name](${JSON.stringify(input)}));`);
   assert.equal(calls,2);return require('../helpers/codex-offline-response').final(body,calls,'The requested product is prepared and requires your approval.');
  }});cleanup.push(()=>relay.close());
 const transport=relay.grant({candidate:'codex',provider:'openai',task:'offline-business',goalId:held.id,ctx,fundingKey:'fake',authorize:()=>gateway.authorize(),wireProfile:'codex',requestGate:()=>session.codexRequest()});
 process.env.STOCKCHIEF_CODEX_SDK_DEMO='1';t.after(()=>{delete process.env.STOCKCHIEF_CODEX_SDK_DEMO;});
 const options={candidate:'codex',budget,transport,credentials:{openai:'FAKE'},offlineOnly:true,
  codexImage:JSON.parse(fs.readFileSync(path.join(artifactDirectory,'runtime.json'))).image,
  session,gateway,browser:{act:async()=>{throw Error('Unused browser in protocol test');}}};
 const result=await require(base+'worker').run(options);assert(!result.interruption,JSON.stringify(result));assert.equal(calls,1);
 assert.equal(result.completionSource,'durable_approval_handoff');assert.equal(result.approvals.length,1);
 const proposal=(await db.query("SELECT * FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND status='PENDING'",[ctx.workspaceId])).rows[0];assert(proposal);
 const count=async()=>Number((await db.query('SELECT count(*) AS n FROM items WHERE workspace_id=$1 AND base_code=$2',[ctx.workspaceId,sku])).rows[0].n);
 assert.equal(await count(),0,'SDK tool permission must not approve the business proposal');
 const replay=await session.handoffApprovals();assert.equal(replay.approvals[0].id,result.approvals[0].id);
 assert.equal((await goals.get(db,ctx,held.id)).status,'WAITING_APPROVAL');
 // Explicit simulated human approval is test-only, outside the agent's tools.
 await require('../../src/assistant/postgres-service').executeProposal(db,ctx,proposal.id);
 await require(base+'waits').refresh(db,ctx,held.id);held=await goals.claim(db,ctx,held.id);assert(held);
 ({session,gateway}=attach(async client=>{
  const rows=(await client.query('SELECT id,name,base_code FROM items WHERE workspace_id=$1 AND base_code=$2',[ctx.workspaceId,sku])).rows;
  return rows.length===1&&rows[0].name===name?{complete:true,answer:'The approved product was created and independently verified.',evidence:[{table:'items',id:rows[0].id}]}:null;
 }));
 const final=await require(base+'worker').run({...options,session,gateway});
 assert.equal(final.completionSource,'host_verified_receipt');assert.equal(await count(),1);assert.equal(calls,1);
 assert.equal((await goals.get(db,ctx,held.id)).status,'COMPLETED');
 const evidence={mode:'OFFLINE_SYNTHETIC_PROVIDER',paidCalls:0,modelRequests:calls,simulatedApprovals:1,realHumanApprovals:0,
  beforeApprovalItems:0,afterApprovalItems:1,idempotentReplay:true,verifiedReportingWithoutModel:true,goalStatus:'COMPLETED'};
 fs.writeFileSync(path.join(artifactDirectory,'offline-business-result.json'),JSON.stringify(evidence,null,2));
});

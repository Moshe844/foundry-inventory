'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('native chat supports exact individual or full-mission approval, with durable scope and canonical verification',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','FOUNDRY_DATABASE_URL'];
 const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(async()=>{await db.close();await cluster.stop();for(const [k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',name='Mission review '+randomUUID();
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Reviewer',businessName:name,email,password:'Offline!'+randomUUID()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};process.env.STOCKCHIEF_RUNTIME_ENV='staging';
 Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:name,emails:[email]})).environment);
 process.env.FOUNDRY_DATABASE_URL=cluster.connectionString;
 await db.query(`UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=1000000,approval_reference='OFFLINE ONLY' WHERE workspace_id=$1`,[ctx.workspaceId]);
 await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
 const store=require('../../src/assistant/postgres-goal-store'),pilot=require('../../src/assistant/postgres-codex-pilot'),handoff=require('../../scripts/environment-agent-demo/approval-handoff');
 const noModel={name:'openai',model:'gpt-6.1-sol',complete:async()=>{throw Error('NO_PAID_CALLS');}};
 async function prepared(steps){
  let goal=await store.create(db,ctx,'Apply the changes stated in this offline fixture.');goal=await store.claim(db,ctx,goal.id);
  await db.query(`UPDATE stockchief_runtime.assistant_goals SET checkpoint=checkpoint||'{"runtime":"codex-staging"}'::jsonb WHERE id=$1`,[goal.id]);
  const gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:'Apply the changes stated in this offline fixture.',goalId:goal.id,runToken:goal.run_token,provider:noModel});
  await require('../../scripts/environment-agent-demo/session').createSession({database:db,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:gateway.authorize}).load();
  const result=await gateway.operate({steps:steps.map(({args,...step})=>({...step,arguments:Object.entries(args).map(([name,value])=>({name,value:String(value)}))}))});
  await db.query(`UPDATE stockchief_runtime.assistant_goals SET checkpoint=jsonb_set(checkpoint,'{harness,calls}',$2::jsonb) WHERE id=$1`,[goal.id,JSON.stringify({fixture:{state:'DONE',result}})]);
  await handoff.inbox(db,ctx,goal.id,{pause:true,runToken:goal.run_token});
  const card=(await pilot.inbox(db,ctx,goal.id)).approvals[0];assert.equal(card.mission.count,steps.length);
  return {goal,card};
 }
 const codes=[];
 for(let i=0;i<2;i++){const code='Q-'+randomUUID().slice(0,8);codes.push(code);await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Quote item '+i,baseCode:code,trackingMode:'quantity'});}
 const {goal,card}=await prepared(codes.map((sku,i)=>({capability:'catalog.set_purchase_cost',args:{sku,amount:25+i,currency:'USD'},dependsOn:[]})));
 const initialCards=(await pilot.inbox(db,ctx,goal.id)).approvals;
 assert.equal(initialCards.length,2,'Every independent explicit-approval change must be prepared before the owner reviews the complete request');
 assert(initialCards.every(c=>c.proposal.status==='PENDING'));
 assert.equal((await db.query('SELECT count(*)::int n FROM sku_purchase_costs WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0,'Preparing the complete review executes no effect');
 const scope={kind:'mission',id:card.mission.id,sha256:card.mission.sha256},decision={source:'human_user',approved:true,responseReference:'OFFLINE EXACT REVIEW',scope};
 const missionBefore=(await db.query('SELECT * FROM stockchief_runtime.assistant_capability_plans WHERE id=$1',[scope.id])).rows[0];
 const html=await require('ejs').renderFile(require('node:path').join(__dirname,'../../src/web/views/attention/postgres-proposal.ejs'),{
  proposal:card.proposal,presentation:require('../../src/web/proposal-presentation').present(card.proposal),mission:missionBefore,nativeApproval:{goalId:goal.id,...card},csrfToken:'offline-csrf',helpers:require('../../src/web/view-helpers'),resumeAvailable:false,
 });
 assert(html.includes('Approve all remaining changes'));assert(html.includes('Approve only this change'));assert(html.includes('name="scope" value="mission"'));assert(html.includes('name="missionHash" value="'+scope.sha256+'"'));
 assert(!html.includes('action="/actions/'+card.proposalId+'/approve-mission"'),'native review must use the durable signed chat handoff');
 await assert.rejects(pilot.decide(db,ctx,goal.id,card.id,card.sha256,true,{responseReference:'OFFLINE',missionScope:{...scope,sha256:'stale'}}),/CHANGED/);
 await assert.rejects(pilot.inbox(db,{...ctx,actorId:'foreign-user'},goal.id));
 await assert.rejects(handoff.decide({database:db,ctx,goalId:goal.id,id:card.id,sha256:card.sha256,decision,execute:async()=>{throw Error('DISCONNECTED_BEFORE_EXECUTION');}}),/DISCONNECTED/);
 assert.deepEqual((await store.get(db,ctx,goal.id)).checkpoint.harness.approvalDeliveries[card.id].decision.scope,scope);
 const revised=structuredClone(missionBefore.approved_steps);revised[1].args.amount=500;
 await db.query('UPDATE stockchief_runtime.assistant_capability_plans SET approved_steps=$2::jsonb,plan_hash=$3 WHERE id=$1',[scope.id,JSON.stringify(revised),require('../../src/assistant/postgres-capability-plans').planHash(revised)]);
 await assert.rejects(pilot.decide(db,ctx,goal.id,card.id,card.sha256,true,{responseReference:decision.responseReference,missionScope:scope}),/CHANGED/);
 await db.query('UPDATE stockchief_runtime.assistant_capability_plans SET approved_steps=$2::jsonb,plan_hash=$3 WHERE id=$1',[scope.id,JSON.stringify(missionBefore.approved_steps),scope.sha256]);
 await assert.rejects(pilot.decide(db,ctx,goal.id,card.id,card.sha256,true,{responseReference:'OFFLINE DIFFERENT SCOPE'}),/CONFLICT/);
 // Interrupted after canonical authorization, before the first operation.
 await require('../../src/assistant/postgres-capability-plans').authorize(db,ctx,card.proposalId,{expectedHash:scope.sha256,expectedId:scope.id});
 const resumedCard=(await pilot.inbox(db,ctx,goal.id)).approvals[0];assert.equal(resumedCard.mission.sha256,scope.sha256);assert.deepEqual(resumedCard.decision.scope,scope);
 await pilot.decide(db,ctx,goal.id,card.id,card.sha256,true,{responseReference:decision.responseReference,missionScope:scope});
 const mission=(await db.query('SELECT * FROM stockchief_runtime.assistant_capability_plans WHERE id=$1',[scope.id])).rows[0];
 assert.equal(mission.authorization_mode,'MISSION');assert.equal(mission.status,'DONE');assert.equal(mission.verification_status,'VERIFIED');
 assert.equal(mission.metrics.approvalInteractions,1,'resumption is not another human approval');
 const reviewed=(await db.query('SELECT id,status FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1',[ctx.workspaceId])).rows;
 assert.equal(reviewed.length,2,'Recovery must not create duplicate or orphan proposals');
 assert.deepEqual(new Set(reviewed.map(p=>p.id)),new Set(initialCards.map(c=>c.proposalId)));
 assert(reviewed.every(p=>p.status==='EXECUTED'));
 const recordedGoal=await store.get(db,ctx,goal.id),actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 const catalogue=await require('../../src/assistant/postgres-control-plane').planningCatalogue(db,ctx,actor);
 const receipt=await require('../../scripts/environment-agent-demo/receipts').collect(db,ctx,recordedGoal,recordedGoal.checkpoint.harness,catalogue);
 assert(receipt.humanDecisions.some(d=>d.source==='human_user'&&d.decision==='approved'&&d.scope.kind==='mission'&&d.scope.id===scope.id&&d.scope.sha256===scope.sha256),'Real mission approval must survive canonical execution as native resumption evidence');
 const quotes=(await db.query('SELECT amount_minor FROM sku_purchase_costs WHERE workspace_id=$1 ORDER BY amount_minor',[ctx.workspaceId])).rows;
 assert.deepEqual(quotes.map(r=>Number(r.amount_minor)),[2500,2600]);
 await pilot.decide(db,ctx,goal.id,card.id,card.sha256,true,{responseReference:decision.responseReference,missionScope:scope});
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM sku_purchase_costs WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),2);
 const names=['North '+randomUUID(),'West '+randomUUID()];
 const individual=await prepared(names.map(recipient=>({capability:'contact.create',args:{recipient,recipientKind:'supplier'},dependsOn:[]})));
 await pilot.decide(db,ctx,individual.goal.id,individual.card.id,individual.card.sha256,true,{responseReference:'OFFLINE INDIVIDUAL APPROVAL'});
 const remaining=await pilot.inbox(db,ctx,individual.goal.id);assert.equal(remaining.approvals.length,1);assert.notEqual(remaining.approvals[0].id,individual.card.id);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM suppliers WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),1,'individual approval never authorizes the rest');
 const dependent=await prepared(codes.map((sku,i)=>({capability:'catalog.set_purchase_cost',args:{sku,amount:35+i,currency:'USD'},dependsOn:i?[0]:[]})));
 assert.equal((await pilot.inbox(db,ctx,dependent.goal.id)).approvals.length,1,'A real declared dependency still waits for its prior effect');
 const dependentPlan=(await db.query('SELECT steps FROM stockchief_runtime.assistant_capability_plans WHERE id=$1',[dependent.card.mission.id])).rows[0];
 assert.equal(dependentPlan.steps[1].reason,'dependency_waiting');
 const newLocation='Independent bay '+randomUUID(),newSupplier='Independent supplier '+randomUUID();
 const separate=await prepared([{capability:'location.create',args:{location:newLocation},dependsOn:[]},{capability:'contact.create',args:{recipient:newSupplier,recipientKind:'supplier'},dependsOn:[]}]);
 assert.equal((await pilot.inbox(db,ctx,separate.goal.id)).approvals.length,2,'Complete preparation works across canonical business engines');
 assert.equal((await db.query('SELECT count(*)::int n FROM locations WHERE workspace_id=$1 AND name=$2',[ctx.workspaceId,newLocation])).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM suppliers WHERE workspace_id=$1 AND name=$2',[ctx.workspaceId,newSupplier])).rows[0].n,0);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0);
 // Full approvals must include and execute operations beyond the old transport
 // boundary. This varies entities and scope without teaching any business flow.
 const fullNames=Array.from({length:12},()=> 'Whole mission '+randomUUID());
 const whole=await prepared(fullNames.map(recipient=>({capability:'contact.create',args:{recipient,recipientKind:'supplier'},dependsOn:[]})));
 const wholeScope={kind:'mission',id:whole.card.mission.id,sha256:whole.card.mission.sha256};
 assert.equal((await pilot.inbox(db,ctx,whole.goal.id)).approvals.length,fullNames.length);
 assert.equal((await db.query('SELECT count(*)::int n FROM suppliers WHERE workspace_id=$1 AND name=ANY($2::text[])',[ctx.workspaceId,fullNames])).rows[0].n,0);
 await pilot.decide(db,ctx,whole.goal.id,whole.card.id,whole.card.sha256,true,{responseReference:'OFFLINE exact complete review',missionScope:wholeScope});
 assert.equal((await db.query('SELECT count(*)::int n FROM suppliers WHERE workspace_id=$1 AND name=ANY($2::text[])',[ctx.workspaceId,fullNames])).rows[0].n,fullNames.length);
 await pilot.decide(db,ctx,whole.goal.id,whole.card.id,whole.card.sha256,true,{responseReference:'OFFLINE exact complete review',missionScope:wholeScope});
 assert.equal((await db.query('SELECT count(*)::int n FROM suppliers WHERE workspace_id=$1 AND name=ANY($2::text[])',[ctx.workspaceId,fullNames])).rows[0].n,fullNames.length);
});

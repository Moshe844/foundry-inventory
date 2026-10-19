'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('recorded settled negative review rejects without repeated observations; every possible completion still verifies current facts',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Review timing',businessName:'Offline verification',email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Unfamiliar shelf '+randomUUID(),kind:'warehouse'}),store=require('../../src/assistant/postgres-goal-store');
 const goal=await store.claim(db,ctx,(await store.create(db,ctx,'Name a current warehouse and determine whether earlier stopped work can continue. Change nothing.')).id);
 const gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:goal.original_request,goalId:goal.id,runToken:goal.run_token}),session=require('../../scripts/environment-agent-demo/session').createSession({database:db,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:gateway.authorize});
 const input={steps:[{capability:'read.locations',arguments:[],dependsOn:[]}]},observation=await session.executePresented('business_operations',input,()=>gateway.operate(input),{full:true}),row=observation.outcomes[0].result.rows.find(r=>r.name===location.name);
 const saved=await store.get(db,ctx,goal.id),catalogue=(await gateway.authorize()).catalogue,review=require('../../src/assistant/native-answer-review'),verifier=require('../../src/assistant/postgres-codex-verification');
 const report={version:1,status:'completed',outcome:'answer',answer:'Recorded warehouse: '+location.name+'. The earlier stopped request can safely continue.',claims:[{sourceRef:row[observation._stockchiefSources.valueField].name,value:row.name}],workProducts:[],nextActions:[]},raw=JSON.stringify(report);
 const settled={version:review.version,hash:review.binding(saved,raw).hash,state:'SETTLED',verdict:{grounded:true,complete:false,missingOutcomes:['Verified whether earlier stopped work can continue'],reason:'Its saved status and lack of effects do not establish continuation eligibility.'}};
 saved.checkpoint.harness.answerScopeReview=settled;
 const forbidden={query:async()=>{throw Error('REJECTED_FINAL_MUST_NOT_REPEAT_CURRENT_READS');},transaction:async()=>{throw Error('REJECTED_FINAL_MUST_NOT_START_TRANSACTION');}};
 for(const candidate of [saved,JSON.parse(JSON.stringify(saved))]){const result=await verifier.verifyFinal(forbidden,ctx,candidate,raw,catalogue,{browser:{verifyObservation:async()=>{throw Error('REJECTED_FINAL_MUST_NOT_REOPEN_SCREEN');}}});assert.equal(result.verified,false);assert.equal(result.verificationFailure,'ANSWER_SCOPE_UNVERIFIED');assert(!Object.hasOwn(result,'receipt'));}
 // The skipped reads only reject. Positive or unreviewed finals must still
 // re-read business truth; no stale fact becomes deliverable.
 await db.query('UPDATE locations SET name=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,location.id,'Changed '+randomUUID()]);
 for(const change of [h=>{h.answerScopeReview={...settled,verdict:{grounded:true,complete:true,missingOutcomes:[],reason:''}};},h=>{delete h.answerScopeReview;},h=>{h.answerScopeReview={...settled,version:1};},h=>{h.answerScopeReview={...settled,hash:'mismatched'};},h=>{h.answerScopeReview={...settled,verdict:{grounded:true}};}]){const candidate=structuredClone(saved);change(candidate.checkpoint.harness);const result=await verifier.verifyFinal(db,ctx,candidate,raw,catalogue);assert.equal(result.verified,false);assert.equal(result.verificationFailure,'CURRENT_RECORDS_CHANGED');}
 const invalid=JSON.stringify({...report,claims:[{sourceRef:'fv1:ABCDEFGHIJKLMNOP',value:'unknown'}]});assert.equal((await verifier.verifyFinal(db,ctx,saved,invalid,catalogue)).verificationFailure,'SOURCE_REFERENCE_NOT_FOUND');
 // A canonical dependency bypasses semantic scope review and must retain its
 // own authority/receipt checks even if an old negative verdict was persisted.
 const dependent=structuredClone(saved);dependent.checkpoint.harness.calls.extra={state:'DONE',result:{missionId:'missing-mission'}};const canonical=await verifier.verifyFinal(db,ctx,dependent,raw,catalogue);assert.equal(canonical.verified,false);assert.notEqual(canonical.verificationFailure,'ANSWER_SCOPE_UNVERIFIED');assert.equal(canonical.receipt.dependencyState,'BLOCKED');
 const question=await verifier.verifyFinal(db,ctx,saved,JSON.stringify({status:'needs_user',question:'Which location should be used?',missingInformation:['Location']}),catalogue);assert.equal(question.verified,false);assert.equal(question.report.status,'needs_user');
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls')).rows[0].n,'0');assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_action_proposals')).rows[0].n,'0');
 t.diagnostic(JSON.stringify({recordedWastedReverificationMs:[4591,8209],settledRejectionMakesNoFreshReads:true,positiveOrUnboundReviewChecksFreshTruth:true,invalidReferencesPreserved:true,canonicalDependenciesRemainFailClosed:true,paidCalls:0,notLiveModelProof:true}));
});

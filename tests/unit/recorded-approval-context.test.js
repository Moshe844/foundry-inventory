'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),handoff=require('../../scripts/environment-agent-demo/approval-handoff');
test('only exact persisted human decisions become resumption evidence after a prepare-only request',async()=>{
 const proposal={id:'recorded-proposal',action_type:'location.create',source_message:'Prepare an empty warehouse, but do not execute.',idempotency_key:'recorded-operation',payload:{name:'Test annex',kind:'warehouse'},summary:'Create the reviewed test annex.',status:'PENDING'};
 const h={calls:{prepared:{state:'DONE',result:{outcomes:[{result:{proposal:{id:proposal.id}}}]}}}},ctx={workspaceId:'test-business',actorId:'test-owner'},goal={id:'test-goal'};
 const client={query:async sql=>({rows:sql.includes('assistant_action_proposals')?[proposal]:[]})};
 const [card]=await handoff.stage(client,ctx,goal,h);assert(card);h.approvalDeliveries[card.id].decision={source:'human_user',approved:true,at:'2026-10-16T12:27:00.000Z',responseReference:'Authenticated test-user approval'};
 proposal.status='EXECUTED';proposal.executed_at='2026-10-16T12:27:00.100Z';proposal.result={id:'created-location'};
 const receipts=require('../../scripts/environment-agent-demo/receipts'),catalogue={list:()=>[{name:'location.create'}]},collect=async harness=>receipts.collect(client,ctx,{...goal,original_request:proposal.source_message},harness,catalogue);
 const receipt=await collect(h);
 assert.equal(receipt.humanDecisions?.length,1,'Recorded live failure: resumption has an execution receipt but no authenticated human approval evidence');
 const decision=receipt.humanDecisions[0];assert.equal(decision.source,'human_user');assert.equal(decision.decision,'approved');assert.equal(decision.proposalId,proposal.id);assert.equal(decision.reviewedRevision,card.sha256);assert.equal(decision.decidedAt,'2026-10-16T12:27:00.000Z');
 assert.equal(decision.scope.kind,'proposal');assert(!JSON.stringify(decision).includes('responseReference'));
 const injected=structuredClone(h);injected.approvalDeliveries[card.id].decision.source='model';assert.deepEqual((await collect(injected)).humanDecisions,[]);
 proposal.payload.name='Changed after review';assert.deepEqual((await collect(h)).humanDecisions,[]);proposal.payload.name='Test annex';
 const noDecision=structuredClone(h);delete noDecision.approvalDeliveries[card.id].decision;assert.deepEqual((await collect(noDecision)).humanDecisions,[]);
 const stale=structuredClone(h);stale.approvalDeliveries[card.id].decision.at='invalid';assert.deepEqual((await collect(stale)).humanDecisions,[]);
});
test('a rule approval remains scoped human context and never becomes proof of an executed trigger',async()=>{
 const proposal={id:'reviewed-rule',summary:'Reviewed persistent warning',status:'PENDING',stated_as:'Prepare this warning without activating it.',resolved_changes:[{kind:'warning'}],integrity_hash:'reviewed-rule-integrity'};
 const h={calls:{prepared:{state:'DONE',result:{outcomes:[{result:{proposal:{id:proposal.id}}}]}}}},ctx={workspaceId:'test-business',actorId:'test-owner'},goal={id:'rule-goal',original_request:proposal.stated_as};
 const client={query:async sql=>({rows:sql.includes('operating_instruction_proposals')?[proposal]:[]})};
 const [card]=await handoff.stage(client,ctx,goal,h);assert.equal(card.kind,'rule');h.approvalDeliveries[card.id].decision={source:'human_user',approved:true,at:'2026-10-16T12:27:00.000Z',responseReference:'Authenticated rule approval'};proposal.status='APPROVED';
 const receipt=await require('../../scripts/environment-agent-demo/receipts').collect(client,ctx,goal,h,{list:()=>[]});
 assert.equal(receipt.humanDecisions.length,1);assert.equal(receipt.humanDecisions[0].decision,'approved');assert.deepEqual(receipt.operations,[],'Saving/approving a rule is not proof of its trigger');
});

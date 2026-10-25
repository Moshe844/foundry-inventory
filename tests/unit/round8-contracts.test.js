'use strict';const test=require('node:test'),assert=require('node:assert/strict');
test('relative dates accept human labels and resolve month boundaries without using the host zone',()=>{
 const relative=require('../../src/reports/relative-dates'),calendar={calendarDate:'2028-02-29',timeZone:'Pacific/Auckland'};
 assert.deepEqual(relative.bounds(' Last 7 days ',calendar),{from:'2028-02-23',to:'2028-02-29'});assert.deepEqual(relative.bounds('this month',calendar),{from:'2028-02-01',to:'2028-02-29'});assert.equal(relative.normalize('This week'),'this_week');
});
test('native report creation accepts structured governed definition and schedule without a second model',()=>{
 const c=require('../../src/assistant/postgres-capability-registry');assert(c.registry.get('report.template.create').fields.includes('reportDefinition'));assert(c.FIELDS.reportDefinition);assert(c.registry.get('settings.ask_preferences'));assert(c.registry.get('read.ask_preferences'));
});
test('presentation preferences work independently from language and cannot grant action authority',()=>{
 const p=require('../../src/assistant/postgres-answer-preferences');assert.match(p.instructions({answerLanguage:null,answerStyle:'Short bullet points'}),/Short bullet points/);assert.match(p.instructions({answerLanguage:'he',answerStyle:'Concise'}),/Hebrew/);assert.match(p.instructions({answerStyle:'Concise'}),/no authority/i);
});
test('current-inventory export includes major-unit selling price and preserves currency-specific rounding',()=>{
 const sql=require('../../src/operations/postgres-export-stream').queries(null)[0][1];assert.match(sql,/AS "Selling price"/);assert.match(sql,/currency/i);assert.match(sql,/sku_prices/);
});
test('order presentation distinguishes cancelling the remainder from cancelling an unshipped order',()=>{
 const labels=require('../../src/sales/order-status');assert.equal(labels.label('CANCELLED',3),'Partly shipped · remainder cancelled');assert.equal(labels.label('CANCELLED',0),'Cancelled');assert.equal(labels.label('FULFILLED',3),'Delivered');
});
test('Ask displays only its actually effective temporary cap while preserving standard limits and credit blocks',()=>{
 const {forAsk}=require('../../src/commercial/ai-spending-limits'),base={accountMinor:12106,workspaceMinor:2000,accountCapMinor:10000,workspaceCapMinor:10000,paused:true,creditsBlocked:false,nativeTestAllowance:{available:true,maximumMinor:14500}};const state=forAsk(base);assert.equal(state.accountCapMinor,14500);assert.equal(state.standardAccountCapMinor,10000);assert.equal(state.paused,false);assert.equal(state.warning,true);assert.equal(base.accountCapMinor,10000);assert.equal(state.blocked,false); const exhausted=forAsk({...base,accountMinor:14800,nativeTestAllowance:{available:false,maximumMinor:14500}});assert.equal(exhausted.paused,true);assert.equal(exhausted.accountCapMinor,14500);assert.equal(forAsk({...base,creditsBlocked:true}).paused,true);
});
test('unverified or interrupted work uses ordinary recovery wording without claiming the change succeeded',()=>{
 const conversation=require('../../src/assistant/agent-conversation');for(const harness of [{interruption:{code:'OPERATION_INTERRUPTED'}},{verificationFailure:{code:'OUTCOME_UNVERIFIED'}}]){const state=conversation.state({id:'fixture-goal',status:'BLOCKED',answer:'An operation was interrupted. Reconcile its canonical records before retrying.',checkpoint:{harness}});assert.doesNotMatch(state.message,/canonical/);assert.match(state.message,/saved|retained/);assert.equal(state.active,false);assert.equal(state.canReply,false);}
});

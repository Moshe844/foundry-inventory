'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const acceptance=require('../../src/assistant/postgres-supplier-acceptance');

function fixture(overrides={}){
  const order={id:'po-1',po_number:'PO-1',supplier_id:'supplier-1',status:'APPROVED',...overrides.order};
  const sent={id:'message-1',supplier_id:'supplier-1',recipient:'supplier@example.test',
    connector_id:'mailbox-1',subject:'Purchase order',body:'Please accept this purchase order.',
    status:'SENT',external_message_id:'external-sent-1',external_thread_id:'thread-1',
    sent_at:'2026-10-11T12:00:00Z',...overrides.sent};
  const replies=overrides.replies||[{id:'reply-1',sender:'supplier@example.test',subject:'Re: Purchase order',
    body_text:'We accept this purchase order without changes.',received_at:'2026-10-11T12:01:00Z'}];
  const database={async query(sql){
    if(sql.includes('FROM purchase_orders'))return {rows:order?[order]:[]};
    if(sql.includes('COUNT(*)::int AS count FROM supplier_communications'))return {rows:[{count:1}]};
    if(sql.includes('FROM supplier_communications'))return {rows:sent?[sent]:[]};
    if(sql.includes('FROM connection_email_messages'))return {rows:replies};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const steps=[{capability:'purchase_order.create',state:'DONE',dependsOn:[],args:{recordReference:'po-1'}},
    {capability:'communication.send_email',state:'WAITING_EVENT',dependsOn:[0],
      args:{supplierAcceptance:'required'}},
    {capability:'purchase_order.place',state:'BLOCKED',dependsOn:[1],args:{}}];
  const result={communicationId:'message-1',communicationKind:'supplier'};
  return {database,steps,result};
}

test('supplier acceptance needs a matching reply and preserves exact evidence',async()=>{
  const f=fixture();
  const provider={async complete(request){
    assert.equal(request.schemaName,'stockchief_supplier_acceptance');
    const data=JSON.parse(request.prompt);
    assert.equal(data.purchaseOrder.number,'PO-1');
    assert.equal(data.supplierReplies.length,1);
    return {data:{decision:'ACCEPTED',messageId:'reply-1',
      evidenceQuote:'We accept this purchase order',changedTerms:false}};
  }};
  const outcome=await acceptance.evaluate(f.database,'workspace-1',f.result,f.steps,1,provider);
  assert.equal(outcome.state,'DONE');
  assert.equal(outcome.evidence.replyMessageId,'reply-1');
  assert.equal(outcome.evidence.externalThreadId,'thread-1');
});

test('delivery or an absent reply cannot place the PO',async()=>{
  const f=fixture({replies:[]});
  const outcome=await acceptance.evaluate(f.database,'workspace-1',f.result,f.steps,1,null);
  assert.equal(outcome.state,'WAITING_EVENT');
  assert.equal(outcome.condition.kind,'supplier_acceptance');
});

test('quoted earlier acceptance is not new supplier evidence',async()=>{
  const f=fixture({replies:[{id:'reply-1',sender:'supplier@example.test',subject:'Re: Purchase order',
    body_text:'We are checking.\nOn Friday someone wrote:\n> We accept this purchase order',
    received_at:'2026-10-11T12:01:00Z'}]});
  const provider={async complete(){return {data:{decision:'ACCEPTED',messageId:'reply-1',
    evidenceQuote:'We accept this purchase order',changedTerms:false}};}};
  const outcome=await acceptance.evaluate(f.database,'workspace-1',f.result,f.steps,1,provider);
  assert.equal(outcome.state,'WAITING_EVENT');
  assert.equal(outcome.reason,'supplier_reply_unclear');
});

test('changed supplier terms or missing provider identity blocks placement',async()=>{
  const f=fixture();
  const provider={async complete(){return {data:{decision:'ACCEPTED',messageId:'reply-1',
    evidenceQuote:'We accept this purchase order',changedTerms:true}};}};
  const changed=await acceptance.evaluate(f.database,'workspace-1',f.result,f.steps,1,provider);
  assert.equal(changed.state,'BLOCKED');
  assert.equal(changed.reason,'supplier_terms_changed');
  const missing=fixture({sent:{external_thread_id:null}});
  const noThread=await acceptance.evaluate(missing.database,'workspace-1',missing.result,
    missing.steps,1,provider);
  assert.equal(noThread.state,'BLOCKED');
  assert.equal(noThread.reason,'supplier_acceptance_evidence_unverified');
});

test('assessment outage holds the mission without inventing acceptance',async()=>{
  const f=fixture();
  const provider={async complete(){throw Object.assign(new Error('unavailable'),{code:'upstream_unavailable'});}};
  const outcome=await acceptance.evaluate(f.database,'workspace-1',f.result,f.steps,1,provider);
  assert.equal(outcome.state,'WAITING_EVENT');
  assert.equal(outcome.reason,'supplier_acceptance_assessment_unavailable');
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),protocol=require('../../src/operations/agent-mail-protocol');
test('scoped mail requires its registered authority-specific worker instead of the generic published worker',()=>{
 for(const name of ['stock_threshold','purchase_followup','shipment_notice','quote_followup','quote_share','customer_statement','invoice_reminder','stock_ready_notice','invoice_dispute','supplier_forecast']){const effect={kind:'mail.outbound.send',payload:{standingAuthority:{kind:name}}},kind=protocol.jobKind(effect);assert(protocol.kinds.includes(kind));assert.notEqual(kind,'provider.effect');assert.doesNotThrow(()=>protocol.assertJob(effect,kind));assert.throws(()=>protocol.assertJob(effect,'provider.effect'),e=>e.code==='incompatible_agent_mail_worker'&&e.retryable===false);}
});
test('unsupported or missing authority kinds cannot fall back to a worker that ignores their checks',()=>{
 for(const name of ['unreleased_future_authority','__proto__','',null,undefined])assert.throws(()=>protocol.jobKind({kind:'mail.outbound.send',payload:{standingAuthority:{kind:name}}}),e=>e.code==='unsupported_agent_mail_authority'&&e.retryable===false);
});
test('ordinary owner mail and other provider operations retain their existing worker',()=>{
 assert.equal(protocol.jobKind({kind:'mail.outbound.send',payload:{}}),'provider.effect');assert.equal(protocol.jobKind({kind:'shipping.label.purchase',payload:{}}),'provider.effect');assert.equal(protocol.jobKind({kind:'mail.reply.send',payload:{}}),'provider.effect');
});

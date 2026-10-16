'use strict';
// The same immutable revision is used for delivery, human decisions and reads.
// Pure functions only: inspecting a revision cannot stage or approve anything.
const {createHash}=require('node:crypto');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
function snapshot(kind,p){return {kind,proposalId:p.id,action:p.action_type||'policy.propose',summary:p.summary,
 authorityReference:kind==='business'?{sourceMessage:p.source_message,idempotencyKey:p.idempotency_key}:{statedAs:p.stated_as},
 payload:kind==='business'?p.payload:{resolvedChanges:p.resolved_changes,integrityHash:p.integrity_hash}};}
module.exports={digest,snapshot};

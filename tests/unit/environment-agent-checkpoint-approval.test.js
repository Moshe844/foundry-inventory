'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../../scripts/environment-agent-demo/checkpoint-approval');
test('checkpoint approval reads serialized canonical rules and refuses broader authority',async()=>{
 const change={domain:'stock_alert',operation:'set',skuId:'sku',locationId:'depot',notificationThreshold:14,
  notificationMetric:'on_hand',notificationComparator:'at_or_below'};
 const db={query:async sql=>({rows:sql.includes('assistant_action_proposals')?[]:[{id:'proposal',resolved_changes:JSON.stringify([change])}]})};
 const pending=await policy.pending(db,{workspaceId:'w',actorId:'a'});
 const f={task:{kind:'rule',threshold:14},product:{skuIds:['sku']},warehouse:{id:'depot'}};
 assert.equal(await policy.permits(db,f,pending[0]),true);
 assert.equal(await policy.permits(db,f,{...pending[0],payload:[change,{domain:'purchase_authority'}]}),false);
 assert.equal(await policy.permits(db,f,{...pending[0],payload:[{...change,locationId:'elsewhere'}]}),false);
});

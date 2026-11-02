'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{cards,status}=require('../../src/web/presentation/connections');
test('connection cards separate account authorization, matching work and actual sync time',()=>{
 const catalog=[{type:'unfamiliar-provider',name:'A provider'}],row={id:'connection-one',provider_type:catalog[0].type,status:'connected',setup_status:'MAPPING',itemsNeedingMapping:4,last_activity_at:'2026-05-02T14:00:00Z',last_synced_at:'2026-05-01T13:00:00Z'};
 const card=cards(catalog,[row])[0];assert.equal(card.state,'Connected');assert.equal(card.needsMatching,4);assert.equal(card.lastSync,row.last_synced_at);assert.equal(card.action,'Manage');assert.equal(card.href,'/settings/connections/connection-one');assert.equal(cards(catalog,[])[0].state,'Not connected');assert.equal(cards(catalog,[{...row,last_synced_at:null}])[0].lastSync,null);
});
test('reauthorization failures are errors while retained disconnected history is not an active account',()=>{
 assert.equal(status({status:'connected',setup_status:'REAUTHORIZATION_REQUIRED'}),'Error');assert.equal(status({status:'error'}),'Error');assert.equal(status({status:'disconnected'}),'Not connected');const catalog=[{type:'neutral'}];assert.equal(cards(catalog,[{id:'old',provider_type:'neutral',status:'disconnected'}])[0].href,null);
});

test('registered providers use their declared category without hiding unfamiliar names or bypassing the category entitlement',()=>{
 const cp=require('../../src/web/presentation/connections'),providers=[{type:'fixture_oauth',name:'Unfamiliar Books',category:'accounting'},{type:'unfamiliar_mail',category:'communication'},{type:'stock_feed',category:'business'},{type:'contract_erp',category:'business',integrationMode:'custom_contract'}],groups=cp.groups(providers);
 assert(groups.find(g=>g.title==='Accounting').types.includes('fixture_oauth'));assert(groups.find(g=>g.title==='Email').types.includes('unfamiliar_mail'));assert(groups.find(g=>g.title==='Other business systems').types.includes('stock_feed'));assert(!groups.some(g=>g.types.includes('contract_erp')));
 assert.deepEqual(cp.access(providers[0]),{capability:'connections.accounting',commercial:'connection.accounting'});assert.equal(cp.access(providers[1]).commercial,'connection.email');assert.equal(cp.access({type:'stripe'}).commercial,'payments.customer');
});

'use strict';const test=require('node:test'),assert=require('node:assert/strict'),presentation=require('../../src/web/presentation/connections');
test('connected rows and cards share health, actionable errors and provider labels',()=>{
 const c={id:'unfamiliar-connection',provider_type:'square',status:'connected',publicStatus:'Needs attention',last_synced_at:new Date().toISOString(),display_name:'\u200b',setup_status:'CONNECTED'};
 assert.equal(presentation.status(c),'Error');assert.equal(presentation.cards([{type:'square',name:'Square'}],[c])[0].state,presentation.status(c));assert(presentation.issue(c));assert.equal(presentation.historyLabel(c),'Square · Error');
 assert.equal(presentation.status({...c,publicStatus:'Connected'}),'Connected');assert.equal(presentation.status({...c,status:'disconnected',publicStatus:'Disconnected'}),'Not connected');assert.equal(presentation.logo('shipstation_custom_store'),'shipstation');
});
test('every connection description is a complete short sentence and production does not offer test apps',()=>{
 for(const provider of require('../../src/connections/providers/registry').catalog()){const text=presentation.description(provider);assert(text.length<=60);assert(!text.endsWith('…'));assert(/[.!]$/.test(text));}
 assert.equal(presentation.availableForCustomer({type:'square',sandboxMode:true},'production'),false);assert.equal(presentation.availableForCustomer({type:'clover',sandboxMode:true},'staging'),true);assert.equal(presentation.availableForCustomer({type:'square',sandboxMode:false},'production'),true);
});

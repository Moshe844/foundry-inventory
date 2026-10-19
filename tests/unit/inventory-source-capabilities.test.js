'use strict';const test=require('node:test'),assert=require('node:assert/strict'),registry=require('../../src/connections/providers/registry');
test('inventory source eligibility follows implemented data capabilities, independently of platform category',()=>{
 const capabilities=['products','skus','stock','locations'];
 for(const category of ['selling','accounting','supplier','new-category'])assert.equal(registry.withInventoryCapabilities({type:'unfamiliar-provider',category},{discover:async()=>({products:[]}),catalogueCapabilities:capabilities}).initialInventoryImport,true);
 assert.equal(registry.withInventoryCapabilities({type:'selling-looking-provider',category:'selling'},{discover:async()=>({products:[]})}).initialInventoryImport,false);
 assert.equal(registry.withInventoryCapabilities({type:'unimplemented-provider'},{catalogueCapabilities:capabilities}).initialInventoryImport,false);
 const all=registry.catalog(),sources=registry.inventorySources();assert(sources.length>=4);for(const p of sources){assert(p.initialInventoryImport);assert(p.inventoryCapabilities.includes('products'));assert.equal(typeof registry.get(p.type).discover,'function');}
 for(const type of ['gmail','microsoft365','reference_webhook','erp_future'])assert.equal(all.find(p=>p.type===type).initialInventoryImport,false,type+' is still available in the full integrations directory');
 for(const type of ['quickbooks','xero'])assert.equal(all.find(p=>p.type===type).initialInventoryImport,true,type+' has an implemented item/stock discovery adapter');
 assert(all.some(p=>p.type==='gmail'));assert(all.some(p=>p.type==='quickbooks'));
});

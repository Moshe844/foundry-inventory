'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{hydrate}=require('../../src/imports/postgres-execution-identities');
test('existing imported products skip catalogue binding reads but still resolve prepared locations',async()=>{
 const client={query:async()=>{throw Error('Unexpected catalogue binding read');}},ctx={workspaceId:'workspace'},plan={id:'plan'},page=[{id:'row',parsed:{existingSkuId:'saved-sku',proposedLocationName:'Warehouse'}}];
 assert.equal(await hydrate(client,ctx,plan,page,{locations:{Warehouse:'location'}}),page);assert.equal(page[0].parsed.locationId,'location');
 await assert.rejects(hydrate(client,ctx,plan,page,{}),/prepared source location/);
});
test('mixed imports resolve only new catalogue identities and still reject missing prepared products',async()=>{
 let ids;const client={query:async(sql,args)=>{ids=args[2];return {rows:[{row_id:'new',item_id:'item',sku_id:'sku'}]};}},ctx={workspaceId:'workspace'},plan={id:'plan'},page=[{id:'old',parsed:{existingSkuId:'existing'}},{id:'new',parsed:{}}];
 await hydrate(client,ctx,plan,page,{});assert.deepEqual(ids,['new']);assert.equal(page[0].parsed.existingSkuId,'existing');assert.equal(page[1].parsed.createdSkuId,'sku');assert.equal(page[1].parsed.createdItemId,'item');
 await assert.rejects(hydrate({query:async()=>({rows:[]})},ctx,plan,[{id:'missing',parsed:{}}],{}),/prepared imported product/);
});

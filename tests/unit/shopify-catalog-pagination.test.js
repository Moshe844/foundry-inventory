'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('Shopify discovers legacy fulfillment locations and every inventory page without merging quantities',async()=>{
 const original=global.fetch,calls=[];global.fetch=async(url,options)=>{
  const {query,variables}=JSON.parse(options.body);calls.push(query);
  if(query.includes('CatalogBootstrap'))return Response.json({data:{shop:{currencyCode:'JPY'},productVariants:{nodes:[{id:'variant',title:'Default Title',sku:null,price:'0',selectedOptions:[],product:{id:'product',title:'Fixture',status:'ACTIVE',isGiftCard:false},inventoryItem:{id:'inventory',tracked:true,inventoryLevels:{nodes:[{location:{id:'merchant',name:'Merchant shop',isActive:true},quantities:[{name:'on_hand',quantity:7}]}],pageInfo:{hasNextPage:true,endCursor:'next'}}}}],pageInfo:{hasNextPage:false}}}});
  if(query.includes('InventoryLevelPage')){assert.deepEqual(variables,{id:'inventory',after:'next'});return Response.json({data:{inventoryItem:{inventoryLevels:{nodes:[{location:{id:'service',name:'External fulfillment',isActive:true},quantities:[{name:'on_hand',quantity:3}]}],pageInfo:{hasNextPage:false,endCursor:'last'}}}}});}
  assert.match(query,/includeLegacy:true/);return Response.json({data:{locations:{nodes:[{id:'merchant',name:'Merchant shop',isActive:true},{id:'service',name:'External fulfillment',isActive:true}],pageInfo:{hasNextPage:false}}}});
 };
 try{const result=await require('../../src/connections/providers/shopify').discover({credentials:{shop:'pagination-fixture.myshopify.com',accessToken:'fixture'}});assert.equal(result.locations.length,2);assert.equal(result.products[0].providerData.inventoryItemId,'inventory');assert.deepEqual(result.products[0].providerData.inventoryCounts.map(r=>r.quantity),[7,3]);assert.deepEqual(result.products[0].providerData.priceMoney,{amount:0,currency:'JPY'});assert.equal(calls.length,3);}finally{global.fetch=original;}
});

'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('Square discovery retrieves every bounded catalog-ID batch and stock page',async t=>{
 const original=global.fetch;t.after(()=>{global.fetch=original;});const requests=[];
 global.fetch=async(input,options={})=>{
  const url=new URL(input);
  if(url.pathname==='/v2/locations')return Response.json({locations:[{id:'store',name:'Store'}]});
  if(url.pathname==='/v2/catalog/list')return Response.json({objects:Array.from({length:1001},(_,i)=>({id:'v'+i,type:'ITEM_VARIATION',item_variation_data:{item_id:'parent',sku:'SKU-'+i,track_inventory:true}}))});
  assert.equal(url.pathname,'/v2/inventory/counts/batch-retrieve');const body=JSON.parse(options.body);requests.push(body);assert(body.catalog_object_ids.length<=1000);
  const last=body.catalog_object_ids.length===1;
  return Response.json({counts:[{catalog_object_id:last?'v1000':'v0',location_id:body.cursor?'annex':'store',quantity:body.cursor?'0':'3',state:'IN_STOCK'}],...(!last&&!body.cursor?{cursor:'more-locations'}:{})});
 };
 const result=await require('../../src/connections/providers/square').discover({credentials:{accessToken:'fixture',environment:'sandbox'}});
 assert.equal(requests.length,3);assert.equal(requests[1].cursor,'more-locations');assert.equal(result.products.length,1001);
 assert.deepEqual(result.products[0].providerData.inventoryCounts.map(r=>r.quantity),['3','0']);assert.equal(result.products.at(-1).providerData.inventoryCounts[0].quantity,'3');
});
test('provider quantity notifications trigger the existing refresh path without inventing stock movements',async()=>{
 const square=await require('../../src/connections/providers/square').normalizeWebhook({body:{event_id:'inventory-event',type:'inventory.count.updated',created_at:'2026-01-02T12:00:00Z'}});
 const shopify=require('../../src/connections/providers/shopify').normalizeWebhook({headers:{'x-shopify-topic':'inventory_levels/update','x-shopify-webhook-id':'quantity-event'},body:{inventory_item_id:42,location_id:11,available:0,updated_at:'2026-01-02T12:00:00Z'}});
 for(const events of [square,shopify]){assert.equal(events.length,1);assert.equal(events[0].type,'product.changed');assert.equal(events[0].data.inventoryCountChanged,true);assert.equal(events[0].data.quantity,undefined);}
});

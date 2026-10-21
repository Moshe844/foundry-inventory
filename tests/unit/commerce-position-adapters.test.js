'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {adapter}=require('../../src/connections/providers/commerce-position');
for(const type of ['shopify','square','clover','woocommerce'])test(type+' transport preserves exact zero prices, stock identity and unrelated product fields',async()=>{
 let price={amount:1234,currency:'USD'},quantity=4,writes=[];
 const credentials={merchantId:'merchant',currency:'USD'},input={credentials,externalId:'variant',parentExternalId:type==='woocommerce'?'parent':null,externalLocationId:type==='clover'?'merchant':'location',field:'price'};
 const transport={storeCurrency:async()=> 'USD',graphql:async(q,query,v)=>{
  if(query.startsWith('query'))return {shop:{currencyCode:'USD'},productVariant:{id:'variant',price:(price.amount/100).toFixed(2),product:{id:'product'},inventoryItem:{id:'inventory',tracked:true,inventoryLevel:{quantities:[{name:'available',quantity},{name:'on_hand',quantity:quantity+2}]}}}};
  writes.push({query,v});if(query.includes('SyncPrice')){price={amount:Math.round(Number(v.variants[0].price)*100),currency:'USD'};return {productVariantsBulkUpdate:{userErrors:[]}};}
  assert.equal(v.input.name,'available');assert.equal(v.input.quantities[0].changeFromQuantity,quantity);assert.equal(v.key,'delivery-key');quantity=v.input.quantities[0].quantity;return {inventorySetQuantities:{userErrors:[]}};
 },api:async(q,path,opts={})=>{
  if(type==='square'){
   if(path.startsWith('/v2/catalog/object/')&&!opts.method)return {body:{object:{id:'variant',type:'ITEM_VARIATION',version:42,item_variation_data:{item_id:'product',track_inventory:true,sku:'UNTOUCHED',price_money:price}}}};
   if(path==='/v2/inventory/counts/batch-retrieve')return {body:{counts:[{catalog_object_id:'variant',location_id:'location',state:'IN_STOCK',quantity:String(quantity)}]}};
   const body=JSON.parse(opts.body);writes.push({path,body});assert.equal(body.idempotency_key,'delivery-key');
   if(path==='/v2/catalog/object'){assert.equal(body.object.version,42);assert.equal(body.object.item_variation_data.track_inventory,true);assert.equal(body.object.item_variation_data.sku,'UNTOUCHED');price=body.object.item_variation_data.price_money;}
   else quantity=Number(body.changes[0].physical_count.quantity);return {body:{errors:[]}};
  }
  if(type==='clover'){
   if(!opts.method)return {body:{id:'variant',price:price.amount,priceType:'FIXED',itemStock:{quantity},modifiedTime:42}};
   const body=JSON.parse(opts.body);writes.push({path,body});if(opts.method==='PUT'){assert(path.includes('/item_stocks/'));quantity=body.quantity;}else{assert.deepEqual(Object.keys(body),['price']);price={amount:body.price,currency:'USD'};}return {body:{}};
  }
  if(type==='woocommerce'){
   if(!opts.method)return {body:{id:'variant',type:'variation',status:'publish',manage_stock:true,stock_quantity:quantity,price:(price.amount/100).toFixed(2),sale_price:''}};
   const body=JSON.parse(opts.body);writes.push({path,body});assert.equal(path,'/products/parent/variations/variant');if(Object.hasOwn(body,'regular_price'))price={amount:Math.round(Number(body.regular_price)*100),currency:'USD'};else quantity=body.stock_quantity;return {body:{}};
  }
 }};
 const a=adapter(type,transport);await a.writeSyncPosition({...input,value:{amount:0,currency:'USD'},expected:price,idempotencyKey:'delivery-key'});assert.equal(price.amount,0);
 await a.writeSyncPosition({...input,field:'quantity',value:0,expected:4,idempotencyKey:'delivery-key'});assert.equal(quantity,0);assert.equal(writes.length,2);
 await assert.rejects(a.writeSyncPosition({...input,value:{amount:100,currency:'EUR'},expected:price,idempotencyKey:'delivery-key'}),/currency/);assert.equal(writes.length,2);
 await assert.rejects(a.writeSyncPosition({...input,field:'quantity',value:3,expected:4,idempotencyKey:'delivery-key'}),/changed/);assert.equal(writes.length,2);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const credentials={storeHash:'ab12cd',accessToken:'private-provider-token',currency:'USD',scopes:['store_v2_products','store_inventory']};
const catalogEvents=['store/sku/created','store/sku/updated','store/sku/deleted','store/product/inventory/order/updated','store/sku/inventory/order/updated','store/channel/*/inventory/product/stock_changed','store/channel/*/inventory/product/settings_changed'];
const locationEvents=['store/inventory/location/created','store/inventory/location/updated','store/inventory/location/deleted'];
function response(data){return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});}
function adapter(){return require('../../src/connections/providers/bigcommerce');}
test('BigCommerce subscribes to documented variant, order-driven stock and location changes',async t=>{
 const saved=[];t.mock.method(global,'fetch',async(url,init)=>{if(init.method==='POST'){saved.push(JSON.parse(init.body));return response({data:{id:saved.length}});}return response({data:[],meta:{pagination:{current_page:1,total_pages:1}}});});
 await adapter().registerWebhooks({credentials:{...credentials,webhookSecret:'private-webhook-fixture'},webhookUrl:'https://app.example.test/events'});
 for(const scope of [...catalogEvents,...locationEvents])assert(saved.some(h=>h.scope===scope&&h.is_active&&h.destination==='https://app.example.test/events'));
 assert.equal(new Set(saved.map(h=>h.scope)).size,saved.length);
});
test('BigCommerce variant and location notifications trigger refresh without inventing stock',async()=>{
 for(const scope of [...catalogEvents,...locationEvents,...[7,43,902].flatMap(channel=>['stock_changed','settings_changed'].map(event=>'store/channel/'+channel+'/inventory/product/'+event))]){const body={producer:'stores/ab12cd',scope,hash:'hash-'+scope,created_at:Math.floor(Date.now()/1000),data:{id:81,sku:{product_id:5,variant_id:17},inventory:{product_id:5,variant_id:17},product_id:5,variant_id:17,location_id:3}};
  const [event]=await adapter().normalizeWebhook({body,credentials});assert.equal(event.type,locationEvents.includes(scope)?'location.changed':'product.changed');assert.deepEqual(Object.keys(event.data),locationEvents.includes(scope)?['externalLocationId']:['externalProductId']);assert.equal(Object.values(event.data)[0],locationEvents.includes(scope)?'3':'5');
 }
});
test('BigCommerce discovers untracked physical variants with their real options and prices, without copying shared stock',async t=>{
 t.mock.method(global,'fetch',async url=>{
  if(String(url).endsWith('/v2/store'))return response({currency:'USD'});
  const data=String(url).includes('/catalog/products')?[{id:5,name:'Woven storage box',type:'physical',inventory_tracking:'none',price:17.5,variants:[{id:17,sku:'WOVEN-OCHRE',price:17.5,option_values:[{option_display_name:'Color',label:'Ochre'}]},{id:18,sku:'WOVEN-TEAL',price:0,option_values:[{option_display_name:'Color',label:'Teal'}]}]}]:String(url).includes('/inventory/locations')?[{id:3,label:'Warehouse'}]:[{identity:{product_id:5},locations:[{location_id:3,total_inventory_onhand:91,available_to_sell:91}]}];
  return response({data,meta:{pagination:{current_page:1,total_pages:1}}});
 });
 const catalogue=await adapter().discover({credentials});assert.equal(catalogue.products.length,2);
 assert.deepEqual(catalogue.products[0].providerData.selectedOptions,[{name:'Color',value:'Ochre'}]);assert.equal(catalogue.products[0].displayName,'Woven storage box / Ochre');
 assert.equal(catalogue.products[1].providerData.priceMoney.amount,0);assert(catalogue.products.every(p=>p.providerData.inventoryCounts.length===0&&p.providerData.virtual===false));
});
test('BigCommerce store input is canonical and cannot redirect credentials to another host',()=>{
 const a=adapter();assert.equal(a.normalizeStore('https://store-ab12cd.mybigcommerce.com/manage'),'ab12cd');
 for(const value of ['https://example.com','https://store-ab12cd.mybigcommerce.com.evil.test','../secret','https://user@store-ab12cd.mybigcommerce.com'])assert.throws(()=>a.normalizeStore(value));
});
test('BigCommerce grant validates the original store and actual granted scopes before retaining tokens',async t=>{
 const a=adapter();let calls=0;t.mock.method(global,'fetch',async()=>{calls++;return response({access_token:'token',context:'stores/another',scope:'store_v2_products store_inventory'});});
 await assert.rejects(a.exchangeAuthorization({query:{code:'code',context:'stores/another',scope:'store_v2_products store_inventory'},metadata:{storeHash:'ab12cd',requestedScopes:['store_v2_products','store_inventory'],redirectUri:'https://app.example.test/callback'}}),/different store/);assert.equal(calls,0);
});
test('BigCommerce modify access includes read access and the retained token is bound to the verified store',async t=>{
 const a=adapter(),scope='store_v2_products store_inventory store_v2_orders store_v2_information_read_only';let exchanges=0;
 t.mock.method(global,'fetch',async(url,init)=>{if(String(url).includes('/oauth2/token')){exchanges++;assert.equal(JSON.parse(init.body).context,'stores/ab12cd');return response({access_token:'verified-test-token',context:'stores/ab12cd',scope,user:{id:7}});}assert.match(String(url),/\/stores\/ab12cd\/v2\/store$/);return response({currency:'USD',name:'Verified fixture store'});});
 const result=await a.exchangeAuthorization({query:{code:'fixture-code',context:'stores/ab12cd',scope},metadata:{storeHash:'ab12cd',redirectUri:'https://app.example.test/callback'}});assert.equal(exchanges,1);assert.equal(result.accountId,'ab12cd');assert.equal(result.credentials.storeUrl,'https://store-ab12cd.mybigcommerce.com');assert.equal(result.credentials.providerUserId,'7');assert(!Object.hasOwn(result.credentials,'webhookClientSecret'));
});
test('BigCommerce stock reads use location inventory, preserve zero and reject missing or competing records',async t=>{
 const a=adapter();let data=[{identity:{variant_id:17,product_id:5},available_to_sell:0,total_inventory_onhand:2,settings:{safety_stock:2}}];
 t.mock.method(global,'fetch',async url=>{if(String(url).includes('/catalog/products/'))return response({data:{id:5,inventory_tracking:'variant'}});assert.match(String(url),/\/v3\/inventory\/locations\/3\/items/);return response({data});});
 const input={credentials,externalId:'17',parentExternalId:'5',externalLocationId:'3',field:'quantity'};
 assert.equal((await a.readSyncPosition(input)).value,0);data=[];await assert.rejects(a.readSyncPosition(input),/explicit/);
});
test('BigCommerce absolute write retains asynchronous transaction and independently verifies sellable stock',async t=>{
 const a=adapter();let quantity=4,writes=0,retained;const seen=[];
 t.mock.method(global,'fetch',async(url,init)=>{seen.push(String(url));if(String(url).includes('/catalog/products/'))return response({data:{id:5,inventory_tracking:'variant'}});if(init.method==='PUT'){writes++;const body=JSON.parse(init.body);assert.equal(body.items[0].quantity,8,'sellable six plus existing safety stock two');quantity=6;return response({transaction_id:'tx-1'});}return response({data:[{identity:{variant_id:17,product_id:5},available_to_sell:quantity,total_inventory_onhand:quantity+2,settings:{safety_stock:2}}]});});
 const result=await a.writeSyncPosition({credentials,externalId:'17',parentExternalId:'5',externalLocationId:'3',field:'quantity',value:6,expected:4,idempotencyKey:'operation-1',onAccepted:async ref=>{retained=ref;}});
 assert.equal(writes,1);assert.equal(retained.transactionId,'tx-1');assert.equal(result.value,6);assert.equal(result.verified,true);assert.equal(seen.length,5);
});
test('accepted asynchronous inventory is pending until readback; no fabricated verification or second write',async t=>{
 const a=adapter();let writes=0,retained;
 t.mock.method(global,'fetch',async(url,init)=>{if(String(url).includes('/catalog/products/'))return response({data:{id:5,inventory_tracking:'variant'}});if(init.method==='PUT'){writes++;return response({transaction_id:'tx-pending'});}return response({data:[{identity:{variant_id:17,product_id:5},available_to_sell:4,total_inventory_onhand:4,settings:{safety_stock:0}}]});});
 await assert.rejects(a.writeSyncPosition({credentials,externalId:'17',parentExternalId:'5',externalLocationId:'3',field:'quantity',value:6,expected:4,idempotencyKey:'op',onAccepted:async ref=>{retained=ref;}}),e=>e.providerOutcomeUncertain===true&&e.code==='commerce_sync_unverified');
 assert.equal(writes,1);assert.equal(retained.transactionId,'tx-pending');
});
test('BigCommerce base products use product inventory identity and shared stock cannot be copied across variants',async t=>{
 const a=adapter();let quantity=3,variants=[{id:17}],writes=0;
 t.mock.method(global,'fetch',async(url,init)=>{if(String(url).includes('/catalog/products/'))return response({data:{id:5,inventory_tracking:'product',variants}});if(init.method==='PUT'){const item=JSON.parse(init.body).items[0];assert.equal(item.product_id,5);assert.equal(item.variant_id,undefined);quantity=item.quantity;writes++;return response({transaction_id:'base-product-write'});}assert.match(String(url),/product_id:in=5/);return response({data:[{identity:{product_id:5,variant_id:null},available_to_sell:quantity,total_inventory_onhand:quantity}]});});
 const input={credentials,externalId:'17',parentExternalId:'5',externalLocationId:'3',field:'quantity'};assert.equal((await a.readSyncPosition(input)).value,3);assert.equal((await a.writeSyncPosition({...input,value:4,expected:3,idempotencyKey:'base-op',onAccepted:async()=>{}})).value,4);assert.equal(writes,1);variants=[{id:17},{id:22}];await assert.rejects(a.readSyncPosition(input),/shared/);
});
test('BigCommerce price zero survives; conflicts, sale overrides and currency mismatch stop before writes',async t=>{
 const a=adapter();let row={id:17,product_id:5,price:0,calculated_price:0,sale_price:0},writes=0;
 t.mock.method(global,'fetch',async(url,init)=>{if(init.method==='PUT')writes++;return String(url).endsWith('/v2/store')?response({currency:'USD'}):response({data:row});});
 const input={credentials,externalId:'17',parentExternalId:'5',externalLocationId:'3',field:'price'};assert.deepEqual((await a.readSyncPosition(input)).value,{amount:0,currency:'USD'});
 await assert.rejects(a.writeSyncPosition({...input,value:{amount:5,currency:'USD'},expected:{amount:1,currency:'USD'},onAccepted:async()=>{}}),e=>e.code==='commerce_sync_conflict'&&e.providerWriteAttempted===false);
 row={...row,price:10,calculated_price:8,sale_price:8};await assert.rejects(a.writeSyncPosition({...input,value:{amount:1100,currency:'USD'},expected:{amount:800,currency:'USD'},onAccepted:async()=>{}}),/override/);assert.equal(writes,0);
});
test('BigCommerce webhooks require store identity and authenticated raw bytes; duplicate identity is stable',async t=>{
 const a=adapter(),secret='private-test-client-secret',at=String(Math.floor(Date.now()/1000)),body={producer:'stores/ab12cd',scope:'store/product/updated',hash:'same-event',created_at:Number(at),data:{id:5}},raw=Buffer.from(JSON.stringify(body)),id='evt-1';
 const previous=process.env.BIGCOMMERCE_CLIENT_SECRET;process.env.BIGCOMMERCE_CLIENT_SECRET=secret;t.after(()=>{if(previous===undefined)delete process.env.BIGCOMMERCE_CLIENT_SECRET;else process.env.BIGCOMMERCE_CLIENT_SECRET=previous;});
 const signature=crypto.createHmac('sha256',secret).update(id+'.'+at+'.').update(raw).digest('base64'),headers={'webhook-id':id,'webhook-timestamp':at,'webhook-signature':'v1,'+signature};
 a.verifyWebhook({headers,rawBody:raw,body,credentials:{...credentials,webhookClientSecret:secret},connection:{provider_account_id:'ab12cd'}});
 assert.throws(()=>a.verifyWebhook({headers,rawBody:Buffer.from('{}'),body,credentials:{...credentials,webhookClientSecret:secret},connection:{provider_account_id:'ab12cd'}}));
 assert.throws(()=>a.verifyWebhook({headers,rawBody:raw,body:{...body,producer:'stores/foreign'},credentials:{...credentials,webhookClientSecret:secret},connection:{provider_account_id:'ab12cd'}}));
 const x=await a.normalizeWebhook({body,credentials,connection:{provider_account_id:'ab12cd'}}),y=await a.normalizeWebhook({body,credentials,connection:{provider_account_id:'ab12cd'}});assert.equal(x[0].eventId,y[0].eventId);assert.equal(x[0].type,'product.changed');
 const legacy={...credentials,webhookSecret:'per-connection-fixture-secret'};a.verifyWebhook({headers:{'x-stockchief-webhook-secret':legacy.webhookSecret},rawBody:raw,body,credentials:legacy,connection:{provider_account_id:'ab12cd'}});assert.throws(()=>a.verifyWebhook({headers:{'x-stockchief-webhook-secret':'wrong'},rawBody:raw,body,credentials:legacy,connection:{provider_account_id:'ab12cd'}}));
});

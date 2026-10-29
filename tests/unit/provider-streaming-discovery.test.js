'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('Square joins disk-backed families to bounded inventory batches and emits every variant',async t=>{
 const seen=[];let inventoryCalls=0;
 t.mock.method(global,'fetch',async(value,options)=>{const u=new URL(value);
  if(u.pathname==='/v2/locations')return Response.json({locations:[{id:'loc',name:'Store'}]});
  if(u.pathname==='/v2/catalog/list')return Response.json({objects:[{id:'parent',type:'ITEM',item_data:{name:'Family'}},...Array.from({length:1001},(_,i)=>({id:'v'+String(i).padStart(4,'0'),type:'ITEM_VARIATION',item_variation_data:{item_id:'parent',name:'Variant '+i,track_inventory:true}}))]});
  const ids=JSON.parse(options.body).catalog_object_ids;assert(ids.length<=1000);assert.equal(seen.length,inventoryCalls?1000:0);inventoryCalls++;
  return Response.json({counts:ids.map(id=>({catalog_object_id:id,location_id:'loc',state:'IN_STOCK',quantity:'2'}))});});
 const found=await require('../../src/connections/providers/square').discover({credentials:{accessToken:'test',environment:'sandbox'},onProduct:r=>seen.push(r)});
 assert.equal(seen.length,1001);assert.equal(inventoryCalls,2);assert.deepEqual(found.products,[]);assert(seen.every(r=>r.providerData.itemName==='Family'&&r.providerData.inventoryCounts[0].quantity==='2'));
});
test('BigCommerce stages stock on disk and emits products before fetching another catalogue page',async t=>{
 const seen=[];t.mock.method(global,'fetch',async value=>{const u=new URL(value),page=Number(u.searchParams.get('page')||1);
  if(u.pathname.endsWith('/v2/store'))return Response.json({currency:'USD'});
  let data,total=1;
  if(u.pathname.endsWith('/inventory/locations'))data=[{id:3,label:'Store'}];
  else if(u.pathname.endsWith('/inventory/items'))data=[1,2].map(i=>({identity:{variant_id:i},locations:[{location_id:3,total_inventory_onhand:i,available_to_sell:i}]}));
  else{assert.equal(seen.length,page-1);total=2;data=[{id:page,name:'Product '+page,type:'physical',inventory_tracking:'variant',price:1,variants:[{id:page,sku:'SKU-'+page}]}];}
  return Response.json({data,meta:{pagination:{current_page:page,total_pages:total}}});});
 const found=await require('../../src/connections/providers/bigcommerce').discover({credentials:{storeHash:'ab12cd',accessToken:'test'},onProduct:r=>seen.push(r)});
 assert.deepEqual(found.products,[]);assert.deepEqual(seen.map(r=>r.providerData.inventoryCounts[0].quantity),[1,2]);
});
test('Clover emits catalogue pages before requesting the next page',async t=>{
 const adapter=require('../../src/connections/providers/clover'),seen=[];
 t.mock.method(global,'fetch',async value=>{const u=new URL(value);
  if(!u.pathname.endsWith('/items'))return Response.json({name:'Stream shop',currency:'USD'});
  const offset=Number(u.searchParams.get('offset'));assert.equal(seen.length,offset);
  return Response.json({elements:Array.from({length:offset?3:100},(_,i)=>({id:String(offset+i),name:'Item '+(offset+i),price:100,itemStock:{quantity:0}}))});});
 const found=await adapter.discover({credentials:{merchantId:'shop',accessToken:'test',environment:'sandbox'},onProduct:r=>seen.push(r)});
 assert.equal(seen.length,103);assert.deepEqual(found.products,[]);assert.equal(seen.at(-1).externalId,'102');
});
test('QuickBooks streams each complete item page with exact quantities and currency',async t=>{
 const adapter=require('../../src/connections/providers/quickbooks');let count=0;
 t.mock.method(global,'fetch',async value=>{const u=new URL(value);
  if(u.pathname.includes('/companyinfo/'))return Response.json({CompanyInfo:{CompanyName:'Stream company'}});
  if(u.pathname.endsWith('/preferences'))return Response.json({Preferences:{CurrencyPrefs:{HomeCurrency:{value:'USD'}}}});
  const second=u.searchParams.get('query').includes('startposition 1001');assert.equal(count,second?1000:0);
  return Response.json({QueryResponse:{Item:Array.from({length:second?1:1000},(_,i)=>({Id:String((second?1000:0)+i),Name:'Stock',Type:'Inventory',TrackQtyOnHand:true,QtyOnHand:2,UnitPrice:'1.25'}))}});});
 const found=await adapter.discover({credentials:{realmId:'company',accessToken:'test'},onProduct:r=>{assert.equal(r.providerData.priceMoney.amount,125);assert.equal(r.providerData.inventoryCounts[0].quantity,2);count++;}});
 assert.equal(count,1001);assert.deepEqual(found.products,[]);
});
test('Shopify streams variants across family and catalogue pages without retaining the catalogue',async t=>{
 const seen=[];t.mock.method(global,'fetch',async(_url,options)=>{const {query,variables}=JSON.parse(options.body);
  if(query.includes('Locations'))return Response.json({data:{locations:{nodes:[],pageInfo:{hasNextPage:false}}}});
  const index=variables.after?1:0;assert.equal(seen.length,index);
  return Response.json({data:{shop:{currencyCode:'JPY'},productVariants:{nodes:[{id:'v'+index,title:'Variant '+index,sku:'SKU'+index,price:'25',product:{id:'same-family',title:'Family',status:'ACTIVE'},inventoryItem:{tracked:true,requiresShipping:true,inventoryLevels:{nodes:[],pageInfo:{hasNextPage:false}}}}],pageInfo:{hasNextPage:index===0,endCursor:'page-2'}}}});});
 const found=await require('../../src/connections/providers/shopify').discover({credentials:{shop:'stream.myshopify.com',accessToken:'test'},onProduct:r=>seen.push(r)});
 assert.deepEqual(seen.map(r=>r.externalId),['v0','v1']);assert(seen.every(r=>r.parentExternalId==='same-family'&&r.providerData.priceMoney.currency==='JPY'));assert.deepEqual(found.products,[]);
});
test('WooCommerce emits simple and variant products as pages arrive',async t=>{
 const network=require('../../src/connections/providers/store-network'),seen=[];
 t.mock.method(network,'fetchStore',async value=>{const u=new URL(value);let body;
  if(u.pathname.endsWith('/data/currencies/current'))body={code:'USD'};
  else if(u.pathname.includes('/variations'))body=[{id:3,sku:'V',price:'2',status:'publish',attributes:[{name:'Color',option:'Red'}]}];
  else body=[{id:1,name:'Simple',sku:'S',type:'simple',price:'1',status:'publish'},{id:2,name:'Family',type:'variable',variations:[3],status:'publish'}];
  return Response.json(body,{headers:{'x-wp-totalpages':'1'}});});
 const found=await require('../../src/connections/providers/woocommerce').discover({credentials:{storeUrl:'https://stream.example.test',consumerKey:'ck_'+'a'.repeat(40),consumerSecret:'cs_'+'b'.repeat(40)},onProduct:r=>seen.push(r)});
 assert.deepEqual(seen.map(r=>r.externalId),['1','3']);assert.deepEqual(found.products,[]);assert.equal(seen[1].parentExternalId,'2');
});

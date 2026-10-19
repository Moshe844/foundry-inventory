'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),woo=require('../../src/connections/providers/woocommerce'),network=require('../../src/connections/providers/store-network');
const credentials={storeUrl:'https://currency-fixture.example.test/shop',consumerKey:'ck_'+'a'.repeat(40),consumerSecret:'cs_'+'b'.repeat(40)};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','x-wp-totalpages':'1'}});
function transport(t,reply){const original=network.fetchStore,calls=[];t.after(()=>{network.fetchStore=original;});network.fetchStore=async(value,options)=>{const u=new URL(value);assert.equal(u.origin,'https://currency-fixture.example.test');assert.equal(options.method||'GET','GET');assert(!u.search.includes(credentials.consumerKey));assert(!u.search.includes(credentials.consumerSecret));assert.equal(options.headers.authorization,'Basic '+Buffer.from(credentials.consumerKey+':'+credentials.consumerSecret).toString('base64'));calls.push(u.pathname);return reply(u.pathname);};return calls;}
test('a missing currency settings option cannot reject a store exposing its canonical current currency',async t=>{
 const calls=transport(t,p=>p.endsWith('/data/currencies/current')?json({code:'JPY'}):p.endsWith('/products')?json([]):json({message:'Missing setting'},404));
 const fact=await woo.verifyReadOnly({credentials});assert.equal(fact.verifiedFact.currency,'JPY');const catalog=await woo.discover({credentials});assert.equal(catalog.products.length,0);assert(!calls.some(p=>p.includes('/settings/')));assert(calls.every(p=>p.startsWith('/shop/wp-json/wc/v3/')));
});
test('only an absent current-currency endpoint uses the legacy settings endpoint',async t=>{
 const calls=transport(t,p=>p.endsWith('/data/currencies/current')?json({message:'Not found'},404):p.endsWith('/settings/general/woocommerce_currency')?json({value:'KWD'}):json([]));
 assert.equal((await woo.verifyReadOnly({credentials})).verifiedFact.currency,'KWD');assert.deepEqual(calls.map(p=>p.replace('/shop/wp-json/wc/v3','')),['/products','/data/currencies/current','/settings/general/woocommerce_currency']);
});
test('authorization failures stop verification without alternate endpoints or unsafe provider details',async t=>{
 const calls=transport(t,()=>json({message:'Reflected '+credentials.consumerSecret,code:credentials.consumerKey},401));
 await assert.rejects(woo.verifyReadOnly({credentials}),e=>{assert.equal(e.status,401);assert.equal(e.httpStatus,401);assert.equal(e.providerResource,'products');assert(!JSON.stringify(e).includes(credentials.consumerSecret));assert(!JSON.stringify(e).includes(credentials.consumerKey));assert.equal(e.providerBody,undefined);assert.equal(e.cause,undefined);return true;});assert.equal(calls.length,1);
});
test('currency permission denial is not misclassified as a missing route',async t=>{
 const calls=transport(t,p=>p.endsWith('/products')?json([]):json({message:'Denied '+credentials.consumerSecret},403));
 await assert.rejects(woo.verifyReadOnly({credentials}),e=>e.status===403&&e.providerResource==='currency'&&!e.message.includes(credentials.consumerSecret));assert.equal(calls.length,2);assert(!calls.some(p=>p.includes('/settings/')));
});
test('missing or invalid currency fails safely without inferring a default',async t=>{
 const calls=transport(t,p=>p.endsWith('/products')?json([]):json({code:'NOT_A_CURRENCY'}));
 await assert.rejects(woo.verifyReadOnly({credentials}),/recognized store currency/);assert.equal(calls.length,2);
});
test('unavailable currency endpoints retain the precise safe failure instead of blaming keys',async t=>{
 transport(t,p=>p.endsWith('/products')?json([]):json({message:'Reflected '+credentials.consumerSecret},404));
 await assert.rejects(woo.verifyReadOnly({credentials}),e=>{assert.equal(e.status,404);assert.equal(e.providerResource,'currency');assert.match(e.message,/currency/);assert(!e.message.includes(credentials.consumerSecret));assert(!e.message.includes('Check the key'));return true;});
});

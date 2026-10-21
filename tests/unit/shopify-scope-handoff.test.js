'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const shopify=require('../../src/connections/providers/shopify');
const originalEnv={...process.env},originalFetch=global.fetch;
const shop='permission-fixture.myshopify.com',writes=['write_products','write_inventory','write_orders','write_fulfillments','write_merchant_managed_fulfillment_orders'];
const reads=['read_orders','read_products','read_locations','read_inventory','read_fulfillments'];
function configure(){process.env.SHOPIFY_CLIENT_ID='fixture-client';process.env.SHOPIFY_CLIENT_SECRET='fixture-secret';process.env.SHOPIFY_ACCESS_SCOPES_BY_SHOP=JSON.stringify({[shop]:writes});}
function signedQuery(){const query={code:'fixture-code',shop,state:'fixture-state'};const text=Object.keys(query).sort().map(key=>key+'='+query[key]).join('&');return {...query,hmac:crypto.createHmac('sha256',process.env.SHOPIFY_CLIENT_SECRET).update(text).digest('hex')};}
test.afterEach(()=>{process.env={...originalEnv};global.fetch=originalFetch;});
test('legacy consent requests configured permissions and the shared stock/price write scopes',()=>{
 configure();const auth=shopify.authorizationUrl({state:'fixture-state',input:{shop,redirectUri:'https://app.example.test/callback'}});
 const url=new URL(auth.url);assert.deepEqual(url.searchParams.get('scope').split(','),[...reads,...writes]);assert.deepEqual(auth.metadata.requestedScopes,[...reads,...writes]);assert.equal(url.searchParams.get('state'),'fixture-state');
 const other=shopify.authorizationUrl({state:'other-state',input:{shop:'other-fixture.myshopify.com',redirectUri:'https://app.example.test/callback'}});
 assert.deepEqual(new URL(other.url).searchParams.get('scope').split(','),[...reads,'write_products','write_inventory']);
 process.env.SHOPIFY_ACCESS_SCOPES_BY_SHOP=JSON.stringify({[shop]:['write_unrelated_privilege']});
 assert.throws(()=>shopify.authorizationUrl({state:'fixture',input:{shop}}),/unsupported access/);
});
test('an old client-credentials grant falls back to human consent instead of claiming an upgrade',async()=>{
 configure();let calls=0;global.fetch=async(url,options)=>{calls++;assert.equal(new URL(url).hostname,shop);assert.equal(new URLSearchParams(options.body).get('grant_type'),'client_credentials');return Response.json({access_token:'old-fixture',scope:reads.join(','),expires_in:86399});};
 assert.equal(await shopify.tryDirectAuthorization({input:{shop}}),null);assert.equal(calls,1);
});
test('callback verifies the persisted request and accepts only actual approved scopes',async()=>{
 configure();const metadata=shopify.authorizationUrl({state:'fixture-state',input:{shop,redirectUri:'https://app.example.test/callback'}}).metadata;
 let scopes=reads;global.fetch=async()=>Response.json({access_token:'callback-fixture',scope:scopes.join(',')});
 await assert.rejects(()=>shopify.exchangeAuthorization({query:signedQuery(),metadata}),/not approved all requested permissions/);
 scopes=[...writes,'read_locations'];const accepted=await shopify.exchangeAuthorization({query:signedQuery(),metadata});
 assert.deepEqual(accepted.capabilities,scopes);assert.equal(accepted.accountId,shop);
 await assert.rejects(()=>shopify.exchangeAuthorization({query:{...signedQuery(),hmac:'forged'},metadata}),/could not be verified/);
});
test('missing scope fields are verified against the installation and are never guessed from the request',async()=>{
 configure();const metadata=shopify.authorizationUrl({state:'fixture-state',input:{shop,redirectUri:'https://app.example.test/callback'}}).metadata;
 let scopes=reads,readsCount=0;global.fetch=async(url)=>{if(String(url).includes('/oauth/access_token'))return Response.json({access_token:'callback-fixture'});readsCount++;return Response.json({data:{currentAppInstallation:{accessScopes:scopes.map(handle=>({handle}))}}});};
 await assert.rejects(()=>shopify.exchangeAuthorization({query:signedQuery(),metadata}),/not approved all requested permissions/);assert.equal(readsCount,1);
 scopes=[...writes,'read_locations'];assert.deepEqual((await shopify.exchangeAuthorization({query:signedQuery(),metadata})).capabilities,scopes);assert.equal(readsCount,2);
});

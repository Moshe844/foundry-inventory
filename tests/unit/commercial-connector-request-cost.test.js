'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {classify}=require('../../src/commercial/connector-request-cost');

test('Stripe Connect classifies only the scoped merchant API operations with documented request pricing',()=>{
 const def={provider:'stripe',version:'v1'},api='https://api.stripe.com';
 for(const path of ['/v1/accounts/acct_Fixture','/v1/invoices/in_Fixture','/v1/charges/ch_Fixture','/v1/payment_intents/pi_Fixture','/v1/refunds','/v1/refunds/re_Fixture','/v1/balance_transactions/txn_Fixture'])assert.equal(classify(def,api+path,'GET')?.basis,'NO_INCREMENTAL_STRIPE_CONNECT_API_REQUEST_FEE',path);
 for(const path of ['/v1/customers','/v1/invoices','/v1/invoiceitems','/v1/refunds','/v1/invoices/in_Fixture/finalize','/v1/invoices/in_Fixture/void'])assert.ok(classify(def,api+path,'POST'),path);
 for(const path of ['/oauth/token','/oauth/deauthorize'])assert.ok(classify({...def,version:'unversioned'},'https://connect.stripe.com'+path,'POST'));
 for(const path of ['/v1/payouts','/v1/transfers','/v1/tax/calculations','/v1/accounts','/v1/webhook_endpoints'])assert.equal(classify(def,api+path,'POST'),null,path);
 assert.equal(classify(def,'https://api.stripe.com.evil.test/v1/customers','POST'),null);
 assert.equal(classify({...def,version:'future'},api+'/v1/customers','POST'),null);
});

test('Shopify classification covers only pinned store Admin and OAuth requests',()=>{
 const def={provider:'shopify',version:'2026-07'},store='https://fixture.myshopify.com';
 assert.equal(classify(def,store+'/admin/api/2026-07/graphql.json','POST').basis,'NO_INCREMENTAL_SHOPIFY_ADMIN_API_REQUEST_FEE');
 assert.ok(classify({...def,version:'unversioned'},store+'/admin/oauth/access_token','POST'));
 assert.ok(classify({...def,version:'unversioned'},store+'/admin/oauth/access_scopes.json','GET'));
 for(const [version,url,method]of [
  ['2027-01',store+'/admin/api/2027-01/graphql.json','POST'],
  ['2026-07',store+'/admin/api/2026-07/graphql.json','GET'],
  ['2026-07','https://fixture.myshopify.com.evil.test/admin/api/2026-07/graphql.json','POST'],
  ['2026-07','http://fixture.myshopify.com/admin/api/2026-07/graphql.json','POST'],
  ['2026-07',store+':8443/admin/api/2026-07/graphql.json','POST'],
  ['unversioned',store+'/admin/oauth/novel_paid_operation','POST'],
 ])assert.equal(classify({...def,version},url,method),null,url);
});

test('Square seller reads and hosted payment links have a verified request classification',()=>{
 const def={provider:'square',version:'2026-08-19'};
 assert.equal(classify(def,'https://connect.squareup.com/v2/orders/search','POST').basis,'NO_INCREMENTAL_SQUARE_API_REQUEST_FEE');
 assert.ok(classify(def,'https://connect.squareup.com/v2/orders/order-1'));
 assert.ok(classify(def,'https://connect.squareup.com/v2/online-checkout/payment-links','POST'));
 assert.equal(classify(def,'https://connect.squareup.com/v2/orders/order-1/pay','POST'),null);
 assert.equal(classify({...def,version:'new'},'https://connect.squareup.com/v2/orders/order-1'),null);
});

test('licensed Microsoft mail and workforce token endpoints leave other operations unresolved',()=>{
 const graph={provider:'microsoft365',version:'v1.0'};
 const entra={provider:'login.microsoftonline.com',version:'v2.0'};
 assert.ok(classify(graph,'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages'));
 assert.ok(classify(graph,'https://graph.microsoft.com/v1.0/me/messages/example/reply','POST'));
 assert.ok(classify(graph,'https://graph.microsoft.com/v1.0/subscriptions/example','PATCH'));
 assert.equal(classify(graph,'https://graph.microsoft.com/v1.0/drives/1/items/2/assignSensitivityLabel','POST'),null);
 assert.ok(classify(entra,'https://login.microsoftonline.com/organizations/oauth2/v2.0/token','POST'));
 assert.equal(classify(entra,'https://login.microsoftonline.com/consumers/oauth2/v2.0/token','POST'),null);
});

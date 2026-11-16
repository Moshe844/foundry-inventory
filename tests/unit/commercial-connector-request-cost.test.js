'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {classify}=require('../../src/commercial/connector-request-cost');

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

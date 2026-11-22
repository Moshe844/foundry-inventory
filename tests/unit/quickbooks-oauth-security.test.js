'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),request=require('supertest'),path=require('node:path');
const service=require('../../src/connections/postgres-provider-service');

function app(){
  const server=express();server.set('views',path.resolve(__dirname,'../../src/web/views'));server.set('view engine','ejs');
  server.use((req,res,next)=>{res.page=(view,data)=>res.render(view,{assetVersion:'test',...data});next();});
  server.use(require('../../src/web/routes/postgres-connections').createPostgresConnectionsRouter({},
    {providers:{catalog:()=>[{type:'quickbooks'}],get:()=>({metadata:()=>({name:'QuickBooks'})})}}));
  return server;
}

test('Intuit callback success is an empty 302 to saved completion, including popup intent',async t=>{
  const context=t.mock.method(service,'callbackContext',async()=>({returnOrigin:'https://app.example.test',popup:true}));
  const exchange=t.mock.method(service,'completeOAuth',async()=>({id:'con_verified'}));
  const result=await request(app()).get('/settings/connections/quickbooks/callback').query({state:'PRIVATE_STATE',code:'PRIVATE_CODE',realmId:'PRIVATE_COMPANY'}).accept('html');
  assert.equal(result.status,302);assert.equal(result.text,'');
  assert.equal(result.headers.location,'https://app.example.test/settings/connections/con_verified/complete?popup=1');
  assert.equal(result.headers['cache-control'],'no-cache, no-store');assert.equal(result.headers['referrer-policy'],'no-referrer');
  assert.equal(context.mock.callCount(),1);assert.equal(exchange.mock.callCount(),1);
});

test('invalid state, provider denial and failed exchange all leave the sensitive callback without rendering HTML',async t=>{
  let invalid=false,exchanges=0;
  t.mock.method(service,'callbackContext',async()=>{if(invalid)throw Error('PRIVATE_STATE');return {};});
  t.mock.method(service,'completeOAuth',async()=>{exchanges++;throw Error('PRIVATE_PROVIDER_DETAIL PRIVATE_CODE');});
  const server=app();
  for(const query of [{state:'PRIVATE_STATE',error:'access_denied',error_description:'PRIVATE_PROVIDER_DETAIL'},
    {state:'PRIVATE_STATE',code:'PRIVATE_CODE',realmId:'PRIVATE_COMPANY'},
    {state:'PRIVATE_STATE',code:'PRIVATE_CODE'}]){
    invalid=!query.realmId&&!query.error;
    const result=await request(server).get('/settings/connections/quickbooks/callback').query(query).accept('html');
    assert.equal(result.status,302);assert.equal(result.text,'');
    assert.equal(result.headers.location,'/settings/connections/quickbooks/authorization-result');
    assert.equal(result.headers['referrer-policy'],'no-referrer');assert.match(result.headers['cache-control'],/no-store/);
    assert.doesNotMatch(JSON.stringify(result.headers),/PRIVATE_/);
  }
  const calls=exchanges;
  const clean=await request(server).get('/settings/connections/quickbooks/authorization-result');
  assert.equal(clean.status,400);assert.match(clean.text,/QuickBooks was not connected/);
  assert.match(clean.text,/start the connection again/);assert.doesNotMatch(clean.text,/PRIVATE_/);
  assert.equal(exchanges,calls,'The clean page never repeats the OAuth exchange');
  assert.match(clean.headers['cache-control'],/no-store/);assert.equal(clean.headers['referrer-policy'],'no-referrer');
});

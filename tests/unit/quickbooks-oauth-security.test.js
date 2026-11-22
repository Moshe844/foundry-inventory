'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),request=require('supertest'),path=require('node:path');
const service=require('../../src/connections/postgres-provider-service');

function app(before=null){
  const server=express();server.set('views',path.resolve(__dirname,'../../src/web/views'));server.set('view engine','ejs');
  server.use(require('../../src/web/security-headers'));
  server.use((req,res,next)=>{res.page=(view,data)=>res.render(view,{assetVersion:'test',...data});next();});
  if(before)server.use(before);
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

test('early authentication redirects and error bodies cannot render or carry callback query values onward',async()=>{
  for(const before of [
    (req,res)=>res.redirect(303,'/login?next='+encodeURIComponent(req.originalUrl)),
    (_req,res)=>res.status(403).type('html').send('<p>PRIVATE_ERROR_BODY</p>'),
    (_req,res)=>res.status(403).json({message:'PRIVATE_ERROR_BODY'}),
  ]){
    const result=await request(app(before)).get('/settings/connections/quickbooks/callback?code=PRIVATE_CODE&state=PRIVATE_STATE&realmId=PRIVATE_COMPANY');
    assert.equal(result.status,302);assert.equal(result.text,'');assert.equal(result.headers.location,'/settings/connections/quickbooks/authorization-result');
    assert.equal(result.headers['content-type'],undefined);assert.equal(result.headers['referrer-policy'],'no-referrer');
    assert.match(result.headers['cache-control'],/no-store/);assert.doesNotMatch(JSON.stringify(result.headers),/PRIVATE_/);
  }
});

test('MFA still blocks an unverified session and strips the OAuth URL before the challenge',async t=>{
  t.mock.method(require('../../src/domain/postgres-mfa'),'state',async()=>({enabled:true,required:true,revision:2}));
  let callbacks=0;t.mock.method(service,'callbackContext',async()=>{callbacks++;return {};});
  const mfa=require('../../src/web/mfa-middleware')({});
  const server=app((req,res,next)=>{req.account={id:'fixture-account'};req.session={mfaRevision:1};return mfa(req,res,next);});
  const blocked=await request(server).get('/settings/connections/quickbooks/callback?code=PRIVATE_CODE&state=PRIVATE_STATE').accept('html');
  assert.equal(blocked.status,302);assert.equal(blocked.text,'');assert.equal(blocked.headers.location,'/settings/connections/quickbooks/authorization-result');assert.equal(callbacks,0);
  const ordinary=await request(server).get('/settings/connections').accept('html');
  assert.equal(ordinary.status,303);assert.equal(ordinary.headers.location,'/auth/mfa','Ordinary MFA protection must keep its challenge');
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

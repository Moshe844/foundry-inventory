'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const clover=require('../../src/connections/providers/clover');
const quickbooks=require('../../src/connections/providers/quickbooks');
const xero=require('../../src/connections/providers/xero');
const originalFetch=global.fetch,environment={...process.env};
test.beforeEach(()=>Object.assign(process.env,{CLOVER_CLIENT_ID:'offline-clover',CLOVER_CLIENT_SECRET:'offline-clover-secret',
 CLOVER_WEBHOOK_AUTH_CODE:'offline-webhook',CLOVER_ENVIRONMENT:'sandbox',QUICKBOOKS_CLIENT_ID:'offline-qb',
 QUICKBOOKS_CLIENT_SECRET:'offline-qb-secret',QUICKBOOKS_ENVIRONMENT:'sandbox',XERO_CLIENT_ID:'offline-xero',XERO_CLIENT_SECRET:'offline-xero-secret'}));
test.afterEach(()=>{global.fetch=originalFetch;process.env={...environment};});
const seconds=()=>Math.floor(Date.now()/1000);
const relative=()=>({access_token:'new-access',refresh_token:'new-refresh',expires_in:1800});
const absolute=()=>({access_token:'new-access',refresh_token:'new-refresh',access_token_expiration:seconds()+1800,refresh_token_expiration:seconds()+86400});
const jwt=event=>'eyJhbGciOiJub25lIn0.'+Buffer.from(JSON.stringify({authentication_event_id:event})).toString('base64url')+'.offline-signature';

for(const [name,adapter,grant] of [['Clover',clover,absolute],['QuickBooks',quickbooks,relative],['Xero',xero,relative]]){
 test(name+' preserves saved credentials when HTTP 200 contains an incomplete rotating grant',async()=>{
  const saved={accessToken:'old-access',refreshToken:'old-refresh',merchantId:'merchant',realmId:'company',tenantId:'tenant',
   environment:'sandbox',expiresAt:new Date(Date.now()-60000).toISOString(),accessTokenExpiration:seconds()-60};
  const before=structuredClone(saved);
  for(const change of [b=>delete b.access_token,b=>delete b.refresh_token,b=>b.access_token='',b=>b.refresh_token=' ',
   b=>b.access_token={unexpected:'object'},b=>b.error='temporarily_unavailable',
   b=>b[name==='Clover'?'access_token_expiration':'expires_in']=-1,
   b=>b[name==='Clover'?'access_token_expiration':'expires_in']='not-a-date',
   b=>b[name==='Clover'?'refresh_token_expiration':'expires_in']=Number.MAX_VALUE]){
   let calls=0;const body=grant();change(body);
   global.fetch=async value=>{calls++;assert.match(new URL(value).hostname,/^(apisandbox\.dev\.clover\.com|oauth\.platform\.intuit\.com|identity\.xero\.com)$/);return Response.json(body);};
   await assert.rejects(()=>adapter.refreshCredentials(saved),error=>error.code==='PROVIDER_REFRESH_UNCONFIRMED'&&error.transient===true&&error.status===503);
   assert.deepEqual(saved,before);assert.equal(calls,1,'A single-use refresh must not be replayed automatically');
  }
 });
 test(name+' retains company identity while accepting a complete replacement grant',async()=>{
  const saved={accessToken:'old',refreshToken:'old-refresh',merchantId:'merchant',realmId:'company',tenantId:'tenant',environment:'sandbox',
   expiresAt:new Date(Date.now()-60000).toISOString(),accessTokenExpiration:seconds()-60};
  global.fetch=async(value,options)=>{assert.equal(options.method,'POST');return Response.json(grant());};
  const result=await adapter.refreshCredentials(saved);
  assert.equal(result.refreshed,true);assert.equal(result.credentials.accessToken,'new-access');assert.equal(result.credentials.refreshToken,'new-refresh');
  for(const key of ['merchantId','realmId','tenantId','environment'])assert.equal(result.credentials[key],saved[key]);
  assert(Date.parse(result.expiresAt)>Date.now());assert.equal(saved.accessToken,'old');
 });
 test(name+' rejects incomplete initial authorization before reading a company',async()=>{
  let calls=0;global.fetch=async()=>{calls++;return Response.json({access_token:'partial-access'});};
  await assert.rejects(()=>adapter.exchangeAuthorization({query:{code:'offline-code',realmId:'company',merchant_id:'merchant'},metadata:{redirectUri:'https://example.test/callback'}}),
   error=>error.code==='PROVIDER_REFRESH_UNCONFIRMED');
  assert.equal(calls,1,'No company identity request can use an incomplete grant');
 });
}

test('Xero chooses the organization consented in this flow when older connections also exist',async()=>{
 const token=jwt('new-event'),calls=[];
 global.fetch=async(value,options={})=>{
  const url=new URL(value);calls.push({path:url.pathname,headers:options.headers});
  if(url.hostname==='identity.xero.com')return Response.json({...relative(),access_token:token});
  assert.equal(url.hostname,'api.xero.com');
  if(url.pathname==='/connections')return Response.json([{tenantId:'old-tenant',authEventId:'old-event',tenantType:'ORGANISATION'},
   {tenantId:'current-tenant',authEventId:'new-event',tenantType:'ORGANISATION'}]);
  assert.equal(options.headers['xero-tenant-id'],'current-tenant');
  return Response.json({Organisations:[{OrganisationID:'current-tenant',Name:'Chosen organization'}]});
 };
 const connected=await xero.exchangeAuthorization({query:{code:'offline'},metadata:{redirectUri:'https://example.test/callback'}});
 assert.equal(connected.accountId,'current-tenant');assert.equal(connected.verifiedFact.externalId,'current-tenant');
 assert(!connected.capabilities.includes('accounting:post'),'Choosing a company does not enable accounting writes');assert.equal(calls.length,3);
});

test('Xero never falls back to another organization when the current consent is missing or ambiguous',async()=>{
 for(const connections of [[{tenantId:'old',authEventId:'old-event'}],
  [{tenantId:'one',authEventId:'new-event'},{tenantId:'two',authEventId:'new-event'}],
  [{tenantId:'practice',tenantType:'PRACTICEMANAGER',authEventId:'new-event'}]]){
  let calls=0;global.fetch=async value=>{calls++;return Response.json(new URL(value).hostname==='identity.xero.com'
   ?{...relative(),access_token:jwt('new-event')}:connections);};
  await assert.rejects(()=>xero.exchangeAuthorization({query:{code:'offline'},metadata:{redirectUri:'https://example.test/callback'}}),/authorize one organization/);
  assert.equal(calls,2,'No organization data is read after an ambiguous selection');
 }
});

test('Xero verifies the returned organization against the authorized tenant before connecting',async()=>{
 global.fetch=async()=>Response.json({Organisations:[{OrganisationID:'different-tenant',Name:'Wrong company'}]});
 await assert.rejects(()=>xero.verifyReadOnly({credentials:{accessToken:'offline',tenantId:'chosen-tenant'}}),/authorized organization identity/);
});

test('QuickBooks rejects an authorization callback missing its company before token exchange',async()=>{
 global.fetch=async()=>{throw Error('Provider call must not occur');};
 for(const query of [{code:'offline'}, {code:'offline',realmId:''}, {realmId:'company'}])
  await assert.rejects(()=>quickbooks.exchangeAuthorization({query,metadata:{redirectUri:'https://example.test/callback'}}),/authorized company/);
});

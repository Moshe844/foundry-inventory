'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../../src/connections/providers/microsoft365');

const saved = () => ({accessToken:'saved-access',refreshToken:'saved-refresh',expiresAt:Date.now()-60000,
  mailbox:'owner@example.test',subscriptionId:'existing-watch'});
const grant = () => ({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,token_type:'Bearer'});

function configure(t) {
  for (const [name,value] of Object.entries({MICROSOFT365_CLIENT_ID:'offline-client',
    MICROSOFT365_CLIENT_SECRET:'offline-secret',MICROSOFT365_TENANT:'common'})) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
}

test('Microsoft refresh rejects incomplete grants without mutating the saved mailbox authorization', async t => {
  configure(t);
  for (const change of [{access_token:undefined},{access_token:' '},{access_token:{}},
    {expires_in:undefined},{expires_in:0},{expires_in:-1},{expires_in:'not-a-duration'},
    {expires_in:Infinity},{expires_in:true},{refresh_token:{}},{refresh_token:''},{token_type:'Basic'}]) {
    await t.test(JSON.stringify(change),async t => {
      const credentials = saved(), before = structuredClone(credentials);
      t.mock.method(global,'fetch',async () => Response.json({...grant(),...change}));
      await assert.rejects(adapter.refreshCredentials(credentials),error =>
        error.code === 'PROVIDER_REFRESH_UNCONFIRMED' && error.transient === true);
      assert.deepEqual(credentials,before);
    });
  }
});

test('Microsoft refresh rotates a confirmed grant and retains mailbox and watch identity', async t => {
  configure(t);
  t.mock.method(global,'fetch',async (url,options) => {
    assert.equal(new URL(url).hostname,'login.microsoftonline.com');
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('grant_type'),'refresh_token');
    assert.equal(body.get('refresh_token'),'saved-refresh');
    return Response.json(grant());
  });
  const credentials = saved();
  const result = await adapter.refreshCredentials(credentials);
  assert.equal(result.refreshed,true);
  assert.equal(result.credentials.accessToken,'new-access');
  assert.equal(result.credentials.refreshToken,'new-refresh');
  assert.equal(result.credentials.mailbox,credentials.mailbox);
  assert.equal(result.credentials.subscriptionId,credentials.subscriptionId);
  assert(result.credentials.expiresAt > Date.now()+3500000);
  assert.equal(credentials.accessToken,'saved-access');
});

test('Microsoft refresh preserves the existing refresh token when no replacement is returned', async t => {
  configure(t);
  t.mock.method(global,'fetch',async () => Response.json({access_token:'new-access',expires_in:3600}));
  const result = await adapter.refreshCredentials(saved());
  assert.equal(result.credentials.refreshToken,'saved-refresh');
});

test('Microsoft does not contact the provider while its confirmed access token is fresh', async t => {
  configure(t);
  t.mock.method(global,'fetch',async () => { throw new Error('Unnecessary provider traffic'); });
  const credentials = {...saved(),expiresAt:Date.now()+3600000};
  assert.equal((await adapter.refreshCredentials(credentials)).refreshed,false);
});

test('Microsoft initial consent requires renewable authorization and a confirmed mailbox identity', async t => {
  configure(t);
  const request = {query:{code:'offline-code'},metadata:{redirectUri:'https://app.example.test/callback'}};
  let profile = {id:'mailbox-id',mail:'owner@example.test'}, token = grant(), profileRequests = 0;
  t.mock.method(global,'fetch',async url => {
    if (new URL(url).hostname === 'login.microsoftonline.com') return Response.json(token);
    profileRequests++;
    return Response.json(profile);
  });
  token = {...grant(),refresh_token:undefined};
  await assert.rejects(adapter.exchangeAuthorization(request),error => error.code === 'PROVIDER_REFRESH_UNCONFIRMED');
  assert.equal(profileRequests,0);
  token = grant();
  for (profile of [{mail:'owner@example.test'},{id:'mailbox-id'},{id:{},mail:'owner@example.test'}]) {
    await assert.rejects(adapter.exchangeAuthorization(request),/confirm.*mailbox identity/i);
  }
  profile = {id:'mailbox-id',userPrincipalName:'owner@example.test'};
  const connected = await adapter.exchangeAuthorization(request);
  assert.equal(connected.accountId,'mailbox-id');
  assert.equal(connected.accountName,'owner@example.test');
});

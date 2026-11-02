'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

const views = path.join(__dirname, '..', '..', 'src', 'web', 'views', 'connections');
function renderConnections(data) {
  return ejs.renderFile(path.join(views,'index.ejs'),{
    assetVersion:'test',launchTicket:'test-launch-ticket',postgresMode:true,
    commercialCapabilities:['payments.customer'],...data,
    helpers:{...require('../../src/web/view-helpers'),...data.helpers},
  });
}

test('another provider account stays available after connection, within owner and capacity limits',async()=>{
 const data={connections:[{id:'connected-store',provider_type:'shopify',status:'connected',setup_status:'CONNECTED',provider_account_name:'Existing store'}],providerCatalog:[{type:'shopify',name:'Shopify',category:'selling',authMode:'oauth',available:true}],commercialCapabilities:['connection.commerce'],currentUser:{role:'owner'},csrfToken:'fixture-csrf',currentWorkspaceId:'fixture-workspace',helpers:{}};
 const allowed=await renderConnections(data);assert.match(allowed,/>Manage Shopify</);assert.match(allowed,/>Connect another Shopify</);assert.equal((allowed.match(/id="connect-shopify"/g)||[]).length,1);assert.equal((allowed.match(/data-oauth-connect="shopify"/g)||[]).length,1);
 for(const input of [{connectionCapacity:{remaining:0,hardLimit:1}},{currentUser:{role:'staff'}},{commercialCapabilities:[]},{providerCatalog:[{...data.providerCatalog[0],available:false}]}]){const locked=await renderConnections({...data,...input});assert.doesNotMatch(locked,/>Connect another Shopify</);assert.match(locked,/>Manage Shopify</);}
});

test('Connections presents Stripe as one top-level OAuth flow when configured', async () => {
  const html = await renderConnections({
    connections: [],
    paymentAccount: { connected: false, source: null, because: 'No payment account is connected.' },
    paymentConnect: { connected: false, available: true, flow: 'oauth', embedded: true, testMode: true },
    paymentWebhookUrl: 'https://foundry.example.test/webhooks/payments/stripe/workspace',
    paymentReturnOrigin: 'https://foundry.example.test',
    currentWorkspaceId: 'wsp_example',
    workspaceName: 'Example Inventory',
    providerCatalog: [],
    newConnectionToken: null,
    currentUser: { role: 'owner' },
    csrfToken: 'test-csrf',
    helpers: { icon() { return ''; }, timeAgo() { return ''; } },
  });

  assert.match(html, />Connect Stripe</);
  assert.match(html, /href="\/settings\/connections\/payments\/launch\?ticket=test-launch-ticket"/);
  assert.doesNotMatch(html, /target="_blank"/);
  assert.match(html, /data-provider-connect data-provider-type="stripe"/);
  assert.match(html, /src="\/provider-connect.js\?v=test"/);
  const popup=require('node:fs').readFileSync(require.resolve('../../src/web/public/provider-connect.js'),'utf8');
  assert.match(popup,/window\.open\(url.href/);
  assert.match(popup,/popup=yes,width=680,height=780/);
  assert.match(popup,/if\(!popup\)\{blocked\(link,name\)/);
  assert.match(popup,/Continuing in this tab/);
  assert.match(popup,/location.assign\(url.href\)/);
  assert.match(html, /Stripe is in test mode on this installation/);
  assert.match(html, /choose the account this business already uses/);
  assert.match(popup, /foundry:stripe-return/);
  assert.match(popup, /event.origin!==location.origin/);
  assert.match(popup, /event.data.workspaceId!==host\?\.dataset.workspaceId/);
  assert.doesNotMatch(html, /id="stripe-onboarding"/);
  assert.doesNotMatch(html, /connect-js\.stripe\.com/);
  assert.doesNotMatch(html, /Stripe secret key/);
  assert.doesNotMatch(html, /Paste a secret key instead/);
});

test('Connections presents hosted onboarding as business-owned Stripe setup', async () => {
  const html = await renderConnections({
    connections: [],
    paymentAccount: { connected: false, source: null, because: 'No payment account is connected.' },
    paymentConnect: { connected: false, available: true, flow: 'hosted', embedded: true, testMode: true },
    paymentWebhookUrl: 'https://foundry.example.test/webhooks/payments/stripe/workspace',
    paymentReturnOrigin: 'https://foundry.example.test',
    currentWorkspaceId: 'wsp_example',
    workspaceName: 'Example Inventory', providerCatalog: [], newConnectionToken: null,
    currentUser: { role: 'owner' }, csrfToken: 'test-csrf',
    helpers: { icon() { return ''; }, timeAgo() { return ''; } },
  });

  assert.match(html, /Create sandbox merchant account/);
  assert.match(html, /account belongs to the business/);
  assert.match(html, /pays out to its bank/);
  assert.match(html, /href="\/settings\/connections\/payments\/launch\?ticket=test-launch-ticket"/);
  assert.doesNotMatch(html, /name="secretKey"/);
});

test('an unfinished hosted attempt is not presented as a connected Stripe account', async () => {
  const html = await renderConnections({
    connections: [],
    paymentAccount: { connected: true, source: 'connect', chargesEnabled: false,
      liveMode: false, displayName: 'Example', accountId: 'acct_example',
      because: 'Stripe is not accepting charges.' },
    paymentConnect: { connected: true, available: true, flow: 'hosted', embedded: false, unfinished: true },
    paymentWebhookUrl: '', paymentReturnOrigin: '', workspaceName: 'Example Inventory',
    currentWorkspaceId: 'wsp_example',
    providerCatalog: [], newConnectionToken: null, currentUser: { role: 'owner' },
    csrfToken: 'test-csrf', helpers: { icon() { return ''; }, timeAgo() { return ''; } },
  });

  assert.match(html, /Unfinished Stripe setup/);
  assert.match(html, /new-account onboarding/);
  assert.match(html, /Discard unfinished setup/);
  assert.match(html, /Continue Stripe setup/);
  assert.doesNotMatch(html, /Connected to Example/);
});

test('a connected test account that cannot take charges can resume Stripe setup', async () => {
  const html = await renderConnections({
    connections: [],
    paymentAccount: { connected: true, source: 'connect', chargesEnabled: false,
      liveMode: false, displayName: 'Example', accountId: 'acct_example',
      because: 'Stripe is not accepting charges.' },
    paymentConnect: { connected: true, available: true, flow: 'oauth', embedded: false,
      unfinished: false, testMode: true },
    paymentWebhookUrl: '', paymentReturnOrigin: '', workspaceName: 'Example Inventory',
    currentWorkspaceId: 'wsp_example',
    providerCatalog: [], newConnectionToken: null, currentUser: { role: 'owner' },
    csrfToken: 'test-csrf', helpers: { icon() { return ''; }, timeAgo() { return ''; } },
  });

  assert.match(html, /Connected to Example/);
  assert.match(html, /Finish Stripe sandbox setup/);
  assert.match(html, /href="https:\/\/dashboard\.stripe\.com\/acct_example\/test\/account\/status"/);
  assert.match(html, /Check Stripe status/);
  assert.doesNotMatch(html, /Discard unfinished setup/);
});

test('Stripe tab paints a useful loading state before StockChief asks Stripe for the URL', async () => {
  const html = await ejs.renderFile(path.join(views, 'payment-start.ejs'), {
    postPath: '/settings/connections/payments/connect', csrfToken: 'test-csrf',
  });

  assert.match(html, /Opening Stripe securely/);
  assert.match(html, /Stripe may take a moment to check the account/);
  assert.match(html, /method="post" action="\/settings\/connections\/payments\/connect"/);
  assert.match(html, /stripe-start-form/);
  assert.match(html, /requestAnimationFrame/);
});

test('Stripe return page updates the Connections window and closes the popup', async () => {
  const html = await ejs.renderFile(path.join(views, 'payment-return.ejs'), {
    outcome: { connected: true, chargesEnabled: true,
      workspaceId: 'wsp_example', inventoryName: 'Example Inventory',
      message: 'Example Stripe is connected and ready to take payments.' },
  });

  assert.match(html, /Stripe is connected/);
  assert.match(html, /window\.opener\.postMessage/);
  assert.match(html, /postMessage\(message, '\*'\)/);
  assert.match(html, /window\.setTimeout\(function \(\) \{ window\.close\(\); \}, 500\)/);
  assert.match(html, /Return to StockChief/);
  assert.match(html, /StockChief inventory:<\/strong> Example Inventory/);
  assert.match(html, /workspaceId: "wsp_example"/);
});

test('a denied Stripe attempt is not counted as a working connection', async () => {
  const html = await renderConnections({
    connections: [{ id: 'conn_failed', provider_type: 'stripe', status: 'disconnected',
      setup_status: 'AUTHORIZATION_FAILED', provider_account_id: 'acct_old',
      provider_account_name: 'Old sandbox', credential_ref: null, capabilities: [],
      last_error: 'The user denied your request', publicStatus: 'Disconnected' }],
    paymentAccount: { connected: false, source: null,
      because: 'No payment account is connected.' },
    paymentConnect: { connected: false, available: true, testMode: true,
      lastAttemptError: 'The user denied your request' },
    paymentWebhookUrl: '', paymentReturnOrigin: '', currentWorkspaceId: 'wsp_example',
    workspaceName: 'Example Inventory', providerCatalog: [], newConnectionToken: null,
    currentUser: { role: 'owner' }, csrfToken: 'test-csrf',
    helpers: { icon() { return ''; }, timeAgo() { return ''; } },
  });

  assert.match(html, /Stripe was not connected/);
  assert.match(html, /last Stripe attempt for Example Inventory did not complete/i);
  assert.doesNotMatch(html, /Old sandbox · no events yet/);
  assert.doesNotMatch(html, />1 connected</);
});

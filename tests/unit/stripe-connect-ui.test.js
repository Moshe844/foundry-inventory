'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

const views = path.join(__dirname, '..', '..', 'src', 'web', 'views', 'connections');

test('Connections presents Stripe as one top-level sign-in flow, without nested or embedded setup', async () => {
  const html = await ejs.renderFile(path.join(views, 'index.ejs'), {
    connections: [],
    paymentAccount: { connected: false, source: null, because: 'No payment account is connected.' },
    paymentConnect: { connected: false, available: true, embedded: true, testMode: true },
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
  assert.match(html, /href="\/settings\/connections\/payments\/start"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /data-stripe-connect/);
  assert.match(html, /window\.open\(link\.href, 'foundry-stripe-connect'/);
  assert.match(html, /popup=yes,width=620,height=760/);
  assert.match(html, /Stripe is in test mode on this installation/);
  assert.match(html, /fetch\('\/settings\/connections\/payments\/state'/);
  assert.match(html, /window\.setInterval/);
  assert.match(html, /choose the account this business already uses/);
  assert.match(html, /foundry:stripe-return/);
  assert.match(html, /trustedStripeReturnOrigins/);
  assert.match(html, /https:\/\/foundry\.example\.test/);
  assert.doesNotMatch(html, /id="stripe-onboarding"/);
  assert.doesNotMatch(html, /connect-js\.stripe\.com/);
  assert.doesNotMatch(html, /Stripe secret key/);
  assert.doesNotMatch(html, /Paste a secret key instead/);
});

test('Connections never replaces missing OAuth with onboarding or API-key entry', async () => {
  const html = await ejs.renderFile(path.join(views, 'index.ejs'), {
    connections: [],
    paymentAccount: { connected: false, source: null, because: 'No payment account is connected.' },
    paymentConnect: { connected: false, available: false, embedded: true },
    paymentWebhookUrl: 'https://foundry.example.test/webhooks/payments/stripe/workspace',
    paymentReturnOrigin: 'https://foundry.example.test',
    currentWorkspaceId: 'wsp_example',
    workspaceName: 'Example Inventory', providerCatalog: [], newConnectionToken: null,
    currentUser: { role: 'owner' }, csrfToken: 'test-csrf',
    helpers: { icon() { return ''; }, timeAgo() { return ''; } },
  });

  assert.match(html, /Stripe account sign-in is not ready/);
  assert.match(html, /will not[\s\S]*new-account application/);
  assert.doesNotMatch(html, /href="\/settings\/connections\/payments\/start"/);
  assert.doesNotMatch(html, /name="secretKey"/);
});

test('an unfinished hosted attempt is not presented as a connected Stripe account', async () => {
  const html = await ejs.renderFile(path.join(views, 'index.ejs'), {
    connections: [],
    paymentAccount: { connected: true, source: 'connect', chargesEnabled: false,
      liveMode: false, displayName: 'Example', accountId: 'acct_example',
      because: 'Stripe is not accepting charges.' },
    paymentConnect: { connected: true, available: true, embedded: false, unfinished: true },
    paymentWebhookUrl: '', paymentReturnOrigin: '', workspaceName: 'Example Inventory',
    currentWorkspaceId: 'wsp_example',
    providerCatalog: [], newConnectionToken: null, currentUser: { role: 'owner' },
    csrfToken: 'test-csrf', helpers: { icon() { return ''; }, timeAgo() { return ''; } },
  });

  assert.match(html, /Unfinished Stripe setup/);
  assert.match(html, /new-account onboarding/);
  assert.match(html, /Discard unfinished setup/);
  assert.match(html, /Connect existing Stripe account/);
  assert.doesNotMatch(html, /Connected to Example/);
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
  const html = await ejs.renderFile(path.join(views, 'index.ejs'), {
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

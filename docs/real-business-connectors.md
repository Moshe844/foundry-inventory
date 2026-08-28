# Real business connectors

Foundry's Shopify, Square, Clover, and WooCommerce connectors translate provider activity into the Mission 11 normalized event contract. Provider payloads never write balances directly. Custom POS, ERP, and WMS systems use the same contract through **Custom business system**.

## Business-owner setup

1. Open **Settings → Connections**.
2. Choose Shopify, Square, Clover, WooCommerce, or Custom business system.
3. Sign in with the provider and approve access.
4. Select provider locations.
5. Resolve only records that Foundry could not match safely.

Catalog and location discovery does not replay historical sales. **Compare recent provider history** is read-only: it reports missing evidence without changing stock.

## Deployment configuration

Real providers must be able to redirect to and send signed webhooks to a public HTTPS Foundry URL.

```text
FOUNDRY_PUBLIC_URL=https://foundry.example.com
FOUNDRY_CONNECTION_ENCRYPTION_KEY=<deployment secret>

SHOPIFY_CLIENT_ID=<Shopify app client ID>
SHOPIFY_CLIENT_SECRET=<Shopify app client secret>

SQUARE_APPLICATION_ID=<Square application ID>
SQUARE_APPLICATION_SECRET=<Square application secret>
SQUARE_WEBHOOK_SIGNATURE_KEY=<Square webhook signature key>
SQUARE_ENVIRONMENT=production

CLOVER_CLIENT_ID=<Clover app ID>
CLOVER_CLIENT_SECRET=<Clover app secret>
CLOVER_WEBHOOK_AUTH_CODE=<Clover Auth Code shown in Clover Webhooks settings>
CLOVER_ENVIRONMENT=production
```

For a single Sandbox test account, Foundry can instead use Square's personal Sandbox token. This mode is never used in production:

```text
SQUARE_ENVIRONMENT=sandbox
SQUARE_APPLICATION_ID=<Sandbox application ID>
SQUARE_SANDBOX_ACCESS_TOKEN=<personal Sandbox access token>
```

Foundry then discovers the Sandbox merchant and registers its signed webhook subscription automatically. Production and multi-merchant connections continue to use OAuth.

Register these redirect URLs in the provider app settings:

- Shopify: `https://foundry.example.com/settings/connections/shopify/callback`
- Square: `https://foundry.example.com/settings/connections/square/callback`
- Square webhooks: `https://foundry.example.com/api/v1/connections/square/webhooks`
- Clover: `https://foundry.example.com/settings/connections/clover/callback`
- Clover webhooks: `https://foundry.example.com/api/v1/connections/clover/webhooks`

WooCommerce uses its Application Authentication Endpoint; the owner enters the store URL and WooCommerce returns scoped API keys to Foundry's HTTPS callback. Foundry creates or updates one signed webhook per required WooCommerce topic, so reconnecting does not accumulate duplicate subscriptions.

Clover uses the expiring v2 OAuth flow. The merchant chooses the Clover account during authorization. Clover webhooks are configured once at the app level, verified with `X-Clover-Auth`, and routed by merchant ID to the matching workspace. Foundry refreshes Clover's single-use refresh-token pair before provider API calls.

In Clover's developer dashboard, grant read access to Merchant, Inventory, Orders, and Payments. Add the Clover redirect URL above, subscribe the app-level webhook to Merchant, Inventory, Orders, and Payments, and set its callback to the Clover webhook URL above. Copy Clover's webhook Auth Code into `CLOVER_WEBHOOK_AUTH_CODE`. This is a one-time deployment setup; each business owner then only authorizes their own merchant in Foundry.

Credentials are encrypted with AES-256-GCM and scoped to one workspace connection. Logs, connection configuration, rendered pages, and normalized events never contain usable provider credentials.

## Safety behavior

- Replayed provider delivery IDs result in one Foundry action.
- Unknown products or locations create one **Needs You** mapping request.
- Unselected provider locations are audited as ignored.
- Financial refunds are not treated as physical returns without restock evidence.
- Disconnecting removes the stored provider credential while preserving mappings and audit history.
- Reconciliation reports discrepancies and never overwrites Foundry balances.

Custom POS/ERP teams can use the generic Foundry Events API described in [foundry-events-api.md](foundry-events-api.md).

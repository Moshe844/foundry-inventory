# Render staging deployment

This is the deployment contract for the native PostgreSQL StockChief process. It does not create subscriptions and it does not permit a production SQLite fallback.

## Existing hosted resource

- Render project: `My project`
- Render environment: `Staging`
- PostgreSQL resource: `stockchief-staging`
- PostgreSQL: version 17, Virginia, paid
- Public qualification origin: `https://qualify.stockchiefhq.com`

`render.yaml` references that existing database by resource name and private `connectionString`. It does not declare a second database and it does not put a database password in source control.

## Processes

- `stockchief-staging-web`: `npm run start:postgres-web`, HTTP readiness at `/readyz`
- `stockchief-staging-worker`: `npm run start:postgres-worker`, no public endpoint
- Both run `npm run db:apply:postgres` before deployment and retain the startup migration check. Migrations are serialized by a PostgreSQL advisory transaction lock.
- Both explicitly declare `FOUNDRY_DATABASE_PRIVATE_NETWORK=true`, so Render's injected internal URL uses the private network without forcing certificate verification against the database's optional self-signed TLS endpoint. External database URLs still require TLS and reject insecure fallback modes.
- Both use the same generated connection-encryption key. The web process additionally uses the same stable session secret across every instance.
- Render's `RENDER_GIT_COMMIT` is the immutable release identity recorded by readiness and certification.

The Blueprint deliberately sets `autoDeployTrigger: off`. Render CLI 2.28.0 validated it against the StockChief workspace on September 24, 2026 (`valid: true`, four planned actions, zero validation errors). Syncing it creates two paid `1c-2g` services at the current Render price of $25/month each. The new recurring compute is therefore $50/month, or $73.50/month including the already-approved staging database, before third-party usage. It must not be synced until that exact recurring price is approved.

## Secrets outside source control

The Blueprint generates only StockChief-owned internal secrets. Add provider credentials in a Render environment group and link the group to every process that needs them. Never paste these values into Git, a ticket, or chat.

Required before deployed release certification:

- `RESEND_API_KEY`, `FOUNDRY_FROM_EMAIL`, `FOUNDRY_SUPPORT_EMAIL`
- `FOUNDRY_ALERT_WEBHOOK_URL`; optionally `FOUNDRY_ALERT_WEBHOOK_TOKEN`
- `ANTHROPIC_API_KEY` and any explicit model overrides

Required only for the corresponding integration qualification:

- Gmail: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUBSUB_VERIFICATION_TOKEN`
- Microsoft 365: `MICROSOFT365_CLIENT_ID`, `MICROSOFT365_CLIENT_SECRET`, `MICROSOFT365_TENANT`
- QuickBooks: `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_ENVIRONMENT`
- Xero: `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`
- Shopify: `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`
- Square: `SQUARE_APPLICATION_ID`, `SQUARE_APPLICATION_SECRET`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_ENVIRONMENT`
- Clover: `CLOVER_CLIENT_ID`, `CLOVER_CLIENT_SECRET`, `CLOVER_WEBHOOK_AUTH_CODE`, `CLOVER_ENVIRONMENT`
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; Connect also uses `STRIPE_CONNECT_CLIENT_ID`
- Shipping: the selected provider key and webhook secret, such as `SHIPENGINE_API_KEY`, `SHIPPO_API_KEY` plus `SHIPPO_WEBHOOK_SECRET`, or `EASYPOST_API_KEY` plus `EASYPOST_WEBHOOK_SECRET`

Provider credentials belong to StockChief's platform environment only when they identify the platform application. Each user's OAuth tokens, connected-account identity, carrier account and accounting company remain encrypted PostgreSQL records scoped to that user's workspace.

## Deployment sequence

1. Approve the $50/month recurring price for the two web/worker services.
2. Commit and push the validated PostgreSQL release to the existing GitHub repository's `main` branch, then sync `render.yaml` from that exact commit.
3. Add the external provider and operational secrets through Render, without copying local `.env` files wholesale.
4. Verify the custom domain and every OAuth callback resolves to `https://qualify.stockchiefhq.com`.
5. Apply schema migrations to the empty staging database and run a no-customer-data smoke test.
6. Migrate a consistent SQLite snapshot with `npm run db:migrate:postgres -- <snapshot-path>`. The migration must report every table matched and balanced journals before cutover.
7. Run two consecutive deployed browser suites for the same `RENDER_GIT_COMMIT`.
8. Run the 15-minute load soak, 1,000-job worker throughput, concurrency/duplicate/crash tests and inventory/accounting reconciliation.
9. Trigger a Render logical export, restore it into a separate database, point a temporary web process at the restored database, and verify the business through the UI.
10. Exercise rollback to the previous application release and record the hosting evidence.

The production gate remains blocked until steps 7–10 record passing release checkpoints.

## Recovery contract

The paid Render PostgreSQL service provides point-in-time recovery and on-demand logical exports. StockChief also retains `npm run backup:postgres` and `npm run restore:test:postgres` for independent, fingerprinted `pg_dump`/`pg_restore` drills. Those commands require a durable backup destination and a separate empty restore database; an ephemeral web or worker filesystem is not a backup destination.

# Xero customer connections on Starter

This release enables merchant-authorized, read-only Xero connections from Settings → Connections on Starter, Growth and Pro. Customers use their own Xero login and select their own company; they do not create developer applications or supply shared credentials.

Activation requires the existing production app's client ID in `STOCKCHIEF_XERO_STARTER_CLIENT_ID` and `STOCKCHIEF_XERO_STARTER_CUSTOMERS_APPROVED=1`. The ID must match the configured Xero application. These controls do not enable QuickBooks or any other unqualified provider.

The application-wide maximum is five distinct Xero organisations, conservatively including the existing pilot. All active, paused and reconnect-required organisations count. Short-lived consent reservations and transactional admission prevent concurrent customers exceeding this cap. Reconnecting a known organisation does not consume another slot. At capacity, existing customers can manage/reconnect; new customers receive a support message. No code path purchases an upgrade, changes a customer plan or expands this limit.

Initial consent requests read-only scopes. Customer connections cannot request posting scopes, choose posting authority, enable journal exports or send invoices/bills to Xero. Read-only comparisons and optional product matching/import affect StockChief only. The existing private Pilot authorization is preserved separately.

Normal subscription access, refunds, expired trials, explicit entitlement denials, ownership, per-account connection limits and tenant checks remain enforced. Provider-specific access must use the saved provider or a verified request destination; never grant generic accounting access to enable Xero.

Setting the customer approval flag to `0` pauses new/replacement consent. Already qualified read grants and subscription checkout remain available, bound to the approved application identity. Preserve the client-ID pin when pausing signups.

Before activation, run the hosted remaining-connector qualification, all-plan browser checks and commercial preservation checks. Deploy the reviewed commit to the worker, then the web service. Compare production subscriptions, unrelated connections/grants and runtime settings with the pre-release baseline; verify checkout remains open and the public Xero catalog is available. Do not fabricate customer OAuth grants for production verification.

Starter is free with up to five connections per the [Xero pricing page](https://developer.xero.com/pricing). Broader capacity requires a separate approved provider-plan change; this release does not authorize one.

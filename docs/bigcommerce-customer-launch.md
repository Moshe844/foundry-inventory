# BigCommerce customer rollout

Prepared 2026-11-26. Customer activation remains off. The verified owned-store pilot is not a Marketplace approval or a qualification of every commerce workflow.

The owner reports having no Partner account. The current registration form rejects email aliases and requires an individual company email, legal entity/contact and business address/phone, plus explicit agreement and authority acknowledgements. The supplied support alias was used only to reach the form; no application or agreement was submitted. The published [developer terms](https://www.commerce.com/partner-agreement/partc/) state a $99 one-time non-refundable App Store submission fee unless otherwise agreed, and 20% revenue share for Public Apps outside Unified Billing. Customer distribution therefore cannot be represented as free. The owner's no-new-charges constraint remains in force: do not submit, accept these obligations, or enable customer admission without actual commercial authorization or a documented applicable waiver.

## Admission and rollback

`STOCKCHIEF_BIGCOMMERCE_CUSTOMER_COHORT` is absent by default. It permits at most ten unique stores, each bound to one inventory and the configured application. Do not configure it until distribution and commercial terms have been reviewed and recorded. Credentials alone do not enable customer admission.

Example shape (placeholders, not a deployment configuration):

```json
{
  "appId": "REGISTERED_CLIENT_ID",
  "distributionApproved": true,
  "commercialApproved": true,
  "approvalReference": "URL or release record containing actual distribution and fee approval",
  "stores": { "APPROVED_INVENTORY_ID": ["APPROVED_STORE_HASH"] }
}
```

Set the same reviewed value on web and worker only after customer qualification. Malformed, duplicate, wrong-app, oversized, or unapproved configurations fail closed. Begin and callback both enforce admission; callback rechecks the current owner, plan capability and capacity. An active store cannot be reassigned from another inventory merely by changing the allowlist. Existing credentials are preserved on failed consent.

The customer proof is separate from `bigcommerceTestEvidence`. Its app, inventory, store, authorizing owner and approval reference are checked by the commercial release guard. API cost classification covers only the existing adapter's allowlisted catalog, inventory, store, order-read and hook endpoints. It does not authorize subscriptions, payments, new API operations or provider fees.

Removing a cohort entry stops new authorization and can close commercial checkout for its active, now-unqualified connection. It does **not** automatically revoke an existing token or disable a stock/price policy. For an operational rollback, first pause the exact connection or review turning its write-back policies off; verify any in-flight delivery before retrying or making manual corrections. Revert code only to a previously qualified release and preserve recorded evidence and credentials. Never re-send an uncertain write just to clear an error.

## Customer setup

The connection page's owner-only form prepares the existing governed `connection.commerce_sync` proposal. It selects one exact SKU/location, separate stock/price directions and an explicit starting source. Submission does not execute the proposal. The review shows currency and quantities without raw internal IDs or integrity hashes. Default initial authority requires equal values. Normal plan, mapping, costed-stock, conflict, idempotency and approval checks remain in force.

The public guide is served at `/integrations/bigcommerce` after this change is deployed. The signed app-load landing opens StockChief in a new tab and provides guide/support links, preserving the BigCommerce control-panel frame. Installation still uses the original session-bound authorization handoff. Store users do not automatically become StockChief users.

## Evidence and remaining release gates

See `output/bigcommerce-production-20261125/live-verification-20261126.json` for the original live observations and `customer-launch-progress-20261126.json` for this work. Keep historical results separate from new scope changes and local simulations.

The reduced-scope grant was refreshed on the same live connection, with 69 mapped variants and no matching issues. Fresh product-event delivery and catalog refresh were verified. `customer-live-qualification-20261126.json` records a zero-dollar guest order imported from the provider and canceled at the source, with cancellation reflected in StockChief and no shipments or money collected. The manual-order flow also exposed an archived incomplete checkout that was incorrectly imported. Its synthetic hold was explicitly canceled. The adapter now ignores unfinished status 0 (Incomplete) and 1 (Pending) before sale hydration; a regression test covers later completion and cancellation. These status definitions are documented in the [official order-status reference](https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/orders/order-status/get-order-statuses). Verify the fix live after deployment before customer activation.

Before submission/activation:

1. Sign in to the separate Technology Partner portal. Verify the account is active, obtain its real Partner ID, confirm the primary contact accepted the agreement and a contact has the Billing/Financial role. Record actual distribution and commercial terms. Do not invent a Partner ID, accept terms without owner approval, purchase a plan or enroll in a paid program.
2. Deploy the qualified code through the normal reviewed release pipeline; verify the new guide URL publicly before adding it to the listing. Revalidate installation with the reduced scope grant. The draft has been renamed StockChief and its starting price corrected to $199/month with no free trial claim. The actual StockChief checkout was observed paused; preserve that control until its underlying release conditions are resolved.
3. Verify a fresh customer install using the approved distribution route, existing-customer reconnect, cancellation/expiry, signed load, removal of a user, uninstall/reinstall and supported browser behavior. The current generic draft install route was unavailable to ordinary customers. In-app-browser verification is not Firefox/Safari certification.
4. Extend the verified zero-dollar order creation/cancellation scope to nonzero totals, update/replay behavior and supported fulfillment/refund observations using non-charging, clearly synthetic data. Do not fabricate a physical shipment or return. The newer guest-order flow works; the legacy flow did not advance. No paid transaction, physical fulfillment or financial refund is qualified.
5. Qualify positive costed-stock writes using legitimate synthetic cost evidence, variants and location combinations where advertised, and interrupted delivery/reconnect recovery. Keep unsupported compatibility badges off.
6. For the initial cohort, record an owner and support coverage; inspect account/catalog/event timestamps, retained event backlog, mapping issues, read-back status, rate-limit/retry holds and commercial warnings daily during the launch window. Use the existing connection and operations pages; do not create paid monitoring infrastructure. Renew test access through the approved partner sandbox path rather than buying a trial-store subscription without authorization.

## Local checks

Use Node 22 (the native SQLite dependency in the existing dependency installation was built for Node 22). Tests use disposable local PostgreSQL databases and mocked provider traffic. A local UI preview disables all outbound provider/model requests and uses synthetic fixture data; its screenshots are demo assets, not proof of live delivery.

```text
node --test tests/unit/bigcommerce-adapter.test.js tests/unit/bigcommerce-order-facts.test.js tests/unit/bigcommerce-callbacks.test.js tests/unit/bigcommerce-review-pilot.test.js tests/unit/bigcommerce-customer-rollout.test.js tests/unit/commerce-synchronization-form.test.js
node --test --test-concurrency=1 tests/postgres/bigcommerce-customer-rollout.test.js tests/postgres/bigcommerce-review-pilot.test.js tests/postgres/bigcommerce-webhooks.test.js tests/postgres/commerce-position-sync.test.js
node scripts/validate-customer-templates.js
git diff --check
```

`scripts/build-bigcommerce-listing-assets.js` renders the existing StockChief vector brand at the required icon/logo dimensions without an image-generation service.

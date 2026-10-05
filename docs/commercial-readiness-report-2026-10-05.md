# StockChief Commercial Readiness Report

Date: 2026-10-05

## Decision

PUBLISHED, NOT READY FOR CHECKOUT. The commercial foundation is live on the existing qualification service at the user's request, but this report does not certify paid launch. Checkout remains closed. Included usage quantities, operation weights, pack quantities and pack prices are provisional configuration, not approved economics.

The initial implementation used disposable local PostgreSQL clusters. Publication preparation additionally verified a Render-hosted backup and successfully rehearsed migration 025 against the existing hosted database inside an explicitly rolled-back transaction. That rehearsal preserved all four subscriptions (three Pro COMP and one Starter ACTIVE), confirmed closed checkout and null approval fields, and verified the new table did not remain after rollback. No hosted data was downloaded. Real model measurements used the configured model provider and synthetic business records, not production customer data. Publishing the application does not authorize live checkout or live charges.

Hosted release evidence: backup `dpg-damlkhuk1f9s739h5ga0-a/2026-10-05T18:40Z`; successful rollback-only rehearsal job `job-db1uviek1f9s738ffks0`, completed at 18:43:35 UTC.

## Publication verification

The application is published at [StockChief qualification](https://qualify.stockchiefhq.com). This is the existing Render qualification/staging environment, not a newly created production environment or an activated paid checkout.

| Release evidence | Verified result |
|---|---|
| Deployed application commit | `ab739c22c02b7959d3b5edbb6cc749d83bfbdd5b` |
| Web deployment | `dep-db1v0lbtqb8s73bedqlg`, LIVE at 18:46:35 UTC |
| Worker deployment | `dep-db1v0lks728c73aeqtgg`, LIVE at 18:46:25 UTC |
| Hosted migration | `025-commercial-wallet.sql` applied once; the second service correctly applied zero additional migrations |
| Health and readiness | Both HTTP 200; matching release SHA; zero dead or stale jobs at verification |
| Browser smoke | Home, pricing, capabilities, integrations, login and selected-plan registration HTTP 200; pricing-to-signup navigation passed |
| Desktop/mobile pricing | Four plans, four usage disclosures, no unsupported claims tested, no horizontal mobile overflow and no browser JavaScript errors |
| Backend purchase lock | Hosted job `job-db1v200m7kps73culmig` verified checkout disabled, both approvals absent and `assertCheckoutOpen` rejecting purchases |
| Existing subscriptions | All four preserved: three Pro COMP, one Starter ACTIVE; all assigned audited foundation snapshots |
| Pack approval | All six packs remain PROVISIONAL |

Hosted verification produced `COMMERCIAL_PUBLICATION_PASS` at 18:48:41 UTC. The last local pre-publication wallet/Stripe-contract/Chromium run passed 24 checks. The hosted smoke log is `data/commercial-publication-browser.log`; desktop and mobile screenshots are `data/commercial-published-pricing-desktop.png` and `data/commercial-published-pricing-mobile.png`. These publication checks did not create a customer account, submit a payment, or certify the remaining actual Stripe lifecycle tests. No release-time error entries were returned by the service error-log query during this verification window.

This report supersedes the earlier subscription certification for this working tree. Historical staging claims in that document are not evidence that this new engine has passed actual Stripe E2E.

## Release checklist

PASS LOCAL means a real local PostgreSQL or Chromium check with a deterministic Stripe/provider boundary. It does not mean an actual Stripe sandbox payment passed.

| Required evidence | Current result |
|---|---|
| Every entitlement and backend enforcement location | Registered below; central service and route, service and worker guards implemented |
| Every metered operation and call sites | Source register below, including scheduled workers and essential cost-only operations |
| Unmetered variable-cost operations equals zero | NOT CERTIFIED. Hosting, database, storage and backup usage ingestion and allocation are still missing |
| Missing cost rates equals zero | BLOCKED. Model samples have zero missing rates; connected-provider, email and infrastructure costs are not fully verified |
| Stripe recurring subscription E2E | PASS LOCAL contract/browser checks; ACTUAL STRIPE E2E NOT RUN |
| Buy More E2E | PASS LOCAL purchase, webhook and grant checks; ACTUAL STRIPE E2E NOT RUN |
| Duplicate webhook and idempotency | PASS LOCAL concurrent duplicate events, cross-event payment grant, reservation and subscription-change checks |
| Auto-top-up E2E | PASS LOCAL consent, payment ownership, concurrency, pending-spend cap and webhook activation; ACTUAL STRIPE E2E NOT RUN |
| Upgrade and downgrade | PASS LOCAL webhook-only upgrade and scheduled downgrade; actual Stripe invoice/proration and schedule execution still required |
| Failed payment and grace | PASS LOCAL fixed grace, no extension by repeated events, immediate read-only enforcement and durable notifications; actual Stripe lifecycle still required |
| Tenant isolation | PASS LOCAL owner scope, foreign workspace rejection, purchased grant isolation and separate merchant accounts |
| Browser pricing to signup to payment to entitlement | PASS LOCAL Chromium with a simulated billing boundary; actual Stripe-hosted payment flow still required |
| Realistic cost and margin simulations | Real model samples plus modeled plan volumes completed; full cost and margin remain UNKNOWN |
| Final allowances and add-on prices | WITHHELD until connected and infrastructure costs and actual Stripe evidence are trustworthy |
| Permission to enable checkout | NOT GIVEN; release remains closed |

## Implemented foundation

`src/commercial/entitlements.js` is the PostgreSQL commercial authority. `src/entitlements/postgres-service.js` is only a compatibility re-export. The SQLite entitlement service explicitly rejects PostgreSQL handles and is not a second production policy engine. Compatibility capability names resolve to canonical keys before lookup. Disabled production capabilities cannot be granted by a plan snapshot or an override.

The new `025-commercial-wallet.sql` migration preserves historical consumption, moves existing subscriptions to an explicitly audited foundation snapshot, and retires implicit overage billing. Ordinary future plan edits use versioned snapshots. The foundation migration was successfully rehearsed against actual existing subscriptions in a transaction that was rolled back; deployment applies it through the existing transactional pre-deploy migration step.

Included usage is pooled across the commercial owner's inventories. Purchased packs are assigned to the selected inventory. Customer-visible usage has exactly two categories: AI Work Credits and Connected Operations. People, inventories, locations and connections remain structural capacity limits rather than additional consumption categories.

Wallet funding is reserved before costly work. Serializable transactions, account/category advisory locks, scoped stable keys and unique database constraints prevent double allocation. Included units are allocated first, followed by purchased grants in expiry order. Commit is idempotent; a reversed reservation cannot be committed. A known failed read can explicitly re-reserve; uncertain external writes retain their reservation and produce a critical warning instead of being automatically repeated or refunded.

Thresholds 80, 95 and 100 create one durable notification per account, category and usage period. At 100 percent, purchased units can fund further work. With no funded usage, optional AI and connected processing are blocked before dispatch. Native inventory work and stored records are not deleted. Background entitlement failures become PAUSED jobs, preserve their pending provider intent, and are reconsidered after funding or access is restored. Ambiguous outcomes require reconciliation, not blind replay.

Buy More persists an immutable purchase snapshot before requesting Stripe Checkout. A redirect or provider API response never grants usage. Verified signed events must match the account, customer, payment identity, amount and currency; a unique purchase grant prevents duplicate activation across Checkout and PaymentIntent events. Purchased grants currently expire after 12 months. That expiry policy is an implementation assumption requiring commercial review, not evidence of approved pack economics.

Auto-top-up is off by default. Enabling it requires explicit versioned consent, a selected pack, a verified customer-owned payment method and a monthly spending cap. Pending or review purchases reserve spending capacity; concurrent workers cannot create multiple pending charges. Its current trigger is below 10 percent of included usage. Caps are per inventory/category and use the UTC calendar month. These mechanics must be disclosed and reviewed before enabling purchases.

Subscriptions bind to registered Stripe Price IDs, not browser parameters or stale plan metadata. Upgrade activation waits for authoritative subscription events; downgrades schedule the future term rather than immediately lowering the paid term. Repeated failures do not extend grace. Expired trial, grace or cancelled terms are read-only even before the scheduler sweep runs. Cancellation responses cannot grant new capabilities.

The Plan & Usage page presents plan, renewal, included usage, purchased grants, remaining and reserved usage, Buy More, upgrades, invoice/purchase history and auto-top-up controls. Purchase controls remain closed. Public pricing leads with supported outcomes and capabilities; usage is a two-category summary with View usage details, without publishing provisional included quantities.

## Backend entitlement register

These are the minimum tiers of the new foundation snapshots. Higher tiers inherit supported lower-tier capabilities. CONDITIONAL integrations also require a configured provider and valid authorization; a plan alone does not make an unavailable connector work. Role permissions and commercial capabilities are separate checks, and both must pass for mutations.

Locations below are repository paths. `enforcement.js` supplies mutation-route guards and scoped service wrappers; these checks do not depend on frontend visibility.

| Canonical entitlement | Minimum tier | Backend enforcement |
|---|---|---|
| `identity.core` | All | `domain/postgres-auth-service.js`, authentication/security middleware and account lifecycle; login, recovery and essential security are deliberately not blocked by billing exhaustion |
| `workspace.core` | Starter | `domain/postgres-auth-service.js` workspace creation; `domain/postgres-account-lifecycle.js` invitations; connection credential/resume guards; structural account capacity |
| `inventory.core` | Starter | `domain/postgres-catalog-service.js`, `domain/postgres-inventory-engine.js`, `commercial/enforcement.js` inventory mutation routes |
| `inventory.multi_location` | Starter | `domain/postgres-location-service.js` creation/activation and pooled location limits |
| `inventory.lot_serial` | Starter | Catalog tracking-mode changes, inventory/import execution guards |
| `inventory.counts` | Starter | Inventory count/reconciliation service and count mutation routes |
| `inventory.transfers` | Starter | `transfers/postgres-transfer-service.js` and autopilot action execution |
| `purchasing.core` | Starter | `operations/postgres-business-workflows.js` operation admission and purchasing mutation routes |
| `purchasing.suppliers` | Starter | `operations/postgres-commerce.js` supplier/service wrappers and supplier mutation routes |
| `purchasing.invoices` | Starter | Business workflow operation admission for supplier invoices and payables |
| `receiving.core` | Starter | Business workflow admission for purchase receiving and receiving mutation routes |
| `sales_orders.core` | Starter | Business workflows, commerce customer mutations, sales mutation routes |
| `fulfillment.core` | Starter | Business workflow admission for fulfillment/reservations |
| `returns.core` | Starter | `operations/postgres-returns.js` operation admission and returns mutation routes |
| `shipping.workflow` | Starter | `shipping/postgres-service.js` manual prepare/pack/handoff and fulfillment route guard |
| `payments.customer` | Starter | `payments/postgres-connect.js`, `payments/postgres-collection.js`, provider-effect worker preflight and funded execution |
| `accounting.core` | Starter | `accounting/postgres-ledger.js` posting/settings and accounting/business-workflow mutation admission |
| `accounting.reports` | Starter | `accounting/postgres-reports.js` exported report guards; stored reports allow read-only access |
| `ask.lookup` | Starter | Ask service/model wrapper and Ask route guard; deterministic lookups do not consume model credits |
| `ask.prepare_actions` | Starter | Model instruction wrapper and `assistant/postgres-service.js` proposal execution; business-domain guards recheck actual actions |
| `connections.commerce` | Starter | OAuth begin/callback/discovery, signed commerce normalization and transactional event ingestion |
| `imports.spreadsheet` | Starter | `imports/postgres-service.js` analysis/approval/execution and import routes; AI mapping only consumes credits if actually called |
| `operations.alerts` | Starter | Settings alert preference mutation guard and native Needs You; essential system/security alerts remain available |
| `communications.email_ingestion` | Growth | Provider connection admission, `connections/postgres-mail.js` capture, mailbox poll and push-renewal workers |
| `communications.send_approved` | Growth | Reply/outbound queue and execution services, provider-effect worker preflight |
| `connections.accounting` | Growth | Accounting OAuth/discovery/authority selection and provider HTTP admission |
| `accounting.sync` | Growth | `accounting/postgres-integration-sync.js` funded read/shadow sync |
| `accounting.explanations` | Growth | `assistant/postgres-service.js` period-based accounting explanation branch; deterministic evidence, not an unsupported AI document feature |
| `shipping.rates` | Growth | Shipping connection, funded rate request and carrier HTTP admission |
| `shipping.labels` | Growth | Label queue, provider-effect worker preflight and funded purchase |
| `shipping.tracking` | Growth | Funded tracking refresh; verified callbacks for existing shipments are essential reconciliation |
| `planning.basic` | Growth | `forecasting/postgres-planning-service.js` service wrappers and planning mutations |
| `planning.transfer_before_buy` | Growth | Planning overview/service guard before computing or writing transfer-before-buy recommendations |
| `authority.advanced` | Pro | `autopilot/postgres-service.js` policy/authority configuration and instruction application |
| `automation.transfers` | Pro | Autopilot execution guard plus native transfer capability, transactional usage and cost event |
| `automation.purchasing` | Pro | Autopilot execution guard plus native purchasing capability, transactional usage and cost event |
| `warehouse.advanced` | Pro | `operations/postgres-fulfillment-waves.js` waves/bins/scans and warehouse mutation routes |
| `accounting.post_connected` | Pro | Export enable/queue/execute checks and accounting export provider-effect worker preflight |
| `api.public` | Pro | Public API client creation, token authentication and every authenticated read/command; native command guard is also checked |
| `connections.custom_api` | Enterprise | Reference/live-feed creation and custom event-ingestion checks; `integrations.custom` resolves to this same authority |

The following canonical keys are DISABLED on every tier: `inventory.kits`, `shipping.automation`, `communications.ai_drafts`, `communications.auto_send`, `documents.extraction`, `migration.assisted`, `adaptive_optimization`, `support.priority`. Their aliases remain disabled. Manufacturing, EDI, SSO and other nonexistent capabilities are not registered or marketed as available. Enterprise custom integrations mean the implemented API/event-feed path, not arbitrary promised integrations.

Compatibility aliases are exhaustively listed in `src/commercial/catalog.js`: email connection/extraction to email ingestion; commerce/accounting connection keys to canonical connections; forecasting/replenishment to planning; Ask, merchant payments, sales, purchasing, suppliers, receiving, accounting and Needs You to their canonical keys; document processing and response generation to disabled capabilities; custom integrations to the Enterprise feed capability. They do not form a separate policy system.

Structural limits are enforced under scoped account locks in workspace creation, invitation membership, location creation/activation and connector authorization. Existing over-limit records are retained after downgrade; new capacity is not granted merely because historical data exists.

## Production operation and cost register

Operation weights below are provisional. Connected Operations count funded logical work; internal HTTP attempts and model tokens are tracked separately, including retries and failed attempts. Nested HTTP work inside a funded logical operation does not double-charge the customer category. A provider call is not free merely because customer usage was reversed.

| Operation | Customer usage | Production call sites and entry paths |
|---|---|---|
| Model-assisted Ask | AI Work Credits, currently 1 | `assistant/postgres-service.js` via `commercial/model.js`; `web/routes/postgres-ask.js` |
| Standing instruction interpretation | AI Work Credits, currently 3 | `manager/postgres-operating-instructions.js` via model wrapper; Ask and settings interpretation/clarification paths |
| Ambiguous spreadsheet mapping | AI Work Credits, currently 5 | `imports/postgres-service.js`, `imports/mapping-service.js` via model wrapper; import analysis route |
| OAuth exchange, connection discovery, accounting verification and webhook registration | Connected Operations | `connections/postgres-provider-service.js` begin/callback; provider credential refresh uses shared HTTP admission/cost interception |
| Provider catalog discovery/synchronization | Connected Operations | `connections/postgres-provider-sync.js`; `provider.catalog-sync` worker |
| Accepted business mailbox message | Connected Operations | `connections/postgres-mail.js` transactional capture; duplicates do not create new capture usage |
| Mailbox polling | Connected Operations | `operations/postgres-runtime-handlers.js` mailboxPoll; scheduled and push-woken `mailbox.poll` jobs |
| Mailbox push renewal | Connected Operations | runtime mailboxPushRenewal; scheduled `mailbox.renew-push` jobs |
| Approved reply send | Connected Operations | `connections/postgres-mail.js` executeSendEffect; `provider.effect` for `mail.reply.send` |
| Approved outbound send | Connected Operations | `connections/postgres-outbound-mail.js` executeSendEffect; `provider.effect` for `mail.outbound.send` |
| Commerce/custom operating event accepted | Connected Operations | `connections/postgres-event-ingestion.js` ingestBatch; signed Shopify/Square/WooCommerce/Clover routes and reference event-feed route |
| Provider enrichment of incoming webhook | Connected Operations when outside a funded operation | `web/routes/postgres-provider-webhooks.js` scoped normalization, shared provider HTTP boundary; replayed enrichment can incur actual provider requests before event deduplication |
| Public API read | Connected Operations | `web/routes/postgres-public-api.js` funded read wrapper |
| Public API command | Connected Operations | `connections/postgres-public-api.js` transactional execute; native inventory/business command capability also enforced |
| Accounting read/shadow synchronization | Connected Operations | `accounting/postgres-integration-sync.js` sync and funded provider reads |
| Approved connected journal export | Connected Operations | integration executeExportEffect; `provider.effect` for `accounting.journal.export` |
| Carrier rates | Connected Operations | `shipping/postgres-service.js` funded getRates from shipping routes |
| Purchased carrier label | Connected Operations | shipping executeLabelPurchaseEffect; `provider.effect` for `shipping.label.purchase` |
| Manual tracking refresh | Connected Operations | shipping refreshTracking from shipping routes |
| Stripe merchant authorization and status refresh | Connected Operations | `payments/postgres-connect.js` callback/refresh and merchant connection routes |
| Merchant customer creation, hosted invoice request, refund request | Connected Operations for each actual funded logical step | `payments/postgres-collection.js` request/refund effect executors; scheduled `provider.effect`; customer ID persisted before the next invoice step |
| Automatic native transfer/purchase execution | Connected Operations | `autopilot/postgres-service.js` automatic execution, same transaction as business action; scheduled `autopilot.evaluate` |
| Other scoped operating HTTP request | Connected Operations if not already funded | `lib/provider-http.js` to `commercial/network.js`, with scoped context established by the PostgreSQL app/services/workers |
| Model input/output and cache usage | Internal cost only | `commercial/model.js`, `commercial/operations.js`, `ai/providers/anthropic.js`; exact response model/API version and actual reported token quantities |
| Every shared provider HTTP attempt | Internal cost only in addition to logical customer usage | Provider HTTP boundary/network after hook; records successful and failed attempts with provider/API version |
| SaaS subscription, pack, auto-top-up and Stripe financial reconciliation requests | Internal cost only | `commercial/stripe-billing.js`, addons and `commercial.stripe-financial-sync` worker; no recursive customer usage charges for billing itself |
| Verified existing merchant payment/refund or shipment tracking callback | Internal cost only, customer usage exempt | `payments/postgres-collection.js` signed financial reconciliation and shipping applyTrackingWebhook; preserve existing business truth after suspension/downgrade |
| Disconnect/revoke existing provider authorization | Internal cost only, customer usage exempt | Merchant/provider disconnect paths with essential system context |
| Recovery, verification, billing and notification email | Internal cost only, customer usage exempt | `system.email-send` runtime handler; actual delivery attempts recorded even on failure |
| System incident webhook | Internal cost only, customer usage exempt | `operations/postgres-monitoring.js`; `system.alert-delivery` worker |
| Shared compute, PostgreSQL, storage and backups | NOT YET FULLY METERED | Hosting bill/usage ingestion, job/request resource measurements and allocation still required; global critical warning prevents a certified margin |

Manual native CRUD, deterministic Ask/reporting and planning calculations are not customer-connected usage simply because they use the database. Their compute and storage costs nevertheless belong in the internal ledger and are the remaining infrastructure coverage gap. Legacy SQLite AI/document pipelines are not advertised as PostgreSQL capabilities and are not evidence of production support.

## Revenue and cost accounting

Revenue is derived from verified Stripe invoice and purchase receipts rather than multiplying a plan's list price. Actual refunds, disputes and settled balance-transaction fees are signed adjustments with unique source identities. Current invoice payment objects and legacy PaymentIntent links are supported; missing payment binding, settlement fees, ambiguous outcomes and failed event reconciliation create visible critical warnings. Stripe's current invoice-payment shape is documented in [Invoice Payment objects](https://docs.stripe.com/api/invoice-payment/object).

The ledger is currently cash-receipt based, not accrual revenue recognition. Annual cash receipts must not be presented as a normalized monthly operating margin. Tax, credit, partial-payment, refund/dispute ordering and real Stripe balance reconciliation require sandbox evidence before relying on profitability. Paginated invoice payment lists require further reconciliation; unsupported revenue currencies block margin reporting rather than being silently summed with USD. Disputed pack access policy and operational reconciliation of unknown side effects also require release review.

Cost rates match provider, model, provider/API version, operation, unit and effective dates exactly. No wildcard model-family or free-provider fallback is used. Unknown cost amounts and legacy unsourced usage-cost estimates are NULL. Missing rates create CRITICAL warnings visible to commercial administrators; global infrastructure coverage warnings also block every account's contribution estimate. Adding an actual rate does not retroactively certify historical unknown events without reconciliation.

The seeded model rates were checked against [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) on 2026-10-05. They apply to the exact configured first-party global standard models, not regional, batch or other-provider pricing. Actual hosting/database/storage/backup, email and connection-provider contract rates have not been supplied or independently verified. They are UNKNOWN, never assumed zero.

## Real model cost simulation

The executable measurement workflow is `scripts/commercial-cost-simulation.js`, exposed as `npm run simulate:commercial`. It refuses to run without `--real-model`, uses a disposable PostgreSQL cluster and does not connect to the application's production database or Stripe. It calls the actual production wrappers for Ask, standing instructions and ambiguous mapping.

Preserved measurements, token quantities, exact model/version identifiers and per-operation aggregates are in [Commercial cost measurements](commercial-cost-measurements-2026-10-05.json). The full local working output is `data/commercial-real-cost-simulation.json`. Twenty-four calls succeeded: three Ask, two instructions and one import-mapping call for each of four plans. The Enterprise disposable test used an explicitly labeled 100-credit sample budget because Enterprise included usage is contract-defined; that budget is not a proposed customer allowance.

| Profile | SKUs | Monthly Ask / instructions / mappings | Connected operations | Half load model cost | Base model cost | Double load model cost |
|---|---:|---|---:|---:|---:|---:|
| Starter | 100 | 150 / 10 / 2 | 1,500 | $0.3031 | $0.6062 | $1.2124 |
| Growth | 500 | 800 / 60 / 10 | 18,000 | $2.4531 | $4.9063 | $9.8125 |
| Pro | 2,000 | 2,500 / 160 / 30 | 90,000 | $7.2706 | $14.5412 | $29.0824 |
| Enterprise illustrative contract | 5,000 | 8,000 / 500 / 100 | 300,000 | $22.9867 | $45.9735 | $91.9469 |

These are measured-model-cost extrapolations, not measured total monthly bills. Workload volumes are scenarios, not observed customer demand. Instruction context is bounded to 500 SKUs by the production query, so the larger catalogue scenarios do not send every SKU to the model. Six samples per profile cannot establish P95 cost, adversarial mix, seasonal peaks, failure/retry distributions or production cache efficiency.

| Profile | Ask cost per provisional credit | Instruction cost per provisional credit | Mapping cost per provisional credit |
|---|---:|---:|---:|
| Starter | $0.003123 | $0.004483 | $0.000331 |
| Growth | $0.003123 | $0.013286 | $0.000332 |
| Pro | $0.003123 | $0.013932 | $0.000316 |
| Enterprise illustrative contract | $0.003124 | $0.013880 | $0.000318 |

Model cost per provisional credit varies materially by operation and context. A single blended credit cost is not yet justified. Connected-operation unit cost, infrastructure allocation, actual subscription revenue and total margins are NULL for every profile. Subscription list amounts used by the script are illustrative scenario inputs, not Stripe receipts or approved pricing evidence.

## Test evidence

The full unit/integration regression passed all 2,091 checks with zero failures, cancellations or skips. This includes legacy compatibility coverage; it is not 2,091 actual Stripe payments. The exact final Settings and Stripe request-contract rerun also passed both checks, and the durable merchant-capability browser rerun passed its check.

The newer broad PostgreSQL/Chromium regression completed 141 checks: 140 passed and one Settings invitation-banner assertion failed. The failed assertion checked transient flash text; it has been replaced with verification of the actual invitation and queued email, with a focused rerun recorded below. The older broad run also finished 140 of 141, failing a transient merchant-capability banner assertion even though the page showed its verified ready state. Merchant OAuth passed in the newer broad regression and its targeted rerun; its capability assertion now checks persisted PostgreSQL verification rather than flash text. Neither earlier failing run is labeled fully passing.

The background/runtime, merchant payment, wallet, mail and shipping focused run passed 36 checks. The later commercial/platform, wallet, mailbox scheduling, merchant-connection and Settings run passed 64 checks, including the current invoice payment/fee binding and pause/resume changes. After removing the legacy implicit zero-cost estimate, the final wallet/control/Settings run passed all 33 checks. The separate cost-control/Settings focused run passed 10 checks. These overlapping runs are not summed into a misleading unique-test total.

Final source syntax verification passed for all 88 changed/new JavaScript files. `git diff --check` passed. The final invitation-delivery assertion verifies the specific `workspace_invitation` job category rather than counting unrelated system emails.

Evidence logs are local files under `data`: `commercial-final-postgres-regression.log`, `commercial-final-unit-regression.log`, `commercial-background-final.log`, `commercial-last-targeted.log`, and `commercial-certified-local-final.log`. They contain synthetic fixture/test data. Logs and test cases are not a substitute for actual Stripe sandbox event/payment records.

Reproducible entry points: `npm run test:commercial`, `npm run test:postgres`, `npm test`, and `npm run simulate:commercial`. Browser tests use Chromium and disposable PostgreSQL. On this Windows host PostgreSQL initialization requires the approved Node execution context; no production database permission is implied.

## Remaining work before approval

1. Stripe TEST credentials and a webhook signing secret were found in the existing hosted environment during publication preparation; the local environment remains unconfigured. Their presence alone does not certify an actual payment. Run actual isolated subscription, pack and off-session top-up payments, failed payment/authentication, upgrade proration, scheduled downgrade, renewals, refunds/disputes, duplicate/out-of-order events and browser acquisition. Retain Stripe object/event identities and reconcile actual balance fees. No live-mode keys or public checkout are needed for this stage.
2. Provide actual nonsecret hosting/database/storage/backup/email/carrier/connection-provider contract rates and usage/billing evidence. Implement infrastructure usage ingestion and a documented allocation model. Verify all production paths against observed runtime cost telemetry before claiming unmetered operations equals zero.
3. The hosted rollback-only migration rehearsal passed for existing records. A local full-database export was blocked by safety review and was not performed; the provider-side backup remains available. Additional paid-lifecycle verification must review annual periods, paid-provider outcome recovery, disputed-pack handling and paginated Stripe invoice-payment reconciliation.
4. Run broader cost samples covering maximum prompt/context sizes, model/version changes, cache variations, connected workload mixes, background polling, retries and exhausted/paused work. Establish per-operation and per-credit distributions, then produce full cost/margin scenarios using actual Stripe receipts and operating costs.
5. Recommend final included allowances, operation weights, add-on prices, pack expiry and top-up terms only after that evidence exists. Obtain explicit economics approval and explicit approval of a revised, passing Commercial Readiness Report.

`commercial/release.js` requires the environment switch, database checkout flag, economics approval and readiness approval together. Plan packaging approval alone cannot open checkout. No release-enabling endpoint was added and none of those approvals were fabricated. This blocked report is not a request to activate checkout.

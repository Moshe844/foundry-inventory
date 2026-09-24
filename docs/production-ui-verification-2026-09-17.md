# StockChief: implementation and browser verification

## Launch decision

This work improves and verifies local business workflows. It does **not** certify StockChief as production-ready or as a fully autonomous operator across every business domain. Billing and subscriptions are outside the requested scope; opening paid production onboarding is not yet justified.

No production business database was changed by these tests. No real supplier email, payment or postage purchase was authorized or executed. Production readiness requirements were not removed and certification checkpoints were not fabricated.

## Completed browser result

`npm run test:e2e` completed on September 17, 2026: **154 passed, 0 failed, 0 skipped, 0 cancelled**, in approximately 9 minutes 20 seconds. Evidence: `artifacts/ui-launch-verification.log`. The total includes parent tests as reported by Node's test runner. The six-month scenario and safe-timeout test are included in this run. `git diff --check` also passed.

This is one complete local browser pass, not two consecutive passes on an immutable deployed production release. No production browser-certification checkpoint was recorded.

## Implemented fixes

- Supervised scheduled work now prepares actual reversible purchase drafts, instead of leaving authorized preparation records without purchase orders. Committing a purchase still requires owner approval or a covering policy.
- Replenishment credits existing draft quantities. Increasing demand refreshes a compatible, unsent, automatically generated draft rather than repeatedly purchasing the full shortage. Manual, sent and committed orders are not silently rewritten. The updated order has refreshed approval integrity, audit events, provenance and prepared communication.
- Automatic purchase approval checks every order line, destination and the total revised order quantity/value. One approved policy must cover the entire consolidated order.
- Perfectly stable weekday/weekend patterns are no longer rejected solely because their within-day variance is zero. Insufficient history still does not become a confident forecast.
- Due count plans and unfinished scheduled/recount sessions become visible owner exceptions. A child recount suppresses the obsolete first-pass exception. Invalid count dates are rejected.
- Completed/prepared work wording more accurately distinguishes a draft, executed work and verification.
- Instruction interpretation has an enforced timeout even when a provider ignores cancellation. A failed interpretation visibly preserves the original request and does not guess a stock change.
- Known-product receipts can be prepared from an unambiguous quantity and location without relying on the model for those facts; approval remains required.
- Product profitability now honors product/SKU and location scope. Calendar quarter/month/year and explicit ISO ranges are resolved deterministically for this lookup. Answers show exact dates, posted revenue, posted COGS, gross profit and recorded margin. Unsupported period phrasing asks for a precise range rather than silently substituting rolling days. Missing posted sales are reported as missing evidence, not invented revenue.

## Six-month browser scenario

Run `npm run test:business-ui`. The fixture uses an isolated database and real domain services to establish 180 days of historical stock movements and posted accounting entries. Initial historical setup is not an assertion that users entered 180 days manually. After setup, business mutations and outcome assertions are performed through browser controls, not direct API requests or database result checks. The production scheduler runs normally; test-only IPC advances the fixture's JavaScript clock, not the computer clock. SQLite's native clock is not replaced.

The browser scenario checks:

1. Friday's scheduled evaluation prepares one supplier purchase draft containing genuinely consumed products, respecting case/MOQ/multiple rules, while excluding dead stock and unobserved new products.
2. Weekday/weekend forecasts disclose measured history; missing history is not invented demand.
3. A prior-quarter product margin is exactly 40.00% from $100 posted revenue and $60 posted COGS, excluding a different product's large profit and the named product's later-quarter sale.
4. A Monday count is absent on Friday/Saturday and becomes due on Monday. Matching evidence completes it without an adjustment.
5. Calendar ticks and refreshes do not duplicate supplier orders.
6. Ask reads actual current quantities. Purchase approval creates incoming stock, not physical stock; receipt updates the actual inventory.
7. Seven backdated days of sales are entered using the visible date field. The resulting demand spike replenishes the consumed product without overlapping drafts or buying unrelated stock.
8. October rollover preserves outstanding supply and surfaces the next recurring count.
9. A discrepancy remains unresolved through first-pass investigation/recount; only explicit variance approval changes inventory.
10. A deliberately stalled interpreter returns a visible safe error, retains the request, and leaves inventory unchanged. This is fault injection, not live-provider certification.

Screenshots are under `artifacts/screenshots/seasoned-business/`. The complete browser suite is `npm run test:e2e`. Local tests use the configured real AI provider with the repository's test-model preload, which defaults deep interpretation to Sonnet. A successful local test is not certification of every production model/provider override.

## Evidence boundaries by domain

| Domain | Locally exercised through screens | Not established by this work |
| --- | --- | --- |
| Inventory | Quantity, variants, serials, lots, transfers, adjustments, mobile workflows, persistence, counts and demand history | Every industry-specific model, peak-load behavior, all ten complex weekly operation scenarios |
| Purchasing | Draft preparation, supplier grouping, pack rules, approval, incoming-stock credit, partial/full receiving, retry safety | Optimal supplier/transfer cost selection, live supplier commitment and acknowledgment |
| Suppliers/email | Supplier-linked ordering and prepared order artifacts | Live mailbox OAuth/refresh, send/delivery verification, real invoice/acknowledgment reconciliation |
| Customer orders/shipping | Existing local inventory/warehouse browser regressions | Real carrier-funded label purchase, delivery events, provider outages and complete allocation prioritization |
| Payments | Existing paid-order popup/return browser regression | The external payment boundary is simulated in that test; live settlement, refunds and payment failures are not certified |
| Accounting | Product-scoped posted-ledger margin, missing-evidence behavior and existing local money workflows | Complete historical books, real bank settlement, QuickBooks/Xero sync and universal calendar-period support in every older financial lookup |
| Ask StockChief | Grounded quantities, scoped quarter margin, action preparation/approval, unsupported requests and interpretation failure | Arbitrary multi-domain instructions, every material subrequirement, all production-model configurations |

## Blocking work before paid production launch

- **Database architecture:** `src/db/index.js` explicitly exposes SQLite topology as `shared: false, multiWriter: false`. The existing production readiness contract requires a certified shared multi-writer topology. A shared-database adapter/migration and its transactional/idempotency validation remain engineering work; setting flags is not a solution.
- **Deployment:** choose the production host and immutable release, configure HTTPS and operational ownership, then prove hosted restore, rollback, alert delivery/acknowledgment and password recovery.
- **External providers:** choose/connect sandbox accounts for mailbox, payments, shipping and accounting. Certify real OAuth return/refresh, signed webhooks, replay protection, polling fallback and the external business outcomes. Never substitute fake-provider tests for this evidence.
- **Release qualification:** two consecutive complete browser passes on the same immutable deployed release, an independent zero-training walkthrough, production-like load/soak/worker tests, retention and inventory/financial reconciliation are still required.
- **Complex-operation coverage:** the ten proposed weekly jobs are acceptance requirements, not passed tests. Supplier economics, invoice/receipt discrepancy resolution, priority allocation, demand-spike uncertainty and the full Monday briefing need dedicated seeded browser scenarios before broad autonomous claims.

The remaining work is more than enabling a subscription screen. Launch should stay blocked until these conditions are fulfilled.

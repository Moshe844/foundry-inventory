# StockChief Subscription and Commercial-Control Certification

Date: 2026-10-05

## Scope

This certification covers StockChief SaaS billing, plan entitlements, usage accounting, overage protection, lifecycle changes, dunning, tenant isolation, internal cost reporting, and the customer-facing plan and billing journeys. Merchant payment collection remains a separate domain and is not used to grant StockChief SaaS access.

## Evidence classes

- **Real browser + PostgreSQL:** Playwright/Chromium exercised the rendered application, HTTP routes, sessions, and native PostgreSQL state.
- **Stripe contract:** Automated tests used a deterministic Stripe-compatible boundary to verify exact request shape, idempotency keys, signatures, event ordering, retry behavior, and server-authoritative activation without creating a real charge.
- **Live Stripe test mode:** The staging acquisition flow previously completed a Stripe test checkout. The deployed release must be rechecked after this certification commit.
- **Not claimed:** No live-mode card was charged and no production customer subscription was changed by this certification.

## Central controls certified

- One backend capability catalog and entitlement resolver governs workspace access; the browser is not the security boundary.
- Versioned plan snapshots preserve grandfathered customers.
- Workspace, promotional, temporary, enterprise, and administrative overrides remain explicit and auditable.
- Usage events are workspace- and billing-period-scoped, atomic, idempotent, and safe under concurrent workers.
- Customer-visible meters use business units rather than tokens.
- Cost events and versioned cost assumptions support subscription revenue, usage cost, overage revenue, and gross-contribution reporting.
- Public self-service plans cannot be approved unless each customer-visible meter has an included allowance and a valid overage policy.
- Paid overage preparation only includes meters configured for billing.
- Paid entitlements activate only from server-confirmed subscription state, never from a browser success URL.
- Upgrade, scheduled downgrade, cancellation, reactivation, grace, restriction, and read-only data-preservation behavior are enforced server-side.

## Requested 40-scenario matrix

| # | Scenario | Evidence | Result |
|---:|---|---|---|
| 1 | New Starter signup | Public/auth browser journey plus paid-workspace provisioning rules | PASS |
| 2 | New Growth signup | Chromium commercial journey and server-confirmed Growth activation | PASS |
| 3 | New Pro signup | Paid-workspace annual Pro browser journey | PASS |
| 4 | Enterprise override | `commercial-platform` scenario 7 | PASS |
| 5 | Monthly subscription | Public pricing and checkout contract | PASS |
| 6 | Annual subscription | Public pricing and paid-workspace annual signup | PASS |
| 7 | Checkout abandoned | Expired checkout releases reserved promotion, scenario 23 | PASS |
| 8 | Payment declined/incomplete | Incomplete payment cannot provision an operational workspace | PASS |
| 9 | Checkout success | Server-confirmed checkout browser journey | PASS |
| 10 | Duplicate checkout webhook | Stable event identity and retry-safe event transaction | PASS |
| 11 | Entitlements activate after authoritative confirmation | Chromium Growth/Pro activation and checkout-completion guard | PASS |
| 12 | Starter blocked from Growth capability | Scenario 1 and Ask scenario 24 | PASS |
| 13 | Growth allowed | Scenario 2 and Ask scenario 25 | PASS |
| 14 | Growth blocked from Pro capability | Chromium plan transition assertions | PASS |
| 15 | Frontend reflects backend entitlement | Real Chromium commercial-control journey | PASS |
| 16 | Included usage increments | Scenario 3 and Chromium usage display | PASS |
| 17 | Duplicate operation does not double-meter | Scenario 4 and public API replay test | PASS |
| 18 | Concurrent metering | `commercial-control-system` concurrent hard-limit test | PASS |
| 19 | 80% warning | Durable threshold test | PASS |
| 20 | 100% allowance reached | Durable threshold and hard-limit tests | PASS |
| 21 | Overage calculation | Scenario 6 | PASS |
| 22 | Starter to Growth upgrade | Scenario 2 | PASS |
| 23 | Growth to Pro upgrade | Real Chromium lifecycle test | PASS |
| 24 | Proration | Exact Stripe preview and update amount in lifecycle browser/contract tests | PASS |
| 25 | Downgrade scheduled | Real Chromium lifecycle test | PASS |
| 26 | Over-limit downgrade safe | Scenario 8 and lifecycle resource-excess checks | PASS |
| 27 | Cancel at renewal | Real Chromium lifecycle test and scenario 10 | PASS |
| 28 | Reactivate | Real Chromium lifecycle test | PASS |
| 29 | Failed renewal | Scenario 9 and notification scenario 30 | PASS |
| 30 | Grace period | Scenarios 9, 17, and 21 | PASS |
| 31 | Recovery after payment update | Server-authoritative subscription update path | PASS |
| 32 | Restriction after grace | Scenarios 20, 31, and 32 | PASS |
| 33 | Existing data remains accessible | Scenarios 8 and 11 | PASS |
| 34 | Billing-period reset | Scenario 5 | PASS |
| 35 | Enterprise custom limits | Scenarios 7 and 29 | PASS |
| 36 | Admin entitlement override | Scenario 7 | PASS |
| 37 | Promotion/trial override | Scenarios 22 and 23 | PASS |
| 38 | Workspace isolation | Shared-workspace ownership, tenant suites, and scoped usage tests | PASS |
| 39 | Stripe ordering and retries | Scenarios 16, 17, 21, 33, 34 plus stale-event control test | PASS |
| 40 | Internal cost/margin reconciliation | Versioned cost and duplicate-safe margin test | PASS |

## Variable-cost coverage

- Model-backed Ask and nested operating-instruction work records provider usage and internal cost events.
- AI-assisted import mapping meters only when an AI mapping is actually invoked; exact duplicate imports reuse prior mappings and do not spend or meter twice.
- Public API write events meter atomically with the business transaction and count a replay once.
- Customer-visible allowance policy and internal unit-cost assumptions are centralized configuration, not code constants.
- Document-page extraction remains disabled and is not sold as an active entitlement.

## Validation results

- Core regression suite: **2,091 passed, 0 failed, 0 skipped**.
- PostgreSQL and real-browser suite: **121 passed, 0 failed, 0 skipped**.
- Focused commercial/lifecycle/metering suite: **51 passed, 0 failed, 0 skipped**.
- Whitespace/error check: `git diff --check` passed.

## Deployment gate

Before calling this release live-ready:

1. Deploy this exact commit to the staging web and worker services.
2. Verify the release reference from `/healthz` on the public staging hostname.
3. Run the acquisition flow against Stripe test mode through the deployed browser.
4. Confirm the production Stripe account has the intended live products/prices, webhook secret, billing portal policy, tax policy, statement descriptor, dunning rules, and verified support identity before accepting live money.
5. Enter commercially approved included allowances, overage rates, and internal cost assumptions. StockChief intentionally does not invent these numbers.

## Known limitations

- Automated Stripe tests certify the integration contract and failure semantics; they do not constitute a live-mode financial transaction.
- Commercial allowances and cost assumptions are configurable business decisions. A self-service plan remains blocked from checkout when its customer-visible metering policy is incomplete.
- Live customer charging should remain disabled until the final staging test-mode pass and production Stripe configuration review are complete.

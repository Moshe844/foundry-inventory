# Commercial recommendation for owner approval — 5 October 2026

**Decision state:** this is a proposed economic configuration, **not** an active price list or approved allowance. Checkout remains closed; no deployment or public-pricing change was made. [Machine-readable assumptions and calculations](commercial-launch-recommendation-2026-10-05.json) are reproducible with `npm run simulate:commercial:recommendation`. The prior [readiness evidence](commercial-readiness-blocker-closure-2026-10-05.md), including 98 real model attempts and genuine Stripe TEST flows, remains intact.

## Recommendation

| Plan | Proposed monthly price | AI Work Credits | Connected Operations | Current backend structural limits (inventories / people / locations / connections) |
|---|---:|---:|---:|---|
| Starter | **$199** | **650** | **2,000** | **1 / 3 / 3 / 2** |
| Growth | **$499** | **2,500** | **20,000** | **3 / 15 / 10 / 8** |
| Pro | **$999** | **8,500** | **70,000** | **10 / 50 / 50 / 25** |

These structural limits are from the current PostgreSQL commercial plan rows, not newly invented features. Keep the existing capability progression and its backend gates. The proposed meter weights are **Ask 1**, **policy/standing-instruction interpretation 7**, **import mapping 5** AI credits per successful operation; failed provider work remains an internal cost but consumes zero customer credits. A normal Pro workload uses about **7,700 AI / 68,920 Connected**, so it fits the included pools. A high-volume Pro workload uses **14,200 / 146,200** and therefore requires explicit Buy More or pauses—there is no implicit overage. The 70,000 Connected allowance, rather than the previous 80,000, is the economic boundary; the 8,500 AI balance preserves ordinary Ask usefulness while weighting the costlier policy operation more appropriately.

**Buy More (proposed, 12-month purchased-unit validity):** 500 AI / **$49**; 2,500 AI / **$239**; 10,000 Connected / **$79**; 50,000 Connected / **$349**. The 500-AI and 10,000-Connected packs are the only proposed *available* auto-top-up choices, each disabled by default and requiring explicit consent, saved payment method, and a monthly spending cap. Larger packs are manual. These are recommended economics, not Stripe Prices or approved database rows. The underlying provisional catalog differs; do not expose these numbers to customers until owner approval, plan-version migration, and fresh E2E tests.

**Enterprise:** negotiated contract, never implicit unlimited spend. The order form specifies capabilities, active workspaces, included units, model-dollar ceilings, merchant/provider fee payer, service level, true-up/pack rules, and payment terms. The same entitlement, reservation, usage, and cost ledgers enforce it. Pass-through postage, carrier, and merchant-payment charges remain the merchant's unless explicitly contracted otherwise.

## Provider cost responsibility

The [machine-checkable classification](../src/commercial/provider-cost-responsibility.js) covers every current connector catalog entry plus the four PostgreSQL shipping adapters. Its regression rejects a new unclassified connector, and every unverified contractual fee has a **null** rate. This distinguishes the commercial payer from who makes the API request:

| Provider / operation | Merchant-paid or pass-through | StockChief-paid cost | Unknown requiring confirmation |
|---|---|---|---|
| Shopify, Square, Clover, WooCommerce | Merchant's store/POS subscription and customer-payment/transaction charges. | Shared processing and any StockChief delivery infrastructure. | App/API/partner-specific fee or contract. |
| Gmail, Microsoft 365, supplier email | Merchant's mailbox/Workspace/M365 subscription. | StockChief polling, parsing, storage and outbound app infrastructure. | Any StockChief OAuth/Graph/Gmail API monetary fee; no $0 assumption. |
| QuickBooks Online, Xero | Merchant's accounting subscription and their own payment services. | StockChief sync and database workload. | StockChief integration/API-specific charges. |
| ShipEngine, ShipStation, EasyPost, Shippo | Postage, labels, carrier charges, seller-account fees on the merchant's connected account/key. | StockChief orchestration and tracking processing. | Any platform, referral, API or partner fee billed to StockChief. |
| Merchant Stripe Connect/direct charge | Merchant's customer-payment processing, refunds and disputes **when the connected account is confirmed as fee/loss payer**. New hosted onboarding requests Stripe as both fee and loss collector; OAuth-connected existing accounts need verification. | StockChief-side API orchestration. | Connect platform-specific charge or any account with platform fee/loss responsibility. |
| StockChief subscription and Buy More Stripe account | Not a merchant pass-through. | Actual Stripe balance-transaction fees, refunds and disputes on StockChief revenue, plus Billing-volume fees. | Future live negotiated fee schedule; updated simulation uses the public 2.9% Payments + 0.7% Billing baseline and $0.30 fixed fee as a reserve, not a claimed contract. |
| Anthropic / Resend | None. | Model token charges including failed attempts; system email delivery/overage. | Resend paid-plan/overage terms remain unverified. |
| Custom public API / reference webhook | Merchant's own sending-system costs. | StockChief web/worker/PostgreSQL/egress. | Custom integration contracts; `erp_future` is not a production-ready connector. |
| Render | None. | Shared web, worker, PostgreSQL, storage, backups and egress. | External object-store/offsite-backup contract and measured production capacity. |

Code evidence: [merchant Stripe account context](../src/payments/postgres-collection.js) routes API calls with `Stripe-Account`; [new hosted accounts](../src/payments/connect.js) request Stripe fee/loss responsibility; [shipping accounts](../src/shipping/postgres-accounts.js) require a workspace key. [Stripe explains](https://docs.stripe.com/connect/accounts-v2/connected-account-configuration) that the Connect `fees_collector` setting determines who pays direct-charge fees. [EasyPost's referral guide](https://docs.easypost.com/guides/get-started-with-forge/easypost-managed-billing-guide) describes merchant-owned billing methods/wallets. A provider-specific StockChief contractual/API charge cannot be proven from account ownership alone; the null entries remain launch checks.

## Shared Render launch cost, not fictitious dedicated servers

The actual `render.yaml` contains **one shared 1c-2g web service, one shared 1c-2g worker and one shared PostgreSQL database**, not one stack per customer. The authenticated partial September Render invoice was **$22.75** and October's unbilled provider forecast **$73.50**. Current [Render pricing](https://render.com/pricing) lists **$25/month** each for 1c-2g web/worker, **$19/month** for 0.5c-1g Postgres, **$0.30/GB-month** database disk and **$0.15/GB** billable outbound bandwidth after the shared included allowance. We use **$69/month** compute/database floor, then a **1.5× operator capacity reserve** ($103.50 shared pool); disk and egress are added from estimated tenant usage. Paid Postgres logical backup is included by Render, but external/offsite backups remain unknown. The pool is allocated at a conservative **five active workspaces** (two Starter, two Growth, one Pro): 50% equally and 50% using *hypothetical* workload weights 1/3/8, with the shared 5 GB egress credit spread proportionately. Connected activity gets a further **$0.0005/operation capacity reserve**; this is **not** a provider fee or observed unit tariff.

| Workspace workload | Shared compute + database + storage/egress allocation | Cost confidence |
|---|---:|---|
| Starter normal / heavy | **$13.90 / $18.04** | Render rates high; occupancy, load weights, storage/egress mix low |
| Growth normal / heavy | **$22.65 / $33.35** | Same |
| Pro normal / heavy | **$46.20 / $71.20** | Same |
| Full-allowance guarded-stress infrastructure: Starter / Growth / Pro | **$27.06 / $50.02 / $106.79** | Heavy-profile allocation ×1.5; low-confidence capacity reserve |

Early underutilization is explicit: with **one paying workspace**, the entire shared pool falls on that customer. Fully allocated normal margin would be **44.2% Starter, 72.6% Growth, 78.3% Pro**. At three workspaces it is **85.4% / 87.2% / 83.5%**; at five, **89.4% / 89.2% / 85.1%**. A one-customer Starter launch therefore has platform-level fixed-cost burn, even though marginal tenant economics are good. Do not shrink Starter's useful allowance to conceal an occupancy problem. Validate actual scaling before treating five-workspace allocation as measured.

## Cost and sensitivity results

These are **estimated contribution margins**, not certified GAAP gross margins or actual Stripe receipts. Merchant pass-through fees are excluded; unknown StockChief contractual/API fees remain `null`, not $0. The model component uses the measured 98-call Anthropic distribution; all Render allocation, connected-capacity, email and live payment-fee inputs are labeled estimates. Heavy rows require *opt-in* packs to complete the whole stated demand; without packs they pause at included exhaustion.

| Monthly workload | AI / Connected demand | Revenue including hypothetical packs | Estimated StockChief cost | Normal/heavy contribution margin |
|---|---:|---:|---:|---:|
| Starter normal | 93 / 245 | $199 | $21.11 | **89.4%** |
| Starter heavy | 635 / 1,550 | $199 | $28.69 | **85.6%** |
| Growth normal | 1,360 / 15,740 | $499 | $53.71 | **89.2%** |
| Growth heavy, opt-in Buy More | 3,340 / 38,280 | $755 ($256 packs) | $96.39 | **87.2%** |
| Pro normal | 7,700 / 68,920 | $999 | $149.35 | **85.1%** |
| Pro heavy, opt-in Buy More | 14,200 / 146,200 | $2,161 ($1,162 packs) | $292.97 | **86.4%** |

At 50% / 100% of included allowance, projected cost is Starter **$23.96 / $27.34**, Growth **$55.37 / $71.83**, Pro **$134.59 / $190.70**. Full-allowance guarded stress includes **2× measured p95 AI mix**, **2× connected capacity reserve**, heavy storage/egress and email, and **1.5× heavy infrastructure allocation**. Pro's proposed **$100 account-period model-cost ceiling** binds at that stress; ordinary Ask at measured cost does not approach it.

| Full included allowance | Current guarded stress | +25% provider **and** infrastructure | +50% provider **and** infrastructure | 2× expensive AI/provider only | First joint-cost multiplier below 60% |
|---|---:|---:|---:|---:|---:|
| Starter | **76.3%** | **71.2%** | **66.1%** | **70.5%** | **1.80×** |
| Growth | **73.5%** | **67.7%** | **61.9%** | **67.3%** | **1.58×** |
| Pro | **68.8%** | **64.3%** | **59.8% — unsafe against 60% target** | **68.5%**, with AI paused at cap | **1.49×** |

The Pro stress cost is **$312.06**: **$100** bounded model work, **$70** connected-capacity reserve, **$106.79** allocated shared/storage/egress infrastructure, **$3** system email reserve, and **$32.27** assumed StockChief subscription processing fee. The old 28.8% guarded case treated every Connected Operation as a $0.005 StockChief-paid provider charge. That is not a justified subscription COGS assumption for merchant-owned postage or merchant payment processing; it has been replaced by an explicit StockChief infrastructure reserve plus **unpriced contractual fees**. This is a change in payer classification, not a claim that API calls are free.

At the 60% target, full-allowance Pro stress has only **$0.0013 per Connected Operation** of headroom for an additional StockChief-paid platform/API fee; under +25% cost the headroom shrinks further, and under +50% it is already negative. Growth's current headroom is **$0.0034/op**. Therefore any provider contract billing StockChief more than the applicable headroom makes that scenario unsafe; do not enable such a connector without repricing, pass-through, or a provider-specific cap. The conservative 50,000-op pack has **$0.0016/op** extra-fee headroom at its 60% stress target. These are *break-even thresholds*, not guessed provider fees.

| Proposed pack | Full-use stress margin | +50% cost | 2× expensive cost |
|---|---:|---:|---:|
| 500 AI / $49 | 78.9% | 70.2% | **61.5%** |
| 2,500 AI / $239 | 78.9% | 70.0% | **61.2%** |
| 10,000 Connected / $79 | 83.8% | 77.4% | **71.1%** |
| 50,000 Connected / $349 | 82.4% | 75.2% | **68.1%** |

All four are above the configurable 60% target *under the stated known/estimated costs*, including 2× expensive cost. They are **not certified against an unknown StockChief-paid provider contract**. The same caveat applies to every plan margin.

## Guardrails and approval conditions

Keep the already implemented pre-provider operation bounds and account/workspace transaction-safe holds. Proposed monthly account model-dollar ceilings: **Starter $25, Growth $75, Pro $100**; Enterprise contract-specific. This changes configuration only *after* approval. The normal Pro median model spend is about **$35.82**, exploratory p95 about **$48.07**, so the $100 cap protects against repeated costly policy/failure work without making routine low-cost Ask unusable. At 2× p95 model prices, even normal Pro can approach the cap; it must pause or use an approved cheaper path, never silently exceed it. A higher-cap exception requires priced approval, not unlimited customer credit redemption. Customer usage still gives 80%/95%/100% committed, deduplicated notices, purchased-unit drawdown, explicit opt-in top-up, and pause on exhaustion.

**Important Buy More implementation condition:** the current fixed period-dollar cap does not automatically increase when a customer buys AI credits. AI packs should not be sold or auto-purchased if the remaining provider-dollar ceiling makes the pack materially unusable. Before approving these packs for checkout, implement a purchase-time budget-availability check or a financially bounded, refund-aware paid-pack dollar increment, then E2E it. A credit pack must never imply a promise of unlimited provider dollars. This is an outstanding launch gate, not hidden by the favorable pack simulation.

Approval should also require: (1) confirm fee/loss collector on each merchant Stripe connection; (2) collect terms/invoices for any StockChief-billed connector/API/partner fee or keep that connector unavailable; (3) verify five-workspace capacity with production-representative load; (4) approve/apply versioned plan quantities, AI weights, pack catalog and dollar caps; (5) rerun genuine Stripe TEST and commercial regressions after the changes; (6) only then revisit checkout authorization. The 60% target is configurable; the +50% Pro breach is intentionally visible for a pricing/allowance/target decision, not silently tuned away.

## Replace estimates with customer-1 telemetry

From the first paying customer, retain per-workspace/period: AI provider, model and pricing version, exact input/output/cache tokens, provider cost, retries and failed-call cost; operation/credit identity and reserved versus committed units; connected call provider/account identity, payer class, endpoint, quota units, bytes, elapsed time, retry/status and any actual platform fee; mailbox polls and push deliveries; orders/events, accounting sync, carrier/rate/label/tracking and autonomous-job counts; measured web/worker CPU time, database query time/count, storage bytes and external egress bytes; active workspaces and capacity saturation; Resend messages and invoice; Render resource-level invoice lines; actual Stripe cash, fees, refunds and disputes. Reconcile vendor invoice totals to tenant allocations with a separate unallocated shared-overhead line. The existing resource table already captures request/job elapsed time and database queries; it does **not** yet prove CPU, storage bytes or egress attribution. Promote an estimate to `MEASURED` only after invoice tie-out and period-matched allocation; missing/changed rates remain critical health failures.

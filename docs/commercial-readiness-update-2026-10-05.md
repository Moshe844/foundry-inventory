# Commercial Readiness Update — October 5, 2026

> Historical checkpoint. The subsequent [blocker-closure evidence](commercial-readiness-blocker-closure-2026-10-05.md) contains the expanded 98-call measurement, dollar guardrails, real Stripe TEST invoice reconciliation, and current release decision. Do not treat the 69-call figures below as the latest recommendation.

**Decision: NOT READY FOR CHECKOUT OR DEPLOYMENT.** This update implements cost instrumentation, cash-ledger correction, historic rate reconciliation, an AI-attempt safety limit, 69 real model-backed measurements, and seven workload simulations. Allowances and prices below are **provisional review candidates**, not approved configuration. The production pack table, public pricing, and checkout flag were not changed. No deployment or live charge was made. The [full preceding audit](commercial-readiness-report-2026-10-05.md) remains the entitlement/call-site inventory; this update supersedes its earlier six-sample economics conclusion.

## Measured cost, not projected monthly bills

A disposable PostgreSQL run exercised the production Ask, standing-instruction/policy, and import-mapping pathways with the configured Anthropic models. There were **69 actual model-backed attempts**, with zero missing model rate matches in this sample. Six instructions failed after incurring model cost; their customer credits reversed. Three Pro instruction probes used a synthetic 500-SKU catalogue with unusually long item labels. The non-sensitive distribution and raw-evidence SHA-256 are in [the measured cost summary](commercial-model-cost-distribution-2026-10-05.json); raw prompts and cost rows remain git-ignored.

| Operation | Model/API version | Priced attempts | Median / exploratory P90 / P95 | Largest observed | Failed-but-billed |
|---|---|---:|---:|---:|---:|
| Ask StockChief | Anthropic `claude-haiku-4-5-20251001` / `2023-06-01` | 24 | $0.002912 / $0.003572 / $0.003572 | $0.003572 | 0 |
| Standing instruction/policy interpretation | Anthropic `claude-sonnet-5` / `2023-06-01` | 24 | $0.039734 / $0.071166 / $0.071632 | $0.071872 | 6 |
| Import mapping | Anthropic `claude-haiku-4-5-20251001` / `2023-06-01` | 21 | $0.001640 / $0.001680 / $0.001680 | $0.001690 | 0 |

These are measured **per-call** costs, not actual monthly costs or a verified maximum. Twenty-four observations and deliberate tail probes do **not** establish a production P95. The exact model/version token rates came from [Anthropic's first-party price table](https://platform.claude.com/docs/en/about-claude/pricing); rate/version changes require renewed measurement.

Gmail now records [Google's published per-method quota units](https://developers.google.com/workspace/gmail/api/reference/quota): profile 1, history.list 2, messages.list 5, messages.get 20, attachment get 20, send 100, watch 100. This is separate from the customer-visible Connected Operation, including scheduled/system polling. A missing monetary quota rate remains `NULL` with a critical warning, never silently $0. PostgreSQL coverage verifies that a sourced LOW-confidence estimate reprices the historical event and resolves its warning. Other connected HTTP attempts retain provider/version/request measurements but need actual rates or explicit conservative estimates. No blanket free Gmail rate was seeded.

Rates now record `VERIFIED_PUBLIC`, `VERIFIED_CONTRACT`, `CONSERVATIVE_ESTIMATE`, or `UNVERIFIED`, plus LOW/MEDIUM/HIGH confidence. The admin view separates measured and provisional cost subtotals; it does not certify a margin containing estimates. Existing shared web/worker occupancy and database-query telemetry remains workload evidence, **not** a made-up tenant hosting invoice. A durable PostgreSQL UTC-day ceiling defaults to 250 model attempts and 12 failures/account (configurable); denied attempts reverse reserved credits before calling the provider. This is not a maximum-dollar guarantee for long prompts or simultaneous calls.

## Seven realistic monthly workflow hypotheses

The reproducible [scenario file](commercial-readiness-simulation-2026-10-05.json) lists Ask, successful/failed instructions, mappings, five-minute mailbox polls, messages/sends, commerce events, accounting sync, shipping/rate/tracking, automation, background jobs, system email, storage, and egress. One connected mailbox produces **8,640 modeled scheduled polls** in 30 days while the present polling fallback operates. The volumes are hypotheses, not measured customer demand. Only per-call model costs above are measured.

The following **projected** margins use repository **unapproved** monthly list-price scenarios ($199/$499/$999), Render's **$73.50 forecast** divided among an assumed ten customers, a configurable **$0.002/Connected Operation risk reserve**, **$0.001/system email reserve**, and an unverified **3.2% + $0.30/payment** fee assumption. They are **not actual Stripe revenue or certified margins**. Storage and egress use the displayed Render invoice rates only for projected increments above shared included capacity.

| Profile | AI credits | Connected ops | Monthly model extrapolation at measured median | Projected cost / margin | Stress margin: 2× model, 2.5× connected, 4× shared hosting |
|---|---:|---:|---:|---:|---:|
| Starter/light | 77 | 245 | $0.34 | $14.86 / 92.5% | 80.7% |
| Starter/heavy | 495 | 1,550 | $2.54 | $19.73 / 90.1% | 73.9% |
| Growth/normal | 1,040 | 15,740 | $5.45 | $60.70 / 87.8% | 71.6% |
| Growth/heavy | 2,460 | 38,280 | $14.00 | $127.13 / 84.1% **only with opt-in Buy More** | 62.8% with packs |
| Pro/normal | 5,700 | 68,920 | $27.72 | $211.03 / 78.9% | 49.0% |
| Pro/heavy | 9,800 | 146,200 | $57.27 | $456.30 / 79.9% **only with opt-in packs** | 52.7% with packs |
| Extreme/abusive | 9,999 | 309,120 | $146.74 | $979.29 / 78.2% **only with opt-in packs** | 47.2% with packs |

Without purchased capacity, the three marked demand profiles **pause at the included limit**; they are not quietly executed at plan price. Hypothetical additional pack revenue is $300 Growth/heavy, $1,274 Pro/heavy, and $3,492 extreme/abusive. No actual purchases are assumed. The connected reserve is a **LOW-confidence risk budget**, not a claim that a provider charges StockChief $0.002 per request. The Render September **paid partial-month** invoice was $22.75; October's $73.50 is a forecast, not a paid full-month bill or validated ten-tenant capacity. Resend Free was $0 only within 100/day and 3,000/month; the email reserve represents paid-plan risk, not an unlimited free rate.

For **both** AI Work Credits and Connected Operations, a committed crossing of **80%, 95%, and 100% of included usage** queues one durable, idempotent owner notification per threshold/category/billing period. A displayed warning based on a reservation does not consume that notification identity; reversals do not burn purchased capacity. At 100% of included usage, already-purchased units remain usable. Once **included plus purchased** capacity is exhausted, new manual and background variable-cost work is denied or paused **before** the provider call; existing business data remains readable and no implicit overage invoice is created. Auto-top-up is attempted only after explicit consent, within the customer's monthly cap, and only when checkout is separately enabled and approved. Because checkout is currently closed, no top-up or Buy More charge can occur.

## Review candidates and margin tradeoff

Provisional included monthly usage: Starter **500 AI / 2,000 Connected**, Growth **2,500 AI / 20,000 Connected**, Pro **8,000 AI / 80,000 Connected**. This fits the normal/light profiles and Starter/heavy; heavier Growth/Pro usage needs explicit Buy More. Candidate packs: **500 AI/$69**, **2,500 AI/$329**, **5,000 Connected/$75**, **25,000 Connected/$349**. The 500-AI and 5,000-Connected packs are candidate auto-top-ups only with explicit opt-in and the existing customer-controlled monthly spending cap. Under the configured 60% contribution target, the packs show about **60–63% projected margin** in the stated stressed unit-cost case, before unmeasured operating expenses. None was added to Stripe or approved in the commercial database.

At **full included consumption** using the most expensive observed P95-per-credit mix, projected base/stress margins are Starter **84.9% / 64.9%**, Growth **75.3% / 46.9%**, and Pro **60.9% / 15.5%**. At the current provisional list prices, a 60% stress target would require about **$173 Starter, $677 Growth, and $2,206 Pro/month** under these exact assumptions. That is a sensitivity result, **not** a recommendation to publish $2,206 Pro. It exposes the decision: verify connected-provider costs/capacity, constrain maximum model-dollar exposure, or change Pro price/allowance economics. We did not cut normal usable allowances simply to manufacture a passing target. The target and assumptions are configurable in [readiness-simulation.js](../src/commercial/readiness-simulation.js).

## Financial reconciliation and remaining launch blockers

The signed `invoice.paid` webhook now records a **zero-amount unverified** subscription receipt with a critical warning, then queues an authoritative Stripe invoice/payment read. Only verified cash net of supported tax updates revenue. Reconciliation is idempotent; changed already-verified cash and nonzero unverified receipts are rejected. This fixes the prior false-margin path where a webhook amount affected revenue before cash attribution. PostgreSQL regressions cover revenue before/after sync, duplicate reconciliation, zero-cash credit, ambiguous tax+credit, carried debit, and overpayment. The full local commercial unit/PostgreSQL/Chromium suite passed **124/124**; `git diff --check` passed. This is **not a fresh real-Stripe signed E2E after the ledger change**; prior TEST runs remain historical evidence.

| Financial case | Status |
|---|---|
| Subscription, discount, exclusive tax, customer-balance credit, split payment, pre-payment credit note | Prior genuine Stripe TEST scenarios passed; new receipt gating passes local regression. Rerun genuine signed settlement after this change. |
| Add-on funding, purchased-credit consumption/reversal, opt-in top-up, duplicate/out-of-order webhooks | Prior genuine Stripe TEST and current local regression passed; checkout remains closed. |
| Explicit Stripe fees, disputes, successful/failed refunds and compensations | Prior genuine Stripe TEST and current local regression passed; production fee-payer contract still unknown. |
| Tax plus credit requiring line-level tax attribution; positive carried debit; overpayment | **Unresolved.** Reproduced and held at zero unverified revenue with open critical warning. Requires Stripe credit-note/customer-balance provenance, correct allocation implementation, and genuine sandbox regression. |
| Unknown connected rates and shared infrastructure | **Unresolved.** No silent zero. Rate-confidence and historic backfill exist; contracts/invoices and tenant allocation are missing. |
| Maximum model-dollar exposure | **Unresolved.** Attempt/failure ceilings exist, but the 180,000-character instruction prompt/8,000-output-token policy lacks a proven dollar cap. |

Therefore **unmetered variable-cost operations = 0 is not certified** and **missing production cost rates = 0 is not certified**. Production evidence needed: a full-month Render bill with compute/database disk/backup/egress detail, per-tenant CPU/storage/traffic allocation and load validation; actual Google/Intuit/Xero/Microsoft/Shopify/shipping developer tiers and fee payer for each integration enabled at launch; a Resend volume/plan decision; real customer workload mix and larger prompt samples; and fresh isolated Stripe TEST reconciliation of the new receipt flow including the unresolved credit/balance cases. Public OAuth verification and unsupported integrations must not be marketed as ready. The environment, database, economics, and readiness gates in `commercial/release.js` still prevent checkout; no approval was fabricated.

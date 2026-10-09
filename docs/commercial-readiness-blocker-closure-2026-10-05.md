# Commercial Readiness — blocker-closure evidence, 5 October 2026

**Release decision: checkout CLOSED; no deployment in this task; no public pricing or final allowances approved.** This is an implementation and test result, not an approval request disguised as a launch. The previous [audit](commercial-readiness-report-2026-10-05.md) remains the capability inventory. The measured [model distribution](commercial-model-cost-distribution-2026-10-05.json), reproducible [seven-profile and guardrail simulation](commercial-readiness-simulation-2026-10-05.json), and ignored local genuine Stripe TEST evidence are the numerical inputs here. The provider-cost and plan-price estimates are explicitly provisional.

## What changed and was verified

- A model call now reserves both customer credits **and** a conservative maximum provider-dollar hold *before* executing. The hold is scoped per operation, workspace and billing period, transactionally serialized, then settled to recorded token cost. An unknown rate/model version, oversized prompt, or exhausted cap prevents the provider call. Default per-call ceilings: Ask $0.30, policy interpretation $1.50, import mapping $0.30; account period: Starter $25, Growth $100, Pro $250, Enterprise $250. Workspace and all operation/period ceilings are configurable. These are safety limits, **not** a promise that all nominal credits can be used in an expensive mix. An unknown outcome retains its worst-case hold and creates a critical warning.
- Failed model work retains its actual provider cost and `customerCreditsConsumed: false`, while customer usage reverses. A configurable daily failed-provider-spend threshold opens `FAILED_AI_PROVIDER_SPEND`. The disposable PostgreSQL regression verifies failure spend, zero consumed credits, long-request preflight rejection, unknown-model warning, and concurrent account-cap reservation.
- The PostgreSQL web/worker dependency graph is scanned by a machine-checkable registry. It found **37 direct outside-provider boundaries** among 362 statically reachable JS files: 16 metered, 2 internally cost-metered, 1 platform billing reconciled from Stripe, 1 public JWKS fixed infrastructure, 17 transitively loaded legacy paths that cannot execute an unmetered Anthropic/HTTP call under PostgreSQL. A new unclassified direct call fails the regression. This is a conservative static check plus fail-closed runtime gates; dynamic dependency paths still deserve review on every new feature.
- The signed invoice receipt contributes **zero revenue** until the authoritative invoice, all linked payments/intents and, where relevant, credit notes and invoice-linked customer-balance transactions reconcile. Tax is allocated to *actual invoice cash*, a positive carried balance is prior-receivable collection, and overpayment is a customer liability. The verified receipt stores these components and Stripe source IDs. Changed verified cash and unproven settlements remain critical failures.
- Genuine Stripe TEST: subscription activation after signed webhook; Buy More after one-time payment; duplicate delivery; monthly/annual renewal; prorated upgrade and scheduled downgrade; failed renewal/grace/recovery; browser pricing→signup→payment→entitlement; tenant isolation; auto-top-up and monthly cap; purchased-credit refund; actual balance-transaction fees. The separate extended genuine TEST run reconciled **nine** annual/credit/tax/carried-debit/split-payment/overpayment invoice-sync jobs with no outstanding Stripe reconciliation warnings. A further genuine edge run passed won/lost disputes and both failed/succeeded asynchronous refunds under duplicate signed delivery; it reconciled six invoice payments and 19 balance-transaction fee rows without fee/payment-binding/delivery warnings. Local ignored evidence: `data/commercial-1791246284606.json` (extended) and `data/commercial-1791246470583.json` (edge).
- Full commercial unit, disposable PostgreSQL and Chromium regression suite: **130/130 passed**, including the direct-Anthropic guard regression. Checkout remains locked by environment plus database release control.

Both genuine Stripe TEST reports have `passed: true`, `complete: true`, and zero test-facility blockers. The extended run retains one expected **UNVERIFIED_INFRASTRUCTURE_COSTS** warning; the edge run retains **MISSING_COST_RATE**, **REFUNDED_SPENT_USAGE**, and **UNVERIFIED_INFRASTRUCTURE_COSTS**. The spent-credit warning is deliberate: a refund cannot unconsume work StockChief already performed, so the loss stays visible. These are **not** fee/payment-binding/delivery reconciliation failures, but they do prevent an all-costs-known commercial certification.

## Actual AI measurement and failed-work exposure

The disposable PostgreSQL harness made **98 actual Anthropic-backed calls** through the production Ask, operating-instruction and import-mapping paths, with **zero missing model rate matches**. Public model/version token rates are from [Anthropic's first-party pricing](https://platform.claude.com/docs/en/about-claude/pricing). This is a deliberately skewed exploratory sample, not a production customer-demand percentile or a guaranteed upper bound.

| Operation | Priced calls | Median | Exploratory p95 | Largest observed | Failed after provider spend |
|---|---:|---:|---:|---:|---:|
| Ask StockChief | 28 | $0.002914 | $0.006741 | $0.007826 | 0 |
| Policy/standing instruction | 45 | $0.055286 | $0.059428 | $0.060618 | 15 |
| Import mapping | 25 | $0.001645 | $0.005846 | $0.005846 | 0 |

The **15 failed policy calls cost StockChief $0.804504**, including a $0.060618 failed outlier; those calls consumed **zero customer credits**. Twenty-four medium-long catalogue policy probes reached the model. A separate oversized-catalogue probe was rejected before provider execution by the $1.50 policy bound; it was not misreported as a free AI success. Four larger Ask contexts and four wide imports did reach the model after raising the disposable sample's daily *failure-count* ceiling only; the production dollar limits remained unchanged. The per-plan sample and raw-evidence SHA-256 are in the distribution artifact; raw prompts remain ignored locally.

For both customer-facing meters, a **committed** crossing of 80%, 95%, or 100% of included usage queues one durable, idempotent owner notification per threshold/category/billing period. Merely displaying a reservation does not consume a notification identity; a reversed provider failure consumes no customer units. At 100% of included usage, already purchased, unexpired units remain usable. When included **and** purchased capacity are exhausted, manual routes refuse and scheduled/background jobs pause **before** paid provider work; existing business data remains readable, and no implicit overage invoice is issued. Auto-top-up is attempted only after explicit opt-in and within the customer's monthly spending cap. With checkout closed, this task can trigger no live purchase or top-up.

## Why the provisional Pro stress case collapses

For the **unapproved** 8,000-AI / 80,000-Connected / $999 Pro scenario, consuming *all* allowance in the most expensive observed p95-per-credit mix gives the following **projection**, not a real tenant bill:

| Component | Baseline full allowance | Stress assumption |
|---|---:|---:|
| Model work | $158.47 | $316.95 (2× p95 mix) |
| Connected-provider risk reserve | $160.00 | $400.00 ($0.005/operation) |
| Shared Render infrastructure allocation | $7.35 | $29.40 (4× shared allocation) |
| Assumed payment fee | $32.27 | $32.27 |
| Total / contribution margin | $358.09 / **64.2%** | $778.62 / **22.1%** |

The existing $250 Pro AI-period guard lowers the stated stress model spend to $250 but **pauses further model work**; resulting margin is only **28.8%**. Thus the guard prevents runaway AI dollars, but does not solve the connected-cost exposure. The earlier 15.5% exploratory stress result used a higher long-policy p95; it is not erased by this newer sample, and the new preflight guard deliberately blocks that oversized execution path. Failed AI attempts spend real money inside the cap while issuing no customer credits. Model-price changes can make the cap activate sooner.

The offline tradeoff runner keeps the configurable 60% contribution target visible and does not mutate plans:

| Alternative | Full-allowance guarded stress margin | Normal Pro fit and cost to customer |
|---|---:|---|
| Current bundle + $250 AI cap | 28.8% | 5,700 AI / 68,920 Connected fits, but stress economics fail. |
| A. 5,000 AI / 60,000 Connected | 44.0% | Normal Pro exceeds both pools; not premium enough alone. |
| B. Policy weight 7 instead of 3, keep 8,000 / 80,000 | 40.2% | Normal mix fits; connected exposure remains. |
| C. $100 AI cap alone, keep 8,000 / 80,000 | 43.8% | Normal mix fits, but high-cost mixes pause with unused credits. |
| D. 40,000 Connected included, earlier explicit Buy More | 48.8% | Normal Pro needs hypothetical $424 in packs; never quietly spend a paid pack ahead of advertised included units. |
| E. Weight policy 7, 8,000 AI / 45,000 Connected, $100 AI cap | **61.3%** | Normal Pro AI fits but its current five-minute mailbox workload needs one hypothetical 25,000-op/$349 pack; normal-with-pack stress is **61.0%**. |
| F. Weight policy 7, $100 AI cap, keep 8,000 / 80,000 at a hypothetical **$1,499/month** | **61.5%** | Normal Pro fits both pools without packs, but a further 20% connected-cost increase lowers stress margin to **56.1%**. |
| G. Same full allowance and guardrails at a hypothetical **$1,699/month** | **65.6%** | Normal Pro fits without packs and a further 20% connected-cost increase leaves **60.9%** stress margin; the much higher sticker price may suppress demand. |

E–G are **investigation options, not approved recommendations**. E is fragile: another 20% increase above the already stressed connected-unit cost takes full-allowance contribution below the 60% target; doubling normal model cost again triggers the dollar pause. F preserves the advertised premium allowance but lacks that connected-cost buffer. G buys a buffer through price, not an engineering efficiency gain; customer willingness to pay is untested. The normal Pro workload should not silently require a pack unless that tradeoff is acceptable to customers. The unknown connected-provider fee payer and real capacity are the decisive evidence still needed.

## Monthly workflow and pack sensitivity

The seven workload hypotheses include Ask, policy failures, imports, 5-minute mailbox polling, messages/sends, orders/events, accounting sync, shipping/rates/tracking, automation/background work, system email, storage and egress. Revenue is **provisional list price plus hypothetical opt-in packs where needed**, not actual Stripe receipts. The base cost uses measured model medians and low-confidence connected/infrastructure/payment assumptions; p95 changes only the model component. Stress uses 2× model p95, 2.5× connected reserve, 4× shared hosting and 2× email reserve.

| Monthly profile | AI / Connected demand | Provisional revenue | Base cost / margin | p95 cost | Stress cost / margin | First guardrail |
|---|---:|---:|---:|---:|---:|---|
| Starter/light | 77 / 245 | $199 | $14.93 / 92.5% | $15.18 | $38.63 / 80.6% | None |
| Starter/heavy | 495 / 1,550 | $199 | $20.32 / 89.8% | $21.85 | $53.29 / 73.2% | None |
| Growth/normal | 1,040 / 15,740 | $499 | $62.02 / 87.6% | $65.14 | $144.44 / 71.1% | None |
| Growth/heavy, with opt-in packs | 2,460 / 38,280 | $799 | $130.87 / 83.6% | $137.85 | $301.62 / 62.3% | Connected included limit |
| Pro/normal | 5,700 / 68,920 | $999 | $219.13 / 78.1% | $231.38 | $514.11 / **48.5%** | None within profile |
| Pro/heavy, with opt-in packs | 9,800 / 146,200 | $2,273 | $474.35 / 79.1% | $495.07 | $1,075.01 / 52.7% | Connected included limit |
| Extreme/abusive | 9,999 / 309,120 | $4,491 hypothetical | $1,036.72 / 76.9% *if all demands execute* | $1,052.02 | **Not executable:** $438.94 model stress demand exceeds $250 Pro cap even with packs | Connected included limit first, then AI dollar cap |

At 50% / 100% of current provisional included allowances, baseline margins are Starter **89.5% / 86.0%**, Growth **86.3% / 77.3%**, Pro **80.1% / 64.2%**. At 100% stress they are **66.9% / 51.0% / 22.1%** before the AI-dollar guard; Pro guarded stress is 28.8%. Growth and Pro therefore still fail the configurable 60% target at full stress on current provisional bundles.

Unapproved pack candidates, under the same conservative *scenario* and including assumed payment fees: 500 AI/$69 **67.7%**, 2,500 AI/$329 **66.6%**, 5,000 Connected/$75 **63.1%**, 25,000 Connected/$349 **60.9%** stressed contribution. These are all above 60% **only under the assumed provider costs**; the narrow 25,000-op margin is not robust to a higher real connected fee. The small AI and Connected packs remain *candidate* opt-in auto-top-ups, constrained by explicit monthly spending caps. No pack price, allowance, Stripe Price ID, or public Pricing copy was finalized here.

Enterprise remains contractual: capabilities, included capacity, provider fee payer, AI-dollar ceiling, support obligations, payment terms and any negotiated overage must be written into the agreement and enforced through the same backend entitlement and cost ledgers. It has no approved public self-service allowance or add-on price.

## Cost confidence and remaining evidence

| Cost input | Evidence class | What is still unknown |
|---|---|---|
| Anthropic model/provider/version/token | **MEASURED provider usage; VERIFIED_PUBLIC rate; exploratory demand distribution** | Future model/rate changes and actual customer mix. Unknown versions create a critical failure, never $0. |
| Gmail API method quota units | **ESTIMATED-HIGH-CONFIDENCE quota units from [Google's table](https://developers.google.com/workspace/gmail/api/reference/quota)** | Monetary fee payer and any commercial Workspace/API contract; quota is not a dollar rate. |
| Connected HTTP/events/accounting/shipping/public API | **ESTIMATED-LOW-CONFIDENCE** $0.002/operation base, $0.005 stressed | Provider contracts, merchant-paid versus StockChief-paid attribution, actual operation mix. Unknown exact rates remain `NULL` with warnings; they do not certify margin. |
| Resend/system email | **ESTIMATED-LOW-CONFIDENCE** $0.001/message risk reserve | Actual paid plan/overage contract at scale. Observed Free-plan limits are not unlimited zero-cost delivery. |
| Render shared compute/database/storage/egress | **MEASURED partial-month invoice** $22.75; **ESTIMATED-LOW-CONFIDENCE** $73.50 October forecast ÷ assumed 10 tenants | Full-month production bill, database backups/storage/egress allocation, and tenant load/capacity validation. Render's displayed $0.30/GB-month disk and $0.15/GB egress increments are projection inputs, not actual per-tenant invoices. |
| Stripe payment fees | **MEASURED on genuine TEST balance transactions**, provisional simulation 3.2% + $0.30 | Actual live fee agreement/tax handling and future charge mix. Ledger uses actual Stripe fees when available, not this estimate. |

The dated, private Render dashboard/invoice evidence is in ignored `data/commercial-render-cost-evidence-2026-10-05.json`. A missing production cost rate still creates an open critical warning and an unknown cost amount; it does **not** become $0 or a certified contribution margin. A sourced, versioned conservative estimate can be installed and later replaced by an actual provider invoice without changing customer usage billing. The five-minute polling duty cycle is especially material to Connected Operations and should be validated against real push/poll behavior.

## Financial and release gates

| Gate | Result |
|---|---|
| Zero **known unmetered** variable-cost PostgreSQL provider paths | **YES within audited static graph and runtime gates:** 37/37 direct boundaries classified; all unscoped paid model/HTTP paths refuse before invocation. Keep the registry regression as a future-change guard. |
| Zero **silent** missing production cost rates | **YES:** unknown stays `NULL`, opens critical health warning, and blocks certified margin. **Zero actual missing connected rates: NO**; contracts/evidence remain outstanding. |
| Tax+credit, carried debit, overpayment, split payments/credit note/annual financial reconciliation | **YES in local PostgreSQL and genuine signed Stripe TEST**, including nine extended invoice jobs with no Stripe reconciliation warnings. |
| Refunds, partial refunds, unused purchased-credit reversal, consumed disputed funding, fees, failed/recovered invoices, upgrade/downgrade | **Local regression PASS; genuine Stripe TEST PASS** for purchased refund, won/lost disputes, failed/succeeded asynchronous refunds, fee reconciliation, renewal recovery and proration. |
| Real Stripe TEST subscription and Buy More E2E; duplicate signed webhook | **YES**, including actual browser card payment and authoritative entitlement/grant. |
| Maximum AI-dollar exposure bounded before provider execution | **YES under verified published rates and configured token/cost caps**; unknown provider price/outcome fails visible/closed. The cap may pause work before nominal credits run out. |
| Every candidate pack profitable under conservative scenario | **YES in the stated provisional sensitivity, NOT certified against unknown connected contracts.** |
| Starter/Growth/Pro acceptable under normal, heavy and guarded stress | **NO** for current provisional Pro; normal Pro stress is 48.5%, full guarded stress 28.8%. Growth full-allowance stress is 51.0%. E–G pass selected hypothetical margins but require an allowance or price tradeoff and unverified provider assumptions. |
| Commercial regression suite | **130/130 PASS** on the final code state. |
| Checkout / deployment / final public pricing | **CLOSED / NONE / NOT APPROVED**. |

**Do not approve final allowances or pack prices yet.** The next evidence to close is the actual fee payer/rate sheet for each production-enabled connected provider and a production-representative Render capacity/allocation measurement. If those change the $0.005 connected stress assumption, rerun the machine-generated simulator; do not silently tune allowances to a target margin. The only release switch remains subject to a separate explicit owner approval of a final readiness report.

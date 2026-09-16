# StockChief competitive and architectural audit

**Audit date:** September 7, 2026  
**Decision gate:** Audit and roadmap only. Do not begin the broad implementation until the owner approves the priorities.

## Executive verdict

StockChief is not a conventional inventory application with a chat box bolted onto it. The repository already contains a meaningful operational core: an immutable inventory movement ledger, variants, multiple locations, lot and serial enforcement, purchase and sales lifecycles, supplier-document and email understanding, internal accounting, evidence-backed forecasting, a business-state reconciler, an exception inbox, and bounded autonomous execution with post-action verification.

That is a better architectural starting point for an autonomous inventory manager than many established products have.

StockChief is **not yet the #1 inventory platform and is not yet private-beta certified**. It is currently strongest in evidence, explanations, connected business reasoning, and safe action execution. It is materially behind mature platforms in warehouse execution and operational breadth: bins, mobile/barcode workflows, stateful transfers and in-transit stock, landed costs, full returns/RMA flows, physical inventory programs, advanced fulfillment, manufacturing/kits/BOMs, EDI/ASN/3PL depth, external accounting synchronization, and production-scale infrastructure.

The website assistant is also not complete. It can answer many business questions, search records, and deep-link into important records, but it does not possess a single authoritative, permission-aware map of all 345 HTTP routes, all page actions, and all troubleshooting playbooks. Its help layer currently covers only a small set of high-level tasks. Therefore the promise “the user never has to hunt for a screen or figure out how to fix a mess” is **Partial**, not complete.

The correct product goal is:

> A mature, auditable inventory engine beneath one autonomous operator that observes, understands, reasons, acts within explicit authority, verifies the result, learns from measured outcomes, and asks the owner only for facts or decisions that truly require a human.

The immediate recommendation is to complete the P0 correctness, navigation, recovery, and production-certification work before expanding into a giant set of features.

## Method and rating standard

This audit inspected the current repository, schemas, domain services, routes, prompts, tests, operational documentation, and connection adapters. It also compared current behavior with official product documentation from Cin7, Katana, Unleashed, Fishbowl, Zoho Inventory, NetSuite, Odoo, Inventory Planner, Prediko, Finale, Extensiv, and Sortly.

Ratings mean:

- **Production-ready:** coherent end-to-end behavior, enforced invariants, permissions, recovery/idempotency where relevant, and meaningful automated coverage.
- **Partial:** substantial implementation exists, but important workflow, UX, scale, integration, or certification gaps remain.
- **Primitive:** a field, isolated operation, or narrow path exists, but not a mature business workflow.
- **Missing:** no credible end-to-end implementation was found.
- **Not applicable:** deliberately outside the intended product scope. This rating is used sparingly.

A database column alone never earns “supported.”

## Architecture found in the repository

### Operational truth

- `src/domain/inventory-engine.js` owns physical receive, issue, transfer, adjustment, and integrity verification.
- `src/db/schema.sql` stores workspaces, locations, items, variants/SKUs, balances, lots, lot balances, serials, and immutable movements.
- `src/purchasing/` owns suppliers, supplier-item mappings, replenishment rules, POs, approvals, partial receiving, supplier documents, and receipt verification.
- `src/sales/` owns customers, Sales Orders, commitments/allocations, backorders, fulfillment, shipments, and customer communication.
- `src/accounting/` consumes operational events and owns journals, valuation, receivables, payables, payments, credits, reconciliation, reports, and owner-friendly explanations. It does not own physical inventory.
- `src/connections/` normalizes external events, maps identities, rejects unsafe ambiguity, persists idempotency evidence, and supports provider-specific connections plus a documented custom event API.
- `src/shipping/` separates rate discovery from a real label purchase and stores seller credentials encrypted per workspace.

### AI and autonomy

- `src/manager/business-brain.js` assembles one business-state view spanning stock, commitments, incoming supply, customer-order risk, supplier activity, accounting, connections, and exceptions.
- `src/manager/reconciliation.js` performs deterministic cross-domain consistency checks and opens investigations instead of silently rewriting material discrepancies.
- `src/actions/execution-service.js` follows proposal → execute → reread → verify; an unverified action is not called complete.
- `src/autopilot/runner.js` plans, executes within authority, verifies, recovers interrupted work, and stops the relevant autonomous scope after verification failure.
- `src/autopilot/capabilities.js` separates authority for transfers, replenishment, policy updates, supplier mail, customer replies, payment requests, label purchases, and shipping notices.
- `src/db/schema-forecasting.sql` and `src/forecasting/` preserve forecasts, evidence, calculations, backtests, outcomes, and recommendations.

### Production controls

- Memberships are workspace-scoped; authorization is checked server-side.
- Roles currently include owner, accountant, and staff, with explicit per-membership grants.
- Sessions use secure cookies in production, CSRF protection, and request rate limiting.
- Provider secrets use AES-256-GCM and are scoped to a workspace connection.
- Background processes use database leases; connection events and action execution use idempotency and recovery paths.
- SQLite uses WAL, foreign keys, immediate write transactions, and a busy timeout.
- Verified backup and local restore-rehearsal tooling exists.

These are meaningful controls. They are not the same as production certification. External alert delivery, live password-recovery mail, monitored support, retention policy, hosting-level restore rehearsal, sustained load, and deployment rollback still need proof.

## Inventory-depth audit

| Capability | Rating | Repository evidence and reason |
|---|---|---|
| Products | Production-ready | Durable item identity, archive behavior, import/onboarding, search, audit events, and tests exist. |
| Variants / SKUs | Production-ready | Variant option values, unique SKU codes, per-SKU tracking and price/cost references are first-class. |
| Barcodes | Primitive | A barcode value exists on SKUs and can participate in import/search, but no complete scan-first receiving, picking, counting, transfer, or label-print workflow exists. |
| Units of measure | Primitive | An item unit label and supplier purchase-unit conversion exist; general alternate UOM definitions and conversion rules do not. |
| Multi-location inventory | Production-ready | Balances and movements are location-scoped; multi-location sales, receiving, transfers, valuation, and forecasting are exercised. |
| Warehouses / stores | Production-ready | Location types and per-location balances are first-class. |
| Bins / aisles / shelves / zones | Missing | No sublocation hierarchy, bin balance, putaway rule, or bin-directed work was found. |
| On-hand quantity | Production-ready | Ledger-derived, transactionally updated, and integrity checked. |
| Committed quantity | Production-ready | Sales allocations reserve stock without reducing physical on-hand. |
| Available quantity | Production-ready | Computed from physical stock and commitments and used by Sales Orders and planning. |
| On-order / incoming quantity | Production-ready | Open PO lines and supplier expectations contribute to incoming supply. |
| Reservations / allocations | Partial | Sales allocations are strong; advanced priority strategies, future-supply allocation, and reprioritization are limited. |
| Reorder points | Production-ready | Per SKU/location policy and deterministic replenishment evaluation exist. |
| Safety stock | Production-ready | Stored and applied in planning/forecasting with tests. |
| Order-up-to levels | Production-ready | Per SKU/location target stock is first-class. |
| Supplier lead times | Production-ready | Configured lead time plus measured lead-time outcomes exist. |
| Supplier SKUs | Production-ready | Supplier item codes and aliases are modeled and used in document/email mapping. |
| Supplier pricing / history | Production-ready | Current, historical, document-sourced pricing and tolerance checks exist. |
| MOQ / order multiples / pack size | Production-ready | Supplier item minimum and purchase-unit multiple behavior is tested in planning. |
| Purchase orders | Production-ready | Draft, approval, ordered, partial receipt, received, cancellation, lines, documents, and audit events exist. |
| Purchase approvals | Production-ready | Distinct create/approve permissions and authority evaluation exist. |
| Partial receiving | Production-ready | Receipt preview, partial quantities, repeated receipts, idempotency, and verification exist. |
| Over / under receiving | Partial | Over-receipt is explicitly guarded and partial receipt is supported; a richer discrepancy/claim workflow is absent. |
| Supplier backorders | Partial | Supplier messages can update partial quantities and ETAs; alternative sourcing and formal backorder lifecycle remain limited. |
| Landed costs | Missing | Import recognizes wording such as landed cost, but no allocation engine links freight/duty/insurance to received inventory layers. |
| Transfers | Primitive | A safe atomic location-to-location move exists, but no transfer order, pick/ship/receive states, in-transit balance, damage, or receiving variance lifecycle. |
| Transfer states / in-transit | Missing | No durable requested/picked/shipped/in-transit/partially-received transfer document was found. |
| Adjustments | Production-ready | Count corrections and non-sale removals have typed reasons, audit evidence, and accounting adapters. |
| Cycle counts | Primitive | A physical count can correct stock; scheduled count programs, count batches, blind counts, approvals, and variance analytics are absent. |
| Full physical inventory | Primitive | No freeze/snapshot/count/recount/approve/post campaign workflow. |
| Customer orders | Partial | Draft, confirm, commitment, shortage/backorder, fulfillment, payment state, email intake, and traceability exist; UX and edge-case regression concerns remain. |
| Fulfillment | Partial | Pick lists and shipment states exist; no wave/cluster/batch picking, bin-directed picking, scan verification, cartonization, or dock workflow. |
| Customer returns / RMA | Primitive | Refund accounting and external return ingestion exist, but not a coherent authorization → receipt → inspection → restock/scrap → refund/exchange lifecycle. |
| Supplier returns / credits | Primitive | Supplier credits and stock removals exist separately; no linked return-to-vendor shipment and credit reconciliation flow. |
| Lot / batch tracking | Partial | Lot identity, location balances, quantities, and movement enforcement exist; FEFO allocation, recall workflow, scanning, and compliance reporting are incomplete. |
| Serial tracking | Partial | One serial per physical unit and movement enforcement exist; scan-first execution, warranty/RMA and richer trace reporting are incomplete. |
| Expiration dates | Partial | Lots carry expiry evidence; proactive expiry disposition, FEFO fulfillment, and compliance workflows are incomplete. |
| End-to-end traceability | Partial | Domain events, movement sources, lots, serials, documents, and accounting evidence are linkable; there is no universal owner-facing trace graph for every lifecycle. |
| Costing / COGS | Partial | Deterministic cost evidence and sale posting are strong; missing landed cost and unresolved historical-cost cases prevent full maturity. |
| Inventory valuation | Partial | Ledger/report reconciliation and owner explanations exist; valuation breadth and external-accounting parity need live certification. |
| Replenishment | Partial | Reorder policy, forecast, rebalance, supplier constraints, PO preparation, authority, and explanations exist; production calibration and scale are not certified. |
| Demand history | Production-ready | Sales and external events create durable demand evidence; censoring/returns scenarios are tested. |
| Forecasting | Partial | Multiple models, backtests, outcomes, trend/seasonality-related behavior, stock projections, and evidence are implemented; live accuracy, scale, and UI adoption are unproven. |
| Slow / fast movers | Partial | Inventory-economics and movement analysis exist, but the operational owner experience and automation playbooks are not comprehensive. |
| Dead stock / overstock | Partial | Excess and slow-inventory analytics exist; automated commercial/transfer/disposition workflows are incomplete. |
| Stockout risk | Partial | Forecasted stockout and customer-order risk exist; risk is not yet tied into every downstream execution and communication path. |
| Multi-location balancing | Partial | Rebalance recommendations and bounded transfers exist; stateful transfers and production validation are missing. |
| Audit history | Production-ready | Immutable movements, domain events, action evidence, documents, user identity, and accounting audit records are pervasive. |
| User permissions | Partial | Server-side roles and granular grants exist; enterprise role templates, separation-of-duties policy, SSO/SCIM, and field/location-level permissions are absent. |
| Internal accounting | Partial | Broad internal double-entry, AR/AP, cash, credits, inventory, bank import, reconciliation, reports, and owner explanations exist; live bookkeeping certification and operational UX remain unfinished. |
| External accounting integration | Missing | No production QuickBooks/Xero/NetSuite accounting synchronization was found. |
| Shipping | Partial | Addresses, packages, rates, seller-funded labels, tracking, and authority controls exist; partner onboarding and real-carrier certification remain external gates. |
| Native commerce/POS connections | Partial | Shopify, Square, Clover, and WooCommerce adapters exist; current user-reported OAuth/payment regressions and incomplete live certification prevent a higher rating. |
| Email connections | Partial | Gmail and Microsoft 365 OAuth, polling/push renewal, supplier/customer classification, attachment/document handling, sending, and idempotency exist; full live reliability is not certified. |
| Custom API / inbound webhooks | Partial | Workspace token and normalized event endpoint exist with idempotency and mapping; this is developer integration, not a no-code connector, and outbound API breadth is limited. |
| Manufacturing / BOM / kits / assemblies | Missing | The capability prompt also identifies manufacturing, BOMs, and kits as unavailable. |
| EDI / ASN / 3PL workflows | Missing | Supplier email/document intelligence is not an EDI/ASN transaction layer or 3PL orchestration system. |
| Operational reporting | Partial | Accounting and forecasting reports are substantial; warehouse productivity, fill rate, OTIF, count accuracy, receiving variance, and picker performance are thin. |
| Scale / high availability | Primitive | SQLite WAL is correct for the current deployment, but no clustered database, durable queue service, horizontal worker model, or sustained scale evidence exists. |

## AI operating-loop audit

### Observe — Strong but not universal

StockChief observes native inventory, sales, purchasing, accounting, provider events, email, supplier documents, connection health, forecasts, and scheduled checks. Gaps include physical warehouse telemetry, broad marketplace/accounting/3PL coverage, bank feeds, and complete external-event parity.

### Understand — Strong architecture, uneven product coverage

The business brain forms a cross-domain state; parsers distinguish evidence from unsupported claims; document and email intake link facts to business records. The Real Business / synthetic boundaries are now modeled explicitly. However, capability truth is scattered. A material example is `src/foundry/prompts.js`, which still says Mission 15 forecasting is unavailable even though the forecasting subsystem and acceptance tests exist. That can make the assistant contradict the product.

### Reason — Strong for inventory, replenishment, accounting, and exceptions

Deterministic calculations own quantities and money. Forecasting, supplier reliability, stockout risk, rebalance, inventory economics, Sales Order risk, and accounting explanations are real. Reasoning is less mature for warehouse task optimization, landed cost, returns, manufacturing, and cross-provider failure repair.

### Decide — Strong bounded policy foundation

StockChief can choose between acting, drafting, or escalating based on mode, capability grants, policy scope, quantity/value limits, supplier/location boundaries, evidence, and permissions. The policy vocabulary is narrower than the full future product and does not yet cover every business lifecycle.

### Execute — Real, but domain-limited

StockChief can execute inventory moves, prepare/approve purchasing under policy, send certain supplier/customer messages, request payments, and buy labels when explicitly authorized. It cannot yet autonomously run missing workflows such as stateful transfers, RMAs, landed-cost allocation, warehouse waves, or manufacturing.

### Verify — One of StockChief's strongest differentiators

Action execution rereads state and verifies the outcome. Reconciliation checks inventory movements, PO receipts/status, work outcomes, imports, duplicate invoices, connector mismatches, AR/AP, and accounting-versus-inventory consistency. Material discrepancies are surfaced instead of silently “fixed.”

### Learn — Partial

Forecast outcomes, backtests, demand behavior, and supplier lead-time outcomes are retained. There is not yet a general governed learning system that measures every autonomous decision, compares expected versus actual consequences, proposes policy improvement, and safely promotes it after approval.

### Escalate — Strong concept, inconsistent navigation

“Needs You” is designed around real human decisions and has deterministic prioritization and links. The architecture is correct. The user has repeatedly found items whose click target is not useful. Current navigation tests prove basic links, not that every attention-item type reaches one exact resolution screen and can return to the originating context.

## Website brain and troubleshooting audit

### What exists

- A manager capability registry and model planner route a user request into deterministic handlers.
- Search deep-links products, SKUs, locations, suppliers, POs, customers, Sales Orders, lots, and serials.
- The guidance service can explain a small set of common tasks and provides direct links.
- The app has approximately 345 declared HTTP route handlers.
- Needs You items carry action labels and target URLs.
- Cross-domain investigations and reconciliation can diagnose several real inconsistencies.

### What is missing

StockChief does **not** yet have one authoritative website knowledge graph containing every page, entity, action, prerequisite, permission, side effect, route parameter, return path, and troubleshooting playbook. Guidance currently names a limited set of tasks and screen descriptions. The AI therefore cannot truthfully be said to know the entire website “by heart.”

It also lacks a complete navigation action contract. A request such as “take me to the place where I add a supplier bill for this receipt” should resolve deterministically to exactly one permitted route, explain why, navigate in-app, and confirm arrival. Today, the system often returns links, but universal coverage and arrival verification are missing.

Troubleshooting is also narrower than the goal. StockChief can detect mismatches and recover interrupted/idempotent work. It needs a governed repair loop:

1. identify the symptom;
2. reconstruct the cross-domain timeline;
3. find the invariant that failed;
4. state the evidence and confidence;
5. distinguish a safe automatic repair from a material judgment;
6. simulate the repair;
7. request authority only if needed;
8. execute one idempotent compensation;
9. verify all affected domains;
10. retain the before/after audit evidence.

“Best troubleshooter” must never mean guessing or silently rewriting history.

## Competitive benchmark

### Mature operational depth StockChief must match

- **Odoo** documents bins, putaway, batch/wave/cluster picking, barcode operations, UOM conversion, returns, FEFO/FIFO removal, cycle counts, manufacturing routes, perpetual valuation, and landed costs. StockChief is much simpler but currently much shallower in warehouse execution. [Official Odoo inventory features](https://www.odoo.com/app/inventory-features)
- **NetSuite** has future-supply allocation, required-by-date matching, advanced lot/serial/bin management, and landed-cost allocation by weight, quantity, or value. StockChief's connected explanations are simpler, but its allocation and costing depth is behind. [Official NetSuite supply allocation](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156424975823.html) and [landed-cost documentation](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2418831.html)
- **Finale** documents bin-directed receiving/putaway, in-transit/dock/zone tracking, mobile barcode receiving/picking/counting/transfers, wave picking, label printing, and lot/serial/expiry scanning. These are direct warehouse gaps in StockChief. [Official Finale WMS](https://www.finaleinventory.com/features/warehouse-management-system/)
- **Fishbowl** documents scan-first receiving, bin putaway, RMA, landed-cost reconciliation, accounting synchronization, manufacturing/BOM/MRP, and advanced warehouse/EDI offerings. StockChief has a stronger explainable-autonomy architecture, but not this breadth. [Official Fishbowl receiving](https://www.fishbowlinventory.com/features/receive-goods) and [product capabilities](https://www.fishbowlinventory.com/fishbowl-inventory)
- **Unleashed** documents real-time inventory, bins, batch/serial tracking, barcode scanning, and pick/pack/receive/transfer warehouse workflows. StockChief is behind in daily warehouse ergonomics. [Official Unleashed inventory features](https://www.unleashedsoftware.com/en-us/product/inventory-management-software/)
- **Zoho Inventory** now documents AI agents that can manage catalog, warehouse, orders, shipment, returns, procurement, and workflows, plus Ask Zia answers with direct action links. StockChief cannot assume competitors stop at recommendations. [Official Zoho AI inventory features](https://www.zoho.com/us/inventory/features/ai-in-inventory/)

### Planning and AI StockChief must match or exceed

- **Cin7 Smart Reorder/ForesightAI** recommends purchases, transfers, and assemblies using demand, lead time, MOQ, pack size, stock position, product segments, and six-month forecasts, then creates supply orders. [Official Cin7 Smart Reorder](https://help.core.cin7.com/hc/en-us/articles/10955759303055-Smart-reorder)
- **Katana AI Replenishment** publishes its safety-stock logic and can update the safety-stock value, while its operational core connects stock, commitments, expected supply, manufacturing, and purchasing. [Official Katana AI replenishment](https://support.katanamrp.com/en/articles/15552497-ai-replenishment-s-safety-stock-formula-and-recommendations)
- **Inventory Planner** specializes in explainable SKU-level forecasts, stockout timing, replenishment, purchasing, open-to-buy, aging, and warehouse comparison. It is a planning layer rather than a full IMS, but its planning UX is mature. [Official Inventory Planner guide](https://help.inventory-planner.com/en/articles/3456738-inventory-planner-101)
- **Prediko** advertises 12-month plans, daily stockout/late-PO updates, one-click PO and transfer actions, raw materials, and a conversational inventory coworker. [Official Prediko workflow](https://www.prediko.io/how-it-works)
- **Cin7, Katana, Unleashed, Inventory Planner, and Prediko** generally lead with recommendations and user-triggered actions. StockChief's opportunity is to close the operational-depth gap while preserving its stronger authority → execution → verification → audit loop.

### Other positioning

- **Extensiv** is strongest where multichannel order management, 3PL/WMS execution, allocations, routing, returns, and high-volume fulfillment meet.
- **Sortly** is intentionally simpler and mobile-first, emphasizing QR/barcode identification, counts, alerts, reports, and straightforward POs. StockChief should beat its ease without inheriting its limited business brain.
- **NetSuite and Odoo** provide the broadest ERP-style depth, but impose substantial configuration and workflow complexity. StockChief should match the correctness that matters without reproducing their operator burden.

## A. What StockChief already does exceptionally well

1. **Physical inventory has one ledger authority.** It is not recomputed from UI state or external payloads.
2. **Money and quantity are separated.** Receiving, supplier billing, supplier payment, sale completion, and customer payment are distinct business facts.
3. **The system does not permit AI prose to own business calculations.** Deterministic services own quantities, money, permissions, and mutations.
4. **Autonomous actions are bounded by explicit capabilities and policies.** Buying labels, spending with suppliers, moving stock, and sending mail are separate grants.
5. **Execution includes verification.** This is foundational to trustworthy autonomy and is a credible differentiator.
6. **Cross-domain reconciliation is real.** Inventory/accounting, external/native, PO/receipt, and work-result disagreements can become one understandable investigation.
7. **Supplier email/document intelligence is deeper than attachment storage.** It can classify, map, extract, apply tolerances, connect consequences, and prepare or send responses under authority.
8. **Owner-friendly accounting is backed by an actual accounting model.** AR, AP, partial payments, credits, COGS, cash, expenses, inventory, and audit detail are not merely display cards.
9. **Forecasting retains evidence and outcomes.** It is not only an opaque number returned by a language model.
10. **Real Business and synthetic data are separate operating boundaries.** This protects production facts while permitting rich test generation.

## B. What exists but is incomplete

- Universal business-state explanations and lifecycle trace graphs.
- Needs You destination correctness and end-to-end resolution coverage.
- Website-wide help/navigation and arrival verification.
- Autonomous replenishment and transfers at production scale.
- Forecast calibration, accuracy monitoring, and safe learning promotion.
- Lot/serial/expiry operations beyond core ledger enforcement.
- Shipment, customer payment, and live connector reliability.
- Supplier backorder consequences and alternative sourcing.
- Full operational reporting and KPI trend explanations.
- Internal accounting UX and external accounting synchronization.
- Permission depth and enterprise identity controls.
- Background processing durability beyond a single SQLite-hosted deployment.

## C. Critical capabilities mature competitors have that StockChief lacks

- Bins, zones, aisles, shelves, docks, putaway, and directed warehouse work.
- Mobile scanning and label printing across receiving, picking, packing, counts, transfers, lots, and serials.
- Stateful transfer orders with in-transit stock and partial receiving.
- Alternate UOM conversions and packaging hierarchy.
- Landed-cost categories and allocation.
- Customer RMA, exchange, inspection, disposition, and refund lifecycle.
- Supplier return-to-vendor and credit lifecycle.
- Scheduled cycle counts and full physical-inventory campaigns.
- Wave/batch/cluster picking and scan verification.
- Kits, bundles, assemblies, BOMs, production orders, MRP, and work orders.
- EDI/ASN, 3PL, and enterprise fulfillment integration.
- External accounting platform synchronization.
- Advanced allocation strategy and future-supply pegging.
- High-availability database/queue architecture and proven scale.

## D. AI capabilities competitors already have that StockChief must meet or exceed

- Plain-language, page-aware answers with direct action links.
- Demand forecasting, stockout dates, forecast explanations, and safety-stock recommendations.
- Purchase, transfer, and assembly recommendations using lead time, MOQ, pack size, demand, commitments, and incoming supply.
- Daily operational briefings and proactive risk alerts.
- Document recognition and workflow generation.
- Multi-location transfer planning.
- Aging, dead stock, margin, and inventory-investment analysis.
- Agent-driven creation and update across core inventory entities.

StockChief must exceed these by executing routine work inside explicit authority, verifying the business result, explaining alternatives and evidence, and escalating only when the evidence or authority is insufficient.

## E. Capabilities that can genuinely differentiate StockChief

1. **One traceable business story.** A customer commitment can be followed through shortage, transfer/PO, supplier response, receipt, fulfillment, revenue, COGS, cash, and profit.
2. **Verified autonomy rather than action-flavored chat.** Every mutation has authority evidence, idempotency, second-read verification, and a durable outcome.
3. **Exception compression.** Hundreds of routine operations become a few owner decisions, with the metric: “StockChief handled X; you were needed for Y.”
4. **Universal “Why?” contract.** What happened, evidence, alternatives, chosen action, authority, result, and next expected event use one model everywhere.
5. **Owner-language accounting joined to physical inventory.** StockChief explains what the owner owns, owes, is owed, spent, collected, earned, and still cannot prove.
6. **A website operator, not a help center.** The owner can ask where anything is, ask StockChief to take them there, or ask it to complete the safe work.
7. **Governed repair.** StockChief can reconstruct and repair real cross-module messes without hiding discrepancies or duplicating effects.
8. **Business-memory onboarding.** Verified facts, safe structural inference, provisional defaults, missing facts, and authority decisions remain distinct without exposing an audit report to the owner.

## F. Architectural weaknesses that block scale or autonomy

1. **Scattered capability truth.** Prompts, registries, routes, UI, docs, and tests can disagree. The stale forecasting statement in `src/foundry/prompts.js` is direct evidence.
2. **No canonical business lifecycle graph.** Links exist, but there is no universal typed relation model joining every originating demand, supply decision, document, movement, invoice, payment, and financial result.
3. **No canonical website/action map.** Help is handcrafted for a subset of tasks while the route surface is much larger.
4. **Single-node SQLite and in-process scheduling.** Correct for local/private development, not yet a horizontally scalable operational platform.
5. **Domain-specific autonomy vocabulary.** Strong where implemented, but new domains can fall outside the common authority, verification, and explanation contract.
6. **Compensation is inconsistent.** Many financial records use reversal correctly, but not every operational workflow has a typed compensation/rollback plan.
7. **Connector certification is incomplete.** Adapters and tests exist, but several user-observed live OAuth, popup, redirect, payment, and state-refresh failures remain material.
8. **No general decision-outcome learning governance.** Forecast learning exists, but action policy learning and safe promotion do not.
9. **Insufficient full-browser certification.** A broad pack has stalled, and the independent zero-training walkthrough has not been completed.

## G. UX/workflow weaknesses that force unnecessary human work

- Too many screens expose implementation/accounting states instead of one next action.
- Needs You links are not proven for every item type and have repeatedly landed on unhelpful pages.
- Sales Order creation, customer identity, delivery method/address, shortage, payment, shipment, and accounting can appear as competing steps instead of one guided lifecycle.
- Connector setup sometimes exposes platform mechanics and delayed state rather than one clear connect → authorize → return → verified state.
- Warehouse work is form-driven rather than scan/task-driven.
- Setup guidance can ask lower-value configuration before requesting the best source evidence.
- The assistant can describe a destination without consistently navigating and confirming that the right record/action is open.
- Troubleshooting tells the owner a mismatch exists but does not always provide a safe, complete repair path.
- Advanced details are not consistently behind progressive disclosure.

## H. Recommended implementation roadmap

### P0 — correctness, universal guidance, and certification

1. Canonical capability, route, action, and troubleshooting registry.
2. Universal business lifecycle graph and provenance contract.
3. Needs You destination/resolution contract with exhaustive route tests.
4. Governed diagnose/simulate/repair/verify framework.
5. Connector/payment/shipping OAuth and state-settlement certification.
6. Durable jobs, migration discipline, observability, alerting, backup/restore, and production environment proof.
7. Complete browser regression plus independent zero-training test.

### P1 — mature inventory and warehouse baseline

8. Bins/zones/putaway plus scan-first mobile operations and labels.
9. Stateful transfer orders and in-transit stock.
10. Alternate UOM and package conversions.
11. Landed-cost allocation.
12. Cycle-count and physical-inventory programs.
13. Customer RMA and supplier return/credit lifecycles.
14. Advanced allocation and warehouse fulfillment.
15. External accounting synchronization and broader API/webhooks.

### P2 — lead AI inventory management

16. Universal autonomous operator loop across every mature domain.
17. Forecast and decision-outcome learning with governed promotion.
18. Supplier alternative sourcing, negotiation preparation, delay mitigation, and consequence simulation.
19. Cash-aware replenishment and constraint-aware optimization.
20. Owner briefing, exception compression, and measured labor-hours saved.

### P3 — enterprise differentiation

21. Kits/bundles/assemblies, BOM, manufacturing/MRP/work orders.
22. EDI/ASN, 3PL, drop-ship, cross-dock, and enterprise routing.
23. SSO/SCIM, advanced separation of duties, compliance and retention controls.
24. Multi-entity/multi-currency/consolidation where product strategy demands it.

## Implementation work packages

The following packages satisfy the requested design dimensions without pretending each is a one-screen feature.

### WP0.1 — canonical website and capability brain

- **Business problem:** users hunt, receive stale answers, or land on the wrong page.
- **Competitor bar:** Zoho Ask Zia provides direct action links; StockChief must navigate and verify arrival.
- **Current state:** partial registries, record search, high-level guidance, and 345 route handlers with no canonical map.
- **Proposed behavior:** generate one typed registry for every page/entity/action/prerequisite/permission/side effect/troubleshooting path; the assistant answers, links, or navigates to the exact permitted destination and confirms it.
- **Data model:** versioned `product_capabilities`, `ui_destinations`, `resolution_playbooks`, and optional navigation outcome events.
- **Backend/domain:** registry validation at startup; route/action handlers declare capability metadata rather than duplicating prose.
- **UI/UX:** one dominant action, in-app navigation, contextual return path, and “I opened X for Y.”
- **AI:** retrieval is limited to the authoritative registry plus live record state; no invented routes.
- **Accounting:** accounting destinations expose owner view first and advanced books only on request.
- **Permissions:** filter destinations and executable actions before the model sees them.
- **Tests:** registry covers every route; every deep link loads; every Needs You action resolves; arrival and back-navigation tests.
- **Migration:** adapt existing guidance and capability registry; keep old URLs as redirects.

### WP0.2 — universal lifecycle/provenance graph

- **Business problem:** records are connected in code but the owner cannot always follow one story.
- **Competitor bar:** NetSuite/Odoo trace supply and demand; StockChief should make it understandable.
- **Current state:** source IDs, domain events, documents, movements, invoices, and payments exist but relations are domain-specific.
- **Proposed behavior:** every important record exposes upstream cause, downstream consequences, documents, decisions, and verified outcome.
- **Data model:** typed immutable `business_relations` edges with source, target, relation kind, evidence, creator, and timestamp.
- **Backend/domain:** emit/validate edges in the same transaction as each event; reconcile missing or contradictory edges.
- **UI/UX:** simple story first; “See how StockChief worked this out” opens the trace.
- **AI:** explanations query graph evidence instead of composing a story from loose snapshots.
- **Accounting:** tie every posting to the exact operational edge and source document.
- **Permissions:** redact inaccessible records while preserving an honest explanation.
- **Tests:** full demand → fulfillment → accounting and purchase → receipt → bill → payment traces.
- **Migration:** backfill only provable edges; mark unknown links instead of guessing.

### WP0.3 — governed troubleshooting and repair

- **Business problem:** detection without resolution still costs the owner time.
- **Competitor bar:** mature systems reconcile transactions; StockChief should diagnose and safely resolve across modules.
- **Current state:** reconciliation/investigation is substantial; universal repair simulation and compensation are not.
- **Proposed behavior:** reconstruct, diagnose, simulate, classify risk, request authority when material, execute one idempotent correction, and verify all affected domains.
- **Data model:** repair cases, proposed compensations, before/after invariants, approvals, and verification evidence.
- **Backend/domain:** domain-owned repair adapters; no direct table patching.
- **UI/UX:** one plain explanation and one safe next action; technical evidence collapsed.
- **AI:** phrase and prioritize; deterministic services determine allowable repairs.
- **Accounting:** immutable reversal/correction entries, never historical overwrites.
- **Permissions:** operation-specific approval; high-value/material discrepancies require owner/accountant.
- **Tests:** duplicate event, stuck job, overpayment, inventory/accounting mismatch, wrong mapping, partial failure, retry exactly once.
- **Migration:** open legacy inconsistencies as cases; do not auto-repair historical ambiguity.

### WP0.4 — production runtime and certification

- **Business problem:** correct local software is not a dependable service.
- **Competitor bar:** SaaS inventory systems provide durable jobs, monitoring, recovery, isolation, and support.
- **Current state:** local controls and restore tooling exist; external operational proof is incomplete.
- **Proposed behavior:** managed relational database, durable queue, transactional outbox/inbox, worker leases, retries/dead-letter handling, external alerts, runbooks, measured restore, rollback, and support ownership.
- **Data model:** job/outbox lifecycle, retry cause, dead-letter review, deployment/migration metadata.
- **Backend/domain:** separate web/worker processes; exactly-once effects through idempotency, not an impossible exactly-once transport claim.
- **UI/UX:** honest connection/job health and recovery actions.
- **AI:** unavailable providers degrade safely; no fabricated completion.
- **Accounting:** financial jobs use immutable events and reconciliation before completion.
- **Permissions:** production operations and support access audited and least-privileged.
- **Tests:** crash mid-action, duplicate delivery, concurrent workers, migration rollback, tenant attack suite, load/soak, backup/restore, alert injection.
- **Migration:** dual-write/outbox rollout, shadow reconciliation, staged cutover, verified rollback.

### WP1.1 — warehouse locations, scans, and labels

- **Business problem:** manual forms cause slow receiving, picks, moves, and counts.
- **Competitor bar:** Odoo, Finale, Fishbowl, and Unleashed support bins and scan-first work.
- **Current state:** warehouse-level locations and SKU barcode field only.
- **Proposed behavior:** bins/zones/docks, putaway suggestions, mobile receiving/picking/counting/transfer, GS1 parsing, and printable product/bin/lot/serial labels.
- **Data model:** sublocations, container/package identities, barcode aliases, putaway rules, warehouse tasks and scans.
- **Backend/domain:** every scan validates a task and posts through the inventory engine.
- **UI/UX:** camera/scanner-first task queue, offline-safe batches where feasible, large error-resistant controls.
- **AI:** optimize task grouping and explain exceptions; never infer a scanned identity.
- **Accounting:** bin moves do not affect value; scrap/damage does.
- **Permissions:** task/location/operation grants.
- **Tests:** wrong bin/SKU/lot/serial, offline replay, duplicate scan, partial putaway, label roundtrip.
- **Migration:** existing locations become parent stock areas; no invented bins.

### WP1.2 — stateful transfers and allocations

- **Business problem:** instant transfers falsely imply goods arrive immediately.
- **Competitor bar:** Finale, Cin7, NetSuite, Odoo, and Prediko track transfer demand and in-transit states.
- **Current state:** atomic immediate transfer; Sales Order allocations are real but strategy is basic.
- **Proposed behavior:** requested → approved → picked → shipped → in transit → partially received → received/cancelled, with damage/variance and demand pegging.
- **Data model:** transfer orders/lines/shipments/receipts/allocations and in-transit custody.
- **Backend/domain:** transfer state machine emits movement legs at physical handoff/receipt, not at request time.
- **UI/UX:** one story showing source, transit, destination, customer consequences, and next action.
- **AI:** compare transfer versus purchase using timing, cost, risk, and authority.
- **Accounting:** location transfer normally preserves total asset; loss/damage posts separately.
- **Permissions:** separate request, approve, dispatch, and receive.
- **Tests:** partial receive, lost shipment, over-receipt, cancellation, customer priority, exactly-once legs.
- **Migration:** retain historic atomic transfers as completed legacy transfers.

### WP1.3 — UOM and landed cost

- **Business problem:** real companies buy cases/pallets, sell eaches, and need true product cost.
- **Competitor bar:** Odoo UOM conversion and NetSuite/Fishbowl landed-cost allocation.
- **Current state:** supplier pack multiplier; no general UOM graph or landed-cost engine.
- **Proposed behavior:** explicit compatible UOM conversions and allocate freight/duty/insurance/handling by quantity, value, weight, or manual evidence.
- **Data model:** UOM families/conversions, receipt cost layers, landed-cost documents/categories/allocations.
- **Backend/domain:** deterministic conversion and allocation with rounding reconciliation.
- **UI/UX:** owner sees “120 each = 10 cases” and true received cost; formulas expandable.
- **AI:** extract proposed charges/method, never guess missing amount or conversion.
- **Accounting:** capitalize eligible costs and flow them to COGS as stock sells.
- **Permissions:** accountant/owner approval for material allocation changes.
- **Tests:** partial receipts, multiple bills, currency/rounding, returns, revaluation, missing weights.
- **Migration:** preserve current unit basis; require explicit conversions before alternate-unit transactions.

### WP1.4 — counts, returns, and warehouse fulfillment

- **Business problem:** adjustments, returns, and high-volume fulfillment cannot remain isolated forms.
- **Competitor bar:** Odoo/Finale/Fishbowl provide scheduled counts, RMAs, inspection/disposition, and advanced picking.
- **Current state:** individual count correction, shipment states, refund/credit records, and manual removals.
- **Proposed behavior:** cycle-count plans and full counts; customer and supplier return state machines; batch/wave picks; scan verification; partial fulfillments and exceptions.
- **Data model:** count sessions/lines/recounts, RMAs/RTVs/dispositions, pick waves/tasks/cartons.
- **Backend/domain:** all stock changes remain inventory-engine movements; all money changes remain accounting events.
- **UI/UX:** task-first mobile flows and exception-first supervisor view.
- **AI:** schedule counts by risk, group work, draft return decisions; never decide condition without evidence.
- **Accounting:** restock, scrap, refund, credit, and write-off are distinct postings.
- **Permissions:** count, approve variance, inspect, refund, scrap, and ship are separate consequences.
- **Tests:** full/partial return, exchange, non-restockable goods, supplier credit mismatch, blind recount, wave shortage.
- **Migration:** map historic adjustments/refunds as completed legacy events without inventing RMA links.

### WP1.5 — external accounting and extensibility

- **Business problem:** owners already use accounting, marketplaces, and specialist systems.
- **Competitor bar:** Fishbowl and other mature systems sync QuickBooks/Xero and expose APIs.
- **Current state:** strong internal books, several commerce/POS/email adapters, and inbound custom events.
- **Proposed behavior:** certified accounting sync, broader provider catalog, outbound webhooks, public read/write API, connection health and reconciliation.
- **Data model:** external identity/version maps, sync checkpoints, conflict cases, outbound subscriptions/deliveries.
- **Backend/domain:** provider adapters translate into canonical commands/events; no provider writes directly to balances.
- **UI/UX:** connect → authorize → return → verify one real read-only fact → choose authority.
- **AI:** explain conflicts and propose mappings; never match uncertain records automatically.
- **Accounting:** configurable source-of-truth and posting direction; prevent double books.
- **Permissions:** OAuth scope minimization and connection-specific authority.
- **Tests:** provider sandbox contracts, token refresh, popup/redirect/session continuity, duplicate/out-of-order events, revocation, conflict recovery.
- **Migration:** per-workspace staged enablement and shadow reconciliation before writes.

### WP2.1 — universal autonomous operator

- **Business problem:** automation is powerful only in selected domains.
- **Competitor bar:** Zoho agents can act broadly; StockChief must be safer and more verifiable.
- **Current state:** common modes/capabilities plus domain-specific policies and runner.
- **Proposed behavior:** every mature operation implements observe, propose, decide, authorize, execute, verify, compensate, learn, and escalate contracts.
- **Data model:** typed operation catalog, authority constraints, alternatives, expected outcomes, actual outcomes, and owner interventions.
- **Backend/domain:** shared orchestration; domain services retain all mutation ownership.
- **UI/UX:** “StockChief handled X; you were needed for Y,” with exception drilldown.
- **AI:** chooses among registered operations and explains; cannot create new operation types or bypass policy.
- **Accounting:** spending, collection, write-off, credit, and financial communication remain separately grantable.
- **Permissions:** quantity, value, supplier, customer, location, confidence, risk, role, time, and daily aggregate limits.
- **Tests:** authority matrix, alternate plan, limit boundary, verification failure, pause/resume, revoked authority, aggregate spend.
- **Migration:** existing grants map conservatively; every new operation defaults off.

### WP2.2 — adaptive planning and cash-aware optimization

- **Business problem:** reorder suggestions that ignore cash, margin, transfers, and uncertainty can hurt the business.
- **Competitor bar:** Cin7/Katana/Inventory Planner/Prediko forecast and recommend; StockChief must optimize and safely act.
- **Current state:** forecasting, backtests, stock projections, excess, rebalance, supplier reliability, and outcome scoring exist.
- **Proposed behavior:** simulate buy/transfer/wait/expedite/substitute scenarios under service, cash, storage, MOQ, lead-time, margin, and authority constraints.
- **Data model:** scenario inputs, objectives, constraints, chosen alternative, expected/actual outcome, model/version evidence.
- **Backend/domain:** deterministic optimizer and forecast ensemble; language model supplies context only when evidenced.
- **UI/UX:** simple recommendation plus alternatives and “why this is safest/cheapest.”
- **AI:** incorporate approved business context and explain uncertainty.
- **Accounting:** cash commitments, payment terms, inventory investment, gross margin, and landed cost constrain decisions.
- **Permissions:** recommendations can be broad; execution stays bounded by explicit grants.
- **Tests:** stockout versus cash, transfer versus PO, late supplier, seasonality, promotions, cold start, forecast drift, infeasible plan.
- **Migration:** shadow recommendations first; measure outcomes before enabling automatic execution.

### WP2.3 — supplier intelligence

- **Business problem:** supplier changes create inventory and customer consequences that humans manually chase.
- **Competitor bar:** serious planning systems use lead times and supply rules; StockChief should understand communications and act on consequences.
- **Current state:** email/doc extraction, supplier mapping, tolerances, partial shipment/ETA updates, follow-ups, and consequence detection.
- **Proposed behavior:** evaluate alternatives, compare supplier reliability/cost/lead time, draft negotiation or alternate PO, update promises only from evidence, and escalate material tradeoffs.
- **Data model:** supplier offers, capacity, constraints, substitutions, acknowledgements, ASN facts, disputes, and scorecards.
- **Backend/domain:** deterministic consequence engine and scenario comparison.
- **UI/UX:** “200 units moved to Sep 28; these three orders are at risk; I can transfer 80 and buy 120 from B.”
- **AI:** interpret messages and draft communication; quantities/dates come from records.
- **Accounting:** price changes, deposits, credits, and landed cost flow through AP/cost layers.
- **Permissions:** supplier communication and purchase authority remain separate.
- **Tests:** partial confirm, substitute, changed price/date, conflicting attachment/email, duplicate invoice, late shipment, alternate source.
- **Migration:** retain existing expectations/documents; add only evidence-backed relations.

### WP3.1 — manufacturing and enterprise operations

- **Business problem:** distributors/manufacturers need assemblies, components, production, EDI, and 3PL scale.
- **Competitor bar:** NetSuite, Odoo, Fishbowl, Cin7, and Katana.
- **Current state:** missing.
- **Proposed behavior:** kits/bundles first, then BOM revisions, work/production orders, material commitments, yield/scrap, subcontracting, MRP, EDI/ASN and 3PL routing.
- **Data model:** components/BOM revisions, production orders/operations/consumption/output, partner messages and logistics orders.
- **Backend/domain:** separate manufacturing ledger/events connected to inventory, purchasing, sales, and accounting.
- **UI/UX:** owner story and exception-first view; shop-floor task UI separate from owner UI.
- **AI:** plan and reschedule under constraints, but all quantities and capacity remain deterministic.
- **Accounting:** WIP, labor/overhead where supported, variance, finished-goods cost, subcontractor bills.
- **Permissions:** engineering, planning, release, consume, complete, scrap, EDI, and 3PL scopes.
- **Tests:** BOM revision, partial build, yield variance, serial/lot genealogy, material shortage, replan, duplicate ASN.
- **Migration:** optional modules; no effect on resellers that do not manufacture.

## Test evidence collected in this audit

A focused cross-domain suite was executed against the current working tree:

- inventory quantities, variants, lots, serials, purchasing, Sales Orders;
- 20 accounting owner lifecycles;
- supplier communication and Gmail/Microsoft connection behavior;
- external connection idempotency and reconciliation;
- forecasting acceptance scenarios;
- Mission 14.5 business-brain scenarios;
- shipping platform flow;
- basic navigation behavior.

**Result: 223 tests passed, 0 failed.**

This is useful evidence, not a release certificate. The complete browser pack has previously stalled, the zero-training independent-user test has not been completed, and external production requirements listed above remain open.

## Repository evidence index

These are the principal code locations behind the ratings. They are included so a future reviewer can reproduce the audit rather than trust its conclusions.

| Evidence | Location |
|---|---|
| Locations, items and SKUs | `src/db/schema.sql:62`, `:74`, `:101` |
| Lots and per-location lot balances | `src/db/schema.sql:135`, `:148` |
| Physical receive / issue / transfer / adjust / integrity check | `src/domain/inventory-engine.js:254`, `:406`, `:507`, `:662`, `:813` |
| Suppliers, supplier items and reorder policies | `src/db/schema-purchasing.sql:20`, `:69`, `:143` |
| Purchase orders and lines | `src/db/schema-purchasing.sql:169`, `:241` |
| Receipt preview / post / verification | `src/purchasing/receiving-service.js:85`, `:184`, `:427` |
| Customers, Sales Orders, lines, shipments | `src/db/schema-sales.sql:5`, `:28`, `:71`, `:172`, `:203` |
| Sales confirmation and fulfillment | `src/sales/sales-order-service.js:327`, `:551` |
| Accounting journals, AR and AP | `src/db/schema-accounting.sql:75`, `:282`, `:332` |
| Connection mappings, issues, reconciliations and encrypted credentials | `src/db/schema-connections.sql:5`, `:21`, `:41`, `:132` |
| Domain events and investigations | `src/db/schema-manager.sql:33`, `:58`, `:97` |
| Business-state build and briefing | `src/manager/business-brain.js:256`, `:361` |
| Unified reconciliation | `src/manager/reconciliation.js:157` |
| Forecasts, outcomes and planning recommendations | `src/db/schema-forecasting.sql:26`, `:63`, `:94` |
| Autopilot capability grants and policies | `src/db/schema-autopilot.sql:66`, `:100` |
| Autonomous execution and restart recovery | `src/autopilot/runner.js:844`, `:1233`, `:1273` |
| Action execution/idempotency | `src/actions/execution-service.js:92`, `:130`, `:425` |
| Shipment packages, rates, tracking and rules | `src/db/schema-shipping.sql:15`, `:39`, `:65`, `:109` |
| Current limited screen-help map | `src/manager/guidance.js:493`, `:569-578` |
| Stale capability assertion that contradicts implemented forecasting | `src/foundry/prompts.js:86-93` |

## Release and acceptance gates

StockChief should not claim this mission complete until all of the following are true:

1. Every route and important action is represented in the canonical website registry.
2. Any “where/how” question returns the exact permitted destination, can navigate there, and verifies arrival.
3. Every Needs You item type has an exhaustive destination and resolution test.
4. The full browser suite completes repeatedly without a stall.
5. A fresh user completes onboarding, inventory, purchasing, supplier email, Sales Orders, Needs You, shipping/payment, and Accounting with no outside instruction; every confusion is fixed and the test repeated.
6. Connector OAuth, popup return, webhook/poll fallback, payment settlement, label onboarding, and UI refresh are certified in official sandboxes and then a controlled live pilot.
7. Tenant isolation, permissions, idempotency, worker crash recovery, and concurrency pass adversarial tests.
8. External error alerts fire on an injected fault and reach a monitored responder.
9. Password recovery email is delivered and used successfully in production.
10. Backup retention is approved, and a hosting-platform restore drill meets the documented recovery target.
11. A deployment migration and rollback rehearsal succeeds against production-like data.
12. Inventory/accounting/external reconciliation reports no unexplained material difference.
13. A sustained realistic-scale workload establishes response-time and worker-throughput budgets.
14. Only after P0 passes should StockChief widen autonomous authority; new authority remains off by default.

## Product standard

StockChief should not win by displaying more fields than competitors. It should win because:

- its underlying inventory facts are at least as rigorous;
- its AI understands the connected business rather than one screen;
- routine work is actually executed within authority;
- every action is verified;
- every number and decision is traceable;
- exceptions are compressed into the few decisions that need a human;
- the owner never has to learn where a feature lives;
- operational complexity stays in the system instead of being pushed onto the user.

The honest current position is: **StockChief has a differentiated autonomous core, but it still needs P0 certification and P1 warehouse depth before it can credibly overpower mature inventory platforms.**

# StockChief launch implementation decision

## Selected hosting target

Use paid Render services for the first launch: an Express web service, a continuously running operations worker and managed PostgreSQL. Keep staging and production isolated, including databases, encryption keys, OAuth apps and provider accounts. Use private object storage for documents and off-platform retained backup exports. The isolated staging database is now provisioned; the web/worker stack is not deployed or certified.

Render supports [continuous background workers](https://render.com/docs/background-workers), [managed PostgreSQL](https://render.com/docs/postgresql), and [point-in-time recovery for paid databases](https://render.com/docs/postgresql-backups). Production database availability should use an eligible plan with [high availability](https://render.com/docs/postgresql-high-availability), subject to approval of its extra standby cost. The owner approved staging PostgreSQL only at $23.50/month: $19 compute and $4.50 for 15 GB. Separate approval is required before buying web, worker, production or other paid resources.

### Provisioned staging resource, September 18

- Separate StockChief Hobby workspace, created after the owner personally supplied a different card; the prior workspace and its services were not modified.
- `stockchief-staging`, PostgreSQL 17, Virginia, 0.5 CPU / 1 GB RAM, 15 GB storage, storage autoscaling off. Render reports Available. The auto-created environment was renamed Staging; there is no production deployment.
- Resource: `dpg-damlkhuk1f9s739h5ga0-a`; workspace: `tea-damlhs3m8hqs73dk3jcg`.
- No business data, mailbox grants or database secrets were exported or imported. Credentials remain in Render, not chat or tracked files. This database has not been qualified by StockChief queries.
- Render's default PostgreSQL inbound rule allows `0.0.0.0/0`. A private-network-only change was attempted but blocked by the approval reviewer; the unsaved edit was discarded. Owner approval is pending. Do not treat the current network configuration as launch-ready.

Do not deploy the existing SQLite file on a Render disk and call it shared production storage. A [Render disk belongs to one service instance](https://render.com/docs/disks), cannot be shared with a separate worker, and prevents multi-instance scaling and zero-downtime deployment.

## Required implementation sequence

1. Finish deterministic operational workflows and their signed-in browser acceptance scenarios. Disputed invoices now have permissioned correction, recheck and dismissal controls with original-value history, matching rules, stale-screen protection and transactionally coupled posting. This does not verify the authenticity of a document mentioned by the human reviewer, or provide a blanket mismatch override.
2. Complete PostgreSQL feature parity before deploying a distributed release. Production startup now selects the asynchronous PostgreSQL application and refuses SQLite. The complete constrained schema, repeatable 271-table migration/reconciliation, shared sessions, fenced workers, core inventory/transfer/order/payment/accounting/browser paths, native pricing/search/planning, governed connector repairs, migrated event-feed compatibility, worker-owned outbound email, responder acknowledgement, deposit/refund effects and accounting-export effects are implemented and locally certified. Remaining work is limited to the legacy operational families listed in `docs/postgresql-migration-status.md`; do not bridge them with a synchronous PostgreSQL compatibility adapter.
3. Multi-process queue claims, transaction rollback, lease expiry/fencing, independent-worker exactly-once effects and concurrent inventory/accounting invariants now pass locally. Repeat the same recovery and reservation workload against managed staging and the deployed worker topology. Keep SQLite local development separate; never put its file on a network share to simulate PostgreSQL.
4. Provision the isolated staging stack after account access and spending approval. Configure stable HTTPS origins, secrets, OAuth callback URLs, signed webhooks, support and alerts. Pin immutable release IDs. Do not copy local mailbox grants or production business records into staging without an explicit data-transfer decision.
5. Qualify real sandbox providers through business UI workflows: shipping label/tracking/replay/void; customer payment/refund/replay/settlement; accounting posting/export/replay/control-account reconciliation; Outlook self-send/reply/duplicate capture. Mock provider faults are supplemental and must not be counted as successful live connections. Sandbox payments do not prove a live funded settlement.
6. Local PostgreSQL backup/restore with manifest reconciliation, worker throughput and HTTP soak now pass. Run historical full-operation browser acceptance, deployed authenticated capacity tests, managed backup restoration into an isolated recovery database, actual hosting rollback, worker restart/lease recovery and alert acknowledgment. Verify the restored managed business through the frontend before clearing deployment gates.
7. Require two complete browser regressions of the exact deployed release plus an independent uncoached operator walkthrough. Evaluate the actual Operations readiness page; do not set evidence flags merely to turn it green. Only after the operational release passes should subscription implementation start.

## Operational acceptance still to complete

- Replenishment: all locations, reservations, open demand, seasonal/recent sales, incoming timing, business calendars and actual supplier lead times; prefer a transfer only when its known cost and arrival time justify it.
- Purchasing: complete supplier consolidation with packs, MOQs, supplier item codes, minimum spend, freight/tax and alternates; disclose unavailable costs rather than declaring an unproven cheapest choice.
- Receiving: partial receipts, damage, overages, shortages and actual invoice differences, including authorized resolution and repeat submissions.
- Discrepancies: trace movements and counts across locations and kits; report evidence versus hypotheses distinctly.
- Customer orders: priority/date allocation at scale, active picks, shortages and arriving stock; verify fulfillment separately from payment.
- Supplier performance and demand spikes: complete historical records, quoted versus actual full delivery, business-calendar changes and confidence/coverage disclosures.
- Cycle counts and dead stock: real scheduled preparation, physical count entry, reviewed adjustment and verification, not merely a suggested plan.
- Monday briefing: the owner now has a date-controlled since-Friday cross-domain evidence report, complete history counts, pending work, exceptions and source-failure warnings. Ask hands off that real report and explicitly refuses unsupported blanket execution rather than claiming it happened. Full authorized cross-domain action orchestration and provider verification are still unfinished.

## Owner setup needed

Render sign-in, a separate card and the isolated staging database purchase are complete. Approve the new database's private-network-only inbound rule before applying that access change. Approve a separate concrete web/worker cost quote before buying those resources. Connect designated provider sandboxes through StockChief's connection forms and complete OAuth consent personally. Keep credentials out of chat and tracked files. No customer contact, live postage purchase, real money transfer or StockChief subscription implementation is authorized by this plan.

# Bounded stock-import execution

`FOUNDRY_IMPORT_STOCK_WORKERS` is an operator setting, disabled by default.
Values 1–4 opt eligible **new** stock imports into four persistent partitions,
served by that many independent sessions. Start with 2; reserve pool capacity
for the job heartbeat and other worker lanes. The coordinator serves the first
lane, and concurrency is capped to leave one pool slot free. Customer input cannot
set concurrency. Existing partial serial imports retain their original order.

Eligibility requires at least 5,000 additive rows for existing ordinary quantity
SKUs, positive whole quantities and positive costs, one currency, and no price,
catalogue, barcode, supplier, reorder, category, serial, lot or measured-stock
changes. Other imports use the existing verified engine. A durable lane import
resumes its original partitions with one session if this setting is disabled.

Each item belongs to one partition. Indexed item/SKU/source-row cursors preserve
source order within a SKU. The existing stock, cost and accounting code applies
and verifies each batch before atomically saving an immutable receipt and cursor.
Final verification folds those receipts rather than rescanning all source rows.
The operator is checked before work and before saving. Failed batches roll back;
all in-flight sessions finish before the coordinator reports an interruption.

The coordinator continuously owns `catalog:<workspace>` while handing exclusive
ownership to shared ownership. Child sessions retain shared ownership across
commits, preventing another import or metadata update from entering even if the
coordinator disconnects. New child sessions reject a missing coordinator. All
catalogue writers must have the nonblocking catalogue guard before enabling this
setting; let retiring deployment instances drain first.

Journal numbers are reserved durably before stock work starts. Private tokens
bind each posting to its approved import, source-row digest, posting date and
reserved number. Uniqueness, balanced lines, tenant scope, active accounts and
open periods remain enforced. Ordinary postings retain their atomic allocator.
Reserved postings omit the global journal lock and do not lock the already
advanced counter. Shared posting-period locks still exclude period closure.

## Measured result, not throughput certification

One local paired run of the original 150,000-row source, SHA-256
`13c428ec124cfbac0cd855a9c24d6f320b247a66cdbee7f197ce57757a341f71`,
using cloned starting databases with 50,000 existing SKUs and five warehouses:

| Execution | Preview and upload | Apply and verify | End to end |
| --- | ---: | ---: | ---: |
| Serial | 22.395 s | 69.934 s | 92.328 s |
| Two sessions | 25.579 s | 50.228 s | 75.807 s |

Both verified 150,000 positions, 150,000 units and 67,500,000 minor units of
inventory value. End-to-end savings: 16.521 s. This is a local result with no
neighboring million-SKU dataset; **it does not meet the 60-second requirement or
certify hosted throughput**. Keep the separate hosted import, fresh-million and
cross-customer qualification gates. Do not describe this release as completing
those goals.

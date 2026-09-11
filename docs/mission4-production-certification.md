# Mission 4 certification record

This file describes what the Mission 4 gate proves. Live results are stored as
durable `runtime_checkpoints` and displayed on the owner-only Operations page.

## Automated evidence

- full browser regression: two consecutive complete runs, no stalls
- adversarial runtime: tenant isolation, permissions, concurrency, duplicate
  delivery and crash-mid-action
- load/soak: at least 900 seconds with recorded latency/error budgets
- durable worker throughput: at least 1,000 leased and completed jobs within the
  recorded jobs-per-second budget
- database quick check, current schema and zero unexplained reconciliation gaps
- durable queue/inbox/outbox retry, lease, dead-letter and idempotency tests
- verified backup and actual restore into a different database file
- release/schema fingerprint and hosting rollback evidence

## Live-provider evidence

OAuth popup return must preserve the signed-in Foundry session. Token refresh,
webhook delivery plus polling fallback, settled/reconciled customer payment and
customer-funded shipping onboarding each have their own checkpoint. Sandbox or
mock assertions do not certify a live checkpoint. Evidence must also match the
exact immutable release currently deployed.

## Human evidence

An independent person completes a zero-training walkthrough of Inventory,
Purchasing, supplier email, Sales Orders, Needs You and Accounting. Support,
password recovery and alerting require actual receipt/acknowledgement. Foundry
must explain any blocked gate and the exact prerequisite rather than presenting
the deployment as production-ready.

The final pass condition is `/readyz` returning ready with no required blocker.

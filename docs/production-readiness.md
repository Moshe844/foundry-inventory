# Foundry production-certification runbook

Mission 4 is a release gate backed by runtime evidence. A green local test run
does not certify an external service, a human response, or a hosting operation.
The owner-only Operations page evaluates the deployment as production and lists
every missing prerequisite.

## Runtime architecture

- Business truth is transactional in the relational database. Runtime jobs,
  provider inbox events, outbound messages, alerts and certification evidence
  are durable database records rather than process memory.
- Jobs use leases, bounded retry and dead-letter states. Completion requires the
  lease owner, so an expired worker cannot commit after another worker takes over.
- Provider inbox identities and domain idempotency keys prevent duplicate
  delivery from repeating an effect. The outbox retries delivery independently
  from the transaction which created it.
- Interrupted Foundry UI work is persisted and becomes an explicit retryable
  failure; a restart cannot leave the browser spinning forever.
- Workspace authorization and action permissions are checked server-side.
- `/healthz` reports liveness and database status. `/readyz` reports the full
  certification gate without returning credentials or business data. Readiness
  probes share a five-second snapshot so probe storms do not starve customer
  traffic; explicit certification and the owner Operations page remain fresh.
- This SQLite deployment is a single-writer topology. Do not run multiple
  application/worker replicas against one local file or network-mounted SQLite
  database. A multi-node deployment requires migration to a shared server
  database and re-certification of leases and concurrency.
- `FOUNDRY_PROCESS_ROLE=web` starts HTTP only, `worker` starts schedulers and
  durable workers without binding a port, and `all` (the default) runs both in
  the one supported SQLite process.

## Required environment

Use separate databases, encryption keys, OAuth applications, webhook secrets,
public origins and provider accounts for development, staging and production.
At minimum production needs:

- `NODE_ENV=production`, `FOUNDRY_PUBLIC_URL=https://...`
- `FOUNDRY_CONNECTION_ENCRYPTION_KEY`
- `FOUNDRY_SUPPORT_EMAIL` pointing to a monitored mailbox
- `FOUNDRY_EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `FOUNDRY_FROM_EMAIL`
- `FOUNDRY_ALERT_WEBHOOK_URL`, `FOUNDRY_ALERT_WEBHOOK_TOKEN`,
  `FOUNDRY_ALERT_ACK_TOKEN`
- `FOUNDRY_BACKUPS_ENABLED=true`, an off-host `FOUNDRY_BACKUP_DIR`, and
  `FOUNDRY_BACKUP_STORAGE=offsite`
- provider-specific production OAuth/webhook secrets

## Certification commands

Run these against staging configured like production:

```powershell
$env:FOUNDRY_RELEASE_REF = "the exact deployed commit or immutable release id"
npm test
node --test tests/integration/*.test.js
npm run certify:browser
npm run certify:adversarial
node scripts/load-soak.js --url https://staging.example.com --seconds 900 --concurrency 20 --p95-ms 750 --error-rate 0.005
npm run certify:worker
npm run backup
node scripts/verify-restore.js C:\path\to\foundry-backup.sqlite --production-like --hosting-provider PROVIDER --hosting-evidence CHANGE_OR_RUN_ID
node scripts/verify-hosting-rollback.js --from RELEASE --to PREVIOUS_RELEASE --evidence CHANGE_OR_RUN_ID
```

Automated browser, adversarial, load and worker evidence is valid only for the
exact `FOUNDRY_RELEASE_REF` currently deployed. Production must never use the
default `development` value.

`certify:browser` requires two consecutive completions of the complete browser
pack. It covers actual browser navigation and provider popup behavior; it is not
replaced by unit tests. The independent zero-training walkthrough is separate
and must be completed by a person who was not trained on Foundry.
The unauthenticated soak creates no browser sessions. An authenticated soak
reuses one dedicated staging cookie; it must not manufacture a new anonymous
CSRF session on every request.
By default it exercises health, readiness and static delivery and counts every
4xx/5xx as an error. Set `FOUNDRY_LOAD_COOKIE` to a dedicated staging account's
cookie to exercise the authenticated default paths (`/`, `/inventory`, `/orders`,
`/accounting`) without putting credentials on the command line.
Login rate limiting runs before session allocation, and unsigned sessions expire
after one hour by default (`FOUNDRY_ANONYMOUS_SESSION_MS`) rather than inheriting
the fourteen-day signed-in lifetime.

## Monitoring and incidents

Collect process exits, HTTP 5xx rates, dead jobs/outbox messages, backup
failures, provider/webhook failures, connection health and database disk usage.
Logs must omit tokens, credentials, document bodies and reset links.
Pending/retry work more than five minutes past its available time is treated as
stuck and blocks readiness even if it has not exhausted its retry limit.
An unresolved error or critical incident blocks readiness until it is reviewed
and explicitly resolved; warning-level certification probes do not.

For a critical alert: acknowledge it using the protected responder endpoint,
identify the affected workspace/records, pause the unsafe worker or integration,
retry only through its idempotent domain adapter, verify inventory and accounting
invariants, then resolve the alert with evidence. “Needs you” business decisions
are not infrastructure incidents.

## Deployment and rollback

1. Record release and schema versions; complete all automated and browser gates.
2. Create and verify an off-site backup and perform a hosting-platform restore.
3. Stop old-version schedulers before the new version begins polling.
4. Deploy, check `/healthz` and `/readyz`, then run signed-in smoke workflows.
5. If rollback is required, stop Foundry, preserve the failed database and
   sidecars, restore the verified pre-deploy backup to a new path, deploy the
   recorded previous revision, and verify the latest inventory, purchasing,
   sales, payment and accounting records. Never overwrite the only database.

## Gates that cannot be self-certified

- a real password-recovery message received through the production sender
- an injected alert acknowledged by the monitored human responder
- a monitored support mailbox with named ownership
- off-site backup plus hosting-platform restore and deployment rollback evidence
- live OAuth return/session preservation, refresh, webhook/poll fallback,
  payment settlement and customer-funded shipping onboarding
- independent zero-training completion of Inventory, Purchasing, supplier email,
  Sales Orders, Needs You and Accounting

These remain blocked until real evidence exists. No local flag silently converts
a local rehearsal into hosting or independent-user evidence.

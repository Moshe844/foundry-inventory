# Keeper production-readiness runbook

Mission 14.5 treats production readiness as a release gate, not a UI label.
The checks below describe what the application enforces and what the deployment
operator must prove before inviting a private-beta business.

## Controls implemented in the application

- Workspace membership is resolved on every request; a session workspace id is
  never treated as authorization. Cross-workspace unit, HTTP, connector, email,
  accounting, and unified-state tests cover isolation.
- Roles and permissions gate stock operation, purchasing, supplier settings,
  accounting, connection, workspace, and export actions on the server.
- Session state has CSRF protection. Login and external-event API routes are
  rate limited. Request-limiter keys are one-way hashes.
- OAuth/provider credentials use AES-256-GCM encryption at rest and are excluded
  from workspace exports. Password hashes, sessions, and authorization states
  are also excluded.
- External events, supplier messages, documents, jobs, accounting postings,
  payments, receipts, and stock movements have durable identity/idempotency
  boundaries. A provider retry or process restart cannot intentionally repeat a
  completed business action.
- Manager/autopilot recovery reconciles in-flight work before retrying. A failed
  verification suspends automatic execution rather than repeating it.
- SQLite migrations are additive and tested against older databases. A release
  must run migration tests and create a verified backup before deployment.
- `/healthz` checks database availability and reports process uptime without
  returning credentials or business data.
- Workspace owners can export their workspace as JSON from Settings. The export
  is scoped to one workspace and includes a SHA-256 evidence digest.
- Scheduled SQLite online backups, integrity verification, retention, and an
  actual restore test are implemented. See `docs/backup-and-recovery.md`.

## Environment separation and rollback

Use separate databases, encryption keys, OAuth applications, webhook secrets,
public origins, and provider accounts for development, staging, and production.
Never point staging at the production SQLite file or reuse the production
`FOUNDRY_CONNECTION_ENCRYPTION_KEY`.

Before deploying:

1. Run unit/integration, live-provider, and browser E2E suites in staging.
2. Run `npm run backup` and verify the manifest reports `ok: true`.
3. Record the application revision and database schema revision.
4. Deploy one application version while background schedulers are stopped on
   the old version, so two versions do not race leases.
5. Check `/healthz`, sign in, open Home, Needs you, Connections, and Accounting,
   and process a reversible staging transaction.

Rollback means stopping Keeper, preserving the failed database for diagnosis,
restoring the verified pre-deploy backup to a new file, pointing
`DATABASE_PATH` at that restored file, deploying the recorded prior revision,
and rerunning the smoke checks. Never overwrite the only copy of a database.

## Monitoring and incident evidence

Production must collect process exits, HTTP 5xx rates, background-job failures,
backup failures, connection health, provider/webhook errors, and database disk
usage. Logs must be access controlled and must not include request bodies,
tokens, document contents, or credentials. Alerts should distinguish an owner
decision from an operational outage; ordinary Needs you work is not a server
incident.

## Private-beta release blockers

The application deliberately reports these as deployment gates rather than
pretending they are solved by a local screen:

- Set `FOUNDRY_SUPPORT_EMAIL` and verify the Support link reaches a monitored
  mailbox.
- Configure and test the deployment's account/password-recovery channel. A
  secure reset cannot be claimed without a verified email sender.
- Establish an operator-reviewed workspace/account deletion procedure with a
  retention/legal-hold policy and a recent verified backup. Do not expose a
  one-click destructive action before that policy exists.
- Connect production error tracking and operational alert delivery, then prove
  an injected staging failure reaches the on-call recipient.
- Run a restore drill on the production hosting platform and record the measured
  recovery time.

Broad autonomous purchasing or financial authority stays off for beta users.
Owners must explicitly approve bounded policy and supplier authority.

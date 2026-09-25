# StockChief backup and recovery

StockChief uses SQLite's online backup API. Each completed backup must pass
`integrity_check`, and a JSON manifest records its size plus workspace, movement
and accounting-entry counts and SHA-256 digest. The manifest is the commit record: a `.sqlite`
file without a verified manifest is partial/untrusted and readiness ignores it.
Interrupted creation removes the destination and SQLite sidecars.

Production backups must be written or replicated off the application host and
configured with `FOUNDRY_BACKUP_STORAGE=offsite`. A same-disk backup can help
development but does not pass production certification.

## Create and verify

```powershell
npm run backup
node scripts/verify-restore.js C:\path\to\foundry-....sqlite
```

The restore command copies into a new temporary database, checks integrity and
compares critical counts. It never overwrites the live database. This proves a
local artifact is readable, but does not certify the hosting platform.

## Hosting-platform rehearsal

Restore the off-site artifact through the real hosting/storage procedure into an
isolated production-like environment. Verify `/healthz`, sign in, and inspect the
latest inventory movement, purchase receipt, customer payment and accounting
posting. Record the provider and change/run identifier only after that succeeds:

```powershell
node scripts/verify-restore.js C:\path\to\downloaded-backup.sqlite --production-like --hosting-provider PROVIDER --hosting-evidence CHANGE_OR_RUN_ID
```

Do not use those flags for a local-only rehearsal. Production readiness requires
both `productionLike` and `hostingVerified` evidence.

## PostgreSQL staging and production

Create the dump on the live service, restore it only into a separate empty
PostgreSQL database, and record provider evidence back in the live database:

```powershell
npm run backup:postgres
$env:FOUNDRY_RESTORE_DATABASE_URL='postgresql://...separate-empty-database...'
node scripts/verify-postgres-restore.js data/postgres-backups/stockchief-postgres-....dump --production-like --hosting-provider Render --hosting-evidence RESTORE_DATABASE_OR_RUN_ID
```

The verifier rejects the live database as a restore target, requires the target
to be empty, validates the dump checksum, compares every restored table and
critical total, and checks that restored journals balance. A local restore may
omit the three hosting flags, but it does not pass the production restore gate.

## Recovery

1. Stop StockChief so no process writes the live database.
2. Preserve the live database plus `-wal` and `-shm`; never overwrite them.
3. Download/select a verified off-site backup and run the restore rehearsal.
4. Restore to a new path and point `DATABASE_PATH` at that file.
5. Start StockChief, check `/healthz` and `/readyz`, and verify current operational
   and accounting records with the owner.
6. Keep the previous database until the restored state is accepted.

The default target is a recovery point under 24 hours and recovery within 30
minutes. A missed/failed backup must raise an external operational alert.

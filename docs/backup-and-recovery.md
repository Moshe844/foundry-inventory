# Foundry backup and recovery

Foundry uses SQLite's online backup API. Each completed backup must pass
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

## Recovery

1. Stop Foundry so no process writes the live database.
2. Preserve the live database plus `-wal` and `-shm`; never overwrite them.
3. Download/select a verified off-site backup and run the restore rehearsal.
4. Restore to a new path and point `DATABASE_PATH` at that file.
5. Start Foundry, check `/healthz` and `/readyz`, and verify current operational
   and accounting records with the owner.
6. Keep the previous database until the restored state is accepted.

The default target is a recovery point under 24 hours and recovery within 30
minutes. A missed/failed backup must raise an external operational alert.

# Keeper backup and recovery

Keeper creates a transactionally consistent SQLite backup every 24 hours when
`FOUNDRY_BACKUPS_ENABLED=true` (enabled by default in production). Backups are
kept for 30 days by default and stored outside the live database directory when
`FOUNDRY_BACKUP_DIR` is configured.

Each backup is opened read-only and must pass SQLite `integrity_check`. A JSON
manifest records file size and the workspace, movement, and accounting-entry
counts. A failed verification deletes the unusable backup and reports an error.

## Manual backup

Run `npm run backup`. The command prints the verified backup path.

## Restore rehearsal

Run `npm run restore:test -- C:\path\to\keeper-....sqlite`. This restores into a
new temporary database, runs the integrity check, compares critical record
counts, and removes the rehearsal copy. A backup is not considered usable until
this succeeds.

## Production restore

1. Stop Keeper so no process holds or writes the live database.
2. Preserve the live database, `-wal`, and `-shm` files; do not overwrite them.
3. Run the restore rehearsal against the selected backup.
4. Restore the backup to a new path using `restoreTo`, then point
   `DATABASE_PATH` at that verified file.
5. Start Keeper, check `/healthz`, sign in, and verify the latest inventory,
   purchase, sale, and accounting records.
6. Keep the previous database until the business owner accepts the restored
   state.

The expected recovery point is no more than 24 hours with the default schedule.
For this single-node SQLite deployment, the target recovery time is 30 minutes,
including integrity verification and owner acceptance. Deployment automation
must alert on a failed backup or missed successful backup.

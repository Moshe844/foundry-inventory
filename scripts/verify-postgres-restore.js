'use strict';

const { openPostgres }=require('../src/db/postgres');
const backups=require('../src/operations/postgres-backup');
const checkpoints=require('../src/operations/postgres-checkpoints');

async function main(){
  const source=process.argv[2];
  const target=process.env.FOUNDRY_RESTORE_DATABASE_URL;
  if(!source||!target)throw new Error('Usage: set FOUNDRY_RESTORE_DATABASE_URL to a separate empty database, then run node scripts/verify-postgres-restore.js backup.dump');
  const database=openPostgres(target,{applicationName:'stockchief-postgres-restore-verification',max:2});
  try{
    const result=await backups.restore(database,target,source);
    await checkpoints.record(database,'backup.restore','PASS',{source:result.manifest.file,
      sha256:result.source.sha256,fingerprint:result.restored.fingerprint,tables:Object.keys(result.restored.tableCounts).length});
    console.log('PostgreSQL restore verification passed.');
    console.log(`Workspaces ${result.restored.critical.workspaces}; movements ${result.restored.critical.movements}; tables ${Object.keys(result.restored.tableCounts).length}.`);
  }finally{await database.close();}
}
main().catch((error)=>{console.error(error);process.exitCode=1;});

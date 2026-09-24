'use strict';

const config=require('../src/config');
const { openPostgres }=require('../src/db/postgres');
const backups=require('../src/operations/postgres-backup');
const checkpoints=require('../src/operations/postgres-checkpoints');

async function main(){
  const connectionString=process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL;
  if(!connectionString)throw new Error('FOUNDRY_DATABASE_URL is required.');
  const database=openPostgres(connectionString,{applicationName:'stockchief-postgres-backup',max:2});
  try{
    const result=await backups.create(database,connectionString,{directory:process.env.FOUNDRY_BACKUP_DIR});
    await checkpoints.record(database,'backup.created','PASS',{file:result.manifest.file,sha256:result.manifest.sha256,
      bytes:result.manifest.bytes,fingerprint:result.manifest.snapshot.fingerprint,releaseRef:config.operations.releaseRef});
    console.log(`Verified PostgreSQL backup: ${result.path}`);
    console.log(`Workspaces ${result.manifest.snapshot.critical.workspaces}; movements ${result.manifest.snapshot.critical.movements}; tables ${Object.keys(result.manifest.snapshot.tableCounts).length}.`);
  }finally{await database.close();}
}
main().catch((error)=>{console.error(error);process.exitCode=1;});

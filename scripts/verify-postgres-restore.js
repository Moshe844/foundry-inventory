'use strict';

const config=require('../src/config');
const { openPostgres }=require('../src/db/postgres');
const backups=require('../src/operations/postgres-backup');
const checkpoints=require('../src/operations/postgres-checkpoints');

function argument(name){const index=process.argv.indexOf(`--${name}`);return index>=0?process.argv[index+1]:null;}

async function main(){
  const source=process.argv[2];
  const target=process.env.FOUNDRY_RESTORE_DATABASE_URL;
  const live=process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL;
  const productionLike=process.argv.includes('--production-like');
  const hostingProvider=argument('hosting-provider');const hostingEvidence=argument('hosting-evidence');
  const hostingVerified=productionLike&&Boolean(hostingProvider&&hostingEvidence);
  if(!source||!target||!live)throw new Error('Usage: set FOUNDRY_RESTORE_DATABASE_URL to a separate empty database, then run node scripts/verify-postgres-restore.js backup.dump');
  if(productionLike&&!hostingVerified)throw new Error('A production-like restore requires --hosting-provider and --hosting-evidence.');
  const database=openPostgres(target,{applicationName:'stockchief-postgres-restore-verification',max:2});
  const evidenceDatabase=openPostgres(live,{applicationName:'stockchief-postgres-restore-evidence',max:2});
  try{
    const result=await backups.restore(database,target,source);
    const detail={source:result.manifest.file,sha256:result.source.sha256,fingerprint:result.restored.fingerprint,
      tables:Object.keys(result.restored.tableCounts).length,productionLike,hostingVerified,
      hostingProvider:hostingProvider||null,hostingEvidence:hostingEvidence||null,releaseRef:config.operations.releaseRef};
    await checkpoints.record(evidenceDatabase,'backup.restore','PASS',detail);
    console.log('PostgreSQL restore verification passed.');
    console.log(`Workspaces ${result.restored.critical.workspaces}; movements ${result.restored.critical.movements}; tables ${Object.keys(result.restored.tableCounts).length}.`);
    if(!hostingVerified)console.log('This was not a production-like hosting rehearsal, so it does not pass the production restore gate.');
  }finally{await Promise.all([database.close(),evidenceDatabase.close()]);}
}
main().catch((error)=>{console.error(error);process.exitCode=1;});

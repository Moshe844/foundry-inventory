'use strict';
// node scripts/database-fingerprint.js > source.json          (fingerprint FOUNDRY_DATABASE_URL)
// node scripts/database-fingerprint.js --compare source.json copy.json
// Run on Render (Shell) while saving is paused, and on the restored AWS copy; the switch
// goes ahead only when --compare reports no differences. Prints counts and checksums only,
// never record contents.
const fs=require('node:fs');
async function main(argv=process.argv.slice(2)){
  const fingerprint=require('../src/db/database-fingerprint');
  if(argv[0]==='--compare'){
    const [a,b]=argv.slice(1).map(f=>JSON.parse(fs.readFileSync(f,'utf8')));
    const problems=fingerprint.compare(a,b);
    console.log(JSON.stringify({exact:problems.length===0,tables:Object.keys(a.tables).length,rows:a.totalRows,problems},null,1));
    if(problems.length)process.exitCode=1;return;
  }
  const url=process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL;if(!url)throw new Error('FOUNDRY_DATABASE_URL is required.');
  const database=require('../src/db/postgres').openPostgres(url,{applicationName:'stockchief-fingerprint',max:1});
  try{const taken=await fingerprint.take(database);console.log(JSON.stringify({takenAt:new Date().toISOString(),...taken}));}finally{await database.close();}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};

'use strict';
// Trusted operator entry. Never loaded by the agent or exposed as a tool.
require('../src/config');
async function provision(db,{businessName,emails}){
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='staging')throw Error('STAGING_ONLY');
 if(!businessName||!emails?.length)throw Error('EXPLICIT_TEST_BUSINESS_AND_USERS_REQUIRED');
 const ownerEmail=emails[0].toLowerCase();
 const workspaces=(await db.query(`SELECT w.id FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id
  WHERE w.name=$1 AND lower(a.email)=$2`,[businessName,ownerEmail])).rows;
 if(workspaces.length!==1)throw Error('Exactly one existing test business owned by the authorized email must match.');
 const workspaceId=workspaces[0].id;
 const users=(await db.query(`SELECT u.id,u.role,lower(a.email) AS email FROM users u JOIN accounts a ON a.id=u.account_id
  WHERE u.workspace_id=$1 AND lower(a.email)=ANY($2::text[])`,[workspaceId,emails.map(e=>e.toLowerCase())])).rows;
 if(users.length!==emails.length||users.find(u=>u.email===ownerEmail)?.role!=='owner')throw Error('All explicitly authorized accounts must already belong to the test business.');
 await db.query(`INSERT INTO stockchief_runtime.codex_pilots(workspace_id,authorized_actor_ids,approved_by,period_ends_at)
  VALUES($1,$2::jsonb,$3,now()+interval '7 days') ON CONFLICT(workspace_id) DO NOTHING`,
  [workspaceId,JSON.stringify(users.map(u=>u.id)),users.find(u=>u.email===ownerEmail).id]);
 return {workspaceId,enabled:false,paidBudgetUsd:0,users:users.map(u=>u.email),
  environment:{STOCKCHIEF_RUNTIME_ENV:'staging',STOCKCHIEF_CODEX_PILOT:'1',STOCKCHIEF_CODEX_PILOT_WORKSPACES:workspaceId,STOCKCHIEF_CODEX_PILOT_EMAILS:emails.join(',')}};
}
async function main(){
 const db=require('../src/db/postgres').openPostgres(process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL);
 try{await require('../src/db/migrate-postgres').migratePostgres(db);
  console.log(JSON.stringify(await provision(db,{businessName:process.argv[2],emails:process.argv.slice(3)}),null,2));}
 finally{await db.close();}
}
if(require.main===module)main().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
module.exports={provision};

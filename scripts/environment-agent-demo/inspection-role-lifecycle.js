'use strict';
const {escapeIdentifier:identifier}=require('pg');
const pattern=/^demo_(read|metrics)_[a-f0-9]{16}$/;
const leaseMs=2*60*60*1000;
const expires=()=>new Date(Date.now()+leaseMs).toISOString();

// Temporary SQL identities belong to the private inspection renderer. Their
// RLS predicates and grants are unchanged. A future login expiry lets a new
// worker identify abandoned identities after an unclean process shutdown.
async function cleanupExpired(database,{limit=8,legacyRoleNames=[]}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>32||!Array.isArray(legacyRoleNames)||legacyRoleNames.length>400||legacyRoleNames.some(name=>!pattern.test(name)))throw Error('INVALID_INSPECTION_CLEANUP_SCOPE');
 const eligible=`r.rolname ~ '^demo_(read|metrics)_[a-f0-9]{16}$' AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolbypassrls
  AND (CASE WHEN cardinality($1::text[])>0 THEN r.rolname=ANY($1::text[]) ELSE r.rolvaliduntil<now() END)
  AND NOT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.usename=r.rolname)
  AND NOT EXISTS(SELECT 1 FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass AND d.refobjid=r.oid
    AND (d.deptype='o' OR d.dbid NOT IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))))`;
 const candidates=(await database.query('SELECT r.oid,r.rolname FROM pg_roles r WHERE '+eligible+' ORDER BY r.rolname LIMIT $2',[legacyRoleNames,limit])).rows;
 if(!candidates.length)return {cleaned:0,remainingCandidates:false};
 const busy=async client=>Boolean((await client.query("SELECT 1 FROM stockchief_runtime.assistant_goals WHERE checkpoint->>'runtime'='codex-staging' AND status='RUNNING' LIMIT 1")).rows.length);
 if(await busy(database))return {cleaned:0,deferred:'ACTIVE_AGENT'};
 const tables=(await database.query("SELECT n.nspname::text AS table_schema,c.relname::text AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','stockchief_runtime') AND c.relkind IN ('r','p')")).rows;
 return require('./inspection-schema').mutate(database,tables,async client=>{
  if(await busy(client))return {cleaned:0,deferred:'ACTIVE_AGENT'};
  const rows=(await client.query('SELECT r.oid,r.rolname FROM pg_roles r WHERE '+eligible+' AND r.oid=ANY($2::oid[]) ORDER BY r.rolname',[legacyRoleNames,candidates.map(r=>r.oid)])).rows;
  if(!rows.length)return {cleaned:0,remainingCandidates:true};
  const policies=(await client.query(`SELECT n.nspname,c.relname,p.polname,p.polroles,r.rolname FROM pg_policy p
    JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_roles r ON r.oid=ANY(p.polroles) WHERE r.oid=ANY($1::oid[]) ORDER BY n.nspname,c.relname,p.polname`,[rows.map(r=>r.oid)])).rows;
  for(const p of policies)if(!['public','stockchief_runtime'].includes(p.nspname)||p.polroles.length!==1||![p.rolname,p.rolname+'_allow',p.rolname+'_restrict',p.rolname+'_conflict'].includes(p.polname))throw Error('UNEXPECTED_INSPECTION_POLICY_DEPENDENCY');
  const names=rows.map(r=>identifier(r.rolname)).join(','),statements=policies.map(p=>`DROP POLICY ${identifier(p.polname)} ON ${identifier(p.nspname)}.${identifier(p.relname)}`);
  statements.push(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public,stockchief_runtime FROM ${names}`,
   `REVOKE SELECT(id) ON public.commercial_resource_measurements FROM ${names}`,
   `REVOKE USAGE ON SCHEMA public,stockchief_runtime FROM ${names}`,
   `DROP ROLE ${names}`);
  await client.query(statements.join(';\n'));return {cleaned:rows.length,roles:rows.map(r=>r.rolname),remainingCandidates:true};
 });
}
module.exports={expires,cleanupExpired,leaseMs};

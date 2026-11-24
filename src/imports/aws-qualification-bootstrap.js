'use strict';
const {connection}=require('./aws-database-connection');
const {openPostgres}=require('../db/postgres');
const {migratePostgres}=require('../db/migrate-postgres');
const databaseName='stockchief_qualification',role='stockchief_qualification';
function identifier(value){if(typeof value!=='string'||!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(value))throw new Error('A valid database name is required.');return '"'+value+'"';}
function settings(env){
 if(env.STOCKCHIEF_IMPORT_DATABASE_ROLE!==role)throw new Error('Bootstrap is restricted to the synthetic qualification role.');
 const scoped=connection(env),address=new URL(scoped.connectionString);
 if(address.pathname!=='/'+databaseName)throw new Error('Bootstrap is restricted to the synthetic qualification database.');
 let master;try{master=JSON.parse(env.STOCKCHIEF_QUALIFICATION_MASTER_SECRET);}catch{throw new Error('Inject the managed bootstrap secret before qualification.');}
 if(!master||master.username!=='sc_database_owner'||typeof master.password!=='string'||!master.password||master.host&&master.host!==address.hostname||Number(master.port??5432)!==5432||master.engine&&master.engine!=='postgres')throw new Error('The bootstrap secret must match the approved database owner and endpoint.');
 const credentials=JSON.parse(env.STOCKCHIEF_IMPORT_DATABASE_SECRET),main=env.STOCKCHIEF_MIGRATION_DATABASE_NAME||'stockchief';identifier(main);
 if(main===databaseName)throw new Error('Customer restore and qualification databases must be separate.');
 if(!/^[a-zA-Z][a-zA-Z0-9-]{2,127}$/.test(env.STOCKCHIEF_QUALIFICATION_OWNER||''))throw new Error('The qualification resource owner is required.');
 if(!/^[a-f0-9]{40}$/.test(env.STOCKCHIEF_QUALIFICATION_COMMIT||''))throw new Error('An immutable qualification commit is required.');
 address.username=encodeURIComponent(master.username);address.password=encodeURIComponent(master.password);address.pathname='/postgres';
 return {scoped,master:address,credentials,main,owner:env.STOCKCHIEF_QUALIFICATION_OWNER,commit:env.STOCKCHIEF_QUALIFICATION_COMMIT};
}
async function bootstrap(env=process.env,{open=openPostgres,migrate=migratePostgres}={}){
 const s=settings(env),opened=[],connect=url=>{const db=open(url,{max:2,ca:s.scoped.ca,privateNetwork:false,requireTls:true,applicationName:'stockchief-qualification-bootstrap'});opened.push(db);return db;};
 try{
  const admin=connect(s.master.href),mainUrl=new URL(s.master);mainUrl.pathname='/'+s.main;
  const main=connect(mainUrl.href);
  const present=(await main.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname IN('public','stockchief_runtime')")).rows[0].n;
  if(present!==0)throw new Error('The customer restore database is not empty; qualification bootstrap will not change its access.');
  const exists=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[databaseName])).rowCount>0;
  if(!exists)await admin.query('CREATE DATABASE stockchief_qualification TEMPLATE template0');
  const ownerUrl=new URL(s.master);ownerUrl.pathname='/'+databaseName;const owner=connect(ownerUrl.href);
  const marked=(await owner.query("SELECT to_regclass('public.stockchief_aws_qualification_marker') AS marker")).rows[0].marker;
  if(marked){
   const rows=(await owner.query('SELECT owner_tag,db_endpoint FROM stockchief_aws_qualification_marker WHERE singleton')).rows;
   if(rows.length!==1||rows[0].owner_tag!==s.owner||rows[0].db_endpoint!==s.master.hostname)throw new Error('This database is not owned by the current synthetic qualification.');
  }else{
   if((await owner.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname IN('public','stockchief_runtime')")).rows[0].n!==0)throw new Error('Do not bootstrap an unmarked database containing existing records.');
   await owner.transaction(async c=>{
    await c.query('CREATE TABLE stockchief_aws_qualification_marker(singleton boolean PRIMARY KEY CHECK(singleton),owner_tag text NOT NULL,db_endpoint text NOT NULL,release_ref text NOT NULL)');
    await c.query('INSERT INTO stockchief_aws_qualification_marker VALUES(true,$1,$2,$3)',[s.owner,s.master.hostname,s.commit]);
   },{isolation:'READ COMMITTED'});
  }
  await admin.transaction(async c=>{
   const current=(await c.query('SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[role])).rows[0];
   if(current){if(!marked||!current.rolcanlogin||current.rolsuper||current.rolcreatedb||current.rolcreaterole||current.rolreplication||current.rolbypassrls)throw new Error('The existing qualification role cannot be adopted safely.');}
   else{
    // Keep the password in a bound, transaction-local setting. The DDL and
    // errors never interpolate its plaintext into a logged SQL statement.
    await c.query("SELECT set_config('stockchief.qualification_password',$1,true)",[s.credentials.password]);
    await c.query("DO $sc$ BEGIN EXECUTE format('CREATE ROLE stockchief_qualification LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L',current_setting('stockchief.qualification_password')); END $sc$");
   }
   await c.query('REVOKE CONNECT ON DATABASE '+identifier(s.main)+' FROM PUBLIC');
   await c.query('REVOKE ALL ON DATABASE '+identifier(s.main)+' FROM stockchief_qualification');
   await c.query('GRANT CONNECT ON DATABASE stockchief_qualification TO stockchief_qualification');
  },{isolation:'READ COMMITTED'});
  const migrations=await migrate(owner);
  await owner.transaction(async c=>{
   await c.query('GRANT USAGE ON SCHEMA public,stockchief_runtime TO stockchief_qualification');
   await c.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public,stockchief_runtime TO stockchief_qualification');
   await c.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public,stockchief_runtime TO stockchief_qualification');
   await c.query('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public,stockchief_runtime TO stockchief_qualification');
   await c.query('REVOKE ALL ON stockchief_aws_qualification_marker FROM stockchief_qualification');
   await c.query('GRANT SELECT ON stockchief_aws_qualification_marker TO stockchief_qualification');
  },{isolation:'READ COMMITTED'});
  const runtime=connect(s.scoped.connectionString),proof=(await runtime.query("SELECT current_user AS role,current_database() AS database,has_database_privilege(current_user,$1,'CONNECT') AS can_connect_main",[s.main])).rows[0];
  if(proof.role!==role||proof.database!==databaseName||proof.can_connect_main!==false)throw new Error('Qualification database isolation did not pass.');
  await runtime.query('SELECT 1 FROM workspaces LIMIT 1');await runtime.query('SELECT 1 FROM stockchief_runtime.jobs LIMIT 1');
  return {database:databaseName,role,migrationsApplied:migrations.length,isolationVerified:true,releaseRef:s.commit};
 }finally{await Promise.allSettled(opened.map(db=>db.close()));}
}
if(require.main===module)bootstrap().then(result=>console.log(JSON.stringify({event:'qualification_bootstrap_complete',...result}))).catch(error=>{console.error(JSON.stringify({event:'qualification_bootstrap_failed',code:error.code||'bootstrap_failed',message:error.message}));process.exitCode=1;});
module.exports={bootstrap,settings};

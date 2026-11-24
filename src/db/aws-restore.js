'use strict';
// Restores a Render export of the live database into the AWS database, as a copy that
// customers are not using yet, and proves it:
//  1. Refuses a database marked live, and anything it did not create itself.
//  2. Creates (or re-keys) two logins: the owner, used only by migrations, and the
//     website login, which reads and writes records but cannot change structure.
//  3. Restores every table, index, sequence and record with pg_restore, in one
//     transaction, owned by the owner login. Only the extensions the app uses are kept.
//  4. Grants the website login, refreshes database statistics, and prints the copy's
//     fingerprint (row counts and checksums, never record contents) for comparison with
//     the source's fingerprint taken while saving was paused.
// Marking the copy live is a separate, explicit step (markLive) after the switch.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {openPostgres}=require('./postgres');
const NAME=/^[a-z_][a-z0-9_]{2,62}$/,FORBIDDEN=new Set(['postgres','rdsadmin','template0','template1','stockchief_qualification']);
const KEEP_EXTENSIONS=new Set(['plpgsql','citext','pg_trgm']);
const quote=name=>'"'+String(name).replaceAll('"','""')+'"';
function log(value){console.log(JSON.stringify({event:'aws_restore',at:new Date().toISOString(),...value}));}

function settings(env){
  const secret=name=>{const value=env[name];if(!value)throw new Error(name+' is required.');const parsed=JSON.parse(value);if(!parsed.username||!parsed.password)throw new Error(name+' needs a username and password.');return parsed;};
  const master=secret('STOCKCHIEF_RESTORE_MASTER_SECRET'),owner=secret('STOCKCHIEF_RESTORE_OWNER_SECRET'),runtime=secret('STOCKCHIEF_RESTORE_RUNTIME_SECRET');
  const database=String(env.STOCKCHIEF_RESTORE_DATABASE||'stockchief');
  if(!NAME.test(database)||FORBIDDEN.has(database))throw new Error('Choose the application database to restore into.');
  for(const login of [owner,runtime])if(!NAME.test(login.username)||login.username===master.username)throw new Error('The owner and website logins need their own lower-case names.');
  if(owner.username===runtime.username)throw new Error('The owner and website logins must differ.');
  const host=env.STOCKCHIEF_RESTORE_HOST||master.host,port=Number(env.STOCKCHIEF_RESTORE_PORT||master.port||5432);
  if(!host)throw new Error('The database host is required.');
  const local=['localhost','127.0.0.1','::1'].includes(host);
  const caPath=env.STOCKCHIEF_RESTORE_CA||path.join(__dirname,'certificates/aws-rds-us-east-2.pem');
  if(!local&&!fs.existsSync(caPath))throw new Error('The database certificate bundle is missing.');
  const source=String(env.STOCKCHIEF_RESTORE_SOURCE||'');if(!source)throw new Error('STOCKCHIEF_RESTORE_SOURCE is required.');
  return {master,owner,runtime,database,host,port,local,caPath,source,sourceVersion:env.STOCKCHIEF_RESTORE_SOURCE_VERSION||null,
    replace:env.STOCKCHIEF_RESTORE_REPLACE==='replace-unswitched-copy',bin:env.STOCKCHIEF_PG_BIN||'',workdir:env.STOCKCHIEF_RESTORE_WORKDIR||os.tmpdir()};
}
function url(s,login,database){
  const u=new URL('postgresql://localhost');u.hostname=s.host;u.port=String(s.port);u.username=encodeURIComponent(login.username);u.password=encodeURIComponent(login.password);u.pathname='/'+database;
  if(!s.local){u.searchParams.set('sslmode','verify-full');}
  return u.href;
}
function open(s,login,database,name){return openPostgres(url(s,login,database),{max:2,applicationName:name,...(s.local?{}:{ca:fs.readFileSync(s.caPath,'utf8'),requireTls:true,privateNetwork:false})});}

function exec(s,command,args,{env={},capture=false}={}){
  const file=s.bin?path.join(s.bin,command+(process.platform==='win32'?'.exe':'')):command;
  return new Promise((resolve,reject)=>{const child=spawn(file,args,{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let out='',err='';
    child.stdout.on('data',d=>{if(capture)out+=d;});child.stderr.on('data',d=>{err+=d;if(err.length>20000)err=err.slice(-20000);});
    child.on('error',reject);child.on('exit',code=>code===0?resolve(out):reject(new Error(command+' failed ('+code+'): '+err.replace(/password=[^ ]+/gi,'password=…').slice(-1500))));});
}
async function fetchSource(s){
  if(!s.source.startsWith('s3://'))return {file:s.source,sha256:null,bytes:null};
  const m=/^s3:\/\/([^/]+)\/(.+)$/.exec(s.source);if(!m)throw new Error('Use s3://bucket/key for the export.');
  const {S3Client,GetObjectCommand}=require('@aws-sdk/client-s3');const s3=new S3Client({});
  const object=await s3.send(new GetObjectCommand({Bucket:m[1],Key:m[2],...(s.sourceVersion?{VersionId:s.sourceVersion}:{})}));
  const file=path.join(s.workdir,'render-export-'+crypto.randomBytes(4).toString('hex')+path.extname(m[2]).replace(/[^.a-z0-9]/gi,'')),hash=crypto.createHash('sha256');let bytes=0;
  await new Promise((resolve,reject)=>{const out=fs.createWriteStream(file);object.Body.on('data',d=>{hash.update(d);bytes+=d.length;});object.Body.on('error',reject);out.on('error',reject);out.on('finish',resolve);object.Body.pipe(out);});
  return {file,sha256:hash.digest('hex'),bytes,version:object.VersionId||null};
}
// A directory dump (toc.dat), a .tar/.tar.gz of one, or a single-file custom dump.
async function dumpPath(s,file){
  if(fs.statSync(file).isDirectory())return file;
  const head=Buffer.alloc(512);const fd=fs.openSync(file,'r');fs.readSync(fd,head,0,512,0);fs.closeSync(fd);
  if(head.subarray(0,5).toString()==='PGDMP')return file;
  const gz=head[0]===0x1f&&head[1]===0x8b,tar=head.subarray(257,262).toString()==='ustar';
  if(!gz&&!tar)throw new Error('The export is not a pg_dump archive.');
  const into=fs.mkdtempSync(path.join(s.workdir,'render-export-'));await exec({bin:''},'tar',[gz?'-xzf':'-xf',file,'-C',into]);
  const found=[];(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.name==='toc.dat')found.push(d);}})(into);
  if(found.length!==1)throw new Error('The export must contain exactly one directory-format dump.');
  return found[0];
}

async function ensureLogin(client,login,{inherit}){
  const current=(await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[login.username])).rows[0];
  if(current&&(current.rolsuper||current.rolcreatedb||current.rolcreaterole||current.rolreplication||current.rolbypassrls))throw new Error('The existing '+login.username+' login has more power than it may have.');
  // The password stays in a bound, transaction-local setting, never in logged SQL text.
  await client.query("SELECT set_config('stockchief.restore_password',$1,true)",[login.password]);
  const attributes='LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS '+(inherit?'INHERIT':'NOINHERIT');
  await client.query(`DO $r$ BEGIN EXECUTE format('${current?'ALTER':'CREATE'} ROLE %I ${attributes} PASSWORD %L',${"'"+login.username+"'"},current_setting('stockchief.restore_password')); END $r$`);
}

async function restore(env=process.env){
  const s=settings(env),started=Date.now();
  const admin=open(s,s.master,'postgres','stockchief-restore-admin');
  try{
    // 1. What is there now.
    const exists=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[s.database])).rows.length>0;
    if(exists){
      const existing=open(s,s.master,s.database,'stockchief-restore-check');
      let marker=null,tables=0;
      try{
        marker=(await existing.query("SELECT to_regclass('stockchief_restore.marker') IS NOT NULL AS present")).rows[0].present
          ?(await existing.query('SELECT mode,restored_at FROM stockchief_restore.marker ORDER BY restored_at DESC LIMIT 1')).rows[0]||null:null;
        tables=Number((await existing.query("SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'")).rows[0].n);
      }finally{await existing.close();}
      if(marker?.mode==='live')throw new Error('This database is live. It is never replaced.');
      if(marker&&!s.replace)throw new Error('A restored copy is already here. Set STOCKCHIEF_RESTORE_REPLACE=replace-unswitched-copy to replace it.');
      if(!marker&&tables>0)throw new Error('The database holds tables this restore did not create. Nothing was changed.');
      await admin.query(`DROP DATABASE ${quote(s.database)} WITH (FORCE)`);
      log({stage:'replaced',database:s.database,previous:marker?.mode||'empty'});
    }
    // 2. Logins; the master may act for the owner to create its database.
    await admin.transaction(async c=>{await ensureLogin(c,s.owner,{inherit:true});await ensureLogin(c,s.runtime,{inherit:false});
      await c.query(`GRANT ${quote(s.owner.username)} TO ${quote(s.master.username)}`).catch(e=>{if(e.code!=='0LP01')throw e;});},{isolation:'READ COMMITTED'});
    await admin.query(`CREATE DATABASE ${quote(s.database)} OWNER ${quote(s.owner.username)}`);
    await admin.query(`REVOKE ALL ON DATABASE ${quote(s.database)} FROM PUBLIC`);
    log({stage:'database-ready',database:s.database});
  }finally{await admin.close();}

  // 3. The export, restored as the owner in one transaction (all or nothing).
  const source=await fetchSource(s),dump=await dumpPath(s,source.file);
  log({stage:'export-ready',bytes:source.bytes,sha256:source.sha256,version:source.version||s.sourceVersion});
  const pgEnv={PGPASSWORD:s.owner.password,...(s.local?{}:{PGSSLMODE:'verify-full',PGSSLROOTCERT:s.caPath})};
  const toc=await exec(s,'pg_restore',['-l',dump],{capture:true});
  const kept=toc.split(/\r?\n/).filter(line=>{const ext=/\bEXTENSION - (\S+)|\bCOMMENT - EXTENSION (\S+)/.exec(line);return !ext||KEEP_EXTENSIONS.has(ext[1]||ext[2]);});
  const dropped=toc.split(/\r?\n/).length-kept.length,list=path.join(s.workdir,'restore-list-'+crypto.randomBytes(4).toString('hex')+'.txt');fs.writeFileSync(list,kept.join('\n'));
  await exec(s,'pg_restore',['--no-owner','--no-privileges','--exit-on-error','--single-transaction','--use-list',list,
    '-h',s.host,'-p',String(s.port),'-U',s.owner.username,'-d',s.database,dump],{env:pgEnv});
  log({stage:'restored',skippedExtensionEntries:dropped});

  // 4. Marker (owned by the master, invisible to the app), grants, statistics, fingerprint.
  const master=open(s,s.master,s.database,'stockchief-restore-marker');
  try{await master.transaction(async c=>{await c.query(`CREATE SCHEMA stockchief_restore AUTHORIZATION ${quote(s.master.username)}`);
    await c.query('REVOKE ALL ON SCHEMA stockchief_restore FROM PUBLIC');
    await c.query("CREATE TABLE stockchief_restore.marker(mode text NOT NULL CHECK(mode IN ('copy','live')),source text NOT NULL,source_version text,source_sha256 text,restored_at timestamptz NOT NULL DEFAULT now())");
    await c.query("INSERT INTO stockchief_restore.marker(mode,source,source_version,source_sha256) VALUES('copy',$1,$2,$3)",[s.source.replace(/\?.*$/,''),source.version||s.sourceVersion,source.sha256]);},{isolation:'READ COMMITTED'});}
  finally{await master.close();}
  const owner=open(s,s.owner,s.database,'stockchief-restore-owner');
  try{
    const granted=await require('./runtime-grants').grant(owner,s.runtime.username);
    await owner.transaction(c=>c.query('ANALYZE'),{isolation:'READ COMMITTED',statementTimeoutMs:3600000});
    const fingerprint=await require('./database-fingerprint').take(owner);
    log({stage:'verified',schemas:granted.schemas,tables:Object.keys(fingerprint.tables).length,rows:fingerprint.totalRows,migrations:fingerprint.migrations,seconds:Math.round((Date.now()-started)/1000)});
    console.log(JSON.stringify({event:'aws_restore_fingerprint',...fingerprint}));
    return {database:s.database,fingerprint,source};
  }finally{await owner.close();if(source.file!==s.source)fs.rmSync(source.file,{force:true});fs.rmSync(list,{force:true});}
}

// After the switch: the copy becomes the live database and can never be replaced again.
async function markLive(env=process.env){
  const s=settings({STOCKCHIEF_RESTORE_SOURCE:'-',...env}),master=open(s,s.master,s.database,'stockchief-restore-live');
  try{const r=await master.query("UPDATE stockchief_restore.marker SET mode='live' WHERE mode='copy' RETURNING restored_at");if(r.rowCount!==1)throw new Error('There is no unswitched copy to mark live.');log({stage:'marked-live',database:s.database});}
  finally{await master.close();}
}

if(require.main===module){(process.argv.includes('--mark-live')?markLive():restore()).catch(error=>{log({stage:'failed',message:String(error.message).slice(0,800)});process.exitCode=1;});}
module.exports={restore,markLive,settings};

'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const { spawn }=require('node:child_process');

function quote(identifier){return `"${String(identifier).replaceAll('"','""')}"`;}
function safeAddress(connectionString){
  let address;
  try{address=new URL(connectionString);}catch{throw new Error('Provide a valid PostgreSQL connection URL.');}
  if(!['postgres:','postgresql:'].includes(address.protocol)||!address.hostname||!address.pathname.slice(1)){
    throw new Error('The PostgreSQL connection URL needs a host and database name.');
  }
  const password=decodeURIComponent(address.password||'');
  address.password='';
  return {url:address.toString(),password,host:address.hostname,port:address.port||'5432',
    database:decodeURIComponent(address.pathname.slice(1))};
}
function binary(name,options={}){
  const directory=options.binDir||process.env.STOCKCHIEF_POSTGRES_BIN||
    (process.platform==='win32'&&fs.existsSync('C:/Program Files/PostgreSQL/17/bin')?'C:/Program Files/PostgreSQL/17/bin':'');
  return directory?path.join(directory,`${name}${process.platform==='win32'?'.exe':''}`):name;
}
function run(name,args,connection,options={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(binary(name,options),args,{windowsHide:true,env:{...process.env,
      ...(connection.password?{PGPASSWORD:connection.password}:{}),PGCONNECT_TIMEOUT:String(options.connectTimeoutSeconds||15)}});
    let stderr='';
    child.stderr.on('data',(chunk)=>{stderr=`${stderr}${chunk}`.slice(-8000);});
    const timeout=setTimeout(()=>child.kill('SIGKILL'),options.timeoutMs||15*60_000);
    child.on('error',(error)=>{clearTimeout(timeout);reject(error);});
    child.on('close',(code,signal)=>{
      clearTimeout(timeout);
      if(code===0)return resolve();
      reject(new Error(`${name} failed${signal?` (${signal})`:''}: ${stderr.trim()||`exit ${code}`}`));
    });
  });
}
async function sha256(file){
  const hash=crypto.createHash('sha256');
  await new Promise((resolve,reject)=>{
    const stream=fs.createReadStream(file);stream.on('data',(chunk)=>hash.update(chunk));
    stream.on('error',reject);stream.on('end',resolve);
  });
  return hash.digest('hex');
}
async function tableNames(queryable){
  return (await queryable.query(`SELECT table_schema,table_name FROM information_schema.tables
    WHERE table_type='BASE TABLE' AND table_schema IN ('public','stockchief_runtime')
    ORDER BY table_schema,table_name`)).rows;
}
async function snapshot(queryable){
  const tables=await tableNames(queryable);const tableCounts={};
  for(const table of tables){
    const key=`${table.table_schema}.${table.table_name}`;
    tableCounts[key]=Number((await queryable.query(`SELECT COUNT(*) AS count FROM ${quote(table.table_schema)}.${quote(table.table_name)}`)).rows[0].count);
  }
  const has=(name)=>Object.hasOwn(tableCounts,`public.${name}`);
  const scalar=async(statement)=>Number((await queryable.query(statement)).rows[0].value||0);
  const critical={
    workspaces:has('workspaces')?tableCounts['public.workspaces']:0,
    skus:has('skus')?tableCounts['public.skus']:0,
    movements:has('movements')?tableCounts['public.movements']:0,
    onHand:has('balances')?await scalar('SELECT COALESCE(SUM(on_hand),0) AS value FROM balances'):0,
    movementDelta:has('movements')?await scalar('SELECT COALESCE(SUM(quantity_delta),0) AS value FROM movements'):0,
    journalDebits:has('accounting_journal_lines')?await scalar('SELECT COALESCE(SUM(debit_minor),0) AS value FROM accounting_journal_lines'):0,
    journalCredits:has('accounting_journal_lines')?await scalar('SELECT COALESCE(SUM(credit_minor),0) AS value FROM accounting_journal_lines'):0,
  };
  const migrations=Object.hasOwn(tableCounts,'public.stockchief_postgres_migrations')
    ?(await queryable.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows:[];
  const evidence={tableCounts,critical,migrations};
  return {...evidence,fingerprint:crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex')};
}
function backupName(now=new Date()){
  return `stockchief-postgres-${now.toISOString().replace(/[:.]/g,'-')}.dump`;
}
async function create(database,connectionString,options={}){
  const connection=safeAddress(connectionString);
  const directory=path.resolve(options.directory||path.join(process.cwd(),'data','postgres-backups'));
  fs.mkdirSync(directory,{recursive:true});
  const output=path.resolve(directory,options.name||backupName(options.now));
  if(path.dirname(output)!==directory)throw new Error('The backup filename must remain inside the configured backup directory.');
  if(fs.existsSync(output))throw new Error('That PostgreSQL backup file already exists.');
  let source;
  try{
    source=await database.transaction(async(client)=>{
      const snapshotId=(await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
      const evidence=await snapshot(client);
      await run('pg_dump',['--format=custom','--compress=6','--no-owner','--no-privileges',
        '--snapshot',snapshotId,'--file',output,connection.url],connection,options);
      return evidence;
    },{isolation:'REPEATABLE READ',readOnly:true,statementTimeoutMs:options.timeoutMs||15*60_000,lockTimeoutMs:30000});
    const manifest={version:1,engine:'postgresql',format:'pg_dump-custom',createdAt:(options.now||new Date()).toISOString(),
      source:{host:connection.host,port:connection.port,database:connection.database},file:path.basename(output),
      bytes:fs.statSync(output).size,sha256:await sha256(output),snapshot:source};
    const manifestPath=`${output}.manifest.json`;const temporary=`${manifestPath}.tmp`;
    fs.writeFileSync(temporary,`${JSON.stringify(manifest,null,2)}\n`,{mode:0o600});fs.renameSync(temporary,manifestPath);
    return {path:output,manifestPath,manifest};
  }catch(error){
    try{if(fs.existsSync(output))fs.unlinkSync(output);}catch{}
    throw error;
  }
}
async function restore(database,targetConnectionString,source,options={}){
  const backup=path.resolve(source);const manifestPath=`${backup}.manifest.json`;
  if(!fs.existsSync(backup)||!fs.existsSync(manifestPath))throw new Error('The backup and its manifest are both required.');
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  if(manifest.version!==1||manifest.engine!=='postgresql'||manifest.format!=='pg_dump-custom')throw new Error('Unsupported PostgreSQL backup manifest.');
  const digest=await sha256(backup);
  if(digest!==manifest.sha256)throw new Error('The PostgreSQL backup checksum does not match its manifest.');
  const target=safeAddress(targetConnectionString);
  const same=target.host===manifest.source.host&&target.port===manifest.source.port&&target.database===manifest.source.database;
  if(same)throw new Error('Restore verification requires a separate target database.');
  const existing=await tableNames(database);
  if(existing.length)throw new Error('The PostgreSQL restore target is not empty. Refusing to overwrite it.');
  await run('pg_restore',['--exit-on-error','--single-transaction','--no-owner','--no-privileges',
    '--dbname',target.url,backup],target,options);
  const restored=await snapshot(database);
  if(restored.fingerprint!==manifest.snapshot.fingerprint){
    throw new Error(`Restored PostgreSQL truth does not reconcile with the backup manifest (${restored.fingerprint} != ${manifest.snapshot.fingerprint}).`);
  }
  if(restored.critical.journalDebits!==restored.critical.journalCredits)throw new Error('Restored accounting journals are not balanced.');
  return {source:{path:backup,sha256:digest,bytes:manifest.bytes},manifest,restored};
}

module.exports={create,restore,snapshot,safeAddress,binary};

'use strict';

const express=require('express');
const session=require('express-session');
const {randomBytes}=require('node:crypto');
const signature=require('cookie-signature');
const {Pool}=require('pg');

// This function accepts only the private, ephemeral cluster returned by the
// test helper, never DATABASE_URL. RLS is added only inside that disposable DB.
async function inspectionDatabase(cluster,admin,ctx,stagingAuthorization=null){
  if(stagingAuthorization)require('../../src/assistant/postgres-codex-pilot').assertReadAuthorization(stagingAuthorization,cluster,ctx);
  else if(!cluster.directory||!require('node:path').basename(cluster.directory).startsWith('postgres-acceptance-'))
    throw new Error('Disposable fixture cluster required.');
  const connection=new URL(cluster.connectionString);
  if(!stagingAuthorization&&connection.hostname!=='127.0.0.1')throw new Error('Inspection must use the isolated local fixture.');
  const role=`demo_read_${randomBytes(8).toString('hex')}`;
  const password=randomBytes(32).toString('hex');
  // Discover only physical, non-dropped columns. information_schema.columns
  // expands type/privilege metadata we do not consume and is expensive on the
  // full application schema. This host-owned catalogue query changes no grant
  // or policy; views still require their separate security-invoker check.
  const tables=(await admin.query(`SELECT n.nspname::text AS table_schema,t.relname::text AS table_name,
    array_agg(a.attname::text ORDER BY a.attnum) AS columns
    FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname IN ('public','stockchief_runtime') AND t.relkind IN ('r','p')
    GROUP BY n.nspname,t.relname ORDER BY n.nspname,t.relname`)).rows;
  const accountId=(await admin.query('SELECT account_id FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0].account_id;
  const foreignKeys=(await admin.query(`SELECT n.nspname AS schema,c.relname AS child,pn.nspname AS parent_schema,p.relname AS parent,
   array_agg(a.attname::text ORDER BY k.ordinality) AS child_columns,array_agg(pa.attname::text ORDER BY k.ordinality) AS parent_columns
   FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_class p ON p.oid=f.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace
   CROSS JOIN LATERAL unnest(f.conkey,f.confkey) WITH ORDINALITY k(child_key,parent_key,ordinality)
   JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.child_key
   JOIN pg_attribute pa ON pa.attrelid=p.oid AND pa.attnum=k.parent_key
   WHERE f.contype='f' AND n.nspname IN ('public','stockchief_runtime')
   GROUP BY f.oid,n.nspname,c.relname,pn.nspname,p.relname`)).rows;
  const scopes=require('./inspection-scopes'),scopeView='stockchief_runtime.codex_pilot_workspace_access';
  const view=(await admin.query("SELECT c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='stockchief_runtime' AND c.relname='codex_pilot_workspace_access' AND c.relkind='v'")).rows[0];
  if(!view?.reloptions?.includes('security_invoker=true'))throw Error('UNSAFE_INSPECTION_ACCESS_VIEW');
  await scopes.ensure(admin,tables,foreignKeys);
  await scopes.createRole(admin,{role,password,ctx,accountId,kind:'read',scopeView,tables});
  connection.username=role;connection.password=password;
  const pool=new Pool({...require('../../src/db/postgres').connectionOptions(connection.toString(),{max:4,
    privateNetwork:process.env.FOUNDRY_DATABASE_PRIVATE_NETWORK==='true'}),min:4,idleTimeoutMillis:4*60000});
  const query=(sql,values=[])=>pool.query(sql,values);
  async function transaction(operation){const client=await pool.connect();
    try{await client.query('BEGIN READ ONLY');const result=await operation({query:(sql,values=[])=>client.query(sql,values)});
      await client.query('COMMIT');return result;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  let poolClosed=false,roleCleaned=false;
  return {query,transaction,renewLease:()=>scopes.renew(admin,role),close:async()=>{if(!poolClosed){await pool.end();poolClosed=true;}if(stagingAuthorization&&!roleCleaned){await scopes.drop(admin,[role]);roleCleaned=true;}},accountId,topology:{engine:'postgresql',shared:true,multiWriter:false}};
}

async function createInspectionServer({cluster,database,ctx,beforeRead=()=>{},stagingAuthorization=null}){
  const readonly=await inspectionDatabase(cluster,database,ctx,stagingAuthorization);
  const originalQuery=readonly.query,originalTransaction=readonly.transaction;
  readonly.query=async(sql,values)=>{beforeRead(sql);return originalQuery(sql,values);};
  readonly.transaction=operation=>originalTransaction(client=>operation({query:async(sql,values)=>{beforeRead(sql);return client.query(sql,values);}}));
  // Telemetry is a separate INSERT-only sink, never the application's business
  // handle. The renderer keeps SELECT-only rights and all GET writes still fail.
  const role=`demo_metrics_${randomBytes(8).toString('hex')}`;
  const password=randomBytes(32).toString('hex');
  try{await require('./inspection-scopes').createRole(database,{role,password,ctx,accountId:readonly.accountId,kind:'metrics'});}
  catch(error){await readonly.close().catch(()=>{});throw error;}
  const connection=new URL(cluster.connectionString);connection.username=role;connection.password=password;
  const telemetry=new Pool({...require('../../src/db/postgres').connectionOptions(connection.toString(),{max:2,
    privateNetwork:process.env.FOUNDRY_DATABASE_PRIVATE_NETWORK==='true'}),min:2,idleTimeoutMillis:4*60000});
  // Preparing the renderer alone left both TLS pools cold on the first page.
  // Open their existing bounded capacity before publishing the ready server.
  // No record, permission result or page content is cached by this warm-up.
  let telemetryClosed=false,telemetryRoleCleaned=false;
  const closeTelemetry=async()=>{if(!telemetryClosed){await telemetry.end();telemetryClosed=true;}if(stagingAuthorization&&!telemetryRoleCleaned){await require('./inspection-scopes').drop(database,[role]);telemetryRoleCleaned=true;}};
  try{await Promise.all([...Array.from({length:4},()=>readonly.query('SELECT 1')),
    ...Array.from({length:2},()=>telemetry.query('SELECT 1'))]);}
  catch(error){await Promise.allSettled([readonly.close(),closeTelemetry()]);throw error;}
  const telemetryErrors=[];const pendingTelemetry=new Set();
  const resourceDatabase={query(sql,values){const call=telemetry.query(sql,values).catch(error=>{
    telemetryErrors.push({code:error.code,message:error.message});throw error;});
    pendingTelemetry.add(call);call.finally(()=>pendingTelemetry.delete(call)).catch(()=>{});return call;}};
  const blockedProvider={name:'demo-offline',model:'none',async complete(){throw new Error('Browser cannot invoke a model.');}};
  const store=new session.MemoryStore();const sid=randomBytes(24).toString('hex');const secret=randomBytes(32).toString('hex');
  await new Promise((resolve,reject)=>store.set(sid,{accountId:readonly.accountId,workspaceId:ctx.workspaceId,
    cookie:{maxAge:3600000,httpOnly:true,sameSite:'lax'}},error=>error?reject(error):resolve()));
  const app=require('../../src/postgres-app').createPostgresApp({database:readonly,resourceDatabase,sessionStore:store,
    sessionSecret:secret,env:'test',aiProvider:blockedProvider,agentInspection:true,
    agentInspectionGuard:stagingAuthorization?(req,res,next)=>
      require('../../src/assistant/postgres-codex-pilot').access(database,ctx,{enabled:true}).then(()=>next(),next):null});
  const gate=express();
  gate.use((req,res,next)=>{
    if(!['GET','HEAD'].includes(req.method))return res.status(403).send('Use the governed business gateway.');
    // No browser cookies or authorization headers choose the actor or workspace.
    req.headers.cookie=`foundry.sid=${encodeURIComponent('s:'+signature.sign(sid,secret))}`;
    delete req.headers.authorization;
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'self'");
    next();
  });
  gate.use((req,res,next)=>require('./network-guard').restricted({databaseUrl:cluster.connectionString,stagingAuthorization,ctx},()=>app(req,res,next)));
  const server=await new Promise(resolve=>{const server=gate.listen(0,'127.0.0.1',()=>resolve(server));});
  return {origin:`http://127.0.0.1:${server.address().port}`,readonly,telemetryErrors,
    renewLease:async()=>{await readonly.renewLease();await require('./inspection-scopes').renew(database,role);},
    flushTelemetry:()=>Promise.allSettled([...pendingTelemetry]),
    async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
      const results=await Promise.allSettled([readonly.close(),closeTelemetry()]);
      const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;}};
}
module.exports={inspectionDatabase,createInspectionServer};

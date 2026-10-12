'use strict';

const express=require('express');
const session=require('express-session');
const {randomBytes}=require('node:crypto');
const signature=require('cookie-signature');
const {Pool,escapeIdentifier,escapeLiteral}=require('pg');

// This function accepts only the private, ephemeral cluster returned by the
// test helper, never DATABASE_URL. RLS is added only inside that disposable DB.
async function inspectionDatabase(cluster,admin,ctx,stagingAuthorization=null){
  if(stagingAuthorization)require('../../src/assistant/postgres-codex-pilot').assertReadAuthorization(stagingAuthorization,cluster,ctx);
  else if(!cluster.directory||!require('node:path').basename(cluster.directory).startsWith('postgres-acceptance-'))
    throw new Error('Disposable fixture cluster required.');
  const connection=new URL(cluster.connectionString);
  if(!stagingAuthorization&&connection.hostname!=='127.0.0.1')throw new Error('Inspection must use the isolated local fixture.');
  const role=`demo_read_${randomBytes(8).toString('hex')}`;
  const password=randomBytes(32).toString('hex');const identifier=escapeIdentifier(role);
  await admin.query(`CREATE ROLE ${identifier} LOGIN PASSWORD ${escapeLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  await admin.query(`ALTER ROLE ${identifier} SET default_transaction_read_only=on`);
  const tables=(await admin.query(`SELECT table_schema,table_name,array_agg(column_name::text) AS columns FROM information_schema.columns
    WHERE table_schema IN ('public','stockchief_runtime') GROUP BY table_schema,table_name`)).rows;
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
  const direct=table=>table.columns.includes('workspace_id')?`workspace_id=${escapeLiteral(ctx.workspaceId)}`:
   table.table_name==='workspaces'?`id=${escapeLiteral(ctx.workspaceId)}`:
   table.table_name==='accounts'?`id=${escapeLiteral(accountId)}`:
   table.columns.includes('account_id')?`account_id=${escapeLiteral(accountId)}`:null;
  await admin.query(`GRANT USAGE ON SCHEMA public,stockchief_runtime TO ${identifier}`);
  const guardedTables=[];
  for(const table of tables){
    const name=`${escapeIdentifier(table.table_schema)}.${escapeIdentifier(table.table_name)}`;
    // Owner-executed views can bypass underlying RLS. Never grant them merely
    // because metadata discovery found them; they need a reviewed safe boundary.
    const kind=(await admin.query('SELECT relkind FROM pg_class WHERE oid=$1::regclass',[name])).rows[0].relkind;
    if(!['r','p'].includes(kind))continue;
    guardedTables.push(table);
    // No ownership, sequence, INSERT, UPDATE, DELETE, CREATE or arbitrary SQL
    // interface is given to the renderer. Canonical gateway has its own handle.
    await admin.query(`GRANT SELECT ON ${name} TO ${identifier}`);
    let predicate=direct(table);
    if(!predicate){
     // Junction tables such as SKU option values inherit their parent's scope.
     const parents=foreignKeys.filter(f=>f.schema===table.table_schema&&f.child===table.table_name)
      .filter(f=>tables.some(p=>p.table_schema===f.parent_schema&&p.table_name===f.parent&&direct(p)));
     if(parents.length)predicate=parents.map(f=>`EXISTS (SELECT 1 FROM ${escapeIdentifier(f.parent_schema)}.${escapeIdentifier(f.parent)} parent
      WHERE ${f.child_columns.map((column,i)=>`parent.${escapeIdentifier(f.parent_columns[i])}=${name}.${escapeIdentifier(column)}`).join(' AND ')})`).join(' AND ');
     // Unscoped runtime/authentication storage is never part of UI evidence.
     else if(!new Set(['commercial_plans','commercial_plan_entitlements','commercial_plan_meters','commercial_capabilities',
      'commercial_meter_definitions','commercial_cost_rates','commercial_plan_versions','commercial_release_control',
      'commercial_usage_packs','commercial_operation_policies']).has(table.table_name))predicate='false';
    }
    if(predicate){
      await admin.query(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`);
      // Restrictive policy remains effective even if another permissive policy
      // exists. A separate permissive policy grants only this tenant's rows.
      await admin.query(`CREATE POLICY ${escapeIdentifier(role+'_allow')} ON ${name} FOR SELECT TO ${identifier} USING (${predicate})`);
      await admin.query(`CREATE POLICY ${escapeIdentifier(role+'_restrict')} ON ${name} AS RESTRICTIVE FOR SELECT TO ${identifier} USING (${predicate})`);
    }
  }
  connection.username=role;connection.password=password;
  const pool=new Pool(require('../../src/db/postgres').connectionOptions(connection.toString(),{max:4,
    privateNetwork:process.env.FOUNDRY_DATABASE_PRIVATE_NETWORK==='true'}));
  const query=(sql,values=[])=>pool.query(sql,values);
  async function transaction(operation){const client=await pool.connect();
    try{await client.query('BEGIN READ ONLY');const result=await operation({query:(sql,values=[])=>client.query(sql,values)});
      await client.query('COMMIT');return result;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  return {query,transaction,close:async()=>{await pool.end();if(stagingAuthorization){
    for(const table of guardedTables){const name=`${escapeIdentifier(table.table_schema)}.${escapeIdentifier(table.table_name)}`;
      await admin.query(`DROP POLICY IF EXISTS ${escapeIdentifier(role+'_allow')} ON ${name}`);
      await admin.query(`DROP POLICY IF EXISTS ${escapeIdentifier(role+'_restrict')} ON ${name}`);
      await admin.query(`REVOKE ALL PRIVILEGES ON ${name} FROM ${identifier}`);}
    await admin.query(`REVOKE USAGE ON SCHEMA public,stockchief_runtime FROM ${identifier}`);await admin.query(`DROP ROLE ${identifier}`);
  }},accountId,topology:{engine:'postgresql',shared:true,multiWriter:false}};
}

async function createInspectionServer({cluster,database,ctx,beforeRead=()=>{},stagingAuthorization=null}){
  const readonly=await inspectionDatabase(cluster,database,ctx,stagingAuthorization);
  const originalQuery=readonly.query,originalTransaction=readonly.transaction;
  readonly.query=async(sql,values)=>{beforeRead(sql);return originalQuery(sql,values);};
  readonly.transaction=operation=>originalTransaction(client=>operation({query:async(sql,values)=>{beforeRead(sql);return client.query(sql,values);}}));
  // Telemetry is a separate INSERT-only sink, never the application's business
  // handle. The renderer keeps SELECT-only rights and all GET writes still fail.
  const role=`demo_metrics_${randomBytes(8).toString('hex')}`;
  const password=randomBytes(32).toString('hex');const identifier=escapeIdentifier(role);
  await database.query(`CREATE ROLE ${identifier} LOGIN PASSWORD ${escapeLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  await database.query(`GRANT USAGE ON SCHEMA public TO ${identifier}`);
  await database.query(`GRANT INSERT ON commercial_resource_measurements TO ${identifier}`);
  await database.query(`GRANT SELECT(id) ON commercial_resource_measurements TO ${identifier}`);
  await database.query(`CREATE POLICY ${identifier} ON commercial_resource_measurements FOR INSERT TO ${identifier}
    WITH CHECK ((workspace_id=${escapeLiteral(ctx.workspaceId)} AND account_id=${escapeLiteral(readonly.accountId)})
      OR (workspace_id IS NULL AND (account_id IS NULL OR account_id=${escapeLiteral(readonly.accountId)})))`);
  await database.query(`CREATE POLICY ${escapeIdentifier(role+'_conflict')} ON commercial_resource_measurements FOR SELECT TO ${identifier}
    USING ((workspace_id=${escapeLiteral(ctx.workspaceId)} AND account_id=${escapeLiteral(readonly.accountId)})
      OR (workspace_id IS NULL AND (account_id IS NULL OR account_id=${escapeLiteral(readonly.accountId)})))`);
  const connection=new URL(cluster.connectionString);connection.username=role;connection.password=password;
  const telemetry=new Pool(require('../../src/db/postgres').connectionOptions(connection.toString(),{max:2,
    privateNetwork:process.env.FOUNDRY_DATABASE_PRIVATE_NETWORK==='true'}));
  const telemetryErrors=[];const pendingTelemetry=new Set();
  const resourceDatabase={query(sql,values){const call=telemetry.query(sql,values).catch(error=>{
    telemetryErrors.push({code:error.code,message:error.message});throw error;});
    pendingTelemetry.add(call);call.finally(()=>pendingTelemetry.delete(call)).catch(()=>{});return call;}};
  const blockedProvider={name:'demo-offline',model:'none',async complete(){throw new Error('Browser cannot invoke a model.');}};
  const store=new session.MemoryStore();const sid=randomBytes(24).toString('hex');const secret=randomBytes(32).toString('hex');
  await new Promise((resolve,reject)=>store.set(sid,{accountId:readonly.accountId,workspaceId:ctx.workspaceId,
    cookie:{maxAge:3600000,httpOnly:true,sameSite:'lax'}},error=>error?reject(error):resolve()));
  const app=require('../../src/postgres-app').createPostgresApp({database:readonly,resourceDatabase,sessionStore:store,
    sessionSecret:secret,env:'test',aiProvider:blockedProvider,agentInspection:true});
  const gate=express();
  gate.use((req,res,next)=>{
    if(!['GET','HEAD'].includes(req.method))return res.status(403).send('Use the governed business gateway.');
    // No browser cookies or authorization headers choose the actor or workspace.
    req.headers.cookie=`foundry.sid=${encodeURIComponent('s:'+signature.sign(sid,secret))}`;
    delete req.headers.authorization;
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'self'");
    if(stagingAuthorization)require('../../src/assistant/postgres-codex-pilot').access(database,ctx,{enabled:true}).then(()=>next(),next);
    else next();
  });
  gate.use((req,res,next)=>require('./network-guard').restricted({databaseUrl:cluster.connectionString,stagingAuthorization,ctx},()=>app(req,res,next)));
  const server=await new Promise(resolve=>{const server=gate.listen(0,'127.0.0.1',()=>resolve(server));});
  return {origin:`http://127.0.0.1:${server.address().port}`,readonly,telemetryErrors,
    flushTelemetry:()=>Promise.allSettled([...pendingTelemetry]),
    async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await telemetry.end();await readonly.close();
      if(stagingAuthorization){await database.query(`DROP POLICY IF EXISTS ${identifier} ON commercial_resource_measurements`);
        await database.query(`DROP POLICY IF EXISTS ${escapeIdentifier(role+'_conflict')} ON commercial_resource_measurements`);
        await database.query(`REVOKE SELECT(id) ON commercial_resource_measurements FROM ${identifier}`);
        await database.query(`REVOKE ALL PRIVILEGES ON commercial_resource_measurements FROM ${identifier}`);
        await database.query(`REVOKE USAGE ON SCHEMA public FROM ${identifier}`);await database.query(`DROP ROLE ${identifier}`);}}};
}
module.exports={inspectionDatabase,createInspectionServer};

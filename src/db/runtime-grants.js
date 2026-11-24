'use strict';
// The website and worker can connect as a login that reads and writes business records
// but cannot change the database's structure. Migrations run as the owner; after each
// run this grants the website login exactly what the running app needs, on every table,
// sequence and function the owner has in its schemas, including ones a migration just added:
// - read, add, change and remove rows;
// - MAINTAIN (PostgreSQL 17) so the statistics refresh after a large import still runs;
// - temporary tables, used by bulk copies;
// - never CREATE on the database or a schema, and never ownership.
const NAME=/^[a-z_][a-z0-9_]{0,62}$/;
const quote=name=>'"'+name.replaceAll('"','""')+'"';

async function grant(database,role){
  if(!NAME.test(String(role||'')))throw new Error('Name the website database login in lower case.');
  return database.transaction(async client=>{
    const me=(await client.query('SELECT current_user AS name,current_database() AS database,current_setting(\'server_version_num\')::int AS version')).rows[0];
    if(me.name===role)throw new Error('The website login must differ from the migration owner.');
    const target=(await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=$1',[role])).rows[0];
    if(!target)throw new Error('The website database login does not exist yet.');
    if(target.rolsuper||target.rolcreatedb||target.rolcreaterole||target.rolbypassrls)throw new Error('The website database login must not be able to create databases, roles or bypass row security.');
    // Schemas holding objects this owner created (public, stockchief_runtime and any later one).
    const schemas=(await client.query(`SELECT DISTINCT n.nspname AS name FROM pg_namespace n JOIN pg_class c ON c.relnamespace=n.oid
      WHERE c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND c.relkind IN ('r','p','S','v','m')
        AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%' ORDER BY 1`)).rows.map(r=>r.name);
    const tableRights='SELECT,INSERT,UPDATE,DELETE'+(me.version>=170000?',MAINTAIN':'');
    const r=quote(role);
    await client.query(`GRANT CONNECT,TEMPORARY ON DATABASE ${quote(me.database)} TO ${r}`);
    for(const schema of schemas){const s=quote(schema);
      await client.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
      await client.query(`GRANT ${tableRights} ON ALL TABLES IN SCHEMA ${s} TO ${r}`);
      await client.query(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA ${s} TO ${r}`);
      await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${s} TO ${r}`);
      // Objects a later migration creates are granted the moment they exist.
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT ${tableRights} ON TABLES TO ${r}`);
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT USAGE,SELECT,UPDATE ON SEQUENCES TO ${r}`);
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT EXECUTE ON FUNCTIONS TO ${r}`);
    }
    return {role,database:me.database,schemas,maintain:me.version>=170000};
  },{isolation:'READ COMMITTED',statementTimeoutMs:120000,lockTimeoutMs:30000});
}

module.exports={grant};

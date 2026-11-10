'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('RFQ upgrade adds only its migration and preserves all prior QC migration statements', {timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});const migrate=require('../../src/db/migrate-postgres').migratePostgres;
 await migrate(db,{through:'304-payment-link-indexes.sql'});const before=(await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows;await migrate(db,{through:'305-agent-supplier-rfqs.sql'});const after=(await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows;
 assert.equal(after.length,before.length+1);assert.deepEqual(after.filter(r=>r.name!=='305-agent-supplier-rfqs.sql'),before);assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_rfq_requests')).rows[0].n,0);await migrate(db,{through:'305-agent-supplier-rfqs.sql'});assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_postgres_migrations')).rows[0].n,after.length);
});

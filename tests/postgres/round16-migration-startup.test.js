'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('a second service waits for the migration owner beyond the normal runtime lock timeout',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),db=f.db;const migrationCount=(await db.query('SELECT count(*)::int n FROM stockchief_postgres_migrations')).rows[0].n;let locked;const ready=new Promise(r=>locked=r);
 const holder=db.transaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(741923609)');locked();await new Promise(r=>setTimeout(r,11000));},{statementTimeoutMs:15000});await ready;
 const start=Date.now(),applied=await require('../../src/db/migrate-postgres').migratePostgres(db);await holder;assert.deepEqual(applied,[]);assert(Date.now()-start>=10500,'A joining service waits for the existing migration instead of failing after ten seconds');
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_postgres_migrations')).rows[0].n,migrationCount);
});

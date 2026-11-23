'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startCluster } = require('../helpers/postgres-cluster');
const { openPostgres } = require('../../src/db/postgres');
const rows = require('../../src/imports/postgres-row-store');

test('COPY and batched INSERT preserve identical scoped import evidence; failure rolls back every staged row', async t => {
  const cluster = await startCluster();
  const db = openPostgres(cluster.connectionString);
  t.after(async () => { await db.close(); await cluster.stop(); });
  await db.query(`CREATE TABLE import_rows(id text PRIMARY KEY, import_id text, workspace_id text,
    row_number bigint, raw jsonb, parsed jsonb, status text, problems jsonb,
    location_id text, quantity numeric, created_at text)`);
  const source = Array.from({length:2000}, (_,i) => ({id:'row-'+i, rowNumber:i+2,
    raw:['Coffee, "Dark"\n250g', '\\N', 'Unicode café'], parsed:{quantity:i%2?3.75:0, locationId:i%3?'warehouse':null},
    status:'VALID', problems:[]}));
  const at = '2026-11-23T00:00:00.000Z';
  await db.transaction(c => rows.insert(c,'wsp_copy','imp_insert',source,at), {isolation:'READ COMMITTED'});
  const original = (await db.query('SELECT * FROM import_rows ORDER BY row_number')).rows;
  await db.query('TRUNCATE import_rows');
  const previous = process.env.STOCKCHIEF_IMPORT_COPY;
  process.env.STOCKCHIEF_IMPORT_COPY='true';
  t.after(() => { if(previous===undefined)delete process.env.STOCKCHIEF_IMPORT_COPY; else process.env.STOCKCHIEF_IMPORT_COPY=previous; });
  await db.transaction(c => rows.insert(c,'wsp_copy','imp_insert',source,at), {isolation:'READ COMMITTED'});
  assert.deepEqual((await db.query('SELECT * FROM import_rows ORDER BY row_number')).rows, original);
  await assert.rejects(db.transaction(async c => {
    await rows.insert(c,'wsp_other','imp_other',source.map(r=>({...r,id:'other-'+r.id})),at);
    throw new Error('simulated lost lease before commit');
  }, {isolation:'READ COMMITTED'}), /lost lease/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM import_rows WHERE workspace_id='wsp_other'")).rows[0].n,0);
  // A reused pooled connection must not retain temporary staging records.
  await db.transaction(c=>rows.insert(c,'wsp_other','imp_other',source.map(r=>({...r,id:'other-'+r.id})),at), {isolation:'READ COMMITTED'});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM import_rows')).rows[0].n,4000);
});

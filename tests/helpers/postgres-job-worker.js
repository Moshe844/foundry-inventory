'use strict';

if (process.env.NODE_ENV !== 'test' || !process.env.STOCKCHIEF_TEST_POSTGRES_URL) throw new Error('An isolated PostgreSQL test connection is required.');
const { openPostgres } = require('../../src/db/postgres');
const jobs = require('../../src/operations/postgres-job-queue');
const database = openPostgres(process.env.STOCKCHIEF_TEST_POSTGRES_URL);

async function run() {
  const job = await jobs.processOne(database, {
    'qualification.effect': async (claimed, client) => {
      await client.query('INSERT INTO qualification_effects(job_id) VALUES ($1)', [claimed.id]);
      return { recorded: true };
    },
  }, { owner: `process:${process.pid}` });
  if (process.send) process.send({ id: job?.id || null, status: job?.status || null });
}

run().then(async () => { await database.close(); process.exit(0); }, async (error) => {
  console.error(error.code || 'qualification_worker_error');
  await database.close();
  process.exit(1);
});

'use strict';

const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { from } = require('pg-copy-streams');

// The transaction owns the connection and its rollback boundary. Never obtain
// a second pooled connection for COPY: that would escape the caller's locks.
async function copyFrom(client, statement, chunks) {
  if (typeof statement !== 'string' || !/^COPY pg_temp\.[a-z_]+ \([a-z_, ]+\) FROM STDIN WITH \(FORMAT csv, NULL '\\N'\)$/.test(statement)) {
    throw new TypeError('COPY accepts only an explicitly named temporary staging table.');
  }
  await pipeline(Readable.from(chunks), client.query(from(statement)));
}

module.exports = { copyFrom };

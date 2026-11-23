'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cell, encode } = require('../../src/imports/postgres-copy-rows');
const { copyFrom } = require('../../src/db/postgres-copy');

test('COPY escapes source cells without changing null, zero or fractional quantities', async () => {
  assert.equal(cell(null), '\\N');
  assert.equal(cell('\\N'), '"\\N"');
  assert.equal(cell('a,"b"\nc'), '"a,""b""\nc"');
  const chunks = [];
  for await (const chunk of encode([{ id:'r', rowNumber:2, raw:['a\nb'], parsed:{quantity:3.75}, status:'VALID', problems:[] }])) chunks.push(chunk);
  assert.match(chunks.join(''), /"3.75"\n$/);
  assert.match(chunks.join(''), /\\N,"3.75"/);
});

test('COPY cannot target live inventory tables or accept compound SQL', async () => {
  const client = { query() { throw new Error('must not execute'); } };
  await assert.rejects(copyFrom(client, 'COPY balances FROM STDIN', []), /temporary staging table/);
  await assert.rejects(copyFrom(client, "COPY pg_temp.input (id) FROM STDIN WITH (FORMAT csv, NULL '\\N'); DELETE FROM balances", []), /temporary staging table/);
});

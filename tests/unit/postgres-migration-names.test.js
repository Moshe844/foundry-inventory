'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

// The migration runner only applies files named NNN-lowercase-words.sql (or .js) and
// skips any other name without a word. A digit in the words ("517-3pl-orders.sql")
// would silently never run, so every file in the folder must match.
test('every file in the PostgreSQL migrations folder has a name the runner applies',()=>{
  const dir=path.join(__dirname,'../../src/db/postgres-migrations');
  const runner=fs.readFileSync(path.join(__dirname,'../../src/db/migrate-postgres.js'),'utf8');
  assert.match(runner,/\/\^\\d\{3\}-\[a-z-\]\+\\\.\(\?:sql\|js\)\$\//,'The runner still uses the name pattern this test checks');
  const skipped=fs.readdirSync(dir).filter(name=>!/^\d{3}-[a-z-]+\.(?:sql|js)$/.test(name));
  assert.deepEqual(skipped,[],'These files would never be applied');
});

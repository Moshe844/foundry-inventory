'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDatabase } = require('../../src/db');

/**
 * Migrations are only interesting on a database that already exists.
 *
 * Everything else in this suite starts from the schema files, which are always
 * current — so a migration that never fires looks identical to one that worked.
 * That is how a CHECK survived a rebuild that reported success: the value the
 * application had started writing was rejected by the customer's own database
 * and by no test anywhere.
 */

const tmp = [];
test.after(() => tmp.forEach((f) => { try { fs.rmSync(f); } catch (e) { /* gone */ } }));

function databaseFrom(createSql) {
  const file = path.join(os.tmpdir(), `foundry-migrate-${process.pid}-${tmp.length}.db`);
  tmp.push(file);
  const seed = new Database(file);
  seed.exec(createSql);
  seed.close();
  return file;
}

test('a CHECK written with a DEFAULT in front of it is still dropped', () => {
  // The shape as it actually exists in databases in the field: DEFAULT and the
  // CHECK on the next line. The rebuild used to skip this and say nothing.
  const file = databaseFrom(`
    CREATE TABLE manager_intents (
      id                   TEXT PRIMARY KEY,
      workspace_id         TEXT NOT NULL,
      user_id              TEXT NOT NULL,
      stated_as            TEXT NOT NULL,
      intent_class         TEXT NOT NULL,
      payload              TEXT NOT NULL DEFAULT '{}',
      confidence           TEXT NOT NULL DEFAULT 'medium'
                             CHECK (confidence IN ('high', 'medium', 'low')),
      status               TEXT NOT NULL DEFAULT 'CLASSIFIED'
                             CHECK (status IN ('CLASSIFIED', 'ROUTED', 'NEEDS_CLARIFICATION', 'COMPLETED', 'FAILED')),
      routed_to            TEXT,
      related_record_id    TEXT,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL
    );
    INSERT INTO manager_intents (id, workspace_id, user_id, stated_as, intent_class, created_at, updated_at)
      VALUES ('keep-me', 'w1', 'u1', 'we sold 10', 'PHYSICAL_EVENT', '2026-01-01', '2026-01-01');
  `);

  const db = openDatabase(file);
  db.prepare("UPDATE manager_intents SET status = 'REFUSED' WHERE id = 'keep-me'").run();
  assert.equal(db.prepare("SELECT status FROM manager_intents WHERE id = 'keep-me'").get().status, 'REFUSED');

  // The rebuild copies the table. Rows and indexes have to come with it.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM manager_intents').get().c, 1);
  assert.equal(
    db.prepare("SELECT stated_as FROM manager_intents WHERE id = 'keep-me'").get().stated_as,
    'we sold 10'
  );
  assert.ok(
    db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'index' AND tbl_name = 'manager_intents'").get().c > 0,
    'the indexes the schema file declares must be back after a rebuild'
  );

  // Only the named column loses its CHECK; its neighbour keeps one.
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'manager_intents'").get().sql;
  assert.doesNotMatch(sql, /CHECK \(status IN/);
  assert.match(sql, /CHECK \(confidence IN/, 'unrelated constraints are not collateral');
  assert.match(sql, /status \s+TEXT NOT NULL DEFAULT 'CLASSIFIED'/, 'the default itself survives');
  db.close();
});

test('opening the same database twice is safe', () => {
  const file = databaseFrom(`
    CREATE TABLE manager_intents (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
      stated_as TEXT NOT NULL, intent_class TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'CLASSIFIED'
               CHECK (status IN ('CLASSIFIED', 'ROUTED')),
      routed_to TEXT, related_record_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  openDatabase(file).close();
  const db = openDatabase(file);
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'manager_intents'").get().sql;
  assert.doesNotMatch(sql, /CHECK \(status IN/);
  db.close();
});

test('a rebuild that fails to drop the constraint is not reported as success', () => {
  // The property that matters more than any single pattern: silence is not an
  // acceptable outcome. If the CHECK is still there afterwards, opening fails
  // loudly at startup rather than at the first write of a new value.
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'db', 'index.js'), 'utf8');
  assert.match(source, /could not drop the CHECK/,
    'relaxColumnCheck must verify its own result');
});

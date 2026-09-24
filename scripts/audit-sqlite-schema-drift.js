'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const { openDatabase } = require('../src/db');

const sourcePath = path.resolve(process.argv[2] || 'data/foundry-inventory.db');
const live = new Database(sourcePath, { readonly: true, fileMustExist: true });
const fresh = openDatabase(':memory:');

function quote(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

try {
  const tables = live.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name NOT LIKE 'search_documents_fts%' AND name<>'sqlite_sequence' ORDER BY name`).all();
  const absentTables = [];
  const sourceOnlyColumns = [];
  const freshOnlyColumns = [];
  const blobColumns = [];
  for (const { name } of tables) {
    if (!fresh.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name)) {
      absentTables.push(name);
      continue;
    }
    const liveInfo = live.prepare(`PRAGMA table_xinfo(${quote(name)})`).all();
    const liveColumns = new Set(liveInfo.map((column) => column.name));
    const freshColumns = new Set(fresh.prepare(`PRAGMA table_xinfo(${quote(name)})`).all().map((column) => column.name));
    for (const column of liveColumns) if (!freshColumns.has(column)) sourceOnlyColumns.push(`${name}.${column}`);
    for (const column of freshColumns) if (!liveColumns.has(column)) freshOnlyColumns.push(`${name}.${column}`);
    for (const column of liveInfo.filter((entry) => String(entry.type).toUpperCase() === 'BLOB')) {
      const size = live.prepare(`SELECT COUNT(${quote(column.name)}) AS rows,
        COALESCE(MAX(length(${quote(column.name)})),0) AS maximum,
        COALESCE(SUM(length(${quote(column.name)})),0) AS total FROM ${quote(name)}`).get();
      blobColumns.push({ table: name, column: column.name, rows: Number(size.rows),
        maximumBytes: Number(size.maximum), totalBytes: Number(size.total) });
    }
  }
  process.stdout.write(`${JSON.stringify({ absentTables, sourceOnlyColumns, freshOnlyColumns, blobColumns }, null, 2)}\n`);
} finally {
  fresh.close();
  live.close();
}

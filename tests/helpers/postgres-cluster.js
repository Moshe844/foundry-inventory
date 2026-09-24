'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

async function startCluster() {
  const root = path.resolve(__dirname, '../../data');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'postgres-acceptance-'));
  const password = crypto.randomBytes(24).toString('hex');
  const passwordFile = path.join(directory, 'fixture-password');
  fs.writeFileSync(passwordFile, password, { mode: 0o600 });
  const data = path.join(directory, 'cluster');
  const bin = process.env.STOCKCHIEF_POSTGRES_BIN || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/17/bin' : '');
  const run = (command, args) => execFileSync(path.join(bin, `${command}${process.platform === 'win32' ? '.exe' : ''}`), args,
    { windowsHide: true, timeout: command === 'pg_ctl' ? 210000 : 120000,
      stdio: command === 'pg_ctl' ? 'ignore' : 'pipe' });
  const cleanup = () => {
    const resolved = fs.realpathSync(directory);
    if (!resolved.startsWith(`${fs.realpathSync(root)}${path.sep}postgres-acceptance-`)) throw new Error('Unsafe PostgreSQL fixture cleanup path.');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  };
  try {
  run('initdb', ['-D', data, '--username=stockchief_fixture', `--pwfile=${passwordFile}`,
    '--auth=scram-sha-256', '--encoding=UTF8', '--no-locale']);
  fs.unlinkSync(passwordFile);
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  run('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', '-t', '30',
    '-o', `-h 127.0.0.1 -p ${port}`, 'start']);
  let stopped = false;
  return { directory, connectionString: `postgresql://stockchief_fixture:${password}@127.0.0.1:${port}/postgres?sslmode=disable`,
    stop: () => {
      if (stopped) return;
      run('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '180', 'stop']);
      stopped = true;
      cleanup();
    } };
  } catch (error) {
    if (fs.existsSync(path.join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '180', 'stop']);
    cleanup();
    throw error;
  }
}

async function copyFixtureTables(sqlite, postgres, tables) {
  for (const table of tables) {
    if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid fixture table name.');
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.length) throw new Error(`Missing fixture table ${table}.`);
    const quote = (name) => `"${name.replaceAll('"', '""')}"`;
    const definitions = columns.map((column) => `${quote(column.name)} ${column.type === 'INTEGER' ? 'BIGINT' : column.type === 'REAL' ? 'DOUBLE PRECISION' : column.type === 'BLOB' ? 'BYTEA' : 'TEXT'}`);
    const keys = columns.filter((column) => column.pk).sort((first, second) => first.pk - second.pk);
    if (keys.length) definitions.push(`PRIMARY KEY (${keys.map((column) => quote(column.name)).join(',')})`);
    await postgres.query(`CREATE TABLE ${quote(table)} (${definitions.join(',')})`);
    await postgres.transaction(async (client) => {
      for (const row of sqlite.prepare(`SELECT * FROM ${table}`).all()) {
        await client.query(`INSERT INTO ${quote(table)} (${columns.map((column) => quote(column.name)).join(',')}) VALUES (${columns.map((column, index) => `$${index + 1}`).join(',')})`,
          columns.map((column) => row[column.name]));
      }
    });
  }
}

module.exports = { startCluster, copyFixtureTables };

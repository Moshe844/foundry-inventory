'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../../src/db');
const { createApp } = require('../../src/app');

if (process.env.NODE_ENV !== 'test') throw new Error('This server is only for disposable frontend acceptance.');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stockchief-entry-ui-'));
const db = openDatabase(path.join(directory, 'acceptance.db'));
require('../../src/domain/auth-service').createAccount(db, {
  name: 'Legacy Owner', email: 'legacy-empty@example.test', password: 'disposable-legacy-password',
});
const app = createApp({ db, env: 'test', sessionSecret: 'disposable-entry-ui-secret' });
const server = app.listen(0, '127.0.0.1', () => {
  if (process.send) process.send({ port: server.address().port });
  else console.log(`Frontend acceptance: http://127.0.0.1:${server.address().port}`);
});
async function shutdown() {
  await new Promise((resolve) => server.close(resolve));
  if (app.locals.sessionStore && app.locals.sessionStore.close) await app.locals.sessionStore.close();
  db.close();
  const resolvedDirectory = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(resolvedDirectory) !== tempRoot || !path.basename(resolvedDirectory).startsWith('stockchief-entry-ui-')) {
    throw new Error('Refusing to remove a directory outside this disposable acceptance fixture.');
  }
  fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  process.exit(0);
}
process.on('message', (message) => { if (message.type === 'shutdown') shutdown(); });
process.on('SIGINT', shutdown);

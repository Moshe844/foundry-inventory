'use strict';

const { makeDatabase, cleanupAll } = require('../helpers');
const { createApp } = require('../../src/app');
if (process.env.NODE_ENV !== 'test') throw new Error('Disposable browser acceptance only.');
const { db } = makeDatabase();
const fixture = require('./autonomy-entry-fixture').seed(db);
const connectedFixture = require('./autonomy-entry-fixture').seed(db, { workspaceName: 'Connected authority UI fixture', email: 'connected-authority-owner@example.test' });
require('./autonomy-entry-fixture').seedConnectedAuthority(db, connectedFixture);
const app = createApp({ db, env: 'test', sessionSecret: 'disposable-autonomy-browser-secret' });
const dailyDigest = require('../../src/autopilot/daily');
dailyDigest.generate(db, fixture.workspace.workspaceId);
const digestTimer = setInterval(() => dailyDigest.generate(db, fixture.workspace.workspaceId), 1000);
const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port, saturday: fixture.saturday, sunday: fixture.sunday }));
async function shutdown() {
  clearInterval(digestTimer);
  await new Promise((resolve) => server.close(resolve));
  if (app.locals.sessionStore?.close) await app.locals.sessionStore.close();
  cleanupAll();
  process.exit(0);
}
process.on('message', (message) => { if (message.type === 'shutdown') shutdown(); });

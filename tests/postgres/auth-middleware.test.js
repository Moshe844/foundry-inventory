'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startCluster } = require('../helpers/postgres-cluster');
const { openPostgres } = require('../../src/db/postgres');
const { migratePostgres } = require('../../src/db/migrate-postgres');
const auth = require('../../src/domain/postgres-auth-service');
const middleware = require('../../src/web/postgres-auth-middleware');

function invoke(handler, req) {
  const res = { locals:{} };
  return new Promise((resolve, reject) => handler(req,res,(error) => error ? reject(error) : resolve({ req,res })));
}

test('PostgreSQL request identity falls back safely and never trusts a tenant id from the session',
  { timeout:120000 }, async (context) => {
    const cluster = await startCluster();
    const database = openPostgres(cluster.connectionString, { applicationName:'stockchief-auth-middleware-test' });
    context.after(async () => { await database.close(); cluster.stop(); });
    await migratePostgres(database);
    const first = await auth.createBusiness(database, {
      name:'First Owner',businessName:'First Inventory',email:'first@example.test',password:'first-password',
    });
    const second = await auth.createBusiness(database, {
      name:'Second Owner',businessName:'Second Inventory',email:'second@example.test',password:'second-password',
    });

    const loaded = await invoke(middleware.loadUser(database), {
      session:{ accountId:first.accountId,workspaceId:second.workspaceId },
    });
    assert.equal(loaded.req.ctx.accountId, first.accountId);
    assert.equal(loaded.req.ctx.workspaceId, first.workspaceId);
    assert.equal(loaded.req.session.workspaceId, first.workspaceId);
    assert.equal(loaded.res.locals.workspaces.length, 1);
    assert.equal(loaded.res.locals.workspaces[0].name, 'First Inventory');

    let destroyed = false;
    const missing = await invoke(middleware.loadUser(database), {
      session:{ accountId:'missing-account',destroy(callback) { destroyed=true; callback(); } },
    });
    assert.equal(destroyed, true);
    assert.equal(missing.req.user, undefined);
    assert.equal(missing.res.locals.currentUser, null);
  });

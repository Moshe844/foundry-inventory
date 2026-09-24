'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startCluster } = require('../helpers/postgres-cluster');
const { openPostgres } = require('../../src/db/postgres');
const { migratePostgres } = require('../../src/db/migrate-postgres');
const auth = require('../../src/domain/postgres-auth-service');
const { DEFAULT_ACCOUNTS } = require('../../src/accounting/chart');

test('PostgreSQL authentication creates and resolves one fully configured tenant atomically',
  { timeout:120000 }, async (context) => {
    const cluster = await startCluster();
    const database = openPostgres(cluster.connectionString, { applicationName:'stockchief-auth-test' });
    context.after(async () => { await database.close(); cluster.stop(); });
    await migratePostgres(database);

    const created = await auth.createBusiness(database, {
      name:'Database Owner',businessName:'Postgres Supply',email:'Owner@Example.Test',
      password:'strong-password-2026',now:'2026-09-23T12:00:00.000Z',
    });
    assert.equal(created.email, 'owner@example.test');
    assert.equal((await auth.authenticate(database, 'OWNER@example.test', 'strong-password-2026')).id,
      created.accountId);
    assert.equal(await auth.authenticate(database, 'owner@example.test', 'wrong-password'), null);
    assert.equal(await auth.authenticate(database, 'missing@example.test', 'wrong-password'), null);

    const resolved = await auth.resolveForAccount(database, created.accountId, created.workspaceId);
    assert.equal(resolved.workspace.name, 'Postgres Supply');
    assert.equal(resolved.membership.role, 'owner');
    assert.equal(await auth.defaultWorkspaceFor(database, created.accountId), created.workspaceId);
    const workspaces = await auth.listWorkspacesForAccount(database, created.accountId);
    assert.deepEqual(workspaces.map((row) => ({ id:row.id,items:Number(row.item_count),units:Number(row.units_on_hand) })),
      [{ id:created.workspaceId,items:0,units:0 }]);

    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM accounting_accounts
      WHERE workspace_id=$1`, [created.workspaceId])).rows[0].count, String(DEFAULT_ACCOUNTS.length));
    assert.equal((await database.query(`SELECT enabled FROM accounting_settings
      WHERE workspace_id=$1`, [created.workspaceId])).rows[0].enabled, '1');

    await assert.rejects(auth.createBusiness(database, {
      name:'Duplicate',businessName:'Must Roll Back',email:'owner@example.test',password:'another-password',
    }), /already uses/i);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM workspaces
      WHERE name='Must Roll Back'`)).rows[0].count, '0');

    const other = await auth.createBusiness(database, {
      name:'Other Owner',businessName:'Other Business',email:'other@example.test',password:'other-password',
    });
    await assert.rejects(auth.rememberWorkspace(database, other.accountId, created.workspaceId), /could not be found/i);
    assert.equal(await auth.rememberWorkspace(database, created.accountId, created.workspaceId), created.workspaceId);
  });

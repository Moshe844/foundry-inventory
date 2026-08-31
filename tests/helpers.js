'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const authService = require('../src/domain/auth-service');
const locationService = require('../src/domain/location-service');
const itemService = require('../src/domain/item-service');
const repo = require('../src/domain/repository');
const workspaceService = require('../src/domain/workspace-service');

const tempRoots = [];

/** A throwaway database on disk (not in memory: restarts must be testable). */
function makeDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-test-'));
  const databasePath = path.join(dir, 'test.db');
  const db = openDatabase(databasePath);
  // The handle is kept with the directory so cleanup can close it. Without
  // that, Windows refuses to delete a database SQLite still has open.
  tempRoots.push({ dir, db });
  return { db, databasePath, dir };
}

function makeApp(existing) {
  const store = existing || makeDatabase();
  const app = createApp({
    db: store.db,
    env: 'test',
    sessionSecret: crypto.randomBytes(16).toString('hex'),
  });
  return { ...store, app };
}

/**
 * Removes every throwaway database this file created.
 *
 * This used to delete the directory and swallow whatever went wrong, on the
 * belief that "the OS will clean temp up". Windows does not clean %TEMP% up,
 * and the delete was not failing occasionally — it was failing whenever the
 * test had not closed its database, because Windows will not unlink a file
 * SQLite still holds open. Every such run left a directory behind for good.
 *
 * That went unnoticed because it is silent and each one is only a couple of
 * megabytes. It was found when the disk filled: 42,557 directories, 82 GB, and
 * a test run failing with ENOSPC in places that had nothing to do with the
 * change being tested.
 *
 * So the handle is closed first, and a failure to remove is reported rather
 * than hidden. A test suite that quietly loses two megabytes per run is a test
 * suite that will eventually stop the machine it runs on.
 */
function cleanupAll() {
  const stubborn = [];
  for (const entry of tempRoots.splice(0)) {
    const { dir, db } = entry;
    try {
      if (db && db.open) db.close();
    } catch {
      /* Already closed by the test itself, which is the tidy case. */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (err) {
      stubborn.push(`${dir}: ${err.code || err.message}`);
    }
  }
  if (stubborn.length) {
    console.error(`[tests] could not remove ${stubborn.length} temp database(s):\n  ${stubborn.join('\n  ')}`);
  }
}

let workspaceCounter = 0;

/** Creates a workspace with an owner, a staff member and two locations. */
function seedWorkspace(db, overrides = {}) {
  workspaceCounter += 1;
  const suffix = `${workspaceCounter}-${crypto.randomBytes(3).toString('hex')}`;
  const account = {
    workspaceName: overrides.workspaceName || `Test Inventory ${suffix}`,
    name: overrides.name || 'Olive Owner',
    email: overrides.email || `owner-${suffix}@example.test`,
    password: overrides.password || 'password123',
  };
  const { workspaceId, userId, accountId } = authService.registerAccount(db, account);
  const ctx = { workspaceId, actorId: userId, accountId };

  const staffEmail = overrides.staffEmail || `staff-${suffix}@example.test`;
  const staff = authService.createTeamMember(db, ctx, { role: 'owner' }, {
    name: 'Sid Staff',
    email: staffEmail,
    password: 'password123',
    role: 'staff',
  });

  const main = locationService.createLocation(db, ctx, { name: 'Main Warehouse', kind: 'warehouse' });
  const store = locationService.createLocation(db, ctx, { name: 'Downtown Store', kind: 'store' });

  return { workspaceId, accountId, ownerId: userId, staffId: staff.id, staffEmail, ctx, account, main, store };
}

/** A second (third, fourth…) inventory owned by an existing account. */
function seedAnotherWorkspace(db, accountId, name) {
  workspaceCounter += 1;
  const created = workspaceService.createWorkspace(db, accountId, name || `Another Inventory ${workspaceCounter}`);
  const ctx = { workspaceId: created.workspaceId, actorId: created.userId, accountId };
  const main = locationService.createLocation(db, ctx, { name: 'Main Warehouse', kind: 'warehouse' });
  const store = locationService.createLocation(db, ctx, { name: 'Downtown Store', kind: 'store' });
  return { workspaceId: created.workspaceId, accountId, ownerId: created.userId, ctx, main, store, name: created.name };
}

function makeQuantityItem(db, ctx, overrides = {}) {
  const created = itemService.createItem(db, ctx, {
    name: 'Copper Elbow',
    baseCode: `CE-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    trackingMode: 'quantity',
    ...overrides,
  });
  const sku = repo.listSkusForItem(db, ctx.workspaceId, created.itemId)[0];
  return { itemId: created.itemId, skuId: sku.id, sku };
}

function makeVariantItem(db, ctx, overrides = {}) {
  const created = itemService.createItem(db, ctx, {
    name: "Children's Sweater",
    baseCode: `CS-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    trackingMode: 'quantity',
    hasVariants: true,
    options: [
      { name: 'Colour', values: 'Navy, Cream' },
      { name: 'Size', values: '4, 5' },
    ],
    ...overrides,
  });
  const skus = repo.listSkusForItem(db, ctx.workspaceId, created.itemId);
  const byLabel = (label) => skus.find((s) => s.variant_label === label);
  return { itemId: created.itemId, skus, byLabel };
}

function makeSerialItem(db, ctx, overrides = {}) {
  const created = itemService.createItem(db, ctx, {
    name: 'Dell Latitude',
    baseCode: `DL-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    trackingMode: 'serial',
    ...overrides,
  });
  const sku = repo.listSkusForItem(db, ctx.workspaceId, created.itemId)[0];
  return { itemId: created.itemId, skuId: sku.id };
}

function makeLotItem(db, ctx, overrides = {}) {
  const created = itemService.createItem(db, ctx, {
    name: 'Trail Ration Pack',
    baseCode: `FOOD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    trackingMode: 'lot',
    ...overrides,
  });
  const sku = repo.listSkusForItem(db, ctx.workspaceId, created.itemId)[0];
  return { itemId: created.itemId, skuId: sku.id };
}

function lotsFor(db, workspaceId, skuId) {
  return db.prepare('SELECT * FROM lots WHERE workspace_id = ? AND sku_id = ? ORDER BY code').all(workspaceId, skuId);
}

function unitsFor(db, workspaceId, skuId) {
  return db.prepare('SELECT * FROM serial_units WHERE workspace_id = ? AND sku_id = ? ORDER BY serial').all(workspaceId, skuId);
}

/** Rendered page as readable text, so assertions ignore markup and links. */
function plain(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // A space, not nothing: adjacent elements are separate words to a reader,
    // and "MigrationNot required" is not what the page says.
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pulls the CSRF token out of a rendered page. */
function csrfFrom(html) {
  const match = String(html).match(/name="_csrf" value="([^"]+)"/);
  if (!match) throw new Error('No CSRF token in response');
  return match[1];
}

/** Signs a supertest agent in and returns a token getter for form posts. */
async function signIn(agent, email, password = 'password123') {
  const page = await agent.get('/login');
  const token = csrfFrom(page.text);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ _csrf: token, email, password, next: '/' });
  if (res.status !== 302) throw new Error(`Sign in failed: ${res.status}`);
  return {
    async token(path = '/') {
      const page2 = await agent.get(path);
      return csrfFrom(page2.text);
    },
  };
}

module.exports = {
  makeDatabase,
  makeApp,
  cleanupAll,
  seedWorkspace,
  seedAnotherWorkspace,
  makeQuantityItem,
  makeVariantItem,
  makeSerialItem,
  makeLotItem,
  lotsFor,
  unitsFor,
  csrfFrom,
  plain,
  signIn,
};

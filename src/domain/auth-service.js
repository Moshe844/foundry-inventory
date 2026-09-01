'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const { ValidationError, AuthorizationError, NotFoundError } = require('./errors');
const { ROLE_IDS } = require('./constants');
const { newId, nowIso, trimOrNull, requireText, requireOneOf } = require('../lib/util');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

function verifyPassword(stored, password) {
  if (typeof stored !== 'string') return false;
  const [scheme, N, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const derived = crypto.scryptSync(password, salt, expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(N) * Number(r) * 2,
  });
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function normaliseEmail(value) {
  const email = trimOrNull(value);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError('Enter a valid email address.', { field: 'email' });
  }
  return email.toLowerCase();
}

function checkPasswordStrength(password) {
  const value = typeof password === 'string' ? password : '';
  if (value.length < 8) {
    throw new ValidationError('Passwords must be at least 8 characters.', { field: 'password' });
  }
  if (value.length > 200) {
    throw new ValidationError('That password is too long.', { field: 'password' });
  }
  return value;
}


function insertAccount(db, input) {
  const name = requireText(input.name, 'Your name', { max: 120 });
  const email = normaliseEmail(input.email);
  const password = checkPasswordStrength(input.password);

  if (db.prepare('SELECT 1 FROM accounts WHERE email = ? COLLATE NOCASE').get(email)) {
    throw new ValidationError('An account already uses that email address.', { field: 'email' });
  }

  const accountId = newId('acc');
  db.prepare(
    `INSERT INTO accounts (id, email, name, password_hash, plan, created_at)
     VALUES (?, ?, ?, ?, 'free', ?)`
  ).run(accountId, email, name, hashPassword(password), nowIso());

  return { accountId, email, name };
}

/** Creates the login first. Inventories are deliberately a separate choice. */
function createAccount(db, input) {
  return inTransaction(db, () => insertAccount(db, input));
}

/**
 * Compatibility boundary for seeds and programmatic provisioning that create
 * an account and its first inventory together. Customer sign-up uses the
 * separate createAccount flow above.
 */
function registerAccount(db, input) {
  return inTransaction(db, () => {
    const workspaceName = requireText(input.workspaceName, 'Inventory name', { max: 120 });
    const account = insertAccount(db, input);

    const { workspaceId, userId } = createWorkspaceFor(db, account.accountId, workspaceName, {
      name: account.name,
    });
    return { ...account, workspaceId, userId };
  });
}

/** Creates a workspace owned by `accountId`, with that account as its owner. */
function createWorkspaceFor(db, accountId, workspaceName, options = {}) {
  const now = options.now || nowIso();
  const clean = requireText(workspaceName, 'Inventory name', { max: 120 });
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) throw new NotFoundError('That account could not be found.');

  const workspaceId = newId('wsp');
  db.prepare(
    'INSERT INTO workspaces (id, name, owner_account_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(workspaceId, clean, accountId, now);

  const userId = newId('usr');
  db.prepare(
    `INSERT INTO users (id, workspace_id, account_id, name, role, created_at)
     VALUES (?, ?, ?, ?, 'owner', ?)`
  ).run(userId, workspaceId, accountId, options.name || account.name, now);

  // Accounting is a built-in consequence of operating the business in
  // Foundry. A new inventory never has to visit an activation screen before
  // receipts, sales, or supplier documents can keep its books.
  require('../accounting/ledger').configure(
    db,
    { workspaceId, actorId: userId },
    { id: userId, role: 'owner' },
    { startDate: now.slice(0, 10), currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE' }
  );

  return { workspaceId, userId, name: clean };
}

/** Authenticates the person, not a workspace. Membership is resolved after. */
function authenticate(db, emailInput, password) {
  const email = String(emailInput || '').trim().toLowerCase();
  const account = db.prepare('SELECT * FROM accounts WHERE email = ? COLLATE NOCASE').get(email);
  if (!account) {
    // Spend comparable time so a missing account is not obviously faster.
    crypto.scryptSync(String(password || ''), 'foundry-timing-salt', 64, {
      N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
    });
    return null;
  }
  if (!verifyPassword(account.password_hash, String(password || ''))) return null;
  return account;
}

function getAccount(db, accountId) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) || null;
}

/**
 * The membership row for this account in this workspace, or null. This is the
 * single gate for "may this person see this inventory?" — every route resolves
 * it before anything workspace-scoped is read.
 */
function getMembership(db, workspaceId, accountId) {
  return (
    db
      .prepare('SELECT * FROM users WHERE workspace_id = ? AND account_id = ?')
      .get(workspaceId, accountId) || null
  );
}

/** Every workspace this account can reach, newest membership last. */
function listWorkspacesForAccount(db, accountId) {
  return db
    .prepare(
      `SELECT w.id, w.name, w.created_at, w.owner_account_id, u.id AS membership_id, u.role
         FROM users u JOIN workspaces w ON w.id = u.workspace_id
        WHERE u.account_id = ?
        ORDER BY w.created_at, w.name`
    )
    .all(accountId);
}

function getUser(db, workspaceId, userId) {
  return (
    db
      .prepare(
        `SELECT u.*, a.email, a.plan FROM users u JOIN accounts a ON a.id = u.account_id
          WHERE u.id = ? AND u.workspace_id = ?`
      )
      .get(userId, workspaceId) || null
  );
}

function listUsers(db, workspaceId) {
  return db
    .prepare(
      `SELECT u.id, u.name, u.role, u.created_at, a.email, a.id AS account_id
         FROM users u JOIN accounts a ON a.id = u.account_id
        WHERE u.workspace_id = ? ORDER BY u.created_at`
    )
    .all(workspaceId);
}

function requireOwner(user) {
  if (!user || user.role !== 'owner') {
    throw new AuthorizationError('Only an owner can change this inventory’s settings.');
  }
  return user;
}

/**
 * Adds someone to *this* workspace. If they already have an account, they are
 * joined to it and keep their existing password — an inventory owner never sets
 * or sees another person's credentials.
 */
function createTeamMember(db, ctx, actor, input) {
  requireOwner(actor);
  return inTransaction(db, () => {
    const name = requireText(input.name, 'Name', { max: 120 });
    const email = normaliseEmail(input.email);
    const role = requireOneOf(input.role, ROLE_IDS, 'Role');

    let account = db.prepare('SELECT * FROM accounts WHERE email = ? COLLATE NOCASE').get(email);
    if (!account) {
      const password = checkPasswordStrength(input.password);
      const accountId = newId('acc');
      db.prepare(
        `INSERT INTO accounts (id, email, name, password_hash, plan, created_at)
         VALUES (?, ?, ?, ?, 'free', ?)`
      ).run(accountId, email, name, hashPassword(password), nowIso());
      account = { id: accountId, email, name };
    } else if (getMembership(db, ctx.workspaceId, account.id)) {
      throw new ValidationError('That person is already on this inventory.', { field: 'email' });
    }

    const id = newId('usr');
    db.prepare(
      `INSERT INTO users (id, workspace_id, account_id, name, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, ctx.workspaceId, account.id, name, role, nowIso());
    return { id, name, email, role, accountId: account.id };
  });
}

function renameWorkspace(db, ctx, actor, name) {
  requireOwner(actor);
  const clean = requireText(name, 'Inventory name', { max: 120 });
  const result = db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(clean, ctx.workspaceId);
  if (result.changes === 0) throw new NotFoundError('That inventory could not be found.');
  return clean;
}

function getWorkspace(db, workspaceId) {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) || null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  createAccount,
  registerAccount,
  createWorkspaceFor,
  authenticate,
  getAccount,
  getMembership,
  listWorkspacesForAccount,
  getUser,
  listUsers,
  requireOwner,
  createTeamMember,
  renameWorkspace,
  getWorkspace,
  normaliseEmail,
};

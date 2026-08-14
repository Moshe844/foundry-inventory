'use strict';

/**
 * Inventory workspaces.
 *
 * A workspace is the tenant boundary: items, locations, movements, balances,
 * Foundry's understanding and configuration, and every attention item belong to
 * exactly one. It is not a location — one workspace holds many.
 *
 * Nothing here reads or writes inventory. Creating a workspace creates an empty
 * one; what goes in it comes from the same services every other path uses.
 */

const { inTransaction } = require('../db');
const authService = require('./auth-service');
const entitlements = require('../entitlements/service');
const { NotFoundError, AuthorizationError } = require('./errors');
const { nowIso } = require('../lib/util');

/**
 * Creates an inventory for this account and makes them its owner.
 * Checked against the account's plan before anything is written.
 */
function createWorkspace(db, accountId, name) {
  return inTransaction(db, () => {
    entitlements.assertWithin(db, { accountId }, 'workspaces');
    return authService.createWorkspaceFor(db, accountId, name);
  });
}

/**
 * Every inventory this account can open, with enough detail to choose between
 * them without opening each one.
 */
function listForAccount(db, accountId) {
  return authService.listWorkspacesForAccount(db, accountId).map((row) => {
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM items WHERE workspace_id = @w AND is_active = 1)      AS itemCount,
                (SELECT COUNT(*) FROM locations WHERE workspace_id = @w AND is_active = 1)  AS locationCount,
                (SELECT COALESCE(SUM(on_hand), 0) FROM balances WHERE workspace_id = @w)    AS unitsOnHand,
                (SELECT COUNT(*) FROM users WHERE workspace_id = @w)                        AS memberCount`
      )
      .get({ w: row.id });

    // Kept separate and defensive: this list is built on every request to draw
    // the switcher, and the interpretation layer must never be able to take the
    // whole application down. A missing badge is a cosmetic loss.
    let attentionCount = 0;
    try {
      attentionCount = db
        .prepare(
          `SELECT COUNT(*) AS n FROM attention_items
            WHERE workspace_id = ? AND status IN ('OPEN', 'ACKNOWLEDGED')`
        )
        .get(row.id).n;
    } catch {
      attentionCount = 0;
    }

    const configuration = db
      .prepare('SELECT configured_at, configuration_version FROM workspace_configuration WHERE workspace_id = ?')
      .get(row.id);

    return {
      workspaceId: row.id,
      name: row.name,
      role: row.role,
      membershipId: row.membership_id,
      isOwner: row.owner_account_id === accountId,
      createdAt: row.created_at,
      ...counts,
      attentionCount,
      configured: Boolean(configuration && configuration.configured_at),
      configuredByFoundry: Boolean(configuration && configuration.configuration_version > 0),
    };
  });
}

/**
 * Resolves a workspace the account is actually a member of.
 *
 * This is the only place a workspace id from a URL, a form, or a session is
 * turned into something usable, and it always requires membership — so a
 * guessed or stolen id is "not found", exactly like any other record belonging
 * to someone else.
 */
function resolveForAccount(db, accountId, workspaceId) {
  if (!accountId || !workspaceId) return null;
  const membership = authService.getMembership(db, workspaceId, accountId);
  if (!membership) return null;
  const workspace = authService.getWorkspace(db, workspaceId);
  if (!workspace) return null;
  return { workspace, membership };
}

/**
 * The one to open when nothing else says which: where they were last, if they
 * can still reach it, otherwise their oldest inventory.
 */
function defaultWorkspaceFor(db, accountId) {
  const account = db.prepare('SELECT last_workspace_id FROM accounts WHERE id = ?').get(accountId);
  if (account && account.last_workspace_id) {
    if (authService.getMembership(db, account.last_workspace_id, accountId)) {
      return account.last_workspace_id;
    }
  }
  const rows = authService.listWorkspacesForAccount(db, accountId);
  return rows.length ? rows[0].id : null;
}

/** Remembers the choice. Best-effort: a failed write must never fail a page. */
function rememberWorkspace(db, accountId, workspaceId) {
  try {
    db.prepare('UPDATE accounts SET last_workspace_id = ? WHERE id = ?').run(workspaceId, accountId);
  } catch {
    /* the session still carries it for this visit */
  }
}

/**
 * Leaving an inventory removes the membership, never the inventory. The last
 * owner cannot leave: an inventory with no owner is unreachable, and the
 * movements that reference this membership must keep resolving.
 */
function leaveWorkspace(db, workspaceId, accountId) {
  return inTransaction(db, () => {
    const membership = authService.getMembership(db, workspaceId, accountId);
    if (!membership) throw new NotFoundError('That inventory could not be found.');

    if (membership.role === 'owner') {
      const owners = db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE workspace_id = ? AND role = 'owner'")
        .get(workspaceId).n;
      if (owners <= 1) {
        throw new AuthorizationError(
          'You are the only owner of this inventory. Add another owner before leaving it.'
        );
      }
    }

    // A membership that recorded movements is never deleted: the ledger says
    // who did what, and that has to keep resolving forever. It is unlinked from
    // the account instead, which ends the access without erasing the history.
    const recorded = db
      .prepare('SELECT COUNT(*) AS n FROM movements WHERE actor_user_id = ?')
      .get(membership.id).n;

    if (recorded === 0) {
      db.prepare('DELETE FROM users WHERE id = ?').run(membership.id);
      return { left: true, retainedForLedger: false };
    }

    const placeholderId = `acc_departed_${membership.id}`;
    db.prepare(
      `INSERT INTO accounts (id, email, name, password_hash, plan, created_at)
       VALUES (?, ?, ?, '', 'free', ?)
       ON CONFLICT(id) DO NOTHING`
    ).run(placeholderId, `departed+${membership.id}@foundry.invalid`, membership.name, nowIso());
    db.prepare('UPDATE users SET account_id = ? WHERE id = ?').run(placeholderId, membership.id);
    return { left: true, retainedForLedger: true };
  });
}

module.exports = {
  createWorkspace,
  listForAccount,
  resolveForAccount,
  defaultWorkspaceFor,
  rememberWorkspace,
  leaveWorkspace,
};

'use strict';

/**
 * Deleting an entire inventory.
 *
 * This is the most destructive thing StockChief can do, and it is deliberately the
 * only place that removes a movement. Everywhere else the ledger is immutable —
 * a correction is a new movement, an undo is a new movement, and a trigger
 * enforces it. That invariant protects history *inside* a live inventory.
 *
 * Removing the whole container is a different act: someone is saying they want
 * this business's records gone. Refusing that in the name of an audit trail
 * would mean holding a customer's data after they asked for it to be deleted,
 * which is a worse answer. So the trigger comes off — inside the transaction,
 * so a failure at any point rolls it back on with everything else — and goes
 * straight back afterwards.
 *
 * The delete order is derived from the schema rather than written down. A
 * hardcoded list of 38 tables would be wrong the first time anyone adds one,
 * and a half-deleted inventory is a much worse outcome than a failed delete.
 */

const { inTransaction } = require('../db');
const { ValidationError, NotFoundError, AuthorizationError } = require('./errors');
const authService = require('./auth-service');

/** Tables that carry a workspace_id, discovered rather than listed. */
function scopedTables(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name);

  return tables.filter((table) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === 'workspace_id')
  );
}

/**
 * An order in which these tables can be emptied without tripping a foreign key.
 *
 * Twenty-eight columns across the schema use ON DELETE RESTRICT — a location
 * cannot be removed while a movement points at it, and that is correct. So
 * children have to go before parents, which is a topological sort of the
 * dependency graph.
 */
function deletionOrder(db, tables) {
  const known = new Set(tables);
  const dependsOn = new Map(tables.map((table) => [table, new Set()]));

  for (const table of tables) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
      // A table pointing at itself says nothing about ordering between tables.
      if (fk.table === table) continue;
      if (known.has(fk.table)) dependsOn.get(table).add(fk.table);
    }
  }

  const ordered = [];
  const placed = new Set();
  let remaining = [...tables];

  // Repeatedly take every table nothing un-placed depends on.
  while (remaining.length) {
    const ready = remaining.filter((table) =>
      [...dependsOn.get(table)].every((parent) => placed.has(parent) || !remaining.includes(parent))
    );

    if (ready.length === 0) {
      // A cycle between two tables. Rather than delete in a guessed order and
      // leave orphans behind, say so — this is a schema change that needs a
      // human decision, not something to paper over.
      throw new ValidationError(
        `StockChief cannot work out a safe order to delete these tables: ${remaining.join(', ')}.`
      );
    }

    // Dependents first: a table whose parents are already placed goes after
    // them in the graph, which means *before* them when deleting.
    for (const table of ready) {
      placed.add(table);
      ordered.push(table);
    }
    remaining = remaining.filter((table) => !placed.has(table));
  }

  return ordered.reverse();
}

/** What is about to be destroyed, in the words a person would use. */
function describe(db, workspaceId) {
  const count = (sql, ...params) => db.prepare(sql).get(workspaceId, ...params).n;

  return {
    items: count('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?'),
    locations: count('SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ?'),
    unitsOnHand: db
      .prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?')
      .get(workspaceId).n,
    movements: count('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?'),
    members: count('SELECT COUNT(*) AS n FROM users WHERE workspace_id = ?'),
    suppliers: count('SELECT COUNT(*) AS n FROM suppliers WHERE workspace_id = ?'),
    purchaseOrders: count('SELECT COUNT(*) AS n FROM purchase_orders WHERE workspace_id = ?'),
    openPurchaseOrders: count(
      `SELECT COUNT(*) AS n FROM purchase_orders WHERE workspace_id = ?
        AND status IN ('APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED')`
    ),
    imports: count('SELECT COUNT(*) AS n FROM import_plans WHERE workspace_id = ?'),
  };
}

/**
 * Deletes one inventory and everything scoped to it.
 *
 * @param {object} options { confirmName } — the person types the inventory's
 *        name. Not ceremony: it is the difference between clicking the wrong
 *        row and meaning it, and this cannot be undone.
 */
function authorizeDeletion(db, accountId, workspaceId, options = {}) {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!workspace) throw new NotFoundError('That inventory could not be found.');

  const membership = authService.getMembership(db, workspaceId, accountId);
  if (!membership) throw new NotFoundError('That inventory could not be found.');
  if (membership.role !== 'owner') {
    throw new AuthorizationError('Only an owner can delete an inventory.');
  }

  const typed = String(options.confirmName || '').trim();
  if (typed.toLowerCase() !== workspace.name.trim().toLowerCase()) {
    throw new ValidationError(
      `Type the inventory's name exactly — “${workspace.name}” — to confirm you want it deleted.`,
      { field: 'confirmName' }
    );
  }

  return workspace;
}

function deleteWorkspace(db, accountId, workspaceId, options = {}) {
  const workspace = authorizeDeletion(db, accountId, workspaceId, options);

  const summary = describe(db, workspaceId);
  const tables = deletionOrder(db, scopedTables(db));

  inTransaction(db, () => {
    /*
     * Every immutability guard, lifted only for this and only in here.
     *
     * This used to name one trigger — the one on movements — and deleting an
     * inventory then failed on the next guard it met: "inventory cost history
     * cannot be deleted". There are four of these, and a list written by hand
     * is a list that goes stale the moment somebody adds a fifth.
     *
     * So they are read out of the database, dropped, and put back from their
     * own definitions. Every statement is inside one transaction, so a failure
     * anywhere rolls the guards back into place along with the data they were
     * guarding.
     *
     * The guards exist because a posted ledger is not editable. Removing the
     * whole inventory is the one case that is not an edit: nothing is being
     * corrected or rewritten, it is all going.
     */
    const guards = db.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND sql LIKE '%BEFORE DELETE%' AND sql LIKE '%RAISE%'`).all();
    for (const guard of guards) db.exec(`DROP TRIGGER IF EXISTS ${guard.name}`);
    try {
      for (const table of tables) {
        db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
      }
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    } finally {
      for (const guard of guards) db.exec(guard.sql);
    }

    // Accounts pointing at the inventory they were last in need somewhere else.
    db.prepare('UPDATE accounts SET last_workspace_id = NULL WHERE last_workspace_id = ?').run(workspaceId);
  });

  return { name: workspace.name, ...summary };
}

/**
 * The same deletion contract, executed in small transactions for a large
 * workspace. A completed batch is safe to repeat, so a durable worker can
 * resume after a process failure without duplicating or inventing effects.
 *
 * The HTTP route performs the owner/name authorization before it creates the
 * job. `preAuthorized` exists only for that durable job: after the users table
 * has been emptied, a retry can no longer repeat the membership lookup.
 */
async function deleteWorkspaceInBatches(db, accountId, workspaceId, options = {}) {
  let workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!workspace) return { workspaceId, alreadyDeleted: true };
  if (!options.preAuthorized) {
    workspace = authorizeDeletion(db, accountId, workspaceId, options);
  } else if (String(options.confirmName || '').trim().toLowerCase() !== workspace.name.trim().toLowerCase()) {
    throw new ValidationError('The authorized inventory name no longer matches the deletion request.');
  }

  const summary = describe(db, workspaceId);
  const tables = deletionOrder(db, scopedTables(db));
  const batchSize = Math.max(100, Math.min(10_000, Number(options.batchSize || 1000)));
  const pauseMs = Math.max(0, Math.min(100, Number(options.pauseMs ?? 8)));

  for (const table of tables) {
    const selfReferences = db.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .filter((fk) => fk.table === table && ['RESTRICT', 'NO ACTION'].includes(fk.on_delete));
    let removed;
    do {
      removed = inTransaction(db, () => {
        const guards = db.prepare(`SELECT name, sql FROM sqlite_master
          WHERE type = 'trigger' AND tbl_name = ? AND sql LIKE '%BEFORE DELETE%' AND sql LIKE '%RAISE%'`).all(table);
        for (const guard of guards) db.exec(`DROP TRIGGER IF EXISTS ${guard.name}`);
        try {
          const leavesOnly = selfReferences.map((fk) =>
            `AND NOT EXISTS (SELECT 1 FROM ${table} child WHERE child.${fk.from} = parent.${fk.to})`
          ).join(' ');
          return db.prepare(`DELETE FROM ${table} WHERE rowid IN (
            SELECT parent.rowid FROM ${table} parent
             WHERE parent.workspace_id = ? ${leavesOnly} LIMIT ?
          )`).run(workspaceId, batchSize).changes;
        } finally {
          for (const guard of guards) db.exec(guard.sql);
        }
      });
      if (removed && typeof options.onProgress === 'function') options.onProgress({ table, removed });
      // Yield the SQLite writer lock between batches. Browser sessions and
      // ordinary work can then commit while a very large inventory is leaving.
      if (removed) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    } while (removed === batchSize);

    const stranded = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(workspaceId).n;
    if (stranded) {
      throw new ValidationError(`StockChief could not safely remove ${stranded} cyclic ${table} record(s).`);
    }
  }

  inTransaction(db, () => {
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    db.prepare('UPDATE accounts SET last_workspace_id = NULL WHERE last_workspace_id = ?').run(workspaceId);
  });
  return { name: workspace.name, ...summary };
}

module.exports = {
  scopedTables,
  deletionOrder,
  describe,
  authorizeDeletion,
  deleteWorkspace,
  deleteWorkspaceInBatches,
};

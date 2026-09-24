'use strict';

const auth = require('../domain/postgres-auth-service');

function workspaceSummary(row, accountId) {
  return {
    workspaceId:row.id,
    name:row.name,
    role:row.role,
    membershipId:row.membership_id,
    isOwner:row.owner_account_id === accountId,
    createdAt:row.created_at,
    dataMode:row.data_mode || 'production',
    itemCount:Number(row.item_count),
    locationCount:Number(row.location_count),
    unitsOnHand:Number(row.units_on_hand),
    memberCount:Number(row.member_count),
  };
}

function loadUser(database) {
  return async function postgresLoadUser(req, res, next) {
    try {
      res.locals.currentUser = null;
      res.locals.workspace = null;
      res.locals.workspaces = [];
      res.locals.account = null;
      if (!req.session?.accountId) return next();

      const account = await auth.getAccount(database, req.session.accountId);
      if (!account) {
        return req.session.destroy((error) => error ? next(error) : next());
      }
      req.account = account;
      res.locals.account = { id:account.id,name:account.name,email:account.email,plan:account.plan };
      const memberships = await auth.listWorkspacesForAccount(database, account.id);
      res.locals.workspaces = memberships.map((row) => workspaceSummary(row, account.id));
      if (!memberships.length) return next();

      let workspaceId = req.session.workspaceId;
      let resolved = await auth.resolveForAccount(database, account.id, workspaceId);
      if (!resolved) {
        workspaceId = await auth.defaultWorkspaceFor(database, account.id);
        resolved = await auth.resolveForAccount(database, account.id, workspaceId);
        if (resolved) req.session.workspaceId = workspaceId;
      }
      if (!resolved) return next();
      if (account.last_workspace_id !== workspaceId) await auth.rememberWorkspace(database, account.id, workspaceId);

      const { workspace,membership } = resolved;
      req.user = { ...membership,email:account.email,plan:account.plan };
      req.workspace = workspace;
      req.ctx = { workspaceId:workspace.id,actorId:membership.id,accountId:account.id };
      res.locals.currentUser = { id:membership.id,name:membership.name,email:account.email,role:membership.role };
      res.locals.workspace = workspace;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { loadUser,workspaceSummary };

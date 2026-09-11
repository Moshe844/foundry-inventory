'use strict';

const MODES = Object.freeze({ PRODUCTION: 'production', SYNTHETIC: 'synthetic' });

function workspaceMode(db, workspaceId) {
  const row = db.prepare('SELECT data_mode FROM workspaces WHERE id = ?').get(workspaceId);
  return row?.data_mode === MODES.SYNTHETIC ? MODES.SYNTHETIC : MODES.PRODUCTION;
}

/*
 * This service is called only from Foundry's inventory-setup lifecycle. The
 * persisted workspace mode, chosen explicitly when the inventory is created,
 * is therefore the authority for whether setup may create synthetic records.
 * Request wording never reclassifies the workspace. It only describes the
 * dataset's shape and quality later in request-spec.js.
 */
function context(db, workspaceId) {
  const mode = workspaceMode(db, workspaceId);
  const synthetic = mode === MODES.SYNTHETIC;
  return {
    mode,
    allowed: synthetic,
    reason: synthetic
      ? 'synthetic_workspace_setup'
      : 'production_workspace_requires_evidence',
  };
}

module.exports = { MODES, workspaceMode, context };

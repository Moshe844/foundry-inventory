'use strict';

// One in-process guard shared by direct Check-now runs and event reactions.
// Durable database idempotency remains the cross-process protection.
module.exports = { activeWorkspaces: new Set() };

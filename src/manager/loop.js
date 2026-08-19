'use strict';

const modes = require('../autopilot/modes');
const runner = require('../autopilot/runner');
const reevaluate = require('../attention/reevaluate');
const triggers = require('./triggers');
const investigations = require('./investigations');
const reconciliation = require('./reconciliation');
const brief = require('./brief');

function run(db, ctx, membership, options = {}) {
  const workspaceId = ctx.workspaceId;
  const recoveredTriggers = triggers.recover(db);
  const recoveredInvestigations = investigations.recover(db, workspaceId);
  const state = modes.ensure(db, workspaceId);
  let work;
  if (state.paused || state.suspended || state.mode === modes.MODES.OBSERVE) {
    const refreshed = reevaluate.refresh(db, workspaceId, options.trigger || 'manager');
    work = { readOnly: true, opened: refreshed.opened, resolved: refreshed.resolved, executed: 0, planned: 0 };
  } else {
    work = options.planOnly
      ? (() => { const planned = runner.planWork(db, ctx, membership, options); return { planned: (planned.created || []).length, executed: 0, planId: planned.planId }; })()
      : runner.run(db, ctx, membership, options);
  }

  const investigated = [];
  for (const entry of investigations.list(db, workspaceId, { statuses: 'OPEN', limit: 25 })) {
    investigated.push(investigations.investigate(db, workspaceId, entry.investigationId));
  }
  const reconciled = reconciliation.scanWorkspace(db, workspaceId);
  const dailyBrief = brief.build(db, workspaceId, { now: options.now || Date.now() });
  return { ...work, recoveredTriggers, recoveredInvestigations, investigated: investigated.length, reconciled, brief: dailyBrief };
}

function processPending(db, authorityFor, { limit = 25, now = Date.now() } = {}) {
  const results = [];
  for (let count = 0; count < limit; count += 1) {
    const trigger = triggers.claimNext(db);
    if (!trigger) break;
    try {
      const authority = authorityFor(db, trigger.workspaceId);
      let actor = authority;
      if (!actor) {
        const owner = db.prepare("SELECT * FROM users WHERE workspace_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1").get(trigger.workspaceId);
        if (!owner) throw new Error('No inventory owner is available.');
        actor = { ctx: { workspaceId: trigger.workspaceId, actorId: owner.id, accountId: owner.account_id }, membership: owner };
      }
      const result = run(db, actor.ctx, actor.membership, { trigger: trigger.kind, now, planOnly: !authority });
      triggers.finish(db, trigger.id);
      results.push({ triggerId: trigger.id, ...result });
    } catch (error) {
      triggers.finish(db, trigger.id, error);
      results.push({ triggerId: trigger.id, failed: true, error: error.message });
    }
  }
  return results;
}

module.exports = { run, processPending };

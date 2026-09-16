'use strict';

const modes = require('../autopilot/modes');
const runner = require('../autopilot/runner');
const reevaluate = require('../attention/reevaluate');
const triggers = require('./triggers');
const investigations = require('./investigations');
const reconciliation = require('./reconciliation');
const brief = require('./brief');
const repairs = require('../repairs/service');
const workItems = require('../autopilot/work-items');
const outcomeLearning = require('../learning/service');

function run(db, ctx, membership, options = {}) {
  const workspaceId = ctx.workspaceId;
  const recoveredTriggers = triggers.recover(db);
  const recoveredInvestigations = investigations.recover(db, workspaceId);
  const recoveredRepairs = repairs.recover(db, ctx, membership);
  // Interrupted work becomes a durable repair case before anything decides
  // what to do with it. A prior successful execution can be reconciled and
  // verified automatically; an unknown outcome remains one owner decision.
  for (const item of workItems.inFlight(db, workspaceId)) {
    const assessed = repairs.openAndAssess(db, ctx, {
      kind: 'stuck_job',
      symptom: `${item.categoryLabel || 'StockChief work'} was interrupted`,
      failedInvariant: 'Every started job must end with one independently verified outcome',
      affectedRecords: { workItemId: item.id },
      idempotencyKey: `repair:work-item:${item.id}`,
    }).repairCase;
    if (assessed.status === 'SIMULATED') {
      try {
        const governed = repairs.executeAutonomously(db, ctx, membership, assessed.id);
        recoveredRepairs.push(repairs.get(db, workspaceId,
          governed.operation.sourceId));
      }
      catch { /* The failed case itself is now the durable Needs You item. */ }
    }
  }
  const state = modes.ensure(db, workspaceId);
  let work;
  const globallySuspended = state.suspended && !state.suspendedScope;
  if (state.paused || globallySuspended || state.mode === modes.MODES.OBSERVE) {
    const refreshed = reevaluate.refresh(db, workspaceId, options.trigger || 'manager');
    work = { readOnly: true, opened: refreshed.opened, resolved: refreshed.resolved, executed: 0, planned: 0 };
  } else {
    work = options.planOnly
      ? (() => { const planned = runner.planWork(db, ctx, membership, options); return { planned: (planned.created || []).length, executed: 0, planId: planned.planId }; })()
      : runner.run(db, ctx, membership, { ...options, skipRecovery: true });
  }

  const investigated = [];
  for (const entry of investigations.list(db, workspaceId, { statuses: 'OPEN', limit: 25 })) {
    investigated.push(investigations.investigate(db, workspaceId, entry.investigationId));
  }
  const reconciled = reconciliation.scanWorkspace(db, workspaceId);
  // Learning is observational by default. Only an exact, versioned learning
  // grant can promote a proposal here; every actual write still goes through
  // the deterministic domain adapter owned by the affected setting.
  let learning = null;
  try { learning = outcomeLearning.run(db, workspaceId, { ...options, applyAuthorized:true }); }
  catch { learning = null; }
  const dailyBrief = brief.build(db, workspaceId, { now: options.now || Date.now() });
  return { ...work, recoveredTriggers, recoveredInvestigations, recoveredRepairs: recoveredRepairs.length,
    investigated: investigated.length, reconciled, learning, brief: dailyBrief };
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

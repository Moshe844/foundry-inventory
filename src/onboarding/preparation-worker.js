'use strict';

const { parentPort,workerData } = require('node:worker_threads');
const { openDatabase } = require('../db');
const migration = require('./canonical-migration');
const ownerMigration = require('./owner-migration');

const db = openDatabase(workerData.databasePath);
const update = (value) => migration.setPreparationProgress(db,workerData.ctx.workspaceId,
  workerData.packageId,value);

try {
  const before = ownerMigration.listDatasets(db,workerData.ctx.workspaceId,workerData.packageId)
    .filter((dataset) => dataset.entityType !== 'reference_only');
  ownerMigration.prepareKnownEvidence(db,workerData.ctx,workerData.membership,workerData.packageId,{
    onProgress(progress) {
      update({ status:'RUNNING',stage:progress.stage,completed:progress.completed,
        total:progress.total || before.length,detail:progress.detail });
      parentPort.postMessage({ type:'progress',...progress });
    },
  });

  const datasets = ownerMigration.listDatasets(db,workerData.ctx.workspaceId,workerData.packageId)
    .filter((dataset) => dataset.entityType !== 'reference_only');
  const prepared = datasets.filter((dataset) => dataset.status === 'STAGED');
  const remaining = datasets.filter((dataset) => dataset.status !== 'STAGED');
  let review = ownerMigration.refreshSourceReview(db,workerData.ctx.workspaceId,workerData.packageId);
  if (remaining.length) {
    update({ status:'WAITING',stage:'SOURCE_DECISION',completed:prepared.length,total:datasets.length,
      detail:`${remaining.length} source ${remaining.length === 1 ? 'meaning needs' : 'meanings need'} your decision.` });
    parentPort.postMessage({ type:'waiting',remaining:remaining.length });
  } else {
    if (ownerMigration.canResolveOperationalTruthByPolicy(review)) {
      update({ status:'RUNNING',stage:'RECONCILING_SOURCE',completed:prepared.length,total:datasets.length,
        detail:'Using the detailed operational records and retaining contradictory summaries as source evidence.' });
      review = ownerMigration.resolveOperationalTruthByPolicy(db,workerData.ctx.workspaceId,workerData.packageId);
    }
    if (review && review.requiresDecision && !review.resolved) {
    update({ status:'WAITING',stage:'SOURCE_CONFLICT',completed:prepared.length,total:datasets.length,
      detail:'One row-level source conflict needs evidence before StockChief can continue.' });
    parentPort.postMessage({ type:'waiting',remaining:1 });
    } else {
    update({ status:'RUNNING',stage:'VERIFYING',completed:prepared.length,total:datasets.length,
      detail:`Checking ${migration.getPackage(db,workerData.ctx.workspaceId,workerData.packageId).stagedCount.toLocaleString()} prepared records against the saved source.` });
    const result = migration.validate(db,workerData.ctx,workerData.membership,workerData.packageId);
    const passed = result.package.status === 'READY';
    update({ status:passed ? 'DONE' : 'WAITING',stage:passed ? 'VERIFIED' : 'VERIFICATION_ISSUES',
      completed:datasets.length,total:datasets.length,
      detail:passed
        ? 'Preparation and verification passed. Only your final approval remains.'
        : `${result.problems.toLocaleString()} prepared records need source evidence before anything can become live.` });
    parentPort.postMessage({ type:passed ? 'done' : 'waiting',problems:result.problems });
    }
  }
} catch (error) {
  try {
    const needsEvidence = Number(error && error.status || 500) < 500;
    update({ status:needsEvidence ? 'WAITING' : 'FAILED',stage:needsEvidence ? 'SOURCE_DECISION' : 'STOPPED',
      detail:needsEvidence ? String(error.message || error) : 'Preparation stopped safely. The source snapshot is still saved.',
      error:String(error.message || error) });
    if (needsEvidence) {
      parentPort.postMessage({ type:'waiting',packageId:workerData.packageId,message:String(error.message || error) });
      return;
    }
  } catch (_) {}
  parentPort.postMessage({ type:'error',packageId:workerData.packageId,message:String(error.message || error) });
  process.exitCode = 1;
} finally {
  db.close();
}

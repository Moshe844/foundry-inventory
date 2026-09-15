'use strict';

const { parentPort,workerData } = require('node:worker_threads');
const { openDatabase } = require('../db');
const migration = require('./canonical-migration');

const db = openDatabase(workerData.databasePath);
try {
  let totalApplied = 0;
  for (;;) {
    const result = migration.advanceCutover(db,workerData.ctx,workerData.membership,
      workerData.packageId,{ limit:5000 });
    totalApplied += Number(result.applied || 0);
    parentPort.postMessage({ type:'progress',packageId:workerData.packageId,totalApplied,
      appliedCount:result.package.appliedCount,status:result.package.status });
    if (result.done) {
      parentPort.postMessage({ type:'done',packageId:workerData.packageId,totalApplied,
        activated:result.activated,status:result.package.status });
      break;
    }
  }
} catch (error) {
  parentPort.postMessage({ type:'error',packageId:workerData.packageId,message:String(error.message || error) });
  process.exitCode = 1;
} finally {
  db.close();
}

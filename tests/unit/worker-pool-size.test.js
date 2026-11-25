'use strict';
// The business worker shares one connection pool between parallel import saving and its
// other loops (jobs, schedules, capacity, Ask reads). Four lanes in a pool of five starved
// those loops on the live worker: jobs lost their claims and Ask reads failed mid-import.
const test=require('node:test'),assert=require('node:assert/strict'),{workerPoolSize}=require('../../src/imports/postgres-stock-lanes');
test('the worker pool grows with the configured import lanes',()=>{
 assert.equal(workerPoolSize({}),5,'no lanes: the worker keeps its usual five connections');
 for(const lanes of [1,2,3,4])assert.equal(workerPoolSize({FOUNDRY_IMPORT_STOCK_WORKERS:String(lanes)}),5+lanes);
 assert.equal(workerPoolSize({FOUNDRY_IMPORT_STOCK_WORKERS:'9'}),5,'lanes outside 1-4 are off, as the import engine treats them');
});
test('an explicit pool size still wins',()=>{
 assert.equal(workerPoolSize({FOUNDRY_WORKER_DB_POOL_SIZE:'12',FOUNDRY_IMPORT_STOCK_WORKERS:'4'}),12);
 assert.equal(workerPoolSize({FOUNDRY_WORKER_DB_POOL_SIZE:'nonsense',FOUNDRY_IMPORT_STOCK_WORKERS:'4'}),9,'an unreadable size falls back to the sized default');
});

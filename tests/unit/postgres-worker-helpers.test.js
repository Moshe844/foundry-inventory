'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Replaces the queue with a stand-in: the first job each lane takes is held until
// released (a long job such as a large account deletion); every later job finishes at once.
function standIn(){
 const queue=require('../../src/operations/postgres-job-queue'),original=queue.processOne;
 const lanes={},owners=new Map(),serial=new Map();let release;const held=new Promise(resolve=>{release=resolve;});
 queue.processOne=async(db,handlers,options)=>{
  const lane=Object.keys(handlers)[0];const state=lanes[lane]||(lanes[lane]={calls:0,inflight:0,maximum:0});
  state.calls++;state.inflight++;state.maximum=Math.max(state.maximum,state.inflight);
  owners.set(options.owner,(owners.get(options.owner)||0)+1);serial.set(lane,options.serialPerBusinessKind===true);
  try{if(state.calls===1)await held;}finally{state.inflight--;}
 };
 return {lanes,owners,serial,release,restore:()=>{release();queue.processOne=original;}};
}
const handler=lane=>Object.assign(async()=>{},lane?{workerLane:lane}:{});

test('a long job no longer holds up routine work: a helper opens, works, then leaves',async()=>{
 const stand=standIn();let worker;
 try{
  worker=require('../../src/operations/postgres-worker').start({},{owner:'helped',intervalMs:10,helpers:{slots:2,afterMs:60},
   handlers:{'fixture.routine':handler(),'fixture.bulk':handler('bulk'),'fixture.forecast':handler('maintenance')}});
  await pause(30);
  assert.equal(stand.lanes['fixture.routine'].calls,1,'before the wait limit, routine work waits behind the long job as it did before');
  await pause(300);
  const routine=stand.lanes['fixture.routine'];
  assert(routine.calls>5,'a helper kept taking routine jobs while the long job ran');
  assert.equal(routine.maximum,2,'one helper is enough while helper jobs finish promptly');
  assert.equal(stand.lanes['fixture.bulk'].maximum,1,'bulk work never gets a helper');
  assert.equal(stand.lanes['fixture.forecast'].maximum,1,'maintenance never gets a helper');
  assert(stand.owners.get('helped:default:helper-1')>0,'the helper claims under its own owner name');
  assert.equal(stand.serial.get('fixture.routine'),true,'helped lanes keep one job per business and kind');
  assert.equal(stand.serial.get('fixture.bulk'),false);
  const callsThen=routine.calls;stand.release();await pause(80);
  const after=stand.owners.get('helped:default:helper-1');await pause(120);
  assert.equal(stand.owners.get('helped:default:helper-1'),after,'the helper left once the long job finished');
  assert(stand.lanes['fixture.routine'].calls>callsThen,'the primary slot carries on alone');
 }finally{stand.release();await worker?.stop();stand.restore();}
});

test('helpers come from one shared budget and are off unless the worker asks for them',async()=>{
 let stand=standIn(),worker;
 try{
  worker=require('../../src/operations/postgres-worker').start({},{owner:'budget',intervalMs:10,helpers:{slots:1,afterMs:40},
   handlers:{'fixture.routine':handler(),'fixture.read':handler('reading')}});
  await pause(250);
  const helpers=[...stand.owners.keys()].filter(owner=>owner.includes(':helper-'));
  assert.equal(helpers.length,1,'two held lanes share the single helper slot');
  assert.equal(stand.lanes['fixture.routine'].maximum+stand.lanes['fixture.read'].maximum,3);
 }finally{stand.release();await worker?.stop();stand.restore();}
 stand=standIn();
 try{
  worker=require('../../src/operations/postgres-worker').start({},{owner:'plain',intervalMs:10,handlers:{'fixture.routine':handler(),'fixture.bulk':handler('bulk')}});
  await pause(150);
  assert.equal(stand.lanes['fixture.routine'].calls,1,'without helpers a long job keeps its lane, exactly as before');
  assert.equal(stand.serial.get('fixture.routine'),false);
 }finally{stand.release();await worker?.stop();stand.restore();}
});

test('helper settings come from the environment and bad values keep the defaults',()=>{
 const {helperSettings}=require('../../src/operations/postgres-worker');
 assert.deepEqual({...helperSettings({})},{slots:2,afterMs:15000});
 assert.deepEqual({...helperSettings({FOUNDRY_WORKER_HELPER_SLOTS:'0',FOUNDRY_WORKER_HELPER_AFTER_MS:'5000'})},{slots:0,afterMs:5000});
 assert.deepEqual({...helperSettings({FOUNDRY_WORKER_HELPER_SLOTS:'9',FOUNDRY_WORKER_HELPER_AFTER_MS:'soon'})},{slots:2,afterMs:15000});
 const {workerPoolSize}=require('../../src/imports/postgres-stock-lanes');
 assert.equal(workerPoolSize({},2),7,'each helper slot brings its own connection');
 assert.equal(workerPoolSize({FOUNDRY_IMPORT_STOCK_WORKERS:'2'},2),9);
 assert.equal(workerPoolSize({FOUNDRY_WORKER_DB_POOL_SIZE:'12'},2),12,'an explicit pool size still wins');
 assert.throws(()=>require('../../src/operations/postgres-worker').start({},{helpers:{slots:7,afterMs:100},
  handlers:{'a':handler(),'b':handler('bulk')}}),/helper settings/);
});

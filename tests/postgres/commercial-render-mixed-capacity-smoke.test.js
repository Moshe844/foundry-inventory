'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const {startCluster}=require('../helpers/postgres-cluster');

test('isolated mixed-capacity probe authenticates, measures and removes its disposable database',
 {timeout:180000},async()=>{
  const cluster=await startCluster();
  try{
   const output=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(__dirname,'../../scripts/certify-render-mixed-capacity.js'),'--smoke'],
     {env:{...process.env,DATABASE_URL:cluster.connectionString,FOUNDRY_DATABASE_URL:'',
      STOCKCHIEF_REQUIRE_PAID_WORKSPACE:'false'},windowsHide:true});
    let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
   });
   assert.equal(output.code,0,output.stderr||output.stdout);
   const events=output.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));
   const result=events.find(event=>event.event==='capacity_summary');
   assert.equal(result.isolated,true);assert.equal(result.providerCalls,0);
   assert.equal(result.results.length,1);assert.equal(result.results[0].businesses,1);
   assert.ok(result.results[0].completed>=5);
   assert.equal(result.results[0].errors,0,JSON.stringify(result.results[0].errorsByKind));
   assert.equal(events.at(-1).event,'capacity_cleanup');
   assert.equal(events.at(-1).dropped,true);
  }finally{cluster.stop();}
 });

test('isolated real mixed probe executes mailbox, import and shipping handlers with provider boundaries mocked',
 {timeout:240000},async()=>{
  const cluster=await startCluster();
  try{
   const output=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(__dirname,'../../scripts/certify-render-mixed-capacity.js'),'--real-mixed-smoke'],
     {env:{...process.env,DATABASE_URL:cluster.connectionString,FOUNDRY_DATABASE_URL:'',
      STOCKCHIEF_REQUIRE_PAID_WORKSPACE:'false'},windowsHide:true});
    let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
   });
   assert.equal(output.code,0,output.stderr||output.stdout);
   const events=output.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));
   const result=events.find(event=>event.event==='capacity_summary')?.results[0];
   assert.ok(result,output.stdout);
   assert.equal(result.errors,0,JSON.stringify(result.errorSamples));
   assert.equal(result.integrity?.passed,true,JSON.stringify(result.integrity));
   assert.ok(result.mixed.mailPolls>0);
   assert.ok(result.mixed.imports>0);
   assert.ok(result.mixed.shipments>0);
   assert.ok(result.mixed.autopilotEvaluations>0);
   assert.ok(result.mixed.mailReplayed>0);
   assert.equal(result.postgres.maxLockWaiters,0);
   assert.equal(result.postgres.maxPoolWaiters,0);
   assert.equal(result.liveProviderCalls,0);
   assert.equal(events.at(-1).event,'capacity_cleanup');
   assert.equal(events.at(-1).dropped,true);
  }finally{cluster.stop();}
 });

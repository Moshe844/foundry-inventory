'use strict';

process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');

test('synthetic speech becomes governed count, transfer and correction paperwork with the live providers',
 {skip:!process.env.STOCKCHIEF_SYNTHETIC_VOICE_DIR,timeout:300000},async t=>{
  require('../../src/net-trust').installSystemCertificates();
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx,subscribe}=f;
  const paperwork=require('../../src/documents/agent-voice-paperwork');
  const queue=require('../../src/operations/postgres-job-queue');
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const locations=require('../../src/domain/postgres-location-service');
  const back=await locations.createLocation(db,ctx,{name:'Back room',kind:'warehouse'});
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason)
   VALUES($1,$2,'ai_work_credits',1000,'Synthetic voice test'),($3,$2,'agent_documents',10,'Synthetic voice test')`,
  [randomUUID(),f.owner.accountId,randomUUID()]);
  const buffer=kind=>{
   const wav=fs.readFileSync(path.join(process.env.STOCKCHIEF_SYNTHETIC_VOICE_DIR,kind+'.wav'));
   assert.ok(wav.length>32000&&wav.length<200000,'The generated fixture is a short voice note');
   return wav;
  };
  const processNote=async kind=>{
   const note=await paperwork.enqueue(db,ctx,{filename:kind+'.wav',buffer:buffer(kind),confirmed:'yes'});
   const job=await queue.processOne(db,{[paperwork.kind]:handlers[paperwork.kind]},{owner:'synthetic-voice-test'});
   assert.equal(job.status,'COMPLETED',JSON.stringify(job.lastError));
   return paperwork.load(db,ctx,note.id);
  };
  await subscribe('starter');
  await assert.rejects(paperwork.enqueue(db,ctx,{buffer:buffer('count'),confirmed:'yes'}),e=>e.code==='entitlement_required');
  await subscribe('growth');
  const count=await processNote('count');
  assert.deepEqual([count.status,count.kind],['DRAFT','COUNT'],count.reason);
  assert.equal(count.draft.rows[0].counted,18);
  assert.equal(await f.balance(),20);
  await paperwork.confirm(db,ctx,count.id,{fingerprint:count.draft.fingerprint,confirmed:'yes'});
  assert.equal(await f.balance(),18);

  await subscribe('pro');
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await paperwork.configure(db,ctx,{revision:0,maximumUnits:'5',maximum:'20',enabled:'yes'});
  const transfer=await processNote('transfer');
  assert.deepEqual([transfer.status,transfer.kind,transfer.automatic],['POSTED','TRANSFER',true],transfer.reason);
  const moved=(await db.query('SELECT status,destination_location_id FROM inventory_transfers WHERE workspace_id=$1 AND id=$2',
   [ctx.workspaceId,transfer.result.transferId])).rows[0];
  assert.deepEqual(moved,{status:'APPROVED',destination_location_id:back.id});

  await subscribe('enterprise');
  const adjustment=await processNote('adjustment');
  assert.deepEqual([adjustment.status,adjustment.kind,adjustment.automatic],['POSTED','ADJUSTMENT',true],adjustment.reason);
  assert.equal(await f.balance(),20);
  const costs=(await db.query(`SELECT count(*)::int n FROM commercial_cost_events WHERE workspace_id=$1
   AND provider='openai' AND operation='audio_transcription'`,[ctx.workspaceId])).rows[0].n;
  assert.equal(costs,3);
  t.diagnostic('Starter refused the upload; Growth drafted and confirmed; Pro reserved a transfer; Custom posted an adjustment. Three real transcription cost events were recorded.');
 });

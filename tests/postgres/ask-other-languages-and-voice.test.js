'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');

// One second of silence as the mono 16 kHz WAV the recorder sends.
function wav(seconds=1){
 const samples=16000*seconds,buffer=Buffer.alloc(44+samples*2);
 buffer.write('RIFF',0);buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);
 buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(16000,24);buffer.writeUInt32LE(32000,28);
 buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(samples*2,40);
 return buffer;
}

test('a question written in Yiddish gets the exact answer, written back in Yiddish with its figures kept',{timeout:180000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t);
 const {db,ctx}=f,assistant=require('../../src/assistant/postgres-service'),{pricedUsage}=require('../helpers/postgres-model-fixture');
 await f.subscribe('pro');
 const sku=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
 const question=`וויפיל ${sku} האבן מיר אויף לאגער?`,seen=[];
 const provider={name:'anthropic',model:'claude-haiku-4-5-20251001',async complete(request){
  seen.push(request.schemaName);
  if(request.schemaName==='stockchief_question_in_english'){
   assert.equal(JSON.parse(request.prompt).question,question,'the person\'s own words are read');
   return {data:{english:`How many units of ${sku} do we have?`},usage:pricedUsage()};
  }
  assert.equal(request.schemaName,'stockchief_localize_recorded_answer');
  assert.equal(JSON.parse(request.prompt).question,question,'the answer is written for the question as asked');
  assert.match(request.system,/language of the current user request/);
  return {data:{answer:'⟦1⟧ (⟦2⟧) — ⟦3⟧ שטיק אויף לאגער. ⟦4⟧ ביי ⟦5⟧ — ⟦6⟧.'},usage:pricedUsage()};
 }};
 const answer=await assistant.ask(db,ctx,question,{provider,usageKey:'yiddish-direct'});
 assert.deepEqual(seen,['stockchief_question_in_english','stockchief_localize_recorded_answer']);
 assert.match(answer.answer,/שטיק אויף לאגער/);assert(answer.answer.includes(sku),'the product code is kept exactly');
 assert.match(answer.answer,/— 4 שטיק/,'the figure is the recorded one');
 const saved=(await db.query('SELECT message FROM stockchief_runtime.assistant_interactions WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1',[ctx.workspaceId])).rows[0];
 assert.equal(saved.message,question,'the conversation keeps what the person wrote');
 // English is never sent to be read first.
 seen.length=0;await assistant.ask(db,ctx,`How many units of ${sku} do we have?`,{provider,usageKey:'english-direct'});
 assert.deepEqual(seen,[]);
});

test('a voice note is read into text in the spoken language, charged once, and refunded when nothing is heard',{timeout:180000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t);
 const {db,ctx}=f,voice=require('../../src/assistant/ask-voice'),budget=require('../../src/commercial/model-cost-budget');
 await f.subscribe('pro');
 const transcriber=text=>({name:'openai',model:'gpt-transcribe',providerVersion:'audio-2026-08-26',async transcribe(wave,{hold}){
  assert.ok(budget.useTranscriptionHold(hold),'the provider runs only under a funded price bound');
  assert.equal(wave.toString('ascii',0,4),'RIFF');
  return {text,seconds:1};
 }});
 const heard=await voice.transcribe(db,ctx,wav(),{transcriber:transcriber('  וויפיל שיך האבן מיר?  '),usageKey:'note-1'});
 assert.deepEqual(heard,{text:'וויפיל שיך האבן מיר?',truncated:false});
 await assert.rejects(voice.transcribe(db,ctx,wav(),{transcriber:transcriber(''),usageKey:'note-2'}),/No words were heard/);
 const usage=(await db.query(`SELECT status,detail->>'type' AS type FROM commercial_usage_events WHERE workspace_id=$1 AND meter='ai_work_credits'
  AND idempotency_key LIKE '%:ask-voice:%' ORDER BY occurred_at,id`,[ctx.workspaceId])).rows;
 assert.deepEqual(usage.map(row=>row.status),['COMMITTED','REVERSED'],'one charge for the note that was read, none for the silent one');
 await assert.rejects(voice.transcribe(db,ctx,Buffer.from('not audio'),{transcriber:transcriber('x')}),/WAV voice note/);
});

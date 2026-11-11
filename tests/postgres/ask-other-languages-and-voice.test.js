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

test('when the web service has no transcription key, the worker reads the voice note and the request gets the words',{timeout:180000},async t=>{
 const old=process.env.OPENAI_API_KEY;delete process.env.OPENAI_API_KEY;t.after(()=>{if(old!==undefined)process.env.OPENAI_API_KEY=old;});
 const f=await require('../helpers/agent-workflow-fixture').fixture(t);
 const {db,ctx}=f,voice=require('../../src/assistant/ask-voice'),budget=require('../../src/commercial/model-cost-budget');
 await f.subscribe('pro');
 const worker=text=>({name:'openai',model:'gpt-transcribe',providerVersion:'audio-2026-08-26',async transcribe(wave,{hold}){assert.ok(budget.useTranscriptionHold(hold));return {text,seconds:1};}});
 // The worker picks up the queued note, as the job runner would.
 const work=async text=>{for(let n=0;n<100;n++){const job=(await db.query("SELECT j.id,j.workspace_id,j.payload FROM stockchief_runtime.jobs j JOIN stockchief_runtime.ask_voice_notes n ON n.workspace_id=j.workspace_id AND n.job_id=j.id WHERE j.workspace_id=$1 AND j.kind=$2 AND n.state='QUEUED' LIMIT 1",[ctx.workspaceId,voice.kind])).rows[0];
  if(job){return voice.run({id:job.id,workspaceId:job.workspace_id,payload:job.payload},db,{transcriber:worker(text)}).catch(error=>error);}
  await new Promise(r=>setTimeout(r,100));}throw new Error('no voice note was queued');};
 const [heard]=await Promise.all([voice.read(db,ctx,wav(),{usageKey:'worker-note',waitMs:20000,pollMs:100}),work('כמה זוגות נעליים יש לנו?')]);
 assert.deepEqual(heard,{text:'כמה זוגות נעליים יש לנו?',truncated:false});
 const saved=(await db.query('SELECT state,content IS NULL AS cleared FROM stockchief_runtime.ask_voice_notes WHERE workspace_id=$1',[ctx.workspaceId])).rows;
 assert.deepEqual(saved,[{state:'READY',cleared:true}],'the audio is not kept once the words are back');
 const [silent]=await Promise.all([voice.read(db,ctx,wav(),{usageKey:'worker-silent',waitMs:20000,pollMs:100}).catch(error=>error),work('')]);
 assert.match(silent.message,/No words were heard/,'the worker\'s reason reaches the person');
});

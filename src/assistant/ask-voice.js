'use strict';
// A voice note for Ask: a recording of up to two minutes, read into text in
// whatever language was spoken (Yiddish, English, Hebrew, Spanish and others),
// then placed in the question box to check before it is sent. Reading it costs
// what one question costs, and nothing is charged when no words come back.
//
// It reuses the checked recording format (documents/voice-wave.js), the
// transcription provider and its price bound, the same as receiving voice notes.
const crypto=require('node:crypto');
const waveform=require('../documents/voice-wave');
const {ValidationError}=require('../domain/errors');

const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const MAX_TEXT=2000; // the question box holds 2,000 characters
// What to expect: questions to an inventory app, spoken in Yiddish, English or
// Hebrew, often mixed. Yiddish and Hebrew are written in Hebrew letters.
const PROMPT='A question to StockChief, an inventory app: stock, orders, customers, suppliers, products, reports, settings. It may be spoken in Yiddish, English or Hebrew, often mixed. ווייז מיר די אָרדערס. נעם מיר צו סטאק. How many do we have in stock?';

function available(){return Boolean(process.env.OPENAI_API_KEY);}

async function transcribe(db,ctx,buffer,{transcriber,usageKey}={}){
  const {wave,seconds}=waveform.validate(buffer);
  if(!transcriber&&!available())throw new ValidationError('Voice notes are not available right now. Type the question instead.');
  transcriber ||=require('../ai/providers/openai-transcription').create();
  const usage=require('../commercial/entitlements'),cost=require('../commercial/model-cost-budget');
  const scope={...await usage.ownerScopeForWorkspace(db,ctx.workspaceId),actorId:ctx.actorId};
  // One recording sent twice is one charge: the key follows the sound and the composer's request.
  const key=ctx.workspaceId+':ask-voice:'+digest(wave).slice(0,32)+':'+digest(String(usageKey||'')).slice(0,16);
  const policy=await require('../commercial/ai-credit-policy').policy(db,scope);
  const tariff=(await db.query("SELECT units FROM commercial_operation_policies WHERE operation='ask'")).rows[0];
  if(!tariff)throw new ValidationError('Voice notes have no usage policy.');
  const meter={meter:'ai_work_credits',idempotencyKey:key};
  await usage.reserveUsage(db,scope,{...meter,units:Number(tariff.units)*policy.scale,detail:{operation:'ask',type:'voice_note',creditPolicy:policy}});
  let held=false,started=false;
  try{
    const hold=await cost.reserveTranscription(db,scope,transcriber,seconds,key);held=true;
    started=true;
    const read=await transcriber.transcribe(wave,{hold,prompt:PROMPT});
    if(Number.isFinite(read.seconds)&&read.seconds>=0){
      await require('../commercial/control-service').recordCost(db,scope,{provider:transcriber.name,model:transcriber.model,
        providerVersion:transcriber.providerVersion,operation:'audio_transcription',unit:'second',quantity:read.seconds,
        idempotencyKey:key+':duration',detail:{source:'provider_duration_receipt',type:'ask_voice_note'}});
    }
    const text=String(read.text||'').replace(/\s+/g,' ').trim();
    if(!text)throw new ValidationError('No words were heard in that recording. Try again a little closer to the microphone.');
    await cost.settle(db,scope,key);held=false;
    await usage.commitUsage(db,scope,{...meter,detail:{operation:'ask',type:'voice_note'}});
    return {text:text.slice(0,MAX_TEXT),truncated:text.length>MAX_TEXT};
  }catch(error){
    if(held){if(started)await cost.settle(db,scope,key,{failed:true});else await cost.release(db,scope,key);}
    await usage.reverseUsage(db,scope,{...meter,reason:'The voice note was not read.'}).catch(()=>{});
    throw error;
  }
}

// The web service reads a voice note itself when it holds the transcription
// key. Otherwise the worker — where the AI keys live — reads it, and this
// request waits for the words, so the person sees the same thing either way.
const table='stockchief_runtime.ask_voice_notes',kind='ask.read-voice-note.v1';
async function read(db,ctx,buffer,{usageKey,transcriber,waitMs=60000,pollMs=400}={}){
  if(transcriber||available())return transcribe(db,ctx,buffer,{transcriber,usageKey});
  const {wave}=waveform.validate(buffer),id=require('../lib/util').newId('askvoice');
  await db.transaction(async tx=>{
    await tx.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND created_at<now()-interval '1 day'`,[ctx.workspaceId]);
    const scoped={query:(...args)=>tx.query(...args),transaction:fn=>fn(tx)};
    const {job}=await require('../operations/postgres-job-queue').enqueue(scoped,{workspaceId:ctx.workspaceId,kind,idempotencyKey:id,
      payload:{id,actorId:ctx.actorId},maxAttempts:1,priority:20});
    await tx.query(`INSERT INTO ${table}(workspace_id,id,actor_user_id,job_id,usage_key,content) VALUES($1,$2,$3,$4,$5,$6)`,
      [ctx.workspaceId,id,ctx.actorId,job.id,String(usageKey||'').slice(0,200),wave]);
  },{isolation:'READ COMMITTED'});
  for(const deadline=Date.now()+waitMs;;){
    const row=(await db.query(`SELECT state,transcript,problem FROM ${table} WHERE workspace_id=$1 AND id=$2 AND actor_user_id=$3`,
      [ctx.workspaceId,id,ctx.actorId])).rows[0];
    if(row?.state==='READY'){const text=String(row.transcript||'');return {text:text.slice(0,MAX_TEXT),truncated:text.length>MAX_TEXT};}
    if(row?.state==='FAILED')throw new ValidationError(row.problem||'The voice note could not be read. Try again or type the question.');
    if(Date.now()>deadline)throw new ValidationError('Reading the voice note is taking longer than usual. Try again in a moment.');
    await new Promise(resolve=>setTimeout(resolve,pollMs));
  }
}
// The worker's side: read the saved recording, keep the words, clear the audio.
async function run(job,db,{transcriber}={}){
  const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId};
  const row=(await db.query(`SELECT content,usage_key,state FROM ${table} WHERE workspace_id=$1 AND id=$2 AND job_id=$3`,
    [ctx.workspaceId,job.payload.id,job.id])).rows[0];
  if(!row||row.state!=='QUEUED'||!row.content)return {id:job.payload.id,replayed:true};
  try{
    const heard=await transcribe(db,ctx,row.content,{transcriber,usageKey:row.usage_key});
    await db.query(`UPDATE ${table} SET state='READY',transcript=$3,content=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,job.payload.id,heard.text]);
    return {id:job.payload.id};
  }catch(error){
    await db.query(`UPDATE ${table} SET state='FAILED',problem=$3,content=NULL WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,job.payload.id,String(error.message||'The voice note could not be read.').slice(0,500)]);
    throw error;
  }
}

module.exports={available,transcribe,read,run,kind,MAX_TEXT};

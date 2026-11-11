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
    const read=await transcriber.transcribe(wave,{hold});
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

module.exports={available,transcribe,MAX_TEXT};

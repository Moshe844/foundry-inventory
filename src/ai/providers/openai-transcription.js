'use strict';

const {ProviderError}=require('../provider');

const model='gpt-transcribe';
const version='audio-2026-08-26';
const endpoint='https://api.openai.com/v1/audio/transcriptions';

function create({apiKey=process.env.OPENAI_API_KEY,fetcher:transcriptionFetch=fetch}={}){
  if(!apiKey)throw new ProviderError('Voice note transcription is unavailable.',{code:'transcription_unavailable'});
  return {name:'openai',model,providerVersion:version,async transcribe(wave,{hold}={}){
    if(!require('../../commercial/model-cost-budget').useTranscriptionHold(hold)){
      throw new ProviderError('Voice transcription needs a funded usage reservation.',{code:'commercial_meter_required',status:503});
    }
    const form=new FormData();
    form.set('model',model);
    form.set('file',new Blob([wave],{type:'audio/wav'}),'voice-note.wav');
    let response;
    try{
      response=await transcriptionFetch(endpoint,{
        method:'POST',headers:{authorization:'Bearer '+apiKey},body:form,signal:AbortSignal.timeout(45000)
      });
    }catch{
      throw new ProviderError('The transcription request did not return a receipt.',{code:'transcription_receipt_missing'});
    }
    if(!response.ok)throw new ProviderError(
      response.status===429?'The transcription service is busy. Try again shortly.':'The transcription service could not read this recording.',
      {code:response.status===429?'transcription_busy':'transcription_failed'});
    const result=await response.json().catch(()=>null);
    return {text:typeof result?.text==='string'?result.text.trim():'',
      seconds:result?.usage?.type==='duration'?result.usage.seconds:null};
  }};
}

module.exports={create,model,version};

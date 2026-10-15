'use strict';
// Host-only, non-generating preflight. At most two IDENTICAL count requests
// share the original 30-second deadline. Never retry generation, estimate a
// missing count, change input, upload data or contact an alternate origin.
const TOTAL_MS=30000,HEDGE_MS=7500,MAX_ATTEMPTS=2;
function createTokenCounter({apiKey,fetchImpl=fetch,afterDelay=setTimeout}){
 if(!apiKey)throw new Error('TOKEN_COUNT_CREDENTIAL_REQUIRED');
 return body=>new Promise((resolve,reject)=>{
  const encoded=JSON.stringify(body),cancel=new AbortController(),deadline=AbortSignal.timeout(TOTAL_MS),signal=AbortSignal.any([cancel.signal,deadline]);
  let started=0,finished=0,settled=false,timer,lastError;
  const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);deadline.removeEventListener('abort',expired);cancel.abort();error?reject(error):resolve(value);};
  const unavailable=reason=>Object.assign(new Error('CODEX_TOKEN_COUNT_UNAVAILABLE'),{code:'CODEX_TOKEN_COUNT_UNAVAILABLE',limitKind:'native_token_preflight',reason,preflightAttempts:started,upstreamAttempted:false});
  const expired=()=>done(unavailable('timeout'));deadline.addEventListener('abort',expired,{once:true});
  const temporary=error=>error.retryable===true||['AbortError','TimeoutError'].includes(error.name)||['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','EAI_AGAIN'].includes(error.cause?.code||error.code);
  const launch=async()=>{
   if(settled||started>=MAX_ATTEMPTS||deadline.aborted)return;started++;
   try{
    const response=await fetchImpl('https://api.openai.com/v1/responses/input_tokens',{
     method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:encoded,redirect:'error',signal});
    if(!response.ok){void response.body?.cancel().catch(()=>{});throw Object.assign(unavailable('http'),{status:response.status,requestId:response.headers.get('x-request-id'),retryable:!response.headers.has('retry-after')&&[500,502,503,504].includes(response.status)});}
    let text='';for await(const part of response.body){text+=Buffer.from(part).toString('utf8');if(Buffer.byteLength(text)>16000)throw new Error('TOKEN_COUNT_RESPONSE_LIMIT');}
    let count;try{count=JSON.parse(text);}catch{throw new Error('INVALID_CODEX_TOKEN_COUNT');}
    if(count?.object!=='response.input_tokens'||!Number.isSafeInteger(count.input_tokens)||count.input_tokens<1||count.input_tokens>1100000)throw new Error('INVALID_CODEX_TOKEN_COUNT');
    finished++;done(null,count);
   }catch(error){
    finished++;if(settled)return;lastError=error;
    if(deadline.aborted)return expired();
    if(!temporary(error))return done(error);
    if(started<MAX_ATTEMPTS){clearTimeout(timer);timer=afterDelay(()=>void launch(),250);return;}
    if(finished===started)done(Object.assign(unavailable('transport'),{status:lastError.status||null}));
   }
  };
  timer=afterDelay(()=>void launch(),HEDGE_MS);void launch();
 });
}
module.exports={createTokenCounter,policy:Object.freeze({totalTimeoutMs:TOTAL_MS,hedgeAfterMs:HEDGE_MS,maxPreflightAttempts:MAX_ATTEMPTS})};

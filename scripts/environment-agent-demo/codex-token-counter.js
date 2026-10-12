'use strict';
// Host-only preflight. No model generation, retries, uploads, alternate origins,
// remote history references or context rewriting. Failure never falls back to an
// unverified cheap estimate. The relay validates the result before reserving.
function createTokenCounter({apiKey,fetchImpl=fetch}){
 if(!apiKey)throw new Error('TOKEN_COUNT_CREDENTIAL_REQUIRED');
 return async body=>{
  const response=await fetchImpl('https://api.openai.com/v1/responses/input_tokens',{
   method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},
   body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Object.assign(new Error('CODEX_TOKEN_COUNT_UNAVAILABLE'),{status:response.status,requestId:response.headers.get('x-request-id')});
  let text='';for await(const part of response.body){text+=Buffer.from(part).toString('utf8');if(Buffer.byteLength(text)>16000)throw new Error('TOKEN_COUNT_RESPONSE_LIMIT');}
  try{return JSON.parse(text);}catch{throw new Error('INVALID_CODEX_TOKEN_COUNT');}
 };
}
module.exports={createTokenCounter};

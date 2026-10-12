'use strict';
const {toWireSchema}=require('../../src/foundry/schema-tools');
const {MODELS,usage}=require('./wire-policy');
// Canonical helper adapter. Uses the same local relay, commercial reservation and
// original schema validation as the native worker; never receives vendor secrets.
function createStructuredProvider(transport,{fetchImpl=fetch}={}){
 const url=new URL(transport.openaiBaseURL);
 if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw new Error('Local relay required.');
 return {name:'openai',model:MODELS.openai,async complete(request){
  if(request.commercial!==true)throw new Error('Canonical commercial reservation required.');
  const response=await fetchImpl(new URL('responses',transport.openaiBaseURL.endsWith('/')?transport.openaiBaseURL:transport.openaiBaseURL+'/'),{
   method:'POST',redirect:'error',signal:request.signal,headers:{authorization:`Bearer ${transport.token}`,'content-type':'application/json'},
   body:JSON.stringify({model:MODELS.openai,instructions:request.system,input:request.prompt,store:false,
    max_output_tokens:Math.min(request.maxOutputTokens||3000,3000),reasoning:{effort:'high'},
    text:{format:{type:'json_schema',name:'business_helper',strict:false,schema:toWireSchema(request.schema)}}})});
  if(!response.ok)throw Object.assign(new Error(`Structured relay stopped: ${response.status}`),{code:transport.lastBlock?.()?.code||'HELPER_RELAY_STOPPED'});
  const body=await response.json(),receipt=usage('openai',[body]);
  const tokens={provider:'openai',providerVersion:'responses-2026-10-11',model:MODELS.openai,
   inputTokens:Math.max(0,receipt.inputTokens-receipt.cacheReadTokens-receipt.cacheWrite5mTokens),outputTokens:receipt.outputTokens,
   cacheReadTokens:receipt.cacheReadTokens,cacheWrite5mTokens:receipt.cacheWrite5mTokens,cacheWrite1hTokens:receipt.cacheWrite1hTokens};
  try{
   if(body.status!=='completed')throw new Error(`Structured response stopped: ${body.status}`);
   const text=(body.output||[]).flatMap(item=>item.content||[]).filter(block=>block.type==='output_text').map(block=>block.text).join('');
   return {data:JSON.parse(text),usage:tokens};
  }catch(error){error.code='ai_invalid_output';error.usage=tokens;throw error;}
 }};
}
module.exports={createStructuredProvider};

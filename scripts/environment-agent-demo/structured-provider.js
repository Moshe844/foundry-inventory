'use strict';
const Anthropic=require('@anthropic-ai/sdk');
const {toWireSchema}=require('../../src/foundry/schema-tools');
const {MODELS,usage}=require('./wire-policy');
// The existing structured provider protocol, pointed exclusively at the shared
// relay. The adaptive controller and canonical engines remain unchanged.
function createStructuredProvider(transport,{effort='high'}={}){
 const url=new URL(transport.anthropicBaseURL);
 if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw new Error('Local relay required.');
 const client=new Anthropic({apiKey:transport.token,baseURL:transport.anthropicBaseURL,maxRetries:0,timeout:125000});
 return {name:'anthropic',model:MODELS.anthropic,async complete(request){
  if(request.commercial!==true)throw new Error('Canonical commercial reservation required.');
 const outputLimit=Math.min(request.maxOutputTokens||3000,3000),smallOutput=outputLimit<1024;
  const response=await client.messages.create({model:MODELS.anthropic,max_tokens:outputLimit,
   system:request.system,messages:[{role:'user',content:request.prompt}],thinking:{type:smallOutput?'disabled':'adaptive'},
   output_config:{...(!smallOutput?{effort}:{}),format:{type:'json_schema',schema:toWireSchema(request.schema)}}},
   {signal:request.signal,maxRetries:0});
  const receipt=usage('anthropic',[response]);
  const tokens={provider:'anthropic',providerVersion:'2023-06-01',model:MODELS.anthropic,inputTokens:receipt.raw.input_tokens,
   outputTokens:receipt.outputTokens,cacheReadTokens:receipt.cacheReadTokens,cacheWrite5mTokens:receipt.cacheWrite5mTokens,
   cacheWrite1hTokens:receipt.cacheWrite1hTokens};
  try{
   if(['refusal','max_tokens'].includes(response.stop_reason))throw new Error(`Structured response stopped: ${response.stop_reason}`);
   return {data:JSON.parse(response.content.filter(block=>block.type==='text').map(block=>block.text).join('')),usage:tokens};
  }catch(error){error.code='ai_invalid_output';error.stopReason=response.stop_reason;error.usage=tokens;throw error;}
 }};
}
module.exports={createStructuredProvider};

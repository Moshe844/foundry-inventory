'use strict';
// Transport policy, not a reasoning/context controller. Never trim native Codex
// history, synthesize a final turn, or choose an agent action here.
const wire=require('./wire-policy');
const policies=new WeakSet();
function forProfile(id){
const PROFILE=require('./codex-models').getProfile(id);
const MODEL=PROFILE.model,EFFORT=PROFILE.effort,VERSION='0.162.1';
// Verified standard short-context pricing, 2026-10-12. The input bound is below
// 180k, hence below the 272k long-context threshold. Include cache-write pricing.
const PRICES=PROFILE.prices;
const {nativePolicy,compactionTokenLimit}=require('./codex-models');
const MAX_INPUT_TOKENS=nativePolicy.maxInputTokens,REQUEST_CEILING_MICRO_USD=nativePolicy.requestCeilingMicroUsd;
if(wire.MAX_OUTPUT!==nativePolicy.maxOutputTokens)throw new Error('CODEX_OUTPUT_POLICY_MISMATCH');
// Economic window, not a replacement compactor. Leave native headroom for the
// next bounded tool round and the compaction request itself. Every compaction
// request still needs exact counting and the unchanged financial reservations.
const nativeCompactionTokenLimit=compactionTokenLimit(PROFILE);
const source=require('./codex-models').source;
function countRequest(body){
 const keys=['model','input','instructions','tools','tool_choice','parallel_tool_calls','reasoning','text'];
 return Object.fromEntries(keys.filter(key=>body[key]!==undefined).map(key=>[key,body[key]]));
}
function counted(normalized,count){
 if(count?.object!=='response.input_tokens'||!Number.isSafeInteger(count.input_tokens)||count.input_tokens<1||count.input_tokens>MAX_INPUT_TOKENS)
  throw new Error('INVALID_CODEX_TOKEN_COUNT');
 return {...normalized,inputTokens:count.input_tokens,
  upperBoundMicroUsd:Math.ceil(count.input_tokens*PRICES.input+normalized.outputTokens*PRICES.output)};
}
function normalize(input){
 if(input?.model!==MODEL||input.reasoning?.effort!==EFFORT)throw new Error('CODEX_MODEL_CONFIGURATION_MISMATCH');
 const keys=new Set(['model','stream','input','instructions','tools','tool_choice','parallel_tool_calls','reasoning','store','include',
  'prompt_cache_key','text','client_metadata','service_tier','max_output_tokens','prompt_cache_options','prompt_cache_retention']);
 for(const key of Object.keys(input))if(!keys.has(key))throw new Error('UNAPPROVED_CODEX_PARAMETER:'+key);
 function localTools(tools){for(const tool of tools||[]){
  if(tool.defer_loading)throw new Error('HOSTED_TOOLS_DISABLED');
  if(tool.type==='namespace')localTools(tool.tools);
  else if(!['function','custom'].includes(tool.type)||tool.defer_loading)throw new Error('HOSTED_TOOLS_DISABLED');
 }}
 localTools(input.tools);
 for(const item of input.input||[])if(item.type==='additional_tools')localTools(item.tools);
 // Reuse the established feature/image/output bounds without changing old Ask.
 const result=wire.normalize('openai',{...input,model:wire.MODELS.openai},{nativeTokenPreflight:true});
 result.body.model=MODEL;
 return result;
}
function receipt(value){
 if(value.returnedModel!==MODEL)throw new Error('CODEX_RETURNED_MODEL_MISMATCH');
 if(value.returnedServiceTier&&!['default','standard'].includes(value.returnedServiceTier))throw new Error('CODEX_RETURNED_SERVICE_TIER_MISMATCH');
 return {...value,conservativeMicroUsd:Math.ceil(value.inputTokens*PRICES.input+value.outputTokens*PRICES.output)};
}
const result=Object.freeze({MODEL,EFFORT,PROFILE,VERSION,PRICES,source,normalize,receipt,countRequest,counted,MAX_INPUT_TOKENS,REQUEST_CEILING_MICRO_USD,nativeCompactionTokenLimit});
policies.add(result);return result;
}
module.exports={...forProfile(process.env.STOCKCHIEF_CODEX_EVALUATION_PROFILE||'sol-high'),forProfile,isPolicy:value=>policies.has(value)};

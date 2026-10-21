'use strict';
const MODELS=Object.freeze({openai:'gpt-6.1-sol',anthropic:'claude-sonnet-5'});
// USD per million tokens == micro-USD per token. Charge the shared experiment
// conservatively at the highest standard price, including long-context caches.
const PRICES=Object.freeze({openai:{input:5,output:15},anthropic:{input:4,output:10}});
const MAX_OUTPUT=3000,MAX_BODY=2*1024*1024;

function finite(value){return Number.isSafeInteger(value)&&value>=0;}
function normalize(provider,input,{nativeTokenPreflight=false}={}){
 if(!MODELS[provider]||!input||typeof input!=='object'||Array.isArray(input))throw new Error('UNAPPROVED_PROVIDER');
 const body=structuredClone(input);
 if(body.model!==MODELS[provider])throw new Error('UNAPPROVED_MODEL');
 if(Buffer.byteLength(JSON.stringify(body))>MAX_BODY)throw new Error('REQUEST_TOO_LARGE');
 // Native Claude explicitly requests the Sonnet 5 default: retain all supplied
 // thinking blocks. This is NOT summary generation or hidden server history.
 // https://platform.claude.com/docs/en/build-with-claude/context-editing
 const keepThinking=provider==='anthropic'&&JSON.stringify(body.context_management)===
  JSON.stringify({edits:[{type:'clear_thinking_20251015',keep:'all'}]});
 // Hidden server context, hosted tools, cloud file references and alternate
 // service tiers require separate price bounds. They cannot silently enter.
 for(const key of ['previous_response_id','conversation','prompt','container','context_management','speed','mcp_servers'])
  if(body[key]!=null&&!(key==='context_management'&&keepThinking))throw new Error(`UNBOUNDED_FEATURE:${key}`);
 if(body.service_tier&&!['default','standard_only','auto'].includes(body.service_tier))throw new Error('UNAPPROVED_SERVICE_TIER');
 body.service_tier=provider==='openai'?'default':'standard_only';
 if(provider==='openai'){
  // These profiles reserve/cache-price 30-minute writes only. Request and
  // content-block overrides must not opt into a more expensive lifetime.
  // The older maximum-retention setting is independent of the write TTL.
  if(body.prompt_cache_options!=null&&(typeof body.prompt_cache_options!=='object'||Array.isArray(body.prompt_cache_options)||
    body.prompt_cache_options.ttl!=null&&body.prompt_cache_options.ttl!=='30m'))throw new Error('UNPRICED_CACHE_LIFETIME');
  body.store=false;
  if((body.tools||[]).some(tool=>!['function','custom',...(nativeTokenPreflight?['namespace']:[])].includes(tool.type)))throw new Error('HOSTED_TOOLS_DISABLED');
  if((body.tools||[]).some(tool=>tool.defer_loading))throw new Error('HIDDEN_TOOL_CONTEXT_DISABLED');
  if(body.max_output_tokens!=null&&(!finite(body.max_output_tokens)||body.max_output_tokens<1||body.max_output_tokens>MAX_OUTPUT))throw new Error('OUTPUT_LIMIT');
  body.max_output_tokens=body.max_output_tokens||MAX_OUTPUT;
 }else{
  // The native harness requests a progress-display beta. Use the documented
  // non-beta display mode without changing the model's reasoning effort.
  if(body.thinking?.display==='updates')body.thinking.display='omitted';
  if((body.tools||[]).some(tool=>tool.type&&tool.type!=='custom'))throw new Error('HOSTED_TOOLS_DISABLED');
  if(body.tools?.length&&body.tool_choice?.type!=='none')body.tool_choice={...(body.tool_choice||{type:'auto'}),disable_parallel_tool_use:true};
  if(body.max_tokens!=null&&(!finite(body.max_tokens)||body.max_tokens<1||body.max_tokens>MAX_OUTPUT))throw new Error('OUTPUT_LIMIT');
  body.max_tokens=body.max_tokens||MAX_OUTPUT;
 }
 let images=0,reasoningBlocks=0;
 function scan(value){
  if(Array.isArray(value))return value.map(scan);
  if(!value||typeof value!=='object')return value;
  if(['input_file','document','file','item_reference','compaction','redacted_thinking','server_tool_use','web_search_tool_result','mcp_tool_use','mcp_tool_result'].includes(value.type))throw new Error('UNBOUNDED_FILE_CONTEXT');
  // Signed/opaque reasoning can reconstruct more tokens than its wire bytes.
  // Every history item originates in this relay's <=3000-token responses; no
  // external session history, server references or compaction is accepted.
  if(value.type==='thinking'&&value.signature||value.type==='reasoning'&&value.encrypted_content){
   if(++reasoningBlocks>48&&!nativeTokenPreflight)throw new Error('REASONING_HISTORY_LIMIT');
  }
  if(value.type==='image'||value.type==='input_image'){
   let base64;
   if(provider==='openai'&&typeof value.image_url==='string'&&value.image_url.startsWith('data:image/png;base64,'))base64=value.image_url.slice(22);
   else if(provider==='anthropic'&&value.source?.type==='base64'&&value.source.media_type==='image/png')base64=value.source.data;
   else throw new Error('ONLY_BOUNDED_INLINE_PNG_IMAGES');
   const bytes=Buffer.from(base64||'','base64');
   if(bytes.length<24||bytes.readUInt32BE(0)!==0x89504e47||bytes.readUInt32BE(4)!==0x0d0a1a0a||bytes.toString('ascii',12,16)!=='IHDR')throw new Error('INVALID_PNG');
   const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
   if(width<1||height<1||width>1280||height>900||++images>4&&!nativeTokenPreflight)throw new Error('IMAGE_LIMIT');
   // 20k tokens is deliberately above a screenshot's documented patch/tile
   // budget. This allowance is in addition to wire bytes and protocol overhead.
   return {type:'bounded_image',tokenUpperBound:20000};
  }
  const copy={};for(const [key,child]of Object.entries(value)){
   if(provider==='openai'&&key==='prompt_cache_breakpoint'&&child!=null&&
     (typeof child!=='object'||Array.isArray(child)||child.ttl!=null&&child.ttl!=='30m'))throw new Error('UNPRICED_CACHE_LIFETIME');
   if(['file_id','file_url','video_url','audio'].includes(key))throw new Error('UNBOUNDED_REMOTE_INPUT');
   copy[key]=scan(child);
  }
  return copy;
 }
 const counted=scan(body);
 const inputTokens=Buffer.byteLength(JSON.stringify(counted))+8192+images*20000+reasoningBlocks*MAX_OUTPUT;
 if(inputTokens>180000&&!nativeTokenPreflight)throw new Error('INPUT_LIMIT');
 const outputTokens=provider==='openai'?body.max_output_tokens:body.max_tokens;
 // Native callers MUST obtain an exact count. A byte estimate is neither a
 // token admission decision nor a spending reservation for that path.
 return {body,inputTokens:nativeTokenPreflight?null:inputTokens,outputTokens,
  upperBoundMicroUsd:nativeTokenPreflight?null:inputTokens*PRICES[provider].input+outputTokens*PRICES[provider].output};
}

function usage(provider,events){
 let raw=null,complete=false,model=null,tier=null;
 for(const event of events){
  model=event.response?.model||event.message?.model||event.model||model;
  tier=event.response?.service_tier||event.service_tier||tier;
  if(provider==='openai'){
   if(['response.completed','response.incomplete','response.failed'].includes(event.type)){
    raw=event.response?.usage;complete=true;
   }else if(event.object==='response'&&event.usage){raw=event.usage;complete=true;}
  }else{
   if(event.type==='message_start')raw={...event.message?.usage};
   if(event.type==='message_delta')raw={...raw,...event.usage};
   if(event.type==='message_stop')complete=true;
   if(event.type==='message'&&event.usage){raw=event.usage;complete=true;}
  }
 }
 if(!complete||!raw||!finite(raw.input_tokens)||!finite(raw.output_tokens))throw new Error('UNKNOWN_USAGE');
 const cacheRead=provider==='openai'?raw.input_tokens_details?.cached_tokens||0:raw.cache_read_input_tokens||0;
 const cacheWrite1h=provider==='openai'?0:raw.cache_creation?.ephemeral_1h_input_tokens||0;
 const cacheWrite5m=provider==='openai'?raw.input_tokens_details?.cache_write_tokens||0:
  raw.cache_creation?.ephemeral_5m_input_tokens??Math.max(0,(raw.cache_creation_input_tokens||0)-cacheWrite1h);
 const cacheDetails=provider==='openai'?raw.input_tokens_details?.cache_write_tokens_details:null;
 if(cacheDetails!=null&&(!finite(cacheDetails.ttl_30m_tokens)||!finite(cacheDetails.ttl_12h_tokens)||
   cacheDetails.ttl_30m_tokens+cacheDetails.ttl_12h_tokens!==cacheWrite5m))throw new Error('INVALID_CACHE_USAGE');
 if(cacheDetails?.ttl_12h_tokens)throw new Error('UNPRICED_CACHE_LIFETIME');
 if(![cacheRead,cacheWrite5m,cacheWrite1h].every(finite))throw new Error('UNKNOWN_CACHE_USAGE');
 const allInput=provider==='openai'?raw.input_tokens:raw.input_tokens+cacheRead+cacheWrite5m+cacheWrite1h;
 if(provider==='openai'&&cacheRead+cacheWrite5m+cacheWrite1h>allInput)throw new Error('INVALID_CACHE_USAGE');
 return {raw,returnedModel:model,returnedServiceTier:tier,inputTokens:allInput,outputTokens:raw.output_tokens,cacheReadTokens:cacheRead,cacheWrite5mTokens:cacheWrite5m,cacheWrite1hTokens:cacheWrite1h,
  conservativeMicroUsd:allInput*PRICES[provider].input+raw.output_tokens*PRICES[provider].output};
}
class UsageParser{
 constructor(provider){this.provider=provider;this.pending='';this.events=[];this.bytes=0;this.decoder=new TextDecoder();this.eventCount=0;this.terminalStatus=null;this.failureCode=null;this.usagePresent=false;this.streamEnded=false;
  this.response=new (require('./finalization').ResponseState)(provider);}
 append(chunk){this.bytes+=chunk.byteLength;if(this.bytes>8*1024*1024)throw new Error('RESPONSE_LIMIT');
  this.pending+=this.decoder.decode(chunk,{stream:true});
  for(;;){const boundary=this.pending.search(/\r?\n\r?\n/);if(boundary<0)break;
   const frame=this.pending.slice(0,boundary);this.pending=this.pending.slice(boundary).replace(/^\r?\n\r?\n/,'');
   const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
   if(data&&data!=='[DONE]'){try{const event=JSON.parse(data);this.observe(event);if(event.usage||event.response?.usage||event.message?.usage||event.type==='message_stop')this.events.push(event);}catch{throw new Error('MALFORMED_USAGE_STREAM');}}
  }
 }
 finish(){this.streamEnded=true;this.pending+=this.decoder.decode();if(this.pending.trim()){
   try{const event=JSON.parse(this.pending);this.observe(event);this.events.push(event);}catch{throw new Error('INCOMPLETE_USAGE_STREAM');}}
  return usage(this.provider,this.events);
 }
 observe(event){
  this.eventCount++;
  const response=event.response||event;
  if(['completed','incomplete','failed'].includes(response.status))this.terminalStatus=response.status;
  if(event.usage||event.response?.usage||event.message?.usage)this.usagePresent=true;
  const code=response.error?.code||event.error?.code;
  if(code)this.failureCode=['server_error','rate_limit_exceeded','invalid_prompt','data_residency_mismatch','bio_policy','misalignment_policy_violation','vector_store_timeout','invalid_image','invalid_image_format','invalid_base64_image','invalid_image_url','image_too_large','image_too_small','image_parse_error','image_content_policy_violation','invalid_image_mode','image_file_too_large','unsupported_image_media_type','empty_image_file','failed_to_download_image','image_file_not_found'].includes(code)?code:'unrecognized_provider_error';
  const id=this.provider==='openai'?(event.response||event).id:(event.message||event).id;
  if(typeof id==='string'&&/^(resp|msg)_[A-Za-z0-9_-]{1,180}$/.test(id))this.responseId=id;
  this.response.observe(event);
 }
 diagnostics(){return {eventCount:this.eventCount,streamEnded:this.streamEnded,terminalStatus:this.terminalStatus,failureCode:this.failureCode,usagePresent:this.usagePresent};}
}
module.exports={MODELS,PRICES,MAX_OUTPUT,MAX_BODY,normalize,usage,UsageParser};

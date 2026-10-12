'use strict';
const http=require('node:http');
const {randomBytes}=require('node:crypto');
const {once}=require('node:events');
const wire=require('./wire-policy');
const ENDPOINTS={openai:'https://api.openai.com/v1/responses',anthropic:'https://api.anthropic.com/v1/messages'};

// Host-only credential broker. Agents receive an opaque, goal-bound token, never
// API credentials. Responses are released only AFTER durable cost settlement.
// SDK retries are independent requests through the same cross-process ledger.
async function createRelay({budget,credentials,commercial,fetchImpl=fetch,timeoutMs=120000,audit=()=>{},allowedProviders=['openai','anthropic'],countCodexInput=null}){
 // Same Windows certificate trust used by StockChief's existing provider.
 // Verification stays enabled; never substitute NODE_TLS_REJECT_UNAUTHORIZED.
 require('../../src/net-trust').installSystemCertificates();
 if(!commercial?.begin||!commercial?.complete||!commercial?.unknown||!commercial?.release)
  throw new Error('Commercial request accounting is required.');
 const grants=new Map();let active=0;
 const server=http.createServer(async(req,res)=>{
  let id=null,held=null,attempted=false,settled=false,grant=null,control=null;const start=Date.now();
  try{
   const token=req.headers.authorization?.replace(/^Bearer /,'')||req.headers['x-api-key'];
    grant=grants.get(token);if(!grant)throw new Error('UNAUTHORIZED_RELAY');
    if(!allowedProviders.includes(grant.provider))throw new Error('PROVIDER_DISABLED_FOR_RUN');
   const paths={openai:'/openai/v1/responses',anthropic:'/anthropic/v1/messages'};
   const url=new URL(req.url,'http://127.0.0.1');
   if(grant.wireProfile==='codex'&&url.pathname==='/openai/v1/responses/compact')
    throw new Error('CODEX_COMPACTION_UNBOUNDED_OUTPUT');
   if(req.method!=='POST'||url.pathname!==paths[grant.provider]||
    [...url.searchParams].some(([key,value])=>grant.provider!=='anthropic'||key!=='beta'||value!=='true'))
    throw new Error(`UNAPPROVED_ENDPOINT:${url.pathname}`);
   if(active)throw new Error('UNRESOLVED_MODEL_CALL');
   active++; // includes body reads and commercial preflight, not just network time
   try{
    let size=0;const parts=[];
    for await(const part of req){size+=part.length;if(size>wire.MAX_BODY)throw new Error('REQUEST_TOO_LARGE');parts.push(part);}
    await grant.authorize(); // current lease, tenant, actor and original authority
    if(grant.livePermit){
     require('./codex-live-permit').assert(grant.livePermit,{budget,task:grant.task});
     if(grant.lastBlock)throw new Error('CODEX_ATTEMPT_ALREADY_STOPPED');
    }
    if(grant.wireProfile!=='codex'&&grant.lastResponse?.empty)throw Object.assign(new Error(require('./finalization').EMPTY_MESSAGE),{code:'EMPTY_MODEL_FINAL'});
    const input=JSON.parse(Buffer.concat(parts).toString('utf8'));
    const outputTokens=grant.provider==='openai'?input.max_output_tokens||wire.MAX_OUTPUT:input.max_tokens||wire.MAX_OUTPUT;
    const nativeCodex=grant.wireProfile==='codex';
    const fitOptions=nativeCodex?null:{memory:await grant.contextSource?.(),
     maxInputTokens:Math.min(60000,await commercial.inputAllowance?.({provider:grant.provider,outputTokens})??60000)};
    const fit=value=>nativeCodex?require('./codex-wire').normalize(value):grant.accountingMode==='native'?require('./wire-context').fit(grant.provider,value,fitOptions):wire.normalize(grant.provider,value);
    let normalized=fit(input);
    require('./protocol').validate(grant.provider,normalized.body);
    const requestHash=nativeCodex?require('node:crypto').createHash('sha256').update(JSON.stringify({
     input:require('./codex-wire').countRequest(normalized.body),outputTokens:normalized.outputTokens,stream:normalized.body.stream,
     serviceTier:normalized.body.service_tier})).digest('hex'):null;
    if(nativeCodex){
     if(typeof countCodexInput!=='function')throw new Error('NATIVE_TOKEN_PREFLIGHT_REQUIRED');
     if(credentials.openai!=='FAKE'&&!grant.nativeSession)throw new Error('DURABLE_CODEX_SESSION_REQUIRED');
     const replay=await grant.nativeSession?.codexReplay(requestHash);
     if(replay){grant.lastResponse=replay.outcome;audit({kind:'codex_response_replayed',requestHash,paidCalls:0});
      res.writeHead(replay.status,{'content-type':replay.contentType,'cache-control':'no-store'});res.end(replay.body);return;}
     await grant.requestGate();
     if(countCodexInput){
      const state=await budget.status();
      if(!state.approval||state.stopped||state.expires<=Date.now())throw new Error('PAID_TESTING_LOCKED');
      if(state.unresolved)throw new Error('UNRESOLVED_MODEL_CALL');
      const codex=require('./codex-wire'),countBody=codex.countRequest(normalized.body);
      const count=await countCodexInput(structuredClone(countBody));
      normalized=codex.counted(normalized,count);
      audit({kind:'codex_input_count',inputTokens:normalized.inputTokens,
       maxOutputTokens:normalized.outputTokens,upperBoundMicroUsd:normalized.upperBoundMicroUsd,
       requestHash:require('node:crypto').createHash('sha256').update(JSON.stringify(countBody)).digest('hex')});
      if(normalized.upperBoundMicroUsd>codex.REQUEST_CEILING_MICRO_USD)throw Object.assign(new Error('CODEX_REQUEST_COST_CEILING'),{limitKind:'operation_cost'});
     }
    }
    if(grant.controlSource){
     const final=fit(require('./finalization').request(grant.provider,input));
     require('./protocol').validate(grant.provider,final.body);
     // Preserve room for an answer before another exploratory request. Both
     // variants still cross every unchanged shared/commercial reservation gate.
     const allowance=await (budget.candidateStatus?.(grant.candidate)||budget.status());
     const room=Math.min(allowance.remaining,await commercial.goalRemainingMicroUsd?.(grant)??Infinity);
     control=await grant.controlSource({budgetFinal:normalized.upperBoundMicroUsd+final.upperBoundMicroUsd>room});
     if(control.final)normalized=final;
     audit({kind:'model_control',...control,remainingMicroUsd:room,requestBoundMicroUsd:normalized.upperBoundMicroUsd});
    }
    if(normalized.context)audit({kind:'wire_context',provider:grant.provider,...normalized.context,inputTokenBound:normalized.inputTokens});
    id=await budget.reserve({candidate:grant.candidate,task:grant.task,upperBoundMicroUsd:normalized.upperBoundMicroUsd});
    held=await commercial.begin({...grant,id,...normalized});
    const secret=credentials[grant.provider];if(!secret)throw new Error('PROVIDER_CREDENTIAL_UNAVAILABLE');
    const headers={'content-type':'application/json',...(grant.provider==='openai'
     ?{authorization:`Bearer ${secret}`}:{'x-api-key':secret,'anthropic-version':'2023-06-01',
      ...(normalized.body.context_management?{'anthropic-beta':'context-management-2025-06-27'}:{})})};
    // Do not forward caller headers, beta features, destinations or redirect auth.
    if(nativeCodex)await grant.nativeSession?.codexPending(requestHash);
    attempted=true;
    const response=await fetchImpl(ENDPOINTS[grant.provider],{method:'POST',headers,redirect:'error',
     body:JSON.stringify(normalized.body),signal:AbortSignal.timeout(timeoutMs)});
    const parser=new wire.UsageParser(grant.provider);const output=[];
    for await(const chunk of response.body){parser.append(chunk);output.push(Buffer.from(chunk));}
    // Error responses and interrupted calls have no reliable charge receipt.
    // Fail closed, retain their complete reservation, and prevent SDK retry spend.
    if(!response.ok){
     let type=null,message=null;try{const error=JSON.parse(Buffer.concat(output).toString('utf8')).error;
      type=error?.type||null;message=String(error?.message||'').replaceAll(secret,'[redacted]').slice(0,600);
     }catch{}
     audit({kind:'provider_rejection',status:response.status,provider:grant.provider,type,message});
     throw new Error(`UPSTREAM_STATUS_${response.status}`);
    }
    const parsedReceipt=parser.finish();
    const receipt=nativeCodex?require('./codex-wire').receipt(parsedReceipt):parsedReceipt;
    if(receipt.inputTokens>normalized.inputTokens||receipt.outputTokens>normalized.outputTokens){
     await budget.stop();throw new Error('TOKEN_BOUND_VIOLATION');
    }
    await commercial.complete(held,receipt);
    await budget.settle(id,receipt.conservativeMicroUsd,{provider:grant.provider,model:normalized.body.model,
     usage:receipt.raw,latencyMs:Date.now()-start,accounting:'conservative standard-price charge'});
    settled=true;
    audit({kind:'model_call',id,candidate:grant.candidate,task:grant.task,usage:receipt,
     latencyMs:Date.now()-start,source:'native_sdk_http'});
    const outcome={...parser.response.result(),request:control?.request||null,final:Boolean(control?.final),usageSettled:true};
    grant.lastResponse=outcome;
    if(nativeCodex)await grant.nativeSession?.codexDelivered(requestHash,{status:response.status,
     contentType:response.headers.get('content-type')||'application/json',body:Buffer.concat(output).toString('utf8'),outcome},outcome);
    // Persist before acknowledging the SDK. A restarted SDK cannot turn an
    // empty terminal response into an unapproved paid continuation.
    await grant.responseSink?.(outcome);
    audit({kind:'model_response',id,provider:grant.provider,...outcome});
    // Codex owns continuation of incomplete/reasoning-only responses. It still
    // crosses every request/goal/period hold; the legacy forced-final controller
    // must not turn a settled native response into a fabricated transport error.
    if(outcome.empty&&!nativeCodex)throw Object.assign(new Error(require('./finalization').EMPTY_MESSAGE),{code:'EMPTY_MODEL_FINAL'});
    res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json',
     'cache-control':'no-store'});res.end(Buffer.concat(output));
   }finally{active--;}
  }catch(error){
   // Never expose provider responses, secrets, SQL or internal stack traces.
   const reason=String(error.code||error.message||'RELAY_FAILURE').slice(0,180);
   const finalGate=['EMPTY_MODEL_FINAL','FINAL_REQUEST_EXHAUSTED'].includes(reason);
   const message=reason==='EMPTY_MODEL_FINAL'?require('./finalization').EMPTY_MESSAGE:
    reason==='FINAL_REQUEST_EXHAUSTED'?'StockChief already used the final request allowance. No additional provider call was made.':
    'StockChief model budget or authority gate stopped this request.';
   if(grant)grant.lastBlock={code:reason,limitKind:error.limitKind||null,upstreamAttempted:attempted,usageSettled:settled,message};
   if(id&&!settled){
    if(attempted){await budget.unknown(id,reason);if(held)await commercial.unknown(held,reason).catch(()=>budget.stop());}
    else {if(held)await commercial.release(held).catch(()=>budget.stop());await budget.settle(id,0,{reason,upstreamAttempted:false});}
   }
   audit({kind:'model_call_blocked',id,reason,limitKind:error.limitKind||null,
    reasonDetail:error.code==='rate_limited'?String(error.message).slice(0,240):null,
    transportCode:error.cause?.code||null,upstreamAttempted:attempted,usageSettled:settled});
   const contextGate=reason==='CONTEXT_BUDGET_EXHAUSTED'||error.limitKind==='operation_cost';
   if(!res.headersSent)res.writeHead(contextGate||finalGate?400:403,{'content-type':'application/json'});
   res.end(JSON.stringify({error:{type:contextGate||finalGate?'invalid_request_error':'permission_error',
    code:finalGate?reason:contextGate?'STOCKCHIEF_CONTEXT_COST_LIMIT':'STOCKCHIEF_GATE_STOPPED',
    message:contextGate?'StockChief cannot fit this context within the unchanged operation cost limit. No provider call was made.':
     message}}));
  }
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${server.address().port}`;
 return {
  grant({candidate,task,provider,authorize,fundingKey,goalId,ctx,accountingMode='native',wireProfile=null,requestGate=null,livePermit=null}){
   if(!wire.MODELS[provider]||typeof authorize!=='function'||!goalId||!ctx||!fundingKey)throw new Error('A funded, authorized durable goal is required.');
   if(!['native','existing'].includes(accountingMode))throw new Error('Unsupported commercial accounting mode.');
   if(wireProfile!==null&&(wireProfile!=='codex'||provider!=='openai'||accountingMode!=='native'||typeof requestGate!=='function'))throw new Error('INVALID_CODEX_GATE');
   if(wireProfile==='codex'&&credentials.openai!=='FAKE'){
    require('./codex-live-permit').assert(livePermit,{budget,task});
    if(typeof countCodexInput!=='function')throw new Error('NATIVE_TOKEN_PREFLIGHT_REQUIRED');
   }
   const token=randomBytes(32).toString('hex');grants.set(token,{candidate,task,provider,authorize,fundingKey,goalId,ctx,accountingMode,wireProfile,requestGate,livePermit});
   return {token,openaiBaseURL:origin+'/openai/v1',anthropicBaseURL:origin+'/anthropic',
    setContextSource:source=>{if(wireProfile==='codex')throw new Error('NATIVE_CODEX_CONTEXT_OWNED_BY_SDK');if(typeof source!=='function')throw new Error('Host context source required.');grants.get(token).contextSource=source;},
    setControlSource:source=>{if(wireProfile==='codex')throw new Error('NATIVE_CODEX_CONTROL_OWNED_BY_SDK');if(typeof source!=='function')throw new Error('Host control source required.');grants.get(token).controlSource=source;},
    setResponseSink:sink=>{if(typeof sink!=='function')throw new Error('Host response sink required.');grants.get(token).responseSink=sink;},
    lastBlock:()=>grants.get(token)?.lastBlock||null,
    lastResponse:()=>grants.get(token)?.lastResponse||null,
    setNativeSession:session=>{const identity=session?.identity;
     if(wireProfile!=='codex'||!session?.codexReplay||!session?.codexPending||!session?.codexDelivered||
      identity?.goalId!==goalId||identity.workspaceId!==ctx.workspaceId||identity.actorId!==ctx.actorId||identity.candidate!==candidate)
      throw new Error('INVALID_CODEX_SESSION');
     if(livePermit)require('./codex-live-permit').bind(livePermit,identity);grants.get(token).nativeSession=session;},
    allCallsMetered:true,commercialGoalBudgetEnforced:true,revoke:()=>grants.delete(token)};
  },
  async close(){grants.clear();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 };
}
module.exports={createRelay};

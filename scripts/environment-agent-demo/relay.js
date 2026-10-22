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
  let id=null,held=null,attempted=false,settled=false,grant=null,control=null,callDetail={},providerStarted=null,providerSignal=null,parser=null,receipt=null;
  const start=Date.now(),timings={},transport={phase:'admission',receivedBytes:0};
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
    // Independent read-only checks may overlap. Join BOTH before decoding,
    // reserving, counting tokens or invoking a provider; no digest or authority
    // is cached. Keep failure ordering and every financial boundary unchanged.
    const gateChecks=await Promise.allSettled([
     (async()=>{const at=Date.now();try{return await grant.authorize();}finally{timings.authorizationMs=Date.now()-at;}})(),
     (async()=>{if(!grant.livePermit)return;const at=Date.now();try{
      await require('./codex-live-permit').assertFresh(grant.livePermit,{budget,task:grant.task});
      if(grant.lastBlock)throw new Error('CODEX_ATTEMPT_ALREADY_STOPPED');
     }finally{timings.sourceIntegrityMs=Date.now()-at;}})()]);
    for(const check of gateChecks)if(check.status==='rejected')throw check.reason;
    const admissionAccess=gateChecks[0].value; // fresh for this exact HTTP boundary
    if(grant.lastResponse?.failed)throw Object.assign(new Error('The provider reported a failed response.'),{code:'PROVIDER_RESPONSE_FAILED'});
    if(grant.wireProfile!=='codex'&&grant.lastResponse?.empty)throw Object.assign(new Error(require('./finalization').EMPTY_MESSAGE),{code:'EMPTY_MODEL_FINAL'});
    const input=JSON.parse(Buffer.concat(parts).toString('utf8'));
    const outputTokens=grant.provider==='openai'?input.max_output_tokens||wire.MAX_OUTPUT:input.max_tokens||wire.MAX_OUTPUT;
    const nativeCodex=grant.wireProfile==='codex';let codex=grant.codexPolicy;
    const fitOptions=nativeCodex?null:{memory:await grant.contextSource?.(),
     maxInputTokens:Math.min(60000,await commercial.inputAllowance?.({provider:grant.provider,outputTokens})??60000)};
    const fit=value=>nativeCodex?codex.normalize(value):grant.accountingMode==='native'?require('./wire-context').fit(grant.provider,value,fitOptions):wire.normalize(grant.provider,value);
    let normalized=fit(input);
    if(nativeCodex&&grant.ctx?.workspaceId&&grant.ctx?.actorId){
     // Native threads still own reasoning/context. Cache accounting belongs to
     // the tenant and actor, not a freshly generated mission UUID. This changes
     // no input, tool, reasoning, retention, response or financial bound.
     normalized.body.prompt_cache_key=require('node:crypto').createHash('sha256')
      .update(JSON.stringify([grant.ctx.workspaceId,grant.ctx.actorId,normalized.body.model])).digest('hex');
    }
    require('./protocol').validate(grant.provider,normalized.body);
    const hashRequest=value=>require('node:crypto').createHash('sha256').update(JSON.stringify({
     input:require('./codex-wire').countRequest(value.body),outputTokens:value.outputTokens,stream:value.body.stream,
     serviceTier:value.body.service_tier})).digest('hex');
    let requestHash=nativeCodex?hashRequest(normalized):null;
    if(nativeCodex){
     if(typeof countCodexInput!=='function')throw new Error('NATIVE_TOKEN_PREFLIGHT_REQUIRED');
     if(credentials.openai!=='FAKE'&&!grant.nativeSession)throw new Error('DURABLE_CODEX_SESSION_REQUIRED');
     const sessionStarted=Date.now();
     const replay=await grant.nativeSession?.codexReplay(requestHash,admissionAccess);
     if(replay){grant.lastResponse=replay.outcome;audit({kind:'codex_response_replayed',requestHash,paidCalls:0});
      res.writeHead(replay.status,{'content-type':replay.contentType,'cache-control':'no-store'});res.end(replay.body);return;}
     // Both processing choices preserve the exact semantic request. A settled
     // receipt from either remains reusable; a pending/unknown one still blocks.
     const preferred=grant.preferredCodexPolicy,preferredNormalized=preferred?.normalize(input);
     // Both processing choices belong to the same host-authorized tenant and
     // actor. Re-normalizing the preferred request must not discard that cache
     // identity or restore the SDK's per-thread/client-supplied value.
     if(preferredNormalized&&normalized.body.prompt_cache_key)preferredNormalized.body.prompt_cache_key=normalized.body.prompt_cache_key;
     const preferredHash=preferredNormalized?hashRequest(preferredNormalized):null;
     if(preferredHash&&preferredHash!==requestHash){const saved=await grant.nativeSession?.codexReplay(preferredHash,admissionAccess);
      if(saved){grant.lastResponse=saved.outcome;audit({kind:'codex_response_replayed',requestHash:preferredHash,paidCalls:0});res.writeHead(saved.status,{'content-type':saved.contentType,'cache-control':'no-store'});res.end(saved.body);return;}}
     await grant.requestGate(admissionAccess);
     timings.sessionAdmissionMs=Date.now()-sessionStarted;
     if(countCodexInput){
      const state=await budget.status();
      if(!state.approval||state.stopped||state.expires<=Date.now())throw new Error('PAID_TESTING_LOCKED');
      if(state.unresolved)throw new Error('UNRESOLVED_MODEL_CALL');
      const countBody=codex.countRequest(normalized.body);
      const countStarted=Date.now(),count=await countCodexInput(structuredClone(countBody));
      timings.tokenPreflightMs=Date.now()-countStarted;
      const goalRoom=await commercial.goalRemainingMicroUsd?.(grant)??Infinity;
      const processingRoom=Math.min(state.remaining,goalRoom);
      if(preferred){const faster=preferred.counted(preferredNormalized,count);
       if(faster.upperBoundMicroUsd<=Math.min(preferred.REQUEST_CEILING_MICRO_USD,processingRoom)){codex=preferred;normalized=faster;requestHash=preferredHash;}
       else normalized=codex.counted(normalized,count);
      }else normalized=codex.counted(normalized,count);
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
    const reservationStarted=Date.now();
    callDetail={provider:grant.provider,model:normalized.body.model,requestedServiceTier:normalized.body.service_tier||null,
     inputTokenBound:normalized.inputTokens,outputTokenBound:normalized.outputTokens,requestHash};
    id=await budget.reserve({candidate:grant.candidate,task:grant.task,upperBoundMicroUsd:normalized.upperBoundMicroUsd,detail:callDetail});
    timings.budgetReservationMs=Date.now()-reservationStarted;
    const commercialStarted=Date.now();
    held=await commercial.begin({...grant,id,...normalized,...(nativeCodex?{codexPolicy:codex}:{}),admissionAccess});
    timings.commercialReservationMs=Date.now()-commercialStarted;
    const secret=credentials[grant.provider];if(!secret)throw new Error('PROVIDER_CREDENTIAL_UNAVAILABLE');
    const headers={'content-type':'application/json',...(grant.provider==='openai'
     ?{authorization:`Bearer ${secret}`}:{'x-api-key':secret,'anthropic-version':'2023-06-01',
      ...(normalized.body.context_management?{'anthropic-beta':'context-management-2025-06-27'}:{})})};
    // Do not forward caller headers, beta features, destinations or redirect auth.
    const pendingStarted=Date.now();if(nativeCodex)await grant.nativeSession?.codexPending(requestHash,admissionAccess);
    timings.pendingCheckpointMs=Date.now()-pendingStarted;
    attempted=true;
    providerStarted=Date.now();timings.admissionMs=providerStarted-start-(timings.tokenPreflightMs||0);
    transport.phase='request';transport.clientRequestId=grant.provider==='openai'?id:null;transport.timeoutMs=timeoutMs;
    // Correlation only, never idempotency or permission to retry an uncertain
    // generation. The durable reservation ID exists even if no headers arrive.
    if(grant.provider==='openai')headers['x-client-request-id']=id;
    providerSignal=AbortSignal.timeout(timeoutMs);
    const response=await fetchImpl(ENDPOINTS[grant.provider],{method:'POST',headers,redirect:'error',
     body:JSON.stringify(normalized.body),signal:providerSignal});
    timings.responseHeadersMs=Date.now()-providerStarted;transport.phase='body';transport.status=response.status;
    const providerRequestId=response.headers.get('x-request-id')||response.headers.get('request-id');
    transport.providerRequestId=typeof providerRequestId==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(providerRequestId)?providerRequestId:null;
    parser=new wire.UsageParser(grant.provider);const output=[];
    for await(const chunk of response.body){
     if(!transport.receivedBytes)timings.firstByteMs=Date.now()-providerStarted;
     transport.receivedBytes+=chunk.byteLength;parser.append(chunk);output.push(Buffer.from(chunk));
    }
    timings.providerMs=Date.now()-providerStarted;
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
    receipt=nativeCodex?codex.receipt(parsedReceipt):parsedReceipt;
    if(receipt.inputTokens>normalized.inputTokens||receipt.outputTokens>normalized.outputTokens){
     await budget.stop();throw new Error('TOKEN_BOUND_VIOLATION');
    }
    transport.phase='settlement';const settlementStarted=Date.now();await commercial.complete(held,receipt);
    timings.commercialSettlementMs=Date.now()-settlementStarted;
    await budget.settle(id,receipt.conservativeMicroUsd,{provider:grant.provider,model:normalized.body.model,
     requestedServiceTier:normalized.body.service_tier,returnedServiceTier:receipt.returnedServiceTier||null,
     usage:receipt.raw,latencyMs:Date.now()-start,timings,transport:{...transport,providerResponseId:parser.responseId||null},protocol:parser.diagnostics(),accounting:'conservative standard-price charge'});
    settled=true;
    transport.phase='delivery';
    audit({kind:'model_call',id,candidate:grant.candidate,task:grant.task,usage:receipt,
     latencyMs:Date.now()-start,timings,source:'native_sdk_http'});
    const outcome={...parser.response.result(),request:control?.request||null,final:Boolean(control?.final),usageSettled:true};
    grant.lastResponse=outcome;
    if(nativeCodex)await grant.nativeSession?.codexDelivered(requestHash,{status:response.status,
     contentType:response.headers.get('content-type')||'application/json',body:Buffer.concat(output).toString('utf8'),outcome},outcome);
    // Persist before acknowledging the SDK. A restarted SDK cannot turn an
    // empty terminal response into an unapproved paid continuation.
    await grant.responseSink?.(outcome);
    audit({kind:'model_response',id,provider:grant.provider,...outcome});
    if(outcome.failed)throw Object.assign(new Error('The provider reported a failed response.'),{code:'PROVIDER_RESPONSE_FAILED'});
    // Codex owns continuation of incomplete/reasoning-only responses. It still
    // crosses every request/goal/period hold; the legacy forced-final controller
    // must not turn a settled native response into a fabricated transport error.
    if(outcome.empty&&!nativeCodex)throw Object.assign(new Error(require('./finalization').EMPTY_MESSAGE),{code:'EMPTY_MODEL_FINAL'});
    res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json',
     'cache-control':'no-store'});res.end(Buffer.concat(output));
   }finally{active--;}
  }catch(error){
   require('./dependency-diagnostics').record(error,{goalId:grant?.ctx?.goalId||grant?.task,phase:'provider_relay'});
   // Never expose provider responses, secrets, SQL or internal stack traces.
   const providerUncertain=attempted&&!settled&&['request','body'].includes(transport.phase);
   const timedOut=providerUncertain&&providerSignal?.aborted;
   const networkFailure=providerUncertain&&['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','ECONNRESET','EPIPE','ETIMEDOUT','EAI_AGAIN'].includes(error.cause?.code||error.code);
   const protocol=parser?.diagnostics();
   const reason=timedOut?'PROVIDER_REQUEST_TIMEOUT':networkFailure?'PROVIDER_TRANSPORT_UNCERTAIN':protocol?.terminalStatus==='failed'?'PROVIDER_RESPONSE_FAILED':String(error.code||error.message||'RELAY_FAILURE').slice(0,180);
   if(providerStarted!==null&&!timings.providerMs)timings.providerMs=Date.now()-providerStarted;
   const limitKind=timedOut||networkFailure?'provider_transport':error.limitKind||null;
   const uncertainDetail={...callDetail,latencyMs:Date.now()-start,timings,
    transport:{...transport,providerResponseId:parser?.responseId||null},...(protocol?{protocol}:{}),
    ...(receipt?{usage:receipt.raw}:{}),accounting:receipt?'provider usage retained; local settlement requires reconciliation':'full reservation retained; provider usage unverified',upstreamAttempted:attempted,usageSettled:settled};
   const finalGate=['EMPTY_MODEL_FINAL','FINAL_REQUEST_EXHAUSTED'].includes(reason);
   const message=reason==='EMPTY_MODEL_FINAL'?require('./finalization').EMPTY_MESSAGE:
    reason==='FINAL_REQUEST_EXHAUSTED'?'StockChief already used the final request allowance. No additional provider call was made.':
    'StockChief model budget or authority gate stopped this request.';
   if(grant)grant.lastBlock={code:reason,limitKind,upstreamAttempted:attempted,usageSettled:settled,message};
   if(id&&!settled){
    if(attempted){await budget.unknown(id,reason,uncertainDetail);if(held)await commercial.unknown(held,reason).catch(()=>budget.stop());}
    else {if(held)await commercial.release(held).catch(()=>budget.stop());await budget.settle(id,0,{reason,upstreamAttempted:false});}
   }
   audit({kind:'model_call_blocked',id,reason,limitKind,...(attempted?{timings,transport:uncertainDetail.transport}:{}),
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
  grant({candidate,task,provider,authorize,fundingKey,goalId,ctx,accountingMode='native',wireProfile=null,requestGate=null,livePermit=null,codexPolicy=null,preferredCodexPolicy=null}){
   if(!wire.MODELS[provider]||typeof authorize!=='function'||!goalId||!ctx||!fundingKey)throw new Error('A funded, authorized durable goal is required.');
   if(!['native','existing'].includes(accountingMode))throw new Error('Unsupported commercial accounting mode.');
   if(wireProfile!==null&&(wireProfile!=='codex'||provider!=='openai'||accountingMode!=='native'||typeof requestGate!=='function'))throw new Error('INVALID_CODEX_GATE');
   if(wireProfile==='codex'&&credentials.openai!=='FAKE'){
    require('./codex-live-permit').assertSetup(livePermit,{budget,task});
    if(typeof countCodexInput!=='function')throw new Error('NATIVE_TOKEN_PREFLIGHT_REQUIRED');
   }
   if(wireProfile==='codex'){
    codexPolicy||=require('./codex-wire').forProfile(require('./codex-wire').PROFILE.id);
    if(!require('./codex-wire').isPolicy(codexPolicy))throw Error('INVALID_HOST_MODEL_POLICY');
   }
   if(preferredCodexPolicy&&(!require('./codex-wire').isPolicy(preferredCodexPolicy)||wireProfile!=='codex'||
    preferredCodexPolicy.MODEL!==codexPolicy.MODEL||preferredCodexPolicy.EFFORT!==codexPolicy.EFFORT))throw Error('INVALID_HOST_PROCESSING_PREFERENCE');
   const token=randomBytes(32).toString('hex');grants.set(token,{candidate,task,provider,authorize,fundingKey,goalId,ctx,accountingMode,wireProfile,requestGate,livePermit,codexPolicy,preferredCodexPolicy});
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

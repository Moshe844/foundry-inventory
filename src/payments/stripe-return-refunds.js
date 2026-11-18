'use strict';
const {ValidationError}=require('../domain/errors');
const effects=require('../operations/postgres-provider-effects'),jobs=require('../operations/postgres-job-queue');
const KIND='payment.refund.create',JOB='payment.refund-status';
const ordinary=e=>e?.kind===KIND&&e.provider==='stripe'&&!e.payload.agentRefundPartId&&!e.payload.customerCreditPartId;
async function refundFor(db,effect){
 if(!ordinary(effect))throw new ValidationError('This is not an ordinary Stripe return refund.');
 const row=(await db.query('SELECT * FROM payment_refund_requests WHERE workspace_id=$1 AND id=$2 AND provider=$3',[effect.workspaceId,effect.payload.refundRequestId,'stripe'])).rows[0];
 if(!row||row.customer_return_id!==effect.aggregateId||!['PENDING','REVIEW','SUCCEEDED'].includes(row.status))throw new ValidationError('The approved original refund needs review.');
 const accounts=(await db.query(`SELECT DISTINCT COALESCE(payload::jsonb->>'account',payload::jsonb->>'providerAccountId') AS id FROM payment_provider_events
  WHERE workspace_id=$1 AND request_id=$2 AND external_payment_id=$3 AND payment_id IS NOT NULL`,[effect.workspaceId,row.payment_request_id,row.external_payment_id])).rows.map(r=>r.id).filter(Boolean);
 if(accounts.length!==1||!/^acct_[A-Za-z0-9]+$/.test(accounts[0]))throw new ValidationError('The original merchant identity needs review before refunding this payment.');
 return {...row,providerAccountId:accounts[0]};
}
function reference(result,refund){
 if(!/^re_[A-Za-z0-9]+$/.test(result?.externalRefundId||'')||result.originalPaymentId!==refund.external_payment_id||
  result.amountMinor!==Number(refund.amount_minor)||String(result.currency||'').toUpperCase()!==refund.currency)return null;
 return {source:'STRIPE_RETURN_REFUND_V1',externalId:result.externalRefundId,providerAccountId:refund.providerAccountId,
  originalPaymentId:refund.external_payment_id,amountMinor:Number(refund.amount_minor),currency:refund.currency,requestId:refund.id};
}
async function context(db,effect,refund,options){
 const collection=require('./postgres-collection'),account=await collection.accountFor(db,effect.workspaceId,'stripe',{refund:true});
 if(account.provider_account_id!==refund.providerAccountId)throw new ValidationError('Reconnect the merchant account that took the original payment. Nothing was refunded through another account.');
 const provider=options.provider||options.providerResolver?.('stripe')||require('./index').get('stripe');
 return {provider,ctx:await collection.providerContext(account,options,db)};
}
async function queue(db,effect,{source=null,now=Date.now(),delay=30000}={}){
 const active=(await db.query("SELECT 1 FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2 AND payload->>'effectId'=$3 AND status IN('PENDING','RETRY','RUNNING') LIMIT 1",[effect.workspaceId,JOB,effect.id])).rows.length;
 if(active)return {created:false};
 return jobs.enqueue(db,{workspaceId:effect.workspaceId,kind:JOB,payload:{effectId:effect.id},priority:20,maxAttempts:6,
  availableAt:now+delay,idempotencyKey:'stripe-refund-read:'+effect.id+':'+(source||Math.floor(now/300000))});
}
async function hold(db,effect,refund,error,{terminal=false}={}){
 await effects.finishError(db,effect.workspaceId,effect.id,effect.claimToken,error,{ambiguous:true,
  apply:c=>c.query("UPDATE payment_refund_requests SET status='REVIEW',last_error=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status IN('PENDING','REVIEW')",[effect.workspaceId,refund.id,error.message])});
 if(!terminal)await queue(db,effect);
}
async function record(db,effect,refund,result){
 const proof=reference(result,refund);
 if(!proof)throw Object.assign(new ValidationError('Stripe did not confirm the exact original payment, amount and currency. No refund posting was created.'),{providerOutcomeUncertain:true});
 await effects.checkpoint(db,effect.workspaceId,effect.id,effect.claimToken,proof);
 await db.query('UPDATE payment_refund_requests SET external_refund_id=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status IN(\'PENDING\',\'REVIEW\')',[effect.workspaceId,refund.id,proof.externalId]);
 if(result.status!=='succeeded'){
  const terminal=['failed','canceled'].includes(result.status),message=terminal?'Stripe reports this refund '+result.status+'. Review the original refund in Stripe before choosing another repayment.':result.status==='requires_action'?'Stripe needs action to finish this refund. Review the original refund in Stripe.':'Stripe is still processing this refund. StockChief will check the original refund again; cash has not been posted.';
  await hold(db,effect,refund,Object.assign(new ValidationError(message),{code:terminal?'stripe_refund_terminal':'stripe_refund_pending'}),{terminal});
  await require('../commercial/operations').completeRetained(db,effect.workspaceId,{operation:'refund_create',key:effect.idempotencyKey},{providerRequestVerified:true,settlementPending:true});
  // The original create request is now verified. Settlement remains a separate
  // pending effect and return; recovering this job must not invent cash.
  await db.query("UPDATE stockchief_runtime.jobs SET status='COMPLETED',last_error=NULL,result=$3::jsonb,completed_at=now(),updated_at=now() WHERE workspace_id=$1 AND kind='provider.effect' AND payload->>'effectId'=$2 AND status='DEAD'",[effect.workspaceId,effect.id,JSON.stringify({providerRequestVerified:true,settlementPending:true,effectId:effect.id})]);
  await recoverReads(db,effect,true);
  return {refundId:proof.externalId,pending:!terminal,needsReview:terminal,financialPostingCreated:false};
 }
 let accountingResult;
 await effects.succeed(db,effect.workspaceId,effect.id,effect.claimToken,{providerReference:proof,result:{refundId:proof.externalId,amountMinor:proof.amountMinor},apply:async c=>{
  const current=await refundFor(c,effect);
  if(reference(result,current)?.requestId!==proof.requestId||current.providerAccountId!==proof.providerAccountId)throw new ValidationError('The original refund changed during verification. Nothing was posted.');
  accountingResult=await require('../operations/postgres-returns').refundCustomerReturnInTransaction(c,{workspaceId:effect.workspaceId,actorId:null,systemSource:'payment_provider_refund',providerEffectId:effect.id},refund.customer_return_id,
   {destination:'CASH',refundDate:await require('../lib/business-time').today(c,effect.workspaceId),idempotencyKey:'provider-refund:'+refund.id});
  await c.query("UPDATE payment_refund_requests SET status='SUCCEEDED',external_refund_id=$3,accounting_refund_id=$4,last_error=NULL,completed_at=now(),updated_at=now() WHERE workspace_id=$1 AND id=$2",[effect.workspaceId,refund.id,proof.externalId,accountingResult.refundIds[0]||null]);
 }});
 await require('../commercial/operations').completeRetained(db,effect.workspaceId,{operation:'refund_create',key:effect.idempotencyKey},{verifiedRefund:true});
 await db.transaction(c=>jobs.reconcileVerifiedEffectWithin(c,effect.workspaceId,effect.id));
 await recoverReads(db,effect,false);
 return {refundId:proof.externalId,accountingResult,replayed:false,financialPostingCreated:true};
}
async function recoverReads(db,effect,pending){
 await db.query("UPDATE stockchief_runtime.jobs SET status='COMPLETED',last_error=NULL,result=$4::jsonb,completed_at=now(),updated_at=now() WHERE workspace_id=$1 AND kind=$2 AND payload->>'effectId'=$3 AND status='DEAD'",[effect.workspaceId,JOB,effect.id,JSON.stringify({originalRefundReadVerified:true,settlementPending:pending,effectId:effect.id})]);
}
async function execute(db,current,options={}){
 const claim=await effects.claim(db,current.workspaceId,current.id);
 if(claim.replayed)return {refundId:claim.effect.result?.refundId,replayed:true};
 const effect=claim.effect;let refund,dispatched=false;
 try{
  refund=await refundFor(db,effect);
  const actor=(await db.query('SELECT * FROM users WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL',[effect.workspaceId,effect.requestedByUserId])).rows[0];
  require('../actions/permissions').assertCan(actor,require('../actions/permissions').REFUND_CUSTOMER_RETURN,'approve customer refunds');
  const {provider,ctx}=await context(db,effect,refund,options);
  const result=await require('../commercial/operations').run(db,effect.workspaceId,{capability:'payments.customer',key:effect.idempotencyKey,provider:'stripe',operation:'refund_create'},()=>{
   dispatched=true;return provider.refundPayment(ctx,{externalPaymentId:refund.external_payment_id,amountMinor:Number(refund.amount_minor),currency:refund.currency,idempotencyKey:effect.idempotencyKey,verifyExact:true,reference:refund.id});
  });
  return await record(db,effect,refund,result);
 }catch(error){
  if(refund&&dispatched&&!effects.definiteFailure(error)){await hold(db,effect,refund,error);}
  else await effects.finishError(db,effect.workspaceId,effect.id,effect.claimToken,error,{ambiguous:false,apply:c=>c.query("UPDATE payment_refund_requests SET status='FAILED',last_error=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status='PENDING'",[effect.workspaceId,effect.payload.refundRequestId,error.message])});
  throw Object.assign(error,{retryable:false});
 }
}
async function verify(db,workspaceId,effectId,options={}){
 let effect=await effects.get(db,workspaceId,effectId);
 if(!ordinary(effect))throw new ValidationError('This operation is not an original Stripe return refund.');
 if(effect.status==='SUCCEEDED')return {replayed:true,refundId:effect.result?.refundId};
 if(effect.status!=='AMBIGUOUS')return {skipped:'refund_not_waiting'};
 if(!options.system){const actor=(await db.query("SELECT * FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner' AND revoked_at IS NULL",[workspaceId,options.actorId])).rows[0];if(!actor)throw new ValidationError('A current owner must verify this refund.');}
 const refund=await refundFor(db,effect),scope=await require('../commercial/entitlements').ownerScopeForWorkspace(db,workspaceId);
 const result=await require('../commercial/context').run({database:db,scope,system:true},async()=>{
  const {provider,ctx}=await context(db,effect,refund,options);
  return effect.providerReference?.externalId?provider.retrieveRefund(ctx,{externalRefundId:effect.providerReference.externalId,externalPaymentId:refund.external_payment_id}):provider.findRefund(ctx,{reference:refund.id,externalPaymentId:refund.external_payment_id});
 });
 const proof=reference(result,refund);
 if(!proof)throw new ValidationError('The original Stripe refund still does not match. Nothing was resent or posted.');
 // A lost create response can be recovered only from Stripe's unique metadata
 // reference and exact original-payment evidence. An existing ID is immutable.
 await db.query("UPDATE stockchief_runtime.provider_effects SET provider_reference=$3::jsonb WHERE workspace_id=$1 AND id=$2 AND status='AMBIGUOUS' AND provider_reference IS NULL",[workspaceId,effectId,JSON.stringify(proof)]);
 const claim=await effects.claimVerification(db,workspaceId,effectId,KIND);
 if(claim.replayed)return {replayed:true,refundId:claim.effect.result?.refundId};effect=claim.effect;
 try{return await record(db,effect,refund,result);}catch(error){await hold(db,effect,refund,error);throw error;}
}
async function queueDue(db,now=Date.now()){
 if(!require('./stripe-live-qualification').production())return {queued:0};
 const rows=(await db.query(`SELECT e.* FROM stockchief_runtime.provider_effects e JOIN payment_refund_requests r ON r.workspace_id=e.workspace_id AND r.id=e.payload->>'refundRequestId'
  WHERE e.kind=$1 AND e.provider='stripe' AND e.status='AMBIGUOUS' AND r.status IN('PENDING','REVIEW') AND r.agent_part_id IS NULL
   AND NOT (e.payload ? 'customerCreditPartId') AND e.error_code IS DISTINCT FROM 'stripe_refund_terminal' AND e.updated_at<now()-interval '90 seconds'
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs j WHERE j.workspace_id=e.workspace_id AND j.kind=$2 AND j.payload->>'effectId'=e.id AND j.status IN('PENDING','RETRY','RUNNING','DEAD'))
  ORDER BY e.updated_at,e.id LIMIT 50`,[KIND,JOB])).rows;
 for(const row of rows){
  // A process can stop after Stripe accepts the create request and before the
  // return row is updated. Recover that saved intent by reading, never sending.
  await db.query("UPDATE payment_refund_requests SET status='REVIEW',last_error=COALESCE(last_error,'The worker stopped before the original Stripe refund was confirmed. StockChief is checking it without resending.'),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status='PENDING'",[row.workspace_id,row.payload.refundRequestId]);
  await queue(db,effects.hydrate(row),{now});
 }return {queued:rows.length};
}
async function queueEvent(db,workspaceId,event){
 if(!require('./stripe-live-qualification').production())return false;
 if(!['refund.created','refund.updated','refund.failed'].includes(String(event.type||'').replace(/^v\d+\./,'')))return false;
 const object=event.data?.object||{};
 if(object.status==='failed'){
  // Banks can return an earlier successful refund. Retain the posted history
  // and bring the discrepancy to the owner; never send a replacement here.
  const settled=(await db.query(`SELECT r.id,a.connector_id FROM payment_refund_requests r
   JOIN stockchief_runtime.provider_effects e ON e.workspace_id=r.workspace_id AND e.payload->>'refundRequestId'=r.id
   JOIN payment_connect_accounts a ON a.workspace_id=r.workspace_id AND a.provider='stripe'
   WHERE r.workspace_id=$1 AND r.provider='stripe' AND r.status='SUCCEEDED' AND r.external_refund_id=$2
    AND e.kind=$3 AND e.status='SUCCEEDED' AND NOT (e.payload ? 'agentRefundPartId') AND NOT (e.payload ? 'customerCreditPartId')`,[workspaceId,object.id||'',KIND])).rows;
  for(const row of settled)await db.query(`INSERT INTO connection_issues(id,workspace_id,connector_id,external_event_id,issue_type,fingerprint,title,detail,resolution_hint,status,created_at,updated_at)
   VALUES($1,$2,$3,$4,'PAYMENT_REFUND_FAILED',$5,'Stripe returned a previously confirmed refund','Stripe reports that the original refund failed after it was recorded. StockChief has retained the accounting history and has not sent another refund.','Review the original refund in Stripe and reconcile the returned funds before choosing another repayment.','OPEN',now(),now())
   ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,updated_at=now()`,[require('../lib/util').newId('conissue'),workspaceId,row.connector_id,event.id,'stripe-refund-returned:'+row.id]);
 }
 const rows=(await db.query(`SELECT e.* FROM stockchief_runtime.provider_effects e JOIN payment_refund_requests r ON r.workspace_id=e.workspace_id AND r.id=e.payload->>'refundRequestId'
  WHERE e.workspace_id=$1 AND e.kind=$2 AND e.provider='stripe' AND e.status='AMBIGUOUS' AND r.status='REVIEW' AND r.agent_part_id IS NULL
   AND NOT (e.payload ? 'customerCreditPartId') AND (r.external_refund_id=$3 OR r.id=$4)`,[workspaceId,KIND,object.id||'',object.metadata?.stockchief_refund_request_id||''])).rows;
 for(const row of rows)await queue(db,effects.hydrate(row),{source:'event:'+event.id,delay:0});return rows.length>0;
}
module.exports={JOB,execute,verify,queueDue,queueEvent,reference};


'use strict';

const {ValidationError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const money=require('../domain/currency');
const evidence=require('./return-refund-evidence');
const returns=require('./postgres-returns');
const credits=require('./postgres-return-credits');
const effects=require('./postgres-provider-effects');
const payments=require('../payments/postgres-collection');
const {EFFECT:KIND}=require('./agent-return-refund-protocol');
const readPlan=(db,ctx,id,lock=false)=>db.query(`SELECT * FROM stockchief_runtime.agent_return_refund_plans
  WHERE workspace_id=$1 AND customer_return_id=$2${lock?' FOR UPDATE':''}`,[ctx.workspaceId,id]).then(r=>r.rows[0]);

async function prepare(db,ctx,recordId,destination,requested){
  await evidence.access(db,ctx);
  if(await readPlan(db,ctx,recordId))throw new ValidationError('Open the already approved refund to review its original payment breakdown.');
  if((await db.query('SELECT 1 FROM payment_refund_requests WHERE workspace_id=$1 AND customer_return_id=$2',
    [ctx.workspaceId,recordId])).rows.length)throw new ValidationError('Review the existing payment-provider refund for this return.');
  const payload=await evidence.snapshot(db,ctx,recordId,{requested});
  if(destination==='AR'&&payload.amountMinor)throw new ValidationError('The paid portion is owed back to the customer through the original recorded payments.');
  if(!payload.amountMinor&&requested)throw new ValidationError('This return has no paid portion to allocate to an original payment.');
  payload.destination=payload.amountMinor?'CASH':'AR';
  const format=value=>money.format(value,payload.currency);
  if(!payload.amountMinor){
    const summary=payload.creditPosted
      ?`Close ${payload.returnNumber} after its posted receipt credit. No additional credit or cash payment is created.`
      :`Credit ${format(payload.arMinor)} to the unpaid invoice ${payload.invoice.number} for ${payload.returnNumber}.`;
    return {payload,summary};
  }
  const tenders=payload.parts.map(p=>`${format(p.amountMinor)} through ${p.methodLabel} (${p.paymentNumber})`).join(', ');
  return {payload,summary:`Refund ${format(payload.amountMinor)} in original paid funds for ${payload.returnNumber}. ${tenders}.`};
}

async function bookLegacyCredit(client,ctx,row,p){
  const legacy=require('./postgres-legacy-return-credits');
  const review=await legacy.preview(client,ctx,row.id);
  if(review.integrity!==p.legacyCreditFingerprint||review.totalMinor!==p.totalCreditMinor
    ||review.arCreditMinor!==p.arMinor||review.cashDueMinor!==p.amountMinor){
    throw new ValidationError('The original receipt amounts changed. Prepare the exact credit and refund again.');
  }
  await legacy.apply(client,ctx,review);
  await evidence.creditProof(client,ctx.workspaceId,row.id,row.currency);
}

async function partRows(db,ctx,planId){
  return (await db.query(`SELECT s.*,p.payment_number,a.name cash_name,q.last_error,q.status request_status,
    e.id effect_id,e.provider_reference,e.error_message effect_error FROM stockchief_runtime.agent_return_refund_parts s
    JOIN accounting_payments p ON p.workspace_id=s.workspace_id AND p.id=s.original_payment_id
    JOIN accounting_accounts a ON a.workspace_id=s.workspace_id AND a.id=s.cash_account_id
    LEFT JOIN payment_refund_requests q ON q.workspace_id=s.workspace_id AND q.agent_part_id=s.id
    LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=s.workspace_id AND e.kind='payment.refund.create'
      AND e.idempotency_key='agent-return-refund:'||s.id
    WHERE s.workspace_id=$1 AND s.plan_id=$2 ORDER BY p.created_at,p.payment_date,p.id`,[ctx.workspaceId,planId])).rows;
}

async function postPart(client,ctx,row,part,externalRefundId=null){
  if(part.status==='SETTLED')return part.journal_entry_id;
  const journalId=await credits.postPayout(client,ctx,row,part,externalRefundId);
  await client.query(`UPDATE stockchief_runtime.agent_return_refund_parts
    SET status='SETTLED',journal_entry_id=$3,external_refund_id=$4,settled_at=now() WHERE workspace_id=$1 AND id=$2`,
  [ctx.workspaceId,part.id,journalId,externalRefundId]);
  return journalId;
}

async function finishPlan(client,ctx,row,plan){
  const parts=await partRows(client,ctx,plan.id);
  const common={customerReturnId:row.id,planId:plan.id,destination:'CASH',amountMinor:Number(plan.amount_minor),
    creditedMinor:plan.snapshot.totalCreditMinor,partCount:parts.length};
  if(parts.some(s=>s.status!=='SETTLED'))return {...common,status:'AWAITING_REFUND',queued:true};
  const receiptCredits=await credits.read(client,ctx.workspaceId,row.id);
  if(receiptCredits.some(c=>Number(c.cash_due_minor)!==Number(c.cash_refunded_minor))){
    throw new ValidationError('The refund still has an unsettled receipt credit.');
  }
  const journalIds=parts.map(s=>s.journal_entry_id);
  const final=await credits.finalize(client,ctx,row,{credits:receiptCredits,destination:'CASH',
    amountMinor:common.amountMinor,creditedMinor:common.creditedMinor,journalEntryId:journalIds[0]});
  const result={...common,...final,payoutJournalIds:journalIds};
  await client.query(`UPDATE stockchief_runtime.agent_return_refund_plans SET completed_at=now(),result=$3::jsonb
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,plan.id,JSON.stringify(result)]);
  await client.query(`UPDATE payment_refund_requests SET accounting_refund_id=$3 WHERE workspace_id=$1 AND customer_return_id=$2
    AND agent_part_id IS NOT NULL AND status='SUCCEEDED'`,[ctx.workspaceId,row.id,final.refundIds[0]||null]);
  await returns.addSalesEvent(client,ctx,row.sales_order_id,'customer_return_refunded',
    {returnNumber:row.return_number,...result},'agent-return-refund-complete:'+plan.id);
  await require('../connections/postgres-return-review').reconcileInTransaction(client,ctx.workspaceId,{salesOrderId:row.sales_order_id});
  return result;
}

async function queueProviderPart(client,ctx,row,part){
  const refundRequestId=newId('payrefund'),at=nowIso();
  await client.query(`INSERT INTO payment_refund_requests
    (id,workspace_id,customer_return_id,payment_request_id,provider,amount_minor,currency,external_payment_id,status,
      created_by_user_id,created_at,updated_at,agent_part_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10,$10,$11)`,
  [refundRequestId,ctx.workspaceId,row.id,part.payment_request_id,part.provider,part.amount_minor,row.currency,
    part.external_payment_id,ctx.actorId,at,part.id]);
  await effects.enqueueInTransaction(client,{workspaceId:ctx.workspaceId,kind:KIND,provider:part.provider,
    aggregateType:'customer_return',aggregateId:row.id,idempotencyKey:'agent-return-refund:'+part.id,requestedByUserId:ctx.actorId,
    payload:{refundRequestId,customerReturnId:row.id,actorId:ctx.actorId,agentRefundPartId:part.id},priority:5,maxAttempts:12});
}

async function approveInTransaction(client,ctx,p){
  await evidence.access(client,ctx,{approve:true,lock:true});
  const row=await returns.readReturn(client,ctx.workspaceId,p.recordId,true);
  const prior=await readPlan(client,ctx,row.id,true);
  if(prior){
    if(prior.approval_key!==p.idempotencyKey||prior.source_fingerprint!==p.sourceFingerprint){
      throw new ValidationError('This return already has an approved original-payment breakdown.');
    }
    return prior.result||{customerReturnId:row.id,planId:prior.id,status:row.status,amountMinor:Number(prior.amount_minor),queued:true,replayed:true};
  }
  if((await client.query('SELECT 1 FROM payment_refund_requests WHERE workspace_id=$1 AND customer_return_id=$2',
    [ctx.workspaceId,row.id])).rows.length)throw new ValidationError('Review the existing payment-provider refund for this return.');
  const exact=await evidence.snapshot(client,ctx,row.id,{requested:p.requested,lock:true});
  if(exact.sourceFingerprint!==p.sourceFingerprint||exact.amountMinor!==p.amountMinor){
    throw new ValidationError('The invoice, original receipts or remaining refund changed. Prepare the refund again for approval.');
  }
  if(!exact.amountMinor){
    return returns.refundCustomerReturnInTransaction(client,ctx,row.id,{destination:'AR',idempotencyKey:p.idempotencyKey});
  }
  if(exact.parts.some(s=>s.provider))await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'payments.customer');
  const id=newId('agent-refund'),frozen=JSON.stringify(exact);
  await require('../commercial/storage-capacity').reserve(client,ctx.workspaceId,'agent-return-refund:'+id,
    Buffer.byteLength(frozen)*2+8192+exact.parts.length*8192,{finished:true});
  if(!exact.creditPosted)await bookLegacyCredit(client,ctx,row,exact);
  const plan=(await client.query(`INSERT INTO stockchief_runtime.agent_return_refund_plans
    (id,workspace_id,customer_return_id,invoice_id,currency,amount_minor,approved_by,approval_key,source_fingerprint,snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
  [id,ctx.workspaceId,row.id,exact.invoice.id,exact.currency,exact.amountMinor,ctx.actorId,p.idempotencyKey,p.sourceFingerprint,frozen])).rows[0];
  for(const s of exact.parts){
    const part=(await client.query(`INSERT INTO stockchief_runtime.agent_return_refund_parts
      (id,workspace_id,plan_id,original_payment_id,cash_account_id,method,amount_minor,provider,provider_account_id,payment_request_id,external_payment_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [newId('refund-part'),ctx.workspaceId,id,s.paymentId,s.cashAccountId,s.method,s.amountMinor,
      s.provider,s.providerAccountId,s.paymentRequestId,s.externalPaymentId])).rows[0];
    if(part.provider)await queueProviderPart(client,ctx,row,part);
    else await postPart(client,ctx,row,part);
  }
  return finishPlan(client,ctx,row,plan);
}

async function verifyApproval(client,ctx,r,p){
  if(!p.amountMinor){
    const row=await returns.readReturn(client,ctx.workspaceId,p.recordId);
    return row.status==='COMPLETED'&&Number(r.amountMinor)===(p.creditPosted?0:p.arMinor);
  }
  const plan=await readPlan(client,ctx,p.recordId);
  if(!plan||plan.id!==r.planId||plan.source_fingerprint!==p.sourceFingerprint)return false;
  const parts=await partRows(client,ctx,plan.id);
  return parts.length===p.parts.length&&parts.every(part=>{
    const expected=p.parts.find(s=>s.paymentId===part.original_payment_id);
    return expected&&Number(part.amount_minor)===expected.amountMinor&&part.cash_account_id===expected.cashAccountId&&
      (part.status==='SETTLED'&&part.journal_entry_id||part.status==='APPROVED'&&part.effect_id&&part.request_status==='PENDING');
  });
}

async function readProviderPart(db,effect){
  const {workspaceId,payload}=effect;
  return (await db.query(`SELECT s.*,plan.currency,plan.approved_by,plan.customer_return_id,plan.invoice_id,
      q.id request_id,q.status request_status,p.status payment_status,j.status journal_status
    FROM stockchief_runtime.agent_return_refund_parts s
    JOIN stockchief_runtime.agent_return_refund_plans plan ON plan.workspace_id=s.workspace_id AND plan.id=s.plan_id
    JOIN payment_refund_requests q ON q.workspace_id=s.workspace_id AND q.agent_part_id=s.id
      AND q.amount_minor=s.amount_minor AND q.external_payment_id=s.external_payment_id AND q.currency=plan.currency
      AND q.payment_request_id=s.payment_request_id AND q.customer_return_id=plan.customer_return_id AND q.provider=s.provider
    JOIN accounting_payments p ON p.workspace_id=s.workspace_id AND p.id=s.original_payment_id AND p.cash_account_id=s.cash_account_id
    JOIN accounting_journal_entries j ON j.workspace_id=p.workspace_id AND j.id=p.journal_entry_id
    JOIN accounting_accounts a ON a.workspace_id=s.workspace_id AND a.id=s.cash_account_id AND a.active=1
    WHERE s.workspace_id=$1 AND s.id=$2 AND q.id=$3 AND plan.customer_return_id=$4 AND s.provider=$5
      AND EXISTS(SELECT 1 FROM payment_provider_events e WHERE e.workspace_id=s.workspace_id AND e.payment_id=p.id
        AND e.provider=s.provider AND e.request_id=s.payment_request_id AND e.external_payment_id=s.external_payment_id
        AND e.processed_at IS NOT NULL)
      AND EXISTS(SELECT 1 FROM accounting_payment_allocations a WHERE a.workspace_id=s.workspace_id AND a.payment_id=p.id
        AND a.customer_invoice_id=plan.invoice_id AND a.amount_minor>=s.amount_minor)
      AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id
        AND r.status='POSTED')`,[workspaceId,payload.agentRefundPartId,payload.refundRequestId,effect.aggregateId,effect.provider])).rows[0];
}

function exactProviderReference(result,part){
  const refundId=String(result?.externalRefundId||'');
  if(!/^[A-Za-z0-9_-]{1,160}$/.test(refundId)||refundId===part.external_payment_id
    ||String(result.originalPaymentId)!==part.external_payment_id||result.amountMinor!==Number(part.amount_minor)
    ||String(result.currency||'').toUpperCase()!==part.currency)return null;
  return {externalId:refundId,originalPaymentId:part.external_payment_id,amountMinor:Number(part.amount_minor),currency:part.currency};
}

async function recordProviderResult(db,effect,part,result){
  const proof=exactProviderReference(result,part);
  if(proof)await effects.checkpoint(db,effect.workspaceId,effect.id,effect.claimToken,proof);
  if(!proof||result.status!=='succeeded'){
    throw Object.assign(new ValidationError('The provider has not confirmed this exact original-payment refund. Review its saved status.'),{providerOutcomeUncertain:true});
  }
  let accountingResult;
  await effects.succeed(db,effect.workspaceId,effect.id,effect.claimToken,{providerReference:proof,
    result:{refundId:proof.externalId,amountMinor:proof.amountMinor},apply:async(client)=>{
      const ctx={workspaceId:effect.workspaceId,actorId:null};
      const row=await returns.readReturn(client,ctx.workspaceId,part.customer_return_id,true);
      const plan=await readPlan(client,ctx,row.id,true);
      const locked=(await client.query(`SELECT * FROM stockchief_runtime.agent_return_refund_parts
        WHERE workspace_id=$1 AND plan_id=$2 AND id=$3 FOR UPDATE`,[ctx.workspaceId,plan?.id,part.id])).rows[0];
      if(!locked||row.status!=='AWAITING_REFUND'||!['APPROVED','REVIEW'].includes(locked.status)){
        throw new ValidationError('The return needs review before the confirmed refund can be recorded.');
      }
      await evidence.creditProof(client,ctx.workspaceId,row.id,row.currency);
      await postPart(client,ctx,row,locked,proof.externalId);
      await client.query(`UPDATE payment_refund_requests SET status='SUCCEEDED',external_refund_id=$3,last_error=NULL,
        completed_at=now(),updated_at=now() WHERE workspace_id=$1 AND agent_part_id=$2`,[ctx.workspaceId,part.id,proof.externalId]);
      accountingResult=await finishPlan(client,ctx,row,plan);
    }});
  return {refundId:proof.externalId,accountingResult,replayed:false};
}

async function failedProviderPart(db,effect,error,{ambiguous,held=false}){
  if(held)error=Object.assign(error,{code:'entitlement_required'});
  await effects.finishError(db,effect.workspaceId,effect.id,effect.claimToken,error,{ambiguous,
    apply:async(client)=>{
      const detail=String(error.message||'Payment refund needs review.').slice(0,500);
      await client.query(`UPDATE stockchief_runtime.agent_return_refund_parts SET status=$3
        WHERE workspace_id=$1 AND id=$2 AND status IN('APPROVED','REVIEW')`,
      [effect.workspaceId,effect.payload.agentRefundPartId,ambiguous?'REVIEW':'FAILED']);
      await client.query(`UPDATE payment_refund_requests SET status=$3,last_error=$4,updated_at=now()
        WHERE workspace_id=$1 AND id=$2 AND status IN('PENDING','REVIEW')`,
      [effect.workspaceId,effect.payload.refundRequestId,ambiguous?'REVIEW':'FAILED',detail]);
    }});
  throw Object.assign(error,{code:held?'entitlement_required':ambiguous?'payment_refund_ambiguous':error.code||'payment_refund_failed',
    retryable:held});
}

async function originalProvider(db,effect,part,options){
  const account=await payments.accountFor(db,effect.workspaceId,effect.provider);
  if(account.provider_account_id!==part.provider_account_id)throw new ValidationError('Reconnect the merchant account that took the original payment.');
  const provider=options.provider||require('../payments').get(effect.provider);
  const context=await payments.providerContext(account,options,db);
  return {provider,context};
}

async function preflight(db,effect){
  const part=await readProviderPart(db,effect);
  if(!part||part.status!=='APPROVED'||part.request_status!=='PENDING'||part.payment_status!=='POSTED'||part.journal_status!=='POSTED'){
    throw new ValidationError('The approved refund no longer has its exact posted original payment.');
  }
  const ctx={workspaceId:effect.workspaceId,actorId:part.approved_by};
  await evidence.access(db,ctx,{approve:true,dispatch:true,lock:true});
  await evidence.checkProviderRefundHistory(db,ctx.workspaceId,part.provider,part.external_payment_id);
  await require('../accounting/postgres-ledger').validatePostingDateInTransaction(db,ctx);
  const row=await returns.readReturn(db,ctx.workspaceId,part.customer_return_id,true);
  const open=await evidence.creditProof(db,ctx.workspaceId,row.id,row.currency);
  if(row.status!=='AWAITING_REFUND'||open.reduce((n,c)=>n+Number(c.cash_due_minor)-Number(c.cash_refunded_minor),0)<Number(part.amount_minor)){
    throw new ValidationError('The current posted return balance needs review before the provider refund.');
  }
  return part;
}

async function executeProviderPart(db,current,options={}){
  const {workspaceId,id}=current;
  const claim=await effects.claim(db,workspaceId,id);
  if(claim.replayed)return {refundId:claim.effect.result?.refundId,replayed:true};
  const effect=claim.effect;
  let dispatched=false;
  try{
    const part=await db.transaction(c=>preflight(c,effect),{isolation:'SERIALIZABLE',retrySafe:true});
    const {provider,context}=await originalProvider(db,effect,part,options);
    const result=await require('../commercial/operations').run(db,workspaceId,
      {capability:'payments.customer',key:effect.idempotencyKey,provider:effect.provider,operation:'refund_create',retryReversed:true},async()=>{
        try{await db.transaction(c=>preflight(c,effect),{isolation:'SERIALIZABLE',retrySafe:true});}
        catch(error){throw Object.assign(error,{status:403});}
        dispatched=true;
        return provider.refundPayment(context,{externalPaymentId:part.external_payment_id,
          amountMinor:Number(part.amount_minor),currency:part.currency,idempotencyKey:effect.idempotencyKey,verifyExact:true});
      });
    return await recordProviderResult(db,effect,part,result);
  }catch(error){
    return failedProviderPart(db,effect,error,{ambiguous:dispatched&&!effects.definiteFailure(error),held:!dispatched});
  }
}

async function verifyProviderPart(db,ctx,returnId,partId,options={}){
  await evidence.owner(db,ctx);
  const plan=await readPlan(db,ctx,returnId);
  const part=plan&&(await partRows(db,ctx,plan.id)).find(s=>s.id===partId);
  if(!part||part.provider!=='stripe'||!part.effect_id||!part.provider_reference?.externalId){
    throw new ValidationError('This refund has no saved Stripe confirmation to verify.');
  }
  const claim=await effects.claimVerification(db,ctx.workspaceId,part.effect_id,KIND);
  if(claim.replayed)return {refundId:claim.effect.result?.refundId,replayed:true};
  const effect=claim.effect;
  try{
    const current=await readProviderPart(db,effect);
    if(!current)throw new ValidationError('Review the retained payment evidence for this refund.');
    const {provider,context}=await originalProvider(db,effect,current,options);
    const result=await provider.retrieveRefund(context,{externalRefundId:effect.providerReference.externalId,
      externalPaymentId:current.external_payment_id});
    const recorded=await recordProviderResult(db,effect,current,result);
    await require('../commercial/operations').completeRetained(db,ctx.workspaceId,{operation:'refund_create',key:effect.idempotencyKey},{verifiedRefund:true});
    await db.transaction(c=>require('./postgres-job-queue').reconcileVerifiedEffectWithin(c,ctx.workspaceId,effect.id));
    return recorded;
  }catch(error){return failedProviderPart(db,effect,error,{ambiguous:true});}
}

async function view(db,workspaceId,returnId){
  const ctx={workspaceId};
  const plan=await readPlan(db,ctx,returnId);
  if(!plan)return null;
  const rows=await partRows(db,ctx,plan.id);
  return {currency:plan.currency,amountMinor:Number(plan.amount_minor),invoiceNumber:plan.snapshot.invoice.number,
    completedAt:plan.completed_at,parts:rows.map(row=>({id:row.id,amountMinor:Number(row.amount_minor),paymentNumber:row.payment_number,
      methodLabel:plan.snapshot.parts.find(s=>s.paymentId===row.original_payment_id)?.methodLabel,
      cashAccountName:row.cash_name,status:row.request_status==='REVIEW'?'REVIEW':row.status,provider:row.provider,error:row.last_error||row.effect_error,
      canVerify:row.request_status==='REVIEW'&&row.provider==='stripe'&&Boolean(row.provider_reference?.externalId)}))};
}

module.exports={prepare,approveInTransaction,verifyApproval,executeProviderPart,verifyProviderPart,view};

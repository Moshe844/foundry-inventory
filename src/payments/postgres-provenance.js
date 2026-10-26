'use strict';
const {newId,nowIso}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const providers=require('./index'),jobs=require('../operations/postgres-job-queue');
const supported=name=>{const p=providers.get(name);return typeof p.readInvoice==='function'&&typeof p.eventFromInvoice==='function';};
async function queue(database,request,{sourceEventId=null}={}){
 if(!request?.id||Number(request.paid_minor)<=0||!supported(request.provider))return null;
 return jobs.enqueue(database,{workspaceId:request.workspace_id,kind:'payment.provenance',
   payload:{requestId:request.id,...(sourceEventId?{sourceEventId}:{})},idempotencyKey:`payment-provenance:${request.id}:${request.paid_minor}${sourceEventId?':event:'+sourceEventId:''}`,priority:30,maxAttempts:6});
}
async function queueMissing(database){
 const rows=(await database.query(`SELECT r.* FROM payment_requests r WHERE r.paid_minor>0 AND r.external_invoice_id IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM payment_provider_events e WHERE e.workspace_id=r.workspace_id AND e.request_id=r.id
    AND e.payment_id IS NOT NULL AND e.external_payment_id IS NOT NULL)
  ORDER BY r.updated_at,r.id LIMIT 50`)).rows;
 let queued=0;for(const row of rows)if(providers.has(row.provider)&&supported(row.provider)){const result=await queue(database,row);if(result?.created)queued++;}
 const orphans=(await database.query(`SELECT orphan.id,orphan.workspace_id,MIN(known.request_id) AS request_id
   FROM payment_provider_events orphan JOIN payment_provider_events known
     ON known.workspace_id=orphan.workspace_id AND known.provider=orphan.provider AND known.external_payment_id=orphan.external_payment_id
   WHERE orphan.event_type='REFUNDED' AND orphan.request_id IS NULL AND known.request_id IS NOT NULL AND known.payment_id IS NOT NULL
   GROUP BY orphan.id,orphan.workspace_id HAVING COUNT(DISTINCT known.request_id)=1 ORDER BY orphan.id LIMIT 50`)).rows;
 for(const orphan of orphans){const request=(await database.query('SELECT * FROM payment_requests WHERE workspace_id=$1 AND id=$2',[orphan.workspace_id,orphan.request_id])).rows[0];
   if(request&&providers.has(request.provider)&&supported(request.provider)){const result=await queue(database,request,{sourceEventId:orphan.id});if(result?.created)queued++;}}
 return {queued};
}
async function reconcile(database,workspaceId,requestId,options={}){
 const collection=require('./postgres-collection'),request=await collection.get(database,workspaceId,requestId);
 if(request.paidMinor<=0||!request.externalInvoiceId)throw new ValidationError('A verified provider receipt is required before checking its original payment.');
 const account=await collection.accountFor(database,workspaceId,request.provider),provider=options.provider||options.providerResolver?.(request.provider)||providers.get(request.provider);
 if(typeof provider.readInvoice!=='function'||typeof provider.eventFromInvoice!=='function')throw new ValidationError('This provider cannot verify the original invoice payment automatically.');
 const context=await collection.providerContext(account,options,database);
 const invoice=await require('../commercial/operations').run(database,workspaceId,{capability:'payments.customer',
   key:`payment-provenance-read:${request.id}:${newId('read')}`,provider:request.provider,operation:'verify_original_invoice_payment'},
   ()=>provider.readInvoice(context,{externalInvoiceId:request.externalInvoiceId}));
 const evidence=providers.normalise(provider.readEvent(provider.eventFromInvoice(invoice)));
 if(evidence.kind!=='PAID'||evidence.externalInvoiceId!==request.externalInvoiceId||!evidence.externalPaymentId
   ||Number(evidence.amountMinor)!==request.paidMinor||evidence.currency!==request.currency
   ||typeof invoice.livemode==='boolean'&&invoice.livemode!==Boolean(Number(account.livemode)))
   throw new ValidationError('The provider could not identify one complete original payment matching this receipt. Refunds remain held for review.');
 return database.transaction(async client=>{
   const current=(await client.query('SELECT * FROM payment_requests WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,requestId])).rows[0];
   const currentAccount=(await client.query('SELECT provider_account_id FROM payment_connect_accounts WHERE workspace_id=$1 AND provider=$2',[workspaceId,request.provider])).rows[0];
   if(!current||Number(current.paid_minor)!==request.paidMinor||current.currency!==request.currency
     ||current.external_invoice_id!==request.externalInvoiceId||currentAccount?.provider_account_id!==account.provider_account_id)
     throw new ValidationError('The receipt or connected merchant changed while its payment was checked. Nothing was relinked.');
   const receipts=(await client.query(`SELECT DISTINCT p.id,p.amount_minor,p.currency,p.source_key FROM payment_provider_events e
     JOIN accounting_payments p ON p.workspace_id=e.workspace_id AND p.id=e.payment_id
     WHERE e.workspace_id=$1 AND e.request_id=$2 AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED'`,[workspaceId,requestId])).rows;
   if(receipts.length!==1||Number(receipts[0].amount_minor)!==request.paidMinor||receipts[0].currency!==request.currency
     ||receipts[0].source_key!==`${request.provider}:${request.id}:paid:${request.paidMinor}`)
     throw new ValidationError('Multiple or changed receipts need review before selecting an original provider payment.');
   const existing=(await client.query('SELECT external_payment_id FROM payment_provider_events WHERE workspace_id=$1 AND request_id=$2 AND external_payment_id IS NOT NULL',[workspaceId,requestId])).rows;
   if(existing.some(row=>row.external_payment_id!==evidence.externalPaymentId))throw new ValidationError('Recorded provider payment identities conflict. Nothing was relinked.');
   const at=nowIso(),externalId=`verified-invoice:${request.externalInvoiceId}:${request.paidMinor}:${evidence.externalPaymentId}`;
   const result=await client.query(`INSERT INTO payment_provider_events(id,workspace_id,provider,external_event_id,event_type,payload,request_id,
     payment_id,external_payment_id,outcome,received_at,processed_at) VALUES($1,$2,$3,$4,'PROVENANCE_VERIFIED',$5,$6,$7,$8,$9,$10,$10)
     ON CONFLICT(workspace_id,provider,external_event_id) DO NOTHING RETURNING id`,[newId('payevt'),workspaceId,request.provider,externalId,
       JSON.stringify({source:'provider_invoice_readback',invoiceId:request.externalInvoiceId,paymentId:evidence.externalPaymentId,
         amountMinor:request.paidMinor,currency:request.currency,providerAccountId:account.provider_account_id}),requestId,receipts[0].id,evidence.externalPaymentId,
       'Verified the original payment against the provider invoice. Existing cash, invoice allocation and stock were preserved.',at]);
   const retained=(await client.query(`SELECT id,external_event_id,outcome FROM payment_provider_events WHERE workspace_id=$1 AND provider=$2
     AND request_id IS NULL AND event_type='REFUNDED' AND external_payment_id=$3 AND ($4::text IS NULL OR id=$4) FOR UPDATE`,
     [workspaceId,request.provider,evidence.externalPaymentId,options.sourceEventId||null])).rows;
   const competing=(await client.query(`SELECT DISTINCT request_id FROM payment_provider_events WHERE workspace_id=$1 AND provider=$2
     AND external_payment_id=$3 AND payment_id IS NOT NULL AND request_id IS NOT NULL`,[workspaceId,request.provider,evidence.externalPaymentId])).rows;
   let linkedEvents=0;if(competing.length===1&&competing[0].request_id===requestId)for(const event of retained){
     await client.query(`INSERT INTO payment_provider_events(id,workspace_id,provider,external_event_id,event_type,payload,request_id,
       payment_id,external_payment_id,outcome,received_at,processed_at) VALUES($1,$2,$3,$4,'EVENT_LINK_VERIFIED',$5,$6,$7,$8,$9,$10,$10)
       ON CONFLICT(workspace_id,provider,external_event_id) DO NOTHING`,[newId('payevt'),workspaceId,request.provider,'linked-event:'+event.external_event_id,
       JSON.stringify({source:'retained_signed_event',sourceEventId:event.id,sourceExternalEventId:event.external_event_id,originalOutcome:event.outcome,
         paymentId:evidence.externalPaymentId,invoiceId:request.externalInvoiceId}),requestId,receipts[0].id,evidence.externalPaymentId,
       'Linked retained refund evidence to its verified original payment. No payment, refund or stock posting was created.',at]);
     const linked=await client.query('UPDATE payment_provider_events SET request_id=$3 WHERE workspace_id=$1 AND id=$2 AND request_id IS NULL',[workspaceId,event.id,requestId]);linkedEvents+=linked.rowCount;
   }
   return {verified:true,replayed:!result.rows.length,linkedEvents,requestId,paymentId:receipts[0].id,externalPaymentId:evidence.externalPaymentId,financialPostingCreated:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={queue,queueMissing,reconcile};

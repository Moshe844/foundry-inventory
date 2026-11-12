'use strict';

const {ValidationError,AuthorizationError}=require('../domain/errors');
const money=require('../domain/currency');
const {hash}=require('../pricing/postgres-promotions');
const policy=require('../commercial/agent-plan');
const receiptCredits=require('./postgres-return-credits');
const financials=require('./return-money');
const ACTION='customer_return.refund';
const JOB=107;
const sum=(rows,field)=>money.sum(rows.map(r=>money.integer(r[field]??0,field)));
const methodName=value=>String(value||'').trim().toLowerCase().replace(/[\s-]+/g,'_');
const offline=new Map([
  ['cash','Cash'],['bank_transfer','Bank transfer'],['ach','ACH'],['wire','Wire transfer'],
  ['check','Check'],['cheque','Check'],['card','Card recorded outside StockChief'],
  ['credit_card','Card recorded outside StockChief'],['debit_card','Debit card recorded outside StockChief'],
  ['other','Recorded external payment'],
]);

async function owner(db,ctx,{lock=false}={}){
  const row=(await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    JOIN accounts a ON a.id=u.account_id WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL)`+
    (lock?' FOR SHARE OF u,w,a':''),[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the current inventory owner can approve a prepared customer refund.');
  await require('./postgres-warehouse-access').assertInventoryWide(db,ctx);
}

async function access(db,ctx,{approve=false,dispatch=false,lock=false}={}){
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  await owner(db,ctx,{lock});
  const account=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  if(approve){
    const stop=await policy.stopped(db,ctx.workspaceId,account,ACTION,false);
    if(stop)throw new ValidationError(stop);
  }
  if(dispatch){
    const mode=(await db.query('SELECT paused,suspended FROM workspace_autopilot WHERE workspace_id=$1'+(lock?' FOR SHARE':''),
      [ctx.workspaceId])).rows[0];
    if(Number(mode?.paused)||Number(mode?.suspended))throw new ValidationError('Resume the inventory before dispatching its approved refund.');
  }
  return account;
}

async function creditProof(db,workspaceId,returnId,currency){
  const rows=(await db.query(`SELECT c.*,
    j.posting_date,j.status='POSTED' AND j.source_type='customer_return_credit' AND j.source_record_id=$2
      AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id
        AND r.reversal_of_entry_id=j.id AND r.status='POSTED') AS posted,
    original.source_type='sale_fulfillment' AND original.status='POSTED'
      AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=original.workspace_id
        AND r.reversal_of_entry_id=original.id AND r.status='POSTED') AS original_posted,
    (SELECT coalesce(sum(l.debit_minor-l.credit_minor) FILTER(WHERE a.system_key='SALES_RETURNS'),0) FROM accounting_journal_lines l
      JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
      WHERE l.workspace_id=c.workspace_id AND l.entry_id=c.journal_entry_id AND l.currency=$3) sales,
    (SELECT coalesce(sum(l.debit_minor-l.credit_minor) FILTER(WHERE a.system_key='SALES_TAX_PAYABLE'),0) FROM accounting_journal_lines l
      JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
      WHERE l.workspace_id=c.workspace_id AND l.entry_id=c.journal_entry_id AND l.currency=$3) tax,
    (SELECT coalesce(sum(l.credit_minor-l.debit_minor) FILTER(WHERE a.system_key='ACCOUNTS_RECEIVABLE'),0) FROM accounting_journal_lines l
      JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
      WHERE l.workspace_id=c.workspace_id AND l.entry_id=c.journal_entry_id AND l.currency=$3) ar,
    (SELECT coalesce(sum(l.credit_minor-l.debit_minor) FILTER(WHERE a.system_key='CUSTOMER_REFUNDS_PAYABLE'),0) FROM accounting_journal_lines l
      JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
      WHERE l.workspace_id=c.workspace_id AND l.entry_id=c.journal_entry_id AND l.currency=$3) payable
    FROM accounting_return_receipt_credits c JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id
    JOIN accounting_journal_entries original ON original.workspace_id=c.workspace_id AND original.id=c.original_journal_entry_id
    WHERE c.workspace_id=$1 AND c.customer_return_id=$2 ORDER BY c.created_at,c.id`,[workspaceId,returnId,currency])).rows;
  if(rows.some(c=>!c.posted||!c.original_posted||Number(c.sales)!==Number(c.revenue_minor)||Number(c.tax)!==Number(c.tax_minor)
    ||Number(c.ar)!==Number(c.ar_credit_minor)||Number(c.payable)!==Number(c.cash_due_minor)
    ||Number(c.cash_due_minor)<Number(c.cash_refunded_minor))) {
    throw new ValidationError('The original sale or posted return credit no longer agrees with its accounting evidence.');
  }
  return rows;
}

async function paymentsFor(db,workspaceId,invoice,lock){
  // Job 107 credits refund through the same original payments as returns.
  const credits=await require('../db/schema-installed').has(db,'stockchief_runtime.agent_customer_credit_refunds');
  if(lock)await db.query(`SELECT p.id FROM accounting_payments p WHERE p.workspace_id=$1 AND EXISTS(
    SELECT 1 FROM accounting_payment_allocations l WHERE l.workspace_id=p.workspace_id AND l.payment_id=p.id AND l.customer_invoice_id=$2)
    ORDER BY p.id FOR UPDATE`,[workspaceId,invoice.id]);
  return (await db.query(`SELECT p.id,p.payment_number,p.payment_date,p.created_at,p.amount_minor,p.method,p.reference,p.source_key,p.currency,
      p.cash_account_id,a.name cash_name,a.active ledger_active,a.account_type,a.normal_balance,
      alloc.amount_minor AS allocated,coalesce(spent.all_minor,0)+coalesce(credit.all_minor,0) already_paid,coalesce(spent.invoice_minor,0)+coalesce(credit.invoice_minor,0) already_paid_invoice,
      proof.cash_paid,proof.valid_journal,coalesce(payments.identities,'[]'::jsonb) provider_identities
    FROM accounting_payments p JOIN accounting_accounts a ON a.workspace_id=p.workspace_id AND a.id=p.cash_account_id
    JOIN LATERAL(SELECT sum(l.amount_minor) AS amount_minor FROM accounting_payment_allocations l
      WHERE l.workspace_id=p.workspace_id AND l.payment_id=p.id AND l.customer_invoice_id=$2) alloc ON alloc.amount_minor>0
    JOIN LATERAL(SELECT j.status='POSTED' AND j.source_type IN('customer_payment','customer_deposit')
      AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id AND r.status='POSTED') valid_journal,
      (SELECT coalesce(sum(l.debit_minor-l.credit_minor),0) FROM accounting_journal_lines l WHERE l.workspace_id=p.workspace_id
        AND l.entry_id=j.id AND l.account_id=p.cash_account_id AND l.customer_id=p.customer_id AND l.currency=p.currency) cash_paid
      FROM accounting_journal_entries j WHERE j.workspace_id=p.workspace_id AND j.id=p.journal_entry_id) proof ON true
    LEFT JOIN LATERAL(SELECT sum(s.amount_minor) all_minor,
      sum(s.amount_minor) FILTER(WHERE plan.invoice_id=$2) invoice_minor FROM stockchief_runtime.agent_return_refund_parts s
      JOIN stockchief_runtime.agent_return_refund_plans plan ON plan.workspace_id=s.workspace_id AND plan.id=s.plan_id
      WHERE s.workspace_id=p.workspace_id AND s.original_payment_id=p.id AND s.status IN('APPROVED','SETTLED','REVIEW')) spent ON true
    ${credits?`LEFT JOIN LATERAL(SELECT sum(r.amount_minor) all_minor,sum(r.amount_minor) FILTER(WHERE c.invoice_id=$2 AND c.kind='price_adjustment') invoice_minor
      FROM stockchief_runtime.agent_customer_credit_refunds r JOIN stockchief_runtime.agent_customer_credits c ON c.workspace_id=r.workspace_id AND c.id=r.credit_id
      WHERE r.workspace_id=p.workspace_id AND r.original_payment_id=p.id AND r.status<>'FAILED') credit ON true`:'CROSS JOIN LATERAL(SELECT NULL::bigint all_minor,NULL::bigint invoice_minor) credit'}
    LEFT JOIN LATERAL(SELECT jsonb_agg(DISTINCT jsonb_build_object('provider',e.provider,'requestId',q.id,'externalPaymentId',e.external_payment_id,
      'merchant',coalesce(e.payload::jsonb->>'providerAccountId',e.payload::jsonb->>'account',
        (SELECT k.merchant_account_id FROM cardknox_checkout_sessions k WHERE q.provider='cardknox' AND k.workspace_id=q.workspace_id AND k.request_id=q.id)),
      'priorLegacy',coalesce((SELECT sum(x.amount_minor) FROM payment_refund_requests x WHERE x.workspace_id=q.workspace_id
        AND x.payment_request_id=q.id AND x.external_payment_id=e.external_payment_id AND x.agent_part_id IS NULL
        AND x.status IN('PENDING','REVIEW','SUCCEEDED')),0))) identities
      FROM payment_provider_events e JOIN payment_requests q ON q.workspace_id=e.workspace_id AND q.id=e.request_id
      WHERE e.workspace_id=p.workspace_id AND e.payment_id=p.id AND e.processed_at IS NOT NULL AND e.external_payment_id IS NOT NULL
        AND q.customer_id=p.customer_id AND q.currency=p.currency AND q.provider=e.provider AND q.paid_minor>0
        AND (q.invoice_id=$2 OR q.sales_order_id=$3)) payments ON true
    WHERE p.workspace_id=$1 AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED' AND p.customer_id=$4 AND p.currency=$5
    ORDER BY p.created_at,p.payment_date,p.id`,[workspaceId,invoice.id,invoice.sales_order_id,invoice.customer_id,invoice.currency])).rows;
}

async function checkProviderRefundHistory(db,workspaceId,provider,externalPaymentId){
  if(provider!=='stripe')return;
  const history=(await db.query(`SELECT
    (SELECT coalesce(sum(q.amount_minor),0) FROM payment_refund_requests q
      WHERE q.workspace_id=$1 AND q.provider=$2 AND q.external_payment_id=$3 AND q.status='SUCCEEDED') booked,
    (SELECT coalesce(max(CASE WHEN e.payload::jsonb#>>'{data,object,amount_refunded}' ~ '^[0-9]{1,16}$'
      THEN (e.payload::jsonb#>>'{data,object,amount_refunded}')::bigint ELSE NULL END),0)
      FROM payment_provider_events e WHERE e.workspace_id=$1 AND e.provider=$2 AND e.event_type='REFUNDED'
        AND (e.external_payment_id=$3 OR e.payload::jsonb#>>'{data,object,id}'=$3)
        AND e.payload::jsonb->>'type'='charge.refunded') reported`,[workspaceId,provider,externalPaymentId])).rows[0];
  if(money.integer(history.reported,'Provider-reported refund')>money.integer(history.booked,'Recorded refunds')){
    throw new ValidationError('The original provider reports another refund. Reconcile it before approving or sending another repayment.');
  }
}

async function provenTenders(db,ctx,invoice,lock){
  const payments=require('../payments/postgres-collection');
  const rows=await paymentsFor(db,ctx.workspaceId,invoice,lock);
  const legacy=(await db.query(`SELECT coalesce(sum(coalesce(r.settled_amount_minor,r.revenue_minor+r.tax_minor)),0) cash
    FROM accounting_sale_refunds r JOIN accounting_journal_entries j ON j.workspace_id=r.workspace_id AND j.id=r.journal_entry_id
    JOIN accounting_journal_entries original ON original.workspace_id=r.workspace_id AND original.id=r.original_journal_entry_id
    WHERE r.workspace_id=$1 AND original.source_record_type='sales_order' AND original.source_record_id=$2 AND r.destination='CASH'
      AND j.status='POSTED' AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_return_refund_plans plan
        WHERE plan.workspace_id=r.workspace_id AND plan.customer_return_id=j.source_record_id)`,[ctx.workspaceId,invoice.sales_order_id])).rows[0];
  let historic=Number(legacy.cash);
  // A single original receipt can absorb a historical refund whose older
  // record did not name a tender. Split historical receipts need their own proof.
  const providerLegacy=rows.reduce((n,row)=>n+(row.provider_identities.length===1?Number(row.provider_identities[0].priorLegacy):0),0);
  historic=Math.max(0,historic-providerLegacy);
  if(historic&&rows.length!==1)throw new ValidationError('An earlier refund does not identify which original payment was used. Reconcile its exact tender first.');
  const tenders=[];
  for(const p of rows){
    const amount=Number(p.amount_minor);
    if(!p.valid_journal||Number(p.cash_paid)!==amount||Number(p.ledger_active)!==1||p.account_type!=='ASSET'||p.normal_balance!=='DEBIT'){
      throw new ValidationError('An original payment needs its posted cash ledger evidence checked.');
    }
    const identities=new Set(p.provider_identities.map(e=>JSON.stringify([e.provider,e.requestId,e.externalPaymentId])));
    const merchants=new Set(p.provider_identities.map(e=>e.merchant).filter(Boolean));
    if(identities.size>1||merchants.size>1)throw new ValidationError('An original online payment has conflicting provider identities.');
    const identity=p.provider_identities[0],sourceMerchant=[...merchants][0];
    if(!identity&&payments.isProviderReceipt(p.source_key))throw new ValidationError('Verify the exact original provider payment before refunding it.');
    const recorded=methodName(p.method),method=identity?identity.provider:recorded;
    if(!identity&&!recorded)throw new ValidationError('Confirm the original recorded payment method before refunding this receipt.');
    let merchant=null;
    if(identity){
      if(!['stripe','cardknox'].includes(identity.provider))throw new ValidationError('The original online payment method needs an individually verified provider refund.');
      const account=await payments.accountFor(db,ctx.workspaceId,identity.provider);
      if(!sourceMerchant||sourceMerchant!==account.provider_account_id)throw new ValidationError('Verify the merchant account that took the original payment.');
      merchant=account.provider_account_id;
      await checkProviderRefundHistory(db,ctx.workspaceId,identity.provider,identity.externalPaymentId);
    }
    const prior=Number(identity?.priorLegacy||0)+(rows.length===1?historic:0);
    const available=Math.min(Number(p.allocated)-Number(p.already_paid_invoice),amount-Number(p.already_paid))-prior;
    if(available>0)tenders.push({paymentId:p.id,paymentNumber:p.payment_number,createdAt:p.created_at,paymentDate:p.payment_date,
      cashAccountId:p.cash_account_id,cashAccountName:p.cash_name,method,
      methodLabel:identity?(identity.provider==='stripe'?'Stripe':'Sola/Cardknox'):(offline.get(recorded)||String(p.method).trim()),
      availableMinor:available,provider:identity?.provider||null,providerAccountId:merchant,
      paymentRequestId:identity?.requestId||null,externalPaymentId:identity?.externalPaymentId||null});
  }
  return tenders;
}

function selectTenders(tenders,cashDue,credits,requested,currency){
  const chosen=new Map(),unspent=new Map(tenders.map(t=>[t.paymentId,t.availableMinor]));
  if(requested){
    const refs=new Map(tenders.map(t=>[t.paymentNumber.trim().toLowerCase(),t]));
    const seen=new Set();
    for(const item of String(requested).split(/[;|\r\n]+/).map(x=>x.trim()).filter(Boolean)){
      const match=/^(.*?)\s*=\s*(.+)$/.exec(item),ref=match?.[1].trim().toLowerCase(),tender=refs.get(ref);
      if(!tender||seen.has(ref))throw new ValidationError('Choose each exact original receipt number and refund amount once.');
      seen.add(ref);
      const amount=money.userToMinor(match[2],currency);
      if(amount<=0||amount>tender.availableMinor)throw new ValidationError('A refund amount exceeds its available original payment.');
      chosen.set(tender.paymentId,amount);
    }
    if(money.sum([...chosen.values()])!==cashDue)throw new ValidationError('The exact original-payment amounts must cover the paid refund.');
    // The accumulated approved portions must be covered by receipts already
    // on the books as each customer refund liability arose.
    let needed=0;
    for(const credit of credits){
      needed+=credit.amountMinor;
      const available=tenders.filter(p=>Date.parse(p.createdAt)<=credit.at).reduce((n,p)=>n+(chosen.get(p.paymentId)||0),0);
      if(available<needed)throw new ValidationError('A selected payment was recorded after the return credit it is meant to cover.');
    }
  }else{
    for(const credit of credits){
      let remaining=credit.amountMinor;
      for(const p of tenders){
        if(!remaining)break;
        if(Date.parse(p.createdAt)>credit.at)continue;
        const amount=Math.min(remaining,unspent.get(p.paymentId));
        if(amount>0){chosen.set(p.paymentId,(chosen.get(p.paymentId)||0)+amount);unspent.set(p.paymentId,unspent.get(p.paymentId)-amount);remaining-=amount;}
      }
      if(remaining)throw new ValidationError('The paid credit exceeds the proven original payments still available to refund.');
    }
  }
  return tenders.filter(p=>chosen.has(p.paymentId)).map(p=>({...p,amountMinor:chosen.get(p.paymentId)}));
}

async function snapshot(db,ctx,returnId,{requested='',lock=false}={}){
  if(lock)await db.query('SELECT id FROM customer_returns WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,returnId]);
  const row=await require('./postgres-returns').getCustomerReturn(db,ctx.workspaceId,returnId);
  if(row.status!=='AWAITING_REFUND'||row.resolution!=='REFUND')throw new ValidationError('This customer return is not awaiting an approved refund.');
  const invoice=(await db.query(`SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2 AND customer_id=$3`+
    (lock?' FOR UPDATE':''),[ctx.workspaceId,row.sales_order_id,row.customer_id])).rows[0];
  if(!invoice||invoice.currency!==row.currency||!['OPEN','PARTIALLY_PAID','PAID'].includes(invoice.status)) {
    throw new ValidationError('Use the exact issued invoice and its current posted balance.');
  }
  requested=String(requested||'').trim();
  const amount=financials.summary(row),modern=row.receipt_credit_policy==='RECEIPT_CREDIT_V1';
  const credits=modern?await creditProof(db,ctx.workspaceId,row.id,row.currency):[];
  if(modern&&amount.totalMinor&&!credits.length)throw new ValidationError('The original posted receipt credit is missing.');
  if(!modern&&amount.totalMinor>Number(invoice.total_minor))throw new ValidationError('This credit exceeds the current invoice value.');
  const arMinor=modern?sum(credits,'ar_credit_minor'):Math.min(Number(invoice.balance_minor),amount.totalMinor);
  const cashDue=modern?sum(credits,'cash_due_minor')-sum(credits,'cash_refunded_minor'):amount.totalMinor-arMinor;
  const legacyCreditFingerprint=!modern&&cashDue
    ?(await require('./postgres-legacy-return-credits').preview(db,ctx,row.id)).integrity:null;
  const windows=modern?credits.map(c=>({amountMinor:Number(c.cash_due_minor)-Number(c.cash_refunded_minor),at:new Date(c.created_at).getTime()}))
    :[{amountMinor:cashDue,at:Date.now()}];
  const parts=cashDue?selectTenders(await provenTenders(db,ctx,invoice,lock),cashDue,windows,requested,row.currency):[];
  const invoiceState={id:invoice.id,number:invoice.invoice_number,totalMinor:Number(invoice.total_minor),balanceMinor:Number(invoice.balance_minor),
    balanceAfterMinor:modern?Number(invoice.balance_minor):Number(invoice.balance_minor)-arMinor,status:invoice.status,updatedAt:invoice.updated_at};
  const result={recordId:row.id,returnNumber:row.return_number,customerId:row.customer_id,salesOrderId:row.sales_order_id,
    currency:row.currency,invoice:invoiceState,creditPosted:modern,arMinor,amountMinor:cashDue,
    legacyCreditFingerprint,totalCreditMinor:amount.totalMinor,priceMinor:amount.priceMinor,chargesMinor:amount.chargesMinor,discountMinor:amount.discountMinor,taxMinor:amount.taxMinor,parts,requested};
  return {...result,sourceFingerprint:hash({...result,credits:credits.map(c=>[c.id,c.journal_entry_id,c.cash_refunded_minor]),
    legacyGroups:modern?null:financials.groups(row)})};
}

module.exports={ACTION,JOB,owner,access,snapshot,creditProof,checkProviderRefundHistory,provenTenders,offline};

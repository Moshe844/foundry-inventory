'use strict';
// Job 107: StockChief prepares refunds and credits; a person always approves.
// Returns keep their own exact refund plans (customer_return.refund). This
// covers the rest of the PDF row:
//  - a price adjustment (a lower agreed price, or a price charged above what
//    was agreed) credits the exact goods amount, the original discount share
//    and the tax on it, from the posted invoice line;
//  - an overcharge, money paid beyond what a shipped order came to;
//  - an order cancelled after payment, the money it still holds.
// Shipping rule: a price adjustment never changes the shipping or other
// charges on the invoice; money held for a cancelled order is refunded in
// full, including any shipping paid in advance, because nothing was shipped
// against it.
//
// Approval posts the credit note through the ledger: the unpaid part lowers
// the invoice, the paid part becomes a refund owed. Each refund goes back
// through an original payment: through Stripe or Sola when they took the
// money (booked only on their exact confirmation), otherwise as an
// instruction for a person to pay, booked only when they say it is paid.
// StockChief never pays money on its own.
const {ValidationError,NotFoundError}=require('../domain/errors');
const money=require('../domain/currency');
const {hash}=require('../pricing/postgres-promotions');
const {newId}=require('../lib/util');
const {has}=require('../db/schema-installed');
const policy=require('../commercial/agent-plan');
const evidence=require('../operations/return-refund-evidence');
const effects=require('../operations/postgres-provider-effects');
const ledger=require('./postgres-ledger');
const ACTION='customer_credit.prepare',CREDITS='stockchief_runtime.agent_customer_credits',REFUNDS='stockchief_runtime.agent_customer_credit_refunds';
const KINDS={price_adjustment:'Price adjustment',overpayment:'Paid more than the order came to',cancellation:'Order cancelled after payment'};
const path='/autopilot/reviews/customer-credits';
const audit=(c,ctx,entry)=>require('../operations/postgres-security-audit').record(c,ctx,entry);
const round=(value,num,den)=>den?Number((BigInt(value)*BigInt(num)*2n+BigInt(den))/(BigInt(den)*2n)):0;
const snapshotOf=line=>{const v=line.pricing_snapshot;if(!v)return null;return typeof v==='string'?JSON.parse(v):v;};

// Which original payments still have this much left to give back.
function choose(tenders,amount,requested,currency){
  const chosen=new Map();
  if(String(requested||'').trim()){
    const refs=new Map(tenders.map(t=>[t.paymentNumber.trim().toLowerCase(),t])),seen=new Set();
    for(const item of String(requested).split(/[;|\r\n]+/).map(x=>x.trim()).filter(Boolean)){
      const m=/^(.*?)\s*=\s*(.+)$/.exec(item),ref=m?.[1].trim().toLowerCase(),tender=refs.get(ref);
      if(!tender||seen.has(ref))throw new ValidationError('Choose each original receipt number and refund amount once.');
      seen.add(ref);const value=money.userToMinor(m[2],currency);
      if(value<=0||value>tender.availableMinor)throw new ValidationError('A refund amount is more than its original payment has left.');
      chosen.set(tender.paymentId,value);
    }
    if(money.sum([...chosen.values()])!==amount)throw new ValidationError('The amounts for each original payment must add up to the exact refund.');
  }else{
    let left=amount;
    for(const t of tenders){if(!left)break;const take=Math.min(left,t.availableMinor);if(take>0){chosen.set(t.paymentId,take);left-=take;}}
    if(left)throw new ValidationError('The refund is more than the original payments still have to give back. Check the payments first.');
  }
  return tenders.filter(t=>chosen.has(t.paymentId)).map(t=>({paymentId:t.paymentId,paymentNumber:t.paymentNumber,cashAccountId:t.cashAccountId,cashAccountName:t.cashAccountName,
    method:t.method,methodLabel:t.methodLabel,amountMinor:chosen.get(t.paymentId),provider:t.provider||null,providerAccountId:t.providerAccountId||null,
    paymentRequestId:t.paymentRequestId||null,externalPaymentId:t.externalPaymentId||null}));
}

// Receipts that hold money for an order (not applied to an invoice).
async function heldTenders(db,ctx,order,lock){
  if(lock)await db.query(`SELECT id FROM accounting_payments WHERE workspace_id=$1 AND sales_order_id=$2 ORDER BY id FOR UPDATE`,[ctx.workspaceId,order.id]);
  const rows=(await db.query(`SELECT p.id,p.payment_number,p.payment_date,p.created_at,p.amount_minor,p.method,p.source_key,p.cash_account_id,a.name cash_name,a.active ledger_active,a.account_type,a.normal_balance,
      p.amount_minor-coalesce((SELECT sum(x.amount_minor) FROM accounting_payment_allocations x WHERE x.workspace_id=p.workspace_id AND x.payment_id=p.id),0) unapplied,
      coalesce((SELECT sum(r.amount_minor) FROM ${REFUNDS} r JOIN ${CREDITS} c ON c.workspace_id=r.workspace_id AND c.id=r.credit_id WHERE r.workspace_id=p.workspace_id AND r.original_payment_id=p.id AND r.status<>'FAILED' AND c.kind<>'price_adjustment'),0) held_spent,
      coalesce((SELECT sum(r.amount_minor) FROM ${REFUNDS} r WHERE r.workspace_id=p.workspace_id AND r.original_payment_id=p.id AND r.status<>'FAILED'),0)
       +coalesce((SELECT sum(s.amount_minor) FROM stockchief_runtime.agent_return_refund_parts s WHERE s.workspace_id=p.workspace_id AND s.original_payment_id=p.id AND s.status IN('APPROVED','SETTLED','REVIEW')),0) all_spent,
      j.status='POSTED' AND j.source_type IN('customer_payment','customer_deposit') AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id AND r.status='POSTED') valid_journal,
      coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('provider',e.provider,'requestId',q.id,'externalPaymentId',e.external_payment_id,
        'merchant',coalesce(e.payload::jsonb->>'providerAccountId',e.payload::jsonb->>'account',(SELECT k.merchant_account_id FROM cardknox_checkout_sessions k WHERE q.provider='cardknox' AND k.workspace_id=q.workspace_id AND k.request_id=q.id))))
        FROM payment_provider_events e JOIN payment_requests q ON q.workspace_id=e.workspace_id AND q.id=e.request_id
        WHERE e.workspace_id=p.workspace_id AND e.payment_id=p.id AND e.processed_at IS NOT NULL AND e.external_payment_id IS NOT NULL AND q.customer_id=p.customer_id AND q.currency=p.currency AND q.provider=e.provider),'[]'::jsonb) identities
    FROM accounting_payments p JOIN accounting_accounts a ON a.workspace_id=p.workspace_id AND a.id=p.cash_account_id
    JOIN accounting_journal_entries j ON j.workspace_id=p.workspace_id AND j.id=p.journal_entry_id
    WHERE p.workspace_id=$1 AND p.sales_order_id=$2 AND p.customer_id=$3 AND p.currency=$4 AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED'
    ORDER BY p.created_at,p.payment_date,p.id`,[ctx.workspaceId,order.id,order.customer_id,order.currency])).rows;
  const legacy=Number((await db.query(`SELECT coalesce(sum(amount_minor),0) n FROM accounting_deposit_refunds WHERE workspace_id=$1 AND sales_order_id=$2 AND source_key NOT LIKE 'agent-customer-credit:%'`,[ctx.workspaceId,order.id])).rows[0].n);
  const holding=rows.filter(r=>Number(r.unapplied)-Number(r.held_spent)>0);
  if(legacy&&holding.length>1)throw new ValidationError('An earlier refund on this order does not say which payment it came from. Refund it yourself from the order.');
  const tenders=[];
  for(const p of rows){
    let available=Math.min(Number(p.unapplied)-Number(p.held_spent),Number(p.amount_minor)-Number(p.all_spent));
    if(legacy&&holding.length===1&&holding[0].id===p.id)available-=legacy;
    if(available<=0)continue;
    if(!p.valid_journal||Number(p.ledger_active)!==1||p.account_type!=='ASSET'||p.normal_balance!=='DEBIT')throw new ValidationError('An original payment needs its posted cash ledger checked first.');
    tenders.push({...await identify(db,ctx,p,p.identities),paymentId:p.id,paymentNumber:p.payment_number,cashAccountId:p.cash_account_id,cashAccountName:p.cash_name,availableMinor:available});
  }
  return tenders;
}
async function identify(db,ctx,p,identities){
  const payments=require('../payments/postgres-collection');
  const keys=new Set(identities.map(e=>JSON.stringify([e.provider,e.requestId,e.externalPaymentId]))),merchants=new Set(identities.map(e=>e.merchant).filter(Boolean));
  if(keys.size>1||merchants.size>1)throw new ValidationError('An original online payment has conflicting provider details. Check it before refunding.');
  const identity=identities[0];
  const method=String(p.method||'').trim().toLowerCase().replace(/[\s-]+/g,'_');
  if(!identity){
    if(payments.isProviderReceipt(p.source_key))throw new ValidationError('Verify the original online payment before refunding it.');
    if(!method)throw new ValidationError('Confirm how the original payment was made before refunding it.');
    return {method,methodLabel:evidence.offline.get(method)||String(p.method).trim(),provider:null};
  }
  if(!['stripe','cardknox'].includes(identity.provider))throw new ValidationError('This online payment needs a refund you make yourself with its provider.');
  const account=await payments.accountFor(db,ctx.workspaceId,identity.provider);
  if(![...merchants][0]||[...merchants][0]!==account.provider_account_id)throw new ValidationError('Reconnect the merchant account that took the original payment.');
  await evidence.checkProviderRefundHistory(db,ctx.workspaceId,identity.provider,identity.externalPaymentId);
  return {method:identity.provider,methodLabel:identity.provider==='stripe'?'Stripe':'Sola/Cardknox',provider:identity.provider,providerAccountId:account.provider_account_id,
    paymentRequestId:identity.requestId,externalPaymentId:identity.externalPaymentId};
}

// "1=8.00; 2=3.50" or "SKU=8.00": the new unit price for each invoice line.
function parseLines(text,lines,skus,currency){
  const out=new Map();
  for(const item of String(text||'').split(/[;\r\n]+/).map(x=>x.trim()).filter(Boolean)){
    const m=/^(.+?)\s*=\s*(.+)$/.exec(item);if(!m)throw new ValidationError('Write each line as its line number or product code, then = and the new unit price.');
    const key=m[1].trim().replace(/^line\s+/i,'').toLowerCase();
    const line=lines.find(l=>String(l.line_number)===key)||lines.find(l=>l.sku_id&&skus.get(l.sku_id)?.toLowerCase()===key);
    if(!line)throw new ValidationError('“'+m[1].trim()+'” is not a line on this invoice.');
    if(out.has(line.id))throw new ValidationError('Give each invoice line one new price.');
    out.set(line.id,money.userToMinor(m[2],currency));
  }
  if(!out.size)throw new ValidationError('Give the invoice line and its new unit price, for example 1=8.00.');
  return out;
}

async function priceAdjustment(db,ctx,invoice,args,lock){
  if(!['OPEN','PARTIALLY_PAID','PAID'].includes(invoice.status))throw new ValidationError('Use an issued customer invoice.');
  const returned=invoice.sales_order_id&&(await db.query(`SELECT 1 FROM customer_returns WHERE workspace_id=$1 AND sales_order_id=$2 AND status<>'CANCELLED' LIMIT 1`,[ctx.workspaceId,invoice.sales_order_id])).rowCount;
  if(returned)throw new ValidationError('Goods on this invoice were returned. Credit the return first, then adjust the price yourself so the two never overlap.');
  const lines=(await db.query('SELECT * FROM accounting_customer_invoice_lines WHERE workspace_id=$1 AND invoice_id=$2 ORDER BY line_number',[ctx.workspaceId,invoice.id])).rows;
  const skus=new Map((await db.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,lines.map(l=>l.sku_id).filter(Boolean)])).rows.map(r=>[r.id,r.code]));
  const wanted=parseLines(args.creditLines,lines,skus,invoice.currency);
  // Earlier approved adjustments set the price each new one starts from.
  const earlier=new Map();
  for(const r of (await db.query(`SELECT snapshot FROM ${CREDITS} WHERE workspace_id=$1 AND invoice_id=$2 AND kind='price_adjustment' ORDER BY created_at,id`,[ctx.workspaceId,invoice.id])).rows)
    for(const l of r.snapshot.lines||[])earlier.set(l.lineId,l.newUnitMinor);
  const out=[];
  for(const [lineId,newUnit] of wanted){
    const line=lines.find(l=>l.id===lineId),unit=Number(line.unit_price_minor),from=earlier.has(lineId)?earlier.get(lineId):unit;
    let s=snapshotOf(line);
    if(!s){
      if(lines.length!==1)throw new ValidationError('Line '+line.line_number+' has no recorded price breakdown. Prepare this credit yourself.');
      s={grossMinor:Number(invoice.subtotal_minor),discountMinor:Number(invoice.discount_minor),taxMinor:Number(invoice.tax_minor),chargeTaxMinor:0};
    }
    if(!unit||newUnit<0||newUnit>=from)throw new ValidationError('The new price for line '+line.line_number+' must be lower than '+money.format(from,invoice.currency)+'.');
    const G=Number(s.grossMinor??s.revenueMinor),D=Number(s.discountMinor||0),T=Number(s.taxMinor||0)-Number(s.chargeTaxMinor||0);
    const at=price=>{const g=round(G,price,unit),d=round(D,g,G),n=g-d;return {g,d,n,t:round(T,n,G-D)};};
    const before=at(from),after=at(newUnit);
    out.push({lineId,lineNumber:line.line_number,description:line.description,quantity:Number(line.quantity),unitMinor:unit,fromUnitMinor:from,newUnitMinor:newUnit,
      grossMinor:before.g-after.g,discountMinor:before.d-after.d,revenueMinor:before.n-after.n,taxMinor:before.t-after.t,chargesMinor:0});
  }
  const sum=k=>money.sum(out.map(l=>l[k]));
  const revenueMinor=sum('revenueMinor'),taxMinor=sum('taxMinor'),creditMinor=revenueMinor+taxMinor;
  if(creditMinor<=0)throw new ValidationError('This change is too small to make a credit.');
  if(creditMinor>Number(invoice.total_minor))throw new ValidationError('This credit is more than the invoice total.');
  const arMinor=Math.min(Number(invoice.balance_minor),creditMinor),refundMinor=creditMinor-arMinor;
  const parts=refundMinor?choose(await evidence.provenTenders(db,ctx,invoice,lock),refundMinor,args.refundPayments,invoice.currency):[];
  return {kind:'price_adjustment',invoiceId:invoice.id,invoiceNumber:invoice.invoice_number,salesOrderId:invoice.sales_order_id,customerId:invoice.customer_id,currency:invoice.currency,
    invoiceBalanceMinor:Number(invoice.balance_minor),invoiceTotalMinor:Number(invoice.total_minor),lines:out,grossMinor:sum('grossMinor'),discountMinor:sum('discountMinor'),
    revenueMinor,taxMinor,creditMinor,arMinor,refundMinor,parts};
}
async function heldMoney(db,ctx,order,args,lock){
  if(!['CANCELLED','FULFILLED'].includes(order.status))throw new ValidationError('Money paid on an open order is still waiting for its goods. A person cancels the order first.');
  const kind=order.status==='CANCELLED'?'cancellation':'overpayment';
  if(args.creditKind&&args.creditKind!==kind)throw new ValidationError(kind==='cancellation'?'This order was cancelled; prepare an order cancellation refund.':'This order was shipped; prepare a refund of the money paid beyond what it came to.');
  const position=await require('../sales/postgres-deposit-refunds').forOrder(db,ctx.workspaceId,order.id);
  const refundMinor=position?.toRefundMinor||0;
  if(refundMinor<=0)throw new ValidationError('This order has no paid money left to give back.');
  const parts=choose(await heldTenders(db,ctx,order,lock),refundMinor,args.refundPayments,order.currency);
  return {kind,salesOrderId:order.id,orderNumber:order.order_number,customerId:order.customer_id,currency:order.currency,refundMinor,creditMinor:0,arMinor:0,parts,
    receivedRefundedMinor:position.refundedMinor};
}

// The exact credit for one request, from the records as they are now.
async function snapshot(db,ctx,args,{lock=false}={}){
  const reference=String(args.recordReference||'').trim();
  if(!reference||reference.length>150)throw new ValidationError('Choose the exact invoice or order number.');
  const reason=String(args.reason||'').trim()||KINDS[args.creditKind]||'';
  if(!reason||reason.length>300)throw new ValidationError('Say in a few words why this credit is due.');
  if(args.creditKind&&!KINDS[args.creditKind])throw new ValidationError('Choose a price adjustment, money paid beyond the order, or an order cancelled after payment.');
  let body;
  if(args.creditKind==='price_adjustment'||(!args.creditKind&&args.creditLines)){
    const invoice=(await db.query(`SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND (id=$2 OR lower(invoice_number)=lower($2))${lock?' FOR UPDATE':''}`,[ctx.workspaceId,reference])).rows;
    if(invoice.length!==1)throw new ValidationError('Choose one exact customer invoice number.');
    body=await priceAdjustment(db,ctx,invoice[0],args,lock);
  }else{
    const order=(await db.query(`SELECT * FROM sales_orders WHERE workspace_id=$1 AND (id=$2 OR lower(order_number)=lower($2))${lock?' FOR UPDATE':''}`,[ctx.workspaceId,reference])).rows;
    if(order.length!==1)throw new ValidationError('Choose one exact customer order number.');
    body=await heldMoney(db,ctx,order[0],args,lock);
  }
  const customer=(await db.query('SELECT name FROM customers WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,body.customerId])).rows[0];
  const p={...body,customerName:customer?.name||'',reason,requested:String(args.refundPayments||'').trim()};
  return {...p,sourceFingerprint:hash(p)};
}
function describe(p){
  const f=v=>money.format(v,p.currency);
  const how=p.parts.map(s=>f(s.amountMinor)+(s.provider?' back through '+s.methodLabel+' ('+s.paymentNumber+')':' for a person to pay back by '+s.methodLabel+' ('+s.paymentNumber+')')).join(', ');
  if(p.kind==='price_adjustment')return 'Credit '+f(p.creditMinor)+' on '+p.invoiceNumber+' for '+p.customerName+' ('+p.lines.map(l=>'line '+l.lineNumber+' '+f(l.fromUnitMinor)+' to '+f(l.newUnitMinor)).join(', ')+'): '+
    f(p.revenueMinor)+' goods after the original discount and '+f(p.taxMinor)+' tax. Shipping and other charges stay as invoiced. '+(p.arMinor?f(p.arMinor)+' lowers what is still owed. ':'')+(p.refundMinor?'Refund '+f(p.refundMinor)+': '+how+'.':'No money is paid back.');
  return 'Refund '+f(p.refundMinor)+' to '+p.customerName+' for '+p.orderNumber+(p.kind==='cancellation'?', cancelled after payment (including any shipping paid in advance)':', paid beyond what it came to')+': '+how+'.';
}
async function build(db,ctx,row,args){
  await evidence.access(db,ctx);
  const p=await snapshot(db,ctx,args);
  return {payload:p,summary:describe(p)+' A person approves this; StockChief never pays money on its own.'};
}

async function postPayout(c,ctx,credit,part){
  const deposit=credit.kind!=='price_adjustment',amount=Number(part.amount_minor);
  if(!deposit)await ledger.ensureSystemAccountInTransaction(c,ctx,'CUSTOMER_REFUNDS_PAYABLE');
  const posted=await ledger.postInTransaction(c,ctx,{sourceKey:'agent-customer-credit-refund:'+part.id,description:(deposit?'Refund held money on ':'Refund credit on ')+(credit.snapshot.orderNumber||credit.snapshot.invoiceNumber),
    sourceType:deposit?'customer_deposit_refund':'customer_credit_refund',sourceRecordType:deposit?'sales_order':'customer_invoice',sourceRecordId:deposit?credit.sales_order_id:credit.invoice_id,currency:credit.currency,
    metadata:{creditId:credit.id,refundId:part.id,originalPaymentId:part.original_payment_id,method:part.method,externalRefundId:part.external_refund_id||null,paidReference:part.paid_reference||null},
    lines:[{accountKey:deposit?'CUSTOMER_DEPOSITS':'CUSTOMER_REFUNDS_PAYABLE',debitMinor:amount,customerId:credit.customer_id},{accountId:part.cash_account_id,creditMinor:amount,customerId:credit.customer_id}]});
  let depositRefundId=null;
  if(deposit){
    depositRefundId=newId('depositrefund');
    await c.query(`INSERT INTO accounting_deposit_refunds(id,workspace_id,sales_order_id,customer_id,amount_minor,currency,refund_date,method,reference,journal_entry_id,source_key,created_by_user_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[depositRefundId,ctx.workspaceId,credit.sales_order_id,credit.customer_id,amount,credit.currency,await require('../lib/business-time').today(c,ctx.workspaceId),
      part.method,part.external_refund_id||part.paid_reference||null,posted.entry.id,'agent-customer-credit:'+part.id,ctx.actorId||null,new Date().toISOString()]);
  }
  await c.query(`UPDATE ${REFUNDS} SET status='SETTLED',journal_entry_id=$3,deposit_refund_id=$4,settled_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,part.id,posted.entry.id,depositRefundId]);
  if(!(await c.query(`SELECT 1 FROM ${REFUNDS} WHERE workspace_id=$1 AND credit_id=$2 AND status<>'SETTLED' LIMIT 1`,[ctx.workspaceId,credit.id])).rowCount)
    await c.query(`UPDATE ${CREDITS} SET status='COMPLETED',completed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status<>'COMPLETED'`,[ctx.workspaceId,credit.id]);
  return posted.entry.id;
}

// Approval: a person approved these exact amounts.
async function execute(client,ctx,p){
  await evidence.access(client,ctx,{approve:true,lock:true});
  const prior=(await client.query(`SELECT * FROM ${CREDITS} WHERE workspace_id=$1 AND approval_key=$2`,[ctx.workspaceId,p.idempotencyKey])).rows[0];
  if(prior){if(prior.source_fingerprint!==p.sourceFingerprint)throw new ValidationError('This approval was already used for different amounts.');return result(client,ctx,prior,true);}
  const fresh=await snapshot(client,ctx,{recordReference:p.invoiceId||p.salesOrderId,creditKind:p.kind,creditLines:p.lines?.map(l=>l.lineNumber+'='+money.fromMinor(l.newUnitMinor,p.currency)).join(';'),reason:p.reason,refundPayments:p.requested},{lock:true});
  if(fresh.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('The invoice, order or original payments changed. Prepare the credit again for approval.');
  if(fresh.parts.some(s=>s.provider))await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'payments.customer');
  const id=newId('custcredit');let journalEntryId=null;
  if(fresh.kind==='price_adjustment'){
    if(fresh.refundMinor)await ledger.ensureSystemAccountInTransaction(client,ctx,'CUSTOMER_REFUNDS_PAYABLE');
    const posted=await ledger.postInTransaction(client,ctx,{sourceKey:'agent-customer-credit:'+id,description:'Credit note on '+fresh.invoiceNumber+': '+fresh.reason,sourceType:'customer_credit_note',
      sourceRecordType:'customer_invoice',sourceRecordId:fresh.invoiceId,currency:fresh.currency,metadata:{creditId:id,revenueMinor:fresh.revenueMinor,taxMinor:fresh.taxMinor,arMinor:fresh.arMinor,refundMinor:fresh.refundMinor},
      lines:[{accountKey:'SALES_RETURNS',debitMinor:fresh.revenueMinor,customerId:fresh.customerId},{accountKey:'SALES_TAX_PAYABLE',debitMinor:fresh.taxMinor,customerId:fresh.customerId},
        {accountKey:'ACCOUNTS_RECEIVABLE',creditMinor:fresh.arMinor,customerId:fresh.customerId},{accountKey:'CUSTOMER_REFUNDS_PAYABLE',creditMinor:fresh.refundMinor,customerId:fresh.customerId}].filter(l=>(l.debitMinor||l.creditMinor)>0)});
    journalEntryId=posted.entry.id;
    const invoice=(await client.query('SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,fresh.invoiceId])).rows[0];
    const total=Number(invoice.total_minor)-fresh.creditMinor,balance=Number(invoice.balance_minor)-fresh.arMinor;
    await client.query(`UPDATE accounting_customer_invoices SET subtotal_minor=subtotal_minor-$3::integer,discount_minor=discount_minor-$4::integer,tax_minor=tax_minor-$5::integer,total_minor=$6::integer,balance_minor=$7::integer,status=$8,
      paid_at=CASE WHEN $7::integer=0 THEN coalesce(paid_at,$9) ELSE paid_at END,updated_at=$9 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,invoice.id,fresh.grossMinor,fresh.discountMinor,fresh.taxMinor,total,balance,balance===0?'PAID':balance<total?'PARTIALLY_PAID':'OPEN',new Date().toISOString()]);
  }
  await client.query(`INSERT INTO ${CREDITS}(workspace_id,id,kind,customer_id,invoice_id,sales_order_id,currency,credit_minor,ar_minor,refund_minor,reason,snapshot,source_fingerprint,approval_key,approved_by,journal_entry_id,status,completed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18)`,
  [ctx.workspaceId,id,fresh.kind,fresh.customerId,fresh.invoiceId||null,fresh.salesOrderId||null,fresh.currency,fresh.creditMinor,fresh.arMinor,fresh.refundMinor,fresh.reason,JSON.stringify(fresh),fresh.sourceFingerprint,
    p.idempotencyKey,ctx.actorId,journalEntryId,fresh.parts.length?'AWAITING_REFUND':'COMPLETED',fresh.parts.length?null:new Date().toISOString()]);
  for(const s of fresh.parts){
    const partId=newId('creditrefund');
    await client.query(`INSERT INTO ${REFUNDS}(workspace_id,id,credit_id,original_payment_id,cash_account_id,method,amount_minor,provider,provider_account_id,payment_request_id,external_payment_id,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[ctx.workspaceId,partId,id,s.paymentId,s.cashAccountId,s.method,s.amountMinor,s.provider,s.providerAccountId,s.paymentRequestId,s.externalPaymentId,s.provider?'APPROVED':'TO_PAY']);
    if(s.provider)await effects.enqueueInTransaction(client,{workspaceId:ctx.workspaceId,kind:'payment.refund.create',provider:s.provider,aggregateType:'customer_credit',aggregateId:id,
      idempotencyKey:'agent-customer-credit-refund:'+partId,requestedByUserId:ctx.actorId,payload:{customerCreditPartId:partId,creditId:id,actorId:ctx.actorId},priority:5,maxAttempts:12});
  }
  await audit(client,ctx,{action:'Customer credit approved: '+KINDS[fresh.kind].toLowerCase(),reference:fresh.invoiceNumber||fresh.orderNumber,
    after:{creditId:id,creditMinor:fresh.creditMinor,arMinor:fresh.arMinor,refundMinor:fresh.refundMinor,currency:fresh.currency,refunds:fresh.parts.map(s=>({payment:s.paymentNumber,amountMinor:s.amountMinor,through:s.provider||'a person'}))}});
  return result(client,ctx,(await client.query(`SELECT * FROM ${CREDITS} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id])).rows[0],false);
}
async function result(db,ctx,credit,replayed){
  const parts=(await db.query(`SELECT id,status,amount_minor,provider FROM ${REFUNDS} WHERE workspace_id=$1 AND credit_id=$2 ORDER BY created_at,id`,[ctx.workspaceId,credit.id])).rows;
  return {creditId:credit.id,status:credit.status,journalEntryId:credit.journal_entry_id,refundMinor:Number(credit.refund_minor),arMinor:Number(credit.ar_minor),
    refunds:parts.map(r=>({id:r.id,status:r.status,amountMinor:Number(r.amount_minor),provider:r.provider})),href:path,replayed};
}
async function verify(db,ctx,r,p){
  const credit=(await db.query(`SELECT * FROM ${CREDITS} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.creditId])).rows[0];
  if(!credit||credit.source_fingerprint!==p.sourceFingerprint||Number(credit.refund_minor)!==p.refundMinor)return false;
  const parts=(await db.query(`SELECT * FROM ${REFUNDS} WHERE workspace_id=$1 AND credit_id=$2`,[ctx.workspaceId,credit.id])).rows;
  return parts.length===p.parts.length&&parts.every(part=>p.parts.some(s=>s.paymentId===part.original_payment_id&&s.amountMinor===Number(part.amount_minor)))&&
    (p.kind!=='price_adjustment'||Boolean(credit.journal_entry_id));
}

// A person paid an offline refund: book it against the original payment's account.
async function markPaid(db,ctx,partId,input={}){
  const reference=String(input.reference||'').trim();
  if(!reference||reference.length>120)throw new ValidationError('Add how it was paid back, such as the check number or transfer reference.');
  return db.transaction(async c=>{
    await evidence.access(c,ctx,{approve:true,lock:true});
    const part=(await c.query(`SELECT * FROM ${REFUNDS} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,partId])).rows[0];
    if(!part)throw new NotFoundError('That refund was not found.');
    if(part.status==='SETTLED'){if(part.paid_reference===reference)return {replayed:true,journalEntryId:part.journal_entry_id};throw new ValidationError('This refund is already recorded as paid.');}
    if(part.status!=='TO_PAY')throw new ValidationError('This refund goes back through the payment provider.');
    const credit=(await c.query(`SELECT * FROM ${CREDITS} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,part.credit_id])).rows[0];
    const payment=(await c.query(`SELECT status FROM accounting_payments WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,part.original_payment_id])).rows[0];
    if(payment?.status!=='POSTED')throw new ValidationError('The original payment was changed. Review it before recording this refund.');
    await c.query(`UPDATE ${REFUNDS} SET paid_reference=$3,paid_by=$4 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,part.id,reference,ctx.actorId]);
    const journalEntryId=await postPayout(c,ctx,credit,{...part,paid_reference:reference});
    await audit(c,ctx,{action:'Customer refund paid by a person and recorded',reference:credit.snapshot.invoiceNumber||credit.snapshot.orderNumber,after:{refundId:part.id,amountMinor:Number(part.amount_minor),method:part.method,reference}});
    return {journalEntryId,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Provider refunds, booked only on the provider's exact confirmation.
async function providerPart(db,effect){
  return (await db.query(`SELECT r.*,c.currency,c.approved_by,c.kind,c.status credit_status,p.status payment_status FROM ${REFUNDS} r
    JOIN ${CREDITS} c ON c.workspace_id=r.workspace_id AND c.id=r.credit_id JOIN accounting_payments p ON p.workspace_id=r.workspace_id AND p.id=r.original_payment_id
    WHERE r.workspace_id=$1 AND r.id=$2 AND r.credit_id=$3 AND r.provider=$4`,[effect.workspaceId,effect.payload.customerCreditPartId,effect.aggregateId,effect.provider])).rows[0];
}
async function preflight(c,effect){
  const part=await providerPart(c,effect);
  if(!part||part.status!=='APPROVED'||part.payment_status!=='POSTED')throw new ValidationError('The approved refund no longer has its posted original payment.');
  const ctx={workspaceId:effect.workspaceId,actorId:part.approved_by};
  await evidence.access(c,ctx,{approve:true,dispatch:true,lock:true});
  await evidence.checkProviderRefundHistory(c,ctx.workspaceId,part.provider,part.external_payment_id);
  await ledger.validatePostingDateInTransaction(c,ctx);
  return part;
}
async function settleProvider(db,effect,part,outcome){
  const refundId=String(outcome?.externalRefundId||'');
  const exact=/^[A-Za-z0-9_-]{1,160}$/.test(refundId)&&refundId!==part.external_payment_id&&String(outcome.originalPaymentId)===part.external_payment_id&&
    outcome.amountMinor===Number(part.amount_minor)&&String(outcome.currency||'').toUpperCase()===part.currency;
  const proof=exact?{externalId:refundId,originalPaymentId:part.external_payment_id,amountMinor:Number(part.amount_minor),currency:part.currency}:null;
  if(proof)await effects.checkpoint(db,effect.workspaceId,effect.id,effect.claimToken,proof);
  if(!proof||outcome.status!=='succeeded')throw Object.assign(new ValidationError('The provider has not confirmed this exact refund. Check its saved status.'),{providerOutcomeUncertain:true});
  await effects.succeed(db,effect.workspaceId,effect.id,effect.claimToken,{providerReference:proof,result:{refundId,amountMinor:proof.amountMinor},apply:async c=>{
    const ctx={workspaceId:effect.workspaceId,actorId:null};
    const locked=(await c.query(`SELECT * FROM ${REFUNDS} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,part.id])).rows[0];
    if(!locked||!['APPROVED','REVIEW'].includes(locked.status))throw new ValidationError('This refund needs review before it can be recorded.');
    await c.query(`UPDATE ${REFUNDS} SET external_refund_id=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,part.id,refundId]);
    const credit=(await c.query(`SELECT * FROM ${CREDITS} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,part.credit_id])).rows[0];
    await postPayout(c,ctx,credit,{...locked,external_refund_id:refundId});
    await audit(c,{workspaceId:ctx.workspaceId,actorId:part.approved_by},{action:'Customer refund confirmed by the payment provider and recorded',reference:credit.snapshot.invoiceNumber||credit.snapshot.orderNumber,after:{refundId:part.id,externalRefundId:refundId,amountMinor:Number(part.amount_minor)}});
  }});
  return {refundId,replayed:false};
}
async function failed(db,effect,error,{ambiguous,held}){
  if(held)error=Object.assign(error,{code:'entitlement_required'});
  await effects.finishError(db,effect.workspaceId,effect.id,effect.claimToken,error,{ambiguous,apply:async c=>{
    await c.query(`UPDATE ${REFUNDS} SET status=$3 WHERE workspace_id=$1 AND id=$2 AND status IN('APPROVED','REVIEW')`,[effect.workspaceId,effect.payload.customerCreditPartId,ambiguous?'REVIEW':'FAILED']);
  }});
  throw Object.assign(error,{code:held?'entitlement_required':ambiguous?'payment_refund_ambiguous':error.code||'payment_refund_failed',retryable:held});
}
async function providerFor(db,effect,part,options){
  const payments=require('../payments/postgres-collection'),account=await payments.accountFor(db,effect.workspaceId,effect.provider);
  if(account.provider_account_id!==part.provider_account_id)throw new ValidationError('Reconnect the merchant account that took the original payment.');
  return {provider:options.provider||require('../payments').get(effect.provider),context:await payments.providerContext(account,options,db)};
}
async function executeProviderPart(db,current,options={}){
  const claim=await effects.claim(db,current.workspaceId,current.id);
  if(claim.replayed)return {refundId:claim.effect.result?.refundId,replayed:true};
  const effect=claim.effect;let dispatched=false;
  try{
    const part=await db.transaction(c=>preflight(c,effect),{isolation:'SERIALIZABLE',retrySafe:true});
    const {provider,context}=await providerFor(db,effect,part,options);
    const outcome=await require('../commercial/operations').run(db,effect.workspaceId,{capability:'payments.customer',key:effect.idempotencyKey,provider:effect.provider,operation:'refund_create',retryReversed:true},async()=>{
      try{await db.transaction(c=>preflight(c,effect),{isolation:'SERIALIZABLE',retrySafe:true});}catch(error){throw Object.assign(error,{status:403});}
      dispatched=true;
      return provider.refundPayment(context,{externalPaymentId:part.external_payment_id,amountMinor:Number(part.amount_minor),currency:part.currency,idempotencyKey:effect.idempotencyKey,verifyExact:true});
    });
    return await settleProvider(db,effect,part,outcome);
  }catch(error){return failed(db,effect,error,{ambiguous:dispatched&&!effects.definiteFailure(error),held:!dispatched});}
}
// An uncertain Stripe answer can be checked again by its saved refund reference.
async function verifyProviderPart(db,ctx,partId,options={}){
  await evidence.owner(db,ctx);
  const row=(await db.query(`SELECT r.*,e.id effect_id,e.provider_reference FROM ${REFUNDS} r JOIN stockchief_runtime.provider_effects e ON e.workspace_id=r.workspace_id AND e.kind='payment.refund.create' AND e.idempotency_key='agent-customer-credit-refund:'||r.id
    WHERE r.workspace_id=$1 AND r.id=$2`,[ctx.workspaceId,partId])).rows[0];
  if(!row||row.provider!=='stripe'||row.status!=='REVIEW'||!row.provider_reference?.externalId)throw new ValidationError('This refund has no saved Stripe answer to check.');
  const claim=await effects.claimVerification(db,ctx.workspaceId,row.effect_id,'payment.refund.create');
  if(claim.replayed)return {refundId:claim.effect.result?.refundId,replayed:true};
  const effect=claim.effect;
  try{
    const part=await providerPart(db,effect);
    const {provider,context}=await providerFor(db,effect,part,options);
    const outcome=await provider.retrieveRefund(context,{externalRefundId:effect.providerReference.externalId,externalPaymentId:part.external_payment_id});
    const done=await settleProvider(db,effect,part,outcome);
    await require('../commercial/operations').completeRetained(db,ctx.workspaceId,{operation:'refund_create',key:effect.idempotencyKey},{verifiedRefund:true});
    await db.transaction(c=>require('../operations/postgres-job-queue').reconcileVerifiedEffectWithin(c,ctx.workspaceId,effect.id));
    return done;
  }catch(error){return failed(db,effect,error,{ambiguous:true});}
}

// StockChief prepares refunds for orders cancelled after payment, and for
// money paid beyond a shipped order, for a person to approve.
async function run(db,workspaceId){
  const out={prepared:0,held:0};
  if(!await has(db,CREDITS))return out;
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,107,'draft')||state.shadow)return out;
  const autopilot=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(autopilot.mode==='OBSERVE'||autopilot.paused||autopilot.suspended||await require('../autopilot/job-modes').restriction(db,workspaceId,107,false))return out;
  const owner=await require('../sales/agent-customer-orders').ownerUser(db,workspaceId);if(!owner)return out;
  for(const due of (await require('../sales/postgres-deposit-refunds').due(db,workspaceId)).slice(0,20)){
    const waiting=(await db.query(`SELECT 1 FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND action_type=$2 AND status='PENDING' AND payload->>'salesOrderId'=$3 LIMIT 1`,[workspaceId,ACTION,due.orderId])).rowCount;
    if(waiting)continue;
    try{
      const prepared=await require('../assistant/postgres-service').prepareAction(db,{workspaceId,actorId:owner,planStepKey:'customer-credit:'+due.orderId+':'+due.toRefundMinor+':'+due.refundedMinor},
        due.cancelled?'Refund the money held for a cancelled order':'Refund the money paid beyond what the order came to',{action:ACTION,recordReference:due.orderNumber,creditKind:due.cancelled?'cancellation':'overpayment'});
      if(prepared.status==='PREPARED')out.prepared++;
    }catch(error){if(!['validation_error','forbidden','entitlement_required'].includes(error.code))throw error;out.held++;}
  }
  return out;
}

// Needs you: refunds a person has to pay, and provider answers to check.
async function inbox(db,workspaceId){
  if(!await has(db,REFUNDS))return [];
  const rows=(await db.query(`SELECT r.*,c.kind,c.snapshot->>'invoiceNumber' invoice_number,c.snapshot->>'orderNumber' order_number,c.currency,cu.name customer_name,p.payment_number
    FROM ${REFUNDS} r JOIN ${CREDITS} c ON c.workspace_id=r.workspace_id AND c.id=r.credit_id JOIN customers cu ON cu.workspace_id=c.workspace_id AND cu.id=c.customer_id
    JOIN accounting_payments p ON p.workspace_id=r.workspace_id AND p.id=r.original_payment_id
    WHERE r.workspace_id=$1 AND r.status IN ('TO_PAY','REVIEW','FAILED') ORDER BY r.created_at,r.id LIMIT 20`,[workspaceId])).rows;
  return rows.map(r=>{const amount=money.format(r.amount_minor,r.currency),what=r.invoice_number||r.order_number;
    return {kind:'accounting',importance:'Needs You',priority:r.status==='TO_PAY'?84:88,moneyValue:Number(r.amount_minor),moneyCurrency:r.currency,
      title:r.status==='TO_PAY'?'Pay '+r.customer_name+' back '+amount:'Check the '+amount+' refund to '+r.customer_name,
      happened:r.status==='TO_PAY'?'You approved a '+amount+' refund on '+what+'. It goes back the way they paid ('+r.method.replaceAll('_',' ')+', '+r.payment_number+').':'The payment provider did not confirm the '+amount+' refund on '+what+'.',
      why:r.status==='TO_PAY'?'StockChief never pays money on its own. Nothing is booked until you say it is paid.':'StockChief books a provider refund only on its exact confirmation.',
      recommendation:r.status==='TO_PAY'?'Pay it, then record it as paid with the reference.':'Check the refund with the provider before doing anything else.',
      href:path,actionLabel:r.status==='TO_PAY'?'Record the payment':'Review the refund',sourceId:'customer-credit-refund:'+r.id,createdAt:r.created_at,timeLabel:'Approved',at:r.created_at};});
}

async function review(db,ctx,{page=1}){
  await evidence.access(db,ctx);
  const ready=await has(db,REFUNDS),offset=(Math.max(1,Number(page)||1)-1)*20;
  const open=ready?(await db.query(`SELECT r.*,c.currency,c.snapshot->>'invoiceNumber' invoice_number,c.snapshot->>'orderNumber' order_number,cu.name customer_name,p.payment_number
    FROM ${REFUNDS} r JOIN ${CREDITS} c ON c.workspace_id=r.workspace_id AND c.id=r.credit_id JOIN customers cu ON cu.workspace_id=c.workspace_id AND cu.id=c.customer_id
    JOIN accounting_payments p ON p.workspace_id=r.workspace_id AND p.id=r.original_payment_id
    WHERE r.workspace_id=$1 AND r.status<>'SETTLED' ORDER BY r.created_at,r.id LIMIT 50`,[ctx.workspaceId])).rows:[];
  const recent=ready?(await db.query(`SELECT c.*,cu.name customer_name FROM ${CREDITS} c JOIN customers cu ON cu.workspace_id=c.workspace_id AND cu.id=c.customer_id
    WHERE c.workspace_id=$1 ORDER BY c.created_at DESC,c.id LIMIT 21 OFFSET $2`,[ctx.workspaceId,offset])).rows:[];
  const due=(await require('../sales/postgres-deposit-refunds').due(db,ctx.workspaceId)).slice(0,20);
  const f=(v,c)=>money.format(Number(v),c);
  return {summary:'StockChief prepares exact credits and refunds for price adjustments, overcharges and orders cancelled after payment. A person approves each one. Approval books the credit; refunds go back through the payment provider that took the money, or wait here for you to pay them and record it. Returns are credited from the return itself.',
    rows:[],more:recent.length>20,creditForm:{
      open:open.map(r=>({id:r.id,status:r.status,amount:f(r.amount_minor,r.currency),who:r.customer_name,what:r.invoice_number||r.order_number,how:r.method.replaceAll('_',' ')+' · '+r.payment_number,
        canVerify:r.status==='REVIEW'&&r.provider==='stripe'})),
      due:due.map(d=>({orderNumber:d.orderNumber,who:d.customerName,amount:f(d.toRefundMinor,d.currency),cancelled:d.cancelled})),
      recent:recent.slice(0,20).map(c=>({kind:KINDS[c.kind],who:c.customer_name,what:c.snapshot.invoiceNumber||c.snapshot.orderNumber,credit:c.credit_minor>0?f(c.credit_minor,c.currency):null,
        refund:Number(c.refund_minor)?f(c.refund_minor,c.currency):null,status:c.status==='COMPLETED'?'Done':'Refund waiting',reason:c.reason,at:c.created_at}))}};
}
module.exports={snapshot,build,execute,verify,markPaid,executeProviderPart,verifyProviderPart,run,inbox,KINDS,
  definition:{id:107,key:'customer-credits',label:'Refunds and credits',filterLabel:'Invoice or order number',readPage:review},
  spec:{name:ACTION,agentJob:107,description:'Prepare an exact customer credit or refund for a person to approve: a price adjustment on a posted invoice line (creditKind price_adjustment, creditLines as line number or product code = new unit price), money paid beyond what a shipped order came to (overpayment) or money held by an order cancelled after payment (cancellation). Uses the original discount and tax, never changes shipping charges on a price adjustment, and refunds through the original payments. Never pays money; refunds of returned goods use customer_return.refund.',
    record:null,fields:['recordReference','creditKind','creditLines','reason','refundPayments'],permission:require('../actions/permissions').REFUND_CUSTOMER_RETURN,ownerOnly:true,capability:'accounting.core',
    resultingRecords:['accounting_journal_entries','accounting_customer_invoices'],resultReference:'creditId',build,execute,verify}};

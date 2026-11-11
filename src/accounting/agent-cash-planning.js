'use strict';

const {documents,addDays} = require('./customer-money');
const money = require('../domain/currency');
const {createHash} = require('node:crypto');
const policy = require('../commercial/agent-plan');
const {ValidationError} = require('../domain/errors');

function terms(text) {
  const value=String(text||'').trim();
  const net=/^net\s*(\d{1,3})\s*(?:days?)?$/i.exec(value);
  if(net) return {net:Number(net[1])};
  const match=/^(\d{1,2}(?:\.\d{1,2})?)\s*%?\s*\/\s*(\d{1,3})\s*[,;]?\s*(?:net|n)\s*\/?\s*(\d{1,3})$/i.exec(value)||
    /^(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:off\s*)?(?:if\s+paid\s+)?(?:in|within)\s+(\d{1,3})\s+days?(?:\s*[,;]?\s*net\s*(\d{1,3}))?$/i.exec(value);
  if(!match)return {};
  const percent=Number(match[1]),days=Number(match[2]),netDays=match[3]==null?null:Number(match[3]);
  if(percent<=0||(netDays!=null&&days>netDays))return {};
  return {percent,days,net:netDays};
}

function opportunity(bill,today) {
  const term=terms(bill.agreed_discount_terms);
  if(!term.percent || bill.balance_minor!==Number(bill.total_minor) || bill.issue_date>today) return null;
  const deadline=addDays(bill.issue_date,term.days);
  if(deadline<today) return null;
  const basis=money.integer(bill.subtotal_minor,bill.currency);
  const minor=Number((BigInt(basis)*BigInt(Math.round(term.percent*100))+5000n)/10000n);
  return minor>0 && minor<=bill.balance_minor ? {deadline,minor} : null;
}

function weekStart(today){
  const day=new Date(today+'T12:00:00Z').getUTCDay();
  return addDays(today,-((day+6)%7));
}

async function paymentFacts(db,workspaceId,today){
  const bills=await documents(db,workspaceId,'bills',today),end=addDays(today,6);
  const dueThisRun=[],discounts=[];
  for(const bill of bills){
    if(bill.issue_date>today)continue;
    const offer=opportunity(bill,today);
    const due=bill.due_date || (terms(bill.agreed_discount_terms).net!=null ? addDays(bill.issue_date,terms(bill.agreed_discount_terms).net) : null);
    const entry={id:bill.id,supplier:bill.party_name,number:bill.number,currency:bill.currency,due,
      balance:bill.balance_minor,offer,link:bill.href};
    if(offer)discounts.push(entry);
    if(!due||due<=end||offer?.deadline<=end)dueThisRun.push(entry);
  }
  const deadline=entry=>[entry.due,entry.offer?.deadline].filter(Boolean).sort()[0]||'9999-12-31';
  dueThisRun.sort((a,b)=>deadline(a).localeCompare(deadline(b))||a.id.localeCompare(b.id));
  discounts.sort((a,b)=>a.offer.deadline.localeCompare(b.offer.deadline)||a.id.localeCompare(b.id));
  const week=weekStart(today);
  const digest=dueThisRun.length?createHash('sha256').update(JSON.stringify({week,dueThisRun})).digest('hex'):null;
  return {end,week,digest,dueThisRun,discounts};
}

function paymentRow(entry){
  const {offer,currency,balance}=entry;
  return {Supplier:entry.supplier,Bill:entry.number,Due:entry.due||'Confirm due date',
    Balance:money.format(balance,currency),'Discount deadline':offer?.deadline||'',
    'Possible saving':offer?money.format(offer.minor,currency):'',
    'Review amount':money.format(balance-(offer?.minor||0),currency),link:entry.link};
}

async function payments(db,ctx,{today,discountsOnly=false}) {
  const facts=await paymentFacts(db,ctx.workspaceId,today);
  if(discountsOnly)return {summary:'Unpaid posted bills within documented early-payment terms. Confirm the discount basis with the supplier.',
    rows:facts.discounts.map(paymentRow)};
  const approved=facts.digest&&(await db.query(`SELECT approved_at FROM stockchief_runtime.agent_supplier_payment_approvals
    WHERE workspace_id=$1 AND week_start=$2 AND digest=$3`,[ctx.workspaceId,facts.week,facts.digest])).rows[0];
  const approvalHold=facts.digest&&await require('../autopilot/job-modes').restriction(db,ctx.workspaceId,104,false);
  return {summary:'Bills due through '+facts.end+', discount deadlines this week and bills needing a due date. Review each bill before paying.',
    rows:facts.dueThisRun.map(paymentRow),paymentRun:{digest:facts.digest,approvedAt:approved?.approved_at||null,
      count:facts.dueThisRun.length,approvalHold}};
}

async function approvePaymentRun(db,ctx,{digest,confirmed}){
  if(confirmed!=='yes'||!(/^[a-f0-9]{64}$/).test(digest||''))
    throw new ValidationError('Review the listed bills and confirm this payment run.');
  return db.transaction(async client=>{
    const state=await require('../autopilot/job-reviews').ownerState(client,ctx);
    policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,104,'draft');
    const hold=await require('../autopilot/job-modes').restriction(client,ctx.workspaceId,104,false);
    if(hold)throw new ValidationError(hold);
    const today=await require('../lib/business-time').today(client,ctx.workspaceId);
    const facts=await paymentFacts(client,ctx.workspaceId,today);
    if(facts.digest!==digest)throw new ValidationError('The bills or discount terms changed. Open the current run and review it again.');
    const saved=await client.query(`INSERT INTO stockchief_runtime.agent_supplier_payment_approvals(workspace_id,week_start,digest,approved_by)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING approved_at`,[ctx.workspaceId,facts.week,digest,ctx.actorId]);
    if(saved.rowCount)await require('../operations/postgres-security-audit').record(client,ctx,{action:'Supplier payment run reviewed',
      after:{week:facts.week,billCount:facts.dueThisRun.length,digest}});
    return {replayed:!saved.rowCount};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function preparePaymentChecks(db,workspaceId,state,today){
  const jobs=require('../autopilot/job-modes');
  const prepareRun=policy.permits(state.plan,104,'automatic')&&!await jobs.restriction(db,workspaceId,104,true);
  const findDiscounts=policy.permits(state.plan,108,'automatic')&&!await jobs.restriction(db,workspaceId,108,true);
  if(!prepareRun&&!findDiscounts)return;
  const modes=(prepareRun?1:0)+(findDiscounts?2:0);
  const previous=await db.query(`SELECT 1 FROM stockchief_runtime.agent_supplier_payment_checks
    WHERE workspace_id=$1 AND (checked_on>$2 OR (checked_on=$2 AND check_modes=$3))`,[workspaceId,today,modes]);
  if(previous.rowCount)return;
  const facts=await paymentFacts(db,workspaceId,today);
  await db.query(`INSERT INTO stockchief_runtime.agent_supplier_payment_checks AS prior(workspace_id,checked_on,check_modes,run_digest,bill_count,discount_count)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id) DO UPDATE SET checked_on=excluded.checked_on,check_modes=excluded.check_modes,
    run_digest=excluded.run_digest,bill_count=excluded.bill_count,discount_count=excluded.discount_count
    WHERE prior.checked_on<excluded.checked_on OR (prior.checked_on=excluded.checked_on AND prior.check_modes<>excluded.check_modes)`,
    [workspaceId,today,modes,prepareRun?facts.digest:null,prepareRun?facts.dueThisRun.length:0,findDiscounts?facts.discounts.length:0]);
}

async function forecast(db,ctx,{today,adviceOnly=false}) {
  const books=await documents(db,ctx.workspaceId,'bills',today);
  const invoices=await documents(db,ctx.workspaceId,'invoices',today);
  const lines=(await db.query(`WITH billed AS (
    SELECT bl.purchase_order_line_id,sum(bl.quantity) AS units FROM accounting_supplier_bill_lines bl
    JOIN accounting_supplier_bills b ON b.workspace_id=bl.workspace_id AND b.id=bl.bill_id
    WHERE bl.workspace_id=$1 AND b.status IN ('OPEN','PARTIALLY_PAID','PAID') GROUP BY bl.purchase_order_line_id)
    SELECT p.po_number,p.currency,p.expected_date,s.payment_terms,l.unit_cost,l.secondary_quantity_ordered,
      greatest(l.quantity_units-coalesce(b.units,0),0) AS unbilled
    FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
    JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
    LEFT JOIN billed b ON b.purchase_order_line_id=l.id WHERE p.workspace_id=$1 AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')
    AND l.quantity_units>coalesce(b.units,0)`,[ctx.workspaceId])).rows;
  const currencies=new Map(),undated=new Set();
  function add(currency,date,amount,kind,reference){
    if(!currencies.has(currency)) currencies.set(currency,Array.from({length:13},()=>({incoming:0,bills:0,purchases:0})));
    if(!date || amount===null){undated.add(reference);return;}
    const days=Math.round((Date.parse(date)-Date.parse(today))/86400000),index=Math.max(0,Math.floor(days/7));
    if(index<13) {const week=currencies.get(currency)[index];week[kind]=money.sum([week[kind],amount]);}
  }
  for(const b of books)add(b.currency,b.due_date,b.balance_minor,'bills',b.number);
  for(const i of invoices)add(i.currency,i.due_date,i.balance_minor,'incoming',i.number);
  for(const l of lines){
    const net=terms(l.payment_terms).net;
    const amount=l.unit_cost==null || l.secondary_quantity_ordered!=null ? null :
      require('../domain/exact-quantity').costMinor(l.unbilled,money.toMinor(l.unit_cost,l.currency));
    add(l.currency,l.expected_date && net!=null ? addDays(l.expected_date,net) : null,amount,'purchases',l.po_number);
  }
  const rows=[];
  for(const [currency,weeks] of [...currencies].sort(([a],[b])=>a.localeCompare(b))){
    let suggested=false;
    weeks.forEach((w,index)=>{
      const week=addDays(today,index*7),net=money.sum([w.incoming,-w.bills,-w.purchases]);
      if(adviceOnly){
        if(!suggested && net<0){rows.push({Currency:currency,'Week beginning':week,Review:'Expected payments exceed expected receipts.'});suggested=true;}
        return;
      }
      rows.push({'Week beginning':week,Currency:currency,'Customer receipts':money.format(w.incoming,currency),
        'Supplier bills':money.format(w.bills,currency),'Unbilled PO goods':money.format(w.purchases,currency),'Net flow':money.format(net,currency)});
    });
    if(adviceOnly && !suggested)rows.push({Currency:currency,'Week beginning':today,Review:'No negative week among dated records.'});
  }
  return {summary:'Overdue amounts enter week one. Unbilled goods use expected delivery plus supplier terms. Unbilled freight, tax, deposits and opening bank balances are excluded. '+undated.size+' documents need a date or price.'+
    (undated.size?' Review '+[...undated].slice(0,8).join(', ')+'.':''),rows};
}
module.exports={payments,approvePaymentRun,preparePaymentChecks,forecast,terms};

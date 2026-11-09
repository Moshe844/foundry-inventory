'use strict';

const {ValidationError,AuthorizationError}=require('../domain/errors');
const money=require('../domain/currency'),policy=require('../commercial/agent-plan');
const {hash}=require('../pricing/postgres-promotions');
const action='customer.statement',kind='customer_statement';
const exact=value=>money.integer(value,'Recorded account amount',{signed:true});

async function owner(db,ctx){
 const actor=(await db.query(`SELECT u.* FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
  WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!actor)throw new AuthorizationError('Only the inventory owner can authorize customer account statements.');
 require('../actions/permissions').assertCan(actor,require('../actions/permissions').VIEW_ACCOUNTING,'review customer account statements');
}

async function facts(db,ctx,customerId,connectorId,requestedCurrency){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,81,'draft');
 const customer=(await db.query("SELECT id,name,email FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'",[ctx.workspaceId,customerId])).rows[0];
 if(!customer||!/^\S+@\S+\.\S+$/.test(customer.email||''))throw new ValidationError('Confirm an active customer and their email before preparing an account statement.');
 const base=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency;
 if(!base)throw new ValidationError('Configure accounting before preparing account statements.');
 const currency=money.code(requestedCurrency||base),asOf=await require('../lib/business-time').today(db,ctx.workspaceId),from=asOf.slice(0,7)+'-01';
 const box=await require('../shipping/agent-shipping-notices').mailbox(db,ctx.workspaceId,connectorId);
 if(!box)throw new ValidationError('Choose a connected Gmail or Microsoft 365 sending mailbox.');
 const totals=(await db.query(`SELECT coalesce(sum(l.debit_minor-l.credit_minor) FILTER(WHERE e.posting_date<$3),0) opening,
  coalesce(sum(l.debit_minor-l.credit_minor),0) closing,count(*)::integer n
  FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id
  JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id AND a.system_key='ACCOUNTS_RECEIVABLE'
  WHERE l.workspace_id=$1 AND l.customer_id=$2 AND l.currency=$5 AND e.status='POSTED' AND e.posting_date<=$4`,[ctx.workspaceId,customerId,from,asOf,currency])).rows[0];
 const activity=(await db.query(`SELECT e.id,e.entry_number,e.posting_date::text date,e.description,
  sum(l.debit_minor) debit,sum(l.credit_minor) credit
  FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id
  JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id AND a.system_key='ACCOUNTS_RECEIVABLE'
  WHERE l.workspace_id=$1 AND l.customer_id=$2 AND l.currency=$5 AND e.status='POSTED' AND e.posting_date BETWEEN $3 AND $4
  GROUP BY e.id ORDER BY e.posting_date,e.entry_number,e.id LIMIT 101`,[ctx.workspaceId,customerId,from,asOf,currency])).rows;
 const invoices=(await db.query(`SELECT i.id,i.invoice_number,i.issue_date::text date,i.due_date::text due,i.balance_minor,i.total_minor,i.status,i.journal_entry_id
  FROM accounting_customer_invoices i WHERE i.workspace_id=$1 AND i.customer_id=$2 AND i.currency=$3
  AND i.status IN ('OPEN','PARTIALLY_PAID') AND i.balance_minor>0 ORDER BY i.issue_date,i.invoice_number,i.id LIMIT 101`,[ctx.workspaceId,customerId,currency])).rows;
 if(activity.length>100||invoices.length>100)throw new ValidationError('This statement has more than 100 current-month entries or outstanding invoices. Review the full account before sending it.');
 if(invoices.some(i=>i.date>asOf))throw new ValidationError('Review the customer’s future-dated issued invoices before sending a current statement.');
 if(invoices.length){
  const valid=(await db.query(`SELECT e.id,sum(l.debit_minor-l.credit_minor)::text original_amount FROM accounting_journal_entries e
   JOIN accounting_journal_lines l ON l.workspace_id=e.workspace_id AND l.entry_id=e.id AND l.customer_id=$3 AND l.currency=$4
   JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id AND a.system_key='ACCOUNTS_RECEIVABLE'
   WHERE e.workspace_id=$1 AND e.id=ANY($2::text[]) AND e.status='POSTED' AND e.posting_date<=$5
   AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=e.workspace_id AND r.reversal_of_entry_id=e.id AND r.status='POSTED') GROUP BY e.id`,[ctx.workspaceId,invoices.map(i=>i.journal_entry_id).filter(Boolean),customerId,currency,asOf])).rows;
  if(invoices.some(i=>!valid.some(e=>e.id===i.journal_entry_id&&exact(e.original_amount)===exact(i.total_minor))))throw new ValidationError('An outstanding invoice does not match its current posted customer receivable. Review the account before sending it.');
 }
 if(!Number(totals.n)&&!invoices.length)throw new ValidationError('This customer has no recorded receivables in '+currency+'. Choose the actual account currency.');
 const openingMinor=exact(totals.opening),balanceMinor=exact(totals.closing);
 const entries=activity.map(r=>({reference:r.entry_number,date:r.date,description:r.description,debitMinor:exact(r.debit),creditMinor:exact(r.credit)}));
 if(exact(entries.reduce((n,r)=>n+r.debitMinor-r.creditMinor,openingMinor))!==balanceMinor)throw new ValidationError('The current account entries do not reconcile. Review the account before sending it.');
 const outstanding=invoices.map(r=>({number:r.invoice_number,date:r.date,due:r.due,balanceMinor:exact(r.balance_minor)}));
 const outstandingMinor=exact(outstanding.reduce((n,r)=>n+r.balanceMinor,0)),otherBalanceMinor=exact(balanceMinor-outstandingMinor);
 const statementValueMinor=Math.max(1,Math.abs(openingMinor),Math.abs(balanceMinor),outstandingMinor,Math.abs(otherBalanceMinor),money.sum(entries.map(r=>r.debitMinor)),money.sum(entries.map(r=>r.creditMinor)));
 const training=require('../autopilot/draft-authority').scope(customer.id,currency,statementValueMinor,['customer-statement',box.id,box.provider_account_id,box.provider_type,customer.email],customer.name+' · account statement · '+currency);
 const known=(await db.query(`SELECT EXISTS(SELECT 1 FROM sales_orders o JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id WHERE o.workspace_id=$1 AND o.customer_id=$2 AND l.quantity_fulfilled>0)
  OR EXISTS(SELECT 1 FROM accounting_payments p WHERE p.workspace_id=$1 AND p.customer_id=$2 AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED')
  OR EXISTS(SELECT 1 FROM customer_communications m JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
   WHERE m.workspace_id=$1 AND m.customer_id=$2 AND m.recipient=$3 AND m.status='SENT' AND m.external_message_id IS NOT NULL AND e.payload->'standingAuthority'->>'kind'=$4 AND e.payload->'standingAuthority'->>'automatic'='false') known`,[ctx.workspaceId,customer.id,customer.email,kind])).rows[0].known;
 const p={recordId:customer.id,customerName:customer.name,recipient:customer.email,currency,from,asOf,openingMinor,balanceMinor,outstandingMinor,otherBalanceMinor,statementValueMinor,entries,outstanding,connectorId:box.id,mailboxAccount:box.provider_account_id,providerType:box.provider_type,training};
 return {...p,sourceFingerprint:hash(p),needsStatementConfirmation:!known};
}

function compose(p){
 const format=n=>money.format(n,p.currency);
 const body='Hello '+p.customerName+',\n\nHere is your recorded account statement in '+p.currency+' as of '+p.asOf+'.\n\nOpening account balance on '+p.from+': '+format(p.openingMinor)+'\n\n'+
  (p.entries.length?'Account activity from '+p.from+' to '+p.asOf+':\n'+p.entries.map(r=>r.date+' · '+r.reference+' · '+r.description+' · Debit '+format(r.debitMinor)+' · Credit '+format(r.creditMinor)).join('\n'):'No recorded account activity this month.')+
  '\n\nAccount balance: '+format(p.balanceMinor)+(p.balanceMinor<0?' (credit)':'')+'\n\n'+
  (p.outstanding.length?'Outstanding invoices:\n'+p.outstanding.map(r=>r.number+' · Issued '+r.date+' · '+(r.due?'Due '+r.due:'No due date recorded')+' · Remaining '+format(r.balanceMinor)).join('\n'):'No outstanding invoices are recorded in this currency.')+
  '\nOutstanding invoice total: '+format(p.outstandingMinor)+'\nOther recorded account balance, including any unapplied receipts, credits or account adjustments: '+format(p.otherBalanceMinor)+
  '\n\nOnly records in '+p.currency+' are included; other currencies are separate. This is a statement of our recorded account, not a new invoice or a change to your agreed payment terms. Please let us know about any differences.\n\nThank you.';
 if(body.length>22000)throw new ValidationError('This account statement is too long for a complete email. Review the full account before sending it.');
 return {subject:'Account statement · '+p.currency+' · '+p.asOf,body};
}

async function authority(db,workspaceId,p){
 const ctx={workspaceId,actorId:p.actorId};await owner(db,ctx);
 const state=await policy.requireWorkspaceJob(db,workspaceId,81,'draft'),stop=await policy.stopped(db,workspaceId,state,action,p.automatic,p);if(stop)throw new ValidationError(stop);
 const fresh=await facts(db,ctx,p.recordId,p.connectorId,p.currency);
 const {needsStatementConfirmation,...evidence}=fresh;
 if(hash(evidence)!==hash(Object.fromEntries(Object.keys(evidence).map(key=>[key,p[key]]))))throw new ValidationError('The customer account, invoices, date or sending mailbox changed. Prepare a fresh statement.');
 const saved=(await db.query('SELECT recipient,subject,body,connector_id FROM customer_communications WHERE workspace_id=$1 AND idempotency_key=$2',[workspaceId,'customer-statement:'+p.recordId+':'+p.sourceFingerprint])).rows[0],words=compose(fresh);
 if(saved&&(saved.recipient!==fresh.recipient||saved.connector_id!==fresh.connectorId||saved.subject!==words.subject||saved.body!==words.body))throw new ValidationError('The queued statement differs from its recorded account evidence. Review its delivery before sending.');
 if(p.automatic){
  if(fresh.needsStatementConfirmation)throw new ValidationError('Approve this first customer statement individually.');
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)throw new ValidationError('Automatic account statements are paused.');
  const trained=state.plan!=='growth'||await require('../autopilot/draft-authority').trained(db,workspaceId,action,fresh);policy.requireJob(state.plan,81,'automatic',{trained});
  const rule=(await db.query(`SELECT r.maximum_minor,u.role FROM stockchief_runtime.agent_draft_rules r LEFT JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by WHERE r.workspace_id=$1 AND r.action_type=$2 AND r.scope_key=$3 AND r.currency=$4`,[workspaceId,action,fresh.training.key,fresh.currency])).rows[0];
  if(rule&&(rule.role!=='owner'||Number(rule.maximum_minor)<fresh.training.amountMinor))throw new ValidationError('s’s current statement rule. Approve this statement individually.');
 }
 return fresh;
}
async function build(db,ctx,row,args){
 const reference=String(args.recordReference||'').trim();if(!reference||reference.length>150)throw new ValidationError('Choose an exact customer name or email.');
 const customers=(await db.query("SELECT id FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' AND (id=$2 OR lower(name)=lower($2) OR lower(email)=lower($2)) LIMIT 2",[ctx.workspaceId,reference])).rows;
 if(customers.length!==1)throw new ValidationError('Choose one exact active customer name or email; StockChief will not guess which account to send.');
 const box=await require('../connections/postgres-outbound-mail').resolveMailbox(db,ctx.workspaceId,args.mailbox);if(!box.row)throw new ValidationError('Choose the exact connected sending mailbox.');
 const p=await facts(db,ctx,customers[0].id,box.row.id,args.currency);compose(p);
 return {payload:p,summary:'Send '+p.customerName+' ('+p.recipient+') their recorded '+p.currency+' account statement as of '+p.asOf+': '+money.format(p.balanceMinor,p.currency)+'. No invoice, payment or agreed terms change.'};
}
async function execute(db,ctx,p){
 const automatic=ctx.agentCustomerStatementScope==='automatic',fresh=await authority(db,ctx.workspaceId,{...p,kind,actorId:ctx.actorId,automatic}),grant={...fresh,kind,actorId:ctx.actorId,automatic};
 const words=compose(fresh),key='customer-statement:'+fresh.recordId+':'+fresh.sourceFingerprint;
 const existing=(await db.query(`SELECT m.*,e.id effect_id,e.payload FROM customer_communications m LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' WHERE m.workspace_id=$1 AND m.idempotency_key=$2`,[ctx.workspaceId,key])).rows[0];
 if(existing){
  if(existing.body!==words.body||existing.subject!==words.subject||existing.recipient!==p.recipient||existing.connector_id!==p.connectorId||existing.payload?.standingAuthority?.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('Review the earlier statement delivery before sending changed details.');
  if(existing.status==='FAILED')throw new ValidationError('Review the earlier statement and its delivery before trying again.');
  return {communicationId:existing.id,communicationKind:'customer',customerId:p.recordId,effectId:existing.effect_id,status:existing.status,replayed:true,automatic:grant.automatic};
 }
 const r=await require('../connections/postgres-outbound-mail').queueInTransaction(db,ctx,{recipientKind:'customer',recipientId:p.recordId,recipientEmail:p.recipient,connectorId:p.connectorId,...words,standingAuthority:grant},key,{agentRequested:true,agentJob:81});
 return {...r,customerId:p.recordId,automatic:grant.automatic};
}
async function confirmedExample(db,workspaceId,p){
 return p.result?.automatic!==true&&p.result?.replayed!==true&&Boolean((await db.query(`SELECT 1 FROM customer_communications m JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
  WHERE m.workspace_id=$1 AND m.id=$2 AND m.customer_id=$3 AND m.status='SENT' AND m.external_message_id IS NOT NULL AND e.payload->'standingAuthority'->>'kind'=$4 AND e.payload->'standingAuthority'->>'automatic'='false' AND e.payload->'standingAuthority'->>'sourceFingerprint'=$5`,[workspaceId,p.result?.communicationId||'',p.payload.recordId,kind,p.payload.sourceFingerprint])).rowCount);
}
async function review(db,ctx,{page=1,filter=''}){
 const rows=(await db.query(`SELECT c.name "Customer",c.email "Email",'/sales/customers/'||c.id link FROM customers c WHERE c.workspace_id=$1 AND c.record_state='ACTIVE' AND ($2='' OR lower(c.name)=lower($2) OR lower(c.email)=lower($2)) AND EXISTS(SELECT 1 FROM accounting_customer_invoices i WHERE i.workspace_id=c.workspace_id AND i.customer_id=c.id AND i.status IN ('OPEN','PARTIALLY_PAID','PAID')) ORDER BY c.name,c.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 const state=await policy.accountState(db,ctx.workspaceId);
 return {summary:'Send a customer their recorded account statement when requested. The preview includes current-month account activity, outstanding invoices and other recorded account balances in one currency. Growth learns the exact customer and mailbox after a confirmed individual send. Larger accounts require the full account review.',rows:rows.slice(0,100),more:rows.length>100,customerStatementForm:{mailboxes:await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId),blocked:await policy.stopped(db,ctx.workspaceId,state,action,false)}};
}
module.exports={facts,compose,authority,confirmedExample,definition:{id:81,key:'customer-statements',label:'Send requested customer account statements',filterLabel:'Exact customer name or email',readPage:review},spec:{name:action,agentJob:81,description:'Send a requested customer account statement from posted receivables, current-month ledger activity and outstanding invoices in one explicit currency. No new invoice, payment or terms change. Use an exact customer and sending mailbox.',record:null,resultReference:'customerId',resultRecordKind:'customer',fields:['recordReference','mailbox','currency'],permission:require('../actions/permissions').MANAGE_ACCOUNTING,ownerOnly:true,capability:'connection.email',completionGate:'provider_effect_succeeded',resultingRecords:['customer_communications','stockchief_runtime.provider_effects'],build,execute,
 verify:async(db,ctx,r,p)=>Boolean((await db.query("SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND id=$2 AND customer_id=$3 AND status IN ('QUEUED','SENDING','SENT')",[ctx.workspaceId,r.communicationId,p.recordId])).rowCount)}};

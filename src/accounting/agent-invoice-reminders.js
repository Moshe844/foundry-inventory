'use strict';
// Job 102: payment reminders on the owner's schedule. A schedule can remind
// days before the due date, on it and days after it; each step has its own
// wording (a friendly note before, a plain one on the day, a gentle first
// overdue reminder and a firmer later one, or the owner's own words). Every
// reminder uses the invoice's current balance, stops once it is paid or the
// customer disputes it, and stays within the owner's balance limit.
//
// Growth drafts each due reminder for approval until the owner has taught it
// (an approved reminder the mailbox confirmed for that customer and mailbox);
// then it sends on its own. Pro and Custom send on their own. A first B2B
// customer, Ask me first and an untaught Growth schedule wait in Needs you.
// Shadow, Watch only and pause only watch.
const {ValidationError,AuthorizationError}=require('../domain/errors'),money=require('../domain/currency'),policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions');
const {has}=require('../db/schema-installed');
const {newId}=require('../lib/util');
const action='customer_invoice.remind',DISPUTES='stockchief_runtime.agent_customer_invoice_disputes';
const audit=(c,ctx,entry)=>require('../operations/postgres-security-audit').record(c,ctx,entry);
async function owner(db,ctx){
 const row=(await db.query(`SELECT u.role FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2
  AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL)`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(row?.role!=='owner')throw new AuthorizationError('Only the inventory owner can authorize customer payment reminders.');
}
const dayNumber=date=>Date.parse(String(date).slice(0,10)+'T00:00:00Z')/86400000;
const daysFrom=(today,due)=>Math.round(dayNumber(today)-dayNumber(due));
async function openDispute(db,workspaceId,invoiceId){
 if(!await has(db,DISPUTES))return null;
 return (await db.query(`SELECT id,reason,source FROM ${DISPUTES} WHERE workspace_id=$1 AND invoice_id=$2 AND status='OPEN'`,[workspaceId,invoiceId])).rows[0]||null;
}
async function facts(db,ctx,id,connectorId){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,102,'draft');
 const i=(await db.query(`SELECT i.*,c.name customer_name,c.email,c.record_state FROM accounting_customer_invoices i
  JOIN customers c ON c.workspace_id=i.workspace_id AND c.id=i.customer_id WHERE i.workspace_id=$1 AND i.id=$2`,[ctx.workspaceId,id])).rows[0];
 if(!i||!['OPEN','PARTIALLY_PAID'].includes(i.status)||Number(i.balance_minor)<=0||i.record_state!=='ACTIVE')throw new ValidationError('Use an issued invoice with an outstanding balance and an active customer.');
 if(!i.due_date)throw new ValidationError('Record the invoice’s agreed due date before scheduling a payment reminder.');
 if(await openDispute(db,ctx.workspaceId,i.id))throw new ValidationError('The customer disputes invoice '+i.invoice_number+' or says it is paid. Reminders stop until you settle it.');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email||''))throw new ValidationError('Confirm a valid email address on this customer before preparing a reminder.');
 const box=await require('../shipping/agent-shipping-notices').mailbox(db,ctx.workspaceId,connectorId);
 if(!box)throw new ValidationError('Choose a connected Gmail or Microsoft 365 mailbox with permission to send.');
 const payload={recordId:i.id,invoiceNumber:i.invoice_number,customerId:i.customer_id,customerName:i.customer_name,recipient:i.email,currency:i.currency,balanceMinor:money.integer(i.balance_minor,'Invoice balance'),dueDate:i.due_date,connectorId:box.id,mailboxAccount:box.provider_account_id,providerType:box.provider_type};
 return {...payload,sourceFingerprint:hash(payload)};
}

// Each step's own wording. {days} is the number of days to or past the due date.
const PLACEHOLDERS=['customer','invoice','amount','due','days'];
const STAGES={
 before:{label:'Before the due date',subject:'Coming up: invoice {invoice} is due {due}',body:'Hello {customer},\n\nA friendly note that invoice {invoice} for {amount} is due on {due}, in {days} days. If payment is already on its way, thank you.\n\nThank you.'},
 due:{label:'On the due date',subject:'Invoice {invoice} is due today',body:'Hello {customer},\n\nInvoice {invoice} for {amount} is due today, {due}. Please let us know if you have already paid or have a question about it.\n\nThank you.'},
 first:{label:'First reminder after the due date',subject:'Payment reminder: invoice {invoice}',body:'Hello {customer},\n\nJust a gentle reminder that invoice {invoice} for {amount} was due on {due}. It may have crossed with your payment; if so, thank you. If you have a question about the invoice, simply reply to this email.\n\nThank you.'},
 later:{label:'Later reminder',subject:'Overdue invoice {invoice}',body:'Hello {customer},\n\nInvoice {invoice} for {amount} is now {days} days past its due date of {due}. Please arrange payment, or reply to tell us if anything about this invoice needs our attention.\n\nThank you.'},
};
function stage(days,offset){
 if(offset<0)return 'before';if(offset===0)return 'due';
 return offset===Math.min(...days.filter(d=>d>0))?'first':'later';
}
function template(rule,offset){
 const saved=(rule.templates||{})[String(offset)];
 const base=STAGES[stage(rule.days_after_due,offset)];
 return saved?.subject&&saved?.body?{stage:stage(rule.days_after_due,offset),subject:saved.subject,body:saved.body,custom:true}:{stage:stage(rule.days_after_due,offset),subject:base.subject,body:base.body,custom:false};
}
function fill(text,p){
 const values={customer:p.customerName,invoice:p.invoiceNumber,amount:money.format(p.balanceMinor,p.currency),due:p.dueDate,days:String(Math.abs(p.daysFromDue??0))};
 return String(text).replace(/\{(customer|invoice|amount|due|days)\}/g,(_,key)=>values[key]);
}
function checkWording(subject,body){
 subject=String(subject||'').trim();body=String(body||'').replace(/\r/g,'').trim();
 if(!subject||subject.length>150||/[\u0000-\u001f\u007f]/.test(subject))throw new ValidationError('Keep each reminder subject on one line, up to 150 characters.');
 if(!body||body.length>3000)throw new ValidationError('Keep each reminder message between 1 and 3,000 characters.');
 const unknown=[...(subject+body).matchAll(/\{([^}]*)\}/g)].map(m=>m[1]).filter(k=>!PLACEHOLDERS.includes(k));
 if(unknown.length)throw new ValidationError('Use only {customer}, {invoice}, {amount}, {due} and {days} in reminder wording.');
 if(!body.includes('{invoice}')||!body.includes('{amount}'))throw new ValidationError('Keep {invoice} and {amount} in each reminder so the customer knows which invoice and how much.');
 return {subject,body};
}
function compose(p){
 if(p.template)return {subject:fill(p.template.subject,p),body:fill(p.template.body,p)};
 return {subject:'Payment reminder: '+p.invoiceNumber,body:'Hello '+p.customerName+',\n\nOur records show '+money.format(p.balanceMinor,p.currency)+' outstanding on invoice '+p.invoiceNumber+', due '+p.dueDate+'. Please let us know if you have already paid or have a question about this invoice.\n\nThank you.'};
}
async function build(db,ctx,row,args){
 const chosen=await require('../connections/postgres-outbound-mail').resolveMailbox(db,ctx.workspaceId,args.mailbox);
 if(!chosen.row)throw new ValidationError('Choose one connected sending mailbox by its exact name.');
 const p=await facts(db,ctx,row.id,chosen.row.id);
 let schedule={};
 if(args.reminderOffset!==undefined&&args.reminderOffset!==null){
  // A reminder the owner's schedule made due: it keeps that step's wording and window.
  const offset=Number(args.reminderOffset),rule=(await db.query('SELECT * FROM stockchief_runtime.agent_invoice_reminder_rules WHERE workspace_id=$1 AND customer_id=$2',[ctx.workspaceId,p.customerId])).rows[0];
  if(!rule||rule.revision!==Number(args.ruleRevision)||!rule.days_after_due.includes(offset)||rule.connector_id!==p.connectorId||rule.currency!==p.currency)throw new ValidationError('The reminder schedule changed. Review the current schedule.');
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  schedule={daysAfterDue:offset,ruleRevision:rule.revision,template:template(rule,offset),windowKey:'invoice-reminder:'+row.id+':schedule:'+offset,daysFromDue:daysFrom(today,p.dueDate)};
 }
 const payload={...p,...schedule};
 return {payload,summary:'Send '+p.customerName+' ('+p.recipient+') a reminder for invoice '+p.invoiceNumber+': '+money.format(p.balanceMinor,p.currency)+' outstanding, due '+p.dueDate+'. Use '+chosen.row.display_name+'.'+(schedule.template?' This is the “'+STAGES[schedule.template.stage].label.toLowerCase()+'” step of your schedule.':'')+' This sends no charge, changes no payment terms and records no money received.'};
}
async function sentExample(db,workspaceId,p,maximum){return Boolean((await db.query(`SELECT 1 FROM customer_communications m
 JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
 WHERE m.workspace_id=$1 AND m.customer_id=$2 AND m.status='SENT' AND m.external_message_id IS NOT NULL
  AND e.payload->'standingAuthority'->>'kind'='invoice_reminder' AND e.payload->'standingAuthority'->>'automatic'='false'
  AND e.payload->'standingAuthority'->>'recipient'=$3 AND e.payload->'standingAuthority'->>'connectorId'=$4
  AND e.payload->'standingAuthority'->>'mailboxAccount'=$5 AND e.payload->'standingAuthority'->>'currency'=$6
  AND (e.payload->'standingAuthority'->>'balanceMinor')::numeric<=$7 AND e.payload->'standingAuthority'->>'providerType'=$8 LIMIT 1`,[workspaceId,p.customerId,p.recipient,p.connectorId,p.mailboxAccount,p.currency,maximum,p.providerType])).rowCount);}
async function knownCustomer(db,workspaceId,customerId){
 return (await db.query(`SELECT EXISTS(SELECT 1 FROM accounting_payments WHERE workspace_id=$1 AND customer_id=$2 AND direction='CUSTOMER_RECEIPT' AND status='POSTED')
 OR EXISTS(SELECT 1 FROM sales_orders o JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id WHERE o.workspace_id=$1 AND o.customer_id=$2 AND l.quantity_fulfilled>0) AS known`,[workspaceId,customerId])).rows[0].known;
}
async function sendAuthority(db,workspaceId,p){
 const ctx={workspaceId,actorId:p.actorId};await owner(db,ctx);const account=await policy.requireWorkspaceJob(db,workspaceId,102,'draft');
 const stop=await policy.stopped(db,workspaceId,account,action,p.automatic,p);if(stop)throw new ValidationError(stop);
 const fresh=await facts(db,ctx,p.recordId,p.connectorId);if(fresh.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('The invoice balance, due date, customer or mailbox changed. Prepare a fresh reminder.');
 if(!p.automatic)return fresh;
 if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)throw new ValidationError('Automatic reminders are paused.');
 const rule=(await db.query('SELECT * FROM stockchief_runtime.agent_invoice_reminder_rules WHERE workspace_id=$1 AND customer_id=$2',[workspaceId,p.customerId])).rows[0];
 if(!rule||rule.authorized_by!==p.actorId||rule.revision!==p.ruleRevision||rule.recipient!==p.recipient||rule.connector_id!==p.connectorId||rule.mailbox_account!==p.mailboxAccount||rule.provider_type!==p.providerType||rule.currency!==p.currency||Number(rule.maximum_minor)<p.balanceMinor||!rule.days_after_due.includes(p.daysAfterDue))throw new ValidationError('The owner’s reminder schedule or limit changed. Review the current schedule.');
 const words=template(rule,p.daysAfterDue);
 if(!p.template||words.subject!==p.template.subject||words.body!==p.template.body)throw new ValidationError('The reminder wording changed. Review the current schedule.');
 const trained=account.plan!=='growth'||await sentExample(db,workspaceId,p,Number(rule.maximum_minor));policy.requireJob(account.plan,102,'automatic',{trained});
 const today=await require('../lib/business-time').today(db,workspaceId),start=require('./customer-money').addDays(p.dueDate,p.daysAfterDue);
 if(today<start)throw new ValidationError('This reminder is not due yet.');
 const {timeZone}=await require('../lib/business-time').forWorkspace(db,workspaceId),boundary=require('../lib/business-time').dayBoundary(start,timeZone);
 if((await db.query("SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND customer_invoice_id=$2 AND status='SENT' AND external_message_id IS NOT NULL AND sent_at::timestamptz>=$3::timestamptz LIMIT 1",[workspaceId,p.recordId,boundary])).rowCount)throw new ValidationError('A reminder was already sent during this scheduled window.');
 if(!await knownCustomer(db,workspaceId,p.customerId)&&!await sentExample(db,workspaceId,p,Number(rule.maximum_minor)))throw new ValidationError('Approve this first B2B customer reminder individually.');
 return fresh;
}
async function queue(db,ctx,p,idempotencyKey){
 await sendAuthority(db,ctx.workspaceId,p);const words=compose(p);
 const result=await require('../connections/postgres-outbound-mail').queueInTransaction(db,ctx,{recipientKind:'customer',recipientId:p.customerId,recipientEmail:p.recipient,connectorId:p.connectorId,...words,standingAuthority:p},idempotencyKey,{agentRequested:true,agentJob:102});
 await db.query('UPDATE customer_communications SET customer_invoice_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,result.communicationId,p.recordId]);
 return {...result,invoiceId:p.recordId,href:'/money/invoices/'+p.recordId};
}
async function execute(db,ctx,p){
 const fresh=await facts(db,ctx,p.recordId,p.connectorId);if(fresh.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('The invoice or mailbox changed after review. Prepare a fresh reminder.');
 const step=p.windowKey?{template:p.template,daysAfterDue:p.daysAfterDue,ruleRevision:p.ruleRevision,daysFromDue:p.daysFromDue,windowKey:p.windowKey}:{};
 return queue(db,ctx,{...fresh,...step,kind:'invoice_reminder',actorId:ctx.actorId,automatic:false},p.windowKey||p.idempotencyKey);
}

// Owner's schedule: days before the due date, on it, and days after it.
function scheduleDays(input){
 const list=value=>String(value||'').split(',').map(v=>v.trim()).filter(Boolean);
 const before=list(input.before),after=list(input.days),onDue=['1','on','yes','true'].includes(String(input.onDue||''));
 if([...before,...after].some(v=>!/^\d{1,3}$/.test(v))||before.some(v=>Number(v)<1||Number(v)>60)||after.some(v=>Number(v)<1||Number(v)>365))
  throw new ValidationError('Use whole days: 1 to 60 before the due date and 1 to 365 after it, separated by commas.');
 const days=[...new Set([...before.map(v=>-Number(v)),...(onDue?[0]:[]),...after.map(Number)])].sort((a,b)=>a-b);
 if(days.length<1||days.length>12)throw new ValidationError('Choose one to twelve reminders: before the due date, on it, or after it.');
 return days;
}
async function configure(db,ctx,input){
 await owner(db,ctx);const revision=Number(input.revision);
 if(!input.customerId&&input.customerReference){
  const reference=String(input.customerReference).trim();if(reference.length>150)throw new ValidationError('Use an exact customer name or email up to 150 characters.');
  const found=(await db.query("SELECT id FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' AND (id=$2 OR lower(name)=lower($2) OR lower(email)=lower($2)) LIMIT 2",[ctx.workspaceId,reference])).rows;
  if(found.length!==1)throw new ValidationError('Choose one exact customer name or email from this inventory.');
  input={...input,customerId:found[0].id};
 }
 if(!Number.isSafeInteger(revision)||revision<0)throw new ValidationError('Reload the current reminder schedule before changing it.');
 return db.transaction(async c=>{
  await owner(c,ctx);const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,102,'draft');
  const prior=(await c.query('SELECT * FROM stockchief_runtime.agent_invoice_reminder_rules WHERE workspace_id=$1 AND customer_id=$2 FOR UPDATE',[ctx.workspaceId,input.customerId])).rows[0];
  if((prior?.revision||0)!==revision)throw new ValidationError('This reminder schedule changed. Reload it before saving.');
  if(input.remove==='1'){await c.query('DELETE FROM stockchief_runtime.agent_invoice_reminder_rules WHERE workspace_id=$1 AND customer_id=$2',[ctx.workspaceId,input.customerId]);await audit(c,ctx,{action:'Customer reminder schedule stopped',reference:input.customerId});return;}
  const customer=(await c.query("SELECT id,email FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'",[ctx.workspaceId,input.customerId])).rows[0],box=await require('../shipping/agent-shipping-notices').mailbox(c,ctx.workspaceId,input.connectorId);
  if(!customer||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email||'')||!box)throw new ValidationError('Confirm the customer’s email and a connected sending mailbox first.');
  const currency=money.code(input.currency),maximum=money.userToMinor(input.maximum,currency),days=scheduleDays(input);
  if(maximum<=0)throw new ValidationError('Set a positive balance limit for automatic reminders.');
  // Each step keeps the owner's own wording, or the standard wording for its stage.
  const templates={};
  for(const offset of days){
   const subject=input['subject'+offset],body=input['body'+offset],saved=prior?.templates?.[String(offset)];
   if(subject===undefined&&body===undefined){if(saved)templates[String(offset)]=saved;continue;}
   // Standard wording (of any stage) stays standard, so it follows the step's stage.
   const words=checkWording(subject,body);
   if(!Object.values(STAGES).some(base=>words.subject===base.subject&&words.body===base.body))templates[String(offset)]=words;
  }
  if(state.shadow)throw new ValidationError('Set automatic reminder schedules after the first 14 days of watching.');
  await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?0:1);
  await c.query(`INSERT INTO stockchief_runtime.agent_invoice_reminder_rules(workspace_id,customer_id,connector_id,mailbox_account,recipient,currency,maximum_minor,days_after_due,authorized_by,provider_type,templates)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(workspace_id,customer_id) DO UPDATE SET connector_id=EXCLUDED.connector_id,mailbox_account=EXCLUDED.mailbox_account,provider_type=EXCLUDED.provider_type,recipient=EXCLUDED.recipient,currency=EXCLUDED.currency,maximum_minor=EXCLUDED.maximum_minor,days_after_due=EXCLUDED.days_after_due,authorized_by=EXCLUDED.authorized_by,templates=EXCLUDED.templates,revision=stockchief_runtime.agent_invoice_reminder_rules.revision+1,problem=NULL,retry_after=NULL`,[ctx.workspaceId,customer.id,box.id,box.provider_account_id,customer.email,currency,maximum,days,ctx.actorId,box.provider_type,JSON.stringify(templates)]);
  const trained=state.plan!=='growth'||await sentExample(c,ctx.workspaceId,{customerId:customer.id,recipient:customer.email,connectorId:box.id,mailboxAccount:box.provider_account_id,providerType:box.provider_type,currency},maximum);
  await audit(c,ctx,{action:'Customer reminder schedule changed',reference:customer.id,after:{days,currency,maximum:money.format(maximum,currency),ownWording:Object.keys(templates),sendsAlone:trained}});
  return {trained};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Scheduled drafts that no longer match the invoice, schedule or newer work
// are withdrawn, so Needs you only shows reminders that are still right.
async function sweep(db,workspaceId){
 const disputed=await has(db,DISPUTES);
 await db.query(`UPDATE stockchief_runtime.assistant_action_proposals p SET status='CANCELLED',cancelled_at=now(),result='{"superseded":true}'::jsonb
  WHERE p.workspace_id=$1 AND p.action_type=$2 AND p.status='PENDING' AND p.payload ? 'windowKey' AND (
   NOT EXISTS(SELECT 1 FROM accounting_customer_invoices i WHERE i.workspace_id=p.workspace_id AND i.id=p.payload->>'recordId' AND i.status IN ('OPEN','PARTIALLY_PAID') AND i.balance_minor=(p.payload->>'balanceMinor')::bigint)
   OR NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_invoice_reminder_rules r WHERE r.workspace_id=p.workspace_id AND r.customer_id=p.payload->>'customerId' AND r.revision=(p.payload->>'ruleRevision')::int)
   OR EXISTS(SELECT 1 FROM customer_communications m WHERE m.workspace_id=p.workspace_id AND m.customer_invoice_id=p.payload->>'recordId' AND m.created_at::timestamptz>=p.created_at)
   OR EXISTS(SELECT 1 FROM stockchief_runtime.assistant_action_proposals n WHERE n.workspace_id=p.workspace_id AND n.action_type=p.action_type AND n.id<>p.id AND n.status='PENDING'
     AND n.payload->>'recordId'=p.payload->>'recordId' AND n.payload ? 'windowKey' AND n.created_at>p.created_at)
   ${disputed?`OR EXISTS(SELECT 1 FROM ${DISPUTES} d WHERE d.workspace_id=p.workspace_id AND d.invoice_id=p.payload->>'recordId' AND d.status='OPEN')`:''})`,[workspaceId,action]);
}
// Why a due reminder waits for the owner instead of going out alone.
async function waitReason(db,workspaceId,account,autopilot,askFirst,quota,rule){
 if(!autopilot.canAutomate)return 'StockChief is set to ask you first.';
 if(askFirst)return askFirst;
 if(quota)return quota;
 const p={customerId:rule.customer_id,recipient:rule.recipient,connectorId:rule.connector_id,mailboxAccount:rule.mailbox_account,providerType:rule.provider_type,currency:rule.currency};
 const example=await sentExample(db,workspaceId,p,Number(rule.maximum_minor));
 if(!policy.permits(account.plan,102,'automatic',{trained:account.plan!=='growth'||example}))return 'You have not taught StockChief this customer’s reminders yet. Approve this one; once the mailbox confirms it, the schedule sends on its own.';
 if(!example&&!await knownCustomer(db,workspaceId,rule.customer_id))return 'Approve this first B2B customer reminder individually.';
 return null;
}
async function draft(db,workspaceId,rule,invoice,reason){
 const windowKey='invoice-reminder:'+invoice.id+':schedule:'+invoice.offset_days;
 const waiting=(await db.query(`SELECT id FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND action_type=$2 AND status='PENDING' AND payload->>'windowKey'=$3 LIMIT 1`,[workspaceId,action,windowKey])).rows[0];
 if(waiting)return 'waiting';
 const ctx={workspaceId,actorId:rule.authorized_by,planStepKey:'invoice-reminder-draft:'+invoice.id+':'+invoice.offset_days+':'+newId('draft')};
 const prepared=await require('../assistant/postgres-service').prepareAction(db,ctx,'A payment reminder is due on your schedule',{action,recordReference:invoice.invoice_number,mailbox:rule.connector_id,reminderOffset:invoice.offset_days,ruleRevision:rule.revision});
 if(prepared.status!=='PREPARED')throw new ValidationError(prepared.answer||'StockChief could not prepare this reminder.');
 await db.transaction(async c=>{
  await c.query('UPDATE stockchief_runtime.agent_invoice_reminder_rules SET problem=$3 WHERE workspace_id=$1 AND customer_id=$2',[workspaceId,rule.customer_id,'Waiting for your approval: '+reason]);
  await audit(c,{workspaceId,actorId:rule.authorized_by},{action:'Payment reminder prepared for approval',reference:invoice.invoice_number,after:{proposalId:prepared.proposal.id,daysFromDue:invoice.offset_days,reason}});
 });
 return 'drafted';
}
async function run(db,workspaceId){
 const result={queued:0,held:0,drafted:0,watched:0};if(!(await db.query('SELECT 1 FROM stockchief_runtime.agent_invoice_reminder_rules WHERE workspace_id=$1 LIMIT 1',[workspaceId])).rowCount)return result;
 const account=await policy.accountState(db,workspaceId);if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,102,'draft'))return result;
 await sweep(db,workspaceId);
 const autopilot=await require('../autopilot/postgres-service').getState(db,workspaceId),modes=require('../autopilot/job-modes');
 const watch=account.shadow?'StockChief is watching during its first 14 days and did not send reminders.':autopilot.mode==='OBSERVE'?'StockChief is set to Watch only and did not send reminders.'
  :autopilot.paused||autopilot.suspended?'Automatic work is paused, so StockChief did not send reminders.':await modes.restriction(db,workspaceId,102,false);
 const {calendarDate:today,timeZone}=await require('../lib/business-time').forWorkspace(db,workspaceId),disputed=await has(db,DISPUTES);
 const candidates=(await db.query(`SELECT i.id,i.invoice_number,i.balance_minor::text balance_minor,i.currency,
   (SELECT cu.name FROM customers cu WHERE cu.workspace_id=i.workspace_id AND cu.id=i.customer_id) customer_name,to_jsonb(r) rule,d.offset_days FROM stockchief_runtime.agent_invoice_reminder_rules r
  JOIN accounting_customer_invoices i ON i.workspace_id=r.workspace_id AND i.customer_id=r.customer_id AND i.currency=r.currency
   AND i.status IN ('OPEN','PARTIALLY_PAID') AND i.balance_minor BETWEEN 1 AND r.maximum_minor AND i.due_date IS NOT NULL
  CROSS JOIN LATERAL(SELECT max(n) AS offset_days FROM unnest(r.days_after_due) n WHERE i.due_date::date+n<=$2::date)d
  WHERE r.workspace_id=$1 AND d.offset_days IS NOT NULL AND (r.retry_after IS NULL OR r.retry_after<=now())
   AND NOT EXISTS(SELECT 1 FROM customer_communications m WHERE m.workspace_id=i.workspace_id AND m.idempotency_key='invoice-reminder:'||i.id||':schedule:'||d.offset_days)
   AND NOT EXISTS(SELECT 1 FROM customer_communications m WHERE m.workspace_id=i.workspace_id AND m.customer_invoice_id=i.id AND m.status='SENT' AND m.external_message_id IS NOT NULL AND m.sent_at::timestamptz>=((i.due_date::date+d.offset_days)::timestamp AT TIME ZONE $3))
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.assistant_action_proposals p WHERE p.workspace_id=i.workspace_id AND p.action_type='customer_invoice.remind' AND p.status='CANCELLED'
     AND p.payload->>'windowKey'='invoice-reminder:'||i.id||':schedule:'||d.offset_days AND p.result->>'superseded' IS NULL)
   ${disputed?`AND NOT EXISTS(SELECT 1 FROM ${DISPUTES} x WHERE x.workspace_id=i.workspace_id AND x.invoice_id=i.id AND x.status='OPEN')`:''}
  ORDER BY i.due_date,i.id LIMIT 20`,[workspaceId,today,timeZone])).rows;
 if(watch){
  // Watch: say what would have gone out; nothing is drafted or sent.
  const per=new Map();for(const c of candidates)per.set(c.rule.customer_id,(per.get(c.rule.customer_id)||0)+1);
  for(const [customerId,n] of per)await db.query('UPDATE stockchief_runtime.agent_invoice_reminder_rules SET problem=$3 WHERE workspace_id=$1 AND customer_id=$2',[workspaceId,customerId,watch+' It would have sent '+n+(n===1?' reminder.':' reminders.')]);
  // Job 198: the first 14 days also go into the shadow-mode report, on plans where reminders go out alone.
  if(account.shadow&&policy.permits(account.plan,102,'automatic',{trained:true}))for(const c of candidates)
   await require('../autopilot/shadow-mode').record(db,workspaceId,{job:102,kind:'message',key:'invoice-reminder:'+c.id+':'+c.offset_days,
    summary:'Remind '+(c.customer_name||'the customer')+' about invoice '+c.invoice_number+' ('+money.format(Number(c.balance_minor),c.currency)+' unpaid)',
    amountMinor:Number(c.balance_minor),currency:c.currency,evidence:{daysFromDue:c.offset_days},href:'/money/invoices/'+c.id},account);
  result.watched=candidates.length;return result;
 }
 const askFirst=await modes.restriction(db,workspaceId,102,true),quota=await require('../commercial/agent-rule-quota').restriction(db,account);
 const heldCustomers=new Set();
 for(const invoice of candidates){
  const rule=invoice.rule;if(heldCustomers.has(rule.customer_id))continue;
  const reason=await waitReason(db,workspaceId,account,autopilot,askFirst,quota,rule);
  if(reason){
   let status;
   try{status=await draft(db,workspaceId,rule,invoice,reason);}
   catch(error){
    if(!['validation_error','forbidden','entitlement_required'].includes(error.code))throw error;
    await db.query("UPDATE stockchief_runtime.agent_invoice_reminder_rules SET problem=$3,retry_after=now()+interval '15 minutes' WHERE workspace_id=$1 AND customer_id=$2",[workspaceId,rule.customer_id,error.message]);
    status='held';heldCustomers.add(rule.customer_id);
   }
   if(status==='drafted')result.drafted++;else if(status==='held')result.held++;
   continue;
  }
  const status=await db.transaction(async c=>{
   await c.query('SAVEPOINT invoice_reminder_queue');
   try{
    const today=await require('../lib/business-time').today(c,workspaceId),fresh=await facts(c,{workspaceId,actorId:rule.authorized_by},invoice.id,rule.connector_id);
    const p={...fresh,kind:'invoice_reminder',actorId:rule.authorized_by,automatic:true,ruleRevision:rule.revision,daysAfterDue:invoice.offset_days,template:template(rule,invoice.offset_days),daysFromDue:daysFrom(today,fresh.dueDate)};
    const queued=await queue(c,{workspaceId,actorId:rule.authorized_by},p,'invoice-reminder:'+invoice.id+':schedule:'+invoice.offset_days);
    await c.query('UPDATE stockchief_runtime.agent_invoice_reminder_rules SET problem=NULL,retry_after=NULL WHERE workspace_id=$1 AND customer_id=$2',[workspaceId,rule.customer_id]);
    await audit(c,{workspaceId,actorId:rule.authorized_by},{action:'Payment reminder sent by StockChief on the owner’s schedule',reference:invoice.invoice_number,after:{communicationId:queued.communicationId,daysFromDue:invoice.offset_days,stage:p.template.stage,balanceMinor:p.balanceMinor,currency:p.currency}});
    await c.query('RELEASE SAVEPOINT invoice_reminder_queue');return 'queued';
   }catch(error){
    if(!['validation_error','forbidden','entitlement_required'].includes(error.code))throw error;
    await c.query('ROLLBACK TO SAVEPOINT invoice_reminder_queue');await c.query('RELEASE SAVEPOINT invoice_reminder_queue');
    await c.query("UPDATE stockchief_runtime.agent_invoice_reminder_rules SET problem=$3,retry_after=now()+interval '15 minutes' WHERE workspace_id=$1 AND customer_id=$2",[workspaceId,rule.customer_id,error.message]);
    return 'held';
   }
  },{isolation:'SERIALIZABLE',retrySafe:true});
  result[status]++;if(status==='held')heldCustomers.add(rule.customer_id);
 }
 return result;
}

// Disputes: the customer questions an invoice or says it is paid. Reminders
// for that invoice stop until the owner settles it.
const disputeWords=/\b(?:dispute|disputing|disputed|incorrect|wrong|overcharged|over-charged|charged twice|double[- ]charged|not ours|never (?:ordered|received)|did not (?:order|receive)|didn't (?:order|receive)|not received|already paid|have paid|has been paid|paid (?:this|it|that|in full|on)|payment (?:was )?sent|query|question about|returned|credit note)\b/i;
async function fromEmail(c,workspaceId,{messageId,customerId,subject,body,threadId,connectorId}){
 if(!await has(c,DISPUTES))return null;
 const words=require('./statement-request').own(body),text=String(subject||'')+'\n'+words;
 if(!disputeWords.test(text))return null;
 const state=await policy.accountState(c,workspaceId);
 if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,102,'draft'))return null;
 const open=(await c.query(`SELECT id,invoice_number FROM accounting_customer_invoices WHERE workspace_id=$1 AND customer_id=$2 AND status IN ('OPEN','PARTIALLY_PAID') AND balance_minor>0 ORDER BY id LIMIT 500`,[workspaceId,customerId])).rows;
 const lower=text.toLowerCase();
 let named=open.filter(i=>{const n=i.invoice_number.toLowerCase(),at=lower.indexOf(n);return at>=0&&!/[\p{L}\p{N}]/u.test(lower[at+n.length]||'')&&!/[\p{L}\p{N}]/u.test(lower[at-1]||'');});
 if(!named.length&&threadId){
  // A reply in the thread of one of our reminders is about that reminder's invoice.
  named=(await c.query(`SELECT DISTINCT i.id,i.invoice_number FROM customer_communications m JOIN accounting_customer_invoices i ON i.workspace_id=m.workspace_id AND i.id=m.customer_invoice_id
   WHERE m.workspace_id=$1 AND m.customer_id=$2 AND m.connector_id=$3 AND m.external_thread_id=$4 AND i.status IN ('OPEN','PARTIALLY_PAID') LIMIT 5`,[workspaceId,customerId,connectorId,threadId])).rows;
 }
 const reason=('The customer wrote: “'+words.replace(/\s+/g,' ').trim()).slice(0,440)+'”';
 for(const invoice of named)await c.query(`INSERT INTO ${DISPUTES}(workspace_id,id,invoice_id,customer_id,source,message_id,reason) VALUES($1,$2,$3,$4,'email',$5,$6) ON CONFLICT DO NOTHING`,
  [workspaceId,newId('invdispute'),invoice.id,customerId,messageId,reason]);
 return named.length?{disputed:named.map(i=>i.invoice_number)}:null;
}
async function dispute(db,ctx,input){
 await owner(db,ctx);
 return db.transaction(async c=>{
  await policy.requireWorkspaceJob(c,ctx.workspaceId,102,'draft');
  const invoice=(await c.query("SELECT id,invoice_number,customer_id FROM accounting_customer_invoices WHERE workspace_id=$1 AND (id=$2 OR lower(invoice_number)=lower($2)) LIMIT 2",[ctx.workspaceId,String(input.invoiceNumber||'').trim()])).rows;
  if(invoice.length!==1)throw new ValidationError('Choose one exact customer invoice number.');
  if(input.resolve==='1'){
   const row=(await c.query(`UPDATE ${DISPUTES} SET status='RESOLVED',resolved_by=$3,resolved_at=clock_timestamp() WHERE workspace_id=$1 AND invoice_id=$2 AND status='OPEN' RETURNING *`,[ctx.workspaceId,invoice[0].id,ctx.actorId])).rows[0];
   if(!row)throw new ValidationError('This invoice has no open dispute.');
   await audit(c,ctx,{action:'Customer invoice dispute settled; reminders resume',reference:invoice[0].invoice_number,before:{reason:row.reason},after:{status:'RESOLVED'}});
   return {resolved:true};
  }
  const reason=String(input.reason||'').trim();if(!reason||reason.length>500)throw new ValidationError('Say in up to 500 characters what the customer disputes.');
  const inserted=await c.query(`INSERT INTO ${DISPUTES}(workspace_id,id,invoice_id,customer_id,source,reason,opened_by) VALUES($1,$2,$3,$4,'owner',$5,$6) ON CONFLICT DO NOTHING RETURNING id`,[ctx.workspaceId,newId('invdispute'),invoice[0].id,invoice[0].customer_id,reason,ctx.actorId]);
  if(!inserted.rowCount)throw new ValidationError('This invoice is already marked as disputed.');
  await audit(c,ctx,{action:'Customer invoice marked disputed; reminders stop',reference:invoice[0].invoice_number,after:{reason}});
  return {disputed:true};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function disputes(db,workspaceId,limit=50){
 if(!await has(db,DISPUTES))return [];
 return (await db.query(`SELECT d.id,d.reason,d.source,d.created_at,d.message_id,i.invoice_number,i.id invoice_id,i.balance_minor,i.currency,c.name customer_name FROM ${DISPUTES} d
  JOIN accounting_customer_invoices i ON i.workspace_id=d.workspace_id AND i.id=d.invoice_id JOIN customers c ON c.workspace_id=d.workspace_id AND c.id=d.customer_id
  WHERE d.workspace_id=$1 AND d.status='OPEN' ORDER BY d.created_at DESC,d.id LIMIT $2`,[workspaceId,limit])).rows;
}
// Needs you: each open dispute, until the owner settles it.
async function inbox(db,workspaceId){
 return (await disputes(db,workspaceId,20)).map(d=>({kind:'accounting',importance:'Needs You',priority:78,
  title:d.customer_name+' disputes '+d.invoice_number,happened:'Payment reminders for '+d.invoice_number+' ('+money.format(d.balance_minor,d.currency)+' outstanding) have stopped.',
  why:d.reason,recommendation:'Check the invoice with the customer. Correct or credit it if needed, then resume reminders.',
  href:'/autopilot/reviews/invoice-reminders',actionLabel:'Review the dispute',sourceId:'invoice-dispute:'+d.id,createdAt:d.created_at,timeLabel:'Raised',at:d.created_at}));
}
async function review(db,ctx,{page=1,filter=''}){
 const rows=(await db.query(`SELECT i.invoice_number "Invoice",c.name "Customer",i.due_date "Due",i.balance_minor,i.currency,'/money/invoices/'||i.id link
  FROM accounting_customer_invoices i JOIN customers c ON c.workspace_id=i.workspace_id AND c.id=i.customer_id WHERE i.workspace_id=$1 AND i.status IN ('OPEN','PARTIALLY_PAID') AND i.balance_minor>0 AND ($2='' OR lower(i.invoice_number)=lower($2) OR lower(c.name)=lower($2)) ORDER BY i.due_date NULLS LAST,i.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 const customers=(await db.query("SELECT id,name,email FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' ORDER BY name,id LIMIT 200",[ctx.workspaceId])).rows,mailboxes=await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId),rules=(await db.query(`SELECT r.*,c.name customer_name FROM stockchief_runtime.agent_invoice_reminder_rules r JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id WHERE r.workspace_id=$1 ORDER BY c.name,c.id LIMIT 101 OFFSET $2`,[ctx.workspaceId,(page-1)*100])).rows;
 const history=await require('../commercial/agent-history').access(db,ctx.workspaceId),recent=(await db.query(`SELECT m.status,m.recipient,m.error_message,m.sent_at,m.subject,i.invoice_number,'/money/invoices/'||i.id href FROM customer_communications m
  JOIN accounting_customer_invoices i ON i.workspace_id=m.workspace_id AND i.id=m.customer_invoice_id WHERE m.workspace_id=$1
   AND ($2::timestamptz IS NULL OR m.created_at::timestamptz>=$2::timestamptz) ORDER BY m.created_at DESC,m.id LIMIT 21 OFFSET $3`,[ctx.workspaceId,history.activityAfter,(page-1)*20])).rows;
 const currency=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency||'',account=await policy.accountState(db,ctx.workspaceId),blocked=await policy.stopped(db,ctx.workspaceId,account,action,false);
 const when=d=>d<0?(-d)+(d===-1?' day before due':' days before due'):d===0?'On the due date':d+(d===1?' day after due':' days after due');
 return {summary:'Remind customers about unpaid invoices on your schedule: before the due date, on it and after it, each step in its own words. Every reminder uses the current balance, stops once the invoice is paid or disputed, and stays within your balance limit. Growth asks you to approve reminders until you have approved one the mailbox confirmed for that customer; Pro and Custom send on their own.',rows:rows.slice(0,100).map(({balance_minor,currency,...r})=>({...r,Balance:money.format(balance_minor,currency)})),more:rows.length>100||recent.length>20||rules.length>100,
  reminderForm:{customers,mailboxes,currency,blocked,recent:recent.slice(0,20),disputes:(await disputes(db,ctx.workspaceId)).map(d=>({...d,balance:money.format(d.balance_minor,d.currency)})),
   rules:rules.slice(0,100).map(r=>({...r,maximum:money.format(r.maximum_minor,r.currency),maximumInput:money.fromMinor(r.maximum_minor,r.currency),
    before:r.days_after_due.filter(d=>d<0).map(d=>-d).join(', '),onDue:r.days_after_due.includes(0),after:r.days_after_due.filter(d=>d>0).join(', '),
    when:r.days_after_due.map(when).join(' · '),steps:r.days_after_due.map(d=>({offset:d,when:when(d),...template(r,d),label:STAGES[stage(r.days_after_due,d)].label}))}))}};
}
module.exports={configure,run,sendAuthority,compose,template,STAGES,fromEmail,dispute,disputes,inbox,definition:{id:102,key:'invoice-reminders',label:'Scheduled customer payment reminders',filterLabel:'Invoice number or customer',readPage:review},spec:{name:action,completionGate:'provider_effect_succeeded',resultingRecords:['customer_communications','stockchief_runtime.provider_effects'],record:'customer_invoice',fields:['recordReference','mailbox'],permission:require('../actions/permissions').OPERATE,ownerOnly:true,capability:'connection.email',description:'Prepare a source-grounded reminder for one issued customer invoice using its current balance, recorded due date, confirmed customer email and exact connected mailbox. Individual approval sends only this message; no charge, payment, terms or stock changes. Use the owner’s separate scheduled-reminder settings for automatic follow-ups.',build,execute,verify:async(db,ctx,r,p)=>Boolean((await db.query('SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND id=$2 AND customer_invoice_id=$3 AND status IN (\'QUEUED\',\'SENDING\',\'SENT\')',[ctx.workspaceId,r.communicationId,p.recordId])).rowCount)}};

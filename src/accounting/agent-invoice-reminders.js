'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors'),money=require('../domain/currency'),policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions');
const action='customer_invoice.remind';
async function owner(db,ctx){
 const row=(await db.query(`SELECT u.role FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2
  AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL)`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(row?.role!=='owner')throw new AuthorizationError('Only the inventory owner can authorize customer payment reminders.');
}
async function facts(db,ctx,id,connectorId){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,102,'draft');
 const i=(await db.query(`SELECT i.*,c.name customer_name,c.email,c.record_state FROM accounting_customer_invoices i
  JOIN customers c ON c.workspace_id=i.workspace_id AND c.id=i.customer_id WHERE i.workspace_id=$1 AND i.id=$2`,[ctx.workspaceId,id])).rows[0];
 if(!i||!['OPEN','PARTIALLY_PAID'].includes(i.status)||Number(i.balance_minor)<=0||i.record_state!=='ACTIVE')throw new ValidationError('Use an issued invoice with an outstanding balance and an active customer.');
 if(!i.due_date)throw new ValidationError('Record the invoice’s agreed due date before scheduling a payment reminder.');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email||''))throw new ValidationError('Confirm a valid email address on this customer before preparing a reminder.');
 const box=await require('../shipping/agent-shipping-notices').mailbox(db,ctx.workspaceId,connectorId);
 if(!box)throw new ValidationError('Choose a connected Gmail or Microsoft 365 mailbox with permission to send.');
 const payload={recordId:i.id,invoiceNumber:i.invoice_number,customerId:i.customer_id,customerName:i.customer_name,recipient:i.email,currency:i.currency,balanceMinor:money.integer(i.balance_minor,'Invoice balance'),dueDate:i.due_date,connectorId:box.id,mailboxAccount:box.provider_account_id,providerType:box.provider_type};
 return {...payload,sourceFingerprint:hash(payload)};
}
function compose(p){return {subject:'Payment reminder: '+p.invoiceNumber,body:'Hello '+p.customerName+',\n\nOur records show '+money.format(p.balanceMinor,p.currency)+' outstanding on invoice '+p.invoiceNumber+', due '+p.dueDate+'. Please let us know if you have already paid or have a question about this invoice.\n\nThank you.'};}
async function build(db,ctx,row,args){
 const chosen=await require('../connections/postgres-outbound-mail').resolveMailbox(db,ctx.workspaceId,args.mailbox);
 if(!chosen.row)throw new ValidationError('Choose one connected sending mailbox by its exact name.');
 const p=await facts(db,ctx,row.id,chosen.row.id);
 return {payload:p,summary:'Send '+p.customerName+' ('+p.recipient+') a reminder for invoice '+p.invoiceNumber+': '+money.format(p.balanceMinor,p.currency)+' outstanding, due '+p.dueDate+'. Use '+chosen.row.display_name+'. This sends no charge, changes no payment terms and records no money received.'};
}
async function sentExample(db,workspaceId,p,maximum){return Boolean((await db.query(`SELECT 1 FROM customer_communications m
 JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
 WHERE m.workspace_id=$1 AND m.customer_id=$2 AND m.status='SENT' AND m.external_message_id IS NOT NULL
  AND e.payload->'standingAuthority'->>'kind'='invoice_reminder' AND e.payload->'standingAuthority'->>'automatic'='false'
  AND e.payload->'standingAuthority'->>'recipient'=$3 AND e.payload->'standingAuthority'->>'connectorId'=$4
  AND e.payload->'standingAuthority'->>'mailboxAccount'=$5 AND e.payload->'standingAuthority'->>'currency'=$6
  AND (e.payload->'standingAuthority'->>'balanceMinor')::numeric<=$7 AND e.payload->'standingAuthority'->>'providerType'=$8 LIMIT 1`,[workspaceId,p.customerId,p.recipient,p.connectorId,p.mailboxAccount,p.currency,maximum,p.providerType])).rowCount);}
async function sendAuthority(db,workspaceId,p){
 const ctx={workspaceId,actorId:p.actorId};await owner(db,ctx);const account=await policy.requireWorkspaceJob(db,workspaceId,102,'draft');
 const stop=await policy.stopped(db,workspaceId,account,action,p.automatic,p);if(stop)throw new ValidationError(stop);
 const fresh=await facts(db,ctx,p.recordId,p.connectorId);if(fresh.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('The invoice balance, due date, customer or mailbox changed. Prepare a fresh reminder.');
 if(!p.automatic)return fresh;
 if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)throw new ValidationError('Automatic reminders are paused.');
 const rule=(await db.query('SELECT * FROM stockchief_runtime.agent_invoice_reminder_rules WHERE workspace_id=$1 AND customer_id=$2',[workspaceId,p.customerId])).rows[0];
 if(!rule||rule.authorized_by!==p.actorId||rule.revision!==p.ruleRevision||rule.recipient!==p.recipient||rule.connector_id!==p.connectorId||rule.mailbox_account!==p.mailboxAccount||rule.provider_type!==p.providerType||rule.currency!==p.currency||Number(rule.maximum_minor)<p.balanceMinor||!rule.days_after_due.includes(p.daysAfterDue))throw new ValidationError('The owner’s reminder schedule or limit changed. Review the current schedule.');
 const trained=account.plan!=='growth'||await sentExample(db,workspaceId,p,Number(rule.maximum_minor));policy.requireJob(account.plan,102,'automatic',{trained});
 const today=await require('../lib/business-time').today(db,workspaceId),start=require('./customer-money').addDays(p.dueDate,p.daysAfterDue);
 if(today<start)throw new ValidationError('This reminder is not due yet.');
 const {timeZone}=await require('../lib/business-time').forWorkspace(db,workspaceId),boundary=require('../lib/business-time').dayBoundary(start,timeZone);
 if((await db.query("SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND customer_invoice_id=$2 AND status='SENT' AND external_message_id IS NOT NULL AND sent_at::timestamptz>=$3::timestamptz LIMIT 1",[workspaceId,p.recordId,boundary])).rowCount)throw new ValidationError('A reminder was already sent during this scheduled window.');
 const known=(await db.query(`SELECT EXISTS(SELECT 1 FROM accounting_payments WHERE workspace_id=$1 AND customer_id=$2 AND direction='CUSTOMER_RECEIPT' AND status='POSTED')
 OR EXISTS(SELECT 1 FROM sales_orders o JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id WHERE o.workspace_id=$1 AND o.customer_id=$2 AND l.quantity_fulfilled>0) AS known`,[workspaceId,p.customerId])).rows[0].known;
 if(!known&&!await sentExample(db,workspaceId,p,Number(rule.maximum_minor)))throw new ValidationError('Approve this first B2B customer reminder individually.');
 return fresh;
}
async function queue(db,ctx,p,idempotencyKey){
 await sendAuthority(db,ctx.workspaceId,p);const words=compose(p);
 const result=await require('../connections/postgres-outbound-mail').queueInTransaction(db,ctx,{recipientKind:'customer',recipientId:p.customerId,recipientEmail:p.recipient,connectorId:p.connectorId,...words,standingAuthority:p},idempotencyKey,{agentRequested:true,agentJob:102});
 await db.query('UPDATE customer_communications SET customer_invoice_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,result.communicationId,p.recordId]);
 return {...result,invoiceId:p.recordId,href:'/money/invoices/'+p.recordId};
}
async function execute(db,ctx,p){const fresh=await facts(db,ctx,p.recordId,p.connectorId);if(fresh.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('The invoice or mailbox changed after review. Prepare a fresh reminder.');return queue(db,ctx,{...fresh,kind:'invoice_reminder',actorId:ctx.actorId,automatic:false},p.idempotencyKey);}
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
  if(input.remove==='1'){await c.query('DELETE FROM stockchief_runtime.agent_invoice_reminder_rules WHERE workspace_id=$1 AND customer_id=$2',[ctx.workspaceId,input.customerId]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Customer reminder schedule stopped',reference:input.customerId});return;}
  const customer=(await c.query("SELECT id,email FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'",[ctx.workspaceId,input.customerId])).rows[0],box=await require('../shipping/agent-shipping-notices').mailbox(c,ctx.workspaceId,input.connectorId);
  if(!customer||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email||'')||!box)throw new ValidationError('Confirm the customer’s email and a connected sending mailbox first.');
  const currency=money.code(input.currency),maximum=money.userToMinor(input.maximum,currency),parts=String(input.days||'').split(',').map(v=>v.trim());
  if(maximum<=0||parts.length<1||parts.length>12||parts.some(v=>!/^\d{1,3}$/.test(v)||Number(v)<1||Number(v)>365))throw new ValidationError('Set a positive balance limit and one to twelve reminder days after the due date, between 1 and 365.');
  const days=[...new Set(parts.map(Number))].sort((a,b)=>a-b),p={customerId:customer.id,recipient:customer.email,connectorId:box.id,mailboxAccount:box.provider_account_id,providerType:box.provider_type,currency};
  if(state.shadow)throw new ValidationError('Set automatic reminder schedules after the first 14 days of watching.');
  const trained=state.plan!=='growth'||await sentExample(c,ctx.workspaceId,p,maximum);
  if(!trained)throw new ValidationError('Approve and send one reminder for this customer from this mailbox before enabling a Growth schedule.');
  policy.requireJob(state.plan,102,'automatic',{trained});
  await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?0:1);
  await c.query(`INSERT INTO stockchief_runtime.agent_invoice_reminder_rules(workspace_id,customer_id,connector_id,mailbox_account,recipient,currency,maximum_minor,days_after_due,authorized_by,provider_type)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,customer_id) DO UPDATE SET connector_id=EXCLUDED.connector_id,mailbox_account=EXCLUDED.mailbox_account,provider_type=EXCLUDED.provider_type,recipient=EXCLUDED.recipient,currency=EXCLUDED.currency,maximum_minor=EXCLUDED.maximum_minor,days_after_due=EXCLUDED.days_after_due,authorized_by=EXCLUDED.authorized_by,revision=stockchief_runtime.agent_invoice_reminder_rules.revision+1,problem=NULL,retry_after=NULL`,[ctx.workspaceId,customer.id,box.id,box.provider_account_id,customer.email,currency,maximum,days,ctx.actorId,box.provider_type]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Customer reminder schedule changed',reference:customer.id,after:{days,currency,maximum:money.format(maximum,currency)}});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function run(db,workspaceId){
 const result={queued:0,held:0};if(!(await db.query('SELECT 1 FROM stockchief_runtime.agent_invoice_reminder_rules WHERE workspace_id=$1 LIMIT 1',[workspaceId])).rowCount)return result;
 const account=await policy.accountState(db,workspaceId);if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,102,'automatic',{trained:true})||!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return result;
 const {calendarDate:today,timeZone}=await require('../lib/business-time').forWorkspace(db,workspaceId);
 const candidates=(await db.query(`SELECT i.id,to_jsonb(r) rule,d.offset_days FROM stockchief_runtime.agent_invoice_reminder_rules r
  JOIN accounting_customer_invoices i ON i.workspace_id=r.workspace_id AND i.customer_id=r.customer_id AND i.currency=r.currency
   AND i.status IN ('OPEN','PARTIALLY_PAID') AND i.balance_minor BETWEEN 1 AND r.maximum_minor AND i.due_date IS NOT NULL
  CROSS JOIN LATERAL(SELECT max(n) AS offset_days FROM unnest(r.days_after_due) n WHERE i.due_date::date+n<=$2::date)d
  WHERE r.workspace_id=$1 AND d.offset_days IS NOT NULL AND (r.retry_after IS NULL OR r.retry_after<=now())
   AND NOT EXISTS(SELECT 1 FROM customer_communications m WHERE m.workspace_id=i.workspace_id AND m.idempotency_key='invoice-reminder:'||i.id||':schedule:'||d.offset_days)
   AND NOT EXISTS(SELECT 1 FROM customer_communications m WHERE m.workspace_id=i.workspace_id AND m.customer_invoice_id=i.id AND m.status='SENT' AND m.external_message_id IS NOT NULL AND m.sent_at::timestamptz>=((i.due_date::date+d.offset_days)::timestamp AT TIME ZONE $3))
  ORDER BY i.due_date,i.id LIMIT 20`,[workspaceId,today,timeZone])).rows;
 const heldCustomers=new Set();
 for(const invoice of candidates){
  const rule=invoice.rule;if(heldCustomers.has(rule.customer_id))continue;
  const status=await db.transaction(async c=>{
   await c.query('SAVEPOINT invoice_reminder_queue');
   try{
    const p={...await facts(c,{workspaceId,actorId:rule.authorized_by},invoice.id,rule.connector_id),kind:'invoice_reminder',actorId:rule.authorized_by,automatic:true,ruleRevision:rule.revision,daysAfterDue:invoice.offset_days};
    await queue(c,{workspaceId,actorId:rule.authorized_by},p,'invoice-reminder:'+invoice.id+':schedule:'+invoice.offset_days);
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
async function review(db,ctx,{page=1,filter=''}){
 const rows=(await db.query(`SELECT i.invoice_number "Invoice",c.name "Customer",i.due_date "Due",i.balance_minor,i.currency,'/money/invoices/'||i.id link
  FROM accounting_customer_invoices i JOIN customers c ON c.workspace_id=i.workspace_id AND c.id=i.customer_id WHERE i.workspace_id=$1 AND i.status IN ('OPEN','PARTIALLY_PAID') AND i.balance_minor>0 AND ($2='' OR lower(i.invoice_number)=lower($2) OR lower(c.name)=lower($2)) ORDER BY i.due_date NULLS LAST,i.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 const customers=(await db.query("SELECT id,name,email FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' ORDER BY name,id LIMIT 200",[ctx.workspaceId])).rows,mailboxes=await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId),rules=(await db.query(`SELECT r.*,c.name customer_name FROM stockchief_runtime.agent_invoice_reminder_rules r JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id WHERE r.workspace_id=$1 ORDER BY c.name,c.id LIMIT 101 OFFSET $2`,[ctx.workspaceId,(page-1)*100])).rows;
 const history=await require('../commercial/agent-history').access(db,ctx.workspaceId),recent=(await db.query(`SELECT m.status,m.recipient,m.error_message,m.sent_at,i.invoice_number,'/money/invoices/'||i.id href FROM customer_communications m
  JOIN accounting_customer_invoices i ON i.workspace_id=m.workspace_id AND i.id=m.customer_invoice_id WHERE m.workspace_id=$1
   AND ($2::timestamptz IS NULL OR m.created_at::timestamptz>=$2::timestamptz) ORDER BY m.created_at DESC,m.id LIMIT 21 OFFSET $3`,[ctx.workspaceId,history.activityAfter,(page-1)*20])).rows;
 const currency=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency||'',account=await policy.accountState(db,ctx.workspaceId),blocked=await policy.stopped(db,ctx.workspaceId,account,action,false);
 return {summary:'Prepare an exact invoice reminder for your approval, or enable a customer schedule with its balance limit. Growth learns from a reminder you approved and the mailbox confirmed sending. Automatic reminders require routine work; paid or changed invoices are held before sending.',rows:rows.slice(0,100).map(({balance_minor,currency,...r})=>({...r,Balance:money.format(balance_minor,currency)})),more:rows.length>100||recent.length>20||rules.length>100,reminderForm:{customers,mailboxes,currency,blocked,recent:recent.slice(0,20),rules:rules.slice(0,100).map(r=>({...r,maximum:money.format(r.maximum_minor,r.currency),maximumInput:money.fromMinor(r.maximum_minor,r.currency)}))}};
}
module.exports={configure,run,sendAuthority,definition:{id:102,key:'invoice-reminders',label:'Scheduled customer payment reminders',filterLabel:'Invoice number or customer',readPage:review},spec:{name:action,completionGate:'provider_effect_succeeded',resultingRecords:['customer_communications','stockchief_runtime.provider_effects'],record:'customer_invoice',fields:['recordReference','mailbox'],permission:require('../actions/permissions').OPERATE,ownerOnly:true,capability:'connection.email',description:'Prepare a source-grounded reminder for one issued customer invoice using its current balance, recorded due date, confirmed customer email and exact connected mailbox. Individual approval sends only this message; no charge, payment, terms or stock changes. Use the owner’s separate scheduled-reminder settings for automatic follow-ups.',build,execute,verify:async(db,ctx,r,p)=>Boolean((await db.query('SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND id=$2 AND customer_invoice_id=$3 AND status IN (\'QUEUED\',\'SENT\')',[ctx.workspaceId,r.communicationId,p.recordId])).rowCount)}};

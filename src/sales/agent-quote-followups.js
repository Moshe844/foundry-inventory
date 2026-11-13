'use strict';
const {ValidationError}=require('../domain/errors'),{hash}=require('../pricing/postgres-promotions');
const policy=require('../commercial/agent-plan'),money=require('../domain/currency'),P=require('../actions/permissions');
const action='sales_quote.followup',kind='quote_followup',relation='stockchief_runtime.agent_quote_followups';
const quotationSource=require('./quote-message-source'),owner=quotationSource.owner,{has}=require('../db/schema-installed');
async function quote(db,ctx,id){return quotationSource.facts(db,ctx,id,{jobId:74});}
async function record(db,ctx,id,input){
 if(input.confirmed!=='yes')throw new ValidationError('Confirm that the customer actually received this exact quotation.');
 const key=String(input.requestKey||'').trim(),date=String(input.presentedOn||''),channel=String(input.channel||''),evidence=String(input.evidence||'').trim(),revision=Number(input.revision);
 if(!key||key.length>160||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||!['email','in_person','phone','customer_portal','post'].includes(channel)||!evidence||evidence.length>1000||!Number.isSafeInteger(revision)||revision<0)throw new ValidationError('Record the actual date, delivery method and reference, and reload the current quote before confirming.');
 return db.transaction(async c=>{
  const {q,customer,today}=await quote(c,ctx,id);if(input.expectedHash!==q.pricing_hash)throw new ValidationError('Review the exact saved quotation before recording its delivery.');
  const {timeZone}=await require('../lib/business-time').forWorkspace(c,ctx.workspaceId),created=require('../lib/business-time').context(timeZone,new Date(q.created_at)).calendarDate;
  if(date>today||date<created)throw new ValidationError('The date received must be between the quote’s creation and today.');
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('quote-followup:'||$1||':'||$2,0))",[ctx.workspaceId,id]);
  const prior=(await c.query('SELECT * FROM '+relation+' WHERE workspace_id=$1 AND quote_id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
  const inputHash=hash({id,quoteHash:q.pricing_hash,customerId:customer.id,recipient:customer.email,date,channel,evidence});
  if(prior?.request_key===key){if(prior.input_hash!==inputHash)throw new ValidationError('This confirmation request already has different details.');return {...prior,replayed:true};}
  if((prior?.revision||0)!==revision)throw new ValidationError('This quote confirmation changed. Reload it before saving.');
  const used=(await c.query('SELECT quote_id FROM '+relation+' WHERE workspace_id=$1 AND request_key=$2',[ctx.workspaceId,key])).rows[0];if(used)throw new ValidationError('That confirmation request belongs to another quotation.');
  await c.query(`INSERT INTO ${relation}(workspace_id,quote_id,quote_hash,customer_id,recipient,presented_on,presentation_channel,presentation_evidence,confirmed_by,request_key,input_hash)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(workspace_id,quote_id) DO UPDATE SET quote_hash=EXCLUDED.quote_hash,customer_id=EXCLUDED.customer_id,recipient=EXCLUDED.recipient,presented_on=EXCLUDED.presented_on,presentation_channel=EXCLUDED.presentation_channel,presentation_evidence=EXCLUDED.presentation_evidence,confirmed_by=EXCLUDED.confirmed_by,request_key=EXCLUDED.request_key,input_hash=EXCLUDED.input_hash,presentation_basis='owner_confirmed',presentation_email_id=NULL,revision=${relation}.revision+1,schedule_enabled=0,problem=NULL,retry_after=NULL,updated_at=now()`,[ctx.workspaceId,id,q.pricing_hash,customer.id,customer.email,date,channel,evidence,ctx.actorId,key,inputHash]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Customer receipt of quotation confirmed',reference:q.quote_number,before:prior?{revision:prior.revision,date:prior.presented_on,channel:prior.presentation_channel,evidence:prior.presentation_evidence}:{},after:{date,channel,evidence}});
  return (await c.query('SELECT * FROM '+relation+' WHERE workspace_id=$1 AND quote_id=$2',[ctx.workspaceId,id])).rows[0];
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function facts(db,ctx,id,connectorId){
 const {q,customer}=await quote(db,ctx,id),source=(await db.query('SELECT *,presented_on::text presented_date FROM '+relation+' WHERE workspace_id=$1 AND quote_id=$2',[ctx.workspaceId,id])).rows[0];
 if(!source||source.quote_hash!==q.pricing_hash||source.customer_id!==customer.id||source.recipient!==customer.email)throw new ValidationError('Record the owner’s confirmation that this customer received this exact quote at their current email before preparing a follow-up, or email the saved quotation through your connected mailbox.');
 if(source.presentation_basis==='mailbox_accepted')await sentEvidence(db,ctx.workspaceId,source);
 const box=await require('../shipping/agent-shipping-notices').mailbox(db,ctx.workspaceId,connectorId);if(!box)throw new ValidationError('Choose a connected Gmail or Microsoft 365 sending mailbox.');
 const currency=money.code(q.pricing.currency),totalMinor=money.integer(q.pricing.totalMinor,'Quoted total'),skus=[...new Set(q.input.lines.map(l=>l.skuId))].sort();
 const training=require('../autopilot/draft-authority').scope(customer.id,currency,totalMinor,['quote-followup',customer.email,box.id,box.provider_account_id,box.provider_type,skus],customer.name+' · same products as '+q.quote_number+' · '+currency);
 const p={recordId:q.id,quoteNumber:q.quote_number,quoteHash:q.pricing_hash,customerId:customer.id,customerName:customer.name,recipient:customer.email,currency,totalMinor,validUntil:q.valid_until,presentedOn:source.presented_date,presentationChannel:source.presentation_channel,presentationEvidence:source.presentation_evidence,presentationRevision:source.revision,connectorId:box.id,mailboxAccount:box.provider_account_id,providerType:box.provider_type,training};
 // Preserve the exact payload and hash of human-confirmed mail queued before migration 288.
 if(source.presentation_basis==='mailbox_accepted'){p.presentationBasis=source.presentation_basis;p.presentationEmailId=source.presentation_email_id;}
 return {...p,sourceFingerprint:hash(p)};
}
async function sentEvidence(db,workspaceId,source){
 const m=(await db.query(`SELECT m.*,e.payload FROM customer_communications m JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED' WHERE m.workspace_id=$1 AND m.id=$2 AND m.customer_id=$3 AND m.status='SENT' AND m.external_message_id IS NOT NULL`,[workspaceId,source.presentation_email_id,source.customer_id])).rows[0],p=m?.payload?.standingAuthority;
 if(!m||m.recipient!==source.recipient||m.idempotency_key!=='quotation-email:'+source.quote_id||m.approved_by_user_id!==source.confirmed_by||p?.kind!=='quote_share'||p.recordId!==source.quote_id||p.quoteHash!==source.quote_hash||p.actorId!==source.confirmed_by||p.connectorId!==m.connector_id||!(p.manualApproval===true&&p.automatic===false||p.manualApproval===false&&p.automatic===true&&p.agentJob===73&&Boolean(p.requestMessageId))||p.mailContentHash!==hash({subject:m.subject,body:m.body}))throw new ValidationError('The original quotation email has no matching confirmed mailbox receipt. Review its delivery before preparing a follow-up.');
 if(!m.sent_at||!p.businessTimeZone||require('../lib/business-time').context(p.businessTimeZone,new Date(m.sent_at)).calendarDate!==source.presented_date)throw new ValidationError('The quotation follow-up date no longer matches the confirmed original send. Review its delivery date.');
}
function compose(p){return {subject:'Following up on quotation '+p.quoteNumber,body:'Hello '+p.customerName+',\n\nI’m following up on quotation '+p.quoteNumber+(p.presentationBasis==='mailbox_accepted'?', which we emailed on ':', which our records show you received on ')+p.presentedOn+'. Its recorded total is '+money.format(p.totalMinor,p.currency)+', valid through '+p.validUntil+'.\n\nPlease let us know whether you would like to proceed or have any questions. This message does not change the quotation, reserve goods, create an order or invoice, or change your payment terms.\n\nThank you.'};}
async function authority(db,workspaceId,p){
 const ctx={workspaceId,actorId:p.actorId};await owner(db,ctx);const state=await policy.requireWorkspaceJob(db,workspaceId,74,'draft'),stop=await policy.stopped(db,workspaceId,state,action,p.automatic,p);if(stop)throw new ValidationError(stop);
 const fresh=await facts(db,ctx,p.recordId,p.connectorId);if(hash(fresh)!==hash(Object.fromEntries(Object.keys(fresh).map(k=>[k,p[k]]))))throw new ValidationError('The quote, customer, confirmation or mailbox changed. Prepare a fresh follow-up.');
 const prior=(await db.query('SELECT recipient,subject,body,connector_id FROM customer_communications WHERE workspace_id=$1 AND idempotency_key=$2',[workspaceId,'quote-followup:'+p.recordId])).rows[0],words=compose(fresh);
 if(prior&&(prior.recipient!==fresh.recipient||prior.connector_id!==fresh.connectorId||prior.subject!==words.subject||prior.body!==words.body))throw new ValidationError('An earlier follow-up uses different details. Review its delivery before sending another message.');
 if(p.automatic){
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)throw new ValidationError('Automatic quotation follow-ups are paused.');
  const trained=state.plan!=='growth'||await require('../autopilot/draft-authority').trained(db,workspaceId,action,fresh);policy.requireJob(state.plan,74,'automatic',{trained});
  const rule=(await db.query('SELECT r.maximum_minor,u.role FROM stockchief_runtime.agent_draft_rules r LEFT JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by WHERE r.workspace_id=$1 AND r.action_type=$2 AND r.scope_key=$3 AND r.currency=$4',[workspaceId,action,fresh.training.key,fresh.currency])).rows[0];
  if(rule&&(rule.role!=='owner'||Number(rule.maximum_minor)<fresh.totalMinor))throw new ValidationError('This quotation is outside the owner’s taught follow-up limit. Approve it individually.');
  if(p.scheduled){
   const row=(await db.query('SELECT *,due_on::text due_date FROM '+relation+' WHERE workspace_id=$1 AND quote_id=$2',[workspaceId,p.recordId])).rows[0],today=await require('../lib/business-time').today(db,workspaceId);
   if(!row||!row.schedule_enabled||row.revision!==p.scheduleRevision||row.scheduled_by!==p.actorId||row.connector_id!==p.connectorId||row.mailbox_account!==p.mailboxAccount||row.provider_type!==p.providerType||row.recipient!==p.recipient||row.due_date>today)throw new ValidationError('The owner’s quotation follow-up date or sending authority changed. Review the current schedule.');
  }
 }
 return fresh;
}
async function queue(db,ctx,p){
 await authority(db,ctx.workspaceId,p);const key='quote-followup:'+p.recordId,words=compose(p),old=(await db.query(`SELECT m.*,e.id effect_id,e.payload FROM customer_communications m LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' WHERE m.workspace_id=$1 AND m.idempotency_key=$2`,[ctx.workspaceId,key])).rows[0];
 if(old){
  if(old.status==='FAILED'||!old.effect_id)throw new ValidationError('Review the earlier follow-up and its delivery before trying again.');
  if(old.status!=='SENT'&&old.payload?.standingAuthority?.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('The earlier queued follow-up uses a different confirmation or schedule. Review its delivery.');
  return {communicationId:old.id,communicationKind:'customer',effectId:old.effect_id,quoteId:p.recordId,status:old.status,replayed:true,automatic:p.automatic};
 }
 const r=await require('../connections/postgres-outbound-mail').queueInTransaction(db,ctx,{recipientKind:'customer',recipientId:p.customerId,recipientEmail:p.recipient,connectorId:p.connectorId,...words,standingAuthority:p},key,{agentRequested:true,agentJob:74});return {...r,quoteId:p.recordId,automatic:p.automatic};
}
async function build(db,ctx,row,args){const box=await require('../connections/postgres-outbound-mail').resolveMailbox(db,ctx.workspaceId,args.mailbox);if(!box.row)throw new ValidationError('Choose the exact connected sending mailbox.');const p=await facts(db,ctx,row.id,box.row.id);return {payload:p,summary:'Follow up with '+p.customerName+' ('+p.recipient+') about '+p.quoteNumber+': '+money.format(p.totalMinor,p.currency)+', valid through '+p.validUntil+'. This sends one message and does not change the quoted terms or create an order.'};}
async function execute(db,ctx,p){return queue(db,ctx,{...p,kind,actorId:ctx.actorId,automatic:ctx.agentQuoteFollowupScope==='automatic',scheduled:false});}
async function confirmedExample(db,workspaceId,p){return p.result?.automatic!==true&&p.result?.replayed!==true&&Boolean((await db.query(`SELECT 1 FROM customer_communications m JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED' WHERE m.workspace_id=$1 AND m.id=$2 AND m.customer_id=$3 AND m.status='SENT' AND m.external_message_id IS NOT NULL AND e.payload->'standingAuthority'->>'kind'=$4 AND e.payload->'standingAuthority'->>'automatic'='false' AND e.payload->'standingAuthority'->>'sourceFingerprint'=$5`,[workspaceId,p.result?.communicationId||'',p.payload.customerId,kind,p.payload.sourceFingerprint])).rowCount);}
async function configure(db,ctx,id,input){
 const revision=Number(input.revision);if(!Number.isSafeInteger(revision)||revision<1)throw new ValidationError('Record and reload the customer’s actual quote receipt before scheduling a follow-up.');
 return db.transaction(async c=>{
  await owner(c,ctx);const row=(await c.query('SELECT * FROM '+relation+' WHERE workspace_id=$1 AND quote_id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];if(!row||row.revision!==revision)throw new ValidationError('This confirmation or schedule changed. Reload before saving.');
  // A follow-up the owner stops is not scheduled again by the default delay (job 74).
  if(input.remove==='1'){await c.query('UPDATE '+relation+' SET schedule_enabled=0,revision=revision+1,problem=NULL,retry_after=NULL,updated_at=now()'+(await has(c,relation,'default_off')?',default_off=true':'')+' WHERE workspace_id=$1 AND quote_id=$2',[ctx.workspaceId,id]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Scheduled quote follow-up stopped',reference:id});return;}
  const days=Number(input.days);if(!/^\d{1,3}$/.test(String(input.days))||days<1||days>365)throw new ValidationError('Choose one to 365 days after the quotation was shared.');
  const p=await facts(c,ctx,id,input.connectorId),state=await policy.requireWorkspaceJob(c,ctx.workspaceId,74,'draft'),stop=await policy.stopped(c,ctx.workspaceId,state,action,true,p);if(stop)throw new ValidationError(stop);
  if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Enable routine work before scheduling this follow-up.');
  const trained=state.plan!=='growth'||await require('../autopilot/draft-authority').trained(c,ctx.workspaceId,action,p);policy.requireJob(state.plan,74,'automatic',{trained});
  const rule=(await c.query('SELECT maximum_minor FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3 AND currency=$4',[ctx.workspaceId,action,p.training.key,p.currency])).rows[0];if(rule&&Number(rule.maximum_minor)<p.totalMinor)throw new ValidationError('This quotation exceeds the owner’s taught follow-up limit. Review it individually.');
  const due=require('../accounting/customer-money').addDays(p.presentedOn,days);if(due>p.validUntil)throw new ValidationError('Choose a follow-up date on or before this quote expires. StockChief cannot extend the quoted terms.');
  if((await c.query('SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND idempotency_key=$2',[ctx.workspaceId,'quote-followup:'+id])).rowCount)throw new ValidationError('This quote already has a follow-up message. Review its delivery.');
  await c.query('UPDATE '+relation+' SET schedule_enabled=1,connector_id=$3,mailbox_account=$4,provider_type=$5,followup_days=$6,due_on=$7,scheduled_by=$8,revision=revision+1,problem=NULL,retry_after=NULL,updated_at=now() WHERE workspace_id=$1 AND quote_id=$2',[ctx.workspaceId,id,p.connectorId,p.mailboxAccount,p.providerType,days,due,ctx.actorId]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'One quote follow-up scheduled',reference:p.quoteNumber,after:{days,due,recipient:p.recipient}});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
// Job 74: the owner's default delay. Every quote emailed through a connected
// mailbox gets one follow-up that many days after the mailbox confirmed it,
// from the same mailbox, under the same checks as a follow-up the owner
// schedules by hand. One the plan, mode or taught scope does not allow waits
// in Needs you with the reason; the owner can still send it from its page.
async function defaults(db,workspaceId){
 const result={scheduled:0,waiting:0};
 if(!await has(db,'stockchief_runtime.agent_quote_settings')||!await has(db,relation,'default_off'))return result;
 const s=(await db.query('SELECT followup_days,authorized_by FROM stockchief_runtime.agent_quote_settings WHERE workspace_id=$1 AND followup_days IS NOT NULL',[workspaceId])).rows[0];if(!s)return result;
 const state=await policy.accountState(db,workspaceId);if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,74,'draft'))return result;
 const today=await require('../lib/business-time').today(db,workspaceId);
 const rows=(await db.query(`SELECT r.quote_id,r.revision FROM ${relation} r JOIN sales_quotations q ON q.workspace_id=r.workspace_id AND q.id=r.quote_id
  WHERE r.workspace_id=$1 AND r.schedule_enabled=0 AND r.presentation_basis='mailbox_accepted' AND NOT r.default_off AND r.presented_on+$3::integer<=$2::date
   AND q.status='OPEN' AND q.valid_until>=$2::date AND (r.retry_after IS NULL OR r.retry_after<=now())
   AND NOT EXISTS(SELECT 1 FROM customer_communications m WHERE m.workspace_id=r.workspace_id AND m.idempotency_key='quote-followup:'||r.quote_id)
  ORDER BY r.presented_on,r.quote_id LIMIT 20`,[workspaceId,today,s.followup_days])).rows;
 for(const selected of rows){const status=await db.transaction(async c=>{
  const r=(await c.query('SELECT * FROM '+relation+' WHERE workspace_id=$1 AND quote_id=$2 FOR UPDATE SKIP LOCKED',[workspaceId,selected.quote_id])).rows[0];if(!r||r.revision!==selected.revision||r.schedule_enabled||r.default_off)return null;
  await c.query('SAVEPOINT quote_followup_default');try{
   const ctx={workspaceId,actorId:s.authorized_by},email=(await c.query('SELECT connector_id FROM customer_communications WHERE workspace_id=$1 AND id=$2',[workspaceId,r.presentation_email_id])).rows[0];
   const p=await facts(c,ctx,r.quote_id,email?.connector_id),account=await policy.requireWorkspaceJob(c,workspaceId,74,'draft'),stop=await policy.stopped(c,workspaceId,account,action,true,p);if(stop)throw new ValidationError(stop);
   if(!(await require('../autopilot/postgres-service').getState(c,workspaceId)).canAutomate)throw new ValidationError('StockChief is set to ask you first. Send this follow-up from its page.');
   const trained=account.plan!=='growth'||await require('../autopilot/draft-authority').trained(c,workspaceId,action,p);policy.requireJob(account.plan,74,'automatic',{trained});
   const rule=(await c.query('SELECT maximum_minor FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3 AND currency=$4',[workspaceId,action,p.training.key,p.currency])).rows[0];if(rule&&Number(rule.maximum_minor)<p.totalMinor)throw new ValidationError('This quotation is over your taught follow-up limit. Send this follow-up from its page.');
   const due=require('../accounting/customer-money').addDays(p.presentedOn,s.followup_days);if(due>p.validUntil)throw new ValidationError('The quote expires before your follow-up delay ends.');
   await c.query(`UPDATE ${relation} SET schedule_enabled=1,connector_id=$3,mailbox_account=$4,provider_type=$5,followup_days=$6,due_on=$7,scheduled_by=$8,revision=revision+1,problem=NULL,retry_after=NULL,updated_at=now() WHERE workspace_id=$1 AND quote_id=$2`,
    [workspaceId,r.quote_id,p.connectorId,p.mailboxAccount,p.providerType,s.followup_days,due,s.authorized_by]);
   await require('../operations/postgres-security-audit').record(c,ctx,{action:'Quote follow-up scheduled from your default delay',reference:p.quoteNumber,after:{days:s.followup_days,due,recipient:p.recipient}});
   await c.query('RELEASE SAVEPOINT quote_followup_default');return 'scheduled';
  }catch(error){if(!['validation_error','forbidden','entitlement_required'].includes(error.code))throw error;await c.query('ROLLBACK TO SAVEPOINT quote_followup_default');await c.query('RELEASE SAVEPOINT quote_followup_default');
   await c.query('UPDATE '+relation+" SET problem=$3,retry_after=now()+interval '15 minutes',updated_at=now() WHERE workspace_id=$1 AND quote_id=$2",[workspaceId,r.quote_id,error.message]);return 'waiting';}
 },{isolation:'SERIALIZABLE',retrySafe:true});if(status)result[status]++;}
 return result;
}
async function run(db,workspaceId){
 const result={queued:0,held:0},defaulted=await defaults(db,workspaceId);if(defaulted.scheduled)result.scheduled=defaulted.scheduled;if(defaulted.waiting)result.waiting=defaulted.waiting;
 if(!(await db.query('SELECT 1 FROM '+relation+' WHERE workspace_id=$1 AND schedule_enabled=1 LIMIT 1',[workspaceId])).rowCount)return result;
 const state=await policy.accountState(db,workspaceId);if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,74,'automatic',{trained:true})||!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate||await require('../autopilot/job-modes').restriction(db,workspaceId,74,true))return result;
 const today=await require('../lib/business-time').today(db,workspaceId),rows=(await db.query(`SELECT quote_id,revision FROM ${relation} r WHERE workspace_id=$1 AND schedule_enabled=1 AND due_on<=$2 AND (retry_after IS NULL OR retry_after<=now()) AND NOT EXISTS(SELECT 1 FROM customer_communications m WHERE m.workspace_id=r.workspace_id AND m.idempotency_key='quote-followup:'||r.quote_id) ORDER BY due_on,quote_id LIMIT 20`,[workspaceId,today])).rows;
 for(const selected of rows){const status=await db.transaction(async c=>{
  const r=(await c.query('SELECT * FROM '+relation+' WHERE workspace_id=$1 AND quote_id=$2 FOR UPDATE SKIP LOCKED',[workspaceId,selected.quote_id])).rows[0];if(!r||r.revision!==selected.revision||!r.schedule_enabled)return null;
  await c.query('SAVEPOINT quote_followup_queue');try{
   const ctx={workspaceId,actorId:r.scheduled_by},p={...await facts(c,ctx,r.quote_id,r.connector_id),kind,actorId:r.scheduled_by,automatic:true,scheduled:true,scheduleRevision:r.revision};
   const sent=await queue(c,ctx,p);await c.query('RELEASE SAVEPOINT quote_followup_queue');return sent.replayed?null:'queued';
  }catch(error){if(!['validation_error','forbidden','entitlement_required'].includes(error.code))throw error;await c.query('ROLLBACK TO SAVEPOINT quote_followup_queue');await c.query('RELEASE SAVEPOINT quote_followup_queue');await c.query('UPDATE '+relation+" SET problem=$3,retry_after=now()+interval '15 minutes',updated_at=now() WHERE workspace_id=$1 AND quote_id=$2",[workspaceId,r.quote_id,error.message]);return 'held';}
 },{isolation:'SERIALIZABLE',retrySafe:true});if(status)result[status]++;}
 return result;
}
async function page(db,ctx,id){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,74,'draft');
 const q=await require('./postgres-quotes').get(db,ctx.workspaceId,id),record=(await db.query('SELECT *,presented_on::text presented_date,due_on::text due_date FROM '+relation+' WHERE workspace_id=$1 AND quote_id=$2',[ctx.workspaceId,id])).rows[0],state=await policy.accountState(db,ctx.workspaceId);
 let quoteHold=null;try{await quote(db,ctx,id);if(record?.presentation_basis==='mailbox_accepted')await sentEvidence(db,ctx.workspaceId,record);}catch(error){if(error.code!=='validation_error')throw error;quoteHold=error.message;}
 const routineBlocked=(await policy.stopped(db,ctx.workspaceId,state,action,true))||((await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate?null:'Enable routine work before scheduling a quotation follow-up.');
 return {quotation:q,record,quoteHold,routineBlocked,today:await require('../lib/business-time').today(db,ctx.workspaceId),formKey:require('../lib/util').newId('quote-confirmation'),mailboxes:await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId),message:(await db.query('SELECT id,status,error_message,sent_at FROM customer_communications WHERE workspace_id=$1 AND idempotency_key=$2',[ctx.workspaceId,'quote-followup:'+id])).rows[0],blocked:await policy.stopped(db,ctx.workspaceId,state,action,false)};
}
async function review(db,ctx,{page=1,filter=''}){
 const rows=(await db.query(`SELECT q.quote_number "Quote",c.name "Customer",q.valid_until::text "Valid through",q.pricing->>'currency' currency,q.pricing->>'totalMinor' total_minor,r.presented_on::text "Quotation shared on",r.due_on::text "Follow-up due",coalesce(m.status,CASE WHEN r.schedule_enabled=1 THEN 'Scheduled' WHEN r.presentation_basis='mailbox_accepted' THEN 'Quotation email sent' WHEN r.quote_id IS NOT NULL THEN 'Customer receipt recorded' ELSE 'Email quote or confirm customer receipt' END) "Follow-up",r.problem "Needs review",'/autopilot/quote-followups/'||q.id link FROM sales_quotations q JOIN customers c ON c.workspace_id=q.workspace_id AND c.id=q.customer_id LEFT JOIN ${relation} r ON r.workspace_id=q.workspace_id AND r.quote_id=q.id LEFT JOIN customer_communications m ON m.workspace_id=q.workspace_id AND m.idempotency_key='quote-followup:'||q.id WHERE q.workspace_id=$1 AND q.status='OPEN' AND ($2='' OR lower(q.quote_number)=lower($2) OR lower(c.name)=lower($2)) ORDER BY q.created_at DESC,q.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 const settings=await require('./agent-quote-requests').settings(db,ctx.workspaceId),state=await policy.accountState(db,ctx.workspaceId);
 return {summary:'Email a saved quotation through your connected mailbox, or record when the customer actually received it through another channel. Then prepare one follow-up or choose its delay. Choose a number of days below and every quote emailed through your mailbox is followed up that many days after it was sent. A mailbox-confirmed send does not establish that the customer read it. StockChief sends only within the current quote, plan and owner authority; acceptance, a newer revision, expiry or changed contact stops the message.',rows:rows.slice(0,100).map(({currency,total_minor,...r})=>({...r,Total:money.format(total_minor,currency)})),more:rows.length>100,
  quoteFollowupDefaults:{days:settings?.followup_days??'',revision:settings?.revision||0,growth:state.plan==='growth',available:await has(db,'stockchief_runtime.agent_quote_settings')}};
}
// Needs you: follow-ups StockChief could not send on its own, with the reason.
async function inbox(db,workspaceId){
 const rows=(await db.query(`SELECT r.quote_id,r.problem,r.updated_at,q.quote_number,c.name customer_name FROM ${relation} r JOIN sales_quotations q ON q.workspace_id=r.workspace_id AND q.id=r.quote_id
  JOIN customers c ON c.workspace_id=q.workspace_id AND c.id=q.customer_id WHERE r.workspace_id=$1 AND r.problem IS NOT NULL AND q.status='OPEN'
  AND NOT EXISTS(SELECT 1 FROM customer_communications m WHERE m.workspace_id=r.workspace_id AND m.idempotency_key='quote-followup:'||r.quote_id)
  ORDER BY r.updated_at DESC,r.quote_id LIMIT 20`,[workspaceId])).rows;
 return rows.map(r=>({kind:'sales',importance:'Needs You',priority:72,title:'Follow-up for '+r.quote_number+' needs you',
  happened:'StockChief did not follow up with '+r.customer_name+' about '+r.quote_number+' on its own. Nothing was sent.',why:r.problem,
  recommendation:'Open the quote follow-up and send it yourself, or stop it.',href:'/autopilot/quote-followups/'+encodeURIComponent(r.quote_id),actionLabel:'Review follow-up',
  sourceId:'quote-followup:'+r.quote_id,createdAt:r.updated_at,timeLabel:'Due',at:r.updated_at}));
}
module.exports={record,configure,page,run,defaults,inbox,facts,compose,authority,confirmedExample,definition:{id:74,key:'quote-followups',label:'Follow up on customer quotations',filterLabel:'Quote number or exact customer',readPage:review},spec:{name:action,agentJob:74,record:'sales_quotation',fields:['recordReference','mailbox'],permission:P.MANAGE_SALES,ownerOnly:true,capability:'connection.email',completionGate:'provider_effect_succeeded',resultingRecords:['customer_communications','stockchief_runtime.provider_effects'],description:'Follow up once on an exact open, unexpired quotation after the owner records that the customer received its saved terms. Use an exact quote and connected mailbox. Does not change terms, accept the quotation, create an order, reserve goods or collect money.',build,execute,verify:async(db,ctx,r,p)=>Boolean((await db.query("SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND id=$2 AND customer_id=$3 AND idempotency_key=$4 AND status IN ('QUEUED','SENDING','SENT')",[ctx.workspaceId,r.communicationId,p.customerId,'quote-followup:'+p.recordId])).rowCount)}};

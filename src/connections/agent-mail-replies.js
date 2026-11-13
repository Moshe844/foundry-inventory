'use strict';
// Job 187: StockChief reads your Gmail or Outlook mail and drafts replies.
//
// Drafting already happens when a known customer or supplier writes (the
// mailbox's reply preparation, checked against your records). This decides
// what happens to each prepared reply:
//  - Starter: not included.
//  - Growth: the reply waits for a person to read and send it.
//  - Pro and Custom: the reply is sent on its own, within the owner's rules,
//    from the mailbox the email came to and in the same conversation.
// Always kept for a person: a sender who is not exactly one customer or
// supplier; the first time StockChief would write to someone; anything on page
// 13's list, money (prices, payments, invoices, refunds, credit) or a
// commitment (dates, cancelling, accepting, agreeing, goods arriving); an
// unclear conversation (no thread, someone else in it, a newer email, or the
// same email in two mailboxes); attachments; email another StockChief job reads
// (job 72 answers stock, delivery and order questions itself, so this job
// leaves those alone); and two connected mailboxes with no choice made.
// Pause, Watch only and the first 14 days only record it; Ask me first keeps
// it for approval. The send is checked again at the mailbox.
const crypto=require('node:crypto');
const policy=require('../commercial/agent-plan');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {has}=require('../db/schema-installed');

const JOB=187,TABLE='stockchief_runtime.agent_mail_replies',SETTINGS='stockchief_runtime.agent_mail_reply_settings';
const KIND='mail.agent-reply.v1',key='mail-replies',path='/autopilot/reviews/'+key;
const tx=(db,work)=>db.transaction(work,{isolation:'SERIALIZABLE',retrySafe:true});
const audit=(c,ctx,entry)=>require('../operations/postgres-security-audit').record(c,ctx,entry);
const digest=m=>require('./postgres-reply-drafting').draftDigest(m);
const expected=error=>[400,402,403,404,409,422].includes(error?.status);

// Mail other StockChief jobs read; the reply to it is theirs or a person's.
const OWN_JOBS=new Set(['mail.reply-draft',KIND,'mail.attachment-extract']);
const QUESTIONS='mail.customer-question.v1';
const MONEY=/[$€£¥]\s?\d|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|cad|aud|nzd|chf|dollars?|euros?|pounds?)\b|\b(?:usd|eur|gbp|cad|aud|nzd|chf)\s?\d|\b(?:pay|paid|paying|payments?|refunds?|refunded|invoices?|credits?|credited|deposits?|charges?|charged|fees?|prices?|pricing|priced|discounts?|rebates?|owe|owed|owing|balance|costs?|quotes?|quotation|terms)\b/i;
const COMMITMENT=/\b(?:guarantee[ds]?|promise[ds]?|commit(?:ted|ment)?|agree[ds]?|accept(?:ed|s)?|approve[ds]?|cancel(?:led|ed|s|lation)?|credit limit|write[- ]?offs?|written off|arrived|received (?:the|your|our) (?:goods|order|delivery|shipment|parcel|package|pallets?|items?|stock)|new (?:ship(?:ping)?[- ]to )?address|ship[- ]to|deliver(?:ed)? to|will (?:ship|deliver|send|dispatch|arrive|be (?:shipped|delivered|sent|there|ready|with you))|(?:by|on|before|until) (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|tonight|next week|the end of)|\d{4}-\d{2}-\d{2})\b/i;
const own=body=>require('../accounting/statement-request').own(body);

async function owner(db,ctx){
  const row=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the inventory owner can choose how StockChief replies to email.');
}

async function settingsOf(db,workspaceId){
  if(!await has(db,SETTINGS))return null;
  return (await db.query(`SELECT * FROM ${SETTINGS} WHERE workspace_id=$1`,[workspaceId])).rows[0]||null;
}

// Called when a reply has been prepared and saved (inside that transaction).
async function queueAfterDraft(client,workspaceId,messageId,draft){
  const state=await policy.accountState(client,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return false;
  const scoped={query:(sql,values)=>client.query(sql,values),transaction:work=>work(client)};
  await require('../operations/postgres-job-queue').enqueue(scoped,{workspaceId,kind:KIND,idempotencyKey:'agent-reply:'+messageId+':'+draft.slice(0,24),payload:{messageId},priority:55,maxAttempts:3});
  return true;
}

// Exactly one active customer or supplier wrote this.
async function contactFor(db,workspaceId,m){
  if(m.trust_status!=='TRUSTED'||!['customer','supplier'].includes(m.classification))return null;
  const customers=(await db.query("SELECT id,name FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' AND lower(email)=lower($2) ORDER BY id LIMIT 2",[workspaceId,m.sender])).rows;
  const suppliers=(await db.query("SELECT id,name FROM suppliers WHERE workspace_id=$1 AND status='active' AND (id=$2 OR lower(email)=lower($3)) ORDER BY id LIMIT 2",[workspaceId,m.supplier_id||'',m.sender])).rows;
  if(customers.length+suppliers.length!==1)return null;
  return customers.length?{kind:'customer',...customers[0]}:{kind:'supplier',...suppliers[0]};
}

// Has StockChief or the business written to this contact before?
async function known(db,workspaceId,contact,sender){
  const wrote=(await db.query(`SELECT EXISTS(SELECT 1 FROM stockchief_runtime.email_reply_outbox WHERE workspace_id=$1 AND lower(recipient)=lower($2) AND status='SENT') ok`,[workspaceId,sender])).rows[0].ok;
  if(wrote)return true;
  if(contact.kind==='customer')return (await db.query(`SELECT EXISTS(SELECT 1 FROM sales_orders WHERE workspace_id=$1 AND customer_id=$2 AND status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED'))
    OR EXISTS(SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND customer_id=$2 AND status='SENT' AND external_message_id IS NOT NULL) ok`,[workspaceId,contact.id])).rows[0].ok;
  return (await db.query(`SELECT EXISTS(SELECT 1 FROM purchase_orders WHERE workspace_id=$1 AND supplier_id=$2 AND status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED'))
    OR EXISTS(SELECT 1 FROM supplier_communications WHERE workspace_id=$1 AND supplier_id=$2 AND status='SENT') ok`,[workspaceId,contact.id])).rows[0].ok;
}

// Whether StockChief may act at all, and whether it only watches.
async function decide(db,workspaceId){
  const state=await policy.accountState(db,workspaceId),plan=policy.usesAgentTerms(state)?state.plan:null;
  if(!plan||!policy.permits(plan,JOB,'draft'))return {mode:'skip',state};
  if(state.shadow)return {mode:'watch',state,reason:'StockChief is watching during its first 14 days and did not send this reply.'};
  const autopilot=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(autopilot.mode==='OBSERVE')return {mode:'watch',state,reason:'StockChief is set to Watch only and did not send this reply.'};
  if(autopilot.paused||autopilot.suspended)return {mode:'watch',state,reason:'Automatic work is paused, so StockChief did not send this reply.'};
  const watch=await require('../autopilot/job-modes').restriction(db,workspaceId,JOB,false);
  if(watch)return {mode:'watch',state,reason:watch};
  return {mode:'prepare',state,autopilot};
}

// The outcome for one prepared reply: SKIP, HELD (stops and asks), WATCHED,
// DRAFTED (kept for a person) or SEND. `sending` names our own outbox row when
// checked again at the mailbox.
async function evaluate(db,workspaceId,m,{sending=null}={}){
  if(!m||m.reply_sent_at||m.reply_state!=='NEEDS_REPLY')return {status:'SKIP',reason:'Someone already answered or filed this email.'};
  if(m.draft_source!=='model'||!m.draft_body||!m.draft_subject)return {status:'SKIP',reason:'There is no reply prepared by StockChief.'};
  const outbox=(await db.query(`SELECT 1 FROM stockchief_runtime.email_reply_outbox WHERE workspace_id=$1 AND message_id=$2 AND status IN ('PENDING','SENDING','SENT','AMBIGUOUS') AND id IS DISTINCT FROM $3 LIMIT 1`,
    [workspaceId,m.id,sending])).rowCount;
  if(outbox)return {status:'SKIP',reason:'A reply to this email is already on its way.'};
  // Job 72 answers customer questions about stock, delivery and orders itself.
  const answered=await has(db,'stockchief_runtime.agent_customer_questions')&&(await db.query('SELECT 1 FROM stockchief_runtime.agent_customer_questions WHERE workspace_id=$1 AND message_id=$2',[workspaceId,m.id])).rowCount;
  const jobs=(await db.query(`SELECT DISTINCT kind FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND payload->>'messageId'=$2`,[workspaceId,m.id])).rows.map(r=>r.kind);
  if(answered||jobs.includes(QUESTIONS))return {status:'SKIP',reason:'StockChief answers this customer question from the records (job 72).'};
  const decision=await decide(db,workspaceId);
  if(decision.mode==='skip')return {status:'SKIP',reason:'Replies need the Growth plan or above.'};
  const base={digest:digest(m)};
  const contact=await contactFor(db,workspaceId,m);
  if(!contact)return {...base,status:'HELD',reason:'StockChief does not know '+m.sender+' as exactly one of your customers or suppliers, so a person answers.'};
  const who={...base,contact};
  const other=jobs.filter(k=>!OWN_JOBS.has(k)&&!k.startsWith('provider-effect'));
  if(other.length||m.agent_category&&['order','invoice','delivery'].includes(m.agent_category))
    return {...who,status:'HELD',reason:'This email is '+({order:'an order',invoice:'an invoice',delivery:'a delivery document'}[m.agent_category]||'being read by another StockChief job')+', so a person sends the reply.'};
  if((await db.query('SELECT 1 FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2 LIMIT 1',[workspaceId,m.id])).rowCount)
    return {...who,status:'HELD',reason:'The email has attachments, so a person reads them and sends the reply.'};
  const incoming=String(m.subject||'')+'\n'+own(m.body_text),reply=m.draft_subject+'\n'+m.draft_body;
  if(MONEY.test(incoming)||MONEY.test(reply))return {...who,status:'HELD',reason:'The email or the reply is about money (prices, payments, invoices, refunds or credit). A person answers that.'};
  if(COMMITMENT.test(incoming)||COMMITMENT.test(reply))return {...who,status:'HELD',reason:'The email or the reply makes or asks for a commitment (a date, a change, a cancellation, an agreement or goods arriving). A person answers that.'};
  const facts=await require('./postgres-reply-drafting').factsFor(db,workspaceId,m);
  const fault=require('./reply-drafting').faultIn({subject:m.draft_subject,body:m.draft_body},m,facts);
  if(fault)return {...who,status:'HELD',reason:'The prepared reply no longer matches your records: '+fault+'.'};
  // One clear conversation, in one mailbox.
  if(!m.external_thread_id)return {...who,status:'HELD',reason:'The email has no conversation thread, so StockChief cannot reply in the same conversation.'};
  const thread=(await db.query(`SELECT count(DISTINCT lower(sender))::int senders,count(*) FILTER (WHERE id<>$4 AND (received_at>$5 OR received_at=$5 AND id>$4))::int newer
    FROM connection_email_messages WHERE workspace_id=$1 AND connector_id=$2 AND external_thread_id=$3`,[workspaceId,m.connector_id,m.external_thread_id,m.id,m.received_at])).rows[0];
  if(thread.senders>1)return {...who,status:'HELD',reason:'More than one person wrote in this conversation, so a person answers.'};
  if(thread.newer)return {...who,status:'HELD',reason:'A newer email arrived in this conversation, so StockChief does not answer this one on its own.'};
  if(m.internet_message_id&&(await db.query('SELECT 1 FROM connection_email_messages WHERE workspace_id=$1 AND internet_message_id=$2 AND connector_id<>$3 LIMIT 1',[workspaceId,m.internet_message_id,m.connector_id])).rowCount)
    return {...who,status:'HELD',reason:'This email arrived in more than one of your mailboxes, so a person chooses where to answer it.'};
  if(!await known(db,workspaceId,contact,m.sender))return {...who,status:'HELD',reason:'This is the first time StockChief would write to '+contact.name+', so a person sends it.'};
  if(decision.mode==='watch')return {...who,status:'WATCHED',reason:decision.reason+' It would have replied to '+contact.name+'.'};
  // The owner's rules for replies sent on their own.
  if(policy.allowance(decision.state.plan,JOB)==='draft')return {...who,status:'DRAFTED',reason:'Your plan keeps replies for you to read and send.'};
  const settings=await settingsOf(db,workspaceId);
  if(settings&&!settings[contact.kind+'s'])return {...who,status:'DRAFTED',reason:'You keep replies to '+contact.kind+'s for yourself.'};
  const box=await require('./agent-sending-mailbox').resolve(db,workspaceId,settings?.connector_id||null,'replies');
  if(box.reason)return {...who,status:'HELD',reason:box.problem==='mailbox_choice'
    ?'You have '+box.boxes.length+' mailboxes connected. Choose the one StockChief replies from on its own; it never picks one for you.'
    :settings?.connector_id?'The mailbox you chose for replies is not connected now. Reconnect it or choose another.':'Connect a mailbox so StockChief can reply from it.'};
  if(box.box.id!==m.connector_id){
    const arrived=(await db.query('SELECT display_name FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[workspaceId,m.connector_id])).rows[0]?.display_name||'another mailbox';
    return {...who,status:'DRAFTED',reason:'This email came to '+arrived+'. StockChief sends replies on its own only from '+box.box.display_name+', and a reply always goes from the mailbox the email came to.'};
  }
  if(!decision.autopilot.canAutomate)return {...who,status:'DRAFTED',reason:'StockChief is set to ask you first.'};
  const ask=await require('../autopilot/job-modes').restriction(db,workspaceId,JOB,true);
  if(ask)return {...who,status:'DRAFTED',reason:ask};
  if(!policy.permits(decision.state.plan,JOB,'automatic'))return {...who,status:'DRAFTED',reason:'Your plan asks you to send each reply.'};
  const quota=await require('../commercial/agent-rule-quota').restriction(db,decision.state);
  if(quota)return {...who,status:'DRAFTED',reason:quota};
  return {...who,status:'SEND',box:box.box};
}

async function message(db,workspaceId,id,lock=false){
  return (await db.query(`SELECT * FROM connection_email_messages WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[workspaceId,id])).rows[0]||null;
}

async function record(c,workspaceId,m,f){
  const prior=(await c.query(`SELECT status,reason,draft_digest FROM ${TABLE} WHERE workspace_id=$1 AND message_id=$2 FOR UPDATE`,[workspaceId,m.id])).rows[0];
  await c.query(`INSERT INTO ${TABLE}(workspace_id,message_id,connector_id,sender,contact_kind,contact_id,contact_name,subject,status,reason,draft_digest,outbox_id,automatic)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(workspace_id,message_id) DO UPDATE SET contact_kind=EXCLUDED.contact_kind,contact_id=EXCLUDED.contact_id,
      contact_name=EXCLUDED.contact_name,status=EXCLUDED.status,reason=EXCLUDED.reason,draft_digest=EXCLUDED.draft_digest,outbox_id=coalesce(EXCLUDED.outbox_id,agent_mail_replies.outbox_id),
      automatic=EXCLUDED.automatic,updated_at=clock_timestamp()`,
  [workspaceId,m.id,m.connector_id,m.sender,f.contact?.kind||null,f.contact?.id||null,f.contact?.name||null,m.subject?String(m.subject).slice(0,300):null,f.status,f.reason?String(f.reason).slice(0,500):null,
    f.digest,f.outboxId||null,Boolean(f.automatic)]);
  return !prior||prior.status!==f.status||prior.draft_digest!==f.digest;
}

const ACTION={WATCHED:'Mail reply watched',HELD:'Mail reply stopped for a person',DRAFTED:'Mail reply kept for a person'};
async function keep(db,workspaceId,actorId,m,f){
  await tx(db,async c=>{
    if(await record(c,workspaceId,m,f))await audit(c,{workspaceId,actorId},{action:ACTION[f.status],reference:m.sender,
      after:{messageId:m.id,contact:f.contact?.name||null,status:f.status,reason:f.reason}});
  });
  return {[f.status==='HELD'?'held':f.status==='WATCHED'?'watched':'drafted']:true,reason:f.reason};
}

// Queue the prepared reply as it stands, from the mailbox it came to, in its
// thread. A person's own send later uses its own key, so a refused automatic
// attempt never blocks it.
async function send(db,ctx,m,f){
  return tx(db,async c=>{
    const locked=await message(c,ctx.workspaceId,m.id,true);
    if(!locked||digest(locked)!==f.digest)throw Object.assign(new ValidationError('The email or its reply changed. Nothing was sent.'),{status:409});
    const again=await evaluate(c,ctx.workspaceId,locked);
    if(again.status!=='SEND'||again.digest!==f.digest)throw Object.assign(new ValidationError(again.reason||'The reply can no longer go out on its own.'),{status:409});
    const box=(await c.query('SELECT provider_type FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,locked.connector_id])).rows[0];
    const idempotencyKey=crypto.createHash('sha256').update('agent-187\n'+locked.id+'\n'+locked.draft_subject+'\n'+locked.draft_body).digest('hex');
    const outboxId=require('../lib/util').newId('mailout');
    const started=await c.query(`INSERT INTO stockchief_runtime.email_reply_outbox(id,workspace_id,message_id,connector_id,idempotency_key,recipient,subject,body,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING') ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING id`,
    [outboxId,ctx.workspaceId,locked.id,locked.connector_id,idempotencyKey,locked.sender,locked.draft_subject,locked.draft_body]);
    if(!started.rowCount)throw Object.assign(new ValidationError('StockChief already tried to send this exact reply. A person sends it.'),{status:409});
    const effect=await require('../operations/postgres-provider-effects').enqueueInTransaction(c,{workspaceId:ctx.workspaceId,kind:'mail.reply.send',provider:box.provider_type,
      aggregateType:'email_message',aggregateId:locked.id,idempotencyKey,requestedByUserId:ctx.actorId,
      payload:{outboxId,messageId:locked.id,connectorId:locked.connector_id,actorId:ctx.actorId,agentJob:JOB,automatic:true,draftDigest:f.digest},priority:10,maxAttempts:12});
    await record(c,ctx.workspaceId,locked,{...f,status:'QUEUED',reason:null,outboxId,automatic:true});
    await audit(c,ctx,{action:'Mail reply sent by StockChief',reference:locked.sender,
      after:{messageId:locked.id,contact:f.contact.name,recipient:locked.sender,mailbox:locked.connector_id,threadId:locked.external_thread_id,outboxId,effectId:effect.effect.id,automatic:true}});
    return {queued:true,outboxId,effectId:effect.effect.id};
  });
}

// The worker for a prepared reply. One outcome per draft.
async function fromDraft(db,workspaceId,id){
  if(!await has(db,TABLE))return {skipped:true};
  const m=await message(db,workspaceId,id);
  if(!m)return {skipped:true};
  const prior=(await db.query(`SELECT status,reason,draft_digest FROM ${TABLE} WHERE workspace_id=$1 AND message_id=$2`,[workspaceId,id])).rows[0];
  if(prior&&prior.draft_digest===digest(m)&&m.draft_source==='model')return {replayed:true,status:prior.status,reason:prior.reason};
  const f=await evaluate(db,workspaceId,m);
  if(f.status==='SKIP')return {skipped:true,reason:f.reason};
  const ownerId=await require('../sales/agent-customer-orders').ownerUser(db,workspaceId);
  if(!ownerId)return {skipped:true};
  if(f.status==='SEND'){
    try{return await send(db,{workspaceId,actorId:ownerId},m,f);}
    catch(error){if(!expected(error))throw error;return keep(db,workspaceId,ownerId,m,{...f,status:'HELD',reason:error.message});}
  }
  return keep(db,workspaceId,ownerId,m,f);
}

// Checked again at the mailbox, just before the provider is called.
async function authority(db,workspaceId,input){
  const row=await has(db,TABLE)&&(await db.query(`SELECT status,outbox_id,draft_digest FROM ${TABLE} WHERE workspace_id=$1 AND message_id=$2`,[workspaceId,input.messageId])).rows[0];
  if(!row||row.status!=='QUEUED'||row.outbox_id!==input.outboxId||row.draft_digest!==input.draftDigest)throw Object.assign(new ValidationError('This reply changed after it was queued. Nothing was sent.'),{status:409});
  const f=await evaluate(db,workspaceId,await message(db,workspaceId,input.messageId),{sending:input.outboxId});
  if(f.digest!==input.draftDigest)throw Object.assign(new ValidationError('This reply changed after it was queued. Nothing was sent.'),{status:409});
  if(f.status!=='SEND')throw Object.assign(new ValidationError(f.reason||'This reply can no longer go out on its own. Nothing was sent.'),{status:409});
}

// The mailbox's answer for a reply this job queued.
async function settled(c,workspaceId,input,{status,reason=null}){
  if(input?.agentJob!==JOB||!await has(c,TABLE))return;
  await c.query(`UPDATE ${TABLE} SET status=$4,reason=$5,updated_at=clock_timestamp() WHERE workspace_id=$1 AND message_id=$2 AND outbox_id=$3`,
    [workspaceId,input.messageId,input.outboxId,status,reason?String(reason).slice(0,500):null]);
}

async function saveSettings(db,ctx,input={}){
  return tx(db,async c=>{
    await owner(c,ctx);
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    const connectorId=String(input.connectorId||'').trim()||null;
    if(connectorId&&!(await require('./postgres-outbound-mail').mailboxes(c,ctx.workspaceId)).some(b=>b.id===connectorId))throw new ValidationError('Choose one of your connected mailboxes.');
    const kinds=[].concat(input.kinds||[]),customers=kinds.includes('customer'),suppliers=kinds.includes('supplier');
    const prior=(await c.query(`SELECT * FROM ${SETTINGS} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
    if(prior&&input.revision!=null&&input.revision!==''&&Number(input.revision)!==prior.revision)throw new ValidationError('These settings changed. Reload before saving.');
    if(prior)await c.query(`UPDATE ${SETTINGS} SET connector_id=$2,customers=$3,suppliers=$4,updated_by=$5,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1`,[ctx.workspaceId,connectorId,customers,suppliers,ctx.actorId]);
    else await c.query(`INSERT INTO ${SETTINGS}(workspace_id,connector_id,customers,suppliers,updated_by) VALUES($1,$2,$3,$4,$5)`,[ctx.workspaceId,connectorId,customers,suppliers,ctx.actorId]);
    await audit(c,ctx,{action:'Mail reply settings saved',reference:'Replies sent on their own',
      before:prior?{mailbox:prior.connector_id,customers:prior.customers,suppliers:prior.suppliers}:{},after:{mailbox:connectorId,customers,suppliers}});
  });
}

const OUTCOME={WATCHED:'Watched only',HELD:'Stopped for you',DRAFTED:'Kept for you',QUEUED:'Sending',SENT:'Sent',FAILED:'Not sent'};

// Needs you: replies waiting for a person. They replace the plain "waiting
// for a response" item for the same email.
async function inbox(db,workspaceId){
  if(!await has(db,TABLE))return [];
  const rows=(await db.query(`SELECT r.* FROM ${TABLE} r JOIN connection_email_messages e ON e.workspace_id=r.workspace_id AND e.id=r.message_id
    WHERE r.workspace_id=$1 AND r.status IN ('WATCHED','HELD','DRAFTED','FAILED') AND e.reply_sent_at IS NULL AND e.reply_state='NEEDS_REPLY'
    ORDER BY r.updated_at DESC,r.message_id LIMIT 20`,[workspaceId])).rows;
  return rows.map(r=>{const who=r.contact_name||r.sender;
    return {kind:'mail',importance:'Needs You',priority:r.status==='FAILED'?84:r.status==='WATCHED'?60:82,
      title:r.status==='FAILED'?'Reply to '+who+' was not sent':r.status==='WATCHED'?'StockChief watched a reply to '+who:'Reply ready for '+who,
      happened:who+' wrote'+(r.subject?' “'+r.subject+'”':'')+'. StockChief prepared a reply from your records. Nothing was sent.',
      why:r.reason||'A person decides what to send.',recommendation:'Read the email and the reply, then send it, change it or answer yourself.',
      href:'/mail/'+encodeURIComponent(r.message_id),actionLabel:'Review reply',sourceId:'mail-reply:'+r.message_id,createdAt:r.updated_at,timeLabel:'Prepared',at:r.updated_at};});
}

async function review(db,ctx,{page=1,filter=''}={}){
  const state=await policy.accountState(db,ctx.workspaceId),plan=policy.usesAgentTerms(state)?state.plan:null;
  const alone=Boolean(plan)&&policy.permits(plan,JOB,'automatic');
  const summary='StockChief prepares replies to email from your customers and suppliers, from your records. '+
    (alone?'On your plan it sends them on its own, from the mailbox the email came to and in the same conversation, within the rules below.':'On your plan every reply waits for you to read and send it.')+
    ' Unknown senders, money, commitments, first emails to someone and unclear conversations always wait for you.';
  if(!await has(db,TABLE))return {summary:'Replies are being upgraded. Try again shortly.',rows:[],more:false};
  const rows=(await db.query(`SELECT * FROM ${TABLE} WHERE workspace_id=$1 AND ($3='' OR lower(sender)=lower($3) OR lower(coalesce(contact_name,''))=lower($3) OR strpos(lower(coalesce(subject,'')),lower($3))>0)
    ORDER BY updated_at DESC,message_id LIMIT 101 OFFSET $2`,[ctx.workspaceId,(Math.max(1,Number(page)||1)-1)*100,String(filter||'').trim()])).rows;
  const settings=await settingsOf(db,ctx.workspaceId);
  const boxes=await require('./postgres-outbound-mail').mailboxes(db,ctx.workspaceId);
  return {summary,more:rows.length>100,
    rows:rows.slice(0,100).map(r=>({From:r.contact_name||r.sender,Subject:r.subject||'(No subject)',Outcome:OUTCOME[r.status]+(r.automatic&&['QUEUED','SENT'].includes(r.status)?' by StockChief':''),Why:r.reason||'',link:'/mail/'+encodeURIComponent(r.message_id)})),
    mailReplyForm:alone?{revision:settings?.revision??'',connectorId:settings?.connector_id||'',customers:settings?settings.customers:true,suppliers:settings?settings.suppliers:true,
      mailboxes:boxes.map(b=>({id:b.id,name:b.display_name})),needsChoice:boxes.length>1&&!settings?.connector_id}:null};
}

module.exports={JOB,KIND,path,queueAfterDraft,evaluate,fromDraft,authority,settled,saveSettings,inbox,review,MONEY,COMMITMENT,
  definition:{id:JOB,key,label:'Reply to customer and supplier email',filterLabel:'Sender, customer or supplier, or words in the subject',readPage:review}};

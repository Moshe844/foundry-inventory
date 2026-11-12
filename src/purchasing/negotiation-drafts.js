'use strict';
// Job 94: "Drafts a negotiation email with your data ('you were late 6 times')."
// The email is built from recorded facts, each linked to its evidence
// (negotiation-evidence). Pro drafts it for the owner to edit and send.
// Custom drafts too until the owner teaches a supplier rule; then it sends
// the routine "please confirm your lead times" note on its own on the rule's
// schedule. Sending always goes through the outbound mail queue, and nothing
// here orders, accepts or changes a price.
const policy=require('../commercial/agent-plan'),evidence=require('./negotiation-evidence');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util'),{hash}=require('../pricing/postgres-promotions'),{addDays}=require('../accounting/customer-money');
const action='supplier.negotiation_draft',mailKind='supplier_negotiation',drafts='stockchief_runtime.agent_negotiation_drafts',rules='stockchief_runtime.supplier_negotiation_rules';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const held=e=>[400,402,403,404,409,422].includes(e?.status)||['validation_error','entitlement_required','forbidden','not_found'].includes(e?.code);
const bodyHash=m=>hash({subject:m.subject,body:m.body});
const emailOk=v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v||''));

async function owner(c,ctx){
 if(!(await c.query("SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner'",[ctx.workspaceId,ctx.actorId])).rowCount)
  throw new AuthorizationError('The inventory owner must review the supplier negotiation.');
}
async function setting(c,workspaceId,supplier){
 return (await c.query('SELECT * FROM '+rules+' WHERE workspace_id=$1 AND supplier_id=$2',[workspaceId,supplier])).rows[0];
}
async function draft(c,ctx,id,lock=false){
 const d=(await c.query(`SELECT d.*,d.period_from::text AS from_day,d.period_to::text AS to_day,m.subject,m.body,m.status,m.recipient,m.connector_id,m.idempotency_key,m.error_message,m.sent_at,s.name AS supplier_name,s.email AS supplier_email
  FROM ${drafts} d JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id JOIN suppliers s ON s.workspace_id=d.workspace_id AND s.id=d.supplier_id
  WHERE d.workspace_id=$1 AND d.id=$2${lock?' FOR UPDATE OF d,m':''}`,[ctx.workspaceId,id])).rows[0];
 if(!d)throw new NotFoundError('That negotiation email is not in this inventory.');return d;
}
async function draftAccess(c,ctx){
 await owner(c,ctx);const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,94,'draft');
 const stopped=await policy.stopped(c,ctx.workspaceId,state,action,false);if(stopped)throw new ValidationError(stopped);return state;
}
// Saves the email as an unsent draft with the facts behind it. A repeat with
// the same facts finds the same draft.
async function persist(c,ctx,found,words,{kind='negotiation',routineKey=null,automatic=false,ruleRevision=null}={}){
 const at=nowIso(),key=kind==='negotiation'?'supplier-negotiation:'+found.supplier.id+':'+evidence.key(found,words):'supplier-negotiation-routine:'+routineKey;
 const inserted=await c.query(`INSERT INTO supplier_communications(id,workspace_id,supplier_id,recipient,subject,body,status,message_kind,idempotency_key,created_at,updated_at)
  VALUES($1,$2,$3,$4,$5,$6,'PREPARED','agent_negotiation',$7,$8,$8) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING id`,[newId('email'),ctx.workspaceId,found.supplier.id,found.supplier.email||null,words.subject,words.body,key,at]);
 const communicationId=inserted.rows[0]?.id||(await c.query('SELECT id FROM supplier_communications WHERE workspace_id=$1 AND idempotency_key=$2',[ctx.workspaceId,key])).rows[0].id;
 if(inserted.rowCount){
  await c.query(`INSERT INTO ${drafts}(id,workspace_id,supplier_id,communication_id,kind,facts,period_from,period_to,routine_key,automatic,rule_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
   [newId('negotiation'),ctx.workspaceId,found.supplier.id,communicationId,kind,JSON.stringify(found.facts),found.from,found.to,routineKey,automatic,ruleRevision]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:kind==='negotiation'?'Prepared supplier negotiation draft':'Prepared routine supplier lead-time note',reference:found.supplier.name,after:{facts:found.facts.map(f=>({kind:f.kind,count:f.count})),from:found.from,to:found.to}});
 }
 const id=(await c.query('SELECT id FROM '+drafts+' WHERE workspace_id=$1 AND communication_id=$2',[ctx.workspaceId,communicationId])).rows[0].id;
 return {...await draft(c,ctx,id),replayed:!inserted.rowCount};
}
async function prepare(db,ctx,input){return tx(db,async c=>{
 await draftAccess(c,ctx);
 const found=await evidence.collect(c,ctx,input.supplier);
 if(!found.facts.length)throw new ValidationError('Nothing recorded for this supplier yet to negotiate with.');
 const words=evidence.negotiationEmail(found);
 if(input.evidence!==evidence.key(found,words))throw new ValidationError('The supplier evidence changed. Review the current draft.');
 return (await persist(c,ctx,found,words)).id;
});}
async function edit(db,ctx,id,input){return tx(db,async c=>{
 await draftAccess(c,ctx);const d=await draft(c,ctx,id,true);
 if(d.status!=='PREPARED')throw new ValidationError('This email was already sent or queued. It can no longer be changed.');
 const subject=String(input.subject||'').trim(),body=String(input.body||'').replace(/\r\n?/g,'\n').trim();
 if(!subject||subject.length>200||/[\x00-\x1f\x7f]/.test(subject)||!body||body.length>20000)throw new ValidationError('Write a one-line subject and an email of up to 20,000 characters.');
 await c.query('UPDATE supplier_communications SET subject=$3,body=$4,updated_at=$5 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,d.communication_id,subject,body,nowIso()]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Edited supplier negotiation draft',reference:d.supplier_name,before:{subject:d.subject},after:{subject}});
 return {id};
});}
// Queues the exact draft through the outbound mail queue.
async function queueDraft(c,ctx,d,connectorId,{automatic=false,ruleRevision=null}={}){
 const person=(await c.query("SELECT id,name,email FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,d.supplier_id])).rows[0];
 if(!person||!emailOk(person.email))throw new ValidationError('Add the supplier’s email address before sending.');
 const box=(await require('../connections/postgres-outbound-mail').mailboxes(c,ctx.workspaceId)).find(m=>m.id===connectorId);
 if(!box)throw new ValidationError('Choose a connected mailbox to send from.');
 const at=nowIso();
 await c.query(`UPDATE supplier_communications SET recipient=$3,connector_id=$4,transport=$5,status='QUEUED',approved_by_user_id=$6,approved_at=$7,queued_at=$7,updated_at=$7
  WHERE workspace_id=$1 AND id=$2 AND status='PREPARED'`,[ctx.workspaceId,d.communication_id,person.email,box.id,box.provider_type,ctx.actorId,at]);
 await c.query('UPDATE '+drafts+' SET sent_by=$3,queued_at=clock_timestamp(),needs_person=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,d.id,ctx.actorId]);
 const grant={kind:mailKind,actorId:ctx.actorId,draftId:d.id,communicationId:d.communication_id,bodyHash:bodyHash(d),automatic,manualApproval:!automatic,...(automatic?{ruleRevision}:{})};
 return require('../connections/postgres-outbound-mail').queueInTransaction(c,ctx,{recipientKind:'supplier',recipientId:person.id,recipientEmail:person.email,connectorId:box.id,subject:d.subject,body:d.body,standingAuthority:grant},d.idempotency_key,{agentRequested:true,agentJob:94});
}
async function send(db,ctx,id,input){return tx(db,async c=>{
 await draftAccess(c,ctx);const d=await draft(c,ctx,id,true);
 if(['QUEUED','SENDING','SENT'].includes(d.status))return {id,communicationId:d.communication_id,replayed:true};
 if(d.status!=='PREPARED')throw new ValidationError('This email can no longer be sent. Prepare a fresh draft.');
 if(input.confirmed!=='yes'||input.bodyHash!==bodyHash(d))throw new ValidationError('The draft changed. Review the exact email before sending it.');
 const queued=await queueDraft(c,ctx,d,String(input.connectorId||''));
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier negotiation email approved and queued',reference:d.supplier_name,after:{draftId:id,communicationId:d.communication_id,kind:d.kind,commitsMoney:false}});
 return {id,communicationId:d.communication_id,effectId:queued.effectId,replayed:false};
});}
// Checked when the email is queued and again just before the mailbox sends it.
async function authority(c,workspaceId,grant){
 const ctx={workspaceId,actorId:grant.actorId},d=await draft(c,ctx,grant.draftId);
 if(grant.kind!==mailKind||d.communication_id!==grant.communicationId||bodyHash(d)!==grant.bodyHash)throw new ValidationError('This negotiation email changed after it was approved. Review it again.');
 await owner(c,ctx);
 if(!emailOk(d.supplier_email)||d.supplier_email.toLowerCase()!==String(d.recipient).toLowerCase())throw new ValidationError('The supplier’s email address changed. Review the email again.');
 if(grant.automatic){
  const rule=await setting(c,workspaceId,d.supplier_id);
  if(!rule||rule.revision!==grant.ruleRevision||rule.owner_id!==ctx.actorId||d.kind!=='lead_time_check'||!d.automatic)throw new ValidationError('The supplier rule changed. This note needs your review.');
  const state=await policy.requireWorkspaceJob(c,workspaceId,94,'automatic',{trained:true});
  const stopped=await policy.stopped(c,workspaceId,state,action,true);if(stopped)throw new ValidationError(stopped);
  if(!(await require('../autopilot/postgres-service').getState(c,workspaceId)).canAutomate)throw new ValidationError('StockChief is set to ask before acting. Review this note.');
 }else{
  await policy.requireWorkspaceJob(c,workspaceId,94,'draft');
  if(grant.manualApproval!==true||d.sent_by!==ctx.actorId)throw new ValidationError('Approve this exact email before sending it.');
 }
 return d;
}
async function deliveryAuthority(...args){try{return await authority(...args);}catch(error){
 if([400,402,403,404,422].includes(error.status)){error.code='negotiation_needs_review';error.retryable=false;}throw error;
}}
// Custom: teaching a supplier rule lets the routine lead-time note go out on
// its own every so many days. Removing it stops the routine.
async function configure(db,ctx,input){return tx(db,async c=>{
 await owner(c,ctx);
 const prior=await setting(c,ctx.workspaceId,input.supplier);
 if((prior?.revision||'')!==(input.revision||''))throw new ValidationError('The supplier rule changed. Open the current rule.');
 if(input.remove==='1'){
  await c.query('DELETE FROM '+rules+' WHERE workspace_id=$1 AND supplier_id=$2',[ctx.workspaceId,input.supplier]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Stopped routine supplier lead-time notes',reference:input.supplier});return;
 }
 await policy.requireWorkspaceJob(c,ctx.workspaceId,94,'automatic',{trained:true});
 const found=await evidence.collect(c,ctx,input.supplier);
 if(!found.facts.length||input.evidence!==evidence.key(found,evidence.negotiationEmail(found)))throw new ValidationError('Review the supplier evidence before teaching this rule.');
 const everyDays=String(input.everyDays??'').trim()?Number(input.everyDays):90;
 if(!Number.isSafeInteger(everyDays)||everyDays<30||everyDays>365)throw new ValidationError('Send the note every 30 to 365 days.');
 const connectorId=String(input.connectorId||'')||null;
 if(connectorId&&!(await require('../connections/postgres-outbound-mail').mailboxes(c,ctx.workspaceId)).some(m=>m.id===connectorId))throw new ValidationError('Choose a connected mailbox to send from.');
 if(!prior)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
 await c.query(`INSERT INTO ${rules}(workspace_id,supplier_id,owner_id,revision,connector_id,every_days) VALUES($1,$2,$3,$4,$5,$6)
  ON CONFLICT(workspace_id,supplier_id) DO UPDATE SET owner_id=$3,revision=$4,connector_id=$5,every_days=$6`,[ctx.workspaceId,found.supplier.id,ctx.actorId,newId('rule'),connectorId,everyDays]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Taught routine supplier lead-time notes',reference:found.supplier.name,after:{everyDays,connectorId,commitsMoney:false}});
});}
async function queue(c,workspaceId,day){
 const due=await c.query(`SELECT supplier_id,revision FROM ${rules} r WHERE r.workspace_id=$1
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs j WHERE j.workspace_id=$1 AND j.kind='agent.supplier-negotiation'
    AND j.idempotency_key='negotiation:'||r.revision||':'||$2) ORDER BY supplier_id LIMIT 100`,[workspaceId,day]);
 const db={query:c.query.bind(c),transaction:work=>work(c)};
 for(const r of due.rows)await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:'agent.supplier-negotiation',
  idempotencyKey:'negotiation:'+r.revision+':'+day,payload:{supplier:r.supplier_id,revision:r.revision},priority:65});
}
// The daily routine for one taught supplier rule.
async function processJob(c,job){
 const state=await policy.accountState(c,job.workspaceId);
 if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,94,'automatic',{trained:true}))return {skipped:'Plan changed'};
 const rule=(await c.query(`SELECT r.*,r.last_sent_on::text AS last_day FROM ${rules} r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.owner_id AND u.role='owner'
  JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id AND s.status='active'
  WHERE r.workspace_id=$1 AND r.supplier_id=$2 AND r.revision=$3 FOR UPDATE OF r`,[job.workspaceId,job.payload.supplier,job.payload.revision])).rows[0];
 if(!rule)return {skipped:'Supplier rule or authority changed'};
 const ctx={workspaceId:job.workspaceId,actorId:rule.owner_id},today=await require('../lib/business-time').today(c,job.workspaceId);
 const note=text=>c.query('UPDATE '+rules+' SET last_note=$3 WHERE workspace_id=$1 AND supplier_id=$2',[job.workspaceId,rule.supplier_id,String(text).slice(0,1000)]);
 if(rule.last_day&&addDays(rule.last_day,rule.every_days)>today)return {skipped:'The next note is not due until '+addDays(rule.last_day,rule.every_days)+'.'};
 const draftStop=await policy.stopped(c,job.workspaceId,state,action,false);
 if(draftStop){await note(draftStop);return {skipped:draftStop};}
 const found=await evidence.collect(c,ctx,rule.supplier_id,{days:rule.every_days,routine:true});
 if(!found.facts.length){const why=found.completed?'All '+found.completed+' completed orders in the last '+rule.every_days+' days arrived on time. No note needed.':'No completed orders with an agreed date in the last '+rule.every_days+' days. Nothing to ask.';await note(why);return {skipped:why};}
 const routineKey=rule.supplier_id+':'+rule.revision+':'+(rule.last_day||'first');
 const d=await persist(c,ctx,found,evidence.leadTimeNote(found),{kind:'lead_time_check',routineKey,automatic:true,ruleRevision:rule.revision});
 if(d.status!=='PREPARED')return {draft:d.id,replayed:true};
 let why=await require('../autopilot/job-modes').restriction(c,job.workspaceId,94,true)
  ||(!(await require('../autopilot/postgres-service').getState(c,job.workspaceId)).canAutomate?'StockChief is set to ask before acting. Review and send this note.':null)
  ||await policy.stopped(c,job.workspaceId,state,action,true)
  ||(!rule.connector_id?'Choose a mailbox in the supplier rule so StockChief can send this note on its own.':null),sent=false;
 if(!why){
  await c.query('SAVEPOINT negotiation_routine_send');
  try{
   const fresh=await draft(c,ctx,d.id,true);await queueDraft(c,ctx,fresh,rule.connector_id,{automatic:true,ruleRevision:rule.revision});
   await c.query('UPDATE '+rules+' SET last_sent_on=$3 WHERE workspace_id=$1 AND supplier_id=$2',[job.workspaceId,rule.supplier_id,today]);
   await c.query('RELEASE SAVEPOINT negotiation_routine_send');sent=true;
  }catch(error){if(!held(error))throw error;await c.query('ROLLBACK TO SAVEPOINT negotiation_routine_send');await c.query('RELEASE SAVEPOINT negotiation_routine_send');why=error.message;}
 }
 if(why)await c.query('UPDATE '+drafts+' SET needs_person=$3 WHERE workspace_id=$1 AND id=$2',[job.workspaceId,d.id,why]);
 await note(sent?'Sent the lead-time note on '+today+'.':'Prepared the lead-time note for you: '+why);
 if(sent||!d.replayed)await require('../operations/postgres-security-audit').record(c,ctx,{action:sent?'Routine supplier lead-time note sent on its own':'Routine supplier lead-time note held for review',reference:found.supplier.name,after:{draftId:d.id,needsPerson:why,commitsMoney:false}});
 return {draft:d.id,sent,needsPerson:why};
}
async function page(db,ctx,{supplier='',draftId=null}={}){
 await owner(db,ctx);const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,94,'draft');
 const suppliers=(await db.query("SELECT id,name FROM suppliers WHERE workspace_id=$1 AND status='active' ORDER BY name,id LIMIT 500",[ctx.workspaceId])).rows;
 const mailboxes=await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId);
 const saved=draftId?await draft(db,ctx,draftId):null;
 let found=null,words=null,key=null,problem=null;const chosen=saved?saved.supplier_id:String(supplier||'').trim();
 if(chosen&&!saved){try{found=await evidence.collect(db,ctx,chosen);if(found.facts.length){words=evidence.negotiationEmail(found);key=evidence.key(found,words);}}catch(error){if(!held(error))throw error;problem=error.message;}}
 const supplierId=saved?.supplier_id||found?.supplier.id||null,rule=supplierId?await setting(db,ctx.workspaceId,supplierId):null;
 const recent=(await db.query(`SELECT d.id,d.kind,d.created_at,d.automatic,d.needs_person,m.status,m.subject,s.name AS supplier_name FROM ${drafts} d
  JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id JOIN suppliers s ON s.workspace_id=d.workspace_id AND s.id=d.supplier_id
  WHERE d.workspace_id=$1 AND ($2::text IS NULL OR d.supplier_id=$2) ORDER BY d.created_at DESC,d.id DESC LIMIT 50`,[ctx.workspaceId,supplierId])).rows;
 return {plan:state.plan,shadow:state.shadow,mode:policy.allowance(state.plan,94),suppliers,mailboxes,saved,bodyHash:saved?bodyHash(saved):null,found,words,key,problem,rule,recent,supplierId};
}
async function inbox(db,workspaceId,actorId){
 const rows=(await db.query(`SELECT d.id,d.needs_person,d.created_at,s.name FROM ${drafts} d JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id
  JOIN suppliers s ON s.workspace_id=d.workspace_id AND s.id=d.supplier_id WHERE d.workspace_id=$1 AND d.needs_person IS NOT NULL AND m.status='PREPARED' ORDER BY d.created_at,d.id LIMIT 50`,[workspaceId])).rows;
 if(!rows.length)return [];await owner(db,{workspaceId,actorId});
 return rows.map(r=>({kind:'purchasing',importance:'Needs You',priority:55,title:'Send lead-time note to '+r.name,happened:'StockChief prepared the routine note from your supplier rule.',why:r.needs_person,recommendation:'Check the late deliveries listed and send the note, or change it first.',href:'/autopilot/supplier-negotiations/drafts/'+r.id,actionLabel:'Review note',sourceId:'supplier-negotiation:'+r.id,at:r.created_at,createdAt:r.created_at}));
}
module.exports={JOB:94,setting,configure,prepare,edit,send,queue,processJob,authority,deliveryAuthority,page,inbox,draft,bodyHash,mailKind};

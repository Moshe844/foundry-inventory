'use strict';
// Job 81: a customer asks for their account statement, by email or through a
// person in Ask. StockChief prepares the reconciled statement (email plus the
// complete PDF) and sends it through the ordinary customer message path, only
// to the customer's address on file.
//
// Growth drafts it for approval until the owner has taught it (a saved rule or
// an approved, delivered statement for that customer and mailbox); then it
// sends on its own. Pro and Custom send on their own. A first statement to a
// customer, Ask me first, a value over the owner's rule and anything unclear
// (an unknown sender, a request naming another customer, another period, or
// more than one possible currency) stop and wait for a person. Shadow, Watch
// only and pause only record what StockChief would have done.
const policy=require('../commercial/agent-plan');
const {ValidationError}=require('../domain/errors');
const {has}=require('../db/schema-installed');
const reader=require('./statement-request');
const TABLE='stockchief_runtime.agent_statement_requests';
const kind='mail.customer-statement.v1';
const path='/autopilot/reviews/customer-statements';
const expected=error=>[400,402,403,404,409,422].includes(error?.status);
const audit=(c,ctx,entry)=>require('../operations/postgres-security-audit').record(c,ctx,entry);

async function record(c,workspaceId,id,f){
  if(!await has(c,TABLE))return;
  await c.query(`INSERT INTO ${TABLE}(workspace_id,id,source,message_id,set_aside_id,sender,subject,customer_id,currency,status,reason,proposal_id,communication_id,automatic)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(workspace_id,id) DO UPDATE SET customer_id=coalesce(EXCLUDED.customer_id,agent_statement_requests.customer_id),
      currency=coalesce(EXCLUDED.currency,agent_statement_requests.currency),status=EXCLUDED.status,reason=EXCLUDED.reason,
      proposal_id=coalesce(EXCLUDED.proposal_id,agent_statement_requests.proposal_id),communication_id=coalesce(EXCLUDED.communication_id,agent_statement_requests.communication_id),
      automatic=EXCLUDED.automatic,updated_at=clock_timestamp()`,
  [workspaceId,id,f.source,f.messageId||null,f.setAsideId||null,f.sender||null,f.subject?String(f.subject).slice(0,300):null,f.customerId||null,f.currency||null,
    f.status,f.reason?String(f.reason).slice(0,500):null,f.proposalId||null,f.communicationId||null,Boolean(f.automatic)]);
}

// Whether StockChief may act on a request at all, before anything is prepared.
async function decide(db,workspaceId){
  const state=await policy.accountState(db,workspaceId),plan=policy.usesAgentTerms(state)?state.plan:null;
  if(!plan||!policy.permits(plan,81,'draft'))return {mode:'skip',state};
  if(state.shadow)return {mode:'watch',state,reason:'StockChief is watching during its first 14 days and did not send this statement.'};
  const autopilot=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(autopilot.mode==='OBSERVE')return {mode:'watch',state,reason:'StockChief is set to Watch only and did not send this statement.'};
  if(autopilot.paused||autopilot.suspended)return {mode:'watch',state,reason:'Automatic work is paused, so StockChief did not send this statement.'};
  const watch=await require('../autopilot/job-modes').restriction(db,workspaceId,81,false);
  if(watch)return {mode:'watch',state,reason:watch};
  return {mode:'prepare',state};
}

// Why a prepared statement waits for a person instead of going out alone.
async function waitReason(db,workspaceId,payload){
  const decision=await decide(db,workspaceId);
  if(decision.mode!=='prepare')return decision.reason||'Statements need the Growth plan or above.';
  const plan=decision.state.plan;
  if(payload.needsStatementConfirmation)return 'This is the first statement to this customer, so a person approves it.';
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return 'StockChief is set to ask you first.';
  const ask=await require('../autopilot/job-modes').restriction(db,workspaceId,81,true);
  if(ask)return ask;
  const trained=plan!=='growth'||await require('../autopilot/draft-authority').trained(db,workspaceId,'customer.statement',payload);
  if(!policy.permits(plan,81,'automatic',{trained}))return 'You have not taught StockChief this customer’s statement yet, so it waits for your approval.';
  const quota=await require('../commercial/agent-rule-quota').restriction(db,decision.state);
  if(quota)return quota;
  return null;
}

// executeProposalCore asks this inside the approval transaction.
async function requireRoutineAuthority(c,ctx,payload){
  const why=await waitReason(c,ctx.workspaceId,payload);
  if(why)throw new ValidationError(why);
  return {kind:'statement_request_routine',customerId:payload.recordId,currency:payload.currency};
}

// One currency: the one the request names, or the only one the account has.
async function currencyFor(db,workspaceId,customerId,named=[]){
  if(named.length>1)return {error:'The request names more than one currency ('+named.join(', ')+'). Send each statement yourself or ask which one they need.'};
  if(named.length===1)return {currency:named[0]};
  const rows=(await db.query(`SELECT DISTINCT l.currency FROM accounting_journal_lines l
    JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id AND a.system_key='ACCOUNTS_RECEIVABLE'
    WHERE l.workspace_id=$1 AND l.customer_id=$2 ORDER BY l.currency LIMIT 3`,[workspaceId,customerId])).rows.map(r=>r.currency);
  if(!rows.length)return {error:'This customer has no recorded account yet, so there is no statement to send.'};
  if(rows.length>1)return {error:'This customer has accounts in '+rows.join(' and ')+'. Ask which currency they want, then send that statement.'};
  return {currency:rows[0]};
}

// Another active customer named in the request: StockChief never sends one
// customer's account to another, and does not guess which account was meant.
async function otherCustomer(db,workspaceId,text,customer){
  const lower=String(text||'').toLowerCase();
  const rows=(await db.query(`SELECT name,company FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' AND id<>$3
    AND ((length(name)>=3 AND strpos($2,lower(name))>0) OR (length(coalesce(company,''))>=3 AND strpos($2,lower(company))>0)) ORDER BY length(name) DESC,id LIMIT 20`,
  [workspaceId,lower,customer.id])).rows;
  const own=[customer.name,customer.company].filter(Boolean).map(n=>n.toLowerCase());
  const whole=n=>{const value=n.toLowerCase();let at=lower.indexOf(value);
    while(at>=0){if(!/[\p{L}\p{N}]/u.test(lower[at-1]||'')&&!/[\p{L}\p{N}]/u.test(lower[at+value.length]||''))return true;at=lower.indexOf(value,at+1);}return false;};
  for(const r of rows)for(const n of [r.name,r.company].filter(v=>v&&v.length>=3)){
    if(own.some(o=>o.includes(n.toLowerCase())))continue;
    if(whole(n))return n;
  }
  return null;
}

async function ownerUser(db,workspaceId){return require('../sales/agent-customer-orders').ownerUser(db,workspaceId);}

// Prepare the statement as a proposal, then send it alone when the owner's
// authority allows; otherwise it waits in Needs you for approval.
async function prepareAndSettle(db,workspaceId,ownerId,rowId,fields,{connectorId,currency,planStepKey,message}){
  const ctx={workspaceId,actorId:ownerId,planStepKey};
  const assistant=require('../assistant/postgres-service');
  let prepared;
  try{prepared=await assistant.prepareAction(db,ctx,message,{action:'customer.statement',recordReference:fields.customerId,mailbox:connectorId,currency});}
  catch(error){if(!expected(error))throw error;return hold(db,workspaceId,ownerId,rowId,fields,error.message);}
  if(prepared.status!=='PREPARED')return hold(db,workspaceId,ownerId,rowId,fields,prepared.answer||'StockChief could not prepare this statement.');
  const proposalId=prepared.proposal.id,proposal=await assistant.getProposal(db,workspaceId,proposalId);
  if(proposal.status==='EXECUTED'){
    await record(db,workspaceId,rowId,{...fields,currency,status:'QUEUED',proposalId,communicationId:proposal.result?.communicationId,automatic:proposal.result?.automatic===true});
    return {queued:true,replayed:true,proposalId,communicationId:proposal.result?.communicationId};
  }
  let why=await waitReason(db,workspaceId,proposal.payload);
  if(!why){
    try{
      const done=await assistant.executeStatementRoutine(db,{workspaceId,actorId:ownerId},proposalId),result=done.result||{};
      await db.transaction(async c=>{
        await record(c,workspaceId,rowId,{...fields,currency,status:'QUEUED',proposalId,communicationId:result.communicationId,automatic:true});
        await audit(c,{workspaceId,actorId:ownerId},{action:'Requested customer statement sent by StockChief',reference:proposal.payload.customerName,
          after:{source:fields.source,customerId:fields.customerId,recipient:proposal.payload.recipient,currency,communicationId:result.communicationId,replayed:result.replayed===true}});
      });
      return {queued:true,proposalId,communicationId:result.communicationId,replayed:result.replayed===true};
    }catch(error){if(!expected(error))throw error;why=error.message;}
  }
  await db.transaction(async c=>{
    await record(c,workspaceId,rowId,{...fields,currency,status:'DRAFTED',reason:why,proposalId});
    await audit(c,{workspaceId,actorId:ownerId},{action:'Requested customer statement prepared for approval',reference:proposal.payload.customerName,
      after:{source:fields.source,customerId:fields.customerId,currency,proposalId,reason:why}});
  });
  return {drafted:true,proposalId,reason:why};
}
async function hold(db,workspaceId,actorId,rowId,fields,reason,status='HELD'){
  await db.transaction(async c=>{
    await record(c,workspaceId,rowId,{...fields,status,reason});
    await audit(c,{workspaceId,actorId},{action:status==='WATCHED'?'Customer statement request watched':'Customer statement request stopped for a person',
      reference:fields.sender||fields.customerId||rowId,after:{source:fields.source,customerId:fields.customerId||null,reason}});
  });
  return {held:status==='HELD',watched:status==='WATCHED',reason};
}

// The worker for a captured customer email. One outcome per email.
async function fromEmail(db,workspaceId,id){
  if(!await has(db,TABLE))return {skipped:true};
  const m=(await db.query('SELECT * FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
  if(!m||m.classification!=='customer'||m.trust_status!=='TRUSTED')return {skipped:true};
  const request=reader.read(m.subject,m.body_text);
  if(!request)return {skipped:true};
  const prior=(await db.query(`SELECT * FROM ${TABLE} WHERE workspace_id=$1 AND message_id=$2`,[workspaceId,id])).rows[0];
  if(prior)return {replayed:true,status:prior.status,reason:prior.reason};
  const decision=await decide(db,workspaceId);
  if(decision.mode==='skip')return {skipped:true};
  const ownerId=await ownerUser(db,workspaceId);
  if(!ownerId)return {skipped:true};
  const rowId='email:'+id,fields={source:'email',messageId:id,sender:m.sender,subject:m.subject};
  const customers=(await db.query(`SELECT id,name,company,email FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' AND lower(email)=lower($2)
    AND NOT EXISTS(SELECT 1 FROM suppliers WHERE workspace_id=$1 AND status='active' AND lower(email)=lower($2)) LIMIT 2`,[workspaceId,m.sender])).rows;
  if(customers.length!==1)return hold(db,workspaceId,ownerId,rowId,fields,'The sender is not exactly one of your customers, so StockChief did not send a statement.');
  const customer=customers[0];fields.customerId=customer.id;
  const other=await otherCustomer(db,workspaceId,request.text,customer);
  if(other)return hold(db,workspaceId,ownerId,rowId,fields,'The email mentions another customer, '+other+'. StockChief sends a statement only to the customer who asked, at their address on file.');
  if(request.period)return hold(db,workspaceId,ownerId,rowId,fields,'The email asks for a statement for a particular period. StockChief sends the current statement only; send that one yourself.');
  const chosen=await currencyFor(db,workspaceId,customer.id,request.currencies);
  if(chosen.error)return hold(db,workspaceId,ownerId,rowId,fields,chosen.error);
  fields.currency=chosen.currency;
  if(decision.mode==='watch')return hold(db,workspaceId,ownerId,rowId,fields,decision.reason+' It would have sent '+customer.name+' their '+chosen.currency+' statement.','WATCHED');
  const box=await require('../shipping/agent-shipping-notices').mailbox(db,workspaceId,m.connector_id);
  if(!box)return hold(db,workspaceId,ownerId,rowId,fields,'The mailbox that received this request cannot send mail. Connect a sending mailbox, then send the statement yourself.');
  return prepareAndSettle(db,workspaceId,ownerId,rowId,fields,{connectorId:box.id,currency:chosen.currency,planStepKey:'customer-statement-email:'+id,
    message:customer.name+' asked for their account statement by email'+(m.subject?' (“'+String(m.subject).slice(0,120)+'”)':'')+'.'});
}

// Mail from someone who is not one of the customers is set aside without its
// body. A statement request among it is recorded for the owner; nothing is sent.
async function fromSetAside(c,workspaceId,{id,sender,subject}){
  if(!await has(c,TABLE)||!reader.read(subject,''))return null;
  const state=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,81,'draft'))return null;
  await c.query(`INSERT INTO ${TABLE}(workspace_id,id,source,set_aside_id,sender,subject,status,reason) VALUES($1,$2,'unknown_sender',$3,$4,$5,'HELD',$6)
    ON CONFLICT DO NOTHING`,[workspaceId,'aside:'+id,id,sender,subject?String(subject).slice(0,300):null,
    'Someone who is not one of your customers ('+sender+') wrote about an account statement. StockChief did not reply.']);
  return {held:true};
}

// Ask, without a model: "send Acme their statement", "email the statement to
// Acme in EUR". Returns null when the sentence is not only that.
async function ask(service,db,ctx,message,query){
  const reference=String(query.customer||'').trim();
  if(!reference||reference.length>150)return null;
  const customers=(await db.query(`SELECT id,name,company,email FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE'
    AND (lower(name)=lower($2) OR lower(coalesce(company,''))=lower($2) OR lower(coalesce(email,''))=lower($2)) ORDER BY id LIMIT 2`,[ctx.workspaceId,reference])).rows;
  if(customers.length!==1)return null;
  const customer=customers[0];
  const clarify=answer=>({status:'CLARIFY',answer,rows:[],columns:[],handoff:{href:path,label:'Open customer statements'}});
  if(query.period)return clarify('StockChief sends the current statement only: the opening balance, this month’s account activity and the outstanding invoices. Nothing was sent.');
  const chosen=await currencyFor(db,ctx.workspaceId,customer.id,query.currency?[query.currency]:[]);
  if(chosen.error)return clarify(chosen.error+' Nothing was sent.');
  const boxes=[];
  for(const box of await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId))
    if(await require('../shipping/agent-shipping-notices').mailbox(db,ctx.workspaceId,box.id))boxes.push(box);
  if(boxes.length!==1)return clarify(boxes.length?'Which mailbox should send it: '+boxes.map(b=>b.display_name).join(' or ')+'? Use the customer statements page to choose. Nothing was sent.'
    :'Connect a mailbox that can send mail first. Nothing was sent.');
  const decision=await decide(db,ctx.workspaceId);
  if(decision.mode==='skip'){
    try{await policy.requireWorkspaceJob(db,ctx.workspaceId,81,'draft');}
    catch(error){if(!expected(error))throw error;return clarify(error.message);}
  }
  const fields={source:'ask',customerId:customer.id,currency:chosen.currency,sender:null,subject:String(message).slice(0,300)};
  let prepared;
  try{prepared=await service.prepareAction(db,ctx,message,{action:'customer.statement',recordReference:customer.id,mailbox:boxes[0].id,currency:chosen.currency});}
  catch(error){if(!expected(error))throw error;return clarify(error.message);}
  if(prepared.status!=='PREPARED')return prepared;
  const rowId='ask:'+prepared.proposal.id,payload=(await require('../assistant/postgres-service').getProposal(db,ctx.workspaceId,prepared.proposal.id)).payload;
  let why=decision.mode==='prepare'?await waitReason(db,ctx.workspaceId,payload):decision.reason;
  if(!why){
    try{
      const done=await service.executeStatementRoutine(db,ctx,prepared.proposal.id),result=done.result||{};
      await db.transaction(async c=>{
        await record(c,ctx.workspaceId,rowId,{...fields,status:'QUEUED',proposalId:prepared.proposal.id,communicationId:result.communicationId,automatic:true});
        await audit(c,ctx,{action:'Requested customer statement sent by StockChief',reference:customer.name,after:{source:'ask',customerId:customer.id,recipient:payload.recipient,currency:chosen.currency,communicationId:result.communicationId}});
      });
      return {status:'ANSWERED',rows:[],columns:[],proposal:prepared.proposal,
        answer:(result.replayed?'This exact statement was already sent to ':'Sending ')+customer.name+(result.replayed?'':' their '+chosen.currency+' account statement as of '+payload.asOf+' at ')+(result.replayed?' (':'')+payload.recipient+(result.replayed?').':', with the full statement attached as a PDF. It counts as sent once the mailbox confirms it.'),
        handoff:{href:'/messages/customer/'+result.communicationId,label:'Open the message'}};
    }catch(error){if(!expected(error))throw error;why=error.message;}
  }
  await record(db,ctx.workspaceId,rowId,{...fields,status:'DRAFTED',reason:why,proposalId:prepared.proposal.id});
  return {...prepared,answer:prepared.proposal.summary+' It waits for your approval: '+why};
}

// Needs you: requests StockChief stopped on, and ones it only watched.
async function inbox(db,workspaceId){
  if(!await has(db,TABLE))return [];
  const rows=(await db.query(`SELECT r.*,c.name customer_name FROM ${TABLE} r LEFT JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id
    WHERE r.workspace_id=$1 AND r.status IN ('HELD','WATCHED') ORDER BY r.updated_at DESC,r.id LIMIT 20`,[workspaceId])).rows;
  return rows.map(r=>{const who=r.customer_name||r.sender||'A customer';return {kind:'accounting',importance:'Needs You',priority:r.status==='HELD'?80:60,
    title:r.status==='HELD'?'Statement request from '+who+' needs you':'StockChief watched a statement request from '+who,
    happened:who+' asked for an account statement'+(r.source==='ask'?' in Ask':r.subject?' in “'+r.subject+'”':'')+'. Nothing was sent.',
    why:r.reason||'A person decides what to send.',recommendation:'Read the request, then send the statement yourself or dismiss it.',
    href:path,actionLabel:'Review the request',sourceId:'statement-request:'+r.id,createdAt:r.updated_at,timeLabel:'Received',at:r.updated_at};});
}

// The review page: recent requests and what happened to each.
async function recent(db,workspaceId,{page=1}={}){
  if(!await has(db,TABLE))return {rows:[],more:false};
  const rows=(await db.query(`SELECT r.id,r.source,r.sender,r.subject,r.status,r.reason,r.proposal_id,r.automatic,r.updated_at,r.message_id,c.name customer_name,
      m.status message_status,m.id communication_id,p.status proposal_status
    FROM ${TABLE} r LEFT JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id
    LEFT JOIN stockchief_runtime.assistant_action_proposals p ON p.workspace_id=r.workspace_id AND p.id=r.proposal_id
    LEFT JOIN customer_communications m ON m.workspace_id=r.workspace_id AND m.id=coalesce(r.communication_id,p.result->>'communicationId')
    WHERE r.workspace_id=$1 ORDER BY r.updated_at DESC,r.id LIMIT 21 OFFSET $2`,[workspaceId,(Math.max(1,Number(page)||1)-1)*20])).rows;
  const label=r=>r.status==='DISMISSED'?'Dismissed':r.status==='WATCHED'?'Watched only':r.status==='HELD'?'Stopped for you':
    r.message_status==='SENT'?'Sent':r.message_status==='FAILED'?'Needs review':r.message_status?'Sending':r.proposal_status==='CANCELLED'?'Not sent':'Waiting for approval';
  return {more:rows.length>20,rows:rows.slice(0,20).map(r=>({id:r.id,who:r.customer_name||r.sender||'Unknown sender',how:r.source==='ask'?'Ask':r.source==='email'?'Email':'Email from someone not on file',
    outcome:label(r),reason:['HELD','WATCHED','DRAFTED'].includes(r.status)&&r.message_status!=='SENT'?r.reason:null,automatic:r.automatic,at:r.updated_at,
    href:r.communication_id?'/messages/customer/'+r.communication_id:r.proposal_id&&r.proposal_status==='PENDING'?'/actions/'+r.proposal_id:r.message_id?'/mail/'+r.message_id:null,
    canDismiss:['HELD','WATCHED'].includes(r.status)}))};
}
async function dismiss(db,ctx,id){
  return db.transaction(async c=>{
    const actor=(await c.query("SELECT role FROM users WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId])).rows[0];
    if(actor?.role!=='owner')throw new ValidationError('Only the inventory owner can dismiss statement requests.');
    const row=(await c.query(`UPDATE ${TABLE} SET status='DISMISSED',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status IN ('HELD','WATCHED') RETURNING *`,[ctx.workspaceId,id])).rows[0];
    if(!row)throw new ValidationError('This request is no longer waiting for you.');
    await audit(c,ctx,{action:'Customer statement request dismissed',reference:row.sender||row.customer_id||row.id,before:{status:'HELD'},after:{status:'DISMISSED'}});
  });
}
module.exports={read:reader.read,decide,waitReason,requireRoutineAuthority,currencyFor,otherCustomer,fromEmail,fromSetAside,ask,inbox,recent,dismiss,kind};

'use strict';
// Job 73: a customer emails asking for a quote. StockChief reads the exact
// products (our code, their own code or a barcode) and quantities, writes the
// quotation at the current prices, customer terms, currency and delivery, and
// emails it back from the customer mailbox the owner chose.
//
// Starter and Growth do not include it. Pro prepares the quote for approval
// until the owner teaches that customer, products and value (an approved quote
// and a saved limit); then it writes and sends alone. Custom writes and sends
// alone, within any lower limit the owner saved. A first quote for a customer,
// Ask me first, a price the customer named, a new delivery address, a product
// it cannot name or a missing validity period stop and wait for a person.
// Shadow, Watch only and pause only record what it would have done.
const policy=require('../commercial/agent-plan');
const {ValidationError}=require('../domain/errors');
const {has}=require('../db/schema-installed');
const reader=require('./quote-request');
const TABLE='stockchief_runtime.agent_quote_requests',SETTINGS='stockchief_runtime.agent_quote_settings';
const JOB=73,kind='mail.customer-quote.v1',action='sales_quote.create',path='/autopilot/reviews/quote-requests';
const expected=error=>[400,402,403,404,409,422].includes(error?.status);
const audit=(c,ctx,entry)=>require('../operations/postgres-security-audit').record(c,ctx,entry);
const tx=(db,work)=>db.transaction(work,{isolation:'SERIALIZABLE',retrySafe:true});
const norm=value=>String(value||'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const questions=()=>require('./agent-customer-questions');

async function queue(client,workspaceId,{id}){
  const state=await policy.accountState(client,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return false;
  const scoped={query:(sql,values)=>client.query(sql,values),transaction:work=>work(client)};
  await require('../operations/postgres-job-queue').enqueue(scoped,{workspaceId,kind,idempotencyKey:'customer-quote-email:'+id,payload:{messageId:id},priority:55,maxAttempts:3});
  return true;
}

async function settings(db,workspaceId){
  if(!await has(db,SETTINGS))return null;
  return (await db.query(`SELECT * FROM ${SETTINGS} WHERE workspace_id=$1`,[workspaceId])).rows[0]||null;
}
// The owner chooses how long quotes stay valid (job 73) or how many days after
// a quote is emailed StockChief follows it up (job 74). Empty turns it off.
async function saveSettings(db,ctx,input={},field){
  if(!['valid_days','followup_days'].includes(field))throw new ValidationError('Choose a quote setting.');
  return tx(db,async c=>{
    await questions().owner(c,ctx);
    if(!await has(c,SETTINGS))throw new ValidationError('Quote settings are being upgraded. Try again shortly.');
    await policy.requireWorkspaceJob(c,ctx.workspaceId,field==='valid_days'?73:74,'draft');
    const raw=String(input.days??'').trim(),days=raw===''?null:Number(raw);
    if(days!==null&&(!/^\d{1,3}$/.test(raw)||days<1||days>365))throw new ValidationError('Choose 1 to 365 days, or leave it empty to turn this off.');
    const prior=(await c.query(`SELECT * FROM ${SETTINGS} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
    if(Number(input.revision||0)!==(prior?.revision||0))throw new ValidationError('These quote settings changed. Reload before saving.');
    if(days!==null&&!prior?.enabled)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    if(prior)await c.query(`UPDATE ${SETTINGS} SET ${field}=$2,authorized_by=$3,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1`,[ctx.workspaceId,days,ctx.actorId]);
    else await c.query(`INSERT INTO ${SETTINGS}(workspace_id,${field},authorized_by) VALUES($1,$2,$3)`,[ctx.workspaceId,days,ctx.actorId]);
    await audit(c,ctx,{action:field==='valid_days'?'Quote validity for written quotes changed':'Default quote follow-up delay changed',reference:ctx.workspaceId,
      before:{days:prior?.[field]??null},after:{days}});
  });
}

async function decide(db,workspaceId){
  const state=await policy.accountState(db,workspaceId),plan=policy.usesAgentTerms(state)?state.plan:null;
  if(!plan||!policy.permits(plan,JOB,'draft'))return {mode:'skip',state};
  if(state.shadow)return {mode:'watch',state,reason:'StockChief is watching during its first 14 days and did not write this quote.'};
  const autopilot=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(autopilot.mode==='OBSERVE')return {mode:'watch',state,reason:'StockChief is set to Watch only and did not write this quote.'};
  if(autopilot.paused||autopilot.suspended)return {mode:'watch',state,reason:'Automatic work is paused, so StockChief did not write this quote.'};
  const watch=await require('../autopilot/job-modes').restriction(db,workspaceId,JOB,false);
  if(watch)return {mode:'watch',state,reason:watch};
  return {mode:'prepare',state};
}

// The first quote for a customer is approved by a person.
async function known(db,workspaceId,customerId){
  return (await db.query(`SELECT EXISTS(SELECT 1 FROM sales_orders WHERE workspace_id=$1 AND customer_id=$2 AND status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED'))
    OR EXISTS(SELECT 1 FROM sales_quotations WHERE workspace_id=$1 AND customer_id=$2 AND status='ACCEPTED')
    OR EXISTS(SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND customer_id=$2 AND status='SENT' AND external_message_id IS NOT NULL) known`,[workspaceId,customerId])).rows[0].known;
}
async function lowerLimit(db,workspaceId,training){
  const rule=(await db.query('SELECT maximum_minor FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3 AND currency=$4',
    [workspaceId,action,training?.key||'',training?.currency||''])).rows[0];
  return Boolean(rule&&Number(rule.maximum_minor)<Number(training.amountMinor));
}

// Why a prepared quote waits for a person instead of being written alone.
async function waitReason(db,workspaceId,payload,customer,decision){
  if(!decision||decision.mode!=='prepare')return decision?.reason||'Writing quotes from customer emails needs the Pro plan or above.';
  if(!await known(db,workspaceId,customer.id))return 'This is the first quote StockChief would write for '+customer.name+', so a person approves it.';
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return 'StockChief is set to ask you first.';
  const ask=await require('../autopilot/job-modes').restriction(db,workspaceId,JOB,true);
  if(ask)return ask;
  const plan=decision.state.plan;
  const trained=policy.allowance(plan,JOB)!=='trained'||await require('../autopilot/draft-authority').trained(db,workspaceId,action,payload);
  if(!policy.permits(plan,JOB,'automatic',{trained}))return 'You have not taught StockChief to quote '+customer.name+' for these products at this value yet, so it waits for your approval.';
  if(await lowerLimit(db,workspaceId,payload.training))return 'This quote is over your saved limit for '+customer.name+' and these products, so it waits for your approval.';
  const quota=await require('../commercial/agent-rule-quota').restriction(db,decision.state);
  return quota||null;
}

// executeProposalCore asks this inside the approval transaction.
async function requireRoutineAuthority(c,ctx,payload){
  const customer=(await c.query("SELECT id,name FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'",[ctx.workspaceId,payload?.input?.customerId])).rows[0];
  const why=customer?await waitReason(c,ctx.workspaceId,payload,customer,await decide(c,ctx.workspaceId)):'Choose an active customer for this quote.';
  if(why)throw new ValidationError(why);
  return {kind:'quote_request_routine',customerId:customer.id};
}

// The quote email StockChief sends alone is checked here at queueing and again
// at the mailbox: the quote came from this request, the plan, mode and taught
// scope still allow it, and the customer mailbox is unchanged.
async function shareAuthority(db,workspaceId,p){
  if(p.agentJob!==JOB||!p.requestMessageId||p.manualApproval!==false)throw new ValidationError('Review and approve this quotation email individually.');
  if(!await has(db,TABLE))throw new ValidationError('Quote requests are being upgraded. Email this quote yourself.');
  const row=(await db.query(`SELECT * FROM ${TABLE} WHERE workspace_id=$1 AND message_id=$2`,[workspaceId,p.requestMessageId])).rows[0];
  if(!row||row.quote_id!==p.recordId||row.customer_id!==p.customerId||!row.automatic)throw new ValidationError('This quote was not written on its own from that customer’s request. Email it yourself after review.');
  const decision=await decide(db,workspaceId);
  if(decision.mode!=='prepare')throw new ValidationError(decision.reason||'Writing quotes from customer emails needs the Pro plan or above.');
  const stop=await policy.stopped(db,workspaceId,decision.state,action,true);
  if(stop)throw new ValidationError(stop);
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)throw new ValidationError('StockChief is set to ask you first.');
  const payload=(await db.query('SELECT payload FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2 AND action_type=$3',[workspaceId,row.proposal_id||'',action])).rows[0]?.payload;
  if(!payload)throw new ValidationError('The quote’s approval record is missing. Email it yourself after review.');
  const trained=policy.allowance(decision.state.plan,JOB)!=='trained'||await require('../autopilot/draft-authority').trained(db,workspaceId,action,payload);
  policy.requireJob(decision.state.plan,JOB,'automatic',{trained});
  if(await lowerLimit(db,workspaceId,payload.training))throw new ValidationError('This quote is over your saved limit. Email it yourself after review.');
  const box=await require('./customer-mailbox').resolve(db,workspaceId);
  if(box.reason)throw new ValidationError(box.reason);
  if(box.box.id!==p.connectorId)throw new ValidationError('The mailbox for customer messages changed. Email this quote yourself after review.');
}

async function record(c,workspaceId,messageId,f){
  await c.query(`INSERT INTO ${TABLE}(workspace_id,message_id,customer_id,sender,subject,status,reason,proposal_id,quote_id,communication_id,automatic)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(workspace_id,message_id) DO UPDATE SET customer_id=coalesce(EXCLUDED.customer_id,agent_quote_requests.customer_id),
      status=EXCLUDED.status,reason=EXCLUDED.reason,proposal_id=coalesce(EXCLUDED.proposal_id,agent_quote_requests.proposal_id),quote_id=coalesce(EXCLUDED.quote_id,agent_quote_requests.quote_id),
      communication_id=coalesce(EXCLUDED.communication_id,agent_quote_requests.communication_id),automatic=EXCLUDED.automatic,updated_at=clock_timestamp()`,
  [workspaceId,messageId,f.customerId||null,f.sender,f.subject?String(f.subject).slice(0,300):null,f.status,f.reason?String(f.reason).slice(0,500):null,
    f.proposalId||null,f.quoteId||null,f.communicationId||null,Boolean(f.automatic)]);
}
async function hold(db,workspaceId,actorId,fields,reason,status='HELD'){
  await tx(db,async c=>{
    await record(c,workspaceId,fields.messageId,{...fields,status,reason});
    await audit(c,{workspaceId,actorId},{action:status==='WATCHED'?'Customer quote request watched':'Customer quote request stopped for a person',
      reference:fields.sender,after:{messageId:fields.messageId,customerId:fields.customerId||null,reason}});
  });
  return {held:status==='HELD',watched:status==='WATCHED',reason};
}

async function addresses(db,workspaceId,customer){
  const used=(await db.query(`SELECT DISTINCT ship_to_address FROM sales_orders WHERE workspace_id=$1 AND customer_id=$2 AND delivery_method='SHIP'
    AND ship_to_address IS NOT NULL AND status<>'CANCELLED' LIMIT 200`,[workspaceId,customer.id])).rows.map(r=>r.ship_to_address);
  return [customer.shipping_address,...used].filter(Boolean);
}

// Email the written quote back to the customer from the customer mailbox.
async function share(db,ctx,fields,quoteId){
  const box=await require('./customer-mailbox').resolve(db,ctx.workspaceId);
  const keep=async reason=>{await tx(db,async c=>{await record(c,ctx.workspaceId,fields.messageId,{...fields,status:'QUOTED',quoteId,automatic:true,reason});
    await audit(c,ctx,{action:'Quote written by StockChief and kept for you to email',reference:fields.sender,after:{messageId:fields.messageId,quoteId,reason}});});
    return {quoted:true,emailed:false,quoteId,reason};};
  if(box.reason)return keep(box.reason);
  const mail=require('./quotation-mail');
  try{
    // The quote is recorded first, so the email's authority can see where it came from.
    await tx(db,c=>record(c,ctx.workspaceId,fields.messageId,{...fields,status:'QUOTED',quoteId,automatic:true,reason:null}));
    return await tx(db,async c=>{
      const p=await mail.facts(c,ctx,quoteId,box.box.id),grant={...p,kind:'quote_share',actorId:ctx.actorId,manualApproval:false,automatic:true,agentJob:JOB,requestMessageId:fields.messageId};
      await mail.authority(c,ctx.workspaceId,grant);
      const r=await require('../connections/postgres-outbound-mail').queueInTransaction(c,ctx,{recipientKind:'customer',recipientId:p.customerId,recipientEmail:p.recipient,
        connectorId:p.connectorId,...mail.compose(p),standingAuthority:grant},'quotation-email:'+quoteId,{agentRequested:true,agentJob:JOB});
      await record(c,ctx.workspaceId,fields.messageId,{...fields,status:'EMAILED',quoteId,communicationId:r.communicationId,automatic:true});
      await audit(c,ctx,{action:'Quote written and emailed by StockChief',reference:p.customerName,after:{messageId:fields.messageId,quoteId,quoteNumber:p.quoteNumber,recipient:p.recipient,communicationId:r.communicationId,total:p.pricing.totalMinor,currency:p.pricing.currency}});
      return {quoted:true,emailed:true,quoteId,communicationId:r.communicationId,effectId:r.effectId};
    });
  }catch(error){if(!expected(error))throw error;return keep(error.message);}
}

// The worker for a captured customer email. One outcome per email.
async function fromEmail(db,workspaceId,id){
  if(!await has(db,TABLE))return {skipped:true};
  const m=(await db.query('SELECT * FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
  if(!m||m.classification!=='customer'||m.trust_status!=='TRUSTED')return {skipped:true};
  const request=reader.read(m.subject,m.body_text);
  if(!request)return {skipped:true};
  const prior=(await db.query(`SELECT status,reason,quote_id FROM ${TABLE} WHERE workspace_id=$1 AND message_id=$2`,[workspaceId,id])).rows[0];
  if(prior)return {replayed:true,status:prior.status,reason:prior.reason,quoteId:prior.quote_id};
  const decision=await decide(db,workspaceId);
  if(decision.mode==='skip')return {skipped:true};
  const ownerId=await require('./agent-customer-orders').ownerUser(db,workspaceId);
  if(!ownerId)return {skipped:true};
  const fields={messageId:id,sender:m.sender,subject:m.subject},ctx={workspaceId,actorId:ownerId};
  const found=await questions().customerFor(db,workspaceId,m.sender);
  if(!found)return hold(db,workspaceId,ownerId,fields,'The sender is not exactly one of your customers, so StockChief did not write a quote.');
  const customer=(await db.query('SELECT * FROM customers WHERE workspace_id=$1 AND id=$2',[workspaceId,found.id])).rows[0];
  fields.customerId=customer.id;
  if(request.error)return hold(db,workspaceId,ownerId,fields,request.error);
  for(const name of request.names)if(![customer.name,customer.company].filter(Boolean).some(n=>norm(n)===norm(name)))
    return hold(db,workspaceId,ownerId,fields,'The request names the customer “'+String(name).slice(0,80)+'”, not '+customer.name+'. A person checks it.');
  const other=await require('../accounting/agent-statement-requests').otherCustomer(db,workspaceId,String(m.subject||'')+'\n'+require('../accounting/statement-request').own(m.body_text),customer);
  if(other)return hold(db,workspaceId,ownerId,fields,'The email mentions another customer, '+other+'. A person writes this quote.');
  let products;
  try{products=await require('./agent-customer-orders').identify(db,workspaceId,customer.id,request.lines.map(l=>l.code));}
  catch(error){if(!expected(error))throw error;return hold(db,workspaceId,ownerId,fields,error.message.replace(/enter the order yourself/gi,'write the quote yourself'));}
  const lines=request.lines.map(l=>({...products.get(l.code.toLowerCase()),quantity:l.quantity,price:l.price}));
  if(new Set(lines.map(l=>l.id)).size!==lines.length)return hold(db,workspaceId,ownerId,fields,'The request lists the same product twice under different codes. A person writes this quote.');
  let deliveryMethod='SHIP',address=null;
  if(request.pickup)deliveryMethod='PICKUP';
  else if(request.shipTo){
    address=(await addresses(db,workspaceId,customer)).find(a=>norm(a)===norm(request.shipTo));
    if(!address)return hold(db,workspaceId,ownerId,fields,'The request names a new delivery address: '+String(request.shipTo).slice(0,200)+'. A person checks new addresses.');
  }else if(customer.shipping_address)address=customer.shipping_address;
  else return hold(db,workspaceId,ownerId,fields,'The request has no delivery address and none is on file for '+customer.name+'. A person writes this quote.');
  const s=await settings(db,workspaceId);
  if(!s?.valid_days)return hold(db,workspaceId,ownerId,fields,'Choose how many days your quotes stay valid on the quote requests page, then StockChief can write quotes on its own.');
  const today=await require('../lib/business-time').today(db,workspaceId),validUntil=require('../accounting/customer-money').addDays(today,s.valid_days);
  // A price the customer names is theirs to ask for; a person decides prices.
  if(lines.some(l=>l.price)){
    const currency=require('../pricing/postgres-service').normaliseCurrency(customer.currency||(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[workspaceId])).rows[0]?.base_currency||'USD');
    let priced;
    try{priced=await require('../pricing/postgres-promotions').prepareQuote(db,ctx,{customerId:customer.id,currency,orderDate:today,deliveryMethod,shipToAddress:address,lines:lines.map(l=>({skuId:l.id,quantity:l.quantity})),codes:[],priceListId:null});}
    catch(error){if(!expected(error))throw error;return hold(db,workspaceId,ownerId,fields,error.message);}
    const money=require('../domain/currency');
    for(const [index,line] of lines.entries()){
      if(!line.price)continue;
      let stated=null;try{stated=money.userToMinor(String(line.price).replace(/^[A-Z]{3}\s?|^[$€£]/,'').replace(/^(\d+),(\d{1,2})$/,'$1.$2'),currency);}catch{/* unreadable */}
      if(stated!==Number(priced.lines[index].unitPriceMinor))return hold(db,workspaceId,ownerId,fields,'The customer asked for '+line.code+' at '+line.price+'; your price is '+money.format(Number(priced.lines[index].unitPriceMinor),currency)+'. A person decides prices.');
    }
  }
  if(decision.mode==='watch')return hold(db,workspaceId,ownerId,fields,decision.reason+' It would have written '+customer.name+' a quote for '+lines.length+(lines.length===1?' product.':' products.'),'WATCHED');
  const assistant=require('../assistant/postgres-service');
  let prepared;
  try{prepared=await assistant.prepareAction(db,{...ctx,planStepKey:'customer-quote-email:'+id},customer.name+' asked for a quote by email'+(m.subject?' (“'+String(m.subject).slice(0,120)+'”)':'')+'.',
    {action,recordReference:customer.id,orderLines:JSON.stringify(lines.map(l=>({sku:l.code,quantity:l.quantity}))),quoteValidUntil:validUntil,deliveryMethod,...(address?{shipToAddress:address}:{})});}
  catch(error){if(!expected(error))throw error;return hold(db,workspaceId,ownerId,fields,error.message);}
  if(prepared.status!=='PREPARED')return hold(db,workspaceId,ownerId,fields,prepared.answer||'StockChief could not prepare this quote.');
  const proposalId=prepared.proposal.id,proposal=await assistant.getProposal(db,workspaceId,proposalId);
  let why=await waitReason(db,workspaceId,proposal.payload,customer,decision);
  if(!why){
    try{
      const done=await assistant.executeQuoteRoutine(db,ctx,proposalId);
      return share(db,ctx,{...fields,proposalId},done.result.quoteId);
    }catch(error){if(!expected(error))throw error;why=error.message;}
  }
  await tx(db,async c=>{
    await record(c,workspaceId,id,{...fields,status:'DRAFTED',reason:why,proposalId});
    await audit(c,ctx,{action:'Customer quote prepared for approval',reference:customer.name,after:{messageId:id,proposalId,reason:why}});
  });
  return {drafted:true,proposalId,reason:why};
}

async function dismiss(db,ctx,id){
  return tx(db,async c=>{
    await questions().owner(c,ctx);
    const row=(await c.query(`UPDATE ${TABLE} SET status='DISMISSED',updated_at=clock_timestamp() WHERE workspace_id=$1 AND message_id=$2 AND status IN ('HELD','WATCHED') RETURNING sender`,[ctx.workspaceId,id])).rows[0];
    if(!row)throw new ValidationError('This request is no longer waiting for you.');
    await audit(c,ctx,{action:'Customer quote request dismissed',reference:row.sender,after:{messageId:id,status:'DISMISSED'}});
  });
}

const OUTCOME=r=>r.status==='DISMISSED'?'Dismissed':r.status==='WATCHED'?'Watched only':r.status==='HELD'?'Stopped for you':
  r.status==='EMAILED'?(r.message_status==='SENT'?'Quote emailed':r.message_status==='FAILED'?'Quote written; email not sent':'Quote written; sending'):
  r.status==='QUOTED'?'Quote written; email it':r.proposal_status==='EXECUTED'?'Quote written after your approval':r.proposal_status==='PENDING'?'Waiting for your approval':'Not written';
async function rows(db,workspaceId,{page=1,waiting=false}={}){
  return (await db.query(`SELECT r.*,c.name customer_name,m.status message_status,p.status proposal_status,coalesce(r.quote_id,p.result->>'quoteId') written_quote_id,q.quote_number
    FROM ${TABLE} r LEFT JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id
    LEFT JOIN customer_communications m ON m.workspace_id=r.workspace_id AND m.id=r.communication_id
    LEFT JOIN stockchief_runtime.assistant_action_proposals p ON p.workspace_id=r.workspace_id AND p.id=r.proposal_id
    LEFT JOIN sales_quotations q ON q.workspace_id=r.workspace_id AND q.id=coalesce(r.quote_id,p.result->>'quoteId')
    WHERE r.workspace_id=$1 ${waiting?`AND (r.status IN ('HELD','WATCHED') OR r.status='DRAFTED' AND p.status='PENDING' OR r.status='EMAILED' AND m.status='FAILED' OR r.status='QUOTED' AND q.status='OPEN'
      AND NOT EXISTS(SELECT 1 FROM customer_communications e WHERE e.workspace_id=r.workspace_id AND e.idempotency_key='quotation-email:'||r.quote_id))`:''}
    ORDER BY r.updated_at DESC,r.message_id LIMIT 101 OFFSET $2`,[workspaceId,(Math.max(1,Number(page)||1)-1)*100])).rows;
}

// Needs you: quotes prepared for approval, requests StockChief stopped on or
// watched, and quotes waiting to be emailed.
async function inbox(db,workspaceId){
  if(!await has(db,TABLE))return [];
  return (await rows(db,workspaceId,{waiting:true})).slice(0,20).map(r=>{const who=r.customer_name||r.sender,written=['QUOTED','EMAILED'].includes(r.status);
    if(r.status==='DRAFTED')return {kind:'approval',importance:'Needs You',priority:82,title:'Quote for '+who+' is ready to approve',
      happened:who+' asked for a quote'+(r.subject?' in “'+r.subject+'”':'')+'. StockChief prepared it at your current prices. Nothing was written or sent.',
      why:r.reason||'Your plan asks you to approve each quote.',recommendation:'Check the products, prices and delivery, then approve or dismiss it.',
      href:'/actions/'+encodeURIComponent(r.proposal_id),actionLabel:'Review quote',sourceId:'quote-request:'+r.message_id,createdAt:r.updated_at,timeLabel:'Received',at:r.updated_at};
    return {kind:'sales',importance:'Needs You',priority:r.status==='WATCHED'?60:written?78:80,
      title:written?'Quote '+(r.quote_number||'')+' for '+who+' is ready to email':r.status==='WATCHED'?'StockChief watched a quote request from '+who:'Quote request from '+who+' needs you',
      happened:who+' asked for a quote'+(r.subject?' in “'+r.subject+'”':'')+'.'+(written?' StockChief wrote it; it has not been emailed.':' Nothing was written or sent.'),
      why:r.reason||'A person decides what to send.',recommendation:written?'Check the quote, then email it.':'Read the request, then write the quote yourself or dismiss it.',
      href:written&&r.written_quote_id?'/quotes/'+encodeURIComponent(r.written_quote_id)+'/email':path,actionLabel:written?'Email the quote':'Review the request',
      sourceId:'quote-request:'+r.message_id,createdAt:r.updated_at,timeLabel:'Received',at:r.updated_at};});
}

// The review page (job 73): recent requests and the quote validity setting.
async function review(db,ctx,{page=1}={}){
  const state=await policy.accountState(db,ctx.workspaceId),training=policy.usesAgentTerms(state)&&policy.allowance(state.plan,JOB)==='trained';
  const summary='When a customer emails asking for a quote with product codes and quantities, StockChief writes it at your current prices and their terms, and emails it from your customer mailbox. '+
    (training?'Pro waits for your approval until you teach it a customer, products and a limit on an approved quote.':'Custom writes and sends on its own within any limit you saved.')+
    ' A first quote for a customer, a price the customer names, a new address or an unclear line waits for you.';
  if(!await has(db,TABLE))return {summary:'Quote requests are being upgraded. Try again shortly.',rows:[],more:false};
  const found=await rows(db,ctx.workspaceId,{page}),s=await settings(db,ctx.workspaceId);
  return {summary,more:found.length>100,
    rows:found.slice(0,100).map(r=>({Customer:r.customer_name||r.sender,Outcome:OUTCOME(r)+(r.automatic?' by StockChief':''),Quote:r.quote_number||'None',
      link:r.written_quote_id?'/quotes/'+encodeURIComponent(r.written_quote_id):r.proposal_status==='PENDING'?'/actions/'+encodeURIComponent(r.proposal_id):'/mail/'+encodeURIComponent(r.message_id)})),
    quoteRequestForm:{validDays:s?.valid_days??'',revision:s?.revision||0,
      waiting:found.filter(r=>['HELD','WATCHED'].includes(r.status)).slice(0,20).map(r=>({id:r.message_id,who:r.customer_name||r.sender,outcome:OUTCOME(r),reason:r.reason}))}};
}

module.exports={queue,settings,saveSettings,decide,waitReason,requireRoutineAuthority,shareAuthority,fromEmail,dismiss,inbox,review,kind,
  definition:{id:JOB,key:'quote-requests',label:'Write quotes from customer requests',readPage:review}};

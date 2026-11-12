'use strict';
// Job 53: repeat a customer's usual order from one sentence ("same as last
// month"), in Ask or in the customer's own email. "Usual" is read as the order
// from last month, the last order, or the lines the customer orders most of the
// time; the order and its summary say which reading was used.
//
// Growth prepares the order for approval until the owner has taught it for that
// customer (an approved example, or a saved rule); then it creates and confirms
// on its own. Pro and Custom do so at once, inside the owner's limits. A new
// customer, a new address, an order over the limit and anything unclear wait.
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const {ValidationError,NotFoundError}=require('../domain/errors');
const {has}=require('../db/schema-installed');
const orders=require('./agent-customer-orders');
const repeat=require('../assistant/repeat-customer-order');
const sentence=require('./repeat-order-sentence');
const pricing=require('../pricing/postgres-promotions');
const expected=error=>[400,402,403,404,409,422].includes(error?.status);
const audit=(c,ctx,entry)=>require('../operations/postgres-security-audit').record(c,ctx,entry);

async function record(c,workspaceId,id,fields){
  if(!await has(c,'stockchief_runtime.agent_repeat_orders'))return;
  await c.query(`INSERT INTO stockchief_runtime.agent_repeat_orders(workspace_id,id,source,message_id,customer_id,reading,training_key,status,reason,sales_order_id,automatic,total_minor,currency)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(workspace_id,id) DO UPDATE SET customer_id=coalesce(EXCLUDED.customer_id,agent_repeat_orders.customer_id),
      reading=coalesce(EXCLUDED.reading,agent_repeat_orders.reading),training_key=coalesce(EXCLUDED.training_key,agent_repeat_orders.training_key),
      status=EXCLUDED.status,reason=EXCLUDED.reason,sales_order_id=coalesce(EXCLUDED.sales_order_id,agent_repeat_orders.sales_order_id),automatic=EXCLUDED.automatic,
      total_minor=coalesce(EXCLUDED.total_minor,agent_repeat_orders.total_minor),currency=coalesce(EXCLUDED.currency,agent_repeat_orders.currency),updated_at=clock_timestamp()
    WHERE agent_repeat_orders.sales_order_id IS NULL OR EXCLUDED.sales_order_id IS NOT NULL`,
  [workspaceId,id,fields.source,fields.messageId||null,fields.customerId||null,fields.reading||null,fields.trainingKey||null,fields.status,fields.reason||null,
    fields.salesOrderId||null,Boolean(fields.automatic),fields.totalMinor??null,fields.currency||null]);
}

// Taught for this customer and these products: a saved rule (with its limit)
// or a repeat order a person approved and confirmed (up to its total).
async function example(db,workspaceId,bound){
  if(!await has(db,'stockchief_runtime.agent_repeat_orders'))return null;
  return (await db.query(`SELECT r.id,o.order_number FROM stockchief_runtime.agent_repeat_orders r
    JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
    WHERE r.workspace_id=$1 AND r.training_key=$2 AND NOT r.automatic AND r.status<>'UNDONE' AND r.currency=$3 AND r.total_minor>=$4
      AND o.status=ANY($5::text[]) AND o.confirmed_by_user_id IS NOT NULL ORDER BY r.updated_at DESC LIMIT 1`,
  [workspaceId,bound.key,bound.currency,bound.amountMinor,orders.CONFIRMED])).rows[0]||null;
}
async function trained(db,workspaceId,payload){
  const bound=payload?.training;
  if(!bound?.key||!Number.isSafeInteger(bound.amountMinor)||bound.amountMinor<=0)return false;
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return false;
  const rule=await db.query(`SELECT 1 FROM stockchief_runtime.agent_draft_rules r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.role='owner'
    WHERE r.workspace_id=$1 AND r.action_type='sales_order.repeat' AND r.scope_key=$2 AND r.currency=$3 AND r.maximum_minor>=$4`,
  [workspaceId,bound.key,bound.currency,bound.amountMinor]);
  return rule.rowCount>0||Boolean(await example(db,workspaceId,bound));
}

// The facts that still need a person even when StockChief may act alone.
async function gates(c,workspaceId,decision,payload){
  const input=payload.input;
  return await orders.needsPerson(c,workspaceId,input.customerId,{pickup:input.deliveryMethod==='PICKUP',address:payload.address})||
    orders.overLimit(decision.limit,{currency:input.currency,totalMinor:payload.training?.amountMinor??0,units:orders.units(input.lines)})||null;
}

// Ask: the owner's authority for an automatic repeat, checked inside the
// approval transaction (executeProposalCore with repeatRoutine).
async function requireRoutineAuthority(c,ctx,payload){
  const taught=await trained(c,ctx.workspaceId,payload);
  const decision=await orders.decide(c,ctx.workspaceId,53,{trained:taught});
  if(decision.mode!=='automatic')throw new ValidationError(decision.reason||'This repeat order waits for your approval.');
  const gate=await gates(c,ctx.workspaceId,decision,payload);
  if(gate)throw new ValidationError(gate);
  return {kind:'repeat_order_routine',trained:taught,limit:decision.limit?{currency:decision.limit.currency,maximumMinor:decision.limit.maximumMinor,maximumUnits:decision.limit.maximumUnits}:null};
}

// Confirm an order StockChief created on its own through the ordinary path.
async function confirmCreated(c,ctx,payload,salesOrderId,key){
  const state=await policy.accountState(c,ctx.workspaceId),limit=await orders.limits(c,ctx.workspaceId);
  const alone=policy.allowance(policy.usesAgentTerms(state)?state.plan:null,53)==='alone';
  const over=alone&&!limit?.enabled?'Save your limits for customer orders before StockChief confirms them on its own.':
    orders.overLimit(limit?.enabled?limit:null,{currency:payload.input.currency,totalMinor:payload.training?.amountMinor??0,units:orders.units(payload.input.lines)});
  if(over)return {held:over};
  return orders.confirm(c,ctx,salesOrderId,key);
}

// The Ask contract for sales_order.repeat. A person's approval creates the
// draft; an automatic run (mission or routine) also confirms it.
async function executeAsk(client,ctx,p){
  const created=await repeat.execute(client,ctx,p);
  if(created.replayed)return created;
  const automatic=ctx.agentRepeatAutomatic===true;
  const confirmed=automatic?await confirmCreated(client,ctx,p,created.salesOrderId,'customer-repeat-confirm:'+p.idempotencyKey):null;
  const status=confirmed&&!confirmed.held?'CONFIRMED':'DRAFTED',reason=confirmed?.held?'StockChief created this order but did not confirm it. '+confirmed.held:null;
  await record(client,ctx.workspaceId,'ask:'+p.idempotencyKey,{source:'ask',customerId:p.recordId,reading:p.reading||null,trainingKey:p.training?.key,status,reason,
    salesOrderId:created.salesOrderId,automatic,totalMinor:created.pricing?.totalMinor??p.training?.amountMinor,currency:p.input.currency});
  await audit(client,ctx,{action:status==='CONFIRMED'?'Repeat customer order created and confirmed by StockChief':automatic?'Repeat customer order prepared by StockChief for approval':'Repeat customer order drafted',
    reference:created.orderNumber,after:{customerId:p.recordId,reading:p.reading||null,sourceOrder:p.sourceOrderNumber,totalMinor:created.pricing?.totalMinor,currency:p.input.currency,
      lines:p.input.lines,status:confirmed?.status||'DRAFT',reason}});
  return {...created,automatic,status:confirmed?.status||'DRAFT',...(reason?{reason}:{})};
}
async function verifyAsk(db,ctx,result,p){
  const statuses=result.automatic?['DRAFT',...orders.CONFIRMED]:['DRAFT'];
  const {rows}=await db.query(`SELECT l.sku_id,l.quantity_ordered FROM sales_orders o JOIN sales_order_lines l
    ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id WHERE o.workspace_id=$1 AND o.id=$2 AND o.customer_id=$3
    AND o.status=ANY($5::text[]) AND o.reference=$4 ORDER BY l.sku_id,l.quantity_ordered`,[ctx.workspaceId,result.salesOrderId,p.recordId,p.sourceOrderNumber,statuses]);
  const keys=lines=>lines.map(([sku,qty])=>JSON.stringify([sku,Number(qty)])).sort();
  return JSON.stringify(keys(rows.map(r=>[r.sku_id,r.quantity_ordered])))===JSON.stringify(keys(p.input.lines.map(l=>[l.skuId,l.quantity])));
}

// Ask, without a model: "same as last month for Acme", "repeat Acme's usual
// order", in English or one of the supported languages (or read in English
// first for other alphabets). Returns null when the sentence is not only that.
async function ask(service,db,ctx,message,query){
  const text=sentence.clean(query.text||message).toLowerCase();
  const candidates=(await db.query(`SELECT id,name,company FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE'
    AND (strpos($2,lower(name))>0 OR (coalesce(company,'')<>'' AND strpos($2,lower(company))>0)) ORDER BY length(name) DESC,id LIMIT 20`,[ctx.workspaceId,text])).rows;
  const whole=name=>{const n=sentence.clean(name).toLowerCase(),at=text.indexOf(n);if(!n||at<0)return false;
    return !/[\p{L}\p{N}]/u.test(text[at-1]||'')&&!/[\p{L}\p{N}]/u.test(text[at+n.length]||'');};
  let named=candidates.filter(c=>whole(c.name)||(c.company&&whole(c.company)));
  named=named.filter(c=>!named.some(o=>o!==c&&[o.name,o.company].filter(Boolean).some(n=>n.length>c.name.length&&n.toLowerCase().includes(c.name.toLowerCase()))));
  if(named.length!==1)return null;
  const customer=named[0];
  if(sentence.leftover(query.text||message,query.found,[customer.name,customer.company]).length)return null;
  let prepared;
  try{prepared=await service.prepareAction(db,ctx,message,{action:'sales_order.repeat',recordReference:customer.id,repeatPeriod:query.period});}
  catch(error){if(!expected(error))throw error;return {status:'CLARIFY',answer:error.message,rows:[],columns:[]};}
  if(prepared.status!=='PREPARED')return prepared;
  const payload=(await db.query('SELECT payload FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,prepared.proposal.id])).rows[0].payload;
  const decision=await orders.decide(db,ctx.workspaceId,53,{trained:await trained(db,ctx.workspaceId,payload)});
  let why=decision.mode==='automatic'?await gates(db,ctx.workspaceId,decision,payload):decision.reason;
  if(decision.mode==='automatic'&&!why){
    try{
      const done=await service.executeRepeatRoutine(db,ctx,prepared.proposal.id),r=done.result||{};
      const total=r.pricing?money.format(r.pricing.totalMinor,r.pricing.currency):'';
      return {status:'ANSWERED',rows:[],columns:[],proposal:prepared.proposal,
        answer:(r.status&&r.status!=='DRAFT'?'Created and confirmed ':'Created ')+r.orderNumber+' for '+customer.name+', repeating their '+payload.reading+' at today’s prices'+(total?', '+total:'')+'.'+
          (r.reason?' '+r.reason:'')+' You can undo it on Customer orders from email.',
        handoff:{href:'/orders/'+r.salesOrderId,label:'Open '+r.orderNumber}};
    }catch(error){if(!expected(error))throw error;why=error.message;}
  }
  return {...prepared,answer:prepared.proposal.summary+' It waits for your approval'+(why?': '+why:'.')};
}

// One customer, by the sender's address, and a sentence that only asks for the repeat.
async function readEmail(c,ctx,m){
  await policy.requireWorkspaceJob(c,ctx.workspaceId,53,'draft');
  if(m.trust_status!=='TRUSTED'||m.classification!=='customer'||m.supplier_id)throw new ValidationError('This email is not from a known customer.');
  const customers=(await c.query(`SELECT * FROM customers WHERE workspace_id=$1 AND lower(email)=lower($2) AND record_state='ACTIVE'
    AND NOT EXISTS(SELECT 1 FROM suppliers WHERE workspace_id=$1 AND lower(email)=lower($2) AND status='active') LIMIT 2`,[ctx.workspaceId,m.sender])).rows;
  if(customers.length!==1)throw new ValidationError('The sender is not exactly one of your customers. Review the email and enter the order yourself.');
  const customer=customers[0],request=sentence.emailRequest(m.subject,m.body_text,[customer.name,customer.company]);
  if(!request)throw new ValidationError('This email does not ask to repeat an order.');
  if(request.extra.length)throw new ValidationError('The email asks for more than a repeat of an earlier order. Review it and enter the order yourself.');
  const prepared=await repeat.prepare(c,ctx,customer,{repeatPeriod:request.period});
  return {customer,request,...prepared};
}
async function recentRepeat(c,workspaceId,key){
  return (await c.query(`SELECT o.order_number FROM stockchief_runtime.agent_repeat_orders r JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
    WHERE r.workspace_id=$1 AND r.source='email' AND r.training_key=$2 AND r.status IN ('DRAFTED','CONFIRMED') AND o.status<>'CANCELLED'
      AND r.created_at>clock_timestamp()-interval '7 days' ORDER BY r.created_at DESC LIMIT 1`,[workspaceId,key])).rows[0]?.order_number||null;
}

// The customer email path. Every outcome is recorded once per email.
async function fromEmail(db,workspaceId,id){
  if(!await has(db,'stockchief_runtime.agent_repeat_orders'))return {skipped:true};
  const m=(await db.query('SELECT * FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
  if(!m||m.classification!=='customer'||m.trust_status!=='TRUSTED'||!sentence.emailRequest(m.subject,m.body_text))return {skipped:true};
  const prior=(await db.query('SELECT sales_order_id FROM stockchief_runtime.agent_repeat_orders WHERE workspace_id=$1 AND message_id=$2',[workspaceId,id])).rows[0];
  if(prior?.sales_order_id)return {replayed:true,salesOrderId:prior.sales_order_id};
  if((await orders.decide(db,workspaceId,53)).mode==='skip')return {skipped:true};
  const owner=await orders.ownerUser(db,workspaceId);
  if(!owner)return {skipped:true};
  const rowId='email:'+id;
  try{
    return await db.transaction(async c=>{
      let ctx={workspaceId,actorId:owner};
      const read=await readEmail(c,ctx,m),p=read.payload;
      const decision=await orders.decide(c,workspaceId,53,{trained:await trained(c,workspaceId,p)});
      if(decision.mode==='skip')throw new ValidationError('Repeat orders need the Growth plan or above.');
      if(decision.mode==='watch')throw Object.assign(new ValidationError(decision.reason+' It would have prepared '+read.customer.name+'’s '+p.reading+' for '+
        money.format(p.training.amountMinor,p.input.currency)+'.'),{watch:true,customerId:read.customer.id});
      const again=await recentRepeat(c,workspaceId,p.training.key);
      if(again)throw Object.assign(new ValidationError('StockChief already repeated this order as '+again+' this week. Check before creating another.'),{customerId:read.customer.id});
      if(decision.mode==='automatic'&&decision.actorId)ctx={workspaceId,actorId:decision.actorId};
      const gate=decision.mode==='automatic'?await gates(c,workspaceId,decision,p):decision.reason;
      const created=await require('../operations/postgres-business-workflows').createSalesOrderInTransaction(c,ctx,{...p.input,
        reference:p.sourceOrderNumber,notes:'Repeat of the customer’s '+p.reading+', asked for by email.',idempotencyKey:'customer-repeat-email:'+id});
      await c.query('UPDATE sales_orders SET source_email_message_id=$3 WHERE workspace_id=$1 AND id=$2',[workspaceId,created.salesOrderId,id]);
      await c.query('UPDATE connection_email_messages SET order_draft_reason=NULL WHERE workspace_id=$1 AND id=$2',[workspaceId,id]);
      const automatic=decision.mode==='automatic'&&!gate;
      const confirmed=automatic?await confirmCreated(c,ctx,p,created.salesOrderId,'customer-repeat-email-confirm:'+id):null;
      const status=confirmed&&!confirmed.held?'CONFIRMED':'DRAFTED';
      const reason=confirmed?.held?'StockChief created this order but did not confirm it. '+confirmed.held:gate;
      await record(c,workspaceId,rowId,{source:'email',messageId:id,customerId:read.customer.id,reading:p.reading,trainingKey:p.training.key,status,reason,
        salesOrderId:created.salesOrderId,automatic,totalMinor:created.pricing.totalMinor,currency:p.input.currency});
      await audit(c,ctx,{action:status==='CONFIRMED'?'Repeat customer order created and confirmed by StockChief':'Repeat customer order prepared by StockChief for approval',
        reference:created.orderNumber,after:{messageId:id,customerId:read.customer.id,reading:p.reading,sourceOrder:p.sourceOrderNumber,totalMinor:created.pricing.totalMinor,
          currency:p.input.currency,lines:p.input.lines,status:confirmed?.status||'DRAFT',reason:reason||null}});
      return {...created,status:confirmed?.status||'DRAFT',automatic,reading:p.reading,...(reason?{reason}:{})};
    },{isolation:'SERIALIZABLE',retrySafe:true});
  }catch(error){
    if(!expected(error))throw error;
    const sender=(await db.query("SELECT id FROM customers WHERE workspace_id=$1 AND lower(email)=lower($2) AND record_state='ACTIVE' LIMIT 2",[workspaceId,m.sender])).rows;
    await db.transaction(async c=>{
      await c.query(`UPDATE connection_email_messages m SET order_draft_reason=$3 WHERE workspace_id=$1 AND id=$2
        AND NOT EXISTS(SELECT 1 FROM sales_orders o WHERE o.workspace_id=m.workspace_id AND o.source_email_message_id=m.id)`,[workspaceId,id,error.message]);
      await record(c,workspaceId,rowId,{source:'email',messageId:id,customerId:error.customerId||(sender.length===1?sender[0].id:null),status:error.watch?'WATCHED':'HELD',reason:error.message});
    });
    return {held:true,reason:error.message};
  }
}

// The mail page: a person reviews the repeat and creates the draft.
async function review(c,ctx,id){
  const m=(await c.query('SELECT * FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
  if(!m)throw new NotFoundError('This email was not found.');
  const existing=(await c.query('SELECT id,order_number FROM sales_orders WHERE workspace_id=$1 AND source_email_message_id=$2',[ctx.workspaceId,id])).rows[0];
  if(existing)return {existing};
  const actor=(await c.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  require('../actions/permissions').assertCan(actor,require('../actions/permissions').OPERATE,'prepare a customer order');
  const read=await readEmail(c,ctx,m),p=read.payload;
  return {customer:read.customer,input:p.input,quote:read.quote,skus:read.items.map(i=>({id:i.sku_id,code:i.code,name:i.name})),
    address:p.address,problems:[],reading:p.reading,payload:p,digest:pricing.hash({payload:p,sender:m.sender,body:m.body_text,subject:m.subject})};
}
async function create(db,ctx,id,digest){
  return db.transaction(async c=>{
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,53,'draft');
    const stop=await policy.stopped(c,ctx.workspaceId,state,'sales_order.repeat',false,{})||await require('../autopilot/job-modes').restriction(c,ctx.workspaceId,53,false);
    if(stop)throw new ValidationError(stop);
    const result=await review(c,ctx,id);
    if(result.existing)return {salesOrderId:result.existing.id,replayed:true};
    if(result.digest!==digest)throw new ValidationError('The order details changed. Review the current order before saving.');
    const p=result.payload;
    const created=await require('../operations/postgres-business-workflows').createSalesOrderInTransaction(c,ctx,{...p.input,
      reference:p.sourceOrderNumber,notes:'Repeat of the customer’s '+p.reading+', asked for by email.',idempotencyKey:'customer-repeat-email:'+id});
    await c.query('UPDATE sales_orders SET source_email_message_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,created.salesOrderId,id]);
    await c.query('UPDATE connection_email_messages SET order_draft_reason=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);
    await record(c,ctx.workspaceId,'email:'+id,{source:'email',messageId:id,customerId:result.customer.id,reading:p.reading,trainingKey:p.training?.key,status:'DRAFTED',
      salesOrderId:created.salesOrderId,automatic:false,totalMinor:created.pricing.totalMinor,currency:p.input.currency});
    await audit(c,ctx,{action:'Repeat customer order drafted',reference:created.orderNumber,after:{messageId:id,customerId:result.customer.id,reading:p.reading,
      sourceOrder:p.sourceOrderNumber,totalMinor:created.pricing.totalMinor,currency:p.input.currency,lines:p.input.lines}});
    return created;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
// A repeat request, not a list of order lines (job 52 reads those).
const isEmailRequest=(subject,body)=>{const request=sentence.emailRequest(subject,body);return Boolean(request)&&!request.extra.some(word=>/\d/.test(word));};
module.exports={trained,requireRoutineAuthority,executeAsk,verifyAsk,ask,fromEmail,review,create,isEmailRequest,kind:'mail.customer-repeat-order.v1'};

'use strict';
// Job 72: a customer emails to ask about stock, a delivery date or where their
// order is. StockChief writes the answer from its own records (only that
// customer's orders, shipments and the current available stock) and sends it
// through the customer mailbox the owner chose.
//
// Growth writes the answer for approval until the owner has taught it: a saved
// rule ("answer stock questions yourself", for one customer or all) or an
// answer the owner approved and the mailbox confirmed. Pro and Custom send on
// their own. The first time StockChief would write to a customer, Ask me first
// and a missing mailbox choice wait for a person. Anything the records do not
// answer stops and asks: an unknown or ambiguous sender, another customer's
// order, a product it cannot name, more than five open orders, a delivery date
// nobody recorded, or anything else the email asks for (prices, changes,
// cancellations, returns, payments, complaints). Shadow, Watch only and pause
// only record what StockChief would have said. One outcome per email.
const policy=require('../commercial/agent-plan');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {has}=require('../db/schema-installed');
const {hash}=require('../pricing/postgres-promotions');
const reader=require('./customer-question');
const TABLE='stockchief_runtime.agent_customer_questions',RULES='stockchief_runtime.agent_customer_answer_rules';
const JOB=72,kind='mail.customer-question.v1',mailKind='customer_answer',path='/autopilot/reviews/customer-questions';
const expected=error=>[400,402,403,404,409,422].includes(error?.status);
const audit=(c,ctx,entry)=>require('../operations/postgres-security-audit').record(c,ctx,entry);
const key=id=>'customer-answer:'+id;
const tx=(db,work)=>db.transaction(work,{isolation:'SERIALIZABLE',retrySafe:true});
const OPEN=['DRAFT','CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED'];
const STATUS={DRAFT:'received, not confirmed yet',CONFIRMED:'confirmed, not shipped yet',BACKORDERED:'confirmed; some goods are waiting for stock',
  PARTIALLY_FULFILLED:'partly shipped',FULFILLED:'shipped in full',CANCELLED:'cancelled'};

async function owner(db,ctx){
  const row=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the inventory owner can authorize answers to customers.');
}

// Called while a customer email is captured. Mail another job reads (orders,
// repeat orders, statements, returns, quote requests) is left to that job.
async function queue(client,workspaceId,{id,subject,body,skip=false}){
  if(skip||!reader.read(subject,body))return false;
  const state=await policy.accountState(client,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return false;
  const scoped={query:(sql,values)=>client.query(sql,values),transaction:work=>work(client)};
  await require('../operations/postgres-job-queue').enqueue(scoped,{workspaceId,kind,idempotencyKey:'customer-question-email:'+id,payload:{messageId:id},priority:55,maxAttempts:3});
  return true;
}

// Whether StockChief may act on a question at all.
async function decide(db,workspaceId){
  const state=await policy.accountState(db,workspaceId),plan=policy.usesAgentTerms(state)?state.plan:null;
  if(!plan||!policy.permits(plan,JOB,'draft'))return {mode:'skip',state};
  if(state.shadow)return {mode:'watch',state,reason:'StockChief is watching during its first 14 days and did not send this answer.'};
  const autopilot=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(autopilot.mode==='OBSERVE')return {mode:'watch',state,reason:'StockChief is set to Watch only and did not send this answer.'};
  if(autopilot.paused||autopilot.suspended)return {mode:'watch',state,reason:'Automatic work is paused, so StockChief did not send this answer.'};
  const watch=await require('../autopilot/job-modes').restriction(db,workspaceId,JOB,false);
  if(watch)return {mode:'watch',state,reason:watch};
  return {mode:'prepare',state,autopilot};
}

// What stops a send right now, for a person's approval (automatic=false) or
// for StockChief alone (automatic=true).
async function stopped(db,workspaceId,state,automatic){
  if(state.shadow)return 'StockChief is watching during its first 14 days. Reply to this email yourself, or approve answers after that.';
  const cfg=(await db.query('SELECT mode,paused,suspended FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];
  if(cfg?.mode==='OBSERVE')return 'StockChief is set to Watch only. Reply to this email yourself, or change its mode.';
  if(automatic&&(Number(cfg?.paused)||Number(cfg?.suspended)))return 'Automatic work is paused.';
  const mode=await require('../autopilot/job-modes').restriction(db,workspaceId,JOB,automatic);
  if(mode)return mode;
  return automatic?require('../commercial/agent-rule-quota').restriction(db,state):null;
}

async function customerFor(db,workspaceId,sender){
  const rows=(await db.query(`SELECT id,name,company,email FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' AND lower(email)=lower($2)
    AND NOT EXISTS(SELECT 1 FROM suppliers WHERE workspace_id=$1 AND status='active' AND lower(email)=lower($2)) LIMIT 2`,[workspaceId,sender])).rows;
  return rows.length===1?rows[0]:null;
}

// Products named by our code, a barcode or this customer's own code.
async function products(db,workspaceId,customerId,tokens){
  if(!tokens.length)return {found:new Map()};
  const own=await has(db,'stockchief_runtime.agent_customer_item_codes');
  const rows=(await db.query(`SELECT lower(s.code) AS key,s.id FROM skus s WHERE s.workspace_id=$1 AND s.is_active=1 AND lower(s.code)=ANY($2::text[])
    UNION SELECT lower(s.barcode),s.id FROM skus s WHERE s.workspace_id=$1 AND s.is_active=1 AND s.barcode IS NOT NULL AND lower(s.barcode)=ANY($2::text[])
    UNION SELECT lower(a.barcode),s.id FROM warehouse_barcode_aliases a JOIN skus s ON s.workspace_id=a.workspace_id AND s.id=a.target_id
      WHERE a.workspace_id=$1 AND a.target_kind='sku' AND s.is_active=1 AND lower(a.barcode)=ANY($2::text[])
    ${own?`UNION SELECT k.code_key,s.id FROM stockchief_runtime.agent_customer_item_codes k JOIN skus s ON s.workspace_id=k.workspace_id AND s.id=k.sku_id
      WHERE k.workspace_id=$1 AND k.customer_id=$3 AND s.is_active=1 AND k.code_key=ANY($2::text[])`:''}`,own?[workspaceId,tokens,customerId]:[workspaceId,tokens])).rows;
  const found=new Map();
  for(const token of tokens){
    const ids=[...new Set(rows.filter(r=>r.key===token).map(r=>r.id))];
    if(ids.length>1)return {hold:'The code “'+token+'” matches more than one of your products, so StockChief did not guess which one they mean.'};
    if(ids.length)found.set(token,ids[0]);
  }
  return {found};
}

function day(value,timeZone){
  if(!value)return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(value)))return String(value);
  const at=new Date(value);
  return Number.isFinite(at.getTime())?require('../lib/business-time').context(timeZone,at).calendarDate:null;
}

// Everything the answer may state, read from records. Returns {hold} when the
// records do not answer the question.
async function gather(db,workspaceId,customer,request){
  const tokens=reader.references(request.text).map(t=>t.toLowerCase());
  const named=tokens.length?(await db.query(`SELECT id,customer_id,lower(order_number) number,lower(coalesce(reference,'')) reference FROM sales_orders
    WHERE workspace_id=$1 AND (lower(order_number)=ANY($2::text[]) OR lower(reference)=ANY($2::text[])) LIMIT 20`,[workspaceId,tokens])).rows:[];
  // Never confirm or describe someone else's order, not even that it exists.
  if(named.some(o=>o.customer_id!==customer.id))return {hold:'The email names an order StockChief cannot match to '+customer.name+', so it shared nothing about it. A person checks it.'};
  const used=new Set(named.flatMap(o=>[o.number,o.reference].filter(Boolean)));
  const named_products=await products(db,workspaceId,customer.id,tokens.filter(t=>!used.has(t)));
  if(named_products.hold)return named_products;
  let orderIds=[...new Set(named.map(o=>o.id))];
  const asksOrders=request.topics.includes('status')||request.topics.includes('delivery');
  if(!orderIds.length&&asksOrders){
    const open=(await db.query(`SELECT o.id FROM sales_orders o WHERE o.workspace_id=$1 AND o.customer_id=$2 AND (o.status=ANY($3::text[])
      OR o.status='FULFILLED' AND EXISTS(SELECT 1 FROM sales_shipments s WHERE s.workspace_id=o.workspace_id AND s.sales_order_id=o.id AND s.status='SHIPPED'))
      ORDER BY o.created_at DESC,o.id DESC LIMIT 6`,[workspaceId,customer.id,OPEN])).rows;
    if(open.length>5)return {hold:customer.name+' has more than five open orders and the email does not say which one. A person answers it.'};
    if(!open.length)return {hold:'No open order is on file for '+customer.name+', so StockChief cannot tell which order they mean.'};
    orderIds=open.map(o=>o.id);
  }
  const {timeZone}=await require('../lib/business-time').forWorkspace(db,workspaceId);
  // "Is my order in stock?" asks about the products on the orders in question.
  const stockFromOrders=request.topics.includes('stock')&&!named_products.found.size;
  const orders=[];
  for(const id of orderIds){
    const o=(await db.query('SELECT id,order_number,reference,status FROM sales_orders WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
    const lines=(await db.query(`SELECT l.sku_id,s.code,i.name,l.quantity_ordered::text ordered,l.quantity_fulfilled::text shipped FROM sales_order_lines l
      JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY l.id LIMIT 51`,[workspaceId,id])).rows;
    if(lines.length>50)return {hold:'Order '+o.order_number+' has more than 50 lines. A person answers it.'};
    const shipments=(await db.query(`SELECT shipment_number,status,handover,carrier,service,tracking_number,tracking_url,shipped_at,expected_delivery_date,delivered_at
      FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2 AND status<>'CANCELLED' ORDER BY created_at,id LIMIT 11`,[workspaceId,id])).rows;
    if(shipments.length>10)return {hold:'Order '+o.order_number+' has more than ten shipments. A person answers it.'};
    const waiting=o.status!=='CANCELLED'&&lines.some(l=>Number(l.shipped)<Number(l.ordered));
    if(request.topics.includes('delivery')&&o.status!=='CANCELLED'){
      // A delivery date is a promise. StockChief states only one a carrier or
      // a delivery record gave; anything still to ship has none.
      if(waiting)return {hold:'Goods on order '+o.order_number+' have not shipped and no delivery date is recorded for them. A person answers when they will arrive.'};
      if(shipments.some(s=>s.status==='SHIPPED'&&!s.expected_delivery_date&&!s.tracking_number&&s.handover!=='COLLECTED'))
        return {hold:'A shipment on order '+o.order_number+' has no tracking number or expected date on record. A person answers when it will arrive.'};
    }
    orders.push({number:o.order_number,reference:o.reference||null,status:o.status,
      lines:lines.map(l=>({code:l.code,name:l.name,ordered:l.ordered,shipped:l.shipped})),
      shipments:shipments.map(s=>({number:s.shipment_number,status:s.status,handover:s.handover||null,carrier:s.carrier||null,service:s.service||null,
        tracking:s.tracking_number||null,link:s.tracking_number?(s.tracking_url||require('./carriers').trackingUrlFor(s.carrier,s.tracking_number)||null):null,
        left:day(s.shipped_at,timeZone),expected:s.expected_delivery_date||null,delivered:day(s.delivered_at,timeZone)}))});
    if(stockFromOrders)for(const l of lines)named_products.found.set('order:'+l.code,l.sku_id);
  }
  const stock=[];
  if(request.topics.includes('stock')){
    const ids=[...new Set(named_products.found.values())];
    if(!ids.length)return {hold:'StockChief could not tell which product they mean. Product codes in the email are needed to answer about stock.'};
    if(ids.length>20)return {hold:'The email asks about more than 20 products. A person answers it.'};
    if(await has(db,'stockchief_runtime.agent_annual_stocktakes')&&(await db.query("SELECT 1 FROM stockchief_runtime.agent_annual_stocktakes WHERE workspace_id=$1 AND status='FROZEN' LIMIT 1",[workspaceId])).rowCount)
      return {hold:'Stock is frozen for the yearly count, so StockChief did not state stock levels. A person answers it.'};
    const items=(await db.query(`SELECT s.id,s.code,i.name,i.unit_label,i.quantity_precision,EXISTS(SELECT 1 FROM kit_components k WHERE k.workspace_id=s.workspace_id AND k.kit_sku_id=s.id) kit
      FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) ORDER BY s.code,s.id`,[workspaceId,ids])).rows;
    const kit=items.find(r=>r.kit);
    if(kit)return {hold:kit.code+' is a kit. A person answers how many can be built.'};
    const places=(await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL ORDER BY id LIMIT 200',[workspaceId])).rows;
    const availability=require('../domain/postgres-stock-availability');
    const read=await availability.readMany(db,workspaceId,items.flatMap(i=>places.map(p=>({skuId:i.id,locationId:p.id}))));
    for(const item of items){
      let available=0;for(const place of places)available+=Number(read.get(availability.key(item.id,place.id))?.available||0);
      if(!Number.isFinite(available))return {hold:'StockChief could not read the stock of '+item.code+'. A person answers it.'};
      const places_=Number(item.quantity_precision)||0;
      stock.push({code:item.code,name:item.name,available:Number(available.toFixed(Math.min(6,places_))),unit:places_>0?item.unit_label||null:null});
    }
  }
  return {facts:{customer:{id:customer.id,name:customer.name,email:customer.email},topics:request.topics,orders,stock}};
}

async function signature(db,workspaceId){
  const policyRow=(await db.query('SELECT coalesce(signature,business_name) sign FROM customer_communication_policy WHERE workspace_id=$1',[workspaceId])).rows[0];
  if(policyRow?.sign)return policyRow.sign;
  try{return (await require('../operations/postgres-company-profile').get(db,workspaceId)).legalName||null;}catch{return null;}
}

function compose(subject,f,sign){
  const carriers=require('./carriers'),lines=[];
  for(const o of f.orders){
    lines.push('Order '+o.number+(o.reference?' (your reference '+o.reference+')':'')+': '+(STATUS[o.status]||o.status.toLowerCase())+'.');
    for(const l of o.lines)lines.push('- '+l.name+' ('+l.code+'): '+l.ordered+' ordered, '+l.shipped+' shipped.');
    for(const s of o.shipments){
      if(s.status==='DELIVERED')lines.push('Shipment '+s.number+' was delivered'+(s.delivered?' on '+s.delivered:'')+'.');
      else if(s.status==='SHIPPED'&&s.handover==='COLLECTED')lines.push('Shipment '+s.number+' was collected'+(s.left?' on '+s.left:'')+'.');
      else if(s.status==='SHIPPED')lines.push('Shipment '+s.number+' left'+(s.left?' on '+s.left:'')+(s.carrier?' with '+carriers.displayName(s.carrier)+(s.service?' '+s.service:''):'')+
        (s.tracking?', tracking number '+s.tracking:'')+'.'+(s.expected?' The carrier expects to deliver it on '+s.expected+'.':'')+(s.link?'\nTrack it: '+s.link:''));
      else lines.push('Shipment '+s.number+' is being prepared and has not left yet.');
    }
    lines.push('');
  }
  if(f.stock.length){
    lines.push('Stock right now:');
    for(const s of f.stock)lines.push('- '+s.name+' ('+s.code+'): '+(s.available>0?s.available+(s.unit?' '+s.unit:'')+' available.':'none available right now.'));
    lines.push('Stock changes as other orders come in, so this is not a promise to hold it.','');
  }
  const title=String(subject||'').replace(/^\s*(?:(?:re|aw|sv|fw|fwd|tr|wg):\s*)+/i,'').trim();
  return {subject:('Re: '+(title||'your question')).slice(0,160),
    body:['Hello '+f.customer.name+',','','Thanks for your message. Here is what our records show.','',...lines,'If anything here does not match what you expected, just reply and we will look into it.',...(sign?['',sign]:[])].join('\n')};
}

// The answer for one email, or why there is none.
async function build(db,workspaceId,m,request){
  const customer=await customerFor(db,workspaceId,m.sender);
  if(!customer)return {hold:'The sender is not exactly one of your customers, so StockChief shared no order or stock details.'};
  if(!/^\S+@\S+\.\S+$/.test(customer.email||''))return {hold:'Add an email address to '+customer.name+' before StockChief answers them.',customer};
  if(request.other.length)return {hold:'The email also asks about '+reader.describe(request.other)+'. A person answers that.',customer};
  const other=await require('../accounting/agent-statement-requests').otherCustomer(db,workspaceId,request.text,customer);
  if(other)return {hold:'The email mentions another customer, '+other+'. StockChief answers each customer only about their own orders.',customer};
  const gathered=await gather(db,workspaceId,customer,request);
  if(gathered.hold)return {hold:gathered.hold,customer};
  const answer=compose(m.subject,gathered.facts,await signature(db,workspaceId));
  return {customer,topics:request.topics,answer,facts:gathered.facts,
    fingerprint:hash({messageId:m.id,customerId:customer.id,recipient:customer.email,topics:request.topics,answer})};
}

// The first time StockChief writes to a customer, a person approves it.
async function known(db,workspaceId,customerId){
  return (await db.query(`SELECT EXISTS(SELECT 1 FROM sales_orders WHERE workspace_id=$1 AND customer_id=$2 AND status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED'))
    OR EXISTS(SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND customer_id=$2 AND status='SENT' AND external_message_id IS NOT NULL) known`,[workspaceId,customerId])).rows[0].known;
}

// Growth is taught by a saved rule (this customer or every customer) or by an
// answer to this customer the owner approved and the mailbox confirmed, each
// covering every topic the email asks about.
async function taught(db,workspaceId,customerId,topics){
  if(!await has(db,TABLE))return false;
  const ruled=(await db.query(`SELECT 1 FROM ${RULES} r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.role='owner'
    WHERE r.workspace_id=$1 AND r.enabled AND (r.customer_id IS NULL OR r.customer_id=$2) AND r.topics@>$3::text[] LIMIT 1`,[workspaceId,customerId,topics])).rowCount;
  if(ruled)return true;
  return Boolean((await db.query(`SELECT 1 FROM ${TABLE} q JOIN users u ON u.workspace_id=q.workspace_id AND u.id=q.approved_by AND u.role='owner'
    JOIN customer_communications m ON m.workspace_id=q.workspace_id AND m.id=q.communication_id
    JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
    WHERE q.workspace_id=$1 AND q.customer_id=$2 AND NOT q.automatic AND q.topics@>$3::text[] AND m.customer_id=$2 AND m.status='SENT' AND m.external_message_id IS NOT NULL
      AND e.payload->'standingAuthority'->>'kind'=$4 AND e.payload->'standingAuthority'->>'automatic'='false' LIMIT 1`,[workspaceId,customerId,topics,mailKind])).rowCount);
}

// Why a written answer waits for a person instead of going out alone.
async function waitReason(db,workspaceId,built,decision){
  if(!decision||decision.mode!=='prepare')return decision?.reason||'Answering customer emails needs the Growth plan or above.';
  if(!await known(db,workspaceId,built.customer.id))return 'This is the first time StockChief would write to '+built.customer.name+', so a person approves it.';
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return 'StockChief is set to ask you first.';
  const ask=await require('../autopilot/job-modes').restriction(db,workspaceId,JOB,true);
  if(ask)return ask;
  if(decision.state.plan==='growth'&&!await taught(db,workspaceId,built.customer.id,built.topics))
    return 'You have not taught StockChief to answer '+built.customer.name+' about '+reader.describe(built.topics)+' yet, so it waits for your approval.';
  if(!policy.permits(decision.state.plan,JOB,'automatic',{trained:true}))return 'Your plan asks you to approve each answer.';
  const quota=await require('../commercial/agent-rule-quota').restriction(db,decision.state);
  if(quota)return quota;
  const box=await require('./customer-mailbox').resolve(db,workspaceId);
  return box.reason||null;
}

// Checked when an answer is queued and again at the mailbox, just before it
// is sent: the same owner authority, the same records, the same mailbox.
async function authority(db,workspaceId,p){
  if(p?.kind!==mailKind)throw new ValidationError('Review this customer answer before sending.');
  const ctx={workspaceId,actorId:p.actorId};await owner(db,ctx);
  const state=await policy.requireWorkspaceJob(db,workspaceId,JOB,'draft');
  const stop=await stopped(db,workspaceId,state,p.automatic===true);
  if(stop)throw new ValidationError(stop);
  const m=(await db.query('SELECT * FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[workspaceId,p.messageId])).rows[0];
  if(!m||m.reply_sent_at||m.reply_state!=='NEEDS_REPLY')throw new ValidationError('This email was already answered or filed, so StockChief did not send another answer.');
  if((await db.query(`SELECT 1 FROM stockchief_runtime.email_reply_outbox WHERE workspace_id=$1 AND message_id=$2 AND status IN ('PENDING','SENDING','SENT','AMBIGUOUS') LIMIT 1`,[workspaceId,m.id])).rowCount)
    throw new ValidationError('A reply to this email is already on its way, so StockChief did not send another answer.');
  const request=reader.read(m.subject,m.body_text);
  if(!request)throw new ValidationError('This email no longer reads as a question StockChief answers.');
  const built=await build(db,workspaceId,m,request);
  if(built.hold)throw new ValidationError(built.hold);
  if(built.fingerprint!==p.sourceFingerprint||built.customer.id!==p.customerId||built.customer.email!==p.recipient)
    throw new ValidationError('The records changed since this answer was written. Review the current answer before sending.');
  const box=await require('./customer-mailbox').resolve(db,workspaceId);
  if(box.reason)throw new ValidationError(box.reason);
  if(box.box.id!==p.connectorId||box.box.provider_account_id!==p.mailboxAccount)throw new ValidationError('The mailbox for customer messages changed. Review the answer before sending.');
  if(p.automatic===true){
    const why=await waitReason(db,workspaceId,built,await decide(db,workspaceId));
    if(why)throw new ValidationError(why);
  }
  const saved=(await db.query('SELECT subject,body,recipient,connector_id FROM customer_communications WHERE workspace_id=$1 AND idempotency_key=$2',[workspaceId,key(m.id)])).rows[0];
  if(saved&&(saved.subject!==built.answer.subject||saved.body!==built.answer.body||saved.recipient!==p.recipient||saved.connector_id!==p.connectorId))
    throw new ValidationError('The queued answer differs from the current records. Review it before sending.');
  return built;
}

async function record(c,workspaceId,messageId,f){
  await c.query(`INSERT INTO ${TABLE}(workspace_id,message_id,customer_id,sender,subject,topics,status,reason,answer_subject,answer_body,fingerprint,communication_id,automatic,approved_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(workspace_id,message_id) DO UPDATE SET customer_id=coalesce(EXCLUDED.customer_id,agent_customer_questions.customer_id),
      status=EXCLUDED.status,reason=EXCLUDED.reason,answer_subject=coalesce(EXCLUDED.answer_subject,agent_customer_questions.answer_subject),
      answer_body=coalesce(EXCLUDED.answer_body,agent_customer_questions.answer_body),fingerprint=coalesce(EXCLUDED.fingerprint,agent_customer_questions.fingerprint),
      communication_id=coalesce(EXCLUDED.communication_id,agent_customer_questions.communication_id),automatic=EXCLUDED.automatic,
      approved_by=coalesce(EXCLUDED.approved_by,agent_customer_questions.approved_by),updated_at=clock_timestamp()`,
  [workspaceId,messageId,f.customerId||null,f.sender,f.subject?String(f.subject).slice(0,300):null,f.topics,f.status,f.reason?String(f.reason).slice(0,500):null,
    f.answer?.subject||null,f.answer?.body||null,f.fingerprint||null,f.communicationId||null,Boolean(f.automatic),f.approvedBy||null]);
}

// Queue the answer through the ordinary customer message path, to the
// customer's address on file, from the chosen customer mailbox.
async function send(db,ctx,m,built,{automatic,box}){
  const grant={kind:mailKind,messageId:m.id,customerId:built.customer.id,recipient:built.customer.email,connectorId:box.id,mailboxAccount:box.provider_account_id,
    providerType:box.provider_type,topics:built.topics,sourceFingerprint:built.fingerprint,actorId:ctx.actorId,automatic,
    ...(box.id===m.connector_id&&m.external_thread_id?{threadId:m.external_thread_id}:{})};
  return tx(db,async c=>{
    const fresh=await authority(c,ctx.workspaceId,grant);
    const prior=(await c.query('SELECT id,status FROM customer_communications WHERE workspace_id=$1 AND idempotency_key=$2',[ctx.workspaceId,key(m.id)])).rows[0];
    if(prior)throw new ValidationError('StockChief already queued an answer to this email. Review its delivery, or reply yourself.');
    const r=await require('../connections/postgres-outbound-mail').queueInTransaction(c,ctx,{recipientKind:'customer',recipientId:fresh.customer.id,recipientEmail:fresh.customer.email,
      connectorId:box.id,...fresh.answer,standingAuthority:grant},key(m.id),{agentRequested:true,agentJob:JOB});
    await record(c,ctx.workspaceId,m.id,{customerId:fresh.customer.id,sender:m.sender,subject:m.subject,topics:fresh.topics,status:'QUEUED',answer:fresh.answer,
      fingerprint:fresh.fingerprint,communicationId:r.communicationId,automatic,approvedBy:automatic?null:ctx.actorId});
    await audit(c,ctx,{action:automatic?'Customer question answered by StockChief':'Customer answer approved and queued',reference:fresh.customer.name,
      after:{messageId:m.id,topics:fresh.topics,recipient:fresh.customer.email,communicationId:r.communicationId,mailbox:box.id}});
    return r;
  });
}

async function hold(db,workspaceId,actorId,m,request,f,status='HELD'){
  await tx(db,async c=>{
    await record(c,workspaceId,m.id,{sender:m.sender,subject:m.subject,topics:request.topics,...f,status});
    await audit(c,{workspaceId,actorId},{action:status==='WATCHED'?'Customer question watched':status==='DRAFTED'?'Customer answer written for approval':'Customer question stopped for a person',
      reference:m.sender,after:{messageId:m.id,customerId:f.customerId||null,topics:request.topics,reason:f.reason}});
  });
  return {held:status==='HELD',watched:status==='WATCHED',drafted:status==='DRAFTED',reason:f.reason};
}

// The worker for a captured customer email. One outcome per email.
async function fromEmail(db,workspaceId,id){
  if(!await has(db,TABLE))return {skipped:true};
  const m=(await db.query('SELECT * FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
  if(!m||m.classification!=='customer'||m.trust_status!=='TRUSTED')return {skipped:true};
  const request=reader.read(m.subject,m.body_text);
  if(!request)return {skipped:true};
  const prior=(await db.query(`SELECT status,reason FROM ${TABLE} WHERE workspace_id=$1 AND message_id=$2`,[workspaceId,id])).rows[0];
  if(prior)return {replayed:true,status:prior.status,reason:prior.reason};
  if(m.reply_sent_at||m.reply_state!=='NEEDS_REPLY')return {skipped:true,reason:'Someone already answered or filed this email.'};
  const decision=await decide(db,workspaceId);
  if(decision.mode==='skip')return {skipped:true};
  const ownerId=await require('./agent-customer-orders').ownerUser(db,workspaceId);
  if(!ownerId)return {skipped:true};
  const built=await build(db,workspaceId,m,request);
  if(built.hold)return hold(db,workspaceId,ownerId,m,request,{customerId:built.customer?.id,reason:built.hold});
  const fields={customerId:built.customer.id,answer:built.answer,fingerprint:built.fingerprint};
  if(decision.mode==='watch')return hold(db,workspaceId,ownerId,m,request,{...fields,reason:decision.reason+' It would have answered '+built.customer.name+' from your records.'},'WATCHED');
  let why=await waitReason(db,workspaceId,built,decision);
  if(!why){
    try{
      const box=await require('./customer-mailbox').resolve(db,workspaceId);
      const r=await send(db,{workspaceId,actorId:ownerId},m,built,{automatic:true,box:box.box});
      return {queued:true,communicationId:r.communicationId,effectId:r.effectId};
    }catch(error){if(!expected(error))throw error;why=error.message;}
  }
  return hold(db,workspaceId,ownerId,m,request,{...fields,reason:why},'DRAFTED');
}

// The mailbox confirmed it: the email is answered and waits on the customer.
async function accepted(c,workspaceId,p,communicationId,at,externalMessageId){
  await c.query(`UPDATE connection_email_messages SET reply_state='WAITING',reply_reason='StockChief answered from your records; waiting on them.',
    reply_state_by_user_id=$3,reply_state_at=$4,reply_sent_at=$4,reply_external_message_id=$5 WHERE workspace_id=$1 AND id=$2 AND reply_sent_at IS NULL`,
  [workspaceId,p.messageId,p.actorId,at,externalMessageId||null]);
  if(await has(c,TABLE))await c.query(`UPDATE ${TABLE} SET status='SENT',updated_at=clock_timestamp() WHERE workspace_id=$1 AND message_id=$2 AND communication_id=$3`,[workspaceId,p.messageId,communicationId]);
}

async function question(db,workspaceId,id){
  const row=(await db.query(`SELECT q.*,c.name customer_name,c.email customer_email,m.status message_status,m.error_message message_error,e.subject email_subject,e.body_text,e.received_at,e.reply_sent_at,e.reply_state
    FROM ${TABLE} q JOIN connection_email_messages e ON e.workspace_id=q.workspace_id AND e.id=q.message_id
    LEFT JOIN customers c ON c.workspace_id=q.workspace_id AND c.id=q.customer_id
    LEFT JOIN customer_communications m ON m.workspace_id=q.workspace_id AND m.id=q.communication_id WHERE q.workspace_id=$1 AND q.message_id=$2`,[workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That customer question was not found.');
  return row;
}

// A person approves the written answer. If the records changed, the answer is
// rewritten and shown again instead of being sent.
async function approve(db,ctx,id,input={}){
  if(input.confirmed!=='yes')throw new ValidationError('Confirm the recipient and the exact answer before sending.');
  await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  const row=await question(db,ctx.workspaceId,id);
  if(!['DRAFTED','WATCHED'].includes(row.status))throw new ValidationError('This answer is no longer waiting for you.');
  const m=(await db.query('SELECT * FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
  const request=reader.read(m.subject,m.body_text);
  const built=request?await build(db,ctx.workspaceId,m,request):{hold:'This email no longer reads as a question StockChief answers.'};
  if(built.hold){await hold(db,ctx.workspaceId,ctx.actorId,m,request||{topics:row.topics},{customerId:built.customer?.id,reason:built.hold});throw new ValidationError(built.hold);}
  if(built.fingerprint!==input.expectedFingerprint){
    await tx(db,c=>record(c,ctx.workspaceId,id,{customerId:built.customer.id,sender:m.sender,subject:m.subject,topics:built.topics,status:row.status,reason:row.reason,answer:built.answer,fingerprint:built.fingerprint}));
    throw new ValidationError('The records changed since this answer was written. Review the updated answer before sending.');
  }
  const box=await require('./customer-mailbox').resolve(db,ctx.workspaceId);
  if(box.reason)throw new ValidationError(box.reason);
  return send(db,ctx,m,built,{automatic:false,box:box.box});
}

async function dismiss(db,ctx,id){
  return tx(db,async c=>{
    await owner(c,ctx);
    const row=(await c.query(`UPDATE ${TABLE} SET status='DISMISSED',updated_at=clock_timestamp() WHERE workspace_id=$1 AND message_id=$2 AND status IN ('HELD','WATCHED','DRAFTED') RETURNING sender,status`,[ctx.workspaceId,id])).rows[0];
    if(!row)throw new ValidationError('This question is no longer waiting for you.');
    await audit(c,ctx,{action:'Customer question dismissed',reference:row.sender,after:{messageId:id,status:'DISMISSED'}});
  });
}

// Growth rules: which questions StockChief answers alone, for one customer or all.
function topicsFrom(value){
  const topics=[...new Set((Array.isArray(value)?value:String(value||'').split(',')).map(v=>String(v).trim()).filter(Boolean))];
  if(!topics.length||topics.some(t=>!reader.TOPICS.includes(t)))throw new ValidationError('Choose stock, delivery dates or order status.');
  return reader.TOPICS.filter(t=>topics.includes(t));
}
async function saveRule(db,ctx,input={}){
  return tx(db,async c=>{
    await owner(c,ctx);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    if(policy.allowance(state.plan,JOB)!=='trained')throw new ValidationError('Your plan answers these questions without teaching. Use the job mode to ask first or watch only.');
    const topics=topicsFrom(input.topics),reference=String(input.customer||'').trim();
    let customer=null;
    if(reference){
      const rows=(await c.query("SELECT id,name FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' AND (lower(name)=lower($2) OR lower(email)=lower($2)) LIMIT 2",[ctx.workspaceId,reference.slice(0,150)])).rows;
      if(rows.length!==1)throw new ValidationError('Choose one exact customer name or email, or leave it empty for every customer.');
      customer=rows[0];
    }
    const prior=(await c.query(`SELECT * FROM ${RULES} WHERE workspace_id=$1 AND coalesce(customer_id,'')=$2 FOR UPDATE`,[ctx.workspaceId,customer?.id||''])).rows[0];
    // Saving for the same customer again replaces its topics; an edit of a
    // loaded rule must still be the current revision.
    if(prior&&input.revision!=null&&input.revision!==''&&Number(input.revision)!==prior.revision)throw new ValidationError('This rule changed. Reload before saving.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    if(prior)await c.query(`UPDATE ${RULES} SET topics=$3,enabled=true,authorized_by=$4,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,prior.id,topics,ctx.actorId]);
    else await c.query(`INSERT INTO ${RULES}(workspace_id,id,customer_id,topics,authorized_by) VALUES($1,$2,$3,$4,$5)`,[ctx.workspaceId,require('../lib/util').newId('answer-rule'),customer?.id||null,topics,ctx.actorId]);
    await audit(c,ctx,{action:'Customer answer rule saved',reference:customer?.name||'Every customer',before:prior?{topics:prior.topics}:{},after:{topics}});
  });
}
async function removeRule(db,ctx,id){
  return tx(db,async c=>{
    await owner(c,ctx);
    const row=(await c.query(`DELETE FROM ${RULES} WHERE workspace_id=$1 AND id=$2 RETURNING topics,customer_id`,[ctx.workspaceId,id])).rows[0];
    if(!row)throw new ValidationError('This rule was already removed.');
    await audit(c,ctx,{action:'Customer answer rule removed',reference:row.customer_id||'Every customer',before:{topics:row.topics}});
  });
}

const OUTCOME=r=>r.status==='DISMISSED'?'Dismissed':r.status==='WATCHED'?'Watched only':r.status==='HELD'?'Stopped for you':r.status==='DRAFTED'?'Waiting for your approval':
  r.message_status==='SENT'||r.status==='SENT'?'Sent':r.message_status==='FAILED'?'Not sent':'Sending';

// Needs you: answers to approve, and questions StockChief stopped on.
async function inbox(db,workspaceId){
  if(!await has(db,TABLE))return [];
  const rows=(await db.query(`SELECT q.*,c.name customer_name,m.status message_status FROM ${TABLE} q
    JOIN connection_email_messages e ON e.workspace_id=q.workspace_id AND e.id=q.message_id
    LEFT JOIN customers c ON c.workspace_id=q.workspace_id AND c.id=q.customer_id
    LEFT JOIN customer_communications m ON m.workspace_id=q.workspace_id AND m.id=q.communication_id
    WHERE q.workspace_id=$1 AND (q.status IN ('HELD','WATCHED','DRAFTED') AND e.reply_sent_at IS NULL AND e.reply_state='NEEDS_REPLY' OR q.status='QUEUED' AND m.status='FAILED')
    ORDER BY q.updated_at DESC,q.message_id LIMIT 20`,[workspaceId])).rows;
  return rows.map(r=>{const who=r.customer_name||r.sender,about=reader.describe(r.topics);
    return {kind:'sales',importance:'Needs You',priority:r.status==='DRAFTED'?82:r.status==='WATCHED'?60:80,
      title:r.status==='DRAFTED'?'Answer ready for '+who:r.status==='WATCHED'?'StockChief watched a question from '+who:r.status==='QUEUED'?'Answer to '+who+' was not sent':'Question from '+who+' needs you',
      happened:who+' asked about '+about+(r.subject?' in “'+r.subject+'”':'')+'.'+(r.status==='DRAFTED'?' StockChief wrote the answer from your records. Nothing was sent.':r.status==='QUEUED'?' The mailbox did not send the answer.':' Nothing was sent.'),
      why:r.reason||'A person decides what to send.',recommendation:r.status==='DRAFTED'?'Read the answer, then send it or reply yourself.':'Read the email, then reply yourself or dismiss it.',
      href:'/autopilot/customer-questions/'+encodeURIComponent(r.message_id),actionLabel:r.status==='DRAFTED'?'Review answer':'Review question',
      sourceId:'customer-question:'+r.message_id,createdAt:r.updated_at,timeLabel:'Received',at:r.updated_at};});
}

// The review page (job 72): recent questions and, on Growth, the taught rules.
async function review(db,ctx,{page=1}={}){
  const state=await policy.accountState(db,ctx.workspaceId),training=policy.usesAgentTerms(state)&&policy.allowance(state.plan,JOB)==='trained';
  const summary='When a customer emails about stock, a delivery date or their order, StockChief answers from your records: only their own orders and shipments, and the stock available now. It never names a delivery date nobody recorded. '+
    (training?'Growth waits for your approval until you teach it, by a rule below or by sending an answer it wrote.':'Pro and Custom send on their own.')+
    ' Anything else the email asks, and the first email to a customer, waits for you.';
  if(!await has(db,TABLE))return {summary:'Customer answers are being upgraded. Try again shortly.',rows:[],more:false};
  const rows=(await db.query(`SELECT q.*,c.name customer_name,m.status message_status FROM ${TABLE} q
    LEFT JOIN customers c ON c.workspace_id=q.workspace_id AND c.id=q.customer_id
    LEFT JOIN customer_communications m ON m.workspace_id=q.workspace_id AND m.id=q.communication_id
    WHERE q.workspace_id=$1 ORDER BY q.updated_at DESC,q.message_id LIMIT 101 OFFSET $2`,[ctx.workspaceId,(Math.max(1,Number(page)||1)-1)*100])).rows;
  const rules=training?(await db.query(`SELECT r.*,c.name customer_name FROM ${RULES} r LEFT JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id
    WHERE r.workspace_id=$1 ORDER BY c.name NULLS FIRST,r.id LIMIT 100`,[ctx.workspaceId])).rows:[];
  return {summary,more:rows.length>100,
    rows:rows.slice(0,100).map(r=>({Customer:r.customer_name||r.sender,'Asked about':reader.describe(r.topics),Outcome:OUTCOME(r)+(r.automatic?' by StockChief':''),link:'/autopilot/customer-questions/'+encodeURIComponent(r.message_id)})),
    customerQuestionForm:{training,rules:rules.map(r=>({id:r.id,who:r.customer_name||'Every customer',about:reader.describe(r.topics),revision:r.revision})),
      topics:reader.TOPICS.map(t=>({value:t,label:{stock:'Stock',delivery:'Delivery dates',status:'Order status'}[t]}))}};
}

// One question: the email, what StockChief wrote and what happened to it.
async function page(db,ctx,id){
  await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  const row=await question(db,ctx.workspaceId,id);
  const box=await require('./customer-mailbox').resolve(db,ctx.workspaceId);
  return {question:{...row,about:reader.describe(row.topics),outcome:OUTCOME(row),words:require('../accounting/statement-request').own(row.body_text).slice(0,3000)},
    canSend:['DRAFTED','WATCHED'].includes(row.status)&&Boolean(row.answer_body)&&!row.reply_sent_at&&row.reply_state==='NEEDS_REPLY',
    mailbox:box.box?(await db.query('SELECT display_name FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,box.box.id])).rows[0]?.display_name:null,mailboxProblem:box.reason||null,
    canDismiss:['HELD','WATCHED','DRAFTED'].includes(row.status)};
}

module.exports={queue,read:reader.read,decide,build,customerFor,owner,waitReason,authority,accepted,fromEmail,approve,dismiss,saveRule,removeRule,taught,inbox,review,page,kind,mailKind,
  definition:{id:JOB,key:'customer-questions',label:'Answer customer emails about stock, delivery and orders',readPage:review}};

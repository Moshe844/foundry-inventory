'use strict';
// Shared authority for customer orders StockChief makes on its own: job 52
// (orders read from customer emails, PDFs and spreadsheets) and job 53
// (repeating a customer's usual order). It decides whether this plan and the
// owner's settings let StockChief create and confirm the order, prepare it for
// approval, or only watch; it holds the owner's limits and the customer's own
// product codes; and it confirms through the ordinary order path.
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {has}=require('../db/schema-installed');
const exact=require('../domain/exact-quantity');

const CONFIRMED=['CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED'];
const path='/autopilot/customer-orders';
const audit=(c,ctx,entry)=>require('../operations/postgres-security-audit').record(c,ctx,entry);

async function ownerUser(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.role='owner' ORDER BY u.created_at,u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}
async function requireOwner(db,ctx){
  const row=(await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the business owner can change how StockChief handles customer orders.');
  return policy.accountState(db,ctx.workspaceId);
}

async function limits(db,workspaceId){
  if(!await has(db,'stockchief_runtime.agent_customer_order_limits'))return null;
  const row=(await db.query(`SELECT l.* FROM stockchief_runtime.agent_customer_order_limits l
    JOIN users u ON u.workspace_id=l.workspace_id AND u.id=l.authorized_by AND u.role='owner' WHERE l.workspace_id=$1`,[workspaceId])).rows[0];
  return row?{enabled:row.enabled,currency:row.currency,maximumMinor:Number(row.maximum_minor),maximumUnits:Number(row.maximum_units),
    revision:row.revision,authorizedBy:row.authorized_by}:null;
}
function canAutomate(plan){return policy.permits(plan,52,'automatic')||policy.permits(plan,53,'automatic',{trained:true});}

async function configure(db,ctx,input){
  return db.transaction(async c=>{
    const state=await requireOwner(c,ctx);
    const plan=policy.usesAgentTerms(state)?state.plan:null;
    if(!canAutomate(plan))policy.requireJob(plan,52,'automatic');
    const prior=(await c.query('SELECT * FROM stockchief_runtime.agent_customer_order_limits WHERE workspace_id=$1 FOR UPDATE',[ctx.workspaceId])).rows[0];
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Your limits changed. Reload the page before saving.');
    const enabled=input.enabled!=='no';
    const currency=prior?.currency||(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.base_currency||'USD';
    const maximum=money.userToMinor(input.maximum,currency,{label:'Largest order'});
    const units=Number(String(input.maximumUnits??'').trim());
    if(maximum<=0)throw new ValidationError('Set the largest order total StockChief may confirm on its own.');
    if(!Number.isFinite(units)||units<=0||units>100000000)throw new ValidationError('Set the most units one order may have.');
    if(enabled&&!prior?.enabled)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    if(prior)await c.query(`UPDATE stockchief_runtime.agent_customer_order_limits SET enabled=$2,maximum_minor=$3,maximum_units=$4,authorized_by=$5,
      revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1`,[ctx.workspaceId,enabled,maximum,units,ctx.actorId]);
    else await c.query(`INSERT INTO stockchief_runtime.agent_customer_order_limits(workspace_id,enabled,currency,maximum_minor,maximum_units,authorized_by)
      VALUES($1,$2,$3,$4,$5,$6)`,[ctx.workspaceId,enabled,currency,maximum,units,ctx.actorId]);
    await audit(c,ctx,{action:'Customer order limits changed',reference:'customer-orders',
      before:prior?{enabled:prior.enabled,maximumMinor:Number(prior.maximum_minor),maximumUnits:Number(prior.maximum_units)}:{},
      after:{enabled,currency,maximumMinor:maximum,maximumUnits:units}});
    return {enabled};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// The customer's own product codes, as they write them on their orders.
async function saveCode(db,ctx,input){
  return db.transaction(async c=>{
    const state=await requireOwner(c,ctx);
    policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,52,'draft');
    const code=String(input.code||'').trim();
    if(!code||code.length>80||/\s/.test(code))throw new ValidationError('Enter the customer’s code exactly as they write it, without spaces.');
    const customer=(await c.query("SELECT id,name FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'",[ctx.workspaceId,input.customerId])).rows[0];
    if(!customer)throw new ValidationError('Choose an active customer.');
    const sku=(await c.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND is_active=1 AND (id=$2 OR lower(code)=lower($2)) LIMIT 2',[ctx.workspaceId,String(input.sku||'').trim()])).rows;
    if(sku.length!==1)throw new ValidationError('Choose one of your active products by its code.');
    const saved=await c.query(`INSERT INTO stockchief_runtime.agent_customer_item_codes(workspace_id,customer_id,code,code_key,sku_id,created_by)
      VALUES($1,$2,$3,lower($3),$4,$5) ON CONFLICT DO NOTHING`,[ctx.workspaceId,customer.id,code,sku[0].id,ctx.actorId]);
    if(!saved.rowCount)throw new ValidationError(customer.name+' already has the code '+code+'. Remove it first to point it at another product.');
    await audit(c,ctx,{action:'Customer product code added',reference:customer.id,after:{code,skuId:sku[0].id,sku:sku[0].code}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function removeCode(db,ctx,input){
  return db.transaction(async c=>{
    await requireOwner(c,ctx);
    const gone=(await c.query(`DELETE FROM stockchief_runtime.agent_customer_item_codes WHERE workspace_id=$1 AND customer_id=$2 AND code_key=lower($3)
      RETURNING code,sku_id`,[ctx.workspaceId,input.customerId,String(input.code||'')])).rows[0];
    if(!gone)throw new ValidationError('That code was already removed.');
    await audit(c,ctx,{action:'Customer product code removed',reference:input.customerId,before:{code:gone.code,skuId:gone.sku_id}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Every product the written code can mean: our code, the customer's own code
// or a barcode. More than one product is a question, never a guess.
async function identify(db,workspaceId,customerId,codes){
  const keys=[...new Set(codes.map(c=>String(c).toLowerCase()))];
  const own=await has(db,'stockchief_runtime.agent_customer_item_codes');
  const rows=(await db.query(`SELECT lower(s.code) AS key,s.id,s.code,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE s.workspace_id=$1 AND s.is_active=1 AND lower(s.code)=ANY($2::text[])
    UNION SELECT lower(s.barcode),s.id,s.code,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE s.workspace_id=$1 AND s.is_active=1 AND s.barcode IS NOT NULL AND lower(s.barcode)=ANY($2::text[])
    UNION SELECT lower(a.barcode),s.id,s.code,i.name FROM warehouse_barcode_aliases a JOIN skus s ON s.workspace_id=a.workspace_id AND s.id=a.target_id
      JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE a.workspace_id=$1 AND a.target_kind='sku' AND s.is_active=1 AND lower(a.barcode)=ANY($2::text[])
    ${own?`UNION SELECT k.code_key,s.id,s.code,i.name FROM stockchief_runtime.agent_customer_item_codes k JOIN skus s ON s.workspace_id=k.workspace_id AND s.id=k.sku_id
      JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE k.workspace_id=$1 AND k.customer_id=$3 AND s.is_active=1 AND k.code_key=ANY($2::text[])`:''}`,
  own?[workspaceId,keys,customerId]:[workspaceId,keys])).rows;
  const found=new Map();
  for(const key of keys){
    const matches=[...new Map(rows.filter(r=>r.key===key).map(r=>[r.id,r])).values()];
    if(!matches.length)throw new ValidationError('StockChief does not know the product code “'+codes.find(c=>String(c).toLowerCase()===key)+
      '”. Add it as this customer’s own code on the customer orders page, or enter the order yourself.');
    if(matches.length>1)throw new ValidationError('The code “'+codes.find(c=>String(c).toLowerCase()===key)+'” matches '+matches.map(m=>m.code).join(' and ')+
      '. Review the original and enter the order yourself.');
    found.set(key,matches[0]);
  }
  return found;
}

// May StockChief do this alone now, only prepare a draft, or only watch?
// trained: the Growth job 53 rule or completed example for this order.
async function decide(db,workspaceId,job,{trained=false,untaught=null}={}){
  const state=await policy.accountState(db,workspaceId);
  const plan=policy.usesAgentTerms(state)?state.plan:null;
  if(!plan||!policy.permits(plan,job,'draft'))return {mode:'skip',state};
  if(state.shadow)return {mode:'watch',state,reason:'StockChief is watching during its first 14 days and did not create this order.'};
  const autopilot=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(autopilot.mode==='OBSERVE')return {mode:'watch',state,reason:'StockChief is set to Watch only and did not create this order.'};
  if(autopilot.paused||autopilot.suspended)return {mode:'watch',state,reason:'Automatic work is paused, so StockChief did not create this order.'};
  const modes=require('../autopilot/job-modes');
  const watch=await modes.restriction(db,workspaceId,job,false);
  if(watch)return {mode:'watch',state,reason:watch};
  if(!policy.permits(plan,job,'automatic',{trained}))return {mode:'draft',state,reason:policy.allowance(plan,job)==='trained'
    ?untaught||'You have not taught StockChief this customer’s repeat order yet, so it waits for your approval.':'On your plan StockChief prepares customer orders for your approval.'};
  if(!autopilot.canAutomate)return {mode:'draft',state,reason:'StockChief is set to ask you first.'};
  const ask=await modes.restriction(db,workspaceId,job,true);
  if(ask)return {mode:'draft',state,reason:ask};
  const quota=await require('../commercial/agent-rule-quota').restriction(db,state);
  if(quota)return {mode:'draft',state,reason:quota};
  const limit=await limits(db,workspaceId);
  if(limit&&!limit.enabled)return {mode:'draft',state,reason:'You asked StockChief to wait for you on every customer order.'};
  // A taught Growth repeat is bounded by its own rule or example; the shared
  // limits still apply when the owner has saved them.
  if(!limit&&policy.allowance(plan,job)!=='trained')return {mode:'draft',state,reason:'Save your limits for customer orders before StockChief confirms them on its own.'};
  return {mode:'automatic',state,limit,actorId:limit?.authorizedBy||null};
}

function overLimit(limit,{currency,totalMinor,units}){
  if(!limit)return null;
  if(currency!==limit.currency)return 'This order is in '+currency+'; your limit is in '+limit.currency+'.';
  if(totalMinor>limit.maximumMinor)return 'This order is '+money.format(totalMinor,currency)+', over your limit of '+money.format(limit.maximumMinor,currency)+' an order.';
  if(units>limit.maximumUnits)return 'This order has '+units+' units, over your limit of '+limit.maximumUnits+' units an order.';
  return null;
}
const units=lines=>Number(exact.canonical(lines.reduce((n,l)=>exact.add(n,String(l.quantity)),'0')));

// "First time with a new B2B customer, or a new ship-to address" (page 13).
async function needsPerson(db,workspaceId,customerId,{pickup,address}){
  const known=(await db.query(`SELECT bool_or(true) AS any,bool_or($3 OR (o.delivery_method='SHIP' AND lower(trim(o.ship_to_address))=lower(trim($4::text)))) AS same
    FROM sales_orders o WHERE o.workspace_id=$1 AND o.customer_id=$2 AND o.status=ANY($5::text[])
      AND coalesce(o.customer_decision_required,0)=0 AND coalesce(o.delivery_decision_required,0)=0`,
  [workspaceId,customerId,Boolean(pickup),address||null,CONFIRMED])).rows[0];
  if(!known?.any)return 'This is the first order from this customer. A person checks a new customer’s first order.';
  if(!known.same)return 'This order goes to a delivery address this customer has not used before. A person checks new addresses.';
  return null;
}

// The order checks (job 54) StockChief can settle before confirming alone.
async function confirmProblems(c,ctx,orderId){
  const order=(await c.query('SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,orderId])).rows[0];
  if(order.delivery_method==='SHIP'&&!require('../shipping/address').parse(order.ship_to_address).complete)
    return 'The delivery address is not complete. Check it before confirming.';
  const today=await require('../lib/business-time').today(c,ctx.workspaceId);
  const debt=(await c.query(`SELECT count(*) FILTER(WHERE i.due_date<$3) AS late,coalesce(sum(i.balance_minor) FILTER(WHERE i.currency=$4),0) AS owed
    FROM accounting_customer_invoices i WHERE i.workspace_id=$1 AND i.customer_id=$2 AND i.status IN ('OPEN','PARTIALLY_PAID') AND i.balance_minor>0`,
  [ctx.workspaceId,order.customer_id,today,order.currency])).rows[0];
  if(Number(debt.late))return 'This customer has an overdue invoice. Check their balance before confirming.';
  const terms=(await c.query(`SELECT credit_limit_minor FROM customer_payment_terms WHERE workspace_id=$1 AND (customer_id=$2 OR customer_id IS NULL)
    ORDER BY (customer_id IS NOT NULL) DESC LIMIT 1`,[ctx.workspaceId,order.customer_id])).rows[0];
  const total=Number((await c.query('SELECT coalesce(sum(quantity_ordered*unit_price_minor),0) AS n FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2',
    [ctx.workspaceId,orderId])).rows[0].n)-Number(order.discount_minor)+Number(order.tax_minor);
  if(terms?.credit_limit_minor!=null&&Number(debt.owed)+total>Number(terms.credit_limit_minor))
    return 'This order would take the customer over their credit limit.';
  return null;
}

// Confirm through the ordinary order path: order checks, reservations and
// warehouse routing. A problem leaves the draft for a person.
async function confirm(c,ctx,orderId,key){
  const problem=await confirmProblems(c,ctx,orderId);
  if(problem)return {held:problem};
  await c.query('SAVEPOINT agent_customer_order_confirm');
  try{
    const done=await require('../operations/postgres-business-workflows').confirmSalesOrderInTransaction(c,ctx,orderId,{idempotencyKey:key});
    await c.query('RELEASE SAVEPOINT agent_customer_order_confirm');
    return {status:done.status,shortage:done.shortage};
  }catch(error){
    if(![400,402,403,404,409,422].includes(error.status))throw error;
    await c.query('ROLLBACK TO SAVEPOINT agent_customer_order_confirm');
    return {held:error.message};
  }
}

// Undo an order StockChief confirmed on its own: cancel it through the ordinary
// path before anything has shipped. The person pressing Undo is the one cancelling.
async function undo(db,ctx,kind,id){
  return db.transaction(async c=>{
    await requireOwner(c,ctx);
    const table=kind==='repeat'?'stockchief_runtime.agent_repeat_orders':kind==='text'?'stockchief_runtime.agent_customer_text_orders':'stockchief_runtime.agent_customer_email_orders';
    const key=kind==='email'?'message_id':'id';
    if(!await has(c,table))throw new ValidationError('This order was not created by StockChief.');
    const row=(await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND ${key}=$2 FOR UPDATE`,[ctx.workspaceId,id])).rows[0];
    if(!row?.automatic||!row.sales_order_id)throw new ValidationError('Only orders StockChief created on its own can be undone here.');
    if(row.status==='UNDONE')return {replayed:true,salesOrderId:row.sales_order_id};
    const order=(await c.query('SELECT order_number,status FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,row.sales_order_id])).rows[0];
    if((await c.query('SELECT 1 FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2 AND quantity_fulfilled>0 LIMIT 1',[ctx.workspaceId,row.sales_order_id])).rowCount)
      throw new ValidationError(order.order_number+' has already shipped in part. Process a return instead.');
    await require('../operations/postgres-business-workflows').cancelSalesOrderInTransaction(c,ctx,row.sales_order_id,
      {idempotencyKey:'agent-customer-order-undo:'+row.sales_order_id,reason:'Undone: StockChief created this order on its own.'});
    await c.query(`UPDATE ${table} SET status='UNDONE',updated_at=clock_timestamp() WHERE workspace_id=$1 AND ${key}=$2`,[ctx.workspaceId,id]);
    await audit(c,ctx,{action:'Customer order created by StockChief undone',reference:order.order_number,before:{status:order.status},after:{status:'CANCELLED'}});
    return {salesOrderId:row.sales_order_id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Everything StockChief did or is waiting on, newest first.
// show: 'all', 'waiting' (a person must act) or 'done' (everything else).
async function work(db,workspaceId,{show='all',limit=100,offset=0,jobs=null}={}){
  const email=(!jobs||jobs.includes(52))&&await has(db,'stockchief_runtime.agent_customer_email_orders');
  const repeat=(!jobs||jobs.includes(53))&&await has(db,'stockchief_runtime.agent_repeat_orders');
  const text=(!jobs||jobs.includes(83))&&await has(db,'stockchief_runtime.agent_customer_text_orders');
  if(!email&&!repeat&&!text)return [];
  const parts=[];
  if(email)parts.push(`SELECT 52 AS job,w.message_id AS id,w.message_id,w.customer_id,w.status,w.reason,w.sales_order_id,w.automatic,w.total_minor,w.currency,
      NULL::text AS reading,w.updated_at,m.sender,m.subject FROM stockchief_runtime.agent_customer_email_orders w
      JOIN connection_email_messages m ON m.workspace_id=w.workspace_id AND m.id=w.message_id WHERE w.workspace_id=$1`);
  if(repeat)parts.push(`SELECT 53,r.id,r.message_id,r.customer_id,r.status,r.reason,r.sales_order_id,r.automatic,r.total_minor,r.currency,
      r.reading,r.updated_at,m.sender,m.subject FROM stockchief_runtime.agent_repeat_orders r
      LEFT JOIN connection_email_messages m ON m.workspace_id=r.workspace_id AND m.id=r.message_id WHERE r.workspace_id=$1`);
  // Job 83: orders sent by text message or WhatsApp. A message still being
  // read, or dismissed by a person, is not shown.
  if(text)parts.push(`SELECT 83,t.id,NULL::text,t.customer_id,t.status,t.reason,t.sales_order_id,t.automatic,t.total_minor,t.currency,
      NULL::text,t.updated_at,t.sender,NULL::text FROM stockchief_runtime.agent_customer_text_orders t
      WHERE t.workspace_id=$1 AND t.status NOT IN ('RECEIVED','STOPPED')`);
  const rows=(await db.query(`SELECT w.*,c.name AS customer,o.order_number,o.status AS order_status FROM (${parts.join(' UNION ALL ')}) w
    LEFT JOIN customers c ON c.workspace_id=$1 AND c.id=w.customer_id
    LEFT JOIN sales_orders o ON o.workspace_id=$1 AND o.id=w.sales_order_id
    CROSS JOIN LATERAL (SELECT coalesce((w.status IN ('HELD','WATCHED') AND (w.sales_order_id IS NULL OR o.status='DRAFT'))
      OR (w.status='DRAFTED' AND o.status='DRAFT'),false) AS waiting) x
    WHERE $2::text='all' OR ($2::text='waiting')=x.waiting
    ORDER BY w.updated_at DESC,w.id LIMIT $3 OFFSET $4`,[workspaceId,show,limit,offset])).rows;
  return rows;
}
function describe(r){
  const who=r.customer||r.sender||'A customer';
  const what=r.job===53?'repeat order':r.job===83?'text order':'order';
  const href=r.sales_order_id?'/orders/'+r.sales_order_id:r.job===83?'/autopilot/text-orders/'+r.id:r.message_id?'/mail/'+r.message_id:path;
  const label=r.status==='CONFIRMED'?(r.order_status==='BACKORDERED'?'Confirmed, waiting for stock':'Confirmed on its own'):
    r.status==='UNDONE'?'Undone':r.status==='DRAFTED'?(r.order_status==='DRAFT'?'Draft waiting for you':'Approved'):
    r.status==='WATCHED'?'Watched only':'Needs you';
  return {job:r.job,id:r.id,who,what,href,label,reason:r.reason,order:r.order_number,
    amount:r.total_minor!=null&&r.currency?money.format(Number(r.total_minor),r.currency):null,reading:r.reading,
    canUndo:r.automatic&&r.status==='CONFIRMED'&&!['CANCELLED','FULFILLED','PARTIALLY_FULFILLED'].includes(r.order_status),
    kind:r.job===53?'repeat':r.job===83?'text':'email',subject:r.subject};
}

async function inbox(db,workspaceId){
  const rows=await work(db,workspaceId,{show:'waiting',limit:20});
  return rows.map(r=>{
    const d=describe(r),draft=r.sales_order_id&&r.order_status==='DRAFT';
    return {kind:'order',importance:'Needs You',priority:86,
      title:draft?`Approve ${r.order_number} for ${d.who}`:`Customer ${d.what} from ${d.who} needs you`,
      happened:draft?`StockChief prepared this ${d.what}${r.subject?` from “${r.subject}”`:''}. Nothing is confirmed yet.`
        :`${d.who} asked for ${r.job===83?'an order by text':'an '+d.what}${r.subject?` in “${r.subject}”`:''}. StockChief stopped before creating it.`,
      why:r.reason||'A person approves this order.',
      recommendation:draft?'Open the order, check the lines and prices, then confirm it or throw it away.':'Read the request and enter or approve the order yourself.',
      href:draft?'/orders/'+r.sales_order_id:r.job===83?d.href:r.message_id?'/mail/'+r.message_id+'/order':path,
      actionLabel:draft?'Approve this order':'Review the request',sourceId:'customer-order:'+r.job+':'+r.id,
      createdAt:r.updated_at,timeLabel:'Received',at:r.updated_at};
  });
}

async function page(db,ctx,{page:number=1}={}){
  const state=await requireOwner(db,ctx);
  const plan=policy.usesAgentTerms(state)?state.plan:null,p=Math.max(1,Math.min(1000,Number(number)||1));
  const [waiting,recent,limit,codes,customers]=await Promise.all([
    work(db,ctx.workspaceId,{show:'waiting',limit:50,jobs:[52,53]}),
    work(db,ctx.workspaceId,{show:'done',limit:51,offset:(p-1)*50,jobs:[52,53]}),
    limits(db,ctx.workspaceId),
    has(db,'stockchief_runtime.agent_customer_item_codes').then(ok=>ok?db.query(`SELECT k.customer_id,k.code,c.name AS customer,s.code AS sku,i.name AS product
      FROM stockchief_runtime.agent_customer_item_codes k JOIN customers c ON c.workspace_id=k.workspace_id AND c.id=k.customer_id
      JOIN skus s ON s.workspace_id=k.workspace_id AND s.id=k.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE k.workspace_id=$1 ORDER BY lower(c.name),k.code_key LIMIT 200`,[ctx.workspaceId]).then(r=>r.rows):[]),
    db.query("SELECT id,name FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' ORDER BY lower(name),id LIMIT 500",[ctx.workspaceId]).then(r=>r.rows),
  ]);
  const autopilot=await require('../autopilot/postgres-service').getState(db,ctx.workspaceId);
  const stop=state.shadow?'StockChief is watching during its first 14 days. It records what it would do and creates nothing.':
    autopilot.mode==='OBSERVE'?'StockChief is set to Watch only.':autopilot.paused?'Automatic work is paused.':null;
  const currency=limit?.currency||(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.base_currency||'USD';
  return {plan,stop,modes:{52:policy.allowance(plan,52),53:policy.allowance(plan,53)},
    waiting:waiting.map(describe),recent:recent.slice(0,50).map(describe),more:recent.length>50,page:p,
    limit:limit?{...limit,maximum:money.fromMinor(limit.maximumMinor,limit.currency)}:null,currency,canSetLimits:canAutomate(plan),
    codes,customers};
}

// The read used by Agent reviews and Ask for jobs 52 and 53.
function readPage(job){
  return async(db,ctx,{page=1}={})=>{
    const rows=(await work(db,ctx.workspaceId,{limit:101,offset:(page-1)*100})).filter(r=>r.job===job).map(describe);
    return {rows:rows.slice(0,100).map(r=>({Customer:r.who,Order:r.order||'',Status:r.label,Total:r.amount||'',Review:r.reason||'',link:r.href})),more:rows.length>100,
      summary:job===53?'Repeat orders StockChief made from one sentence in Ask or a customer email, at current prices.':
        'Customer orders StockChief read from emails, PDFs and spreadsheets.'};
  };
}

module.exports={path,CONFIRMED,ownerUser,limits,configure,saveCode,removeCode,identify,decide,overLimit,units,needsPerson,confirm,confirmProblems,undo,work,inbox,page,
  definitions:[{id:52,key:'customer-email-orders',label:'Customer orders from email',readPage:readPage(52)},
    {id:53,key:'repeat-customer-orders',label:'Repeat customer orders from one sentence',readPage:readPage(53)}]};

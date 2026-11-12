'use strict';

// Job 55: hold orders for customers who are overdue past the owner's rule.
// A held order cannot be confirmed, picked, packed into a parcel or shipped.
// Pro and Custom hold and release on full payment on their own; Growth only
// suggests. Releasing a hold any other way is a person's credit decision.
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const permissions=require('../actions/permissions');
const money=require('../domain/currency');
const {newId,nowIso}=require('../lib/util');
const JOB=55,ACTION='sales_order.credit_hold',KIND='agent.credit-hold.v1';
const OPEN=['DRAFT','CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED'];
const rules='stockchief_runtime.agent_overdue_order_rules',holds='stockchief_runtime.agent_order_credit_holds';
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const plural=(n,one,many)=>n+' '+(Number(n)===1?one:many);
const audit=(c,ctx,entry)=>require('../operations/postgres-security-audit').record(c,ctx,entry);

async function rule(db,workspaceId){
  return (await db.query(`SELECT r.* FROM ${rules} r JOIN users u
    ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.role='owner' WHERE r.workspace_id=$1`,[workspaceId])).rows[0]||null;
}

function describeRule(r){
  if(!r)return null;
  const days=Number(r.days_overdue),minimum=Number(r.minimum_overdue_minor);
  return 'Hold orders when a customer has invoices more than '+plural(days,'day','days')+' overdue'+
    (minimum?' totalling at least '+money.format(minimum,r.currency):'')+', and release them when those invoices are paid in full.';
}

async function orderEvent(c,ctx,order,type,detail){
  await c.query(`INSERT INTO sales_order_events(id,workspace_id,sales_order_id,event_type,detail,actor_user_id,idempotency_key,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[newId('soevt'),ctx.workspaceId,order.id,type,JSON.stringify(detail),ctx.actorId||null,
    type+':'+detail.holdId,nowIso()]);
}

async function release(c,ctx,order,hold,kind,note=null){
  const done=(await c.query(`UPDATE ${holds} SET status='RELEASED',released_kind=$3,released_by=$4,release_note=$5,released_at=now()
    WHERE workspace_id=$1 AND id=$2 AND status='HELD' RETURNING *`,[ctx.workspaceId,hold.id,kind,kind==='PERSON'||kind==='RULE_OFF'?ctx.actorId:null,note])).rows[0];
  if(!done)return false;
  const action={PAYMENT:'Credit hold released after full payment',PERSON:'Credit hold released by a person',
    ORDER_CLOSED:'Credit hold closed with the order',RULE_OFF:'Credit hold released when the rule was turned off'}[kind];
  await audit(c,ctx,{action,reference:order.order_number,before:{status:'HELD',reason:hold.reason},after:{status:'RELEASED',kind,note}});
  await orderEvent(c,ctx,order,'credit_hold_released',{holdId:hold.id,kind,note});
  return true;
}

// The customer's overdue position against the rule: invoices past the rule's
// days, and their unpaid balance in the rule's currency.
async function position(db,workspaceId,customerId,days,currency,today){
  const cutoff=require('../accounting/customer-money').addDays(today,-Number(days));
  const row=(await db.query(`SELECT count(*)::int late,min(due_date)::text oldest,
      coalesce(sum(balance_minor) FILTER(WHERE currency=$4),0)::bigint same,
      coalesce(bool_or(currency IS DISTINCT FROM $4),false) foreign_currency,
      coalesce(jsonb_agg(jsonb_build_object('invoice',invoice_number,'due',due_date,'balance',balance_minor,'currency',currency) ORDER BY due_date,id),'[]') invoices
    FROM accounting_customer_invoices WHERE workspace_id=$1 AND customer_id=$2 AND status IN ('OPEN','PARTIALLY_PAID')
      AND balance_minor>0 AND due_date<=$3`,[workspaceId,customerId,cutoff,currency||null])).rows[0];
  return {...row,late:Number(row.late),same:Number(row.same),days:Number(days)};
}

function decide(r,p){
  if(!p.late)return {hold:false,clear:true};
  const minimum=Number(r.minimum_overdue_minor);
  const reason=plural(p.late,'invoice','invoices')+' more than '+plural(p.days,'day','days')+' overdue, the oldest due '+p.oldest+
    (minimum?', with '+money.format(p.same,r.currency)+' unpaid':'')+'.';
  if(!minimum||p.same>=minimum)return {hold:true,reason};
  // Amounts in another currency cannot be compared with the owner's limit.
  if(p.foreign_currency)return {hold:false,ask:'Overdue invoices in another currency need a person to compare with your limit.'};
  return {hold:false};
}

// Holds and releases happen on their own only on Pro and Custom with the
// owner's rule, routine work on, and no pause, Watch only, shadow mode or Ask me first.
async function automatic(db,workspaceId,state){
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return null;
  const r=await rule(db,workspaceId);
  if(!r)return null;
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return null;
  if(await policy.stopped(db,workspaceId,state,ACTION,true))return null;
  return r;
}

async function lastHold(db,workspaceId,orderId){
  return (await db.query(`SELECT * FROM ${holds} WHERE workspace_id=$1 AND sales_order_id=$2 ORDER BY placed_at DESC,id DESC LIMIT 1`,
    [workspaceId,orderId])).rows[0]||null;
}

// Credit holds came with migration 438; older databases have none.
const ready=db=>require('../db/schema-installed').has(db,holds);
async function assertCanRelease(db,workspaceId,orderId){
  if(!await ready(db))return;
  const held=(await db.query(`SELECT reason FROM ${holds} WHERE workspace_id=$1 AND sales_order_id=$2 AND status='HELD'`,[workspaceId,orderId])).rows[0];
  if(held)throw new ValidationError('This order is on credit hold: '+held.reason+' Nothing can be picked or shipped until a person releases it on the order.');
  // Between a customer falling overdue and the worker recording the hold.
  if(!await rule(db,workspaceId))return;
  const r=await automatic(db,workspaceId,await policy.accountState(db,workspaceId));
  if(!r)return;
  const order=(await db.query('SELECT customer_id FROM sales_orders WHERE workspace_id=$1 AND id=$2',[workspaceId,orderId])).rows[0];
  if(!order)return;
  if((await lastHold(db,workspaceId,orderId))?.released_kind==='PERSON')return;
  const today=await require('../lib/business-time').today(db,workspaceId);
  if(decide(r,await position(db,workspaceId,order.customer_id,r.days_overdue,r.currency,today)).hold)
    throw new ValidationError('This order is on hold because the customer has an overdue invoice. Review the customer balance before releasing the order.');
}

// Place or release the hold on one order. Replays change nothing.
async function reconcile(c,workspaceId,orderId,r){
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['credit-hold:'+workspaceId+':'+orderId]);
  const order=(await c.query('SELECT id,order_number,status,customer_id FROM sales_orders WHERE workspace_id=$1 AND id=$2',[workspaceId,orderId])).rows[0];
  if(!order)return {state:'missing'};
  const actorId=await require('./agent-backorders').currentOwner(c,workspaceId),ctx={workspaceId,actorId};
  const active=(await c.query(`SELECT * FROM ${holds} WHERE workspace_id=$1 AND sales_order_id=$2 AND status='HELD' FOR UPDATE`,[workspaceId,orderId])).rows[0];
  if(!OPEN.includes(order.status)){
    if(active)await release(c,ctx,order,active,'ORDER_CLOSED');
    return {state:active?'closed':'not-open'};
  }
  const today=await require('../lib/business-time').today(c,workspaceId);
  if(active){
    // A hold a person placed stays until every overdue invoice is paid.
    const days=active.placed_by_kind==='PERSON'?1:r.days_overdue;
    const now=await position(c,workspaceId,order.customer_id,days,r.currency,today);
    if(now.late)return {state:'held'};
    await release(c,ctx,order,active,'PAYMENT');
    return {state:'released'};
  }
  const now=await position(c,workspaceId,order.customer_id,r.days_overdue,r.currency,today),choice=decide(r,now);
  if(!choice.hold)return {state:choice.ask?'ask':'clear',reason:choice.ask};
  if((await lastHold(c,workspaceId,orderId))?.released_kind==='PERSON')return {state:'released-by-person'};
  const id=newId('credithold');
  const placed=(await c.query(`INSERT INTO ${holds}(id,workspace_id,sales_order_id,customer_id,status,placed_by_kind,reason,evidence)
    VALUES($1,$2,$3,$4,'HELD','RULE',$5,$6::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
  [id,workspaceId,orderId,order.customer_id,choice.reason,JSON.stringify({ruleRevision:r.revision,invoices:now.invoices})])).rows[0];
  if(!placed)return {state:'held'};
  await audit(c,ctx,{action:'Order put on credit hold',reference:order.order_number,before:{},after:{reason:choice.reason,rule:describeRule(r)}});
  await orderEvent(c,ctx,order,'credit_hold_placed',{holdId:id,reason:choice.reason});
  return {state:'placed'};
}

async function reconcileOrder(c,workspaceId,orderId){
  const r=await automatic(c,workspaceId,await policy.accountState(c,workspaceId));
  if(!r)return {state:'watching'};
  await c.query('SAVEPOINT credit_hold');
  try{const done=await reconcile(c,workspaceId,orderId,r);await c.query('RELEASE SAVEPOINT credit_hold');return done;}
  catch(error){
    if(error.code!=='validation_error')throw error;
    await c.query('ROLLBACK TO SAVEPOINT credit_hold');
    return {state:'ask',reason:error.message};
  }
}

// Job 198: in the first 14 days StockChief holds nothing. It records each open
// order it would have held under the owner's rule, with the order's value as
// the money it would have kept from going to a customer who is overdue.
async function watched(database,workspaceId,state){
  const shadow=require('../autopilot/shadow-mode');
  if(!policy.permits(state.plan,JOB,'automatic')||!await ready(database)||!await shadow.watching(database,workspaceId,state))return 0;
  const r=await rule(database,workspaceId);
  if(!r)return 0;
  const today=await require('../lib/business-time').today(database,workspaceId);
  const {rows}=await database.query(`SELECT o.id,o.order_number,o.customer_id,o.currency,c.name customer_name,
      (round(coalesce(sum(l.quantity_ordered*coalesce(l.unit_price_minor,0)),0))+o.tax_minor-o.discount_minor)::bigint AS total_minor
    FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    LEFT JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
    WHERE o.workspace_id=$1 AND o.status=ANY($2::text[]) AND EXISTS(SELECT 1 FROM accounting_customer_invoices i WHERE i.workspace_id=o.workspace_id
      AND i.customer_id=o.customer_id AND i.status IN ('OPEN','PARTIALLY_PAID') AND i.balance_minor>0 AND i.due_date<=$3)
    GROUP BY o.id,c.name ORDER BY o.id LIMIT 200`,[workspaceId,OPEN,require('../accounting/customer-money').addDays(today,-Number(r.days_overdue))]);
  let recorded=0;
  for(const o of rows){
    const choice=decide(r,await position(database,workspaceId,o.customer_id,r.days_overdue,r.currency,today));
    if(!choice.hold)continue;
    const value=Math.max(0,Number(o.total_minor));
    if(await shadow.record(database,workspaceId,{job:JOB,kind:'hold',key:'credit-hold:'+o.id,
      summary:'Hold order '+o.order_number+' for '+o.customer_name+': '+choice.reason,
      amountMinor:value,caughtMinor:value,currency:o.currency,evidence:{rule:describeRule(r)},href:'/orders/'+o.id},state))recorded++;
  }
  return recorded;
}

// The routine: customers fall overdue as days pass, and holds end with payment.
async function sweep(database,workspaceId){
  const result={placed:0,released:0,watching:false};
  const state=await policy.accountState(database,workspaceId);
  const r=await automatic(database,workspaceId,state);
  if(!r){if(state.shadow)result.watched=await watched(database,workspaceId,state);result.watching=true;return result;}
  const today=await require('../lib/business-time').today(database,workspaceId);
  const {rows}=await database.query(`SELECT o.id FROM sales_orders o WHERE o.workspace_id=$1 AND (
      EXISTS(SELECT 1 FROM ${holds} h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status='HELD')
      OR o.status=ANY($2::text[]) AND EXISTS(SELECT 1 FROM accounting_customer_invoices i WHERE i.workspace_id=o.workspace_id
        AND i.customer_id=o.customer_id AND i.status IN ('OPEN','PARTIALLY_PAID') AND i.balance_minor>0 AND i.due_date<=$3))
    ORDER BY o.id LIMIT 200`,[workspaceId,OPEN,require('../accounting/customer-money').addDays(today,-Number(r.days_overdue))]);
  for(const row of rows){
    const done=await tx(database,c=>reconcileOrder(c,workspaceId,row.id));
    if(done.state==='placed')result.placed++;
    if(['released','closed'].includes(done.state))result.released++;
  }
  return result;
}

// A recorded customer payment checks that customer's held orders at once.
async function queueForCustomer(c,workspaceId,customerId){
  if(!await ready(c))return;
  const held=await c.query(`SELECT 1 FROM ${holds} WHERE workspace_id=$1 AND customer_id=$2 AND status='HELD' LIMIT 1`,[workspaceId,customerId]);
  if(!held.rowCount)return;
  const state=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return;
  await require('../operations/postgres-job-queue').enqueue(scoped(c),{workspaceId,kind:KIND,priority:55,maxAttempts:5,
    idempotencyKey:'credit-hold:'+customerId+':'+newId('payment'),payload:{customerId}});
}

async function work(database,workspaceId,{customerId}={}){
  if(typeof customerId!=='string'||!customerId)throw new ValidationError('A credit hold check needs its customer.');
  const {rows}=await database.query(`SELECT DISTINCT sales_order_id FROM ${holds} WHERE workspace_id=$1 AND customer_id=$2 AND status='HELD'
    ORDER BY sales_order_id LIMIT 200`,[workspaceId,customerId]);
  const result={released:0};
  for(const row of rows)if(['released','closed'].includes((await tx(database,c=>reconcileOrder(c,workspaceId,row.sales_order_id))).state))result.released++;
  return result;
}

async function person(c,ctx,permission,what){
  const user=(await c.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!user)throw new AuthorizationError('Only a person in this inventory can '+what+'.');
  permissions.assertCan(user,permission,what);
  return user;
}

// Releasing a credit hold is a credit decision, so only a person with
// accounting authority can make it, on any plan.
async function releaseByPerson(db,ctx,orderId,{note}={}){
  const text=String(note||'').trim()||null;
  if(text&&text.length>300)throw new ValidationError('Keep the release note under 300 characters.');
  return tx(db,async c=>{
    await person(c,ctx,permissions.MANAGE_ACCOUNTING,'release a credit hold');
    const order=(await c.query('SELECT id,order_number,status,customer_id FROM sales_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,orderId])).rows[0];
    if(!order)throw new NotFoundError('That order is not in this inventory.');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['credit-hold:'+ctx.workspaceId+':'+orderId]);
    const active=(await c.query(`SELECT * FROM ${holds} WHERE workspace_id=$1 AND sales_order_id=$2 AND status='HELD' FOR UPDATE`,[ctx.workspaceId,orderId])).rows[0];
    if(active){await release(c,ctx,order,active,'PERSON',text);return {released:true};}
    // The rule is blocking the order before the worker recorded a hold.
    try{await assertCanRelease(c,ctx.workspaceId,orderId);}catch(error){
      if(error.code!=='validation_error')throw error;
      const id=newId('credithold');
      await c.query(`INSERT INTO ${holds}(id,workspace_id,sales_order_id,customer_id,status,placed_by_kind,reason,released_kind,released_by,release_note,released_at)
        VALUES($1,$2,$3,$4,'RELEASED','RULE','The customer has an overdue invoice.','PERSON',$5,$6,now())`,[id,ctx.workspaceId,orderId,order.customer_id,ctx.actorId,text]);
      await audit(c,ctx,{action:'Credit hold released by a person',reference:order.order_number,before:{status:'HELD'},after:{status:'RELEASED',kind:'PERSON',note:text}});
      await orderEvent(c,ctx,order,'credit_hold_released',{holdId:id,kind:'PERSON',note:text});
      return {released:true};
    }
    return {released:false,replayed:true};
  });
}

// A person puts an order on hold, or puts a released hold back (Pro and Custom).
async function holdByPerson(db,ctx,orderId){
  return tx(db,async c=>{
    await person(c,ctx,permissions.MANAGE_SALES,'put an order on credit hold');
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const order=(await c.query('SELECT id,order_number,status,customer_id FROM sales_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,orderId])).rows[0];
    if(!order)throw new NotFoundError('That order is not in this inventory.');
    if(!OPEN.includes(order.status))throw new ValidationError('Only an open order can be put on credit hold.');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['credit-hold:'+ctx.workspaceId+':'+orderId]);
    if((await c.query(`SELECT 1 FROM ${holds} WHERE workspace_id=$1 AND sales_order_id=$2 AND status='HELD'`,[ctx.workspaceId,orderId])).rowCount)return {replayed:true};
    const today=await require('../lib/business-time').today(c,ctx.workspaceId);
    const now=await position(c,ctx.workspaceId,order.customer_id,1,null,today);
    if(!now.late)throw new ValidationError('This customer has no overdue invoice. Nothing was held.');
    const reason=plural(now.late,'invoice','invoices')+' overdue, the oldest due '+now.oldest+'.',id=newId('credithold');
    await c.query(`INSERT INTO ${holds}(id,workspace_id,sales_order_id,customer_id,status,placed_by_kind,placed_by,reason,evidence)
      VALUES($1,$2,$3,$4,'HELD','PERSON',$5,$6,$7::jsonb)`,[id,ctx.workspaceId,orderId,order.customer_id,ctx.actorId,reason,JSON.stringify({invoices:now.invoices})]);
    await audit(c,ctx,{action:'Order put on credit hold by a person',reference:order.order_number,before:{},after:{reason}});
    await orderEvent(c,ctx,order,'credit_hold_placed',{holdId:id,reason,person:true});
    return {held:true};
  });
}

async function configure(db,ctx,input){
  const values=typeof input==='string'?{mode:input}:input||{},choice=values.mode;
  if(!['on','off'].includes(choice))throw new ValidationError('Choose whether to hold orders for overdue invoices.');
  return tx(db,async c=>{
    const state=await require('../autopilot/job-reviews').ownerState(c,ctx);
    const prior=await rule(c,ctx.workspaceId);
    if(choice==='on'){
      policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,JOB,'automatic');
      const daysText=String(values.days??'').trim(),days=daysText?Number(daysText):1;
      if(!Number.isSafeInteger(days)||days<1||days>365)throw new ValidationError('Enter the days overdue, from 1 to 365.');
      const currency=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency||null;
      const amountText=String(values.amount??'').trim();
      if(amountText&&!currency)throw new ValidationError('Turn on accounting to set an overdue amount. Leave the amount blank to hold for any overdue invoice.');
      const minimum=amountText?money.userToMinor(amountText,currency,{label:'Overdue amount'}):0;
      if(!Number.isSafeInteger(minimum)||minimum<0)throw new ValidationError('Enter a positive overdue amount, or leave it blank.');
      if(!prior)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
      await c.query(`INSERT INTO ${rules} AS current(workspace_id,authorized_by,days_overdue,minimum_overdue_minor,currency) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(workspace_id) DO UPDATE SET authorized_by=EXCLUDED.authorized_by,days_overdue=EXCLUDED.days_overdue,
          minimum_overdue_minor=EXCLUDED.minimum_overdue_minor,currency=EXCLUDED.currency,revision=current.revision+1,updated_at=now()`,
      [ctx.workspaceId,ctx.actorId,days,minimum,minimum?currency:null]);
      await audit(c,ctx,{action:'Overdue customer order rule changed',before:{enabled:Boolean(prior),rule:describeRule(prior)},
        after:{enabled:true,days,minimumMinor:minimum,currency:minimum?currency:null}});
      return;
    }
    await c.query(`DELETE FROM ${rules} WHERE workspace_id=$1`,[ctx.workspaceId]);
    // Turning the rule off is the owner's decision to release what it held.
    const held=(await c.query(`SELECT h.*,o.order_number FROM ${holds} h JOIN sales_orders o ON o.workspace_id=h.workspace_id AND o.id=h.sales_order_id
      WHERE h.workspace_id=$1 AND h.status='HELD' AND h.placed_by_kind='RULE' ORDER BY h.id FOR UPDATE OF h`,[ctx.workspaceId])).rows;
    for(const h of held)await release(c,ctx,{id:h.sales_order_id,order_number:h.order_number},h,'RULE_OFF');
    await audit(c,ctx,{action:'Overdue customer order rule changed',before:{enabled:Boolean(prior),rule:describeRule(prior)},after:{enabled:false,released:held.length}});
  });
}

// What the order page shows about credit holds for this order.
async function forOrderPage(db,ctx,order,state,user){
  if(!await ready(db))return null;
  const active=(await db.query(`SELECT h.*,u.name placed_by_name FROM ${holds} h LEFT JOIN users u ON u.workspace_id=h.workspace_id AND u.id=h.placed_by
    WHERE h.workspace_id=$1 AND h.sales_order_id=$2 AND h.status='HELD'`,[ctx.workspaceId,order.id])).rows[0];
  const plan=policy.usesAgentTerms(state)?state.plan:null;
  const canRelease=permissions.can(user,permissions.MANAGE_ACCOUNTING);
  const canHold=policy.permits(plan,JOB,'draft')&&permissions.can(user,permissions.MANAGE_SALES);
  if(active)return {active:{reason:active.reason,placedAt:active.placed_at,byPerson:active.placed_by_kind==='PERSON',placedByName:active.placed_by_name},canRelease};
  if(!OPEN.includes(order.status)||!policy.permits(plan,JOB,'suggest'))return null;
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  const overdue=await position(db,ctx.workspaceId,order.customer_id,1,null,today);
  const last=await lastHold(db,ctx.workspaceId,order.id);
  if(!overdue.late&&!last)return null;
  return {overdue:overdue.late?{count:overdue.late,oldest:overdue.oldest}:null,
    released:last?{kind:last.released_kind,at:last.released_at,note:last.release_note}:null,
    canHold:canHold&&overdue.late>0,automatic:policy.permits(plan,JOB,'automatic'),rule:describeRule(await rule(db,ctx.workspaceId))};
}

// Needs you: every order on hold, so sales knows why it is not moving.
async function inbox(db,workspaceId){
  const {rows}=await db.query(`SELECT h.sales_order_id,h.reason,h.placed_at,h.placed_by_kind,o.order_number,c.name customer_name FROM ${holds} h
    JOIN sales_orders o ON o.workspace_id=h.workspace_id AND o.id=h.sales_order_id
    JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    WHERE h.workspace_id=$1 AND h.status='HELD' ORDER BY h.placed_at DESC,h.id LIMIT 20`,[workspaceId]);
  return rows.map(row=>({kind:'inventory',importance:'Important',priority:82,
    title:row.order_number+' for '+row.customer_name+' is on credit hold',
    happened:(row.placed_by_kind==='RULE'?'StockChief held the order under your overdue rule. ':'A person held the order. ')+'It cannot be picked or shipped.',
    why:row.reason,recommendation:'Ask the customer to pay. The hold ends on its own when the overdue invoices are paid in full, or a person can release it.',
    href:'/orders/'+encodeURIComponent(row.sales_order_id)+'#credit-hold',actionLabel:'Review hold',
    sourceId:'credit-hold-'+row.sales_order_id,createdAt:row.placed_at,timeLabel:'Held',at:row.placed_at}));
}

// Pass installed=false on a database without credit holds; nothing is held there.
const activeHoldSql=(alias,installed=true)=>!installed?'false':`EXISTS(SELECT 1 FROM ${holds} credit_hold WHERE credit_hold.workspace_id=${alias}.workspace_id
  AND credit_hold.sales_order_id=${alias}.id AND credit_hold.status='HELD')`;

module.exports={JOB,KIND,ACTION,rule,describeRule,configure,assertCanRelease,reconcileOrder,sweep,queueForCustomer,work,
  releaseByPerson,holdByPerson,forOrderPage,inbox,activeHoldSql,ready};

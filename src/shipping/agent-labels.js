'use strict';
// Job 58: for each packed parcel, compare the current quotes from every
// connected shipping account and pick the cheapest that arrives by the date
// promised on the order. Arrival comes from the quote: the carrier's own
// delivery date, or its transit days counted from its ship date (which
// already reflects its cut-off) or from the day it quoted. Quotes in another
// currency are never compared. Starter sees the suggestion; Growth suggests
// until the owner approves one or saves the rule; Pro and Custom choose on
// their own. A person's one tap buys the label at the suggested rate.
//
// Job 59: a chosen rate's label is bought through the carrier adapter within
// the owner's limits: Growth up to $25 a label (or the owner's lower limit),
// Pro and Custom within the owner's saved $ per label, and any 24-hour limit.
// Starter prepares each label for one tap. Anything over a limit, under Ask me
// first, paused or watching waits for that tap instead.
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');
const validation=require('./address-validation');
const money=require('../domain/currency');
const {allowed}=require('./service-eligibility');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');

const CHOOSE=58,BUY=59,KIND='agent.shipping-labels.v1',FRESH_MS=30*60_000,RETRY_MS=60*60_000,ANYWAY=' Approve it to buy it anyway.';
const runs='stockchief_runtime.agent_label_runs',rules='stockchief_runtime.agent_shipping_rate_rules';
const LABEL_BUSY=['PURCHASED','PENDING','REVIEW','VOID_PENDING'];
const shipping=()=>require('./postgres-service');
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const expected=error=>error instanceof ValidationError||['validation_error','entitlement_required','forbidden'].includes(error?.code);
const installed=db=>require('../db/schema-installed').has(db,runs);

function addBusinessDays(day,count){
  const d=new Date(day+'T12:00:00Z');let left=count;
  while(left>0){d.setUTCDate(d.getUTCDate()+1);if(![0,6].includes(d.getUTCDay()))left--;}
  return d.toISOString().slice(0,10);
}
// When each quote says the parcel arrives, from the quote alone.
async function arrivals(db,workspaceId,rates){
  const quoted=new Map(),time=require('../lib/business-time');
  for(const rate of rates){
    rate.arrival=null;
    if(rate.delivery_date){rate.arrival=String(rate.delivery_date).slice(0,10);continue;}
    const days=Number(rate.delivery_days);
    if(rate.delivery_days==null||!Number.isSafeInteger(days)||days<0)continue;
    let start=/^\d{4}-\d{2}-\d{2}$/.test(String(rate.ship_date||''))?rate.ship_date:null;
    if(!start){const at=String(rate.quoted_at);if(!quoted.has(at))quoted.set(at,await time.today(db,workspaceId,new Date(at)));start=quoted.get(at);}
    rate.arrival=addBusinessDays(start,days);
  }
  return rates;
}
function label(rate){return require('../sales/carriers').displayName(rate.carrier)+' '+rate.service;}
// The cheapest current quote for this exact parcel that arrives in time.
function choose(view,promised){
  const fingerprint=shipping().quoteFingerprint(view),options=view.shipment.shipping_options||{},poBox=validation.poBox(view.to);
  const usable=view.rates.filter(r=>r.parcel_fingerprint===fingerprint&&Date.now()-Date.parse(r.quoted_at)<=FRESH_MS&&allowed(r,options)
    &&!(poBox&&validation.refusesPoBox(r))&&r.currency===view.shipment.currency);
  const timely=usable.filter(r=>r.arrival&&promised&&r.arrival<=promised).sort((a,b)=>Number(a.amount_minor)-Number(b.amount_minor)
    ||a.arrival.localeCompare(b.arrival)||Number(b.guaranteed)-Number(a.guaranteed)||String(a.id).localeCompare(String(b.id)));
  const fastest=usable.filter(r=>r.arrival).sort((a,b)=>a.arrival.localeCompare(b.arrival)||Number(a.amount_minor)-Number(b.amount_minor))[0]||null;
  return {pick:timely[0]||null,fastest,usable};
}

async function ownerUser(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL ORDER BY u.created_at,u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}

// How far StockChief may go right now: watch, suggest, draft or choose alone.
async function authority(db,workspaceId){
  const account=await policy.accountState(db,workspaceId),plan=policy.usesAgentTerms(account)?account.plan:null;
  if(!plan||!policy.permits(plan,CHOOSE,'suggest'))return {plan:null,account};
  const watch=await policy.stopped(db,workspaceId,account,'shipping.choose_rate',false);
  const rule=(await db.query(`SELECT r.* FROM ${rules} r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.role='owner'
    WHERE r.workspace_id=$1 AND r.enabled`,[workspaceId])).rows[0]||null;
  const examples=new Map((await db.query(`SELECT r.currency,max(r.amount_minor) AS most FROM ${runs} r
    JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.decided_by AND u.role='owner'
    WHERE r.workspace_id=$1 AND r.status='QUEUED' AND r.mode IN ('suggest','draft') GROUP BY r.currency`,[workspaceId])).rows.map(r=>[r.currency,Number(r.most)]));
  let hold=null;
  if(!watch){
    hold=await policy.stopped(db,workspaceId,account,'shipping.choose_rate',true);
    if(!hold&&!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
      hold='Routine work is off. Choose Handle routine work in StockChief AI to let it choose rates on its own.';
  }
  return {account,plan,watch,hold,rule,examples,labelHold:await labelAuthority(db,workspaceId,account,plan)};
}
// Why a chosen label cannot be bought without a person right now, or null.
async function labelAuthority(db,workspaceId,account,plan){
  if(!policy.permits(plan,BUY,'automatic'))return 'Approve this label to buy it.';
  const stop=await policy.stopped(db,workspaceId,account,'shipping.label',true);
  if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
    return 'Routine work is off. Approve this label, or choose Handle routine work in StockChief AI.';
  // "Within your $ per label": Growth's plan limit is $25; Pro and Custom use the owner's own.
  if(plan!=='growth'&&(await require('./postgres-purchase-policy').get(db,workspaceId))?.per_label_minor==null)
    return 'Set your $ per label in Shipping settings so StockChief can buy labels on its own. Until then, approve each one.';
  return null;
}
// Growth is taught by the saved rule, or by an approved example at least as costly.
function level(auth,pick){
  if(!auth.plan)return null;
  if(auth.watch)return 'watch';
  const trained=Boolean(auth.rule)||Boolean(pick)&&(auth.examples.get(pick.currency)??-1)>=Number(pick.amount_minor);
  if(!auth.hold&&policy.permits(auth.plan,CHOOSE,'automatic',{trained}))return 'automatic';
  return policy.permits(auth.plan,CHOOSE,'draft')?'draft':'suggest';
}

function candidate(view){
  const s=view.shipment;
  return s.status==='PACKED'&&!s.customer_return_id&&s.delivery_kind!=='CUSTOMER_DIRECT'&&s.handover==='CARRIER'&&s.delivery_method==='SHIP'
    &&!LABEL_BUSY.includes(s.label_status)&&!(s.provider_packages||[]).some(p=>p.externalLabel===true)&&view.shippingAccounts.length>0;
}
async function current(db,workspaceId,shipmentId,fingerprint,lock=false){
  return (await db.query(`SELECT * FROM ${runs} WHERE workspace_id=$1 AND shipment_id=$2 AND fingerprint=$3${lock?' FOR UPDATE':''}`,[workspaceId,shipmentId,fingerprint])).rows[0]||null;
}

// One row per parcel as quoted. A queued or declined choice is never rewritten.
async function save(db,ctx,view,fingerprint,fields){
  return tx(db,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['agent-label:'+view.shipment.id]);
    const before=await current(c,ctx.workspaceId,view.shipment.id,fingerprint,true);
    if(before&&['QUEUED','DECLINED'].includes(before.status))return before;
    const pick=fields.pick,at=nowIso();
    const row=(await c.query(`INSERT INTO ${runs}(id,workspace_id,shipment_id,fingerprint,status,mode,promised_date,rate_id,carrier,service,amount_minor,currency,
        arrival_date,guaranteed,hold,reason,label_reason,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT(workspace_id,shipment_id,fingerprint) DO UPDATE SET status=EXCLUDED.status,mode=EXCLUDED.mode,promised_date=EXCLUDED.promised_date,
        rate_id=EXCLUDED.rate_id,carrier=EXCLUDED.carrier,service=EXCLUDED.service,amount_minor=EXCLUDED.amount_minor,currency=EXCLUDED.currency,
        arrival_date=EXCLUDED.arrival_date,guaranteed=EXCLUDED.guaranteed,hold=EXCLUDED.hold,reason=EXCLUDED.reason,label_reason=EXCLUDED.label_reason,updated_at=EXCLUDED.updated_at
      RETURNING *`,[newId('labelrun'),ctx.workspaceId,view.shipment.id,fingerprint,fields.status,fields.mode,view.shipment.needed_by||null,
      pick?.id||null,pick?.carrier||null,pick?.service||null,pick?Number(pick.amount_minor):null,pick?.currency||null,pick?.arrival||null,
      pick?Boolean(pick.guaranteed):null,fields.hold||null,fields.reason||null,fields.labelReason||null,at])).rows[0];
    const changed=!before||before.status!==row.status||before.rate_id!==row.rate_id||before.reason!==row.reason||before.mode!==row.mode;
    if(changed&&row.status!=='SUGGESTED'||changed&&!before)await audit.record(c,ctx,{action:row.status==='CHOSEN'?'Chose a shipping rate':row.status==='HELD'?'Held a shipping rate choice':'Suggested a shipping rate',
      reference:view.shipment.shipment_number,before:before?{status:before.status,rate:before.rate_id}:{},
      after:{status:row.status,mode:row.mode,carrier:row.carrier,service:row.service,amountMinor:row.amount_minor,currency:row.currency,arrival:row.arrival_date,promised:row.promised_date,reason:row.reason}});
    return row;
  });
}
const held=(db,ctx,view,fingerprint,mode,hold,reason)=>save(db,ctx,view,fingerprint,{status:'HELD',mode,hold,reason});

// Decide one parcel. Quotes are fetched only when none are current, and a
// choice waiting for a person is left alone until its facts or authority change.
async function evaluate(database,workspaceId,shipmentId,{auth,owner,providerResolver}={}){
  const svc=shipping(),ctx={workspaceId,actorId:owner};
  let view=await svc.state(database,workspaceId,shipmentId);
  if(!candidate(view))return null;
  let fingerprint=svc.quoteFingerprint(view),run=await current(database,workspaceId,shipmentId,fingerprint);
  const promised=view.shipment.needed_by||null,baseMode=level(auth,null);
  if(run&&['QUEUED','DECLINED'].includes(run.status))return run;
  if(run?.status==='CHOSEN'&&run.promised_date===promised&&auth.labelHold){
    if(run.label_reason===auth.labelHold)return run;
    return (await database.query(`UPDATE ${runs} SET label_reason=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status='CHOSEN' RETURNING *`,[workspaceId,run.id,auth.labelHold])).rows[0]||run;
  }
  // A label refused for this rate (over a limit) is tried again hourly, not every cycle.
  if(run?.status==='CHOSEN'&&run.promised_date===promised&&String(run.label_reason||'').endsWith(ANYWAY)&&Date.now()-Date.parse(run.updated_at)<RETRY_MS)return run;
  if(run?.status==='SUGGESTED'&&run.promised_date===promised&&level(auth,{currency:run.currency,amount_minor:run.amount_minor})===run.mode)return run;
  if(!promised)return held(database,ctx,view,fingerprint,baseMode,'promise','Add the promised delivery date to the order so StockChief can pick a rate that arrives in time.');
  if(!view.ready)return held(database,ctx,view,fingerprint,baseMode,'parcel',view.blocked.join(' '));
  const fresh=view.rates.some(r=>r.parcel_fingerprint===fingerprint&&Date.now()-Date.parse(r.quoted_at)<=FRESH_MS);
  if(!fresh){
    if(run?.status==='HELD'&&Date.now()-Date.parse(run.updated_at)<RETRY_MS&&run.promised_date===promised)return run;
    try{await svc.quote(database,ctx,shipmentId,{idempotencyKey:'agent-rates:'+shipmentId+':'+newId('quote'),providerResolver});}
    catch(error){if(!expected(error))throw error;return held(database,ctx,view,fingerprint,baseMode,'rates','Rates could not be fetched: '+error.message);}
    view=await svc.state(database,workspaceId,shipmentId);
    if(!candidate(view))return null;
    fingerprint=svc.quoteFingerprint(view);run=await current(database,workspaceId,shipmentId,fingerprint);
    if(run&&['QUEUED','DECLINED'].includes(run.status))return run;
  }
  const address=await require('./agent-address-checks').view(database,workspaceId,shipmentId);
  if(address?.held)return held(database,ctx,view,fingerprint,baseMode,'address',address.reason+' Answer the address check on the order first.');
  await arrivals(database,workspaceId,view.rates);
  const {pick,fastest,usable}=choose(view,promised);
  if(!pick)return held(database,ctx,view,fingerprint,baseMode,'late',!usable.length?'No current carrier rates came back for this parcel.':
    'No rate arrives by the promised date, '+promised+'.'+(fastest?' The fastest, '+label(fastest)+', arrives '+fastest.arrival+'.':' The carriers gave no delivery estimate.'));
  const mode=level(auth,pick);
  const row=await save(database,ctx,view,fingerprint,{status:mode==='automatic'?'CHOSEN':'SUGGESTED',mode,pick,labelReason:mode==='automatic'?auth.labelHold:null});
  return row.status==='CHOSEN'&&!auth.labelHold?buyAlone(database,ctx,view,row):row;
}

// Job 59 alone: the carrier adapter buys the chosen label through the worker.
// The plan and owner limits are checked here and again just before the carrier.
async function buyAlone(database,ctx,view,run){
  let queued;
  try{queued=await shipping().queueLabelPurchase(database,{...ctx,agentPostageScope:'automatic'},view.shipment.id,run.rate_id,{idempotencyKey:'agent-label:'+run.id});}
  catch(error){
    if(!expected(error))throw error;
    return (await database.query(`UPDATE ${runs} SET label_reason=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status='CHOSEN' RETURNING *`,
      [ctx.workspaceId,run.id,error.message+ANYWAY])).rows[0]||run;
  }
  return tx(database,async c=>{
    const row=(await c.query(`UPDATE ${runs} SET status='QUEUED',effect_id=$3,transaction_id=$4,label_reason=NULL,updated_at=now()
      WHERE workspace_id=$1 AND id=$2 AND status='CHOSEN' RETURNING *`,[ctx.workspaceId,run.id,queued.effectId||null,queued.transactionId||null])).rows[0]||run;
    await audit.record(c,ctx,{action:'Bought a shipping label within your limits',reference:view.shipment.shipment_number,before:{status:'CHOSEN'},
      after:{carrier:run.carrier,service:run.service,amountMinor:Number(run.amount_minor),currency:run.currency,arrival:run.arrival_date,promised:run.promised_date,effectId:queued.effectId||null}});
    return row;
  });
}

const CANDIDATES=`SELECT s.id FROM sales_shipments s JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
  WHERE s.workspace_id=$1 AND s.status='PACKED' AND s.customer_return_id IS NULL AND s.handover='CARRIER' AND o.delivery_method='SHIP' AND o.status<>'CANCELLED'
    AND coalesce(s.label_status,'') NOT IN ('PURCHASED','PENDING','REVIEW','VOID_PENDING')
    AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_label_runs r WHERE r.workspace_id=s.workspace_id AND r.shipment_id=s.id AND r.status IN ('QUEUED','DECLINED')
      AND r.updated_at>=s.updated_at::timestamptz)`;

async function run(database,job,options={}){
  const workspaceId=job.workspaceId;
  if(!await installed(database))return {skipped:'not_installed'};
  const auth=await authority(database,workspaceId);if(!auth.plan)return {skipped:'plan'};
  const owner=await ownerUser(database,workspaceId);if(!owner)return {skipped:'owner'};
  const {rows}=await database.query(CANDIDATES+` ORDER BY o.needed_by NULLS LAST,s.created_at,s.id LIMIT 25`,[workspaceId]);
  const result={checked:0,held:0,suggested:0,chosen:0,queued:0};
  for(const {id} of rows){
    let row;try{row=await evaluate(database,workspaceId,id,{auth,owner,providerResolver:options.providerResolver});}
    catch(error){if(!expected(error))throw error;result.held++;continue;}
    if(!row)continue;result.checked++;
    result[{HELD:'held',SUGGESTED:'suggested',CHOSEN:'chosen',QUEUED:'queued'}[row.status]||'checked']+=row.status==='DECLINED'?0:1;
  }
  return result;
}
async function schedule(c,workspaceId,cycleId){
  if(!await installed(c))return {queued:false};
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,CHOOSE,'suggest'))return {queued:false};
  if(!(await c.query(`SELECT 1 FROM (${CANDIDATES}) waiting LIMIT 1`,[workspaceId])).rowCount)return {queued:false};
  await jobs.enqueue(scoped(c),{workspaceId,kind:KIND,idempotencyKey:'shipping-labels:cycle:'+cycleId,payload:{cycleId},priority:45,maxAttempts:3});
  return {queued:true};
}

// One tap: approve the suggested rate and buy its label. An expired quote is
// fetched again; a dearer or different answer is shown instead of bought.
async function approve(database,ctx,shipmentId,input={},options={}){
  const svc=shipping();
  let view=await svc.state(database,ctx.workspaceId,shipmentId);
  let run=(await database.query(`SELECT * FROM ${runs} WHERE workspace_id=$1 AND shipment_id=$2 AND id=$3`,[ctx.workspaceId,shipmentId,input.runId])).rows[0];
  if(run?.status==='QUEUED')return {queued:true,replayed:true,run};
  if(!run||run.fingerprint!==svc.quoteFingerprint(view)||!['SUGGESTED','CHOSEN'].includes(run.status)||run.mode==='watch')
    throw new ValidationError('This shipping choice changed. Open the order again to see the current one.');
  let rate=view.rates.find(r=>r.id===run.rate_id);
  if(!rate||Date.now()-Date.parse(rate.quoted_at)>FRESH_MS){
    await svc.quote(database,ctx,shipmentId,{idempotencyKey:'agent-rates:'+run.id+':'+newId('quote'),providerResolver:options.providerResolver});
    view=await svc.state(database,ctx.workspaceId,shipmentId);
    if(svc.quoteFingerprint(view)!==run.fingerprint)throw new ValidationError('The parcel or its address changed. Review the new rates on the order.');
    await arrivals(database,ctx.workspaceId,view.rates);
    const {pick}=choose(view,run.promised_date);
    if(!pick||pick.carrier!==run.carrier||pick.service!==run.service||pick.currency!==run.currency||Number(pick.amount_minor)>Number(run.amount_minor)){
      const updated=pick?await save(database,ctx,view,run.fingerprint,{status:run.status,mode:run.mode,pick,labelReason:run.label_reason})
        :await held(database,ctx,view,run.fingerprint,run.mode,'late','No current rate arrives by the promised date, '+run.promised_date+'.');
      return {changed:true,run:updated};
    }
    rate=pick;
  }
  const queued=await svc.queueLabelPurchase(database,{...ctx,agentPostageScope:'individual'},shipmentId,rate.id,{idempotencyKey:'agent-label:'+run.id});
  run=await tx(database,async c=>{
    const row=(await c.query(`UPDATE ${runs} SET status='QUEUED',rate_id=$3,amount_minor=$4,decided_by=$5,decided_at=now(),effect_id=$6,transaction_id=$7,label_reason=NULL,updated_at=now()
      WHERE workspace_id=$1 AND id=$2 RETURNING *`,[ctx.workspaceId,run.id,rate.id,Number(rate.amount_minor),ctx.actorId,queued.effectId||null,queued.transactionId||null])).rows[0];
    await audit.record(c,ctx,{action:'Approved a shipping rate and its label',reference:view.shipment.shipment_number,before:{status:run.status,mode:run.mode},
      after:{carrier:row.carrier,service:row.service,amountMinor:row.amount_minor,currency:row.currency,arrival:row.arrival_date,promised:row.promised_date}});
    return row;
  });
  return {queued:true,replayed:Boolean(queued.replayed),run};
}

async function dismiss(database,ctx,shipmentId,input={}){
  return tx(database,async c=>{
    const user=(await c.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
    require('../actions/permissions').assertCan(user,require('../actions/permissions').OPERATE,'choose a shipping rate');
    const row=(await c.query(`UPDATE ${runs} SET status='DECLINED',decided_by=$4,decided_at=now(),updated_at=now()
      WHERE workspace_id=$1 AND shipment_id=$2 AND id=$3 AND status IN ('SUGGESTED','CHOSEN','HELD') RETURNING *`,[ctx.workspaceId,shipmentId,input.runId,ctx.actorId])).rows[0];
    if(!row)throw new ValidationError('This shipping choice changed. Open the order again to see the current one.');
    await audit.record(c,ctx,{action:'Declined a suggested shipping rate',reference:shipmentId,before:{status:'SUGGESTED'},after:{status:'DECLINED',carrier:row.carrier,service:row.service}});
    return row;
  });
}

// Growth: the owner's saved rule. It counts against the plan's rule allowance.
async function configure(database,ctx,{enabled}){
  return tx(database,async c=>{
    const member=(await c.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId])).rowCount;
    if(!member)throw new AuthorizationError('Only the business owner can let StockChief choose rates on its own.');
    const account=await policy.accountState(c,ctx.workspaceId);
    policy.requireJob(policy.usesAgentTerms(account)?account.plan:null,CHOOSE,'automatic',{trained:true});
    const prior=(await c.query(`SELECT enabled FROM ${rules} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
    if(enabled&&!prior?.enabled)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    await c.query(`INSERT INTO ${rules}(workspace_id,enabled,authorized_by) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id) DO UPDATE SET enabled=EXCLUDED.enabled,authorized_by=EXCLUDED.authorized_by,updated_at=now()`,[ctx.workspaceId,Boolean(enabled),ctx.actorId]);
    await audit.record(c,ctx,{action:'Shipping rate rule changed',before:{enabled:Boolean(prior?.enabled)},after:{enabled:Boolean(enabled)}});
    return {enabled:Boolean(enabled)};
  });
}
async function settings(db,workspaceId){
  if(!await installed(db))return null;
  const account=await policy.accountState(db,workspaceId),plan=policy.usesAgentTerms(account)?account.plan:null;
  if(!plan)return null;
  const rule=(await db.query(`SELECT enabled FROM ${rules} WHERE workspace_id=$1`,[workspaceId])).rows[0];
  return {plan,mode:policy.allowance(plan,CHOOSE),ruleEnabled:Boolean(rule?.enabled),canTeach:policy.permits(plan,CHOOSE,'automatic',{trained:true})&&policy.allowance(plan,CHOOSE)==='trained',
    buysAlone:policy.permits(plan,BUY,'automatic')};
}

// What the order's Ship panel shows for this parcel.
async function view(db,workspaceId,shipmentId){
  if(!await installed(db))return null;
  const state=await shipping().state(db,workspaceId,shipmentId);
  if(!candidate(state))return null;
  const row=await current(db,workspaceId,shipmentId,shipping().quoteFingerprint(state));
  if(!row||row.status==='DECLINED'||row.status==='QUEUED')return null;
  return {...row,carrierName:row.carrier?require('../sales/carriers').displayName(row.carrier):null,
    price:row.amount_minor!=null?money.format(Number(row.amount_minor),row.currency):null,
    tap:['SUGGESTED','CHOSEN'].includes(row.status)&&row.mode!=='watch'&&state.rates.some(r=>r.id===row.rate_id)};
}

// Needs you: suggestions to approve and choices that cannot go ahead.
async function inbox(db,workspaceId){
  if(!await installed(db))return [];
  const {rows}=await db.query(`SELECT DISTINCT ON (r.shipment_id) r.*,s.shipment_number,s.sales_order_id,o.order_number
    FROM ${runs} r JOIN sales_shipments s ON s.workspace_id=r.workspace_id AND s.id=r.shipment_id
    JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
    WHERE r.workspace_id=$1 AND s.status='PACKED' AND o.status<>'CANCELLED' AND coalesce(s.label_status,'') NOT IN ('PURCHASED','PENDING','REVIEW','VOID_PENDING')
    ORDER BY r.shipment_id,r.updated_at DESC LIMIT 50`,[workspaceId]);
  return rows.filter(r=>r.mode!=='watch'&&(['SUGGESTED','CHOSEN'].includes(r.status)||r.status==='HELD'&&r.hold!=='address')).slice(0,25).map(r=>{
    const choice=r.carrier?require('../sales/carriers').displayName(r.carrier)+' '+r.service+' at '+money.format(Number(r.amount_minor),r.currency)+', arriving '+r.arrival_date:null;
    return r.status==='HELD'?{kind:'shipping',importance:'Needs You',priority:66,title:'Shipping for order '+r.order_number+' is waiting',happened:r.reason,
      why:'StockChief only picks a rate that arrives by the date promised to the customer.',recommendation:'Fix what is missing on the order, or choose a rate yourself.',
      href:'/orders/'+r.sales_order_id+'#ship-now',actionLabel:'Open the order',sourceId:'label-run:'+r.id,at:r.updated_at,createdAt:r.created_at}
    :{kind:'shipping',importance:'Needs You',priority:64,title:'Approve the label for order '+r.order_number,happened:choice+(r.promised_date?' (promised by '+r.promised_date+').':'.'),
      why:r.label_reason&&r.status==='CHOSEN'?r.label_reason:'It is the cheapest current rate that arrives by the promised date.',recommendation:'One tap buys this label.',
      href:'/orders/'+r.sales_order_id+'#ship-now',actionLabel:'Approve the label',sourceId:'label-run:'+r.id,at:r.updated_at,createdAt:r.created_at};
  });
}

module.exports={KIND,run,schedule,evaluate,approve,dismiss,configure,settings,view,inbox,arrivals,choose,authority,level,addBusinessDays};

'use strict';

// Job 198: shadow mode. For an account's first 14 days (counted from
// accounts.created_at) StockChief only watches. The shared gate in
// agent-plan stopped() refuses every agent action in that period, and each
// automatic job checks the same period before it acts.
//
// This module is the one place where jobs record what they would have done
// while watching, with amounts and the evidence they used. The main automatic
// jobs record here: reorders and transfers from the replenishment planner,
// count postings and recounts, scheduled count lists, credit holds, delivery
// QC holds, payment reminders and tracking emails.
//
// The report shows what StockChief would have done, and what it would have
// saved or caught, from evidence only: the orders it would have placed, the
// stockouts it would have prevented (the item really ran out at that location
// after the order would have arrived, or was still out when it would have
// arrived) and the money it would have caught (orders it would have held for
// customers who were overdue). When the 14 days end, Needs you asks the owner
// to choose: switch on automatic work per area, for everything, or keep
// watching. Every plan has the report; each plan's own modes still decide how
// far a switched-on job may go.

const crypto=require('node:crypto');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const {has}=require('../db/schema-installed');
const {newId}=require('../lib/util');
const {ValidationError,AuthorizationError,DomainError}=require('../domain/errors');

const JOB=198,path='/autopilot/shadow';
const ACTIONS='stockchief_runtime.agent_shadow_actions',DECISIONS='stockchief_runtime.agent_shadow_decisions';
const range=(from,to)=>Array.from({length:to-from+1},(_,i)=>from+i);

// Every plan job belongs to exactly one area, following the plan's sections.
// Switching an area on grants its jobs the highest mode the plan allows and,
// where an older inventory-wide switch also guards the work, that switch.
const AREAS=[
  {key:'purchasing',label:'Reorders and purchasing',jobs:[...range(18,50),...range(52,54),...range(89,97)],capabilities:['replenishment','supplier_emails']},
  {key:'counts',label:'Stock counts',jobs:range(1,17)},
  {key:'transfers',label:'Transfers between locations',jobs:range(117,125),capabilities:['inventory_transfers']},
  {key:'holds',label:'Holds on orders and deliveries',jobs:[51,55]},
  {key:'orders',label:'Orders, shipping and returns',jobs:[...range(56,71),...range(111,116)],capabilities:['shipping_labels','shipping_notices']},
  {key:'customers',label:'Customers, invoices and payments',jobs:[...range(72,88),...range(98,110)],capabilities:['customer_replies','payment_requests']},
  {key:'catalog',label:'Products, documents and planning',jobs:range(126,151)},
  {key:'other',label:'Reports, alerts and the rest',jobs:range(152,214)}
];
const areaOf=job=>AREAS.find(a=>a.jobs.includes(Number(job)))||AREAS.at(-1);
const KINDS={order:'Order',transfer:'Transfer',count:'Count',count_list:'Count list',hold:'Hold',message:'Email'};

function digest(value){return crypto.createHash('sha256').update(JSON.stringify(value??null)).digest('hex').slice(0,40);}
function amountMinor(value,currency){
  if(value===null||value===undefined||value===''||!/^[A-Z]{3}$/.test(String(currency||'')))return null;
  try{return money.toMinor(String(value),currency,{signed:true});}catch{return null;}
}
function formatMinor(minor,currency){try{return money.format(Number(minor),currency);}catch{return String(minor)+' '+currency;}}
function quantity(value){const n=Number(value);return Number.isFinite(n)?String(Number.isInteger(n)?n:Number(n.toFixed(6))):String(value);}
const day=value=>new Date(value).toISOString().slice(0,10);

// The account, when StockChief is in its watching period and the table exists.
async function watching(db,workspaceId,account=null){
  if(!await has(db,ACTIONS))return null;
  account=account||await policy.accountState(db,workspaceId);
  return account.shadow&&account.plan&&policy.usesAgentTerms(account)?account:null;
}

// Records one thing StockChief would have done. A replay of the same action
// adds nothing. Outside the watching period nothing is recorded.
async function record(db,workspaceId,entry,account=null){
  const state=await watching(db,workspaceId,account);
  if(!state)return null;
  const job=Number(entry.job);
  if(!Number.isInteger(job)||job<1||job>214||!KINDS[entry.kind])throw new TypeError('A watched action needs its plan job and kind.');
  const currency=/^[A-Z]{3}$/.test(String(entry.currency||''))?entry.currency:null;
  const amount=currency&&entry.amountMinor!=null&&Number.isSafeInteger(Number(entry.amountMinor))?Number(entry.amountMinor):null;
  const caught=currency&&entry.caughtMinor!=null&&Number.isSafeInteger(Number(entry.caughtMinor))&&Number(entry.caughtMinor)>=0?Number(entry.caughtMinor):null;
  const lead=entry.leadDays==null||!Number.isFinite(Number(entry.leadDays))?null:Math.min(3650,Math.max(0,Math.round(Number(entry.leadDays))));
  const key=String(entry.key||'');
  const qty=entry.quantity==null||!Number.isFinite(Number(entry.quantity))?null:String(entry.quantity);
  const summary=String(entry.summary||'').replace(/\s+/g,' ').trim().slice(0,500)||KINDS[entry.kind];
  const row=(await db.query(`INSERT INTO ${ACTIONS}(id,workspace_id,job_id,area,kind,record_key,summary,sku_id,location_id,quantity,amount_minor,currency,lead_days,caught_minor,evidence,href)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)
    ON CONFLICT(workspace_id,job_id,record_key) DO NOTHING RETURNING id`,
  [newId('shadow'),workspaceId,job,areaOf(job).key,entry.kind,key.length>0&&key.length<=300?key:digest(key),summary,entry.skuId||null,entry.locationId||null,
    qty,amount,amount!=null||caught!=null?currency:null,lead,caught,JSON.stringify(entry.evidence||{}),entry.href||null])).rows[0];
  if(row)await require('../operations/postgres-security-audit').record(db,{workspaceId},{action:'StockChief only watched: it would have acted',reference:row.id,
    after:{job,kind:entry.kind,summary,amountMinor:amount,caughtMinor:caught,currency:amount!=null||caught!=null?currency:null}});
  return row?.id||null;
}

// Reorders and transfers the replenishment planner prepared while watching.
async function fromPlannedWork(db,workspaceId,items,account=null){
  const state=await watching(db,workspaceId,account);
  if(!state||!items.length)return 0;
  let recorded=0;
  for(const item of items){
    const a=item.recommendedAction||{};
    if(a.type==='purchase'&&a.skuId&&a.supplierId){
      // The same lead time the planner uses: measured, then configured, then the default.
      const lead=(await db.query(`SELECT coalesce(lead.effective_lead,$4) AS effective_lead FROM supplier_items si JOIN stockchief_runtime.supplier_planning_leads lead ON lead.supplier_item_id=si.id
        WHERE si.workspace_id=$1 AND si.sku_id=$2 AND si.supplier_id=$3 ORDER BY si.is_preferred DESC,si.id LIMIT 1`,
        [workspaceId,a.skuId,a.supplierId,require('../purchasing/replenishment-decision').DEFAULT_LEAD_DAYS])).rows[0];
      if(await record(db,workspaceId,{job:policy.permits(state.plan,20,'automatic')?20:19,kind:'order',
        key:'order:'+a.skuId+':'+(a.destinationLocationId||'inventory')+':'+a.supplierId,
        summary:'Order '+quantity(a.quantity)+' of '+(a.displayName||a.code||'this item')+' from '+(a.supplierName||'the supplier')+(a.destinationLocationId?' for '+a.destinationLocationName:''),
        skuId:a.skuId,locationId:a.destinationLocationId||null,quantity:a.quantity,amountMinor:amountMinor(a.value,a.currency),currency:a.currency,
        leadDays:lead?.effective_lead??null,evidence:{available:a.destinationAvailable,incoming:a.incoming,reorderPoint:a.reorderPoint,unitCost:a.unitCost},
        href:'/autopilot/work/'+item.id},state))recorded++;
    }else if(a.type==='transfer'&&a.skuId){
      if(await record(db,workspaceId,{job:policy.permits(state.plan,119,'automatic')?119:118,kind:'transfer',
        key:'transfer:'+a.skuId+':'+a.sourceLocationId+':'+a.destinationLocationId,
        summary:'Move '+quantity(a.quantity)+' of '+(a.displayName||a.code||'this item')+' from '+a.sourceLocationName+' to '+a.destinationLocationName,
        skuId:a.skuId,locationId:a.destinationLocationId,quantity:a.quantity,leadDays:1,
        evidence:{destinationAvailable:a.destinationAvailable,reorderPoint:a.reorderPoint,sourceAvailable:a.sourceAvailable},href:'/autopilot/work/'+item.id},state))recorded++;
    }
  }
  return recorded;
}

// A count StockChief would have posted under the owner's limit, or sent for a recount.
async function fromCount(db,workspaceId,account,rule,payload,exposureMinor,action){
  if(!action)return null;
  const where=payload.location?.name?' at '+payload.location.name:'';
  return record(db,workspaceId,{job:action==='post'?6:8,kind:'count',key:'count:'+digest(payload),
    summary:action==='post'?'Post count differences worth '+formatMinor(exposureMinor,rule.currency)+where+' under your '+formatMinor(rule.limit_minor,rule.currency)+' limit'
      :'Ask for a recount'+where+': differences worth '+formatMinor(exposureMinor,rule.currency)+' are over your '+formatMinor(rule.limit_minor,rule.currency)+' limit',
    locationId:payload.location?.id||null,amountMinor:exposureMinor,currency:rule.currency,
    evidence:{lines:(payload.lines||[]).filter(l=>l.delta).length,exposureMinor,limitMinor:Number(rule.limit_minor)}},account);
}

// Count lists the owner's schedule would have sent to staff.
async function fromCountSchedules(db,workspaceId,account,due){
  const state=await watching(db,workspaceId,account);
  if(!state||!due.length||!policy.permits(state.plan,7,'automatic',{trained:true}))return 0;
  const names=(await db.query(`SELECT r.location_id,l.name location_name,u.name counter_name FROM stockchief_runtime.agent_count_schedules r
    JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.counter_id
    WHERE r.workspace_id=$1 AND r.location_id=ANY($2::text[])`,[workspaceId,due.map(r=>r.location_id)])).rows;
  let recorded=0;
  for(const r of due){
    // Growth sends a scheduled list only after a taught, approved example.
    if(state.plan==='growth'&&!r.example_campaign_id)continue;
    const n=names.find(x=>x.location_id===r.location_id);
    if(await record(db,workspaceId,{job:7,kind:'count_list',key:'count-list:'+r.location_id+':'+r.day,
      summary:'Send '+(n?.counter_name||'your counter')+' the count list for '+(n?.location_name||'this location')+' due '+r.day,
      locationId:r.location_id,evidence:{due:r.day,intervalDays:r.interval_days}},state))recorded++;
  }
  return recorded;
}

// The orders it would have placed, by currency, and the other actions by kind.
async function totals(db,workspaceId){
  const rows=(await db.query(`SELECT kind,currency,count(*)::int n,coalesce(sum(amount_minor),0)::text amount,coalesce(sum(caught_minor),0)::text caught,
      count(caught_minor)::int caught_n
    FROM ${ACTIONS} WHERE workspace_id=$1 GROUP BY kind,currency ORDER BY kind,currency NULLS FIRST`,[workspaceId])).rows;
  const byKind={};for(const r of rows)byKind[r.kind]=(byKind[r.kind]||0)+r.n;
  const orders=rows.filter(r=>r.kind==='order');
  return {count:rows.reduce((n,r)=>n+r.n,0),byKind,
    orders:{count:orders.reduce((n,r)=>n+r.n,0),amounts:orders.filter(r=>r.currency&&Number(r.amount)).map(r=>({currency:r.currency,minor:Number(r.amount),text:formatMinor(r.amount,r.currency)}))},
    caught:{count:rows.reduce((n,r)=>n+r.caught_n,0),amounts:Object.values(rows.filter(r=>r.currency&&Number(r.caught)).reduce((m,r)=>{
      (m[r.currency]=m[r.currency]||{currency:r.currency,minor:0}).minor+=Number(r.caught);return m;},{})).map(a=>({...a,text:formatMinor(a.minor,a.currency)}))}};
}

// Stockouts it would have prevented, with the movement that proves each one:
// the item ran out at that location after the order or transfer would have
// arrived, or it was still out of stock when it would have arrived.
async function prevented(db,workspaceId,until){
  return (await db.query(`SELECT r.id,r.summary,r.kind,r.recorded_at,a.arrives,l.name location_name,
      coalesce(before.out,false) AS out_on_arrival,after.at AS ran_out_at
    FROM ${ACTIONS} r CROSS JOIN LATERAL (SELECT r.recorded_at+make_interval(days=>coalesce(r.lead_days,0)) AS arrives) a
    LEFT JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id
    LEFT JOIN LATERAL (SELECT m.balance_after<=0 AS out FROM movements m WHERE m.workspace_id=r.workspace_id AND m.sku_id=r.sku_id AND m.location_id=r.location_id
      AND m.occurred_at::timestamptz<=a.arrives ORDER BY m.occurred_at::timestamptz DESC,m.seq DESC LIMIT 1) before ON true
    LEFT JOIN LATERAL (SELECT min(m.occurred_at::timestamptz) AS at FROM movements m WHERE m.workspace_id=r.workspace_id AND m.sku_id=r.sku_id AND m.location_id=r.location_id
      AND m.occurred_at::timestamptz>a.arrives AND m.occurred_at::timestamptz<=$2 AND m.balance_after<=0) after ON true
    WHERE r.workspace_id=$1 AND r.kind IN ('order','transfer') AND r.sku_id IS NOT NULL AND r.location_id IS NOT NULL AND a.arrives<=$2
      AND (before.out OR after.at IS NOT NULL)
    ORDER BY r.recorded_at,r.id LIMIT 200`,[workspaceId,until])).rows.map(r=>({...r,
    evidence:r.ran_out_at?'Ran out at '+(r.location_name||'that location')+' on '+day(r.ran_out_at)+', after the '+(r.kind==='order'?'order':'transfer')+' would have arrived on '+day(r.arrives)+'.'
      :'Was still out of stock at '+(r.location_name||'that location')+' on '+day(r.arrives)+', when the '+(r.kind==='order'?'order':'transfer')+' would have arrived.'}));
}

async function owner(db,ctx){
  const found=(await db.query("SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!found)throw new AuthorizationError('Only the business owner can see the shadow-mode report and switch on automatic work.');
  return found;
}

function areaChoices(plan){
  const modes=require('./job-modes');
  return AREAS.map(a=>{
    const jobs=a.jobs.filter(j=>modes.auditedJobs.has(j)&&modes.choices(plan,j).length);
    return {key:a.key,label:a.label,jobs:jobs.length,alone:jobs.filter(j=>modes.choices(plan,j).includes('routine')).length};
  }).filter(a=>a.jobs);
}

async function page(db,ctx){
  await owner(db,ctx);
  const account=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'automatic');
  const installed=await has(db,ACTIONS)&&await has(db,DECISIONS);
  const endsAt=new Date(account.shadowEndsAt),now=new Date(),until=account.shadow?now:endsAt;
  const started=new Date(endsAt.getTime()-14*86400000);
  const records=installed?(await db.query(`SELECT * FROM ${ACTIONS} WHERE workspace_id=$1 ORDER BY recorded_at DESC,id DESC LIMIT 400`,[ctx.workspaceId])).rows:[];
  const counts=installed?(await db.query(`SELECT area,count(*)::int n FROM ${ACTIONS} WHERE workspace_id=$1 GROUP BY area`,[ctx.workspaceId])).rows:[];
  const decision=installed?(await db.query(`SELECT d.*,u.name decided_by_name FROM ${DECISIONS} d LEFT JOIN users u ON u.workspace_id=d.workspace_id AND u.id=d.decided_by
    WHERE d.workspace_id=$1`,[ctx.workspaceId])).rows[0]||null:null;
  const sum=installed?await totals(db,ctx.workspaceId):{count:0,byKind:{},orders:{count:0,amounts:[]},caught:{count:0,amounts:[]}};
  const stockouts=installed?await prevented(db,ctx.workspaceId,until):[];
  const show=r=>({id:r.id,summary:r.summary,kind:KINDS[r.kind],at:r.recorded_at,href:r.href,
    amount:r.amount_minor!=null?formatMinor(r.amount_minor,r.currency):null,caught:r.caught_minor!=null?formatMinor(r.caught_minor,r.currency):null});
  const choices=areaChoices(account.plan);
  return {plan:account.plan,shadow:Boolean(account.shadow),endsAt,startedAt:started,
    day:Math.min(14,Math.max(1,Math.floor((now-started)/86400000)+1)),
    orderVerb:policy.permits(account.plan,20,'automatic')?'would have placed':'would have prepared for you to send',
    total:sum.count,byKind:sum.byKind,orders:sum.orders,caught:sum.caught,
    held:records.filter(r=>r.caught_minor!=null).slice(0,20).map(show),
    stockouts:stockouts.map(r=>({summary:r.summary,evidence:r.evidence})),
    areas:AREAS.map(a=>({key:a.key,label:a.label,count:counts.find(c=>c.area===a.key)?.n||0,rows:records.filter(r=>r.area===a.key).slice(0,10).map(show)})).filter(a=>a.count),
    choices,decision:decision?{areas:decision.areas.map(k=>AREAS.find(a=>a.key===k)?.label||k),mode:decision.mode,at:decision.decided_at,by:decision.decided_by_name,
      jobs:(decision.changes?.jobs||[]).length,capabilities:decision.changes?.capabilities||[]}:null,
    canDecide:installed&&!account.shadow&&!decision};
}

// The owner's choice when watching ends. Switched-on areas get their jobs'
// highest mode on this plan; areas left off keep watching. The inventory mode
// becomes the plan's highest (Handle routine work from Growth, Ask me first on
// Starter), or Watch only when nothing is switched on. Limits are untouched:
// spending still needs the owner's own limits.
async function decide(db,ctx,input={}){
  const choice=['all','selected','watch'].includes(input.choice)?input.choice:'selected';
  const picked=choice==='all'?AREAS.map(a=>a.key):choice==='watch'?[]:[...new Set([].concat(input.areas??[]).map(String))];
  if(picked.some(k=>!AREAS.some(a=>a.key===k)))throw new ValidationError('Choose areas from the list.');
  if(choice==='selected'&&!picked.length)throw new ValidationError('Tick at least one area to switch on, or choose to keep StockChief watching.');
  return db.transaction(async c=>{
    const user=await owner(c,ctx);
    const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    if(!await has(c,DECISIONS))throw new ValidationError('This inventory is being upgraded. Try again in a few minutes.');
    if(account.shadow)throw new ValidationError('StockChief is still watching. You can switch on automatic work from '+day(account.shadowEndsAt)+'.');
    const autonomy=require('./postgres-service'),modes=require('./job-modes');
    await autonomy.ensure(c,ctx.workspaceId);
    await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR UPDATE',[ctx.workspaceId]);
    const prior=(await c.query(`SELECT areas,mode FROM ${DECISIONS} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
    if(prior)return {replayed:true,areas:prior.areas,mode:prior.mode};
    if(modes.choices(account.plan,26).length)await require('../purchasing/postgres-purchase-exposure').lock(c,ctx.workspaceId,{budgetFence:true});
    const current=new Map((await c.query('SELECT job_id,mode FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 FOR UPDATE',[ctx.workspaceId])).rows.map(r=>[Number(r.job_id),r.mode]));
    const jobs=[];
    for(const area of AREAS){
      const on=picked.includes(area.key);
      for(const job of area.jobs){
        if(!modes.auditedJobs.has(job))continue;
        const allowed=modes.choices(account.plan,job);
        if(!allowed.length)continue;
        const target=on?(allowed.includes('routine')?'routine':'inherit'):'watch',before=current.get(job)||'inherit';
        if(before===target)continue;
        await c.query(`INSERT INTO stockchief_runtime.agent_job_modes(workspace_id,job_id,mode,revision,updated_by) VALUES($1,$2,$3,1,$4)
          ON CONFLICT(workspace_id,job_id) DO UPDATE SET mode=EXCLUDED.mode,revision=stockchief_runtime.agent_job_modes.revision+1,updated_by=EXCLUDED.updated_by,changed_at=now()`,
          [ctx.workspaceId,job,target,ctx.actorId]);
        jobs.push({job,area:area.key,before,after:target});
      }
    }
    const scoped={query:(...args)=>c.query(...args),transaction:fn=>fn(c)};
    let mode=picked.length?(policy.permits(account.plan,20,'automatic')?'POLICY_AUTOMATED':'SUPERVISED'):'OBSERVE';
    const attempt=async(name,work)=>{
      await c.query('SAVEPOINT '+name);
      try{await work();await c.query('RELEASE SAVEPOINT '+name);return true;}
      catch(error){if(!(error instanceof DomainError))throw error;await c.query('ROLLBACK TO SAVEPOINT '+name);await c.query('RELEASE SAVEPOINT '+name);return false;}
    };
    // A plan version without bounded automatic work falls back to Ask me first.
    if(mode==='POLICY_AUTOMATED'&&!await attempt('shadow_mode',()=>autonomy.setMode(scoped,ctx,user,mode)))mode='SUPERVISED';
    if(mode!=='POLICY_AUTOMATED')await autonomy.setMode(scoped,ctx,user,mode);
    const capabilities=[];
    if(account.plan!=='starter'){
      for(const area of AREAS.filter(a=>picked.includes(a.key)))for(const capability of area.capabilities||[]){
        if(await attempt('shadow_capability',()=>autonomy.setCapability(scoped,ctx,user,capability,true)))capabilities.push(capability);
      }
    }
    await c.query(`INSERT INTO ${DECISIONS}(workspace_id,areas,mode,changes,decided_by) VALUES($1,$2,$3,$4::jsonb,$5)`,
      [ctx.workspaceId,picked,mode,JSON.stringify({jobs,capabilities}),ctx.actorId]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:picked.length?'Automatic work switched on after shadow mode':'StockChief kept watching after shadow mode',
      reference:'shadow-mode',before:{},after:{areas:picked,mode,jobs,capabilities}});
    return {replayed:false,areas:picked,mode,jobs:jobs.length,capabilities};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Needs you: once the 14 days are over, until the owner has chosen.
async function inbox(db,workspaceId){
  if(!await has(db,DECISIONS)||!await has(db,ACTIONS))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!account.plan||!policy.usesAgentTerms(account)||account.shadow||!policy.permits(account.plan,JOB,'automatic'))return [];
  const {rows:[row]}=await db.query(`SELECT EXISTS(SELECT 1 FROM ${DECISIONS} WHERE workspace_id=$1) decided,
    (SELECT count(*)::int FROM ${ACTIONS} WHERE workspace_id=$1) n,
    (SELECT count(*)::int FROM ${ACTIONS} WHERE workspace_id=$1 AND kind='order') orders,
    $2::timestamptz>now()-interval '30 days' recent`,[workspaceId,account.shadowEndsAt]);
  if(row.decided||!row.n&&!row.recent)return [];
  return [{kind:'approval',importance:'Important',priority:72,title:'StockChief’s 14 days of watching are over',
    happened:row.n?'It recorded '+row.n+(row.n===1?' thing':' things')+' it would have done'+(row.orders?', including '+row.orders+(row.orders===1?' order':' orders'):'')+'. Nothing was changed.'
      :'It watched for 14 days and found nothing it would have done on its own. Nothing was changed.',
    why:'Until you choose, StockChief asks you before it acts.',
    recommendation:'Read what it would have done and saved, then switch on the areas you want it to handle.',
    // Only the owner chooses what StockChief may do, so this is never passed on (job 172).
    ownerOnly:true,
    href:path,actionLabel:'See the report',sourceId:'shadow-report',createdAt:account.shadowEndsAt,timeLabel:'Watching ended',at:account.shadowEndsAt}];
}

// Ask and the agent reviews read the same records.
async function review(db,ctx,{page:number=1}={}){
  const s=await page(db,ctx);
  const offset=(Number(number)-1)*100;
  const rows=(await db.query(`SELECT * FROM ${ACTIONS} WHERE workspace_id=$1 ORDER BY recorded_at DESC,id DESC LIMIT 101 OFFSET $2`,[ctx.workspaceId,offset])).rows;
  const orders=s.orders.count+' '+(s.orders.count===1?'order':'orders')+' it '+s.orderVerb+(s.orders.amounts.length?' worth '+s.orders.amounts.map(a=>a.text).join(' and '):'');
  return {summary:(s.shadow?'StockChief is watching until '+day(s.endsAt)+'. So far: ':'In its first 14 days StockChief only watched. ')+orders+', '+
    s.stockouts.length+(s.stockouts.length===1?' stockout':' stockouts')+' it would have prevented and '+(s.caught.amounts.length?s.caught.amounts.map(a=>a.text).join(' and '):'no money')+' it would have caught.',
    rows:rows.slice(0,100).map(r=>({'When':day(r.recorded_at),'Area':areaOf(r.job_id).label,'Would have':r.summary,
      'Amount':r.amount_minor!=null?formatMinor(r.amount_minor,r.currency):'','Caught':r.caught_minor!=null?formatMinor(r.caught_minor,r.currency):'',...(r.href?{link:r.href}:{})})),
    more:rows.length>100};
}

module.exports={JOB,path,AREAS,KINDS,watching,record,fromPlannedWork,fromCount,fromCountSchedules,totals,prevented,page,decide,inbox,review,
  definition:{id:JOB,key:'shadow-report',label:'See what StockChief would have done in its first 14 days',readPage:review}};

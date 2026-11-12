'use strict';

// Job 86: builds a clearance plan with the cash it should bring back. A person
// approves prices.
//
// A plan covers one item: the units nobody needs (stock above the location's
// own target, not held for orders, transfers or returns, and not able to move
// to a location where the item sells). It suggests up to three markdown steps:
// the markdown the owner chose, then the same cut again, never below the
// recorded stock cost. Each step shows the units it should sell, the cash those
// units bring back before tax and when. Recorded sales over the last 90 days
// show how far the current selling speed would get on its own.
//
// Changing a selling price always needs a person (plan spec, page 13), so every
// step's price waits for the owner's approval on every plan. An approved price
// goes through the normal catalogue price path and the plan then tracks posted
// sales and revenue against what it expected. When stock, cost or price change
// after the plan was built, it stops and asks for a fresh plan.

const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');
const audit=require('../operations/postgres-security-audit');
const prices=require('./postgres-service');
const {hash}=require('./postgres-promotions');
const {newId}=require('../lib/util');

const JOB=86,ACTION='catalog.clearance_plan',path='/autopilot/clearance-plans',WINDOW=90,MAX_STEPS=3;
const plans='stockchief_runtime.agent_clearance_plans';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const percent=points=>(Number(points)/100).toLocaleString('en-US',{maximumFractionDigits:2})+'%';
const channelSources=new Set(['provider_catalog_sync','provider_opening_catalog']);

async function owner(db,ctx,{lock=false}={}){
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  const allowed=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!allowed)throw new AuthorizationError('Only the current inventory owner can plan clearance prices.');
}

// Every plan is a draft for a person on every plan that includes the job.
// Pause, shadow, watch mode and Watch only stop new plans and price approvals.
async function access(db,ctx,{lock=false,stop=false}={}){
  await owner(db,ctx,{lock});
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  if(stop){
    if(lock)await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
    const reason=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
    if(reason)throw new ValidationError(reason);
  }
  return state;
}

function markdownPoints(value){
  const clean=String(value??'').trim().replace(/%$/,'');
  let points;
  try{points=exact.atoms(clean,2,{label:'Markdown'});}catch(error){if(error.code!=='validation_error')throw error;points=NaN;}
  if(!Number.isSafeInteger(points)||points<1||points>9900)throw new ValidationError('Enter a markdown from 0.01% to 99%.');
  return points;
}
function stepLength(value){
  const days=Number(String(value??'').trim());
  if(!Number.isSafeInteger(days)||days<1||days>365)throw new ValidationError('Enter how many days each step runs, from 1 to 365.');
  return days;
}

async function product(db,ctx,reference){
  const clean=String(reference||'').trim();
  if(!clean)throw new ValidationError('Choose the exact item code.');
  const rows=(await db.query(`SELECT s.id,s.code,s.item_id,s.variant_label,i.name,i.unit_label,i.secondary_unit_label,i.tracking_mode
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND (s.id=$2 OR lower(s.code)=lower($2)) ORDER BY s.id LIMIT 2`,
  [ctx.workspaceId,clean])).rows;
  if(rows.length!==1)throw new ValidationError('No single active item has that code.');
  return rows[0];
}

// What the plan rests on, read fresh. A problem means a person has to look.
async function facts(db,ctx,sku){
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  const base={sku,units:0,positions:[],price:null,unitCost:null,sold:0,windowDays:WINDOW};
  if(sku.secondary_unit_label)return {...base,problem:'Measured items need a person to set a clearance price.'};
  const found=await require('../forecasting/agent-excess-stock').findings(db,ctx,{skuIds:[sku.id],today});
  const positions=found.rows.filter(r=>r.rest>0).map(r=>({locationId:r.position.location_id,location:r.position.location_name,
    units:exact.canonical(String(r.rest)),onHand:r.position.onHand,finding:r.kind.label}))
    .sort((a,b)=>a.locationId.localeCompare(b.locationId));
  const units=positions.reduce((sum,p)=>exact.add(sum,p.units),'0');
  const sold=(await db.query(`SELECT coalesce(sum(-m.quantity_delta),0)::text AS sold FROM movements m
    WHERE m.workspace_id=$1 AND m.sku_id=$2 AND m.operation='issue' AND m.reason_code IN ('sale','sold')
      AND m.occurred_at::timestamptz>now()-interval '${WINDOW} days' AND m.occurred_at::timestamptz<=now()`,[ctx.workspaceId,sku.id])).rows[0].sold;
  const known={...base,units:exact.safeNumber(units),positions,sold:exact.safeNumber(sold)};
  if(!known.units)return {...known,problem:'Nothing here needs clearing. The stock is held for orders, targets, transfers or returns, or it can move to a location where it sells.'};
  const price=await prices.currentPrice(db,ctx.workspaceId,sku.id);
  if(!price.isSet||!(price.amount_minor>0))return {...known,problem:'Set a selling price for this item first.'};
  if(channelSources.has(price.source))return {...known,problem:'This price comes from a sales channel. Change it there.'};
  const priced={...known,price:{id:price.id,amount:price.amount_minor,currency:price.currency}};
  const book=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
  if(!book)return {...priced,problem:'Set up the inventory books so the plan can compare prices with the stock cost.'};
  if(book.base_currency!==price.currency)return {...priced,problem:'The selling price and the stock cost are in different currencies.'};
  const costs=(await db.query(`SELECT location_id,quantity_units::text AS quantity,total_cost_minor::text AS total
    FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=ANY($3::text[])`,
  [ctx.workspaceId,sku.id,positions.map(p=>p.locationId)])).rows;
  let quantity='0',total=0;
  for(const p of positions){
    const cost=costs.find(c=>c.location_id===p.locationId);
    if(!cost||Number(cost.quantity)!==Number(p.onHand))return {...priced,problem:'Complete the stock cost for this item first.'};
    quantity=exact.add(quantity,cost.quantity);total=money.sum([total,money.integer(cost.total,'Recorded stock cost')]);
  }
  if(exact.safeNumber(quantity)<=0)return {...priced,problem:'Complete the stock cost for this item first.'};
  // Round the unit cost up, so no step can sell below what the stock cost.
  const q=BigInt(exact.atoms(quantity,6)),unitCost=Number((BigInt(total)*1000000n+q-1n)/q);
  return {...priced,unitCost};
}
// Only these facts must still hold when a person approves the first price.
const evidenceOf=f=>({skuId:f.sku.id,priceId:f.price.id,price:f.price.amount,currency:f.price.currency,unitCost:f.unitCost,
  units:exact.canonical(String(f.units)),positions:f.positions.map(p=>[p.locationId,p.units])});

// Whole units stay whole; the last step takes what is left over.
function split(units,parts){
  const precision=Number.isInteger(units)?0:6,atoms=exact.atoms(String(units),precision),each=Math.floor(atoms/parts);
  return Array.from({length:parts},(_,i)=>exact.fromAtoms(i===parts-1?atoms-each*(parts-1):each,precision));
}

// The suggested steps. Expected units are the plan's target per step: the units
// spread evenly over the steps. When recorded sales would sell them all during
// the first step, one step is enough.
function ladder(f,{points,stepDays}){
  const priceAt=p=>exact.ratioMinor(f.price.amount,String(10000-p),'10000');
  if(priceAt(points)<f.unitCost)throw new ValidationError('A '+percent(points)+' markdown sells below the recorded cost of '+
    money.format(f.unitCost,f.price.currency)+' each. Choose a smaller markdown.');
  let floor=Math.min(9900,Math.floor((f.price.amount-f.unitCost)*10000/f.price.amount));
  while(floor>points&&priceAt(floor)<f.unitCost)floor--;
  const steps=[points];
  for(let k=2;k<=MAX_STEPS;k++){const next=Math.min(k*points,floor);if(next>steps.at(-1))steps.push(next);}
  const speed=Math.floor(f.sold*stepDays/WINDOW);
  const used=speed>=f.units?steps.slice(0,1):steps;
  const units=split(f.units,used.length);
  return used.map((p,i)=>{const price=priceAt(p);return {step:i+1,points:p,priceMinor:price,days:stepDays,
    expectedUnits:units[i],expectedCashMinor:exact.costMinor(units[i],price)};});
}

async function preview(db,ctx,{sku,markdown,stepDays}){
  const found=await product(db,ctx,sku),f=await facts(db,ctx,found);
  if(f.problem)return {facts:f,problem:f.problem};
  if(markdown==null||markdown===''||stepDays==null||stepDays==='')return {facts:f};
  const steps=ladder(f,{points:markdownPoints(markdown),stepDays:stepLength(stepDays)});
  return {facts:f,steps,expectedCash:money.sum(steps.map(s=>s.expectedCashMinor))};
}

// Saves the plan as a draft. Nothing changes until a person approves its price.
async function prepareIn(c,ctx,input,{automatic=false}={}){
  await access(c,ctx,{lock:true,stop:true});
  const requestKey=String(input.requestKey||'').trim();
  if(!requestKey||requestKey.length>200)throw new ValidationError('Reload the page before building this plan.');
  const prior=(await c.query(`SELECT * FROM ${plans} WHERE workspace_id=$1 AND request_key=$2`,[ctx.workspaceId,requestKey])).rows[0];
  if(prior)return {id:prior.id,replayed:true};
  const sku=await product(c,ctx,input.sku);
  await c.query('SELECT id FROM skus WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,sku.id]);
  const open=(await c.query(`SELECT id FROM ${plans} WHERE workspace_id=$1 AND sku_id=$2 AND status IN ('DRAFT','ACTIVE')`,[ctx.workspaceId,sku.id])).rows[0];
  if(open)throw new ValidationError('This item already has an open clearance plan. Open it instead.');
  const f=await facts(c,ctx,sku);
  if(f.problem)throw new ValidationError(f.problem);
  const stepDays=stepLength(input.stepDays),steps=ladder(f,{points:markdownPoints(input.markdown),stepDays});
  const evidence={...evidenceOf(f),sold:f.sold,windowDays:WINDOW,locations:f.positions.map(p=>({id:p.locationId,name:p.location,units:p.units,finding:p.finding}))};
  const id=newId('clearance-plan'),expected=money.sum(steps.map(s=>s.expectedCashMinor));
  await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'clearance-plan:'+id,Buffer.byteLength(JSON.stringify({steps,evidence}))*3+8192,{finished:true});
  await c.query(`INSERT INTO ${plans}(id,workspace_id,sku_id,status,request_key,currency,original_price_id,original_price_minor,unit_cost_minor,units,
      step_days,steps,evidence,evidence_hash,expected_cash_minor,automatic,created_by)
    VALUES($1,$2,$3,'DRAFT',$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16)`,
  [id,ctx.workspaceId,sku.id,requestKey,f.price.currency,f.price.id,f.price.amount,f.unitCost,exact.canonical(String(f.units)),stepDays,
    JSON.stringify(steps),JSON.stringify(evidence),hash(evidenceOf(f)),expected,automatic,ctx.actorId]);
  await audit.record(c,ctx,{action:automatic?'Clearance plan prepared on its own':'Clearance plan prepared',reference:id,
    after:{sku:sku.code,units:exact.canonical(String(f.units)),steps:steps.map(s=>percent(s.points)+' '+money.format(s.priceMinor,f.price.currency)),
      expectedCash:money.format(expected,f.price.currency)}});
  return {id};
}
const prepare=(database,ctx,input)=>tx(database,c=>prepareIn(c,ctx,input));

async function load(db,ctx,id,{lock=false}={}){
  const row=(await db.query(`SELECT p.*,s.code,s.item_id,i.name,i.unit_label FROM ${plans} p
    JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE p.workspace_id=$1 AND p.id=$2${lock?' FOR UPDATE OF p':''}`,[ctx.workspaceId,String(id||'')])).rows[0];
  if(!row)throw new NotFoundError('That clearance plan is not in this inventory.');
  return row;
}

// A person approves one step's price. The first approval rechecks the stock,
// cost and price the plan was built on; later steps need the plan's own price
// to still be the current one.
async function approve(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true,stop:true});
    const plan=await load(c,ctx,id,{lock:true}),step=Number(input.step);
    if(!Number.isSafeInteger(step)||step<1||step>plan.steps.length)throw new ValidationError('Choose a step of this plan.');
    if(plan.steps[step-1].priceId)return {replayed:true,step};
    if(input.confirmed!=='yes'||input.evidenceHash!==plan.evidence_hash)throw new ValidationError('Review the current plan and confirm this exact price.');
    let previous;
    if(plan.status==='DRAFT'){
      if(step!==1)throw new ValidationError('Approve the first step first.');
      const f=await facts(c,ctx,{id:plan.sku_id,code:plan.code});
      if(f.problem)throw new ValidationError(f.problem);
      if(hash(evidenceOf(f))!==plan.evidence_hash)throw new ValidationError('The stock, cost or price changed since this plan was built. Build a fresh plan.');
      previous={id:plan.original_price_id,amount:Number(plan.original_price_minor)};
    }else if(plan.status==='ACTIVE'){
      if(step!==plan.current_step+1)throw new ValidationError('Approve the next step of this plan.');
      const current=await prices.currentPrice(c,ctx.workspaceId,plan.sku_id);
      if(current.id!==plan.current_price_id)throw new ValidationError('The selling price changed outside this plan. End the plan or set the price on the item.');
      previous={id:current.id,amount:current.amount_minor};
    }else throw new ValidationError('This plan is closed.');
    const s=plan.steps[step-1];
    const saved=await prices.setPriceInTransaction(c,ctx,{skuId:plan.sku_id,amountMinor:s.priceMinor,currency:plan.currency,
      expectedCurrentId:previous.id,source:'agent_clearance_plan',sourceDetail:{planId:plan.id,step}});
    if(saved.amount_minor!==s.priceMinor||saved.currency!==plan.currency)throw new ValidationError('The selling price did not change as approved.');
    const steps=plan.steps.map((x,i)=>i===step-1?{...x,priceId:saved.id,approvedBy:ctx.actorId,startedAt:new Date().toISOString()}:x);
    await c.query(`UPDATE ${plans} SET status='ACTIVE',current_step=$3,current_price_id=$4,steps=$5::jsonb,
      started_at=coalesce(started_at,clock_timestamp()),revision=revision+1 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,plan.id,step,saved.id,JSON.stringify(steps)]);
    await audit.record(c,ctx,{action:'Clearance price approved',reference:plan.id,before:{price:money.format(previous.amount,plan.currency)},
      after:{price:money.format(s.priceMinor,plan.currency),sku:plan.code,step,markdown:percent(s.points),priceId:saved.id}});
    return {step,priceId:saved.id};
  });
}

// A person closes the plan. A draft is cancelled. A running plan ends, and can
// put the price it started from back while nobody changed the price since.
async function endIn(c,ctx,plan,{restore=false}={}){
  if(['ENDED','CANCELLED'].includes(plan.status))return {replayed:true};
  if(plan.status==='DRAFT'){
    await c.query(`UPDATE ${plans} SET status='CANCELLED',ended_by=$3,ended_at=clock_timestamp(),revision=revision+1 WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,plan.id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Clearance plan cancelled',reference:plan.id,after:{sku:plan.code}});
    return {cancelled:true};
  }
  let restored=null;
  if(restore){
    const current=await prices.currentPrice(c,ctx.workspaceId,plan.sku_id);
    if(current.id!==plan.current_price_id)throw new ValidationError('The selling price changed outside this plan. Set it on the item instead.');
    restored=await prices.setPriceInTransaction(c,ctx,{skuId:plan.sku_id,amountMinor:Number(plan.original_price_minor),currency:plan.currency,
      expectedCurrentId:current.id,source:'agent_clearance_plan',sourceDetail:{planId:plan.id,restore:true}});
  }
  await c.query(`UPDATE ${plans} SET status='ENDED',ended_by=$3,ended_at=clock_timestamp(),restored_price_id=$4,revision=revision+1
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,plan.id,ctx.actorId,restored?.id||null]);
  await audit.record(c,ctx,{action:'Clearance plan ended',reference:plan.id,
    after:{sku:plan.code,restoredPrice:restored?money.format(restored.amount_minor,plan.currency):null}});
  return {ended:true,restored:Boolean(restored)};
}
async function end(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true});
    const plan=await load(c,ctx,id,{lock:true});
    if(input.confirmed!=='yes'&&!['ENDED','CANCELLED'].includes(plan.status))throw new ValidationError('Confirm that this plan stops.');
    return endIn(c,ctx,plan,{restore:input.restore==='yes'});
  });
}
// Used by job 9's undo: only a plan nobody has approved yet can go.
async function cancelDraft(c,ctx,id){
  const plan=await load(c,ctx,id,{lock:true});
  if(plan.status==='CANCELLED')return {replayed:true};
  if(plan.status!=='DRAFT')throw new ValidationError('A price on this clearance plan was already approved. End the plan on its page.');
  return endIn(c,ctx,plan);
}

// Posted sales since each approved step: units from the stock ledger and the
// revenue before tax the sale posted in the plan's currency.
async function progress(db,ctx,plan){
  if(!plan.started_at)return null;
  const sales=(await db.query(`SELECT m.occurred_at::timestamptz AS at,(-m.quantity_delta)::text AS units,r.revenue
    FROM movements m LEFT JOIN accounting_inventory_cost_movements cm ON cm.workspace_id=m.workspace_id AND cm.inventory_movement_id=m.id
    LEFT JOIN accounting_journal_entries e ON e.workspace_id=cm.workspace_id AND e.id=cm.journal_entry_id AND e.status='POSTED'
      AND e.source_type='sale_fulfillment'
    LEFT JOIN LATERAL(SELECT sum(l.credit_minor-l.debit_minor)::bigint AS revenue FROM accounting_journal_lines l
      JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id AND a.system_key='SALES_REVENUE'
      WHERE l.workspace_id=e.workspace_id AND l.entry_id=e.id AND l.sku_id=m.sku_id AND l.currency=$4
      HAVING count(*)>0) r ON e.id IS NOT NULL
    WHERE m.workspace_id=$1 AND m.sku_id=$2 AND m.operation='issue' AND m.reason_code IN ('sale','sold')
      AND m.occurred_at::timestamptz>=$3::timestamptz ORDER BY m.occurred_at::timestamptz,m.id`,
  [ctx.workspaceId,plan.sku_id,plan.started_at,plan.currency])).rows;
  const now=Date.now();
  const steps=plan.steps.map((s,i)=>{
    if(!s.startedAt)return {...s,actualUnits:null,actualCashMinor:null};
    const from=Date.parse(s.startedAt),to=plan.steps[i+1]?.startedAt?Date.parse(plan.steps[i+1].startedAt):Infinity;
    const inside=sales.filter(r=>r.at.getTime()>=from&&r.at.getTime()<to);
    return {...s,actualUnits:inside.reduce((sum,r)=>exact.add(sum,r.units),'0'),
      actualCashMinor:inside.every(r=>r.revenue!=null)?money.sum(inside.map(r=>Number(r.revenue))):null,
      dueAt:new Date(from+s.days*86400000).toISOString()};
  });
  const units=sales.reduce((sum,r)=>exact.add(sum,r.units),'0');
  const current=steps[plan.current_step-1],target=steps.slice(0,plan.current_step).reduce((sum,s)=>exact.add(sum,s.expectedUnits),'0');
  const due=plan.status==='ACTIVE'&&current&&Date.parse(current.dueAt)<=now;
  const behind=exact.safeNumber(exact.subtract(units,target),{signed:true})<0;
  const cleared=exact.safeNumber(exact.subtract(units,plan.units),{signed:true})>=0;
  const label=cleared?'All planned units sold':due&&behind?(plan.current_step<plan.steps.length?'Behind plan. The next step is due.':'Behind plan'):'On plan';
  return {steps,units,cashMinor:sales.every(r=>r.revenue!=null)?money.sum(sales.map(r=>Number(r.revenue))):null,
    target,due,behind,cleared,label,nextDue:due&&behind&&!cleared&&plan.current_step<plan.steps.length};
}

const statusLabels={DRAFT:'Waiting for your price approval',ACTIVE:'Running',ENDED:'Ended',CANCELLED:'Cancelled'};

async function page(db,ctx,{id=null,page:number=1}={}){
  await access(db,ctx);
  number=Number(number);
  if(!Number.isSafeInteger(number)||number<1||number>1000000)throw new ValidationError('Choose a valid page.');
  if(!id){
    const rows=(await db.query(`SELECT p.id,p.status,p.units::text,p.currency,p.expected_cash_minor,p.current_step,jsonb_array_length(p.steps) AS step_count,
        p.created_at,p.automatic,s.code,i.name FROM ${plans} p JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id
        JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE p.workspace_id=$1 ORDER BY (p.status IN ('DRAFT','ACTIVE')) DESC,p.created_at DESC,p.id LIMIT 51 OFFSET $2`,
    [ctx.workspaceId,(number-1)*50])).rows;
    return {plan:null,plans:rows.slice(0,50).map(r=>({...r,units:exact.canonical(r.units),label:statusLabels[r.status]})),more:rows.length>50,page:number};
  }
  const plan=await load(db,ctx,id);
  const tracking=await progress(db,ctx,plan);
  let hold=null;
  if(plan.status==='DRAFT'){
    const f=await facts(db,ctx,{id:plan.sku_id,code:plan.code,secondary_unit_label:null});
    hold=f.problem||(hash(evidenceOf(f))!==plan.evidence_hash?'The stock, cost or price changed since this plan was built. Build a fresh plan.':null);
  }
  const current=plan.status==='ACTIVE'?await prices.currentPrice(db,ctx.workspaceId,plan.sku_id):null;
  if(current&&current.id!==plan.current_price_id)hold='The selling price changed outside this plan. End the plan or set the price on the item.';
  const stop=await policy.stopped(db,ctx.workspaceId,await policy.accountState(db,ctx.workspaceId),ACTION,false);
  const next=plan.status==='DRAFT'?1:plan.status==='ACTIVE'&&plan.current_step<plan.steps.length?plan.current_step+1:null;
  return {plan:{...plan,units:exact.canonical(plan.units),label:statusLabels[plan.status],steps:tracking?tracking.steps:plan.steps},tracking,hold,stop,next,
    bookValue:exact.costMinor(plan.units,Number(plan.unit_cost_minor)),
    restorable:plan.status==='ACTIVE'&&current?.id===plan.current_price_id,percent};
}

async function inbox(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const rows=(await db.query(`SELECT p.id,p.status,p.units::text,p.current_step,jsonb_array_length(p.steps) AS step_count,p.created_at,s.code,
      (p.steps->(greatest(p.current_step,1)-1)->>'startedAt')::timestamptz+make_interval(days=>p.step_days)<=now() AS due,
      (SELECT coalesce(sum(-m.quantity_delta),0) FROM movements m WHERE m.workspace_id=p.workspace_id AND m.sku_id=p.sku_id
        AND m.operation='issue' AND m.reason_code IN ('sale','sold') AND m.occurred_at::timestamptz>=p.started_at)::text AS sold,
      (SELECT coalesce(sum((x.step->>'expectedUnits')::numeric),0) FROM jsonb_array_elements(p.steps) WITH ORDINALITY AS x(step,n)
        WHERE x.n<=p.current_step)::text AS target
    FROM ${plans} p JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id
    WHERE p.workspace_id=$1 AND p.status IN ('DRAFT','ACTIVE') ORDER BY p.created_at,p.id LIMIT 200`,[workspaceId])).rows;
  const waiting=rows.filter(r=>r.status==='DRAFT');
  const due=rows.filter(r=>r.status==='ACTIVE'&&r.due&&Number(r.sold)<Number(r.target)&&r.current_step<r.step_count);
  const cleared=rows.filter(r=>r.status==='ACTIVE'&&Number(r.sold)>=Number(r.units));
  const notices=[];
  const at=rows[0]?.created_at;
  if(waiting.length)notices.push({kind:'inventory',importance:'Needs You',priority:60,grouped:true,
    title:waiting.length===1?'A clearance price waits for you':waiting.length+' clearance prices wait for you',
    happened:'Clearance plans for '+waiting.slice(0,3).map(r=>r.code).join(', ')+(waiting.length>3?' and more':'')+' are ready.',
    why:'Changing a selling price always needs a person.',recommendation:'Review each plan and approve its first price, or cancel it.',
    href:waiting.length===1?path+'/'+encodeURIComponent(waiting[0].id):path,actionLabel:'Review clearance plans',sourceId:'clearance-plans:waiting',at,createdAt:at});
  for(const r of due.slice(0,10))notices.push({kind:'inventory',importance:'Needs You',priority:55,
    title:'The next clearance step for '+r.code+' is due',happened:exact.canonical(r.sold)+' of '+exact.canonical(r.target)+' planned units sold so far.',
    why:'The plan is behind, and only a person can lower the price again.',recommendation:'Approve the next step, or end the plan.',
    href:path+'/'+encodeURIComponent(r.id),actionLabel:'Review the plan',sourceId:'clearance-plan-due:'+r.id+':'+r.current_step,at:r.created_at,createdAt:r.created_at});
  for(const r of cleared.slice(0,10))notices.push({kind:'inventory',importance:'Needs You',priority:40,
    title:'Every planned unit of '+r.code+' sold',happened:'The clearance price is still live.',
    why:'Only a person decides whether the price goes back.',recommendation:'End the plan, and choose whether the original price comes back.',
    href:path+'/'+encodeURIComponent(r.id),actionLabel:'End the plan',sourceId:'clearance-plan-cleared:'+r.id,at:r.created_at,createdAt:r.created_at});
  return notices;
}

module.exports={JOB,ACTION,path,markdownPoints,stepLength,preview,prepare,prepareIn,approve,end,cancelDraft,page,inbox,load,progress};

'use strict';

// Job 54: every new or changed customer order is checked for stock, credit,
// address and price problems by the worker. Growth, Pro and Custom attach the
// problems to the order and to Needs you on their own; Starter gets one sample
// check as a suggestion. A check never changes or cancels an order.
const {ValidationError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const addresses=require('../shipping/address');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');
const JOB=54,KIND='agent.order-check.v1',ACTION='sales_order.check';
const OPEN=['DRAFT','CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED'];
// What counts as a big discount until the owner saves a different limit.
const DEFAULT_DISCOUNT_BPS=2000;
const labels={stock:'Stock',credit:'Credit',address:'Address',price:'Price'};
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const plural=(n,one,many)=>n+' '+(Number(n)===1?one:many);
const units=value=>exact.canonical(String(value));
// Whole-word unit names read as plurals; short symbols such as kg stay as they are.
const unitName=(label,quantity)=>Number(quantity)!==1&&/^[a-z]{4,}$/i.test(label)&&!/s$/i.test(label)?label+'s':label;

async function discountLimit(db,workspaceId){
  const row=(await db.query('SELECT discount_alert_bps FROM stockchief_runtime.agent_order_check_settings WHERE workspace_id=$1',[workspaceId])).rows[0];
  return row?Number(row.discount_alert_bps):DEFAULT_DISCOUNT_BPS;
}

async function settings(db,ctx){
  const bps=await discountLimit(db,ctx.workspaceId);
  return {discountPercent:bps/100};
}

async function saveSettings(db,ctx,input){
  const percent=Number(String(input.discountPercent??'').trim());
  if(!Number.isFinite(percent)||percent<1||percent>100||Math.round(percent*100)!==percent*100)
    throw new ValidationError('Enter the discount off the list price, from 1 to 100 percent, that should be flagged.');
  return db.transaction(async c=>{
    const state=await require('../autopilot/job-reviews').ownerState(c,ctx);
    policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,JOB,'draft');
    const before=await discountLimit(c,ctx.workspaceId),bps=Math.round(percent*100);
    await c.query(`INSERT INTO stockchief_runtime.agent_order_check_settings(workspace_id,discount_alert_bps,updated_by) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id) DO UPDATE SET discount_alert_bps=EXCLUDED.discount_alert_bps,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [ctx.workspaceId,bps,ctx.actorId]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Order check discount limit changed',
      before:{discountPercent:before/100},after:{discountPercent:percent}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function stockProblems(db,ctx,order){
  const lines=(await db.query(`SELECT l.id,l.sku_id,s.code,i.unit_label,l.quantity_ordered::text ordered,l.quantity_fulfilled::text fulfilled,
      coalesce(to_jsonb(l)->>'direct_committed_quantity','0') direct,
      coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id),0)::text reserved
    FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY l.created_at,l.id`,[ctx.workspaceId,order.id])).rows;
  const parts=(await db.query(`SELECT k.sales_order_line_id,k.component_sku_id sku_id,s.code,i.unit_label,
      greatest(k.quantity_required-k.quantity_fulfilled-coalesce((SELECT sum(x.quantity) FROM sales_order_kit_allocations x
        WHERE x.workspace_id=k.workspace_id AND x.kit_component_id=k.id),0),0)::text needed
    FROM sales_order_kit_components k JOIN sales_order_lines l ON l.workspace_id=k.workspace_id AND l.id=k.sales_order_line_id
    JOIN skus s ON s.workspace_id=k.workspace_id AND s.id=k.component_sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE k.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY k.sales_order_line_id,s.code`,[ctx.workspaceId,order.id])).rows;
  const kitLines=new Set(parts.map(p=>p.sales_order_line_id)),needs=new Map();
  const need=(row,quantity)=>{
    if(!(Number(quantity)>0))return;
    const prior=needs.get(row.sku_id);
    needs.set(row.sku_id,{code:row.code,unit:row.unit_label,quantity:prior?exact.add(prior.quantity,quantity):String(quantity)});
  };
  for(const line of lines){
    if(kitLines.has(line.id))continue;
    need(line,exact.subtract(exact.subtract(exact.subtract(line.ordered,line.fulfilled),line.direct),line.reserved));
  }
  for(const part of parts)need(part,part.needed);
  if(!needs.size)return [];
  const places=(await db.query(`SELECT b.sku_id,b.location_id FROM balances b JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id
    WHERE b.workspace_id=$1 AND b.sku_id=ANY($2::text[]) AND l.is_active=1 AND l.custody_agreement_id IS NULL AND ($3::text IS NULL OR b.location_id=$3)`,
  [ctx.workspaceId,[...needs.keys()],order.fulfillment_location_id||null])).rows;
  const positions=await require('../domain/postgres-stock-availability').readMany(db,ctx.workspaceId,
    places.map(p=>({skuId:p.sku_id,locationId:p.location_id})),{customerId:order.customer_id});
  const problems=[];
  for(const [skuId,wanted] of needs){
    let free='0';
    for(const p of places.filter(p=>p.sku_id===skuId)){
      const position=positions.get(JSON.stringify([skuId,p.location_id]));
      if(position&&Number(position.available)>0)free=exact.add(free,String(position.available));
    }
    if(Number(free)<Number(wanted.quantity))problems.push({check:'stock',problem:'Only '+units(free)+' of the '+units(wanted.quantity)+' '+unitName(wanted.unit,wanted.quantity)+
      ' of '+wanted.code+' still needed '+(Number(free)===1?'is':'are')+' free after other orders, holds and protected stock.'});
  }
  return problems;
}

async function creditProblems(db,ctx,order,today){
  const problems=[];
  const late=(await db.query(`SELECT count(*)::int n,min(due_date)::text oldest,currency,sum(balance_minor)::bigint owed
    FROM accounting_customer_invoices WHERE workspace_id=$1 AND customer_id=$2 AND status IN ('OPEN','PARTIALLY_PAID')
      AND balance_minor>0 AND due_date<$3 GROUP BY currency ORDER BY currency`,[ctx.workspaceId,order.customer_id,today])).rows;
  if(late.length){
    const count=late.reduce((n,r)=>n+r.n,0),oldest=late.map(r=>r.oldest).sort()[0];
    problems.push({check:'credit',kind:'overdue',problem:plural(count,'overdue invoice','overdue invoices')+' ('+
      late.map(r=>money.format(r.owed,r.currency)).join(' and ')+'), the oldest due '+oldest+'.'});
  }
  const limit=await require('./order-credit-exposure').forAnyOrder(db,ctx,order.id);
  if(limit?.Result==='Over limit')problems.push({check:'credit',kind:'limit',problem:'Over the credit limit: '+limit['Exposure with this order']+
    ' owed or ordered against a limit of '+limit['Credit limit']+'.'});
  else if(limit&&limit.Result!=='Within limit')problems.push({check:'credit',kind:'limit',problem:'A person needs to check the credit limit: other currencies or missing prices.'});
  return problems;
}

const normalized=text=>String(text||'').toLowerCase().replace(/[.,#]/g,' ').replace(/\s+/g,' ').trim();

async function addressProblems(db,ctx,order){
  if(order.delivery_method!=='SHIP')return [];
  const fields=order.ship_to_address===order.customer_shipping_address?order.customer_shipping_address_fields:null;
  const parsed=addresses.parse(order.ship_to_address,fields);
  if(!parsed.complete)return [{check:'address',problem:addresses.why(parsed)}];
  // Online shoppers from connected channels are not held for a new address.
  const channel=(await db.query(`SELECT 1 FROM connection_mappings WHERE workspace_id=$1 AND entity_type='sales_order' AND foundry_record_id=$2 LIMIT 1`,
    [ctx.workspaceId,order.id])).rowCount;
  if(channel)return [];
  const previous=(await db.query(`SELECT order_number,ship_to_address FROM sales_orders WHERE workspace_id=$1 AND customer_id=$2 AND id<>$3
    AND status<>'CANCELLED' AND delivery_method='SHIP' AND (created_at,id)<($4,$3) ORDER BY created_at DESC,id DESC LIMIT 1`,
  [ctx.workspaceId,order.customer_id,order.id,order.created_at])).rows[0];
  if(previous&&normalized(previous.ship_to_address)!==normalized(order.ship_to_address))
    return [{check:'address',problem:'The ship-to address changed since '+previous.order_number+'. A person checks a new address on business and staff-entered orders.'}];
  return [];
}

async function priceProblems(db,ctx,order){
  const problems=[];
  const missing=(await db.query(`SELECT s.code FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2 AND l.unit_price_minor IS NULL ORDER BY s.code`,[ctx.workspaceId,order.id])).rows;
  for(const row of missing)problems.push({check:'price',problem:row.code+' has no price.'});
  // Below cost uses the same exact evidence as the order price review (job 82).
  const below=(await db.query(`SELECT code,recorded,compared_amount,basis_quantity,basis_unit,currency FROM (${require('./agent-order-price-alerts').findings('NULL')}) f
    WHERE id=$3 AND problem='Selling below recorded cost' ORDER BY code`,[ctx.workspaceId,order.order_number,order.id])).rows;
  for(const row of below){
    const cost=row.compared_amount==null?null:money.format(row.compared_amount,row.currency)+(row.basis_quantity?' per '+row.basis_quantity+' '+row.basis_unit:'');
    problems.push({check:'price',problem:row.code+' is priced below cost: '+money.format(row.recorded,row.currency)+(cost?' against a cost of '+cost:'')+'.'});
  }
  const snapshot=(await db.query(`SELECT quote FROM stockchief_runtime.pricing_order_snapshots WHERE workspace_id=$1 AND sales_order_id=$2
    ORDER BY created_at DESC,(id=$3) DESC,id DESC LIMIT 1`,[ctx.workspaceId,order.id,order.pricing_quote_id])).rows[0]?.quote;
  if(!Array.isArray(snapshot?.lines)||snapshot.currency!==order.currency)return problems;
  const quoted=snapshot.lines.filter(l=>l&&typeof l.skuId==='string');
  const skus=(await db.query(`SELECT s.id,s.code,p.amount_minor FROM skus s LEFT JOIN LATERAL(SELECT amount_minor FROM sku_prices
      WHERE workspace_id=s.workspace_id AND sku_id=s.id AND currency=$3 ORDER BY created_at DESC,id DESC LIMIT 1)p ON true
    WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])`,[ctx.workspaceId,quoted.map(l=>l.skuId),order.currency])).rows;
  const bySku=new Map(skus.map(s=>[s.id,s])),limit=await discountLimit(db,ctx.workspaceId);
  for(const line of quoted){
    const list=bySku.get(line.skuId)?.amount_minor,quantity=Number(line.pricingQuantity??line.quantity);
    const net=Number(line.netMinor)+Math.min(Number(line.chargesMinor||0),0);
    if(list==null||!(Number(list)>0)||!(quantity>0)||!Number.isFinite(net))continue;
    const listTotal=Number(list)*quantity,off=listTotal-net;
    if(off*10000>listTotal*limit)problems.push({check:'price',problem:bySku.get(line.skuId).code+' is '+Math.round(off*100/listTotal)+
      '% below its list price of '+money.format(Number(list),order.currency)+'. Your limit is '+(limit/100)+'%.'});
  }
  // A typed-in price can undercut the price list the customer is entitled to.
  const typed=quoted.map((line,index)=>({line,index})).filter(x=>x.line.priceOverride===true);
  if(typed.length){
    try{
      const agreed=await require('../pricing/postgres-promotions').prepareQuote(db,ctx,{customerId:order.customer_id,currency:order.currency,
        at:new Date().toISOString(),lines:quoted.map(l=>({skuId:l.skuId,quantity:l.quantity,
          ...(l.pricingQuantity!=null?{secondaryQuantity:l.pricingQuantity}:{})}))});
      for(const {line,index} of typed){
        const expected=agreed.lines[index];
        if(expected?.priceSource&&Number(expected.unitPriceMinor)>Number(line.unitPriceMinor))
          problems.push({check:'price',problem:bySku.get(line.skuId).code+' is priced at '+money.format(Number(line.unitPriceMinor),order.currency)+
            ', below the customer’s agreed price of '+money.format(Number(expected.unitPriceMinor),order.currency)+'.'});
      }
    }catch(error){if(error.code!=='validation_error')throw error;
      problems.push({check:'price',problem:'A person needs to compare the typed-in prices with the customer’s price list. '+error.message});}
  }
  return problems;
}

async function order(db,workspaceId,id){
  return (await db.query(`SELECT o.*,c.name customer_name,c.shipping_address customer_shipping_address,
      c.shipping_address_fields customer_shipping_address_fields FROM sales_orders o
    JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id WHERE o.workspace_id=$1 AND o.id=$2`,[workspaceId,id])).rows[0];
}

// Every check, in a fixed order, with the reason a person can act on.
async function evaluate(db,ctx,id){
  const current=await order(db,ctx.workspaceId,id);
  if(!current)return null;
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  const findings=[...await stockProblems(db,ctx,current),...await creditProblems(db,ctx,current,today),
    ...await addressProblems(db,ctx,current),...await priceProblems(db,ctx,current)];
  return {order:current,findings};
}

// A short form for tables: how many problems and which checks found them.
function summary(findings){
  return plural(findings.length,'problem','problems')+': '+[...new Set(findings.map(f=>f.check))].join(', ');
}

function describe(findings){
  return findings.map(f=>labels[f.check]+': '+f.problem).join(' ');
}

// Whether checks may run and attach flags alone right now. Shadow mode, Watch
// only, pause and the job's Watch or Ask me first settings only watch.
async function automatic(db,workspaceId,state){
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return false;
  return !await policy.stopped(db,workspaceId,state,ACTION,true);
}

async function check(c,workspaceId,id,trigger){
  const actorId=await require('./agent-backorders').currentOwner(c,workspaceId);
  if(!actorId)return {checked:false};
  const ctx={workspaceId,actorId};
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['order-check:'+workspaceId+':'+id]);
  const result=await evaluate(c,ctx,id);
  if(!result||!OPEN.includes(result.order.status))return {checked:false};
  const prior=(await c.query('SELECT * FROM stockchief_runtime.agent_order_checks WHERE workspace_id=$1 AND sales_order_id=$2 FOR UPDATE',
    [workspaceId,id])).rows[0];
  const version=Number(result.order.version);
  if(prior&&Number(prior.order_version)>version)return {checked:false,stale:true};
  // Stored JSON reorders keys, so compare the findings field by field.
  const flat=list=>JSON.stringify((list||[]).map(f=>[f.check,f.kind||null,f.problem]));
  const status=result.findings.length?'FLAGGED':'CLEAR',same=prior&&flat(prior.findings)===flat(result.findings);
  await c.query(`INSERT INTO stockchief_runtime.agent_order_checks AS current(workspace_id,sales_order_id,order_version,status,findings,trigger)
    VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(workspace_id,sales_order_id) DO UPDATE SET order_version=EXCLUDED.order_version,
      status=EXCLUDED.status,findings=EXCLUDED.findings,trigger=EXCLUDED.trigger,checked_at=now()`,
  [workspaceId,id,version,status,JSON.stringify(result.findings),trigger]);
  if(!same&&(result.findings.length||prior?.findings?.length))await require('../operations/postgres-security-audit').record(c,ctx,{
    action:result.findings.length?'Order check found problems':'Order check cleared',reference:result.order.order_number,
    before:prior?{status:prior.status,findings:prior.findings}:{},after:{status,findings:result.findings,trigger}});
  return {checked:true,status,findings:result.findings};
}

async function run(database,workspaceId,{orderId,trigger='routine'}={}){
  if(typeof orderId!=='string'||!orderId)throw new ValidationError('An order check needs its order.');
  if(!['created','confirmed','changed','routine'].includes(trigger))throw new ValidationError('Choose a supported order check.');
  return database.transaction(async c=>{
    const state=await policy.accountState(c,workspaceId);
    const result=await automatic(c,workspaceId,state)?await check(c,workspaceId,orderId,trigger):{checked:false,watching:true};
    return result;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Called inside the order's own transaction, so the check runs only once the
// order is committed, and never for a plan that cannot use it.
async function queue(c,ctx,orderId,trigger){
  const state=await policy.accountState(c,ctx.workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return;
  const version=(await c.query('SELECT version FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,orderId])).rows[0]?.version;
  if(version==null)return;
  await require('../operations/postgres-job-queue').enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind:KIND,priority:60,maxAttempts:5,
    idempotencyKey:'order-check:'+orderId+':'+version+':'+trigger,payload:{orderId,trigger}});
}

// The routine catches orders changed while checks were paused, and credit that
// changed since the last check: invoices fall overdue as days pass.
async function schedule(database,workspaceId){
  const state=await policy.accountState(database,workspaceId);
  if(!await automatic(database,workspaceId,state))return {queued:0};
  const today=await require('../lib/business-time').today(database,workspaceId);
  const {rows}=await database.query(`SELECT o.id,o.version FROM sales_orders o
    LEFT JOIN stockchief_runtime.agent_order_checks k ON k.workspace_id=o.workspace_id AND k.sales_order_id=o.id
    WHERE o.workspace_id=$1 AND o.status=ANY($2::text[]) AND (k.sales_order_id IS NULL OR k.order_version<>o.version
      OR k.checked_at<now()-interval '1 day')
    ORDER BY k.checked_at NULLS FIRST,o.created_at,o.id LIMIT 50`,[workspaceId,OPEN]);
  for(const row of rows)await require('../operations/postgres-job-queue').enqueue(database,{workspaceId,kind:KIND,priority:70,maxAttempts:5,
    idempotencyKey:'order-check:'+row.id+':'+row.version+':routine:'+today,payload:{orderId:row.id,trigger:'routine'}});
  return {queued:rows.length};
}

async function latest(db,workspaceId,orderId){
  const row=(await db.query(`SELECT k.*,o.version FROM stockchief_runtime.agent_order_checks k JOIN sales_orders o ON o.workspace_id=k.workspace_id
    AND o.id=k.sales_order_id WHERE k.workspace_id=$1 AND k.sales_order_id=$2`,[workspaceId,orderId])).rows[0];
  if(!row)return null;
  return {status:row.status,checkedAt:row.checked_at,current:Number(row.order_version)===Number(row.version),
    findings:row.findings.map(f=>({...f,label:labels[f.check]}))};
}

// For the order page: the automatic result on Growth and above, and one
// suggested check on Starter.
async function forOrderPage(db,ctx,orderId,state){
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'suggest'))return null;
  if(policy.permits(state.plan,JOB,'automatic'))return {automatic:true,result:await latest(db,ctx.workspaceId,orderId)};
  return {automatic:false,review:'/autopilot/reviews/sales-order-checks'};
}

const needsSql=`SELECT k.sales_order_id,k.findings,k.checked_at,o.order_number,c.name customer_name FROM stockchief_runtime.agent_order_checks k
  JOIN sales_orders o ON o.workspace_id=k.workspace_id AND o.id=k.sales_order_id AND o.version=k.order_version
    AND o.status IN ('DRAFT','CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
  JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
  WHERE k.workspace_id=$1 AND k.status='FLAGGED' ORDER BY k.checked_at DESC,k.sales_order_id LIMIT 20`;

// Needs you, read fresh so a plan change shows at once.
async function inbox(db,workspaceId){
  const {rows}=await db.query(needsSql,[workspaceId]);
  if(!rows.length)return [];
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return [];
  return rows.map(row=>({kind:'inventory',importance:'Important',priority:78,
    title:'Check order '+row.order_number+' for '+row.customer_name,
    happened:plural(row.findings.length,'problem was','problems were')+' found when the order was checked. Nothing on the order was changed.',
    why:describe(row.findings),recommendation:'Open the order and decide what to do about each problem.',
    href:'/orders/'+encodeURIComponent(row.sales_order_id)+'#order-checks',actionLabel:'Review order',
    sourceId:'order-check-'+row.sales_order_id,createdAt:row.checked_at,timeLabel:'Checked',at:row.checked_at}));
}

module.exports={JOB,KIND,ACTION,DEFAULT_DISCOUNT_BPS,evaluate,describe,summary,run,queue,schedule,latest,forOrderPage,settings,saveSettings,inbox};

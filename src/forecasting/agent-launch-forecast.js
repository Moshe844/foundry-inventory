'use strict';

// Job 146: forecasts new products using similar items.
//
// A new product is one added in the last 90 days with no recorded sales older
// than that. Its forecast comes from similar items that have at least eight
// weeks of sales, chosen by the owner or by these explicit rules:
//   1. the same units (and second unit), always;
//   2. another variant of the same product, the same category, or the same
//      brand together with a matching price or detail;
//   3. ranked by what else matches: same product, category, brand, a selling
//      price within 25% in the same currency, and matching product details.
// The best-ranked group sets the rate, using each item's own job 144 forecast
// so its seasons carry over. As soon as the new product has its own sales,
// they count too, and more each day. No similar item, or similar items that
// sell very differently, stop and ask for a choice.
//
// Growth suggests. Pro and Custom let the forecast drive planning on their
// own, inside the same owner modes as job 144.
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const installed=require('../db/schema-installed');
const time=require('../lib/business-time');
const models=require('./models');
const base=require('./agent-demand-forecast');
const {addDays}=require('../accounting/customer-money');
const {ValidationError,NotFoundError}=require('../domain/errors');

const JOB=146,CAPABILITY='planning.launch_forecast',NEW_DAYS=90,HISTORY_DAYS=56,PRIOR_DAYS=28,GROUP=5,DISAGREE=2,APPROVAL_TOLERANCE=0.1;
const table='stockchief_runtime.agent_launch_forecasts';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const round=(n,places=2)=>Math.round(n*10**places)/10**places;

// New products in this inventory, optionally limited to some products or one
// code. Sales older than the 90-day window mean the product is not new.
async function launches(db,workspaceId,{today,skuIds=null,filter='',limit=null,offset=0}){
  const {timeZone}=await time.forWorkspace(db,workspaceId);
  const since=addDays(today,-NEW_DAYS);
  return (await db.query(`SELECT s.id,s.code,s.item_id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    WHERE s.workspace_id=$1 AND s.is_active=1 AND s.created_at::timestamptz>=$2::timestamptz AND ($3::text[] IS NULL OR s.id=ANY($3::text[]))
      AND ($4='' OR lower(s.code)=lower($4))
      AND NOT EXISTS(SELECT 1 FROM sales_order_lines l JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
        WHERE l.workspace_id=s.workspace_id AND l.sku_id=s.id AND o.status NOT IN ('DRAFT','CANCELLED') AND left(o.order_date,10)<$5)
      AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.replenishment_demand_events d JOIN movements m ON m.workspace_id=d.workspace_id AND m.id=d.movement_id
        WHERE d.workspace_id=s.workspace_id AND d.sku_id=s.id AND d.occurred_at<$2::timestamptz AND m.operation='issue' AND m.reason_code IN ('sale','sold'))
    ORDER BY s.code,s.id LIMIT $6 OFFSET $7`,[workspaceId,time.dayBoundary(since,timeZone),skuIds,filter,since,limit,offset])).rows;
}

const facts=`coalesce(nullif(f.facts,'')::jsonb,'{}'::jsonb)||coalesce(nullif(sf.facts,'')::jsonb,'{}'::jsonb)`;
const brand=`nullif(lower(trim(coalesce(nullif(f.facts,'')::jsonb->>'brand',nullif(f.facts,'')::jsonb->>'Brand'))),'')`;
const profile=alias=>`SELECT s.id,s.item_id,i.unit_label,i.secondary_unit_label,nullif(lower(trim(f.category)),'') AS category,${brand} AS brand,${facts} AS facts,
    price.amount_minor AS price,price.currency FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    LEFT JOIN catalogue_item_facts f ON f.workspace_id=s.workspace_id AND f.item_id=s.item_id
    LEFT JOIN catalogue_sku_facts sf ON sf.workspace_id=s.workspace_id AND sf.sku_id=s.id
    LEFT JOIN LATERAL(SELECT amount_minor,currency FROM sku_prices p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id
      ORDER BY p.created_at DESC,p.id DESC LIMIT 1) price ON true WHERE s.workspace_id=$1 AND ${alias}`;

// Similar items for one new product under the explicit rules, best first,
// limited to items with sales at least eight weeks old in the history window.
async function candidates(db,workspaceId,skuId,{today,from,only=null}){
  const {timeZone}=await time.forWorkspace(db,workspaceId),seasoned=addDays(today,-HISTORY_DAYS);
  return (await db.query(`WITH n AS (${profile('s.id=$2')}), p AS (${profile(`s.is_active=1 AND (($6::text IS NOT NULL AND s.id=$6) OR ($6::text IS NULL AND (s.item_id=(SELECT item_id FROM n)
      OR nullif(lower(trim(f.category)),'')=(SELECT category FROM n) OR ${brand}=(SELECT brand FROM n))))`)}),
    c AS (SELECT p.id,p.item_id=n.item_id AS variant,coalesce(p.category=n.category,false) AS category,coalesce(p.brand=n.brand,false) AS brand,
      coalesce(n.price>0 AND p.currency=n.currency AND p.price BETWEEN n.price*0.75 AND n.price*1.25,false) AS price,
      (SELECT count(*) FROM jsonb_each_text(n.facts) e WHERE lower(e.key) NOT IN ('brand','category') AND e.value<>'' AND p.facts->>e.key=e.value)::int AS details
      FROM n JOIN p ON p.id<>n.id AND p.unit_label=n.unit_label AND p.secondary_unit_label IS NOT DISTINCT FROM n.secondary_unit_label
      JOIN items pi ON pi.workspace_id=$1 AND pi.id=p.item_id AND pi.is_active=1
      WHERE EXISTS(SELECT 1 FROM sales_order_lines l JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
          WHERE l.workspace_id=$1 AND l.sku_id=p.id AND o.status NOT IN ('DRAFT','CANCELLED') AND left(o.order_date,10) BETWEEN $3 AND $4)
        OR EXISTS(SELECT 1 FROM stockchief_runtime.replenishment_demand_events d JOIN movements m ON m.workspace_id=d.workspace_id AND m.id=d.movement_id
          WHERE d.workspace_id=$1 AND d.sku_id=p.id AND d.occurred_at>=$5::timestamptz AND d.occurred_at<$7::timestamptz
            AND m.operation='issue' AND m.reason_code IN ('sale','sold')))
    SELECT c.*,s.code,(4*c.variant::int+3*c.category::int+2*c.brand::int+c.price::int+least(c.details,2)) AS score FROM c JOIN skus s ON s.workspace_id=$1 AND s.id=c.id
    WHERE $6::text IS NOT NULL OR c.variant OR c.category OR (c.brand AND (c.price OR c.details>0))
    ORDER BY score DESC,s.code,c.id LIMIT 20`,
  [workspaceId,skuId,from,seasoned,time.dayBoundary(from,timeZone),only,time.dayBoundary(addDays(seasoned,1),timeZone)])).rows;
}
const matchWords=c=>[c.variant&&'same product',c.category&&'same category',c.brand&&'same brand',c.price&&'price within 25%',
  c.details>0&&c.details+(c.details===1?' matching detail':' matching details')].filter(Boolean);

// The forecast for each new product, before plan and owner modes apply.
async function estimate(db,workspaceId,launchList,{today,chosen=new Map()}){
  if(!launchList.length)return new Map();
  const from=await base.historyStart(db,workspaceId,today),found=new Map(),pool=new Set();
  for(const n of launchList){
    const only=chosen.get(n.id)||null,list=await candidates(db,workspaceId,n.id,{today,from,only});
    found.set(n.id,list);for(const c of list)pool.add(c.id);
  }
  const own=await base.demand(db,workspaceId,launchList.map(n=>n.id),{from,today});
  const history=await base.demand(db,workspaceId,[...pool],{from,today}),fitted=new Map();
  for(const id of pool){
    const f=base.fit(base.daysOf(history.get(id),today));
    if(f.shape)fitted.set(id,{shape:f.shape,label:f.label,units:base.units(f.shape,today,30)});
  }
  const result=new Map();
  for(const n of launchList){
    const chosenId=chosen.get(n.id)||null,list=found.get(n.id).filter(c=>fitted.has(c.id));
    const sales=own.get(n.id),firstSale=[...sales.keys()].sort()[0];
    const ownDays=firstSale?base.daysOf(sales,today).length:0,ownUnits=[...sales.values()].reduce((a,b)=>a+b,0);
    const early={ownDays,ownUnits:round(ownUnits,4)};
    const top=list.length?list.filter(c=>Number(c.score)===Number(list[0].score)).slice(0,GROUP):[];
    const comparisons=top.map(c=>({skuId:c.id,code:c.code,units30:fitted.get(c.id).units,method:fitted.get(c.id).label,matched:chosenId?['your choice']:matchWords(c)}));
    if(!top.length){
      result.set(n.id,{...early,comparisons,reason:chosenId?'The item you chose has no sales history to forecast from. Choose another similar item.':
        'No similar item with the same units has eight weeks of sales. Choose a similar item.'});
      continue;
    }
    const rates=comparisons.map(c=>c.units30),low=Math.min(...rates),high=Math.max(...rates);
    if(high>0&&(low===0||high>DISAGREE*low)){
      result.set(n.id,{...early,comparisons,reason:'The closest similar items sell very differently: '+low+' to '+high+' units in 30 days. Choose the most similar one.'});
      continue;
    }
    const sorted=[...rates].sort((a,b)=>a-b),median=sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;
    const reference=comparisons.reduce((best,c)=>Math.abs(c.units30-median)<Math.abs(best.units30-median)?c:best,comparisons[0]);
    const analog=median/30,weight=ownDays/(ownDays+PRIOR_DAYS),ownRate=ownDays?ownUnits/ownDays:0;
    const rate=(1-weight)*analog+weight*ownRate,refRate=reference.units30/30;
    const shape=refRate>0?{kind:'scaled',factor:rate/refRate,shape:fitted.get(reference.skuId).shape}:{kind:'flat',rate};
    result.set(n.id,{...early,comparisons,reference:reference.skuId,analog:round(analog*30),weight:round(weight,4),rate:round(rate,4),shape,
      next30:base.units(shape,today,30),rule:chosenId?'OWNER':'RULES'});
  }
  return result;
}

function decide(auth,before,e){
  if(e.reason)return {status:'ASK',reason:e.reason};
  if(auth.level==='suggest')return {status:'SUGGESTED',reason:null};
  if(auth.level==='watch')return {status:'WATCHED',reason:auth.reason};
  if(auth.level==='draft'){
    const approved=before?.approved_reference===e.reference&&before.approved_next_30!=null&&
      Math.abs(e.next30-Number(before.approved_next_30))<=APPROVAL_TOLERANCE*Math.max(Number(before.approved_next_30),1);
    return approved?{status:'USED',reason:null}:{status:'PROPOSED',reason:auth.reason};
  }
  return {status:'USED',reason:null};
}

async function save(c,workspaceId,runId,today,skuId,e,decision){
  await c.query(`INSERT INTO ${table}(workspace_id,sku_id,run_id,as_of,status,reason,rule,comparisons,reference_sku_id,analog_30,own_days,own_units,
      weight,daily_rate,shape,next_30,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,now())
    ON CONFLICT(workspace_id,sku_id) DO UPDATE SET run_id=coalesce(EXCLUDED.run_id,${table}.run_id),as_of=EXCLUDED.as_of,status=EXCLUDED.status,
      reason=EXCLUDED.reason,rule=EXCLUDED.rule,comparisons=EXCLUDED.comparisons,reference_sku_id=EXCLUDED.reference_sku_id,analog_30=EXCLUDED.analog_30,
      own_days=EXCLUDED.own_days,own_units=EXCLUDED.own_units,weight=EXCLUDED.weight,daily_rate=EXCLUDED.daily_rate,shape=EXCLUDED.shape,
      next_30=EXCLUDED.next_30,updated_at=now()`,
  [workspaceId,skuId,runId,today,decision.status,decision.reason,e.rule||null,JSON.stringify(e.comparisons),e.reference||null,e.analog??null,
    e.ownDays,e.ownUnits,e.weight??null,e.rate??null,e.shape?JSON.stringify(e.shape):null,e.next30??null]);
}

// One step of the daily forecast run, for the new products on this page.
async function step(c,ctx,{run,skuIds,today,account}){
  const counts={new_used:0,new_waiting:0,new_shown:0,new_asked:0};
  if(!skuIds.length||!await installed.has(c,table))return counts;
  const auth=await base.authority(c,ctx.workspaceId,{job:JOB,capability:CAPABILITY,account});
  if(!auth.plan)return counts;
  const list=await launches(c,ctx.workspaceId,{today,skuIds});
  const prior=new Map((await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) FOR UPDATE`,[ctx.workspaceId,skuIds])).rows.map(r=>[r.sku_id,r]));
  const current=new Set(list.map(n=>n.id));
  const gone=[...prior.keys()].filter(id=>!current.has(id));
  if(gone.length)await c.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND sku_id=ANY($2::text[])`,[ctx.workspaceId,gone]);
  const chosen=new Map([...prior.values()].filter(r=>r.chosen_sku_id&&current.has(r.sku_id)).map(r=>[r.sku_id,r.chosen_sku_id]));
  const found=await estimate(c,ctx.workspaceId,list,{today,chosen}),changed=[];
  for(const n of list){
    const e=found.get(n.id),before=prior.get(n.id),decision=decide(auth,before,e);
    await save(c,ctx.workspaceId,run.id,today,n.id,e,decision);
    counts[{USED:'new_used',PROPOSED:'new_waiting',WATCHED:'new_shown',SUGGESTED:'new_shown',ASK:'new_asked'}[decision.status]]++;
    const wasUsed=before?.status==='USED';
    if(decision.status==='USED'?!wasUsed||before.reference_sku_id!==e.reference||Math.round(Number(before.next_30))!==Math.round(e.next30):wasUsed)
      changed.push({skuId:n.id,code:n.code,before:wasUsed?{reference:before.reference_sku_id,next30:Number(before.next_30)}:null,
        after:decision.status==='USED'?{reference:e.reference,next30:e.next30,weight:e.weight}:{status:decision.status}});
  }
  if(changed.length)await audit.record(c,ctx,{action:'Updated new product forecasts used for planning',reference:run.id,
    before:{products:changed.map(x=>({skuId:x.skuId,code:x.code,...x.before}))},after:{products:changed.map(x=>({skuId:x.skuId,code:x.code,...x.after})),level:auth.level}});
  return counts;
}

async function row(c,ctx,skuId,lock=true){
  const found=(await c.query(`SELECT l.*,s.code FROM ${table} l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    WHERE l.workspace_id=$1 AND l.sku_id=$2${lock?' FOR UPDATE OF l':''}`,[ctx.workspaceId,String(skuId||'')])).rows[0];
  if(!found)throw new NotFoundError('That product is not a new product with a forecast in this inventory.');
  return found;
}

// A person picks the similar item for a new product, or clears the choice.
// The forecast is worked out again at once.
async function choose(db,ctx,input){
  return tx(db,async c=>{
    await base.member(c,ctx,'choose similar items');
    const auth=await base.authority(c,ctx.workspaceId,{job:JOB,capability:CAPABILITY});
    policy.requireJob(auth.plan,JOB,'suggest');
    const current=await row(c,ctx,input.skuId),code=String(input.code||'').trim(),today=await time.today(c,ctx.workspaceId);
    let chosen=null;
    if(code){
      const match=(await c.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND lower(code)=lower($2) AND is_active=1',[ctx.workspaceId,code])).rows[0];
      if(!match)throw new ValidationError('Enter the code of an active product in this inventory.');
      if(match.id===current.sku_id)throw new ValidationError('Choose a different product than the new one.');
      const from=await base.historyStart(c,ctx.workspaceId,today);
      const [fit]=await candidates(c,ctx.workspaceId,current.sku_id,{today,from,only:match.id});
      if(!fit)throw new ValidationError(match.code+' needs the same units and at least eight weeks of sales to be used.');
      chosen=match;
    }
    if((current.chosen_sku_id||null)===(chosen?.id||null))return {skuId:current.sku_id,replayed:true};
    await c.query(`UPDATE ${table} SET chosen_sku_id=$3,chosen_by=$4,chosen_at=CASE WHEN $3::text IS NULL THEN NULL ELSE now() END WHERE workspace_id=$1 AND sku_id=$2`,
      [ctx.workspaceId,current.sku_id,chosen?.id||null,chosen?ctx.actorId:null]);
    const [launch]=await launches(c,ctx.workspaceId,{today,skuIds:[current.sku_id]});
    if(!launch)throw new ValidationError('This product is no longer new. Its own sales history forecasts it now.');
    const e=(await estimate(c,ctx.workspaceId,[launch],{today,chosen:new Map(chosen?[[launch.id,chosen.id]]:[])})).get(launch.id);
    const decision=decide(auth,current,e);
    await save(c,ctx.workspaceId,null,today,launch.id,e,decision);
    await audit.record(c,ctx,{action:chosen?'Chose a similar item for a new product':'Cleared the similar item for a new product',reference:current.sku_id,
      before:{code:current.code,chosen:current.chosen_sku_id||null,status:current.status},
      after:{code:current.code,chosen:chosen?.code||null,status:decision.status,next30:e.next30??null}});
    return {skuId:current.sku_id,status:decision.status,next30:e.next30??null};
  });
}

// Ask me first on Pro and Custom: a person lets the forecast drive planning.
async function approve(db,ctx,skuId){
  return tx(db,async c=>{
    await base.member(c,ctx,'approve forecasts');
    const auth=await base.authority(c,ctx.workspaceId,{job:JOB,capability:CAPABILITY});
    policy.requireJob(auth.plan,JOB,'automatic');
    if(auth.level==='watch')throw new ValidationError(auth.reason);
    const current=await row(c,ctx,skuId);
    if(current.status==='USED'&&current.approved_by===ctx.actorId&&current.approved_reference===current.reference_sku_id)return {skuId:current.sku_id,replayed:true};
    if(current.status!=='PROPOSED')throw new ValidationError('This forecast is no longer waiting for approval.');
    await c.query(`UPDATE ${table} SET status='USED',reason=NULL,approved_reference=reference_sku_id,approved_next_30=next_30,approved_by=$3,approved_at=now(),updated_at=now()
      WHERE workspace_id=$1 AND sku_id=$2`,[ctx.workspaceId,current.sku_id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Approved new product forecast for planning',reference:current.sku_id,before:{status:current.status},
      after:{code:current.code,reference:current.reference_sku_id,next30:Number(current.next_30)}});
    return {skuId:current.sku_id};
  });
}

// Planning feed: new product forecasts in use replace job 144's for those
// products, on plans where job 146 may act on its own.
async function feed(db,workspaceId,skuIds){
  if(!await installed.has(db,table))return [];
  return (await db.query(`SELECT sku_id,'SIMILAR' AS basis,146 AS job,'similar_items' AS method,'Similar items' AS label,shape FROM ${table}
    WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND status='USED'`,[workspaceId,skuIds])).rows;
}

const statusWords={USED:'Used for planning',PROPOSED:'Waiting for your approval',WATCHED:'Shown only',SUGGESTED:'Suggestion',ASK:'Choose a similar item'};

// The review page and Growth's single suggestion: the same calculation as
// the daily run, with what the run decided.
async function review(db,ctx,{filter,page,today}){
  const list=await launches(db,ctx.workspaceId,{today,filter,limit:26,offset:(page-1)*25});
  const shown=list.slice(0,25),ids=shown.map(n=>n.id);
  const saved=await installed.has(db,table)?new Map((await db.query(`SELECT sku_id,status,chosen_sku_id FROM ${table} WHERE workspace_id=$1 AND sku_id=ANY($2::text[])`,
    [ctx.workspaceId,ids])).rows.map(r=>[r.sku_id,r])):new Map();
  const chosen=new Map([...saved.values()].filter(r=>r.chosen_sku_id).map(r=>[r.sku_id,r.chosen_sku_id]));
  const found=await estimate(db,ctx.workspaceId,shown,{today,chosen});
  const rows=shown.map(n=>{
    const e=found.get(n.id),first=e.comparisons[0];
    return {SKU:n.code,'Comparable SKUs':e.comparisons.length,'Example comparable SKU':first?.code||null,'Why similar':first?first.matched.join(', '):null,
      'Days with its own sales':e.ownDays,'Estimated units in 30 days':e.reason?null:e.next30,'What to do':e.reason||null,
      Planning:statusWords[saved.get(n.id)?.status]||'Not checked yet',link:'/inventory/'+n.item_id};
  });
  return {rows,more:list.length>25,summary:'New products added in the last 90 days. Each is forecast from similar items with the same units and at least eight weeks of sales: the same product, category or brand first, then matching price and details. Its own early sales count more each day. When no clear similar item exists, choose one.'};
}

async function section(db,ctx,auth){
  if(!await installed.has(db,table))return {};
  const plan=auth.plan,mode=policy.allowance(plan,JOB);
  if(mode==='excluded')return {launchLocked:true};
  const rows=(await db.query(`SELECT l.*,l.next_30::float8 AS next_30,l.analog_30::float8 AS analog_30,l.weight::float8 AS weight,s.code,i.unit_label,c.code AS chosen_code
    FROM ${table} l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    LEFT JOIN skus c ON c.workspace_id=l.workspace_id AND c.id=l.chosen_sku_id
    WHERE l.workspace_id=$1 ORDER BY l.status='ASK' DESC,l.status='PROPOSED' DESC,s.code,l.sku_id LIMIT 100`,[ctx.workspaceId])).rows;
  return {launches:rows,launchMode:mode,launchWords:statusWords};
}

// Needs you: new products without a clear similar item (Growth and up), and
// forecasts waiting for approval (Pro and Custom).
async function inbox(db,workspaceId){
  if(!await installed.has(db,table))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'suggest'))return [];
  const row=(await db.query(`SELECT count(*) FILTER(WHERE status='ASK')::int AS ask,count(*) FILTER(WHERE status='PROPOSED')::int AS waiting,min(updated_at) AS at
    FROM ${table} WHERE workspace_id=$1 AND status IN ('ASK','PROPOSED')`,[workspaceId])).rows[0];
  const items=[];
  if(row.ask)items.push({kind:'inventory',importance:'Needs You',priority:46,grouped:true,title:'New products need a similar item',
    happened:row.ask+(row.ask===1?' new product has':' new products have')+' no clear similar item to forecast from.',
    why:'StockChief never guesses a new product\'s sales. It needs an item with the same units and eight weeks of sales.',
    recommendation:'Choose a similar item for each.',href:base.href+'#new-products',actionLabel:'Choose similar items',sourceId:'launch-forecast-choices',at:row.at,createdAt:row.at});
  if(row.waiting&&policy.permits(account.plan,JOB,'automatic'))items.push({kind:'inventory',importance:'Needs You',priority:45,grouped:true,
    title:'New product forecasts wait for your approval',happened:row.waiting+(row.waiting===1?' new product forecast is':' new product forecasts are')+' ready but not used for planning yet.',
    why:'Ask me first, a pause or routine work being off keeps them out of planning until you approve them.',
    recommendation:'Approve them, or keep planning these products by hand.',href:base.href+'#new-products',actionLabel:'Review new products',sourceId:'launch-forecast-approvals',at:row.at,createdAt:row.at});
  return items;
}

base.addStep(step);
base.addFeed(feed);
base.addSection(section);
base.addInbox(inbox);

module.exports={JOB,CAPABILITY,launches,candidates,estimate,step,choose,approve,feed,review,inbox,statusWords};

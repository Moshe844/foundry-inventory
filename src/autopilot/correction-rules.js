'use strict';
// Job 209: suggests a new rule when it sees you fix the same thing again and
// again. A fix counts when a person made it, and "again and again" means the
// same fix, in the same direction, on at least three separate occasions in the
// last 30 days. Every suggestion is built from those records (their counts,
// dates and quantities), never from a guess:
//
//  - stock-count: stock corrected at the same product and warehouse. Suggests
//    a recurring blind count of that warehouse; you choose the counter and day.
//  - order-quantity: the quantity raised on three draft purchase orders for the
//    same product and supplier. Suggests that supplier's minimum order: the
//    smallest quantity you raised it to.
//  - repeat-move: the same stock moved from one location to another three
//    times. Suggests keeping that product stocked at the destination: reorder
//    when it falls to the highest level you moved stock at, up to the lowest
//    level you topped it up to. StockChief then moves spare stock first.
//  - declined-reorder: a reorder suggestion for the same product and location
//    declined three times. Suggests a lower reorder point: one below the
//    lowest stock level you declined at.
//
// Each suggestion is a plain-words rule you accept with one tap. Accepting
// saves it as a standing rule (job 207's rules, or the count schedule), so it
// counts against your rule allowance. Before you accept, the page shows what
// the rule would have done with the last 90 days of records (job 210).
// Selling and supplier prices are not suggested: changing a selling price or
// accepting a supplier's new price always needs a person (page 13).
const policy=require('../commercial/agent-plan');
const {has}=require('../db/schema-installed');
const {ValidationError}=require('../domain/errors');

const JOB=209,DAYS=30,TIMES=3,path='/autopilot/learning/corrections';
const DECISIONS='stockchief_runtime.agent_learning_decisions';
const day=value=>new Date(value).toISOString().slice(0,10);
const units=value=>String(Number(Number(value).toFixed(6)));
const anchor=(pattern,scope)=>'fix-'+require('node:crypto').createHash('sha256').update(pattern+'|'+scope).digest('hex').slice(0,16);
// Later evidence only, once the owner has answered.
const open=(decided,kind,scope,latest)=>decided?` AND NOT EXISTS(SELECT 1 FROM ${DECISIONS} d WHERE d.workspace_id=$1 AND d.job_id=209
  AND d.kind='${kind}' AND d.scope_key=${scope} AND d.through>=${latest})`:'';

// Each pattern returns its scope, evidence and a reference for Needs you.
function patterns(decided){
  const count=require('./repeated-corrections').sql;
  return {
    'stock-count':`SELECT 'stock-count:'||c.reference AS reference,'${path}' AS link,c."SKU" AS code,c."Warehouse" AS location,c."Corrections" AS times,
        c."Latest correction"::timestamptz AS last,split_part(c.reference,':',1) AS sku_id,split_part(c.reference,':',2) AS location_id
      FROM (${count}) c WHERE true${open(decided,'stock-count','c.reference','c."Latest correction"::timestamptz')}`,
    'order-quantity':`SELECT 'order-quantity:'||o.supplier_id||':'||k.id AS reference,'${path}' AS link,o.supplier_id,sup.name AS supplier,k.id AS sku_id,k.code,
        count(DISTINCT e.purchase_order_id)::int AS times,min((e.detail::jsonb->>'to')::numeric) AS raised_to,min((e.detail::jsonb->>'from')::numeric) AS lowest_from,
        coalesce(max(si.units_per_purchase_unit),1)::numeric AS pack,max(si.minimum_order_quantity)::numeric AS current_minimum,
        min(e.created_at::timestamptz) AS first,max(e.created_at::timestamptz) AS last
      FROM purchase_order_events e JOIN purchase_orders o ON o.workspace_id=e.workspace_id AND o.id=e.purchase_order_id
      JOIN suppliers sup ON sup.workspace_id=o.workspace_id AND sup.id=o.supplier_id AND sup.status='active'
      JOIN skus k ON k.workspace_id=e.workspace_id AND k.id=e.detail::jsonb->>'skuId' AND k.is_active=1
      JOIN items i ON i.workspace_id=k.workspace_id AND i.id=k.item_id AND i.is_active=1
      LEFT JOIN supplier_items si ON si.workspace_id=o.workspace_id AND si.supplier_id=o.supplier_id AND si.sku_id=k.id AND si.is_active=1
      WHERE e.workspace_id=$1 AND e.event='draft_line_revised' AND e.actor_user_id IS NOT NULL AND e.created_at::timestamptz>=now()-interval '${DAYS} days'
      GROUP BY o.supplier_id,sup.name,k.id,k.code
      HAVING count(DISTINCT e.purchase_order_id)>=${TIMES} AND bool_and((e.detail::jsonb->>'to')::numeric>(e.detail::jsonb->>'from')::numeric)
        AND coalesce(max(si.minimum_order_quantity),0)*coalesce(max(si.units_per_purchase_unit),1)<min((e.detail::jsonb->>'to')::numeric)
        ${open(decided,'order-quantity',"o.supplier_id||':'||k.id",'max(e.created_at::timestamptz)')}`,
    'repeat-move':`SELECT 'repeat-move:'||m.sku_id||':'||m.counterparty_location_id||':'||m.location_id AS reference,'${path}' AS link,
        m.sku_id,k.code,m.counterparty_location_id AS source_id,src.name AS source,m.location_id,dst.name AS location,
        count(DISTINCT m.group_id)::int AS times,max(m.balance_after-m.quantity_delta)::numeric AS moved_at,min(m.balance_after)::numeric AS topped_to,
        min(m.occurred_at::timestamptz) AS first,max(m.occurred_at::timestamptz) AS last
      FROM movements m JOIN skus k ON k.workspace_id=m.workspace_id AND k.id=m.sku_id AND k.is_active=1
      JOIN items i ON i.workspace_id=k.workspace_id AND i.id=k.item_id AND i.is_active=1 AND i.tracking_mode='quantity' AND i.secondary_unit_label IS NULL
      JOIN locations src ON src.workspace_id=m.workspace_id AND src.id=m.counterparty_location_id AND src.is_active=1
      JOIN locations dst ON dst.workspace_id=m.workspace_id AND dst.id=m.location_id AND dst.is_active=1
      WHERE m.workspace_id=$1 AND m.operation='transfer' AND m.leg='in' AND m.quantity_delta>0 AND m.occurred_at::timestamptz>=now()-interval '${DAYS} days'
      GROUP BY m.sku_id,k.code,m.counterparty_location_id,src.name,m.location_id,dst.name
      HAVING count(DISTINCT m.group_id)>=${TIMES}
        AND NOT EXISTS(SELECT 1 FROM reorder_policies r WHERE r.workspace_id=$1 AND r.sku_id=m.sku_id AND r.location_id=m.location_id
          AND r.reorder_point IS NOT NULL AND r.reorder_point>=max(m.balance_after-m.quantity_delta))
        ${open(decided,'repeat-move',"m.sku_id||':'||m.counterparty_location_id||':'||m.location_id",'max(m.occurred_at::timestamptz)')}`,
    'declined-reorder':`SELECT 'declined-reorder:'||w.sku_id||':'||w.location_id AS reference,'${path}' AS link,w.sku_id,k.code,nullif(w.location_id,'') AS location_id,l.name AS location,
        count(*)::int AS times,min(w.available) AS lowest,max(w.reorder_point) AS suggested_at,min(w.at) AS first,max(w.at) AS last
      FROM (SELECT x.a->>'skuId' AS sku_id,coalesce(x.a->>'destinationLocationId','') AS location_id,(x.a->>'destinationAvailable')::numeric AS available,
          (x.a->>'reorderPoint')::numeric AS reorder_point,w.completed_at::timestamptz AS at
        FROM work_items w CROSS JOIN LATERAL (SELECT w.recommended_action::jsonb AS a) x
        WHERE w.workspace_id=$1 AND w.execution_status='CANCELLED' AND w.verification_status<>'NOT_APPLICABLE' AND w.category='replenishment_plan'
          AND x.a->>'type'='purchase' AND w.completed_at IS NOT NULL AND w.completed_at::timestamptz>=now()-interval '${DAYS} days') w
      JOIN skus k ON k.workspace_id=$1 AND k.id=w.sku_id AND k.is_active=1
      LEFT JOIN locations l ON l.workspace_id=$1 AND l.id=nullif(w.location_id,'')
      GROUP BY w.sku_id,k.code,w.location_id,l.name
      HAVING count(*)>=${TIMES} AND min(w.available)>=1 AND (nullif(w.location_id,'') IS NULL OR max(l.name) IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM reorder_policies r WHERE r.workspace_id=$1 AND r.sku_id=w.sku_id AND r.location_id IS NOT DISTINCT FROM nullif(w.location_id,'')
          AND r.reorder_point IS NOT NULL AND r.reorder_point<min(w.available))
        ${open(decided,'declined-reorder',"w.sku_id||':'||w.location_id",'max(w.at)')}`
  };
}

// Needs you: the same patterns as plain references, for the notices refresh.
async function noticeSql(db){
  const decided=await has(db,DECISIONS),all=patterns(decided);
  return Object.values(all).map(sql=>`SELECT reference,link FROM (${sql}) p`).join(' UNION ALL ');
}

// The plain-words rule each pattern suggests, from its evidence.
function suggestion(pattern,r){
  const scope=r.reference.slice(pattern.length+1),base={pattern,scope,anchor:anchor(pattern,scope),times:r.times,last:new Date(r.last).toISOString(),
    first:r.first?day(r.first):null};
  if(pattern==='stock-count')return {...base,rule:'Count '+r.location+' with a recurring blind count, so differences are found before they need fixing.',
    evidence:'You corrected '+r.code+' at '+r.location+' '+r.times+' times in the last '+DAYS+' days, most recently on '+day(r.last)+'.',
    locationId:r.location_id,locationName:r.location,link:'/autopilot/reviews/staff-count-lists?locationId='+encodeURIComponent(r.location_id)};
  if(pattern==='order-quantity'){
    const pack=Number(r.pack)||1,packs=Number(r.raised_to)/pack;
    if(!Number.isInteger(packs)||packs<1)return null;
    return {...base,skuId:r.sku_id,supplierId:r.supplier_id,
      rule:'Order at least '+units(r.raised_to)+' of '+r.code+' from '+r.supplier+(pack>1?' ('+packs+' packs of '+units(pack)+')':'')+'.',
      evidence:'You raised the quantity of '+r.code+' on '+r.times+' draft orders to '+r.supplier+' in the last '+DAYS+' days, each time to '+units(r.raised_to)+' or more.',
      change:{domain:'supplier_terms',operation:'set',sku:r.code,supplier:r.supplier,minimumOrderQuantity:packs}};
  }
  if(pattern==='repeat-move'){
    const point=Number(r.moved_at),target=Number(r.topped_to);
    return {...base,skuId:r.sku_id,locationId:r.location_id,
      rule:'Keep '+r.code+' stocked at '+r.location+': reorder when it falls to '+units(point)+(target>point?', up to '+units(target):'')+'. StockChief moves spare stock from another location before buying.',
      evidence:'You moved '+r.code+' from '+r.source+' to '+r.location+' '+r.times+' times in the last '+DAYS+' days, each time when '+r.location+' had '+units(point)+' or fewer.',
      change:{domain:'replenishment',operation:'set',sku:r.code,location:r.location,reorderPoint:point,...(target>point?{targetStock:target}:{})}};
  }
  const point=Math.ceil(Number(r.lowest))-1;
  if(!(point>=0)||(r.suggested_at!=null&&point>=Number(r.suggested_at)))return null;
  const where=r.location?' at '+r.location:'';
  return {...base,skuId:r.sku_id,locationId:r.location_id||null,
    rule:'Reorder '+r.code+where+' only when it falls to '+units(point)+'.',
    evidence:'You declined StockChief’s reorder suggestion for '+r.code+where+' '+r.times+' times in the last '+DAYS+' days, each time with '+units(r.lowest)+' or more in stock.',
    change:{domain:'replenishment',operation:'set',sku:r.code,location:r.location||'',reorderPoint:point}};
}

// The rule's effect as the rule engine reads it, for the past-data test.
async function resolved(db,workspaceId,s){
  if(!s.change)return null;
  const c=s.change;
  const sku=(await db.query(`SELECT s.id,s.code,i.name,s.variant_label FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=$2`,[workspaceId,s.skuId])).rows[0];
  const display=sku?sku.name+(sku.variant_label?' · '+sku.variant_label:''):c.sku;
  return {...c,skuId:s.skuId,displayName:display,skuCode:sku?.code,...(s.supplierId?{supplierId:s.supplierId,supplierName:c.supplier}:{}),
    ...(s.locationId?{locationId:s.locationId,locationName:c.location}:{})};
}

async function suggestions(db,ctx,{test=true}={}){
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'automatic');
  const all=patterns(await has(db,DECISIONS)),found=[];
  for(const [pattern,sql] of Object.entries(all)){
    for(const r of (await db.query(sql+' ORDER BY 1 LIMIT 50',pattern==='stock-count'?[ctx.workspaceId,'']:[ctx.workspaceId])).rows){
      const s=suggestion(pattern,r);
      if(!s)continue;
      if(test){
        const rehearsal=require('./rule-rehearsal');
        s.test={sections:[pattern==='stock-count'?await rehearsal.countSchedule(db,ctx.workspaceId,{locationId:s.locationId,locationName:s.locationName,days:7}):
          await rehearsal.change(db,ctx.workspaceId,await resolved(db,ctx.workspaceId,s))]};
      }
      found.push(s);
    }
  }
  return state.shadow?found.map(s=>({...s,shadow:true})):found;
}

const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
async function owner(db,ctx){return require('./job-reviews').ownerState(db,ctx);}
async function decide(c,ctx,s,decision,rule){
  if(!await has(c,DECISIONS))return;
  await c.query(`INSERT INTO ${DECISIONS}(workspace_id,job_id,kind,scope_key,decision,through,rule_reference,decided_by) VALUES($1,209,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(workspace_id,job_id,kind,scope_key) DO UPDATE SET decision=EXCLUDED.decision,through=greatest(${DECISIONS}.through,EXCLUDED.through),
      rule_reference=EXCLUDED.rule_reference,decided_by=EXCLUDED.decided_by,decided_at=clock_timestamp()`,
  [ctx.workspaceId,s.pattern,s.scope,decision,s.last,rule,ctx.actorId]);
}
async function find(c,ctx,input){
  const pattern=String(input.pattern||''),scope=String(input.scope||'');
  if(!['stock-count','order-quantity','repeat-move','declined-reorder'].includes(pattern)||!scope)throw new ValidationError('Choose a suggested rule from the list.');
  return {pattern,scope,s:(await suggestions(scoped(c),ctx,{test:false})).find(x=>x.pattern===pattern&&x.scope===scope)};
}

// Accept: the suggestion becomes a standing plain-words rule, tested first.
async function accept(db,ctx,input={}){
  return db.transaction(async c=>{
    const s=scoped(c);await owner(s,ctx);
    const state=await policy.requireWorkspaceJob(s,ctx.workspaceId,JOB,'automatic');
    const found=await find(c,ctx,input);
    if(!found.s){
      const prior=await has(c,DECISIONS)&&(await c.query(`SELECT rule_reference FROM ${DECISIONS} WHERE workspace_id=$1 AND job_id=209 AND kind=$2 AND scope_key=$3 AND decision='accepted'`,
        [ctx.workspaceId,found.pattern,found.scope])).rows[0];
      if(prior)return {replayed:true,ruleId:prior.rule_reference};
      throw new ValidationError('This suggestion changed since you saw it. Review the current suggestions.');
    }
    if(found.s.pattern==='stock-count')throw new ValidationError('Choose who counts and when on the count list page to start this rule.');
    if(state.shadow)throw new ValidationError(policy.SHADOW_REASON);
    const rules=require('../manager/postgres-operating-instructions');
    const proposal=await rules.prepareSuggested(s,ctx,found.s.change),change=proposal.resolvedChanges[0];
    // The rule engine must read the same product, supplier and location as the evidence.
    if(change.skuId!==found.s.skuId||(found.s.supplierId&&change.supplierId!==found.s.supplierId)||(found.s.locationId&&change.locationId!==found.s.locationId))
      throw new ValidationError('A product, supplier or location name now matches a different record. Check the names, then review the suggestion again.');
    const test=await require('./rule-rehearsal').instruction(s,ctx,proposal);
    const approved=await rules.approve(s,ctx,proposal.id,proposal.integrityHash);
    await decide(c,ctx,found.s,'accepted',approved.id);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Accepted a rule suggested by repeated corrections',reference:approved.id,
      after:{pattern:found.s.pattern,rule:approved.summary,evidence:found.s.evidence,times:found.s.times,since:found.s.first,test:require('./rule-rehearsal').snapshot(test)}});
    return {replayed:false,ruleId:approved.id,rule:approved.summary};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Not now: the suggestion stays away until the same fix is made again.
async function dismiss(db,ctx,input={}){
  return db.transaction(async c=>{
    await owner(scoped(c),ctx);
    if(!await has(c,DECISIONS))throw new ValidationError('This inventory is being upgraded. Try again in a few minutes.');
    const found=await find(c,ctx,input);
    if(!found.s)return {replayed:true};
    await decide(c,ctx,found.s,'declined',null);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Dismissed a rule suggested by repeated corrections',reference:found.pattern+':'+found.scope,after:{rule:found.s.rule,evidence:found.s.evidence}});
    return {replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function page(db,ctx){
  await owner(db,ctx);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'automatic');
  return {shadow:Boolean(state.shadow),shadowEndsAt:state.shadowEndsAt,days:DAYS,times:TIMES,suggestions:await suggestions(db,ctx)};
}

// The review list (also reached from Ask's review capability).
async function review(db,ctx){
  const rows=(await suggestions(db,ctx,{test:false})).map(s=>({Rule:s.rule,Evidence:s.evidence,Times:s.times,link:path+'#'+s.anchor}));
  return {rows,more:false,summary:'Fixes you made at least '+TIMES+' times in the last '+DAYS+' days, each with the rule that would make them unnecessary. Open one to see what the rule would have done before you accept it.'};
}

module.exports={JOB,DAYS,TIMES,path,patterns,noticeSql,suggestions,accept,dismiss,page,
  definition:{id:JOB,key:'suggested-rules',label:'Rules suggested by your repeated fixes',readPage:review}};

'use strict';
// Job 210: tests a new rule on past data first and shows what it would have
// done. Before a rule is switched on (a plain-words rule from Ask or Settings,
// a rule suggested by repeated fixes, or a routine learned from approvals),
// StockChief replays the last 90 days of recorded history: stock movements,
// purchase orders, transfers, approvals and corrections. It reads records only
// and changes nothing. Each answer is counts and dates from those records.
//
// Rule kinds and what is replayed:
//  - reorder settings (reorder point and target): each time stock on hand fell
//    to the reorder point, and whether it later ran out;
//  - stock alerts: each time stock crossed the alert level;
//  - stock protection: each outgoing movement that would have been stopped or
//    warned about;
//  - supplier terms (minimum, multiple, pack, lead time): each past order line
//    the terms would have changed, and each delivery slower than the lead time;
//  - transfer and purchase authority: each past transfer or purchase order that
//    was inside the limits;
//  - a recurring count: the corrections a count every few days would have found;
//  - a taught routine: the past approvals inside its amount.
// Preferences and job authority change how StockChief decides rather than a
// quantity it can replay, so they are shown as not testable.
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');

const JOB=210,DAYS=90,ROWS=20,STEPS=5000;
const day=value=>new Date(value).toISOString().slice(0,10);
const num=value=>{if(value===null||value===undefined||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;};
const units=value=>String(Number(Number(value).toFixed(6)));
const plural=(n,one,many)=>n+' '+(n===1?one:many);

// The plan and terms that include this job, or null.
async function included(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  return policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'automatic')?state:null;
}

// Stock on hand at one location (or every location) through the window,
// replayed from the movement ledger backwards from today's balance.
async function stockSteps(db,workspaceId,skuId,locationId){
  const {rows:[row]}=await db.query(`WITH m AS MATERIALIZED (SELECT occurred_at::timestamptz AS at,seq,quantity_delta::numeric AS d,operation
      FROM movements WHERE workspace_id=$1 AND sku_id=$2 AND ($3::text IS NULL OR location_id=$3)
       AND occurred_at::timestamptz>=now()-make_interval(days=>$4) ORDER BY occurred_at::timestamptz DESC,seq DESC LIMIT $5)
    SELECT (SELECT coalesce(sum(on_hand),0)::numeric FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND ($3::text IS NULL OR location_id=$3))
      -(SELECT coalesce(sum(d),0) FROM m) AS opening,
      coalesce((SELECT jsonb_agg(jsonb_build_array(at,d,operation) ORDER BY at,seq) FROM m),'[]'::jsonb) AS steps`,
  [workspaceId,skuId,locationId||null,DAYS,STEPS]);
  return {opening:Number(row.opening),steps:row.steps};
}
// Each time the level entered the tested range, and each time stock ran out.
function replay({opening,steps},inside){
  let level=opening,was=inside(level);const hits=[],outs=[],outgoing=[];
  for(const [at,delta,operation] of steps){
    const before=level;level+=Number(delta);const now=inside(level);
    if(now&&!was)hits.push({at,level,before});
    if(Number(delta)<0&&now)outgoing.push({at,level,before,delta:Number(delta),operation});
    if(level<=0&&before>0)outs.push(at);
    was=now;
  }
  return {hits,outs,outgoing};
}
const where=c=>c.locationName?' at '+c.locationName:' across your locations';

async function reorder(db,workspaceId,c){
  const point=num(c.reorderPoint)??num(c.safetyStock),target=num(c.targetStock);
  const title='Reorder '+(c.displayName||'this product')+where(c);
  if(point===null)return {title,tested:false,summary:'This rule sets only a target, so there is no reorder point to replay.',rows:[]};
  const history=await stockSteps(db,workspaceId,c.skuId,c.locationId),run=replay(history,level=>level<=point);
  const current=(await db.query('SELECT reorder_point FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2 AND location_id IS NOT DISTINCT FROM $3',
    [workspaceId,c.skuId,c.locationId||null])).rows[0];
  const before=current&&num(current.reorder_point)!==null&&Number(current.reorder_point)!==point?replay(history,level=>level<=Number(current.reorder_point)):null;
  const rows=run.hits.map(h=>{
    const out=run.outs.find(at=>new Date(at)>=new Date(h.at));
    return {When:day(h.at),'Would have':'Asked for '+(target!==null&&target>h.level?units(target-h.level)+' more to reach '+units(target):'more stock')+(c.locationId?'':' in total'),
      'What happened':units(h.level)+' on hand'+(out?'. Ran out on '+day(out):'')};
  });
  return {title,tested:true,rows:rows.slice(-ROWS),more:rows.length>ROWS,
    summary:'In the last '+DAYS+' days stock reached '+units(point)+' or less '+plural(run.hits.length,'time','times')+', so it would have asked for stock '+plural(run.hits.length,'time','times')+'.'+
      (run.outs.length?' Stock ran out '+plural(run.outs.length,'time','times')+'.':' Stock never ran out.')+
      (before?' Under the current reorder point of '+units(current.reorder_point)+' it would have asked '+plural(before.hits.length,'time','times')+'.':'')};
}

async function alert(db,workspaceId,c){
  const t=num(c.notificationThreshold),below=c.notificationComparator==='below',title='Warn about '+(c.displayName||'this product')+where(c);
  if(t===null)return {title,tested:false,summary:'This rule sets no alert level to replay.',rows:[]};
  const run=replay(await stockSteps(db,workspaceId,c.skuId,c.locationId),level=>below?level<t:level<=t);
  const rows=run.hits.map(h=>({When:day(h.at),'Would have':'Warned you','What happened':units(h.level)+' on hand'}));
  return {title,tested:true,rows:rows.slice(-ROWS),more:rows.length>ROWS,
    summary:'In the last '+DAYS+' days stock went '+(below?'below ':'to or below ')+units(t)+' '+plural(run.hits.length,'time','times')+', so it would have warned you '+plural(run.hits.length,'time','times')+'.'+
      (c.notificationMetric==='available_to_fulfill'?' This replays stock on hand; customer commitments are not recorded for each past day.':'')};
}

async function protection(db,workspaceId,c){
  const t=num(c.guardThreshold),below=c.guardComparator==='below',title=(c.guardMode==='block'?'Protect ':'Warn about ')+(c.displayName||'this product')+where(c);
  if(t===null)return {title,tested:false,summary:'This rule sets no stock level to replay.',rows:[]};
  const run=replay(await stockSteps(db,workspaceId,c.skuId,c.locationId),level=>below?level<t:level<=t);
  const verb=c.guardMode==='block'?'Stopped':'Warned before';
  const rows=run.outgoing.map(o=>({When:day(o.at),'Would have':verb+' taking out '+units(-o.delta),'What happened':'Left '+units(o.level)+' on hand'}));
  return {title,tested:true,rows:rows.slice(-ROWS),more:rows.length>ROWS,
    summary:plural(run.outgoing.length,'outgoing movement','outgoing movements')+' in the last '+DAYS+' days left stock '+(below?'below ':'at or below ')+units(t)+'. It would have '+(c.guardMode==='block'?'stopped':'warned about')+' '+(run.outgoing.length===1?'it':'them')+'.'};
}

async function supplierTerms(db,workspaceId,c){
  const title=(c.supplierName||'Supplier')+' terms for '+(c.displayName||'this product');
  const moq=num(c.minimumOrderQuantity),multiple=num(c.orderMultiple),pack=num(c.unitsPerPurchaseUnit),lead=num(c.leadTimeDays);
  const lines=(await db.query(`SELECT o.po_number,coalesce(o.ordered_at,o.approved_at,o.created_at) AS at,o.completed_at,o.ordered_at,o.status,o.currency,
      l.quantity_units::numeric AS quantity,l.unit_cost::numeric AS unit_cost
    FROM purchase_orders o JOIN purchase_order_lines l ON l.workspace_id=o.workspace_id AND l.purchase_order_id=o.id
    WHERE o.workspace_id=$1 AND o.supplier_id=$2 AND l.sku_id=$3 AND o.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED')
      AND coalesce(o.ordered_at,o.approved_at,o.created_at)::timestamptz>=now()-make_interval(days=>$4)
    ORDER BY coalesce(o.ordered_at,o.approved_at,o.created_at),o.po_number LIMIT 500`,[workspaceId,c.supplierId,c.skuId,DAYS])).rows;
  const rows=[];let added=0;const extra={};
  for(const l of lines){
    let q=Number(l.quantity);const was=q;
    if(moq!==null&&moq>0&&q<moq)q=moq;
    if(multiple!==null&&multiple>1&&q%multiple)q=Math.ceil(q/multiple)*multiple;
    if(pack!==null&&pack>1&&q%pack)q=Math.ceil(q/pack)*pack;
    if(q!==was){added+=q-was;if(l.unit_cost!=null)extra[l.currency]=(extra[l.currency]||0)+(q-was)*Number(l.unit_cost);
      rows.push({When:day(l.at),'Would have':'Ordered '+units(q)+' instead of '+units(was),'What happened':l.po_number});}
    if(lead!==null&&l.status==='RECEIVED'&&l.ordered_at&&l.completed_at){
      const took=Math.round((new Date(l.completed_at)-new Date(l.ordered_at))/86400000);
      if(took>lead)rows.push({When:day(l.completed_at),'Would have':'Planned for '+plural(lead,'day','days'),'What happened':l.po_number+' took '+plural(took,'day','days')});
    }
  }
  const changed=rows.filter(r=>r['Would have'].startsWith('Ordered')).length,late=rows.length-changed;
  const value=Object.entries(extra).map(([currency,v])=>{try{return money.format(money.toMinor(v.toFixed(money.exponent(currency)),currency),currency);}catch{return null;}}).filter(Boolean);
  return {title,tested:true,rows:rows.slice(-ROWS),more:rows.length>ROWS,
    summary:lines.length?(moq!==null||multiple!==null||pack!==null?changed+' of '+plural(lines.length,'past order line','past order lines')+' would have changed'+(added?', adding '+units(added)+' units'+(value.length?' (about '+value.join(' and ')+')':''):'')+'.':'')+
      (lead!==null?' '+plural(late,'delivery','deliveries')+' took longer than '+plural(lead,'day','days')+'.':''):
      'No purchase orders from '+(c.supplierName||'this supplier')+' for this product in the last '+DAYS+' days, so nothing would have changed.'};
}

async function transfers(db,workspaceId,c){
  const max=num(c.maximumQuantity),title='Move stock on its own up to '+units(max||0)+' units';
  const moves=(await db.query(`SELECT m.occurred_at::timestamptz AS at,m.quantity_delta::numeric AS quantity,s.code,src.name AS source,dst.name AS destination
    FROM movements m JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id JOIN locations dst ON dst.workspace_id=m.workspace_id AND dst.id=m.location_id
    LEFT JOIN locations src ON src.workspace_id=m.workspace_id AND src.id=m.counterparty_location_id
    WHERE m.workspace_id=$1 AND m.operation='transfer' AND m.leg='in' AND m.occurred_at::timestamptz>=now()-make_interval(days=>$2)
      AND ($3::text IS NULL OR m.sku_id=$3) AND ($4::text IS NULL OR $4 IN (m.location_id,m.counterparty_location_id))
      AND ($5::text IS NULL OR m.counterparty_location_id=$5)
    ORDER BY m.occurred_at::timestamptz,m.seq LIMIT 500`,[workspaceId,DAYS,c.skuId||null,c.locationId||null,c.sourceLocationId||null])).rows;
  const inside=moves.filter(m=>Number(m.quantity)<=max);
  const rows=moves.map(m=>({When:day(m.at),'Would have':Number(m.quantity)<=max?'Moved it on its own':'Still asked you','What happened':units(m.quantity)+' of '+m.code+' from '+(m.source||'another location')+' to '+m.destination}));
  return {title,tested:true,rows:rows.slice(-ROWS),more:rows.length>ROWS,
    summary:moves.length?inside.length+' of '+plural(moves.length,'past transfer','past transfers')+' in the last '+DAYS+' days were within this limit. Stock and safety checks still run each time.':
      'No transfers in the last '+DAYS+' days match this rule.'};
}

async function purchases(db,workspaceId,c){
  const each=num(c.maximumValue),week=num(c.weeklyValue),title='Send purchase orders to '+(c.supplierName||'this supplier')+' on its own';
  const orders=(await db.query(`SELECT o.po_number,o.ordered_at::timestamptz AS at,o.currency,coalesce(sum(l.line_total),0)::numeric AS value,
      bool_and($3::text IS NULL OR l.sku_id=$3) AS scoped
    FROM purchase_orders o JOIN purchase_order_lines l ON l.workspace_id=o.workspace_id AND l.purchase_order_id=o.id
    WHERE o.workspace_id=$1 AND o.supplier_id=$2 AND o.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED') AND o.ordered_at IS NOT NULL
      AND o.ordered_at::timestamptz>=now()-make_interval(days=>$5) AND ($4::text IS NULL OR o.destination_location_id=$4)
    GROUP BY o.id,o.po_number,o.ordered_at,o.currency ORDER BY o.ordered_at::timestamptz,o.po_number LIMIT 500`,
  [workspaceId,c.supplierId,c.skuId||null,c.locationId||null,DAYS])).rows.filter(o=>o.scoped);
  const rows=[];let inside=0;
  for(const o of orders){
    const rolling=orders.filter(x=>x.currency==='USD'&&new Date(x.at)<=new Date(o.at)&&new Date(x.at)>new Date(new Date(o.at)-7*86400000))
      .reduce((n,x)=>n+Number(x.value),0);
    const why=o.currency!=='USD'?'it is in '+o.currency:Number(o.value)>each?'it is over $'+each.toFixed(2):rolling>week?'the 7-day total would pass $'+week.toFixed(2):null;
    if(!why)inside++;
    rows.push({When:day(o.at),'Would have':why?'Still asked you: '+why:'Sent it on its own','What happened':o.po_number+' · '+o.currency+' '+Number(o.value).toFixed(2)});
  }
  return {title,tested:true,rows:rows.slice(-ROWS),more:rows.length>ROWS,
    summary:orders.length?inside+' of '+plural(orders.length,'past purchase order','past purchase orders')+' in the last '+DAYS+' days were within these limits. Price and stock checks still run each time.':
      'No purchase orders sent to '+(c.supplierName||'this supplier')+' in the last '+DAYS+' days match this rule.'};
}

// A plain-words rule, one replay per change.
async function change(db,workspaceId,c){
  if(c.operation==='remove')return {title:'Remove a setting',tested:false,summary:'Removing a setting has nothing to replay.',rows:[]};
  if(c.domain==='replenishment')return reorder(db,workspaceId,c);
  if(c.domain==='stock_alert')return alert(db,workspaceId,c);
  if(c.domain==='stock_protection')return protection(db,workspaceId,c);
  if(c.domain==='supplier_terms')return supplierTerms(db,workspaceId,c);
  if(c.domain==='transfer_authority')return transfers(db,workspaceId,c);
  if(c.domain==='purchase_authority')return purchases(db,workspaceId,c);
  return {title:c.domain==='operating_preference'?'A planning preference':'Authority for a job',tested:false,rows:[],
    summary:'This rule changes how StockChief decides, not a quantity it can replay, so there is no past-data test for it.'};
}

// A recurring count at one warehouse: the recorded corrections it would have found.
async function countSchedule(db,workspaceId,{locationId,locationName,days=7}){
  const every=Math.max(1,Math.min(365,Number(days)||7)),title='Count '+(locationName||'this warehouse')+' every '+plural(every,'day','days');
  const fixes=(await db.query(`SELECT m.occurred_at::timestamptz AS at,s.code,m.quantity_delta::numeric AS delta
    FROM movements m JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id
    WHERE m.workspace_id=$1 AND m.location_id=$2 AND m.operation='adjust' AND m.quantity_delta<>0
      AND coalesce(m.reason_code,'') NOT IN ('opening_stock','opening') AND m.occurred_at::timestamptz>=now()-make_interval(days=>$3)
    ORDER BY m.occurred_at::timestamptz,m.seq LIMIT 500`,[workspaceId,locationId,DAYS])).rows;
  const start=Date.now()-DAYS*86400000,counts=Math.floor(DAYS/every);
  const rows=fixes.map(f=>{const k=Math.ceil((new Date(f.at)-start)/(every*86400000)),at=start+k*every*86400000;
    return {When:day(f.at),'Would have':at<=Date.now()?'Found it at the count on '+day(at):'Find it at the next count','What happened':f.code+' corrected by '+units(f.delta)};});
  return {title,tested:true,rows:rows.slice(-ROWS),more:rows.length>ROWS,
    summary:'A count every '+plural(every,'day','days')+' would have checked '+(locationName||'this warehouse')+' '+plural(counts,'time','times')+' in the last '+DAYS+' days and found the '+plural(fixes.length,'correction','corrections')+' recorded there.'};
}

// A taught routine: the past approvals in its scope, and which were inside its amount.
async function routine(db,ctx,{action,key,currency,maximumMinor,latestId,label}){
  const examples=(await db.query(`SELECT created_at,status,(payload#>>'{training,amountMinor}')::bigint AS amount FROM stockchief_runtime.assistant_action_proposals
    WHERE workspace_id=$1 AND action_type=$2 AND payload#>>'{training,key}'=$3 AND payload#>>'{training,currency}'=$4 AND status IN ('EXECUTED','CANCELLED')
      AND created_at>=now()-make_interval(days=>$5) ORDER BY created_at DESC,id DESC LIMIT $6`,[ctx.workspaceId,action,key,currency,DAYS,ROWS+1])).rows;
  const settings=latestId?await require('./draft-authority').settings(db,ctx,latestId,money.fromMinor(maximumMinor,currency)):null;
  const preview=settings?.preview,limit=money.format(maximumMinor,currency);
  const rows=examples.slice(0,ROWS).reverse().map(e=>({When:day(e.created_at),
    'Would have':e.status==='CANCELLED'?'Asked you (you said no then)':Number(e.amount)<=maximumMinor?'Done it on its own':'Still asked you: over '+limit,
    'What happened':(e.status==='CANCELLED'?'Not approved':'Approved')+' · '+money.format(e.amount,currency)}));
  return {title:label||'A taught routine',tested:true,rows,more:examples.length>ROWS,
    summary:preview?preview.covered+' of '+plural(preview.total,'completed approval','completed approvals')+' in this scope were within '+limit+'. It would have done those on its own.':
      'No completed approvals in this scope to replay.'};
}

// Every change in a plain-words rule (an operating instruction proposal).
async function instruction(db,ctx,proposal){
  if(!await included(db,ctx.workspaceId))return null;
  const sections=[];
  for(const c of (proposal.resolvedChanges||[]).slice(0,12))sections.push(await change(db,ctx.workspaceId,c));
  return {sections,days:DAYS};
}
// One line for a rule list.
function headline(result){
  const tested=(result?.sections||[]).filter(s=>s.tested);
  return tested.length?tested.map(s=>s.summary).join(' '):'No past-data test for this kind of rule.';
}
// What the owner saw before switching the rule on, kept in the audit entry.
function snapshot(result){
  return {days:DAYS,sections:(result?.sections||[]).map(s=>({title:s.title,tested:s.tested,summary:s.summary,rows:s.rows.length}))};
}

// Job 210's review: every rule waiting to be switched on, with its replay.
async function review(db,ctx){
  await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'automatic');
  const pending=(await db.query(`SELECT id,summary,stated_as,resolved_changes FROM operating_instruction_proposals
    WHERE workspace_id=$1 AND status='PENDING' AND questions IN ('[]','') ORDER BY created_at DESC,id DESC LIMIT 20`,[ctx.workspaceId])).rows;
  const rows=[];
  for(const p of pending){
    let changes;try{changes=JSON.parse(p.resolved_changes||'[]');}catch{changes=[];}
    const result=await instruction(db,ctx,{resolvedChanges:changes});
    rows.push({Rule:p.summary||p.stated_as,Kind:'Rule you wrote','What it would have done':headline(result),link:'/operating-instructions/'+p.id});
  }
  const learning=require('./approval-learning'),corrections=require('./correction-rules');
  for(const o of (await learning.offers(db,ctx).catch(e=>{if(e.code==='entitlement_required')return [];throw e;})).slice(0,20))
    rows.push({Rule:o.label,Kind:'Stop asking',
      'What it would have done':o.test.sections[0]?.summary||'',link:learning.path+'#'+o.anchor});
  for(const s of (await corrections.suggestions(db,ctx).catch(e=>{if(e.code==='entitlement_required')return [];throw e;})).slice(0,20))
    rows.push({Rule:s.rule,Kind:'Suggested by your fixes','What it would have done':s.test.sections[0]?.summary||'',link:corrections.path+'#'+s.anchor});
  return {rows,more:false,summary:'Each rule waiting to be switched on, replayed against your last '+DAYS+' days of records. Nothing is changed by the test.'};
}

module.exports={JOB,DAYS,included,change,instruction,countSchedule,routine,headline,snapshot,review,
  definition:{id:JOB,key:'rule-tests',label:'Test new rules on past data',readPage:review}};

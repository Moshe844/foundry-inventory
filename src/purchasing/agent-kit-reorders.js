'use strict';

// Job 13: kits and bundles. Shows how many kits each warehouse can build now
// and keeps their parts stocked through the ordinary reorder path.
//
// A part that kits use is planned once per warehouse. Its recorded issues
// already include parts shipped in kits and parts used to assemble kits, so
// its own reorder point and target come from that real history. A saved kit
// target ("keep 5 kits ready here") replaces that kit's share of the history
// and is added on top. A part shared by several kits therefore has one need
// and one available quantity; nothing is counted twice. Reserved, held,
// expired and recalled stock never counts as available.
//
// Orders go through autopilot work items: Starter only sees the build counts,
// Growth prepares each part order for approval, and Pro and Custom place them
// inside the owner's purchasing rule and plan limits.
const {ValidationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan'),exact=require('../domain/exact-quantity');
const kits=require('../domain/postgres-kit-service'),decision=require('./replenishment-decision');
const MAX_KITS=500,MAX_PARTS=1000,PAGE=25;
const key=(skuId,locationId)=>skuId+'|'+locationId;
const num=value=>Number(value||0);
const whole=value=>Math.floor(value+1e-9);
const round=value=>Math.round(value*1e6)/1e6;
const autonomy=()=>require('../autopilot/postgres-service');
const scoped=client=>({query:(statement,values=[])=>client.query(statement,values),transaction:operation=>operation(client)});

async function recipes(db,workspaceId,{kitIds=null,filter='',offset=0,limit=MAX_KITS}={}){
 const rows=(await db.query(`SELECT k.kit_sku_id AS id,min(k.stock_basis) AS basis,s.code,s.item_id,i.name,s.variant_label
  FROM kit_components k JOIN skus s ON s.workspace_id=k.workspace_id AND s.id=k.kit_sku_id
  JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  WHERE k.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ($2::text[] IS NULL OR k.kit_sku_id=ANY($2::text[]))
   AND ($3='' OR lower(s.code)=lower($3))
  GROUP BY k.kit_sku_id,s.code,s.item_id,i.name,s.variant_label ORDER BY s.code,k.kit_sku_id OFFSET $4 LIMIT $5`,
 [workspaceId,kitIds,filter,offset,limit+1])).rows;
 const result=[];
 for(const kit of rows.slice(0,limit)){
  try{
   let parts;
   if(kit.basis==='components')parts=await kits.explode(db,workspaceId,kit.id);
   else{
    // A ready-made kit is assembled ahead from its recipe. Its parts are its
    // direct components, opened up through any kits built from parts.
    const definition=await kits.definition(db,workspaceId,kit.id),totals=new Map(),budget={remaining:2000};
    for(const component of definition.components)for(const leaf of await kits.explode(db,workspaceId,component.component_sku_id,
     {multiplier:exact.canonical(component.quantity),path:new Set([kit.id]),budget,depth:1}))
     totals.set(leaf.skuId,exact.add(totals.get(leaf.skuId)||'0',leaf.quantity));
    parts=[...totals].sort(([a],[b])=>a.localeCompare(b)).map(([skuId,quantity])=>({skuId,quantity}));
   }
   result.push({...kit,parts});
  }catch(error){
   if(!(error instanceof ValidationError))throw error;
   result.push({...kit,parts:[],problem:error.message});
  }
 }
 return {kits:result,more:rows.length>limit};
}

async function locations(db,workspaceId){
 return (await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL ORDER BY name,id',[workspaceId])).rows;
}

async function codes(db,workspaceId,ids){
 if(!ids.length)return new Map();
 return new Map((await db.query(`SELECT s.id,s.code,s.item_id,i.name,s.variant_label,i.unit_label FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])`,[workspaceId,ids])).rows.map(r=>[r.id,r]));
}

// Parts shipped in kits and parts used to assemble kits, by warehouse and the
// kit that used them, from the same 90 days the reorder points use.
async function partHistory(db,workspaceId,partIds){
 if(!partIds.length)return {sales:[],assembly:[]};
 const sales=(await db.query(`SELECT k.sku_id,k.location_id,l.sku_id AS kit_sku_id,sum(k.quantity)::text AS units,count(*)::int AS events
  FROM sales_shipment_kit_lines k JOIN sales_order_lines l ON l.workspace_id=k.workspace_id AND l.id=k.sales_order_line_id
  WHERE k.workspace_id=$1 AND k.sku_id=ANY($2::text[]) AND k.created_at::timestamptz>=CURRENT_TIMESTAMP-make_interval(days=>$3)
  GROUP BY 1,2,3`,[workspaceId,partIds,decision.WINDOW_DAYS])).rows;
 const assembly=(await db.query(`SELECT u.sku_id,u.location_id,b.output_sku_id AS kit_sku_id,sum(u.quantity)::text AS units,count(*)::int AS events
  FROM manufacturing_material_uses u JOIN manufacturing_work_orders w ON w.workspace_id=u.workspace_id AND w.id=u.work_order_id
  JOIN manufacturing_boms b ON b.workspace_id=w.workspace_id AND b.id=w.bom_id
  JOIN movements m ON m.workspace_id=u.workspace_id AND m.id=u.movement_id
  WHERE u.workspace_id=$1 AND u.sku_id=ANY($2::text[]) AND m.occurred_at::timestamptz>=CURRENT_TIMESTAMP-make_interval(days=>$3)
   AND EXISTS(SELECT 1 FROM kit_components kc WHERE kc.workspace_id=b.workspace_id AND kc.kit_sku_id=b.output_sku_id)
  GROUP BY 1,2,3`,[workspaceId,partIds,decision.WINDOW_DAYS])).rows;
 return {sales,assembly};
}

// Whole kits sold from and assembled at each warehouse in the last 90 days.
async function kitHistory(db,workspaceId,kitIds){
 if(!kitIds.length)return new Map();
 const rows=(await db.query(`WITH shipped AS (
   SELECT l.sku_id AS kit_sku_id,k.location_id,max(k.quantity::numeric/c.quantity_per_kit) AS kits
   FROM sales_shipment_kit_lines k JOIN sales_order_kit_components c ON c.workspace_id=k.workspace_id AND c.id=k.kit_component_id
   JOIN sales_order_lines l ON l.workspace_id=k.workspace_id AND l.id=k.sales_order_line_id
   WHERE k.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND k.created_at::timestamptz>=CURRENT_TIMESTAMP-make_interval(days=>$3)
   GROUP BY l.sku_id,k.location_id,k.shipment_id,k.sales_order_line_id)
  SELECT kit_sku_id,location_id,sum(kits)::text AS sold,'0' AS assembled FROM shipped GROUP BY 1,2
  UNION ALL
  SELECT sku_id,location_id,sum(-quantity_delta) FILTER(WHERE operation='issue' AND reason_code IN('sale','sold'))::text,
   sum(quantity_delta) FILTER(WHERE operation='receive' AND reason_code='production')::text
  FROM movements WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND occurred_at::timestamptz>=CURRENT_TIMESTAMP-make_interval(days=>$3)
   AND (operation='issue' AND reason_code IN('sale','sold') OR operation='receive' AND reason_code='production')
  GROUP BY 1,2`,[workspaceId,kitIds,decision.WINDOW_DAYS])).rows,result=new Map();
 for(const row of rows){const k=key(row.kit_sku_id,row.location_id),old=result.get(k)||{sold:0,assembled:0};
  result.set(k,{sold:round(old.sold+num(row.sold)),assembled:round(old.assembled+num(row.assembled))});}
 return result;
}

// Orders already waiting for a person, or unsent purchase drafts, count as
// supply so a waiting order is never prepared a second time.
async function pendingSupply(db,workspaceId,partIds,excludeWorkId){
 const result=new Map();if(!partIds.length)return result;
 const rows=(await db.query(`SELECT a->>'skuId' AS sku_id,a->>'destinationLocationId' AS location_id,sum((a->>'quantity')::numeric)::text AS quantity
  FROM work_items w CROSS JOIN LATERAL (SELECT w.recommended_action::jsonb AS a) action
  WHERE w.workspace_id=$1 AND w.source='postgres_autopilot' AND w.category IN('replenishment_plan','stock_transfer')
   AND w.execution_status IN('WAITING_FOR_APPROVAL','AUTHORIZED') AND w.purchase_order_id IS NULL
   AND w.id<>coalesce($3,'') AND a->>'skuId'=ANY($2::text[]) AND a->>'destinationLocationId' IS NOT NULL
  GROUP BY 1,2
  UNION ALL
  SELECT l.sku_id,coalesce(l.destination_location_id,o.destination_location_id),sum(l.quantity_units-l.quantity_received_units)::text
  FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
  WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND o.status IN('DRAFT','AWAITING_APPROVAL')
   AND coalesce(to_jsonb(o)->>'delivery_kind','WAREHOUSE')='WAREHOUSE' AND l.quantity_units>l.quantity_received_units
  GROUP BY 1,2`,[workspaceId,partIds,excludeWorkId])).rows;
 for(const row of rows){if(!row.location_id)continue;const k=key(row.sku_id,row.location_id);result.set(k,round(num(result.get(k))+num(row.quantity)));}
 return result;
}

function describeQuantity(value){return String(round(value));}

// The kit facts behind each part and warehouse. Used to plan, to explain and to
// keep ordinary reorders from buying the same part a second time.
async function facts(db,workspaceId,{partIds=null}={}){
 const {kits:list}=await recipes(db,workspaceId);
 const uses=new Map(),kitById=new Map(list.map(k=>[k.id,k]));
 for(const kit of list)for(const part of kit.parts){if(!uses.has(part.skuId))uses.set(part.skuId,[]);uses.get(part.skuId).push({kit,quantity:num(part.quantity)});}
 let ids=[...uses.keys()].sort();if(partIds)ids=ids.filter(id=>partIds.includes(id));
 const partial=ids.length>MAX_PARTS;ids=ids.slice(0,MAX_PARTS);
 const kitIds=list.map(k=>k.id);
 // Sequential reads: inside a transaction these share one connection.
 const history=await partHistory(db,workspaceId,ids);
 const targets=kitIds.length?(await db.query(`SELECT sku_id,location_id,reorder_point::text,target_stock::text FROM reorder_policies
   WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND (reorder_point IS NOT NULL OR target_stock IS NOT NULL) ORDER BY sku_id,location_id NULLS FIRST`,[workspaceId,kitIds])).rows:[];
 const bought=kitIds.length?new Set((await db.query(`SELECT DISTINCT si.sku_id FROM supplier_items si JOIN suppliers v ON v.workspace_id=si.workspace_id AND v.id=si.supplier_id
   WHERE si.workspace_id=$1 AND si.sku_id=ANY($2::text[]) AND si.is_active=1 AND v.status='active'`,[workspaceId,kitIds])).rows.map(x=>x.sku_id)):new Set();
 const stock=await require('../domain/postgres-kit-availability').stock(db,workspaceId,[...new Set([...ids,...kitIds])]);
 // A ready-made kit bought from a supplier is ordinary stock, not a build target.
 const kitTargets=new Map(),kitProblems=new Map();
 for(const t of targets){const kit=kitById.get(t.sku_id);if(!kit||kit.basis!=='components'&&bought.has(kit.id))continue;
  if(!t.location_id){kitProblems.set(kit.id,'Save the kit target for each warehouse. One target for all warehouses does not say where to keep the parts.');continue;}
  kitTargets.set(key(kit.id,t.location_id),{reorder:t.reorder_point==null?null:num(t.reorder_point),target:t.target_stock==null?null:num(t.target_stock)});}
 const byPosition=new Map();
 const add=(row,field)=>{const k=key(row.sku_id,row.location_id);if(!byPosition.has(k))byPosition.set(k,{sales:0,salesEvents:0,assembly:0,assemblyEvents:0,byKit:new Map()});
  const entry=byPosition.get(k),units=num(row.units);entry[field]=round(entry[field]+units);entry[field+'Events']+=row.events;
  const kitEntry=entry.byKit.get(row.kit_sku_id)||{units:0,events:0};entry.byKit.set(row.kit_sku_id,{units:round(kitEntry.units+units),events:kitEntry.events+row.events});};
 for(const row of history.sales)add(row,'sales');
 for(const row of history.assembly)add(row,'assembly');
 const usable=(skuId,locationId)=>num(stock.get(JSON.stringify([skuId,locationId])));
 function at(skuId,locationId){
  const entry=byPosition.get(key(skuId,locationId))||{sales:0,salesEvents:0,assembly:0,assemblyEvents:0,byKit:new Map()};
  const saved=[];
  for(const use of uses.get(skuId)||[]){const target=kitTargets.get(key(use.kit.id,locationId));if(!target)continue;
   const ready=usable(use.kit.id,locationId),reorder=target.reorder??target.target,goal=Math.max(reorder,target.target??reorder);
   saved.push({kitSkuId:use.kit.id,code:use.kit.code,perKit:use.quantity,ready,kitReorder:reorder,kitTarget:goal,
    reorder:round(Math.max(0,reorder-ready)*use.quantity),target:round(Math.max(0,goal-ready)*use.quantity)});}
  return {...entry,saved,owned:entry.sales>0||entry.assembly>0||saved.length>0};
 }
 return {list,uses,ids,partial,kitProblems,usable,at,kitById};
}

// One plan position per part and warehouse with kit demand.
async function plan(db,workspaceId,{partIds=null,locationId=null,excludeWorkId=null,known=null}={}){
 const kitFacts=known||await facts(db,workspaceId,{partIds});
 const places=(await locations(db,workspaceId)).filter(p=>!locationId||p.id===locationId);
 const candidates=[],wanted=partIds?kitFacts.ids.filter(id=>partIds.includes(id)):kitFacts.ids;
 for(const skuId of wanted)for(const place of places){const f=kitFacts.at(skuId,place.id);if(f.owned)candidates.push({skuId,place,facts:f});}
 if(!candidates.length)return {positions:[],facts:kitFacts};
 const ids=[...new Set(candidates.map(c=>c.skuId))];
 const rows=await require('./postgres-replenishment-state').rows(db,workspaceId,{onlySkuIds:ids});
 const pending=await pendingSupply(db,workspaceId,ids,excludeWorkId),names=await codes(db,workspaceId,ids);
 const byKey=new Map(),template=new Map(),global=new Set();
 for(const row of rows){if(!row.location_id){global.add(row.sku_id);continue;}byKey.set(key(row.sku_id,row.location_id),row);if(!template.has(row.sku_id))template.set(row.sku_id,row);}
 const positions=[];
 for(const {skuId,place,facts:f} of candidates){
  const name=names.get(skuId),code=name?.code||skuId;
  const kitsUsing=(kitFacts.uses.get(skuId)||[]).map(u=>({kitSkuId:u.kit.id,code:u.kit.code,perKit:u.quantity}));
  const base={skuId,code,itemId:name?.item_id,unit:name?.unit_label,locationId:place.id,locationName:place.name,kits:kitsUsing,
   kitSales:f.sales,assembly:f.assembly,saved:f.saved};
  if(global.has(skuId)){positions.push({...base,ordinary:true,hold:code+' uses one reorder point for all warehouses, so its kit needs are planned with that reorder point.'});continue;}
  const existing=byKey.get(key(skuId,place.id)),source=template.get(skuId);
  // A warehouse with no record of the part yet still needs its kit parts.
  const row=existing||(source?{...source,location_id:place.id,location_name:place.name,on_hand:0,committed:0,incoming:0,issue_events:0,issued:0,
   policy_id:null,policy_location_id:null,reorder_point:null,target_stock:null,safety_stock:null,default_order_quantity:null,preferred_supplier_id:null,
   local_lead:null,local_policy_updated_at:null,supplier_supply_held:undefined}:null);
  if(!row){positions.push({...base,hold:'Restore '+code+' before planning its kits.'});continue;}
  // A saved kit target replaces that kit's share of the history.
  let issued=num(row.issued),events=num(row.issue_events);
  for(const target of f.saved){const used=f.byKit.get(target.kitSkuId);if(used){issued-=used.units;events-=used.events;}}
  issued=Math.max(0,round(issued));events=Math.max(0,events);
  const available=kitFacts.usable(skuId,place.id),incoming=num(row.incoming),waiting=num(pending.get(key(skuId,place.id)));
  const derived=decision.derive({...row,issued,issue_events:events,on_hand:available,committed:0,incoming:round(incoming+waiting)});
  const savedReorder=round(f.saved.reduce((n,t)=>n+t.reorder,0)),savedTarget=round(f.saved.reduce((n,t)=>n+t.target,0));
  const none=derived.reorder===null&&!f.saved.length;
  const reorder=none?null:round((derived.reorder??0)+savedReorder);
  const target=none?null:round(Math.max(reorder,(derived.target??derived.reorder??0)+savedTarget));
  const projected=round(available+incoming+waiting),shortage=reorder!==null&&projected<=reorder;
  const needed=shortage?Math.max(0,round(target-projected)):0;
  const direct=Math.max(0,round(num(row.issued)-f.sales-f.assembly));
  let hold=null;
  if(shortage&&needed>0){
   if(row.supplier_supply_held)hold='Check the supplier’s availability report on the open order for '+code+' before ordering more.';
   else if(num(row.on_hand)<0)hold='Correct the negative stock of '+code+' at '+place.name+' before reordering it.';
   else if(kitFacts.kitById.has(skuId))hold=code+' is itself a kit. Assemble more '+code+' at '+place.name+'; its own parts are planned from its recipe.';
  }
  positions.push({...base,row,available,onHand:num(row.on_hand),incoming,pending:waiting,projected,issued:num(row.issued),direct,
   reorder,target,shortage,needed,hold,lead:derived.lead,safety:derived.safety,sourceVersion:row.source_version||'0',
   inferred:derived.reorder!==null&&row.reorder_point==null});
 }
 return {positions,facts:kitFacts};
}

function label(position){
 const kitsLine=position.kits.map(k=>k.code+' ('+describeQuantity(k.perKit)+' each)').join(', ');
 const saved=position.saved.map(t=>t.code+': keep '+describeQuantity(t.kitReorder)+(t.kitTarget!==t.kitReorder?' to '+describeQuantity(t.kitTarget):'')+' ready'+(t.ready?', '+describeQuantity(t.ready)+' already made':'')).join('; ');
 return {kitsLine,saved};
}

async function prepare(db,workspaceId,positions,state){
 const ready=[],held=[];
 for(const position of positions){
  if(position.ordinary||!position.shortage||!(position.needed>0))continue;
  if(position.hold){held.push({position,reason:position.hold});continue;}
  const supplier=await autonomy().supplierChoice(db,workspaceId,{...position.row,sku_id:position.skuId,needed:position.needed},state);
  if(!supplier){held.push({position,reason:'Save a supplier and its current price for '+position.code+' so its kit parts can be ordered.'});continue;}
  if(supplier.restriction){held.push({position,reason:supplier.restriction});continue;}
  const {kitsLine,saved}=label(position),name=position.row.item_name+(position.row.variant_label?' — '+position.row.variant_label:'');
  const candidate={type:'purchase',skuId:position.skuId,sourceVersion:position.sourceVersion,displayName:name,code:position.code,
   quantity:supplier.quantity,purchaseUnits:supplier.purchaseUnits,unitsPerPurchaseUnit:supplier.unitsPer,purchaseUnit:supplier.purchase_unit,
   purchaseMultiple:supplier.purchaseMultiple,topUpSignature:supplier.topUpSignature,supplierId:supplier.supplier_id,supplierName:supplier.supplier_name,
   supplierSku:supplier.supplier_sku,destinationLocationId:position.locationId,destinationLocationName:position.locationName,quantityScope:'location',
   receivingOptions:null,unitCost:supplier.unitCost,value:supplier.value,currency:supplier.currency||'USD',destinationAvailable:position.available,
   incoming:position.incoming,pending:position.pending,reorderPoint:position.reorder,targetStock:position.target,priority:88,
   urgency:position.available<=0?'immediate':'soon',
   kitDemand:{kits:position.kits,saved:position.saved.map(t=>({kitSkuId:t.kitSkuId,code:t.code,perKit:t.perKit,keep:t.kitReorder,upTo:t.kitTarget,ready:t.ready})),
    kitSales:position.kitSales,assembly:position.assembly,otherUse:position.direct,windowDays:decision.WINDOW_DAYS},
   evidence:[{fact:'available',value:position.available},{fact:'incoming',value:position.incoming},
    ...(position.pending?[{fact:'already_waiting',value:position.pending}]:[]),
    {fact:'reorder_point',value:position.reorder},{fact:'target_stock',value:position.target},
    {fact:'used_in_kits',value:kitsLine},{fact:'kit_sales_90_days',value:position.kitSales},{fact:'kit_assembly_90_days',value:position.assembly},
    {fact:'other_use_90_days',value:position.direct},...(saved?[{fact:'saved_kit_targets',value:saved}]:[]),
    {fact:'supplier_pack',value:supplier.unitsPer},{fact:'supplier_minimum_purchase_units',value:Number(supplier.minimum_order_quantity||1)},
    ...(supplier.topUp?[{fact:'supplier_top_up',value:supplier.topUp}]:[])]};
  ready.push({position,candidate});
 }
 return {ready,held};
}

// Called by the scheduled autopilot run. Everything goes through ordinary
// autopilot work items, so limits, approvals and supplier mail are unchanged.
async function run(database,ctx,{partIds=null}={}){
 const account=await policy.accountState(database,ctx.workspaceId);
 if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,13,'draft'))return {skipped:'plan'};
 const service=autonomy(),state=await service.getState(database,ctx.workspaceId);
 if(state.paused||state.suspended)return {skipped:'paused'};
 // A stock signal about products no kit uses needs no kit planning.
 if(partIds&&!(await database.query('SELECT 1 FROM kit_components WHERE workspace_id=$1 AND component_sku_id=ANY($2::text[]) LIMIT 1',[ctx.workspaceId,partIds])).rowCount)
  return {planned:0,executed:0,waiting:0,held:[]};
 const {positions}=await plan(database,ctx.workspaceId,{partIds});
 const {ready,held}=await prepare(database,ctx.workspaceId,positions,state),prepared=[];
 for(const {candidate} of ready){const evaluation=await service.evaluate(database,ctx.workspaceId,candidate,state);if(evaluation.decision!=='refused')prepared.push({candidate,evaluation});}
 const {created}=await service.persistPlannedWork(database,ctx.workspaceId,prepared);
 let executed=0;
 for(const item of created.filter(w=>w.approval_requirement==='NONE')){
  const done=await database.transaction(async client=>{
   await client.query('SAVEPOINT kit_parts_order');
   try{const result=await service.execute(scoped(client),ctx,item.id,{worker:true});await client.query('RELEASE SAVEPOINT kit_parts_order');return result;}
   catch(error){
    if(!['validation_error','entitlement_required','forbidden','not_found'].includes(error.code))throw error;
    await client.query('ROLLBACK TO SAVEPOINT kit_parts_order');await client.query('RELEASE SAVEPOINT kit_parts_order');
    await client.query(`UPDATE work_items SET approval_requirement='REQUIRED',execution_status='WAITING_FOR_APPROVAL',error_message=$3
     WHERE workspace_id=$1 AND id=$2 AND execution_status='AUTHORIZED'`,[ctx.workspaceId,item.id,error.message]);
    return service.getWork(scoped(client),ctx.workspaceId,item.id);
   }
  },{isolation:'SERIALIZABLE',retrySafe:true});
  if(done.purchase_order_id)executed+=1;
 }
 return {planned:created.length,executed,waiting:created.length-executed,held:held.map(h=>({skuId:h.position.skuId,locationId:h.position.locationId,reason:h.reason}))};
}

// Ordinary reorders leave parts with kit demand to this job on plans that
// include it, so one warehouse never gets two orders for the same need. A kit
// built from parts is never bought; moving its parts stays with transfers, but
// a warehouse never gives away parts its own kits need.
async function owned(db,workspaceId,rows){
 const ids=[...new Set(rows.map(r=>r.sku_id))];
 if(!ids.length)return ()=>null;
 const found=(await db.query(`SELECT DISTINCT kit_sku_id AS sku_id,stock_basis FROM kit_components WHERE workspace_id=$1 AND kit_sku_id=ANY($2::text[])
  UNION SELECT DISTINCT component_sku_id,'part' FROM kit_components WHERE workspace_id=$1 AND component_sku_id=ANY($2::text[])`,[workspaceId,ids])).rows;
 if(!found.length)return ()=>null;
 const built=new Set(found.filter(r=>r.stock_basis==='components').map(r=>r.sku_id)),known=await facts(db,workspaceId);
 const global=new Set(rows.filter(r=>!r.location_id).map(r=>r.sku_id));
 return (skuId,locationId)=>built.has(skuId)?'kit':locationId&&!global.has(skuId)&&known.uses.has(skuId)&&known.at(skuId,locationId).owned?'part':null;
}

// Execution checks the same part and warehouse again, without counting this
// order as already waiting.
async function revalidate(db,workspaceId,action,workId){
 const {positions}=await plan(db,workspaceId,{partIds:[action.skuId],locationId:action.destinationLocationId,excludeWorkId:workId});
 const position=positions.find(p=>p.skuId===action.skuId&&p.locationId===action.destinationLocationId);
 if(!position||position.ordinary||!position.shortage||!(position.needed>0))
  throw new ValidationError('The kit parts at '+(action.destinationLocationName||'this warehouse')+' no longer need this order. Review the updated stock before acting.');
 if(position.hold)throw new ValidationError(position.hold);
 if(position.incoming>Number(action.incoming||0))throw new ValidationError('New incoming stock changes this need. StockChief did not order twice.');
 const service=autonomy(),state=await service.getState(db,workspaceId);
 const supplier=await service.supplierChoice(db,workspaceId,{...position.row,sku_id:position.skuId,needed:position.needed},state);
 if(supplier?.restriction)throw new ValidationError(supplier.restriction);
 if(!supplier||supplier.supplier_id!==action.supplierId||supplier.quantity!==action.quantity||supplier.unitCost!==action.unitCost||supplier.currency!==action.currency||
  supplier.purchaseUnits!==action.purchaseUnits||supplier.unitsPer!==action.unitsPerPurchaseUnit||(action.purchaseUnit!=null&&supplier.purchase_unit!==action.purchaseUnit)||
  (action.purchaseMultiple!=null&&supplier.purchaseMultiple!==action.purchaseMultiple)||(action.topUpSignature??null)!==supplier.topUpSignature)
  throw new ValidationError('Supplier terms, price or the required quantity changed after this decision. Review a fresh recommendation.');
}

function limitText(part,available,perKit,others){
 return part+': '+describeQuantity(available)+' available, '+describeQuantity(perKit)+' per kit'+(others.length?' (also used by '+others.join(', ')+')':'');
}

// The kit review: build counts for every warehouse, what limits each one,
// and on paid plans the parts being reordered for them.
async function review(db,ctx,{filter='',page=1,adviceOnly=false}={}){
 const {kits:list,more}=await recipes(db,ctx.workspaceId,{filter,offset:(page-1)*PAGE,limit:PAGE});
 const places=await locations(db,ctx.workspaceId);
 const known=await facts(db,ctx.workspaceId),partIds=[...new Set(list.flatMap(k=>k.parts.map(p=>p.skuId)))];
 const names=await codes(db,ctx.workspaceId,partIds),activity=await kitHistory(db,ctx.workspaceId,list.map(k=>k.id));
 const planned=adviceOnly||!partIds.length?{positions:[]}:await plan(db,ctx.workspaceId,{partIds,known});
 const byPosition=new Map(planned.positions.map(p=>[key(p.skuId,p.locationId),p]));
 const prepared=planned.positions.length?await prepare(db,ctx.workspaceId,planned.positions,await autonomy().getState(db,ctx.workspaceId)):{ready:[],held:[]};
 const toOrder=new Map(prepared.ready.map(r=>[key(r.position.skuId,r.position.locationId),r.candidate])),stopped=new Map(prepared.held.map(h=>[key(h.position.skuId,h.position.locationId),h.reason]));
 const rows=[];
 for(const kit of list)for(const place of places){
  let build=0,limit=kit.problem||'No parts recorded';
  if(!kit.problem&&kit.parts.length){
   const counts=kit.parts.map(p=>({part:p,code:names.get(p.skuId)?.code||p.skuId,available:known.usable(p.skuId,place.id),perKit:num(p.quantity)}))
    .map(p=>({...p,build:whole(p.available/p.perKit)})).sort((a,b)=>a.code.localeCompare(b.code));
   build=Math.max(0,Math.min(...counts.map(p=>p.build)));
   limit=counts.filter(p=>p.build===build).map(p=>limitText(p.code,p.available,p.perKit,
    (known.uses.get(p.part.skuId)||[]).filter(u=>u.kit.id!==kit.id).map(u=>u.kit.code))).join('; ');
  }
  const row={Kit:kit.code,Warehouse:place.name,'Build now':build,'Limited by':limit};
  if(!adviceOnly){
   const used=activity.get(key(kit.id,place.id))||{sold:0,assembled:0},notes=[];
   for(const part of kit.parts){
    const k=key(part.skuId,place.id),position=byPosition.get(k),code=names.get(part.skuId)?.code||part.skuId;
    if(!position)continue;
    if(position.pending>0)notes.push(code+': '+describeQuantity(position.pending)+' waiting for approval');
    if(toOrder.has(k))notes.push(code+': '+describeQuantity(toOrder.get(k).quantity)+' to order');
    else if(stopped.has(k))notes.push(stopped.get(k));
    else if(position.ordinary)notes.push(position.hold);
   }
   row['Ready-made']=known.usable(kit.id,place.id);
   row['Used, 90 days']=describeQuantity(used.sold)+' sold, '+describeQuantity(used.assembled)+' assembled';
   row['Parts to order']=notes.length?[...new Set(notes)].join('; '):'None';
   row.Review=known.kitProblems.get(kit.id)||'Reserved, held, expired and recalled parts are not counted.';
   row.link='/inventory/'+kit.item_id;
  }
  rows.push(row);
 }
 return {rows,more,summary:adviceOnly?'How many of each kit every warehouse can build from its own available parts, and which part limits it.'
  :'How many of each kit every warehouse can build from its own available parts. Parts shared by kits are counted once. Kit sales, kit assembly and saved kit targets set each part’s reorder; orders go through your usual purchase approvals and limits.'};
}

function suggestion(row){
 return row['Build now']>0?'Build '+row['Build now']+' '+row.Kit+' at '+row.Warehouse+' now. Limited by '+row['Limited by']+'.'
  :row.Kit+' can’t be built at '+row.Warehouse+' now. Short: '+row['Limited by']+'.';
}

module.exports={recipes,facts,plan,prepare,run,owned,revalidate,review,suggestion,MAX_PARTS};

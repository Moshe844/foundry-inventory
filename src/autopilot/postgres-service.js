'use strict';

const crypto = require('node:crypto');
const { newId, nowIso } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const transfers = require('../transfers/postgres-transfer-service');
const workflows = require('../operations/postgres-business-workflows');

const MODES = Object.freeze({ OBSERVE:'OBSERVE', SUPERVISED:'SUPERVISED', POLICY_AUTOMATED:'POLICY_AUTOMATED' });
const ACTIONS = Object.freeze({ TRANSFER:'transfer', PURCHASE:'approve_purchase_order' });
const STATUSES = Object.freeze({ WAITING:'WAITING_FOR_APPROVAL', AUTHORIZED:'AUTHORIZED', EXECUTING:'EXECUTING',
  COMPLETED:'COMPLETED', CANCELLED:'CANCELLED', FAILED:'FAILED' });

function parse(value,fallback){if(value&&typeof value==='object')return value;try{return JSON.parse(value||'')??fallback;}catch{return fallback;}}
function stable(value){if(value===null||typeof value!=='object')return JSON.stringify(value??null);
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;}
function hash(value){return crypto.createHash('sha256').update(stable(value)).digest('hex');}
function integer(value,label,{minimum=0,maximum=1000000}={}){const number=Number(value);
  if(!Number.isSafeInteger(number)||number<minimum||number>maximum)throw new ValidationError(`${label} must be a whole number between ${minimum} and ${maximum}.`);return number;}
function money(value,label){const number=Number(value);if(!Number.isFinite(number)||number<=0||number>100000000)
  throw new ValidationError(`${label} must be a positive amount.`);return Math.round(number*100)/100;}
function assertAdmin(membership){permissions.assertCan(membership,permissions.ADMIN,'change StockChief authority');}
function assertOperate(membership){permissions.assertCan(membership,permissions.OPERATE,'operate StockChief');}
function scopedDatabase(client){return {query:(statement,values=[])=>client.query(statement,values),
  transaction:(operation)=>operation(client)};}

function stateFrom(row){return {workspaceId:row.workspace_id,mode:row.mode,paused:Boolean(Number(row.paused)),pausedAt:row.paused_at,
  pausedReason:row.paused_reason,suspended:Boolean(Number(row.suspended)),suspendedScope:row.suspended_scope,
  suspendedReason:row.suspended_reason,lastEvaluatedAt:row.last_evaluated_at,nextEvaluationAt:row.next_evaluation_at,
  canAct:row.mode!==MODES.OBSERVE&&!Number(row.paused)&&!Number(row.suspended),
  canAutomate:row.mode===MODES.POLICY_AUTOMATED&&!Number(row.paused)&&!Number(row.suspended)};}

async function ensure(database,workspaceId){const at=nowIso();
  await database.query(`INSERT INTO workspace_autopilot(workspace_id,mode,created_at,updated_at)
    VALUES($1,'SUPERVISED',$2,$2) ON CONFLICT(workspace_id) DO NOTHING`,[workspaceId,at]);
  await database.query(`INSERT INTO autopilot_limits(workspace_id,updated_at) VALUES($1,$2)
    ON CONFLICT(workspace_id) DO NOTHING`,[workspaceId,at]);
  return stateFrom((await database.query('SELECT * FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0]);}
async function getState(database,workspaceId){return ensure(database,workspaceId);}

async function setMode(database,ctx,membership,mode){if(!Object.values(MODES).includes(mode))
  throw new ValidationError('Choose watch only, ask first, or bounded automatic work.');
  const current=await ensure(database,ctx.workspaceId);const rank={OBSERVE:0,SUPERVISED:1,POLICY_AUTOMATED:2};
  if(rank[mode]>rank[current.mode])assertAdmin(membership);else assertOperate(membership);
  await database.query('UPDATE workspace_autopilot SET mode=$2,updated_at=$3 WHERE workspace_id=$1',[ctx.workspaceId,mode,nowIso()]);
  return getState(database,ctx.workspaceId);}
async function pause(database,ctx,membership,reason){assertOperate(membership);await ensure(database,ctx.workspaceId);const at=nowIso();
  await database.query(`UPDATE workspace_autopilot SET paused=1,paused_at=$2,paused_by_user_id=$3,
    paused_reason=$4,updated_at=$2 WHERE workspace_id=$1`,[ctx.workspaceId,at,ctx.actorId,String(reason||'').trim()||null]);
  return getState(database,ctx.workspaceId);}
async function resume(database,ctx,membership){assertOperate(membership);const current=await ensure(database,ctx.workspaceId);
  if(current.suspended)assertAdmin(membership);await database.query(`UPDATE workspace_autopilot SET paused=0,paused_at=NULL,
    paused_by_user_id=NULL,paused_reason=NULL,updated_at=$2 WHERE workspace_id=$1`,[ctx.workspaceId,nowIso()]);
  return getState(database,ctx.workspaceId);}

function policyFrom(row){return {id:row.id,name:row.name,description:row.description,enabled:Boolean(Number(row.enabled)),
  actions:parse(row.allowed_action_types,[]),locationScope:parse(row.location_scope,[]),supplierScope:parse(row.supplier_scope,[]),
  conditions:parse(row.conditions,[]),thresholds:parse(row.thresholds,{}),maximumQuantity:row.maximum_quantity===null?null:Number(row.maximum_quantity),
  maximumValue:row.maximum_value===null?null:Number(row.maximum_value),dailyLimit:row.daily_limit===null?null:Number(row.daily_limit),
  version:Number(row.version),integrityHash:row.integrity_hash,approvedAt:row.approved_at,disabledAt:row.disabled_at,
  active:Boolean(Number(row.enabled))&&Boolean(row.approved_at)&&!row.disabled_at};}
async function listPolicies(database,workspaceId){return (await database.query(`SELECT * FROM automation_policies WHERE workspace_id=$1
  ORDER BY created_at DESC,id`,[workspaceId])).rows.map(policyFrom);}
async function activePolicy(database,workspaceId,action){const rows=(await database.query(`SELECT * FROM automation_policies
  WHERE workspace_id=$1 AND enabled=1 AND approved_at IS NOT NULL AND disabled_at IS NULL ORDER BY version DESC,created_at DESC`,[workspaceId])).rows;
  return rows.map(policyFrom).find((policy)=>policy.actions.includes(action))||null;}

async function replacePolicy(client,ctx,input){await ensure(client,ctx.workspaceId);const prior=(await client.query(`SELECT * FROM automation_policies
  WHERE workspace_id=$1 AND enabled=1 AND approved_at IS NOT NULL AND disabled_at IS NULL ORDER BY version DESC`,[ctx.workspaceId])).rows
  .find((row)=>parse(row.allowed_action_types,[]).includes(input.action));const at=nowIso();
  if(prior)await client.query(`UPDATE automation_policies SET enabled=0,disabled_at=$2,disabled_by_user_id=$3,
    updated_at=$2 WHERE workspace_id=$1 AND id=$4`,[ctx.workspaceId,at,ctx.actorId,prior.id]);
  if(!input.enabled)return null;
  const body={allowedActionTypes:[input.action],locationScope:input.locationScope||[],supplierScope:input.supplierScope||[],
    conditions:input.conditions||[],thresholds:input.thresholds||{},maximumQuantity:input.maximumQuantity??null,
    maximumValue:input.maximumValue??null,dailyLimit:input.dailyLimit??null};const id=newId('apol');
  await client.query(`INSERT INTO automation_policies(id,workspace_id,name,description,enabled,allowed_action_types,scope,item_scope,
    location_scope,supplier_scope,exclusions,conditions,thresholds,maximum_quantity,maximum_value,daily_limit,approval_rules,version,
    supersedes_policy_id,integrity_hash,created_by_user_id,approved_by_user_id,approved_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,1,$5,'{}','[]',$6,$7,'[]',$8,$9,$10,$11,$12,'{}',$13,$14,$15,$16,$16,$17,$17,$17)`,
  [id,ctx.workspaceId,input.name,input.description||null,JSON.stringify(body.allowedActionTypes),JSON.stringify(body.locationScope),
    JSON.stringify(body.supplierScope),JSON.stringify(body.conditions),JSON.stringify(body.thresholds),body.maximumQuantity,
    body.maximumValue,body.dailyLimit,Number(prior?.version||0)+1,prior?.id||null,hash(body),ctx.actorId,at]);return id;}

async function configureRoutine(database,ctx,membership,input){assertAdmin(membership);
  const transferEnabled=['1','on',true].includes(input.transferEnabled);const purchaseEnabled=['1','on',true].includes(input.purchaseEnabled);
  const locationScope=[...new Set((Array.isArray(input.locationIds)?input.locationIds:input.locationIds?[input.locationIds]:[]).map(String))];
  const supplierScope=[...new Set((Array.isArray(input.supplierIds)?input.supplierIds:input.supplierIds?[input.supplierIds]:[]).map(String))];
  const maximumQuantity=transferEnabled?integer(input.maximumQuantity,'Transfer limit',{minimum:1,maximum:100000}):null;
  const maximumValue=purchaseEnabled?money(input.maximumValue,'Purchase-order limit'):null;
  const weeklyValue=purchaseEnabled?money(input.weeklyValue,'Seven-day purchasing limit'):null;
  if(purchaseEnabled&&!supplierScope.length)throw new ValidationError('Choose at least one usual supplier for automatic purchasing.');
  return database.transaction(async(client)=>{if(locationScope.length){const found=await client.query(`SELECT id FROM locations
      WHERE workspace_id=$1 AND id=ANY($2::text[]) AND is_active=1`,[ctx.workspaceId,locationScope]);
      if(found.rows.length!==locationScope.length)throw new ValidationError('One selected location is unavailable.');}
    if(supplierScope.length){const found=await client.query(`SELECT id FROM suppliers WHERE workspace_id=$1
      AND id=ANY($2::text[]) AND status='active'`,[ctx.workspaceId,supplierScope]);
      if(found.rows.length!==supplierScope.length)throw new ValidationError('One selected supplier is unavailable.');}
    const transferId=await replacePolicy(client,ctx,{enabled:transferEnabled,action:ACTIONS.TRANSFER,name:'Routine stock balancing',
      description:'Move stock between approved locations when one can safely spare what another needs.',locationScope,
      conditions:['destination_stockout_risk','source_above_safety','no_conflicting_transfer'],maximumQuantity});
    const purchaseId=await replacePolicy(client,ctx,{enabled:purchaseEnabled,action:ACTIONS.PURCHASE,name:'Routine replenishment',
      description:'Approve supplier orders inside supplier, per-order and rolling seven-day limits.',supplierScope,
      conditions:['replenishment_evidence','moq_order_multiple_compliant','no_duplicate_incoming_demand','price_within_policy'],
      maximumValue,thresholds:{maxValuePerWeek:weeklyValue}});
    if(transferEnabled||purchaseEnabled)await client.query(`UPDATE workspace_autopilot SET mode='POLICY_AUTOMATED',updated_at=$2
      WHERE workspace_id=$1`,[ctx.workspaceId,nowIso()]);return {transferId,purchaseId};},{isolation:'SERIALIZABLE'});}

async function planningRows(database,workspaceId){return (await database.query(`WITH committed AS (
    SELECT sol.sku_id,a.location_id,SUM(a.quantity) AS quantity FROM sales_order_allocations a JOIN sales_order_lines sol
      ON sol.id=a.sales_order_line_id AND sol.workspace_id=a.workspace_id WHERE a.workspace_id=$1 GROUP BY sol.sku_id,a.location_id
  ), purchase_incoming AS (SELECT pol.sku_id,COALESCE(pol.destination_location_id,po.destination_location_id) AS location_id,
      SUM(pol.quantity_units-pol.quantity_received_units) AS quantity FROM purchase_order_lines pol JOIN purchase_orders po
      ON po.id=pol.purchase_order_id WHERE pol.workspace_id=$1 AND po.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED')
      GROUP BY pol.sku_id,COALESCE(pol.destination_location_id,po.destination_location_id)),
  transfer_incoming AS (SELECT tl.sku_id,t.destination_location_id AS location_id,
      SUM(CASE t.status WHEN 'REQUESTED' THEN tl.requested_quantity WHEN 'APPROVED' THEN tl.approved_quantity
        WHEN 'PICKED' THEN tl.picked_quantity
        ELSE tl.shipped_quantity-tl.received_quantity-tl.lost_quantity-tl.damaged_quantity END) AS quantity
      FROM inventory_transfer_lines tl JOIN inventory_transfers t ON t.id=tl.transfer_id
      WHERE tl.workspace_id=$1 AND t.status IN ('REQUESTED','APPROVED','PICKED','SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED')
      GROUP BY tl.sku_id,t.destination_location_id),
  incoming AS (SELECT sku_id,location_id,SUM(quantity) AS quantity FROM (
      SELECT * FROM purchase_incoming UNION ALL SELECT * FROM transfer_incoming
    ) sources GROUP BY sku_id,location_id),
  demand AS (SELECT sku_id,location_id,COUNT(*) AS issue_events,SUM(-quantity_delta) AS issued FROM movements
      WHERE workspace_id=$1 AND operation='issue' AND quantity_delta<0 AND occurred_at >= (CURRENT_TIMESTAMP-INTERVAL '30 days')::text
      GROUP BY sku_id,location_id)
  SELECT s.id AS sku_id,s.code,s.variant_label,i.name AS item_name,i.tracking_mode,l.id AS location_id,l.name AS location_name,
    COALESCE(b.on_hand,0)::bigint AS on_hand,COALESCE(c.quantity,0)::bigint AS committed,COALESCE(inc.quantity,0)::bigint AS incoming,
    COALESCE(d.issue_events,0)::bigint AS issue_events,COALESCE(d.issued,0)::bigint AS issued,rp.reorder_point,rp.target_stock,
    rp.safety_stock,rp.default_order_quantity,rp.preferred_supplier_id,rp.lead_time_days
  FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id CROSS JOIN locations l
  LEFT JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id AND b.location_id=l.id
  LEFT JOIN committed c ON c.sku_id=s.id AND c.location_id=l.id LEFT JOIN incoming inc ON inc.sku_id=s.id AND inc.location_id=l.id
  LEFT JOIN demand d ON d.sku_id=s.id AND d.location_id=l.id LEFT JOIN LATERAL (SELECT * FROM reorder_policies p
    WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id AND (p.location_id=l.id OR p.location_id IS NULL)
    ORDER BY (p.location_id IS NOT NULL) DESC LIMIT 1) rp ON true
  WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND l.workspace_id=$1 AND l.is_active=1 ORDER BY s.id,l.id`,[workspaceId])).rows;}

function position(row){const available=Number(row.on_hand)-Number(row.committed);const rate=Number(row.issued)/30;
  const lead=Number(row.lead_time_days||14);const safety=row.safety_stock===null?Math.ceil(rate*7):Number(row.safety_stock);
  const reorder=row.reorder_point===null?(Number(row.issue_events)>=2?Math.ceil(rate*lead)+safety:null):Number(row.reorder_point);
  const target=row.target_stock===null?(reorder===null?null:Math.max(reorder+safety,Math.ceil(rate*30))):Number(row.target_stock);
  return {...row,onHand:Number(row.on_hand),committed:Number(row.committed),available,incoming:Number(row.incoming),
    issueEvents:Number(row.issue_events),issued:Number(row.issued),rate,safety,reorder,target,projected:available+Number(row.incoming)};}

async function supplierChoice(database,workspaceId,shortage){const result=await database.query(`SELECT si.*,s.name AS supplier_name,
    s.currency,s.minimum_order_amount,COALESCE(si.lead_time_days,s.default_lead_time_days,30) AS effective_lead
  FROM supplier_items si JOIN suppliers s ON s.id=si.supplier_id AND s.workspace_id=si.workspace_id
  WHERE si.workspace_id=$1 AND si.sku_id=$2 AND si.is_active=1 AND s.status='active'
    AND ($3::text IS NULL OR si.supplier_id=$3) ORDER BY si.is_preferred DESC,COALESCE(si.last_unit_cost,1e100),effective_lead,si.id`,
  [workspaceId,shortage.sku_id,shortage.preferred_supplier_id]);const selected=result.rows[0];if(!selected)return null;
  const unitsPer=Number(selected.units_per_purchase_unit||1);let purchaseUnits=Math.ceil((shortage.default_order_quantity||shortage.needed)/unitsPer);
  purchaseUnits=Math.max(purchaseUnits,Number(selected.minimum_order_quantity||1));const multiple=Number(selected.order_multiple||1);
  purchaseUnits=Math.ceil(purchaseUnits/multiple)*multiple;const quantity=purchaseUnits*unitsPer;
  const unitCost=selected.last_unit_cost===null?null:Number(selected.last_unit_cost);
  return {...selected,unitsPer,purchaseUnits,quantity,unitCost,value:unitCost===null?null:Math.round(unitCost*quantity*100)/100};}

async function evaluate(database,workspaceId,candidate,state){if(state.mode===MODES.OBSERVE)
  return {decision:'needs_approval',reason:'StockChief is set to watch only.',policy:null};
  if(state.paused)return {decision:'refused',reason:state.pausedReason||'StockChief is paused.',policy:null};
  if(state.suspended)return {decision:'refused',reason:state.suspendedReason||'Automatic work is suspended.',policy:null};
  if(state.mode!==MODES.POLICY_AUTOMATED)return {decision:'needs_approval',reason:'This inventory is set to ask before consequential work.',policy:null};
  const action=candidate.type==='transfer'?ACTIONS.TRANSFER:ACTIONS.PURCHASE;const policy=await activePolicy(database,workspaceId,action);
  if(!policy)return {decision:'needs_approval',reason:'No approved standing authority covers this action.',policy:null};
  if(candidate.type==='transfer'){
    if(policy.locationScope.length&&(!policy.locationScope.includes(candidate.sourceLocationId)||!policy.locationScope.includes(candidate.destinationLocationId)))
      return {decision:'needs_approval',reason:'The transfer uses a location outside the approved scope.',policy};
    if(candidate.quantity>policy.maximumQuantity)return {decision:'needs_approval',reason:`The transfer needs ${candidate.quantity} units; the approved limit is ${policy.maximumQuantity}.`,policy};
  }else{if(!policy.supplierScope.includes(candidate.supplierId))return {decision:'needs_approval',reason:'The selected supplier is outside the approved scope.',policy};
    if(candidate.value===null)return {decision:'needs_approval',reason:'The supplier price is missing, so value authority cannot be checked.',policy};
    if(candidate.value>policy.maximumValue)return {decision:'needs_approval',reason:`The order is $${candidate.value.toFixed(2)}; the approved limit is $${policy.maximumValue.toFixed(2)}.`,policy};
    const since=new Date(Date.now()-7*86400000).toISOString();const spent=Number((await database.query(`SELECT COALESCE(SUM((outcome::jsonb->>'value')::numeric),0) AS total
      FROM work_items WHERE workspace_id=$1 AND category='replenishment_plan' AND execution_status='COMPLETED'
      AND approval_requirement='NONE' AND completed_at>=$2`,[workspaceId,since])).rows[0].total||0);
    if(spent+candidate.value>Number(policy.thresholds.maxValuePerWeek||0))return {decision:'needs_approval',reason:'This order would exceed the approved rolling seven-day purchasing limit.',policy};}
  return {decision:'authorized',reason:`Approved policy “${policy.name}” covers this exact action and its limits.`,policy};}

function workFrom(row){return {...row,sourceEvidence:parse(row.source_evidence,[]),affectedEntities:parse(row.affected_entities,{}),
  recommendedAction:parse(row.recommended_action,{}),policyEvaluation:parse(row.policy_evaluation,{}),
  movementIds:parse(row.movement_ids,[]),outcome:parse(row.outcome,{})};}
async function getWork(database,workspaceId,id){const row=(await database.query('SELECT * FROM work_items WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That prepared work is not in this inventory.');return workFrom(row);}
async function insertWork(database,workspaceId,candidate,evaluation){const key=`autopilot:${hash({candidate,balance:candidate.destinationAvailable,incoming:candidate.incoming}).slice(0,40)}`;
  const existing=(await database.query('SELECT * FROM work_items WHERE workspace_id=$1 AND idempotency_key=$2',[workspaceId,key])).rows[0];
  if(existing)return {item:workFrom(existing),created:false};const id=newId('wi');const at=nowIso();const automatic=evaluation.decision==='authorized';
  const category=candidate.type==='transfer'?'stock_transfer':'replenishment_plan';
  await database.query(`INSERT INTO work_items(id,workspace_id,category,source,source_evidence,affected_entities,recommended_action,
    priority,urgency,confidence,policy_id,policy_evaluation,approval_requirement,execution_status,verification_status,movement_ids,
    idempotency_key,outcome,attempts,created_at) VALUES($1,$2,$3,'postgres_autopilot',$4,$5,$6,$7,$8,'high',$9,$10,$11,$12,'PENDING','[]',$13,'{}',0,$14)`,
  [id,workspaceId,category,JSON.stringify(candidate.evidence),JSON.stringify({skuId:candidate.skuId,displayName:candidate.displayName}),
    JSON.stringify(candidate),candidate.priority,candidate.urgency,evaluation.policy?.id||null,
    JSON.stringify({decision:evaluation.decision,reason:evaluation.reason,policyVersion:evaluation.policy?.version||null,
      policyHash:evaluation.policy?.integrityHash||null}),automatic?'NONE':'REQUIRED',automatic?STATUSES.AUTHORIZED:STATUSES.WAITING,key,at]);
  await database.query(`INSERT INTO work_item_events(id,workspace_id,work_item_id,event,detail,created_at)
    VALUES($1,$2,$3,'planned',$4,$5)`,[newId('wievt'),workspaceId,id,JSON.stringify({automatic,reason:evaluation.reason}),at]);
  return {item:await getWork(database,workspaceId,id),created:true};}

async function plan(database,workspaceId){const state=await ensure(database,workspaceId);const rows=(await planningRows(database,workspaceId)).map(position);
  const bySku=new Map();for(const row of rows){if(!bySku.has(row.sku_id))bySku.set(row.sku_id,[]);bySku.get(row.sku_id).push(row);}
  const created=[];const considered=[];
  for(const locations of bySku.values()){for(const shortage of locations.filter((row)=>row.reorder!==null&&row.projected<=row.reorder)){
    const needed=Math.max(1,(shortage.target??shortage.reorder)-shortage.projected);
    const source=locations.filter((row)=>row.location_id!==shortage.location_id&&row.available>row.safety)
      .map((row)=>({...row,spare:row.available-row.safety})).filter((row)=>row.spare>0).sort((a,b)=>b.spare-a.spare)[0];let candidate;
    if(source&&shortage.tracking_mode==='quantity'){const quantity=Math.min(needed,source.spare);
      candidate={type:'transfer',skuId:shortage.sku_id,displayName:`${shortage.item_name}${shortage.variant_label?` — ${shortage.variant_label}`:''}`,
        code:shortage.code,quantity,sourceLocationId:source.location_id,sourceLocationName:source.location_name,
        destinationLocationId:shortage.location_id,destinationLocationName:shortage.location_name,destinationAvailable:shortage.available,
        incoming:shortage.incoming,reorderPoint:shortage.reorder,targetStock:shortage.target,sourceAvailable:source.available,
        sourceSafety:source.safety,priority:90,urgency:shortage.available<=0?'immediate':'soon',evidence:[
          {fact:'destination_available',value:shortage.available},{fact:'destination_reorder_point',value:shortage.reorder},
          {fact:'source_available',value:source.available},{fact:'source_safety_stock',value:source.safety}]};
    }else{const supplier=await supplierChoice(database,workspaceId,{...shortage,needed});if(!supplier){considered.push({skuId:shortage.sku_id,reason:'no_supplier'});continue;}
      candidate={type:'purchase',skuId:shortage.sku_id,displayName:`${shortage.item_name}${shortage.variant_label?` — ${shortage.variant_label}`:''}`,
        code:shortage.code,quantity:supplier.quantity,purchaseUnits:supplier.purchaseUnits,unitsPerPurchaseUnit:supplier.unitsPer,
        supplierId:supplier.supplier_id,supplierName:supplier.supplier_name,supplierSku:supplier.supplier_sku,
        destinationLocationId:shortage.location_id,destinationLocationName:shortage.location_name,unitCost:supplier.unitCost,
        value:supplier.value,currency:supplier.currency||'USD',destinationAvailable:shortage.available,incoming:shortage.incoming,
        reorderPoint:shortage.reorder,targetStock:shortage.target,priority:88,urgency:shortage.available<=0?'immediate':'soon',evidence:[
          {fact:'available',value:shortage.available},{fact:'incoming',value:shortage.incoming},{fact:'reorder_point',value:shortage.reorder},
          {fact:'supplier_pack',value:supplier.unitsPer},{fact:'supplier_minimum_purchase_units',value:Number(supplier.minimum_order_quantity||1)}]};}
    considered.push(candidate);const evaluation=await evaluate(database,workspaceId,candidate,state);if(evaluation.decision==='refused')continue;
    const stored=await insertWork(database,workspaceId,candidate,evaluation);if(stored.created)created.push(stored.item);
  }}await database.query(`UPDATE workspace_autopilot SET last_evaluated_at=$2,next_evaluation_at=$3,updated_at=$2 WHERE workspace_id=$1`,
    [workspaceId,nowIso(),new Date(Date.now()+15*60000).toISOString()]);return {state,created,considered};}

async function revalidate(database,workspaceId,action){
  if(action.type==='transfer'){
    const result=await database.query(`WITH committed AS (SELECT a.location_id,SUM(a.quantity) AS quantity
      FROM sales_order_allocations a JOIN sales_order_lines sol ON sol.id=a.sales_order_line_id
      WHERE a.workspace_id=$1 AND sol.sku_id=$2 GROUP BY a.location_id)
      SELECT l.id,COALESCE(b.on_hand,0)-COALESCE(c.quantity,0) AS available FROM locations l
      LEFT JOIN balances b ON b.workspace_id=l.workspace_id AND b.location_id=l.id AND b.sku_id=$2
      LEFT JOIN committed c ON c.location_id=l.id WHERE l.workspace_id=$1 AND l.id=ANY($3::text[]) FOR SHARE OF l`,
    [workspaceId,action.skuId,[action.sourceLocationId,action.destinationLocationId]]);
    const balances=Object.fromEntries(result.rows.map((row)=>[row.id,Number(row.available)]));
    if((balances[action.sourceLocationId]??0)-action.quantity<Number(action.sourceSafety||0))
      throw new ValidationError('The source can no longer spare this transfer while keeping its safety stock. StockChief did nothing.');
    if((balances[action.destinationLocationId]??0)>Number(action.reorderPoint))
      throw new ValidationError('The destination is no longer below its reorder point. StockChief did nothing.');
    const openTransfer=Number((await database.query(`SELECT COALESCE(SUM(CASE t.status
        WHEN 'REQUESTED' THEN tl.requested_quantity WHEN 'APPROVED' THEN tl.approved_quantity
        WHEN 'PICKED' THEN tl.picked_quantity
        ELSE tl.shipped_quantity-tl.received_quantity-tl.lost_quantity-tl.damaged_quantity END),0) AS quantity
      FROM inventory_transfer_lines tl JOIN inventory_transfers t ON t.id=tl.transfer_id
      WHERE tl.workspace_id=$1 AND tl.sku_id=$2 AND t.destination_location_id=$3
        AND t.status IN ('REQUESTED','APPROVED','PICKED','SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED')`,
    [workspaceId,action.skuId,action.destinationLocationId])).rows[0].quantity||0);
    if(openTransfer>0)throw new ValidationError('An open transfer already covers this destination. StockChief did not prepare another one.');
    return;
  }
  const incoming=Number((await database.query(`SELECT COALESCE(SUM(pol.quantity_units-pol.quantity_received_units),0) AS quantity
    FROM purchase_order_lines pol JOIN purchase_orders po ON po.id=pol.purchase_order_id
    WHERE pol.workspace_id=$1 AND pol.sku_id=$2 AND COALESCE(pol.destination_location_id,po.destination_location_id)=$3
      AND po.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED')`,
  [workspaceId,action.skuId,action.destinationLocationId])).rows[0].quantity||0);
  if(incoming>Number(action.incoming||0))throw new ValidationError('New incoming stock now covers this need. StockChief did not order twice.');
}

async function execute(database,ctx,workId,{approvedBy=null}={}){
  return database.transaction(async(client)=>{const scoped=scopedDatabase(client);const item=await getWork(scoped,ctx.workspaceId,workId);
  if(item.execution_status===STATUSES.COMPLETED)return item;if(![STATUSES.AUTHORIZED,STATUSES.WAITING].includes(item.execution_status))
    throw new ValidationError('That work is not ready to execute.');if(item.approval_requirement!=='NONE'&&!approvedBy)
    throw new ValidationError('This work needs a person to approve it.');
  if(item.approval_requirement==='NONE'){
    const currentState=await getState(scoped,ctx.workspaceId);const currentEvaluation=await evaluate(scoped,ctx.workspaceId,item.recommendedAction,currentState);
    if(currentEvaluation.decision!=='authorized'||currentEvaluation.policy?.id!==item.policy_id||
      currentEvaluation.policy?.integrityHash!==item.policyEvaluation.policyHash){
      await client.query(`UPDATE work_items SET approval_requirement='REQUIRED',execution_status='WAITING_FOR_APPROVAL',
        policy_evaluation=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,item.id,JSON.stringify(currentEvaluation)]);
      return getWork(scoped,ctx.workspaceId,item.id);
    }
  }
  await revalidate(scoped,ctx.workspaceId,item.recommendedAction);const at=nowIso();
  await client.query(`UPDATE work_items SET execution_status='EXECUTING',approved_by_user_id=COALESCE(approved_by_user_id,$3),
    approved_at=COALESCE(approved_at,$4),attempts=attempts+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,workId,approvedBy,at]);
  const action=item.recommendedAction;let result;if(action.type==='transfer'){
      const requested=await transfers.requestInTransaction(client,ctx,{fromLocationId:action.sourceLocationId,
        toLocationId:action.destinationLocationId,reference:`AUTO-${item.id}`,
        notes:`StockChief: ${item.policyEvaluation.reason}`,idempotencyKey:`work:${item.id}:transfer-request`,
        decisionDetail:{workItemId:item.id,policyEvaluation:item.policyEvaluation},
        lines:[{skuId:action.skuId,quantity:action.quantity}]});
      const approved=await transfers.approveInTransaction(client,ctx,requested.id,
        {idempotencyKey:`work:${item.id}:transfer-approve`});
      result={kind:'transfer',transferId:approved.id,transferNumber:approved.transfer_number,
        status:approved.status,quantity:action.quantity,verified:true,physicalExecutionPending:true};
    }else{const purchase=await workflows.createPurchaseOrder(scoped,ctx,{supplierId:action.supplierId,
      destinationLocationId:action.destinationLocationId,currency:action.currency,source:'foundry_recommendation',
      sourceDetail:{workItemId:item.id,evidence:item.sourceEvidence},lines:[{skuId:action.skuId,quantityUnits:action.quantity,
        quantityPurchaseUnits:action.purchaseUnits,unitsPerPurchaseUnit:action.unitsPerPurchaseUnit,unitCost:action.unitCost,
        destinationLocationId:action.destinationLocationId,supplierSku:action.supplierSku}],idempotencyKey:`work:${item.id}:po`});
      const approved=await workflows.approvePurchaseOrder(scoped,ctx,purchase.purchaseOrderId,{idempotencyKey:`work:${item.id}:approve-po`});
      result={kind:'purchase',purchaseOrderId:purchase.purchaseOrderId,poNumber:purchase.poNumber,status:approved.status,value:action.value,verified:true};}
    await client.query(`UPDATE work_items SET execution_status='COMPLETED',verification_status='VERIFIED',movement_ids=$3,
      purchase_order_id=$4,outcome=$5,error_message=NULL,completed_at=$6 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,item.id,JSON.stringify(result.movementIds||[]),result.purchaseOrderId||null,JSON.stringify(result),nowIso()]);
    await client.query(`INSERT INTO work_item_events(id,workspace_id,work_item_id,event,detail,actor_user_id,created_at)
      VALUES($1,$2,$3,'completed',$4,$5,$6)`,[newId('wievt'),ctx.workspaceId,item.id,JSON.stringify(result),ctx.actorId,nowIso()]);
    return getWork(scoped,ctx.workspaceId,item.id);},{isolation:'SERIALIZABLE',retrySafe:true});}

async function run(database,ctx){const planned=await plan(database,ctx.workspaceId);let executed=0;
  for(const item of planned.created.filter((entry)=>entry.approval_requirement==='NONE')){
    const completed=await execute(database,ctx,item.id);if(completed.execution_status===STATUSES.COMPLETED)executed+=1;
  }
  return {planned:planned.created.length,executed,waiting:planned.created.length-executed,considered:planned.considered.length};}
async function approve(database,ctx,membership,id){assertOperate(membership);return execute(database,ctx,id,{approvedBy:ctx.actorId});}
async function cancel(database,ctx,membership,id){assertOperate(membership);const item=await getWork(database,ctx.workspaceId,id);
  if([STATUSES.COMPLETED,STATUSES.FAILED].includes(item.execution_status))throw new ValidationError('Completed work cannot be discarded.');
  await database.query(`UPDATE work_items SET execution_status='CANCELLED',completed_at=$3 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,id,nowIso()]);return getWork(database,ctx.workspaceId,id);}

async function dashboard(database,workspaceId){const [state,policies,locations,suppliers,recent]=await Promise.all([
  ensure(database,workspaceId),listPolicies(database,workspaceId),
  database.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 ORDER BY name`,[workspaceId]),
  database.query(`SELECT id,name FROM suppliers WHERE workspace_id=$1 AND status='active' ORDER BY name`,[workspaceId]),
  database.query(`SELECT * FROM work_items WHERE workspace_id=$1 AND source='postgres_autopilot' ORDER BY created_at DESC,id DESC LIMIT 30`,[workspaceId])]);
  return {state,policies,locations:locations.rows,suppliers:suppliers.rows,recent:recent.rows.map(workFrom),
    transferPolicy:policies.find((policy)=>policy.active&&policy.actions.includes(ACTIONS.TRANSFER))||null,
    purchasePolicy:policies.find((policy)=>policy.active&&policy.actions.includes(ACTIONS.PURCHASE))||null};}

module.exports={MODES,ACTIONS,STATUSES,ensure,getState,setMode,pause,resume,configureRoutine,replacePolicy,listPolicies,dashboard,plan,run,
  getWork,approve,cancel,execute,evaluate,revalidate};

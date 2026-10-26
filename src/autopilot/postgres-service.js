'use strict';

const crypto = require('node:crypto');
const { newId, nowIso } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const capabilityDefinitions = require('./capabilities');
const transfers = require('../transfers/postgres-transfer-service');
const workflows = require('../operations/postgres-business-workflows');
const outboundMail=require('../connections/postgres-outbound-mail');
const commercial=require('../commercial/service');
const entitlements=require('../entitlements/postgres-service');

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
async function getState(database,workspaceId){
  // Reading a new workspace must not initialize automation or require INSERT
  // privileges. Write paths still call ensure() before changing persisted state.
  const row=(await database.query(`SELECT a.*,w.id AS workspace_id FROM workspaces w
    LEFT JOIN workspace_autopilot a ON a.workspace_id=w.id WHERE w.id=$1`,[workspaceId])).rows[0];
  if(!row)throw new NotFoundError('That inventory could not be found.');
  return stateFrom({...row,mode:row.mode||MODES.SUPERVISED,paused:row.paused??0,suspended:row.suspended??0});
}

async function setMode(database,ctx,membership,mode){if(!Object.values(MODES).includes(mode))
  throw new ValidationError('Choose watch only, ask first, or bounded automatic work.');
  if(mode==='POLICY_AUTOMATED')await require('../commercial/enforcement').workspace(database,ctx.workspaceId,'authority.advanced');
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

async function listCapabilities(database,workspaceId){const rows=(await database.query(
  'SELECT capability,granted,updated_at FROM autopilot_capabilities WHERE workspace_id=$1',[workspaceId])).rows;
  const current=new Map(rows.map((row)=>[row.capability,row]));return capabilityDefinitions.NAMES.map((capability)=>({
    capability,...capabilityDefinitions.CAPABILITIES[capability],granted:Boolean(Number(current.get(capability)?.granted)),
    updatedAt:current.get(capability)?.updated_at||null}));}

async function setCapability(database,ctx,membership,capability,granted){if(!capabilityDefinitions.CAPABILITIES[capability])
  throw new ValidationError(`There is no StockChief job called "${capability}".`);
  if(granted)assertAdmin(membership);else assertOperate(membership);const at=nowIso();
  await database.query(`INSERT INTO autopilot_capabilities
    (workspace_id,capability,granted,granted_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)
    ON CONFLICT(workspace_id,capability) DO UPDATE SET granted=EXCLUDED.granted,
      granted_by_user_id=EXCLUDED.granted_by_user_id,updated_at=EXCLUDED.updated_at`,
  [ctx.workspaceId,capability,granted?1:0,ctx.actorId,at]);return listCapabilities(database,ctx.workspaceId);}

async function capabilityMay(database,workspaceId,capability){if(!capabilityDefinitions.CAPABILITIES[capability])
  throw new ValidationError(`There is no StockChief job called "${capability}".`);const state=await getState(database,workspaceId);
  if(state.paused)return {allowed:false,because:'StockChief is paused.'};
  if(state.suspended)return {allowed:false,because:'StockChief has stopped itself and is waiting to be looked at.'};
  if(state.mode==='OBSERVE')return {allowed:false,because:'StockChief is set to watch only.'};
  if(!capabilityDefinitions.modeAllows(capability,state.mode))return {allowed:false,because:'StockChief is set to ask before acting.'};
  const row=(await database.query(`SELECT granted FROM autopilot_capabilities
    WHERE workspace_id=$1 AND capability=$2`,[workspaceId,capability])).rows[0];
  return Number(row?.granted)===1?{allowed:true,because:null}:{allowed:false,
    because:`Nobody has authorised StockChief to ${capabilityDefinitions.CAPABILITIES[capability].label.toLowerCase()} on its own.`};}

async function supplierDeliveryReadiness(database,workspaceId,supplierId){
  const supplier=(await database.query(`SELECT id,name,email,contact_name,watched_connector_id FROM suppliers
    WHERE workspace_id=$1 AND id=$2 AND status='active'`,[workspaceId,supplierId])).rows[0];
  if(!supplier||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(supplier.email||'')))return {ready:false,
    reason:'The selected supplier has no verified order email address.'};
  const mailboxes=await outboundMail.mailboxes(database,workspaceId);let mailbox=null;
  if(supplier.watched_connector_id)mailbox=mailboxes.find((entry)=>entry.id===supplier.watched_connector_id)||null;
  else if(mailboxes.length===1)mailbox=mailboxes[0];
  if(!mailbox)return {ready:false,reason:mailboxes.length>1
    ?'Choose the supplier’s sending mailbox before automatic purchasing.'
    :'Connect one active supplier mailbox before automatic purchasing.'};
  return {ready:true,supplier,mailbox};
}

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
    const at=nowIso();for(const [capability,granted] of [['inventory_transfers',transferEnabled],['replenishment',purchaseEnabled]])
      await client.query(`INSERT INTO autopilot_capabilities
        (workspace_id,capability,granted,granted_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)
        ON CONFLICT(workspace_id,capability) DO UPDATE SET granted=EXCLUDED.granted,
          granted_by_user_id=EXCLUDED.granted_by_user_id,updated_at=EXCLUDED.updated_at`,
      [ctx.workspaceId,capability,granted?1:0,ctx.actorId,at]);
    if(transferEnabled||purchaseEnabled)await client.query(`UPDATE workspace_autopilot SET mode='POLICY_AUTOMATED',updated_at=$2
      WHERE workspace_id=$1`,[ctx.workspaceId,nowIso()]);return {transferId,purchaseId};},{isolation:'SERIALIZABLE'});}

async function planningRows(database,workspaceId,{afterSkuId=null,limitSkus=null}={}){return (await database.query(`WITH demand_eligible AS (
 SELECT sku_id FROM movements WHERE workspace_id=$1 AND operation='issue' AND quantity_delta<0
 AND occurred_at >= (CURRENT_TIMESTAMP-INTERVAL '30 days')::text GROUP BY sku_id,location_id HAVING count(*)>=2),
 eligible_skus AS MATERIALIZED (SELECT sku_id FROM reorder_policies WHERE workspace_id=$1
  UNION SELECT sku_id FROM demand_eligible),
 selected_skus AS MATERIALIZED (SELECT s.id FROM eligible_skus e JOIN skus s ON s.id=e.sku_id AND s.workspace_id=$1
  JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.is_active=1 AND i.is_active=1
  AND ($2::text IS NULL OR s.id>$2) ORDER BY s.id LIMIT $3), committed AS (
    SELECT sol.sku_id,a.location_id,SUM(a.quantity) AS quantity FROM sales_order_allocations a JOIN sales_order_lines sol
      ON sol.id=a.sales_order_line_id AND sol.workspace_id=a.workspace_id WHERE a.workspace_id=$1 AND sol.sku_id IN (SELECT id FROM selected_skus) GROUP BY sol.sku_id,a.location_id
  ), purchase_incoming AS (SELECT pol.sku_id,COALESCE(pol.destination_location_id,po.destination_location_id) AS location_id,
      SUM(pol.quantity_units-pol.quantity_received_units) AS quantity FROM purchase_order_lines pol JOIN purchase_orders po
      ON po.id=pol.purchase_order_id WHERE pol.workspace_id=$1 AND pol.sku_id IN (SELECT id FROM selected_skus) AND po.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED')
      GROUP BY pol.sku_id,COALESCE(pol.destination_location_id,po.destination_location_id)),
  transfer_incoming AS (SELECT tl.sku_id,t.destination_location_id AS location_id,
      SUM(CASE t.status WHEN 'REQUESTED' THEN tl.requested_quantity WHEN 'APPROVED' THEN tl.approved_quantity
        WHEN 'PICKED' THEN tl.picked_quantity
        ELSE tl.shipped_quantity-tl.received_quantity-tl.lost_quantity-tl.damaged_quantity END) AS quantity
      FROM inventory_transfer_lines tl JOIN inventory_transfers t ON t.id=tl.transfer_id
      WHERE tl.workspace_id=$1 AND tl.sku_id IN (SELECT id FROM selected_skus) AND t.status IN ('REQUESTED','APPROVED','PICKED','SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED')
      GROUP BY tl.sku_id,t.destination_location_id),
  incoming AS (SELECT sku_id,location_id,SUM(quantity) AS quantity FROM (
      SELECT * FROM purchase_incoming UNION ALL SELECT * FROM transfer_incoming
    ) sources GROUP BY sku_id,location_id),
  demand AS (SELECT sku_id,location_id,COUNT(*) AS issue_events,SUM(-quantity_delta) AS issued FROM movements
      WHERE workspace_id=$1 AND sku_id IN (SELECT id FROM selected_skus) AND operation='issue' AND quantity_delta<0 AND occurred_at >= (CURRENT_TIMESTAMP-INTERVAL '30 days')::text
      GROUP BY sku_id,location_id)
  SELECT s.id AS sku_id,s.code,s.variant_label,i.name AS item_name,i.tracking_mode,l.id AS location_id,l.name AS location_name,
    COALESCE(b.on_hand,0)::bigint AS on_hand,COALESCE(c.quantity,0)::bigint AS committed,COALESCE(inc.quantity,0)::bigint AS incoming,
    COALESCE(d.issue_events,0)::bigint AS issue_events,COALESCE(d.issued,0)::bigint AS issued,rp.reorder_point,rp.target_stock,
    rp.safety_stock,rp.default_order_quantity,rp.preferred_supplier_id,rp.lead_time_days
  FROM selected_skus selected JOIN skus s ON s.id=selected.id AND s.workspace_id=$1
  JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id CROSS JOIN locations l
  LEFT JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id AND b.location_id=l.id
  LEFT JOIN committed c ON c.sku_id=s.id AND c.location_id=l.id LEFT JOIN incoming inc ON inc.sku_id=s.id AND inc.location_id=l.id
  LEFT JOIN demand d ON d.sku_id=s.id AND d.location_id=l.id LEFT JOIN LATERAL (SELECT * FROM reorder_policies p
    WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id AND (p.location_id=l.id OR p.location_id IS NULL)
    ORDER BY (p.location_id IS NOT NULL) DESC LIMIT 1) rp ON true
  WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND l.workspace_id=$1 AND l.is_active=1 ORDER BY s.id,l.id`,[workspaceId,afterSkuId,limitSkus===null?null:limitSkus+1])).rows;}

function position(row){const available=Number(row.on_hand)-Number(row.committed);const rate=Number(row.issued)/30;
  const lead=Number(row.lead_time_days||14);const safety=row.safety_stock===null?Math.ceil(rate*7):Number(row.safety_stock);
  const reorder=row.reorder_point===null?(Number(row.issue_events)>=2?Math.ceil(rate*lead)+safety:null):Number(row.reorder_point);
  const target=row.target_stock===null?(reorder===null?null:Math.max(reorder+safety,Math.ceil(rate*30))):Number(row.target_stock);
  return {...row,onHand:Number(row.on_hand),committed:Number(row.committed),available,incoming:Number(row.incoming),
    issueEvents:Number(row.issue_events),issued:Number(row.issued),rate,safety,reorder,target,projected:available+Number(row.incoming)};}

async function planningSuppliers(database,workspaceId,skuIds){
 if(!skuIds.length)return new Map();
 const rows=(await database.query(`SELECT si.*,s.name AS supplier_name,s.currency,s.minimum_order_amount,
  COALESCE(si.lead_time_days,s.default_lead_time_days,30) AS effective_lead
  FROM supplier_items si JOIN suppliers s ON s.id=si.supplier_id AND s.workspace_id=si.workspace_id
  WHERE si.workspace_id=$1 AND si.sku_id=ANY($2::text[]) AND si.is_active=1 AND s.status='active'
  ORDER BY si.sku_id,si.is_preferred DESC,COALESCE(si.last_unit_cost,1e100),effective_lead,si.id`,[workspaceId,skuIds])).rows;
 const bySku=new Map();for(const row of rows){if(!bySku.has(row.sku_id))bySku.set(row.sku_id,[]);bySku.get(row.sku_id).push(row);}return bySku;
}
async function supplierChoice(database,workspaceId,shortage,cached=null){const result=cached?{rows:(cached.get(shortage.sku_id)||[]).filter(row=>!shortage.preferred_supplier_id||row.supplier_id===shortage.preferred_supplier_id)}:await database.query(`SELECT si.*,s.name AS supplier_name,
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
  const capability=await capabilityMay(database,workspaceId,candidate.type==='transfer'?'inventory_transfers':'replenishment');
  if(!capability.allowed)return {decision:'needs_approval',reason:capability.because,policy:null};
  if(!policy)return {decision:'needs_approval',reason:'No approved standing authority covers this action.',policy:null};
  if(candidate.type==='transfer'){
    if(policy.locationScope.length&&(!policy.locationScope.includes(candidate.sourceLocationId)||!policy.locationScope.includes(candidate.destinationLocationId)))
      return {decision:'needs_approval',reason:'The transfer uses a location outside the approved scope.',policy};
    if(candidate.quantity>policy.maximumQuantity)return {decision:'needs_approval',reason:`The transfer needs ${candidate.quantity} units; the approved limit is ${policy.maximumQuantity}.`,policy};
  }else{if(!policy.supplierScope.includes(candidate.supplierId))return {decision:'needs_approval',reason:'The selected supplier is outside the approved scope.',policy};
    const supplierEmail=await capabilityMay(database,workspaceId,'supplier_emails');
    if(!supplierEmail.allowed)return {decision:'needs_approval',reason:supplierEmail.because,policy};
    const delivery=await supplierDeliveryReadiness(database,workspaceId,candidate.supplierId);
    if(!delivery.ready)return {decision:'needs_approval',reason:delivery.reason,policy};
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
async function persistPlannedWork(database,workspaceId,entries){
 const created=[];
 // Bound each SQL payload rather than performing four network round trips per
 // suggestion. The unique idempotency key and its audit event commit together.
 for(let offset=0;offset<entries.length;offset+=250){const batch=entries.slice(offset,offset+250).map(({candidate,evaluation})=>{
  const automatic=evaluation.decision==='authorized';return {id:newId('wi'),event_id:newId('wievt'),
   category:candidate.type==='transfer'?'stock_transfer':'replenishment_plan',source_evidence:candidate.evidence,
   affected_entities:{skuId:candidate.skuId,displayName:candidate.displayName},recommended_action:candidate,
   priority:candidate.priority,urgency:candidate.urgency,policy_id:evaluation.policy?.id||null,
   policy_evaluation:{decision:evaluation.decision,reason:evaluation.reason,policyVersion:evaluation.policy?.version||null,policyHash:evaluation.policy?.integrityHash||null},
   approval_requirement:automatic?'NONE':'REQUIRED',execution_status:automatic?STATUSES.AUTHORIZED:STATUSES.WAITING,
   idempotency_key:'autopilot:'+hash({candidate,balance:candidate.destinationAvailable,incoming:candidate.incoming}).slice(0,40),
   event_detail:{automatic,reason:evaluation.reason}};});
  const result=await database.query(`WITH supplied AS MATERIALIZED (SELECT * FROM jsonb_to_recordset($2::jsonb)
   AS d(id text,event_id text,category text,source_evidence jsonb,affected_entities jsonb,recommended_action jsonb,
    priority integer,urgency text,policy_id text,policy_evaluation jsonb,approval_requirement text,execution_status text,idempotency_key text,event_detail jsonb)),
   saved AS (INSERT INTO work_items(id,workspace_id,category,source,source_evidence,affected_entities,recommended_action,
    priority,urgency,confidence,policy_id,policy_evaluation,approval_requirement,execution_status,verification_status,movement_ids,idempotency_key,outcome,attempts,created_at)
    SELECT id,$1,category,'postgres_autopilot',source_evidence,affected_entities,recommended_action,priority,urgency,'high',policy_id,policy_evaluation,approval_requirement,execution_status,'PENDING','[]',idempotency_key,'{}',0,$3 FROM supplied
    ON CONFLICT DO NOTHING RETURNING *),
   events AS (INSERT INTO work_item_events(id,workspace_id,work_item_id,event,detail,created_at)
    SELECT d.event_id,$1,saved.id,'planned',d.event_detail,$3 FROM saved JOIN supplied d ON d.id=saved.id RETURNING id)
   SELECT saved.* FROM saved CROSS JOIN (SELECT count(*) FROM events) audit`,[workspaceId,JSON.stringify(batch),nowIso()]);
  const byId=new Map(result.rows.map(row=>[row.id,row]));for(const entry of batch)if(byId.has(entry.id))created.push(workFrom(byId.get(entry.id)));
 }return created;
}

async function plan(database,workspaceId,{afterSkuId=null,limitSkus=null,processedSkus=0}={}){if(limitSkus!==null&&(!Number.isSafeInteger(limitSkus)||limitSkus<1||limitSkus>1000))throw new ValidationError('Invalid planning batch bound.');const state=await ensure(database,workspaceId);const rows=(await planningRows(database,workspaceId,{afterSkuId,limitSkus})).map(position);
  const bySku=new Map();for(const row of rows){if(!bySku.has(row.sku_id))bySku.set(row.sku_id,[]);bySku.get(row.sku_id).push(row);}
  const selected=Array.from(bySku.entries()).slice(0,limitSkus??bySku.size),partial=limitSkus!==null&&bySku.size>limitSkus;
  const prepared=[];const considered=[];const suppliers=await planningSuppliers(database,workspaceId,selected.map(([id])=>id));
  for(const [,locations] of selected){for(const shortage of locations.filter((row)=>row.reorder!==null&&row.projected<=row.reorder)){
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
    }else{const supplier=await supplierChoice(database,workspaceId,{...shortage,needed},suppliers);if(!supplier){considered.push({skuId:shortage.sku_id,reason:'no_supplier'});continue;}
      candidate={type:'purchase',skuId:shortage.sku_id,displayName:`${shortage.item_name}${shortage.variant_label?` — ${shortage.variant_label}`:''}`,
        code:shortage.code,quantity:supplier.quantity,purchaseUnits:supplier.purchaseUnits,unitsPerPurchaseUnit:supplier.unitsPer,
        supplierId:supplier.supplier_id,supplierName:supplier.supplier_name,supplierSku:supplier.supplier_sku,
        destinationLocationId:shortage.location_id,destinationLocationName:shortage.location_name,unitCost:supplier.unitCost,
        value:supplier.value,currency:supplier.currency||'USD',destinationAvailable:shortage.available,incoming:shortage.incoming,
        reorderPoint:shortage.reorder,targetStock:shortage.target,priority:88,urgency:shortage.available<=0?'immediate':'soon',evidence:[
          {fact:'available',value:shortage.available},{fact:'incoming',value:shortage.incoming},{fact:'reorder_point',value:shortage.reorder},
          {fact:'supplier_pack',value:supplier.unitsPer},{fact:'supplier_minimum_purchase_units',value:Number(supplier.minimum_order_quantity||1)}]};}
    considered.push(candidate);const evaluation=await evaluate(database,workspaceId,candidate,state);if(evaluation.decision==='refused')continue;
    prepared.push({candidate,evaluation});
  }}const created=await persistPlannedWork(database,workspaceId,prepared);if(!partial)await database.query(`UPDATE workspace_autopilot SET last_evaluated_at=$2,next_evaluation_at=$3,updated_at=$2 WHERE workspace_id=$1`,
    [workspaceId,nowIso(),new Date(Date.now()+15*60000).toISOString()]);return {state,created,considered,partial,nextAfterSkuId:selected.at(-1)?.[0]||afterSkuId,processedSkus:processedSkus+selected.length};}

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

async function queueSupplierPurchaseOrder(client,ctx,item,purchase){const scoped=scopedDatabase(client);
  const delivery=await supplierDeliveryReadiness(scoped,ctx.workspaceId,item.recommendedAction.supplierId);
  if(!delivery.ready)throw new ValidationError(delivery.reason);
  const lines=(await client.query(`SELECT sku.code,line.quantity_units,line.unit_cost FROM purchase_order_lines line
    JOIN skus sku ON sku.id=line.sku_id AND sku.workspace_id=line.workspace_id
    WHERE line.workspace_id=$1 AND line.purchase_order_id=$2 ORDER BY line.line_number,line.id`,
  [ctx.workspaceId,purchase.purchaseOrderId])).rows;
  const body=[`Hello${delivery.supplier.contact_name?` ${delivery.supplier.contact_name}`:''},`,'',
    `Purchase order ${purchase.poNumber}:`,...lines.map((line)=>
      `${line.quantity_units} × ${line.code}${line.unit_cost===null?'':` at ${item.recommendedAction.currency} ${Number(line.unit_cost).toFixed(2)}`}`),
    '',`Please confirm acceptance and expected delivery for ${purchase.poNumber}.`].join('\n');
  return outboundMail.queueInTransaction(client,ctx,{recipientKind:'supplier',recipientId:delivery.supplier.id,
    recipientEmail:delivery.supplier.email,connectorId:delivery.mailbox.id,
    subject:`Purchase order ${purchase.poNumber}`,body},`work:${item.id}:supplier-order`);
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
  const scope=await entitlements.ownerScopeForWorkspace(client,ctx.workspaceId);
  await entitlements.assertCapability(client,scope,item.recommendedAction.type==='transfer'?'inventory.transfers':'purchasing.core');
  const automatic=item.approval_requirement==='NONE';const usageKey=`autopilot-work:${item.id}`;
  if(automatic){await entitlements.assertCapability(client,scope,item.recommendedAction.type==='transfer'?'automation.transfers':'automation.purchasing');
    await entitlements.reserveUsage(client,scope,{meter:'connected_operations',units:1,idempotencyKey:usageKey,
      detail:{operation:'autopilot_action',workId:item.id}});}
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
      const delivery=await queueSupplierPurchaseOrder(client,ctx,item,purchase);
      result={kind:'purchase',purchaseOrderId:purchase.purchaseOrderId,poNumber:purchase.poNumber,status:approved.status,
        value:action.value,verified:true,phase:'SUPPLIER_DELIVERY_PENDING',effectId:delivery.effectId,
        communicationId:delivery.communicationId};}
    if(result.phase==='SUPPLIER_DELIVERY_PENDING'){
      await client.query(`UPDATE work_items SET execution_status='EXECUTING',verification_status='PENDING',
        purchase_order_id=$3,outcome=$4,error_message=NULL WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,item.id,result.purchaseOrderId,JSON.stringify(result)]);
      await client.query(`INSERT INTO work_item_events(id,workspace_id,work_item_id,event,detail,actor_user_id,created_at)
        VALUES($1,$2,$3,'waiting_for_supplier_delivery',$4,$5,$6)`,[newId('wievt'),ctx.workspaceId,item.id,
        JSON.stringify({effectId:result.effectId,purchaseOrderId:result.purchaseOrderId}),ctx.actorId,nowIso()]);
      if(automatic){await entitlements.commitUsage(client,scope,{meter:'connected_operations',idempotencyKey:usageKey});
        await require('../commercial/control-service').recordCost(client,scope,{provider:'stockchief',operation:'autopilot_action',
          unit:'operation',quantity:1,idempotencyKey:usageKey});}
      return getWork(scoped,ctx.workspaceId,item.id);
    }
    await client.query(`UPDATE work_items SET execution_status='COMPLETED',verification_status='VERIFIED',movement_ids=$3,
      purchase_order_id=$4,outcome=$5,error_message=NULL,completed_at=$6 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,item.id,JSON.stringify(result.movementIds||[]),result.purchaseOrderId||null,JSON.stringify(result),nowIso()]);
    await client.query(`INSERT INTO work_item_events(id,workspace_id,work_item_id,event,detail,actor_user_id,created_at)
      VALUES($1,$2,$3,'completed',$4,$5,$6)`,[newId('wievt'),ctx.workspaceId,item.id,JSON.stringify(result),ctx.actorId,nowIso()]);
    if(automatic){await entitlements.commitUsage(client,scope,{meter:'connected_operations',idempotencyKey:usageKey});
      await require('../commercial/control-service').recordCost(client,scope,{provider:'stockchief',operation:'autopilot_action',
        unit:'operation',quantity:1,idempotencyKey:usageKey});}
    const commercialScope=scope;
    await commercial.trackOnce(client,{eventName:'first_meaningful_stockchief_action',accountId:commercialScope.accountId,
      sourcePath:'autopilot',detail:{workItemId:item.id,actionType:action.type}});
    return getWork(scoped,ctx.workspaceId,item.id);},{isolation:'SERIALIZABLE',retrySafe:true});}

async function reconcileSupplierFollowThrough(database,workspaceId,{actorId=null}={}){
  const pending=(await database.query(`SELECT item.id,item.outcome,effect.status AS effect_status,effect.error_message
    FROM work_items item LEFT JOIN stockchief_runtime.provider_effects effect
      ON effect.workspace_id=item.workspace_id AND effect.id=(item.outcome::jsonb)->>'effectId'
    WHERE item.workspace_id=$1 AND item.source='postgres_autopilot' AND item.execution_status='EXECUTING'
      AND (item.outcome::jsonb)->>'phase'='SUPPLIER_DELIVERY_PENDING' ORDER BY item.created_at,item.id`,[workspaceId])).rows;
  if(!pending.length)return {completed:0,failed:0,pending:0};
  const ownerId=actorId||(await database.query(`SELECT id FROM users WHERE workspace_id=$1 AND role='owner'
    ORDER BY created_at,id LIMIT 1`,[workspaceId])).rows[0]?.id;
  if(!ownerId)throw new ValidationError('Automatic supplier follow-through needs an inventory owner.');
  let completed=0,failed=0,waiting=0;
  for(const row of pending){const outcome=parse(row.outcome,{});
    if(row.effect_status==='SUCCEEDED'){
      const placed=await workflows.placePurchaseOrder(database,{workspaceId,actorId:ownerId},outcome.purchaseOrderId,
        {idempotencyKey:`work:${row.id}:place-after-delivery`});
      await database.transaction(async(client)=>{await client.query(`UPDATE work_items SET execution_status='COMPLETED',
          verification_status='VERIFIED',outcome=$3::jsonb,error_message=NULL,completed_at=$4
          WHERE workspace_id=$1 AND id=$2 AND execution_status='EXECUTING'`,[workspaceId,row.id,
          JSON.stringify({...outcome,status:placed.status,phase:'SUPPLIER_DELIVERED_AND_ORDERED',verified:true}),nowIso()]);
        await client.query(`INSERT INTO work_item_events(id,workspace_id,work_item_id,event,detail,actor_user_id,created_at)
          VALUES($1,$2,$3,'supplier_delivery_verified',$4,$5,$6)`,[newId('wievt'),workspaceId,row.id,
          JSON.stringify({effectId:outcome.effectId,purchaseOrderId:outcome.purchaseOrderId,status:placed.status}),ownerId,nowIso()]);
      },{isolation:'SERIALIZABLE',retrySafe:true});completed+=1;
    }else if(['FAILED','AMBIGUOUS','CANCELLED'].includes(row.effect_status)||!row.effect_status){
      const reason=row.effect_status==='AMBIGUOUS'
        ?'Supplier delivery is uncertain. Check the Sent folder before taking further action.'
        :row.error_message||'Supplier delivery could not be verified.';
      await database.query(`UPDATE work_items SET execution_status='FAILED',verification_status='FAILED',error_message=$3,
        outcome=$4::jsonb,completed_at=$5 WHERE workspace_id=$1 AND id=$2 AND execution_status='EXECUTING'`,
      [workspaceId,row.id,reason,JSON.stringify({...outcome,phase:'SUPPLIER_DELIVERY_FAILED',verified:false}),nowIso()]);failed+=1;
    }else waiting+=1;
  }
  return {completed,failed,pending:waiting};
}

async function run(database,ctx,options={}){const followThrough=await reconcileSupplierFollowThrough(database,ctx.workspaceId,{actorId:ctx.actorId});
  const planned=await plan(database,ctx.workspaceId,options);let executed=0;
  for(const item of planned.created.filter((entry)=>entry.approval_requirement==='NONE')){
    const completed=await execute(database,ctx,item.id);if(completed.execution_status===STATUSES.COMPLETED)executed+=1;
  }
  return {planned:planned.created.length,executed,waiting:planned.created.length-executed,
    considered:planned.considered.length,followThrough,partial:planned.partial,nextAfterSkuId:planned.nextAfterSkuId,processedSkus:planned.processedSkus};}
async function approve(database,ctx,membership,id){assertOperate(membership);return execute(database,ctx,id,{approvedBy:ctx.actorId});}
async function cancel(database,ctx,membership,id){assertOperate(membership);const item=await getWork(database,ctx.workspaceId,id);
  if([STATUSES.COMPLETED,STATUSES.FAILED].includes(item.execution_status))throw new ValidationError('Completed work cannot be discarded.');
  await database.query(`UPDATE work_items SET execution_status='CANCELLED',completed_at=$3 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,id,nowIso()]);return getWork(database,ctx.workspaceId,id);}

async function dashboard(database,workspaceId){const [state,policies,capabilities,locations,suppliers,recent]=await Promise.all([
  getState(database,workspaceId),listPolicies(database,workspaceId),
  listCapabilities(database,workspaceId),
  database.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 ORDER BY name`,[workspaceId]),
  database.query(`SELECT id,name FROM suppliers WHERE workspace_id=$1 AND status='active' ORDER BY name`,[workspaceId]),
  database.query(`SELECT * FROM work_items WHERE workspace_id=$1 AND source='postgres_autopilot' ORDER BY created_at DESC,id DESC LIMIT 30`,[workspaceId])]);
  return {state,policies,capabilities,locations:locations.rows,suppliers:suppliers.rows,recent:recent.rows.map(workFrom),
    maintenanceProgress:await require('../operations/postgres-maintenance-progress').read(database,workspaceId),
    transferPolicy:policies.find((policy)=>policy.active&&policy.actions.includes(ACTIONS.TRANSFER))||null,
    purchasePolicy:policies.find((policy)=>policy.active&&policy.actions.includes(ACTIONS.PURCHASE))||null};}

module.exports={MODES,ACTIONS,STATUSES,ensure,getState,setMode,pause,resume,configureRoutine,replacePolicy,listPolicies,dashboard,plan,run,
  listCapabilities,setCapability,capabilityMay,getWork,approve,cancel,execute,evaluate,revalidate,
  supplierDeliveryReadiness,reconcileSupplierFollowThrough};
require('../commercial/enforcement').guardExports(module.exports,0,1,{configureRoutine:'authority.advanced',
 setCapability:'authority.advanced',plan:'planning.basic',run:'planning.basic'});

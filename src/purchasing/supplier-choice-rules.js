'use strict';
// Job 207: supplier rules the owner writes in plain words, such as
// "always order SKU-1 from Acme" or "never order the Shoes category from Beta".
//
// A rule covers one SKU, one product (all its variants), a category, or
// everything. Reorder drafts, supplier picks and automatic reorders keep only
// the suppliers the rules allow: a "never" rule removes that supplier, and an
// "always" rule removes every other supplier. When the rules leave no supplier,
// or rule out the product's saved reorder supplier, the reorder stops and asks
// instead of choosing one. Each enabled rule counts against the plan's rule
// allowance, and only the owner can change rules.
const {has}=require('../db/schema-installed');
const audit=require('../operations/postgres-security-audit');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId}=require('../lib/util');

const TABLE='stockchief_runtime.agent_supplier_choice_rules';

// The rules that cover each SKU: Map sku -> {always:[...], never:[...]}.
async function forSkus(db,workspaceId,skuIds){
  const ids=[...new Set(skuIds.filter(Boolean))];
  if(!ids.length||!await has(db,TABLE))return new Map();
  const {rows}=await db.query(`SELECT s.id AS sku_id,r.choice,r.supplier_id,r.instruction,v.name AS supplier
    FROM ${TABLE} r JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=ANY($2::text[])
    JOIN suppliers v ON v.workspace_id=r.workspace_id AND v.id=r.supplier_id
    LEFT JOIN catalogue_item_facts f ON f.workspace_id=s.workspace_id AND f.item_id=s.item_id
    WHERE r.workspace_id=$1 AND r.enabled AND CASE r.scope_kind WHEN 'ALL' THEN true WHEN 'SKU' THEN r.sku_id=s.id
      WHEN 'ITEM' THEN r.item_id=s.item_id ELSE lower(trim(f.category))=r.category_key END
    ORDER BY s.id,r.created_at,r.id`,[workspaceId,ids]);
  const result=new Map();
  for(const r of rows){
    if(!result.has(r.sku_id))result.set(r.sku_id,{always:[],never:[]});
    result.get(r.sku_id)[r.choice==='ALWAYS'?'always':'never'].push({supplierId:r.supplier_id,supplier:r.supplier,instruction:r.instruction});
  }
  return result;
}
function allows(entry,supplierId){
  if(!entry)return true;
  return !entry.never.some(r=>r.supplierId===supplierId)&&entry.always.every(r=>r.supplierId===supplierId);
}
// Supplier rows (each with sku_id and supplier_id) the rules allow.
async function filter(db,workspaceId,rows){
  const rules=await forSkus(db,workspaceId,rows.map(r=>r.sku_id));
  return rules.size?rows.filter(r=>allows(rules.get(r.sku_id),r.supplier_id)):rows;
}
const quote=entry=>{const all=[...entry.always,...entry.never];
  return (all.length>1?'Your rules ':'Your rule ')+all.map(r=>'“'+r.instruction+'”').join(' and ')+(all.length>1?' leave':' leaves');};
// Why a reorder of one product stops, or null.
function stop(entry,code,remaining,preferredSupplierId){
  if(!entry)return null;
  if(!remaining.length)return quote(entry)+' no supplier for '+code+'. Link an allowed supplier to it or change the rule.';
  if(preferredSupplierId&&!remaining.some(o=>o.supplier_id===preferredSupplierId))
    return quote(entry)+' out the saved reorder supplier for '+code+'. Change the product’s reorder supplier or the rule.';
  return null;
}

async function owner(c,ctx){
  const allowed=(await c.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!allowed)throw new AuthorizationError('Only the owner can change supplier rules.');
}
function meaning(rule){
  const what=rule.scope_kind==='ALL'?'anything':rule.scope_kind==='CATEGORY'?'anything in the '+rule.scope_name+' category':rule.scope_name;
  return rule.choice==='ALWAYS'
    ?'Reorders of '+what+' use only '+rule.supplier+'. If '+rule.supplier+' does not sell it, StockChief asks you instead of using another supplier.'
    :'Reorders of '+what+' never use '+rule.supplier+'. If no other supplier sells it, StockChief asks you.';
}

// Saves one rule, already read and checked by plain-rules.js. The same rule
// saved again changes nothing.
async function save(db,ctx,rule){
  return db.transaction(async c=>{
    await owner(c,ctx);
    await require('../commercial/agent-plan').requireWorkspaceJob(c,ctx.workspaceId,207,'automatic');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['supplier-choice:'+ctx.workspaceId]);
    const supplier=(await c.query("SELECT id,name FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active' FOR SHARE",[ctx.workspaceId,rule.supplierId])).rows[0];
    if(!supplier)throw new ValidationError('That supplier is no longer active. Read the rule again.');
    const scope=[rule.scopeKind,rule.skuId||null,rule.itemId||null,rule.categoryKey||null];
    const existing=(await c.query(`SELECT r.*,v.name AS supplier FROM ${TABLE} r JOIN suppliers v ON v.workspace_id=r.workspace_id AND v.id=r.supplier_id
      WHERE r.workspace_id=$1 AND r.enabled AND r.scope_kind=$2 AND r.sku_id IS NOT DISTINCT FROM $3 AND r.item_id IS NOT DISTINCT FROM $4
        AND r.category_key IS NOT DISTINCT FROM $5 FOR UPDATE OF r`,[ctx.workspaceId,...scope])).rows;
    const prior=existing.find(r=>r.supplier_id===supplier.id);
    const other=existing.find(r=>r.supplier_id!==supplier.id&&r.choice==='ALWAYS'&&rule.choice==='ALWAYS');
    if(other)throw new ValidationError('You already said “'+other.instruction+'”. Remove that rule first, then save this one.');
    if(prior&&prior.choice===rule.choice&&prior.instruction===rule.instruction)return {id:prior.id,unchanged:true,meaning:meaning(prior)};
    if(!prior)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    const id=prior?.id||newId('supplierrule');
    await c.query(`INSERT INTO ${TABLE} AS r(id,workspace_id,instruction,choice,scope_kind,scope_name,sku_id,item_id,category_key,supplier_id,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) ON CONFLICT(id) DO UPDATE SET instruction=excluded.instruction,choice=excluded.choice,
      scope_name=excluded.scope_name,updated_by=excluded.updated_by,revision=r.revision+1,updated_at=clock_timestamp()`,
    [id,ctx.workspaceId,rule.instruction,rule.choice,rule.scopeKind,rule.scopeName||'',scope[1],scope[2],scope[3],supplier.id,ctx.actorId]);
    const saved={choice:rule.choice,scope_kind:rule.scopeKind,scope_name:rule.scopeName||'',supplier:supplier.name};
    await audit.record(c,ctx,{action:'Supplier rule saved',reference:id,before:prior?{instruction:prior.instruction,meaning:meaning(prior)}:{},
      after:{instruction:rule.instruction,meaning:meaning(saved)}});
    return {id,meaning:meaning(saved)};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function remove(db,ctx,id){
  return db.transaction(async c=>{
    await owner(c,ctx);
    const removed=(await c.query(`UPDATE ${TABLE} SET enabled=false,updated_by=$3,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND enabled RETURNING instruction`,
      [ctx.workspaceId,String(id||''),ctx.actorId])).rows[0];
    if(removed)await audit.record(c,ctx,{action:'Supplier rule removed',reference:String(id),before:{instruction:removed.instruction}});
    return {removed:Boolean(removed)};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function list(db,workspaceId){
  if(!await has(db,TABLE))return [];
  return (await db.query(`SELECT r.id,r.instruction,r.choice,r.scope_kind,r.scope_name,v.name AS supplier,r.updated_at FROM ${TABLE} r
    JOIN suppliers v ON v.workspace_id=r.workspace_id AND v.id=r.supplier_id WHERE r.workspace_id=$1 AND r.enabled ORDER BY r.created_at,r.id`,[workspaceId])).rows
    .map(r=>({...r,meaning:meaning(r)}));
}
module.exports={TABLE,forSkus,allows,filter,stop,meaning,save,remove,list};

'use strict';

// Job 126: finds duplicates, missing cost or weight and bad SKUs, and fixes
// them in bulk through the catalog's own services.
//
//  - Merge: a duplicate product (same barcode, same supplier code, the same
//    SKU apart from capitals and spaces, or the same name with the same
//    options, unit and tracking) is merged into the product kept. Its supplier
//    terms, sales channel links and barcode move to the kept product, and it is
//    archived with its stock movements, orders and receipts on its own record.
//    StockChief never moves or writes off stock to merge (plan spec, page 13):
//    while the duplicate still holds stock, open orders, a kit or recipe, or a
//    channel stock link, a person resolves that first. Different barcodes,
//    units or supplier codes need a person to confirm the merge.
//  - SKU: spaces and control characters are taken out when the cleaned SKU is
//    free and no sales channel or supplier code points at the old one. Blank
//    SKUs, characters channels reject and anything unsafe wait for a person.
//  - Cost: a missing purchase cost is filled from the latest receipt or the
//    supplier price, only when every source agrees. Otherwise it asks.
//  - Weight: a missing weight is filled from a supplier file or the product's
//    other variants, only when every source agrees. Otherwise it asks.
//
// Starter only suggests. Growth prepares a bulk fix list a person approves.
// Pro prepares fixes until the owner approved one of a kind and saved a daily
// limit; Custom fixes on its own inside a daily limit the owner can change or
// stop. Automatic fixes respect shadow, pause, watch mode, Watch only and Ask
// me first. Every fix is audited and can be undone.

const {ValidationError,AuthorizationError,NotFoundError,DomainError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');
const maintenance=require('../domain/postgres-sku-maintenance');
const {hash}=require('../pricing/postgres-promotions');
const {newId,nowIso}=require('../lib/util');

const JOB=126,ACTION='catalog.fix_data',kind='agent.catalog-fixes.v1',path='/autopilot/catalog-fixes';
const KINDS=['MERGE','SKU','COST','WEIGHT'],DEFAULT_DAILY=50;
const fixes='stockchief_runtime.agent_catalog_fixes',rules='stockchief_runtime.agent_catalog_fix_rules';
// Characters every connected sales channel accepts in a SKU.
const SAFE=/^[A-Za-z0-9._/-]+$/,SAFE_SQL='^[A-Za-z0-9._/-]+$';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const expected=error=>error instanceof DomainError&&[400,402,403,404,409].includes(error.status);
const grams=value=>String(Number(value));
const kindLabels={MERGE:'Duplicate products',SKU:'SKUs',COST:'Purchase costs',WEIGHT:'Weights'};

async function owner(db,ctx,{lock=false}={}){
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  const allowed=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!allowed)throw new AuthorizationError('Only the current inventory owner can fix product data.');
}

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

// ---- Finding problems -------------------------------------------------------

// Active SKUs with a code, cost or weight problem, plus any SKUs asked for.
const PROBLEMS=`SELECT * FROM (
  SELECT s.id,s.item_id,s.code,s.barcode,s.variant_label,i.name,
    EXISTS(SELECT 1 FROM skus o WHERE o.workspace_id=s.workspace_id AND o.id<>s.id AND o.is_active=1
      AND lower(btrim(o.code))=lower(btrim(s.code))) AS repeated,
    NOT EXISTS(SELECT 1 FROM sku_purchase_costs p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id) AS no_cost,
    NOT coalesce(s.weight_grams>0,false) AS no_weight
  FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
  WHERE s.workspace_id=$1 AND s.is_active=1 AND ($2::text[] IS NULL OR s.id=ANY($2::text[])) AND ($3::text IS NULL OR s.id>$3)
    AND ($4='' OR lower(btrim(s.code))=lower($4) OR lower(i.name)=lower($4))
) x WHERE x.code<>btrim(x.code) OR x.code !~ '${SAFE_SQL}' OR x.repeated OR x.no_cost OR x.no_weight OR x.id=ANY($5::text[])`;

async function problemRows(db,workspaceId,{skuIds=null,after=null,filter='',include=[],order='id',limit=200,offset=0}={}){
  return (await db.query(PROBLEMS+(order==='name'?' ORDER BY x.name,x.code,x.id':' ORDER BY x.id')+' LIMIT $6 OFFSET $7',
    [workspaceId,skuIds,after,filter,include,limit,offset])).rows;
}

function codeProblem(code){
  const trimmed=code.trim();
  if(!trimmed)return 'blank';
  if(code!==trimmed||/[\s\x00-\x1f\x7f]/.test(code))return 'spaces';
  if(!SAFE.test(code))return 'characters';
  return null;
}

async function codeFree(db,workspaceId,skuId,code){
  return !(await db.query('SELECT 1 FROM skus WHERE workspace_id=$1 AND id<>$2 AND lower(btrim(code))=lower(btrim($3)) LIMIT 1',[workspaceId,skuId,code])).rowCount;
}

// Whether a SKU code is referenced outside StockChief: a sales channel
// listing, or a supplier code that points at it.
async function codeLinked(db,workspaceId,sku){
  if((await db.query("SELECT 1 FROM connection_mappings WHERE workspace_id=$1 AND entity_type='sku' AND foundry_record_id=$2 LIMIT 1",[workspaceId,sku.id])).rowCount)
    return 'This SKU is linked to a sales channel listing. Change it there too, then enter the new SKU here.';
  if((await db.query('SELECT 1 FROM supplier_code_mappings WHERE workspace_id=$1 AND internal_base_code=$2::citext LIMIT 1',[workspaceId,sku.code])).rowCount)
    return 'A supplier code points at this SKU. Enter the new SKU yourself so the supplier code can be checked.';
  return null;
}

function tryMinor(value,currency){
  try{return currency?money.toMinor(String(value),currency,{label:'Cost'}):null;}catch(error){if(error instanceof ValidationError)return null;throw error;}
}

// Weights recorded in approved supplier files for these SKUs.
async function fileWeights(db,workspaceId,skuIds){
  const specs=require('../domain/agent-supplier-specs');
  const {rows}=await db.query(`SELECT f.sku_id,e.key,e.value,p.source_name FROM catalog_source_facts f
      JOIN import_plans p ON p.workspace_id=f.workspace_id AND p.id=f.source_import_id AND p.approval_status='APPROVED' AND p.status IN ('SUCCEEDED','PARTIAL')
      CROSS JOIN LATERAL jsonb_each_text(coalesce(f.attributes,jsonb_build_object(coalesce(f.name,''),f.value))) e
      WHERE f.workspace_id=$1 AND f.sku_id=ANY($2::text[])
    UNION ALL
    SELECT r.sku_id,col->>'name',r.raw::jsonb->>((col->>'index')::int),p.source_name FROM import_rows r
      JOIN import_plans p ON p.workspace_id=r.workspace_id AND p.id=r.import_id AND p.approval_status='APPROVED' AND p.status IN ('SUCCEEDED','PARTIAL')
      CROSS JOIN LATERAL jsonb_array_elements(p.source_columns::jsonb) col
      WHERE r.workspace_id=$1 AND r.sku_id=ANY($2::text[]) AND r.status='IMPORTED'
        AND jsonb_typeof(r.raw::jsonb)='array' AND col->>'index' ~ '^[0-9]+$'`,[workspaceId,skuIds]);
  const out=new Map();
  for(const fact of rows){
    const field=specs.aliases.get(String(fact.key||'').toLowerCase().replace(/[^a-z0-9]/g,''));
    if(!field||field[0]!=='weight_grams'||!String(fact.value??'').trim())continue;
    const value=specs.decode(field,fact.value);
    if(!out.has(fact.sku_id))out.set(fact.sku_id,[]);
    out.get(fact.sku_id).push({grams:value==null?null:grams(value),label:'supplier file '+fact.source_name});
  }
  return out;
}

const group=rows=>{const out=new Map();for(const r of rows){if(!out.has(r.sku_id))out.set(r.sku_id,[]);out.get(r.sku_id).push(r);}return out;};
const option=(type,row,details,{target=null,hold=null,ask=null,facts=[]}={})=>({kind:type,skuId:row.id,targetSkuId:target,hold,ask,
  details:{code:row.code,name:row.name,itemId:row.item_id,...details},fingerprint:hash([type,row.id,target,row.code,details,facts,hold,ask])});

// The SKU, cost and weight fixes for these problem rows.
async function skuOptions(db,workspaceId,rows,{skip=new Set()}={}){
  rows=rows.filter(r=>!skip.has(r.id));
  if(!rows.length)return [];
  const ids=rows.map(r=>r.id),costIds=rows.filter(r=>r.no_cost).map(r=>r.id),weightIds=rows.filter(r=>r.no_weight).map(r=>r.id);
  const receipts=costIds.length?new Map((await db.query(`SELECT DISTINCT ON (pol.sku_id) pol.sku_id,po.po_number,po.currency,pol.unit_cost::text AS unit_cost
      FROM purchase_order_lines pol JOIN purchase_orders po ON po.workspace_id=pol.workspace_id AND po.id=pol.purchase_order_id
      JOIN purchase_order_receipt_lines l ON l.workspace_id=pol.workspace_id AND l.purchase_order_line_id=pol.id
      JOIN purchase_order_receipts r ON r.workspace_id=l.workspace_id AND r.id=l.receipt_id
      WHERE pol.workspace_id=$1 AND pol.sku_id=ANY($2::text[]) ORDER BY pol.sku_id,r.created_at DESC,r.id DESC`,[workspaceId,costIds])).rows.map(r=>[r.sku_id,r])):new Map();
  const prices=costIds.length?group((await db.query(`SELECT si.sku_id,v.name,v.currency,si.last_unit_cost::text AS cost FROM supplier_items si
      JOIN suppliers v ON v.workspace_id=si.workspace_id AND v.id=si.supplier_id AND v.status='active'
      WHERE si.workspace_id=$1 AND si.sku_id=ANY($2::text[]) AND si.is_active=1 AND si.last_unit_cost IS NOT NULL ORDER BY si.sku_id,v.name,si.id`,[workspaceId,costIds])).rows):new Map();
  const siblings=weightIds.length?group((await db.query(`SELECT s.id AS sku_id,o.code,o.weight_grams::text AS grams FROM skus s
      JOIN skus o ON o.workspace_id=s.workspace_id AND o.item_id=s.item_id AND o.id<>s.id AND o.is_active=1 AND o.weight_grams>0
      WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) ORDER BY s.id,o.code`,[workspaceId,weightIds])).rows):new Map();
  const files=weightIds.length?await fileWeights(db,workspaceId,weightIds):new Map();
  const out=[];
  for(const row of rows){
    const problem=codeProblem(row.code);
    // A SKU that repeats another is a duplicate; the merge handles it.
    if(problem&&!row.repeated){
      const trimmed=row.code.trim(),cleaned=trimmed.replace(/[\x00-\x1f\x7f]/g,'').replace(/\s+/g,'-');
      if(problem==='spaces'){
        const linked=await codeLinked(db,workspaceId,row);
        const ask=!SAFE.test(cleaned)?'Sales channels reject some characters in this SKU. Enter a new SKU.':
          cleaned.length>120?'The cleaned SKU is too long. Enter a shorter SKU.':
          !(await codeFree(db,workspaceId,row.id,cleaned))?'Another product already uses '+cleaned+'. Enter a different SKU.':linked;
        out.push(option('SKU',row,{problem,after:ask?null:cleaned,suggestion:SAFE.test(cleaned)?cleaned:null},{ask}));
      }else{
        const suggestion=trimmed.replace(/[^A-Za-z0-9._/-]+/g,'-').replace(/^-+|-+$/g,'')||null;
        out.push(option('SKU',row,{problem,after:null,suggestion},{ask:problem==='blank'?'This SKU is blank. Enter a SKU.':
          'Sales channels reject some characters in this SKU. Enter a new SKU using letters, numbers, hyphens, underscores, periods or slashes.'}));
      }
    }
    if(row.no_cost){
      const sources=[],receipt=receipts.get(row.id);
      if(receipt?.unit_cost!=null)sources.push({amountMinor:tryMinor(receipt.unit_cost,receipt.currency),currency:receipt.currency,label:'the latest receipt on '+receipt.po_number});
      for(const p of prices.get(row.id)||[])sources.push({amountMinor:tryMinor(p.cost,p.currency),currency:p.currency,label:p.name+' price'});
      const clear=sources.every(s=>s.amountMinor!=null),values=[...new Set(sources.map(s=>s.amountMinor+' '+s.currency))];
      const candidates=sources.filter(s=>s.amountMinor!=null);
      if(clear&&values.length===1){
        const s=sources[0];
        out.push(option('COST',row,{after:{amountMinor:s.amountMinor,currency:s.currency},source:sources.map(x=>x.label).join(' and ')},{facts:values}));
      }else out.push(option('COST',row,{after:null,candidates},{facts:sources.map(s=>[s.amountMinor,s.currency,s.label]),
        ask:!sources.length?'No receipt or supplier price records this cost. Enter it.':'Choose one or enter the cost.'}));
    }
    if(row.no_weight){
      const sources=[...(siblings.get(row.id)||[]).map(s=>({grams:grams(s.grams),label:'variant '+s.code})),...(files.get(row.id)||[])];
      const clear=sources.every(s=>s.grams!=null),values=[...new Set(sources.map(s=>s.grams))];
      if(sources.length&&clear&&values.length===1){
        out.push(option('WEIGHT',row,{after:{grams:values[0]},source:[...new Set(sources.map(s=>s.label))].join(' and ')},{facts:values}));
      }else out.push(option('WEIGHT',row,{after:null,candidates:[...new Map(sources.filter(s=>s.grams!=null).map(s=>[s.grams,s])).values()]},
        {facts:sources.map(s=>[s.grams,s.label]),ask:!sources.length?'No supplier file or other variant records this weight. Enter it.':
          'Choose one or enter the weight.'}));
    }
  }
  return out;
}

// Products that look like duplicates, grouped by what they share. Groups are
// joined into clusters; each cluster keeps one product and merges the rest.
const DUPLICATES=`WITH active AS MATERIALIZED (
    SELECT s.id,s.code,s.barcode,s.variant_label,i.name,i.unit_label,i.tracking_mode,i.secondary_unit_label
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    WHERE s.workspace_id=$1 AND s.is_active=1
  ), keyed AS (
    SELECT id,1 AS rank,lower(btrim(barcode)) AS key,NULL::text AS barcode FROM active WHERE btrim(coalesce(barcode,''))<>''
    UNION ALL SELECT si.sku_id,2,si.supplier_id||chr(31)||lower(btrim(si.supplier_sku)),NULL FROM supplier_items si JOIN active a ON a.id=si.sku_id
      WHERE si.workspace_id=$1 AND si.is_active=1 AND btrim(coalesce(si.supplier_sku,''))<>''
    UNION ALL SELECT id,3,lower(btrim(code)),NULL FROM active WHERE btrim(code)<>''
    UNION ALL SELECT id,4,regexp_replace(lower(name),'[^[:alnum:]]+','','g')||chr(31)||regexp_replace(lower(coalesce(variant_label,'')),'[^[:alnum:]]+','','g')
      ||chr(31)||lower(btrim(unit_label))||chr(31)||tracking_mode||chr(31)||lower(coalesce(secondary_unit_label,'')),lower(nullif(btrim(barcode),''))
      FROM active WHERE regexp_replace(lower(name),'[^[:alnum:]]+','','g')<>''
  )
  SELECT rank,key,array_agg(DISTINCT id ORDER BY id) AS ids FROM keyed GROUP BY rank,key HAVING count(DISTINCT id)>1
    -- The same name with different barcodes is two products.
    AND (rank<>4 OR count(DISTINCT barcode)<=1)
  ORDER BY rank,key LIMIT 2000`;

// Orders, purchase orders and transfers that still list a SKU, the same test
// the catalog uses before archiving a variant.
const PENDING=`SELECT o.order_number AS reference FROM sales_order_lines l JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
    WHERE l.workspace_id=$1 AND l.sku_id=$2 AND o.status NOT IN ('FULFILLED','CANCELLED')
  UNION ALL SELECT o.po_number FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
    WHERE l.workspace_id=$1 AND l.sku_id=$2 AND o.status NOT IN ('COMPLETED','CANCELLED','RECEIVED')
  UNION ALL SELECT t.transfer_number FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.workspace_id=l.workspace_id AND t.id=l.transfer_id
    WHERE l.workspace_id=$1 AND l.sku_id=$2 AND t.status NOT IN ('RECEIVED','CANCELLED') LIMIT 1`;
async function pendingWork(db,workspaceId,sku){
  const work=await require('../domain/postgres-record-removal').openWork(db,{workspaceId},[sku.id]);
  if(work)return work.replace('; nothing was removed.','.');
  const listed=(await db.query(PENDING,[workspaceId,sku.id])).rows[0];
  return listed?listed.reference+' still lists '+sku.code+'. Finish or cancel it first.':null;
}

async function mergeOptions(db,workspaceId){
  const groups=(await db.query(DUPLICATES,[workspaceId])).rows;
  const result={options:new Map(),clustered:new Set()};
  if(!groups.length)return result;
  const ids=[...new Set(groups.flatMap(g=>g.ids))];
  const facts=new Map((await db.query(`SELECT s.id,s.item_id,s.code,s.barcode,s.created_at,i.name,lower(btrim(i.unit_label)) AS unit,i.tracking_mode,
      lower(coalesce(i.secondary_unit_label,'')) AS secondary,
      EXISTS(SELECT 1 FROM balances b WHERE b.sku_id=s.id AND (b.on_hand<>0 OR coalesce(b.secondary_on_hand,0)<>0)) OR
      EXISTS(SELECT 1 FROM accounting_inventory_cost_balances c WHERE c.workspace_id=s.workspace_id AND c.sku_id=s.id
        AND (c.quantity_units<>0 OR coalesce(c.secondary_quantity_units,0)<>0 OR c.total_cost_minor<>0)) AS stocked,
      EXISTS(SELECT 1 FROM sales_order_lines l JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
          WHERE l.workspace_id=s.workspace_id AND l.sku_id=s.id AND o.status NOT IN ('FULFILLED','CANCELLED'))
        OR EXISTS(SELECT 1 FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
          WHERE l.workspace_id=s.workspace_id AND l.sku_id=s.id AND o.status NOT IN ('COMPLETED','CANCELLED','RECEIVED'))
        OR EXISTS(SELECT 1 FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.workspace_id=l.workspace_id AND t.id=l.transfer_id
          WHERE l.workspace_id=s.workspace_id AND l.sku_id=s.id AND t.status NOT IN ('RECEIVED','CANCELLED')) AS pending,
      EXISTS(SELECT 1 FROM movements m WHERE m.sku_id=s.id) OR EXISTS(SELECT 1 FROM sales_order_lines l WHERE l.workspace_id=s.workspace_id AND l.sku_id=s.id)
        OR EXISTS(SELECT 1 FROM purchase_order_lines l WHERE l.workspace_id=s.workspace_id AND l.sku_id=s.id) AS history,
      EXISTS(SELECT 1 FROM kit_components k WHERE k.workspace_id=s.workspace_id AND (k.kit_sku_id=s.id OR k.component_sku_id=s.id))
        OR EXISTS(SELECT 1 FROM manufacturing_boms b WHERE b.workspace_id=s.workspace_id AND b.status='ACTIVE' AND (b.output_sku_id=s.id
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(b.definition->'components','[]'::jsonb)) x WHERE x->>'skuId'=s.id))) AS assembled,
      EXISTS(SELECT 1 FROM connection_commerce_positions p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id AND p.mode<>'off') AS synced,
      EXISTS(SELECT 1 FROM sku_purchase_costs p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id)::int+coalesce((s.weight_grams>0)::int,0)
        +(btrim(coalesce(s.barcode,''))<>'')::int AS filled
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])`,[workspaceId,ids])).rows.map(r=>[r.id,r]));
  const links=group((await db.query(`SELECT si.sku_id,si.supplier_id,v.name,si.supplier_sku FROM supplier_items si
    JOIN suppliers v ON v.workspace_id=si.workspace_id AND v.id=si.supplier_id WHERE si.workspace_id=$1 AND si.sku_id=ANY($2::text[]) AND si.is_active=1
    ORDER BY si.sku_id,v.name,si.id`,[workspaceId,ids])).rows);
  // Join groups into clusters.
  const parent=new Map(ids.map(id=>[id,id])),root=id=>{while(parent.get(id)!==id)id=parent.get(id);return id;};
  for(const g of groups)for(const id of g.ids.slice(1))parent.set(root(id),root(g.ids[0]));
  const clusters=new Map();
  for(const id of ids){const r=root(id);if(!clusters.has(r))clusters.set(r,[]);clusters.get(r).push(facts.get(id));}
  const code=v=>String(v||'').trim().toLowerCase();
  const evidence=sku=>groups.filter(g=>g.ids.includes(sku.id)).map(g=>{
    if(g.rank===1)return 'same barcode '+String(sku.barcode).trim();
    if(g.rank===2){const l=(links.get(sku.id)||[]).find(x=>x.supplier_id+'\u001f'+code(x.supplier_sku)===g.key);return 'same supplier code '+String(l?.supplier_sku||'').trim()+' at '+l?.name;}
    return g.rank===3?'same SKU apart from capitals and spaces':'same name and options';
  });
  for(const members of clusters.values()){
    for(const m of members)result.clustered.add(m.id);
    // Keep the product with stock or open work, then history, then the most
    // complete data, then the oldest.
    const busy=s=>s.stocked||s.pending;
    const sorted=[...members].sort((a,b)=>Number(busy(b))-Number(busy(a))||Number(b.history)-Number(a.history)||b.filled-a.filled||
      String(a.created_at).localeCompare(String(b.created_at))||a.id.localeCompare(b.id));
    const keeper=sorted[0];
    const barcodes=new Set(members.map(m=>code(m.barcode)).filter(Boolean));
    const units=new Set(members.map(m=>[m.unit,m.tracking_mode,m.secondary].join('|')));
    const sameItem=new Set(members.map(m=>m.item_id)).size!==members.length;
    for(const dup of sorted.slice(1)){
      const keepLinks=links.get(keeper.id)||[],ranks=groups.filter(g=>g.ids.includes(dup.id)).map(g=>g.rank);
      const supplierClash=(links.get(dup.id)||[]).find(l=>keepLinks.some(k=>k.supplier_id===l.supplier_id&&code(k.supplier_sku)&&code(l.supplier_sku)&&code(k.supplier_sku)!==code(l.supplier_sku)));
      const work=dup.pending?await pendingWork(db,workspaceId,dup):null;
      const hold=sameItem?'Two variants of '+dup.name+' share these details. Correct one of them instead of merging.':
        dup.stocked?dup.code+' still holds stock. Move it to '+keeper.code+' yourself first. StockChief never moves or writes off stock to merge products.':
        work||(dup.assembled?dup.code+' is part of a kit or production recipe. Change the kit or recipe to use '+keeper.code+' first.':
        dup.synced?dup.code+' sends stock or prices to a sales channel. Link that listing to '+keeper.code+' yourself first.':null);
      const ask=hold?null:barcodes.size>1?'These products have different barcodes. Merge only if they are the same product.':
        units.size>1?'These products are counted in different units or tracked differently. Merge only if they are the same product.':
        supplierClash?'They have different supplier codes at '+supplierClash.name+'. Merge only if they are the same product; the code on '+keeper.code+' is kept.':
        ranks.every(r=>r===4)?'These products share only a name and options. Merge only if they are the same product.':null;
      const row={id:dup.id,item_id:dup.item_id,code:dup.code,name:dup.name};
      result.options.set(dup.id,option('MERGE',row,{evidence:evidence(dup),barcode:dup.barcode,
        keeper:{id:keeper.id,code:keeper.code,name:keeper.name,itemId:keeper.item_id}},
        {target:keeper.id,hold,ask,facts:[members.map(m=>m.id).sort(),keeper.id]}));
    }
  }
  return result;
}

// ---- Describing fixes -------------------------------------------------------

function amount(after){return money.format(after.amountMinor,after.currency);}
function describe(f){
  const d=f.details;
  if(f.kind==='MERGE')return 'Looks like a duplicate of '+d.keeper.code+' ('+d.evidence.join(', ')+'). Merge it into '+d.keeper.code;
  if(f.kind==='SKU')return d.after?'SKU has spaces. Change it to '+d.after:d.problem==='blank'?'SKU is blank':
    d.problem==='spaces'?'SKU has spaces':'SKU has characters sales channels reject';
  if(f.kind==='COST')return d.after?'No purchase cost. Fill '+amount(d.after)+' from '+d.source:
    d.candidates?.length?'No purchase cost. The records disagree: '+d.candidates.map(c=>amount(c)+' ('+c.label+')').join(', '):'No purchase cost';
  return d.after?'No weight. Fill '+d.after.grams+' g from '+d.source:
    d.candidates?.length?'No weight. The records disagree: '+d.candidates.map(c=>c.grams+' g ('+c.label+')').join(', '):'No weight';
}
// The fix and, when it needs a person, what they need to do.
const explain=o=>describe(o)+(o.hold||o.ask?'. '+String(o.hold||o.ask).replace(/\.$/,''):'');
function doneText(f){
  const d=f.details,a=f.applied||{};
  if(f.kind==='MERGE')return 'Merged '+d.code+' into '+d.keeper.code+'.';
  if(f.kind==='SKU')return 'Changed SKU “'+a.before+'” to '+a.after+'.';
  if(f.kind==='COST')return 'Set the purchase cost of '+d.code+' to '+money.format(a.amountMinor,a.currency)+'.';
  return 'Set the weight of '+d.code+' to '+a.grams+' g.';
}

// ---- Recording and authority -----------------------------------------------

async function record(c,workspaceId,o,{reason=null,wouldApply=false}={}){
  const status=o.hold||o.ask?'HELD':'DRAFT';
  return (await c.query(`INSERT INTO ${fixes} AS f(id,workspace_id,kind,sku_id,target_sku_id,status,details,fingerprint,reason,would_apply)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
    ON CONFLICT(workspace_id,kind,sku_id) WHERE status IN ('DRAFT','HELD') DO UPDATE SET target_sku_id=excluded.target_sku_id,status=excluded.status,
      details=excluded.details,fingerprint=excluded.fingerprint,reason=excluded.reason,would_apply=excluded.would_apply,checked_at=clock_timestamp()
    RETURNING *`,
  [newId('catalog-fix'),workspaceId,o.kind,o.skuId,o.targetSkuId,status,JSON.stringify({...o.details,blocked:Boolean(o.hold)}),o.fingerprint,o.hold||o.ask||reason,wouldApply])).rows[0];
}

// A fix the owner dismissed or undid stays as it is until its facts change.
async function closed(c,workspaceId,o){
  return (await c.query(`SELECT status FROM ${fixes} WHERE workspace_id=$1 AND sku_id=$2 AND kind=$3 AND fingerprint=$4 AND status IN ('DISMISSED','UNDONE')
    ORDER BY decided_at DESC NULLS LAST LIMIT 1`,[workspaceId,o.skuId,o.kind,o.fingerprint])).rows[0]?.status||null;
}

async function loadRule(db,workspaceId,type,{lock=false}={}){
  return (await db.query(`SELECT r.*,EXISTS(SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
      WHERE u.id=r.authorized_by AND w.id=r.workspace_id AND u.role='owner') AS current
    FROM ${rules} r WHERE r.workspace_id=$1 AND r.kind=$2${lock?' FOR SHARE OF r':''}`,[workspaceId,type])).rows[0]||null;
}

// A completed manual example: a fix of this kind the owner made themselves
// that has not been undone.
async function example(db,workspaceId,type,actorId){
  return (await db.query(`SELECT id FROM ${fixes} WHERE workspace_id=$1 AND kind=$2 AND status='DONE' AND NOT automatic AND decided_by=$3
    ORDER BY decided_at DESC,id LIMIT 1`,[workspaceId,type,actorId])).rows[0]||null;
}

async function gates(c,workspaceId){
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {draft:false,account};
  const person=(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0];
  if(!person)return {draft:false,account};
  await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[workspaceId]);
  let blocked=await policy.stopped(c,workspaceId,account,ACTION,true);
  if(!blocked&&!(await require('../autopilot/postgres-service').getState(c,workspaceId)).canAutomate)blocked='Handle routine work is off for this inventory.';
  return {draft:true,account,owner:person.id,blocked,workspaceId};
}

// Whether this fix may be made without a person right now, and if not, why.
async function authority(c,gate,o){
  if(!policy.permits(gate.account.plan,JOB,'automatic',{trained:true}))return {reason:'A person approves each fix on this plan.'};
  const rule=await loadRule(c,gate.workspaceId,o.kind,{lock:true}),mode=policy.allowance(gate.account.plan,JOB);
  if(mode==='trained'){
    if(!rule||!rule.enabled)return {reason:'Approve one fix of this kind yourself and save a daily limit to let StockChief make it on its own.'};
    if(!rule.current)return {reason:'The limit was saved by someone who is no longer the owner. Save it again.'};
    const taught=rule.example_fix_id?Boolean(await example(c,gate.workspaceId,o.kind,rule.authorized_by)):false;
    if(!policy.permits(gate.account.plan,JOB,'automatic',{trained:taught}))return {reason:'Approve one fix of this kind yourself, then save its limit again.'};
  }else if(rule&&!rule.enabled)return {reason:'You chose to approve every fix of this kind yourself.'};
  const limit=rule?.enabled?rule.daily_limit:DEFAULT_DAILY;
  const made=Number((await c.query(`SELECT count(*) FROM ${fixes} WHERE workspace_id=$1 AND kind=$2 AND status='DONE' AND automatic
    AND decided_at>clock_timestamp()-interval '1 day'`,[gate.workspaceId,o.kind])).rows[0].count);
  if(made>=limit)return {reason:'This is over your limit of '+limit+' '+kindLabels[o.kind].toLowerCase()+' fixed a day.'};
  if(await closed(c,gate.workspaceId,o)==='UNDONE')return {reason:'You undid this fix before. It waits for you now.'};
  return {rule};
}

// ---- Making the fix through the catalog services ----------------------------

async function history(c,ctx,sku,action,before,after){await maintenance.history(c,ctx,{id:sku.id,item_id:sku.item_id},action,before,after);}

async function mergeIn(c,ctx,o){
  const d=o.details,ws=ctx.workspaceId,dupId=o.skuId,keepId=o.targetSkuId;
  await c.query('SELECT id FROM items WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[ws,[d.itemId,d.keeper.itemId]]);
  const skus=new Map((await c.query('SELECT id,item_id,code,barcode,is_active FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[ws,[dupId,keepId]])).rows.map(r=>[r.id,r]));
  const dup=skus.get(dupId),keep=skus.get(keepId);
  if(!dup||!keep||!Number(dup.is_active)||!Number(keep.is_active))throw new ValidationError('One of these products was archived. Check again for a fresh fix.');
  // The duplicate must hold nothing that a merge would have to move.
  if((await c.query(`SELECT 1 FROM balances WHERE sku_id=$1 AND (on_hand<>0 OR coalesce(secondary_on_hand,0)<>0) UNION ALL
      SELECT 1 FROM accounting_inventory_cost_balances WHERE workspace_id=$2 AND sku_id=$1 AND (quantity_units<>0 OR total_cost_minor<>0) LIMIT 1`,[dupId,ws])).rowCount)
    throw new ValidationError(dup.code+' now holds stock. Move it to '+keep.code+' yourself first.');
  const work=await pendingWork(c,ws,dup);
  if(work)throw new ValidationError(work);
  const applied={dupItemId:dup.item_id,keepItemId:keep.item_id,supplierLinks:[],mappings:[],barcode:null,archived:null};
  // Supplier terms: the kept product gets each supplier it does not have yet.
  const dupLinks=(await c.query('SELECT * FROM supplier_items WHERE workspace_id=$1 AND sku_id=$2 AND is_active=1 ORDER BY id',[ws,dupId])).rows;
  const keepLinks=(await c.query('SELECT supplier_id,is_active FROM supplier_items WHERE workspace_id=$1 AND sku_id=$2',[ws,keepId])).rows;
  const twoDecimals=v=>v==null?null:Math.abs(Math.round(Number(v)*100)-Number(v)*100)<=1e-6?Number(v):null;
  const add=dupLinks.filter(l=>!keepLinks.some(k=>k.supplier_id===l.supplier_id)).map(l=>({supplierId:l.supplier_id,skuId:keepId,expectAbsent:true,
    supplierSku:l.supplier_sku,purchaseUnit:l.purchase_unit,unitsPerPurchaseUnit:Number(l.units_per_purchase_unit),lastUnitCost:twoDecimals(l.last_unit_cost),
    leadTimeDays:l.lead_time_days==null?null:Number(l.lead_time_days),minimumOrderQuantity:l.minimum_order_quantity==null?null:Number(l.minimum_order_quantity),
    orderMultiple:l.order_multiple==null?null:Number(l.order_multiple),notes:l.notes,
    isPreferred:Boolean(Number(l.is_preferred))&&!keepLinks.some(k=>Number(k.is_active))}));
  if(add.length)applied.supplierLinks=(await require('../operations/postgres-commerce').linkSupplierItemsInTransaction(c,ctx,add)).map(r=>r.id);
  // Sales channel listings now point at the kept product.
  applied.mappings=(await c.query(`UPDATE connection_mappings SET foundry_record_id=$3,updated_at=$4 WHERE workspace_id=$1 AND entity_type='sku'
    AND foundry_record_id=$2 RETURNING id`,[ws,dupId,keepId,nowIso()])).rows.map(r=>r.id);
  // The barcode moves when the kept product has none.
  const barcode=String(dup.barcode||'').trim();
  if(barcode&&!String(keep.barcode||'').trim()){
    await maintenance.update(scoped(c),ctx,dup.item_id,dupId,{barcode:'',expectedBarcode:dup.barcode||''});
    await maintenance.update(scoped(c),ctx,keep.item_id,keepId,{barcode,expectedBarcode:keep.barcode||''});
    applied.barcode=barcode;
  }
  // Archive the duplicate. Its history stays on its own record.
  const others=Number((await c.query('SELECT count(*) FROM skus WHERE workspace_id=$1 AND item_id=$2 AND id<>$3 AND is_active=1',[ws,dup.item_id,dupId])).rows[0].count);
  if(others){await maintenance.update(scoped(c),ctx,dup.item_id,dupId,{active:false});applied.archived='sku';}
  else{await require('../domain/postgres-catalog-service').archiveZeroStockItemsInTransaction(c,ctx,[dup.item_id]);applied.archived='item';}
  await history(c,ctx,dup,'catalog_merge',{active:true},{mergedInto:keepId,code:keep.code});
  await history(c,ctx,keep,'catalog_merge',{},{mergedFrom:dupId,code:dup.code,supplierLinks:applied.supplierLinks.length,channelLinks:applied.mappings.length});
  return applied;
}

async function unmerge(c,ctx,fix){
  const a=fix.applied,ws=ctx.workspaceId,dupId=fix.sku_id,keepId=fix.target_sku_id;
  await c.query('SELECT id FROM items WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[ws,[a.dupItemId,a.keepItemId]]);
  const skus=new Map((await c.query('SELECT id,item_id,code,barcode,is_active FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[ws,[dupId,keepId]])).rows.map(r=>[r.id,r]));
  const dup=skus.get(dupId),keep=skus.get(keepId);
  if(!dup||!keep)throw new ValidationError('One of these products was deleted. The merge cannot be undone.');
  if(Number(dup.is_active))throw new ValidationError(dup.code+' was already restored.');
  if(a.barcode&&String(keep.barcode||'').trim()!==a.barcode)throw new ValidationError('The barcode on '+keep.code+' changed after the merge. Change it on the product.');
  if(!(await codeFree(c,ws,dupId,dup.code)))throw new ValidationError('Another product now uses '+dup.code+'. Change one SKU before restoring it.');
  if(a.archived==='item'){
    const entitlements=require('../commercial/entitlements');
    await entitlements.assertMeterCapacity(c,await entitlements.ownerScopeForWorkspace(c,ws),'products',1);
    await c.query('UPDATE items SET is_active=1,updated_at=$3 WHERE workspace_id=$1 AND id=$2',[ws,dup.item_id,nowIso()]);
    await c.query('UPDATE skus SET is_active=1 WHERE workspace_id=$1 AND id=$2',[ws,dupId]);
  }else await maintenance.update(scoped(c),ctx,dup.item_id,dupId,{active:true});
  if(a.barcode){
    await maintenance.update(scoped(c),ctx,keep.item_id,keepId,{barcode:'',expectedBarcode:keep.barcode||''});
    await maintenance.update(scoped(c),ctx,dup.item_id,dupId,{barcode:a.barcode,expectedBarcode:dup.barcode||''});
  }
  if(a.mappings.length)await c.query(`UPDATE connection_mappings SET foundry_record_id=$3,updated_at=$5 WHERE workspace_id=$1 AND id=ANY($4::text[])
    AND entity_type='sku' AND foundry_record_id=$2`,[ws,keepId,dupId,a.mappings,nowIso()]);
  if(a.supplierLinks.length)await c.query(`UPDATE supplier_items SET is_active=0,is_preferred=0,updated_at=$4 WHERE workspace_id=$1 AND sku_id=$2 AND id=ANY($3::text[])`,
    [ws,keepId,a.supplierLinks,nowIso()]);
  await history(c,ctx,dup,'catalog_unmerge',{mergedInto:keepId},{active:true});
  await history(c,ctx,keep,'catalog_unmerge',{mergedFrom:dupId},{});
}

// Reads a person's choice or typed value for a fix that asks.
async function chosen(c,ctx,o,input){
  const d=o.details,pick=String(input.choice??'').trim();
  const candidate=pick!==''&&/^\d+$/.test(pick)?d.candidates?.[Number(pick)]:null;
  if(pick!==''&&!candidate)throw new ValidationError('Choose one of the recorded values.');
  if(o.kind==='COST'){
    if(candidate)return {amountMinor:candidate.amountMinor,currency:candidate.currency};
    const currency=money.code(String(input.currency||'').trim()||d.candidates?.[0]?.currency||
      (await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.base_currency||'USD');
    return {amountMinor:money.userToMinor(input.amount,currency,{label:'Purchase cost'}),currency};
  }
  if(o.kind==='WEIGHT'){
    if(candidate)return {grams:candidate.grams};
    const value=String(input.grams??'').trim();
    if(!value)throw new ValidationError('Enter the weight in grams.');
    return {grams:grams(require('../domain/physical-measure').convert(value,{label:'Weight in grams'}))};
  }
  if(o.kind==='SKU'){
    const code=String(input.code??'').trim();
    if(!code)throw new ValidationError('Enter the new SKU.');
    if(!SAFE.test(code)||code.length>120)throw new ValidationError('Use up to 120 letters, numbers, hyphens, underscores, periods or slashes.');
    return {code};
  }
  return null;
}

async function act(c,ctx,fix,o,{automatic,rule=null,value=null}){
  const ws=ctx.workspaceId,d=o.details;
  let applied;
  if(o.kind==='MERGE')applied=await mergeIn(c,ctx,o);
  else{
    const sku=(await c.query('SELECT id,item_id,code,weight_grams FROM skus WHERE workspace_id=$1 AND id=$2 AND is_active=1 FOR UPDATE',[ws,o.skuId])).rows[0];
    if(!sku)throw new ValidationError('This product was archived. Check again for a fresh fix.');
    if(o.kind==='COST'){
      const v=value||d.after;
      if((await c.query('SELECT 1 FROM sku_purchase_costs WHERE workspace_id=$1 AND sku_id=$2 LIMIT 1',[ws,sku.id])).rowCount)
        throw new ValidationError('A purchase cost was added since. Check again for a fresh fix.');
      const [saved]=await require('../pricing/postgres-service').setPurchaseCostsInTransaction(c,ctx,[{skuId:sku.id,amountMinor:v.amountMinor,currency:v.currency,
        source:'agent_catalog_fix',sourceDetail:{fixId:fix.id,from:value?'person':d.source}}]);
      applied={costId:saved.id,amountMinor:v.amountMinor,currency:v.currency};
    }else if(o.kind==='WEIGHT'){
      const v=value||d.after;
      const changed=await c.query('UPDATE skus SET weight_grams=$3 WHERE workspace_id=$1 AND id=$2 AND NOT coalesce(weight_grams>0,false)',[ws,sku.id,v.grams]);
      if(changed.rowCount!==1)throw new ValidationError('A weight was added since. Check again for a fresh fix.');
      await history(c,ctx,sku,'catalog_fix_weight',{weightGrams:null},{weightGrams:v.grams,from:value?'person':d.source});
      applied={grams:v.grams};
    }else{
      const next=value?.code||d.after;
      if(!(await codeFree(c,ws,sku.id,next)))throw new ValidationError('Another product already uses '+next+'. Enter a different SKU.');
      const changed=await c.query('UPDATE skus SET code=$3 WHERE workspace_id=$1 AND id=$2 AND code=$4',[ws,sku.id,next,d.code]);
      if(changed.rowCount!==1)throw new ValidationError('The SKU changed since. Check again for a fresh fix.');
      await history(c,ctx,sku,'catalog_fix_code',{code:d.code},{code:next});
      applied={before:d.code,after:next};
    }
  }
  await c.query(`UPDATE ${fixes} SET status='DONE',automatic=$3,decided_by=$4,decided_at=clock_timestamp(),rule_revision=$5,reason=NULL,would_apply=false,applied=$6
    WHERE workspace_id=$1 AND id=$2`,[ws,fix.id,automatic,ctx.actorId,rule?.revision??null,JSON.stringify(applied)]);
  await audit.record(c,ctx,{action:automatic?'Catalog fix made on its own':'Catalog fix approved',reference:fix.id,
    after:{kind:o.kind,sku:d.code,keeper:d.keeper?.code||null,change:applied,limit:automatic?(rule?.enabled?rule.daily_limit:DEFAULT_DAILY):null}});
  return {kind:o.kind,id:fix.id,applied};
}

// One option: make it within the owner's limits, or leave it for a person.
async function decide(c,gate,o){
  if(await closed(c,gate.workspaceId,o)==='DISMISSED')return 'dismissed';
  if(o.hold||o.ask){await record(c,gate.workspaceId,o);return 'held';}
  const allowed=await authority(c,gate,o);
  if(allowed.reason||gate.blocked){
    await record(c,gate.workspaceId,o,{reason:allowed.reason||gate.blocked,wouldApply:!allowed.reason});
    return 'draft';
  }
  const fix=await record(c,gate.workspaceId,o);
  await c.query('SAVEPOINT catalog_fix');
  try{
    await act(c,{workspaceId:gate.workspaceId,actorId:gate.owner},fix,o,{automatic:true,rule:allowed.rule});
    await c.query('RELEASE SAVEPOINT catalog_fix');
    return 'done';
  }catch(error){
    if(!expected(error))throw error;
    await c.query('ROLLBACK TO SAVEPOINT catalog_fix');
    await record(c,gate.workspaceId,o,{reason:error.message});
    return 'draft';
  }
}

// ---- The routine ------------------------------------------------------------

// Worker: merges first, then SKU, cost and weight fixes page by page.
async function run(job,database){
  const workspaceId=job.workspaceId,started=new Date().toISOString(),seen=new Set(),totals={done:0,draft:0,held:0,dismissed:0};
  const key=o=>o.kind+':'+o.skuId;
  const merges=await tx(database,async c=>{
    const gate=await gates(c,workspaceId);
    if(!gate.draft)return null;
    const found=await mergeOptions(c,workspaceId);
    for(const o of found.options.values()){seen.add(key(o));totals[await decide(c,gate,o)]++;}
    return {skip:new Set(found.options.keys())};
  });
  if(!merges)return {skipped:true,...totals};
  let after=null;
  for(let page=1;page<=500;page++){
    const batch=await tx(database,async c=>{
      const gate=await gates(c,workspaceId);
      if(!gate.draft)return null;
      const rows=await problemRows(c,workspaceId,{after,limit:200});
      for(const o of await skuOptions(c,workspaceId,rows,{skip:merges.skip})){seen.add(key(o));totals[await decide(c,gate,o)]++;}
      return {last:rows.at(-1)?.id,more:rows.length===200};
    });
    if(!batch)return {skipped:true,...totals};
    after=batch.last;
    if(!batch.more)break;
  }
  // Fixes whose problem is gone are no longer needed.
  await tx(database,async c=>{
    const open=(await c.query(`SELECT id,kind,sku_id FROM ${fixes} WHERE workspace_id=$1 AND status IN ('DRAFT','HELD') AND checked_at<$2`,[workspaceId,started])).rows
      .filter(f=>!seen.has(f.kind+':'+f.sku_id));
    if(open.length)await c.query(`UPDATE ${fixes} SET status='DISMISSED',reason='The product no longer needs this fix.',decided_at=clock_timestamp()
      WHERE workspace_id=$1 AND id=ANY($2::text[]) AND status IN ('DRAFT','HELD')`,[workspaceId,open.map(f=>f.id)]);
  });
  return totals;
}

async function enabled(c,workspaceId){
  const account=await policy.accountState(c,workspaceId);
  return policy.usesAgentTerms(account)&&policy.permits(account.plan,JOB,'draft');
}
// The routine checks once a business day, after each import, and whenever the
// owner saves a limit or asks to check now.
async function schedule(c,workspaceId,cycleId){
  if(!await enabled(c,workspaceId))return {queued:false};
  const today=await require('../lib/business-time').today(c,workspaceId);
  return {queued:(await jobs.enqueue(scoped(c),{workspaceId,kind,idempotencyKey:'catalog-fixes:day:'+today,payload:{cycleId},priority:70,maxAttempts:3})).created};
}
async function afterImport(c,workspaceId,importId){
  if(!await enabled(c,workspaceId))return {queued:false};
  return {queued:(await jobs.enqueue(scoped(c),{workspaceId,kind,idempotencyKey:'catalog-fixes:import:'+importId,payload:{importId},priority:60,maxAttempts:3})).created};
}
async function check(db,ctx){
  return tx(db,async c=>{
    await access(c,ctx,{lock:true});
    return {queued:(await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,idempotencyKey:'catalog-fixes:check:'+Math.floor(Date.now()/60000),
      payload:{requestedBy:ctx.actorId},priority:55,maxAttempts:3})).created};
  });
}

// ---- A person's decisions ---------------------------------------------------

async function load(db,ctx,id,{lock=false}={}){
  const row=(await db.query(`SELECT * FROM ${fixes} WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[ctx.workspaceId,String(id||'')])).rows[0];
  if(!row)throw new NotFoundError('That product fix is not in this inventory.');
  return row;
}

// The same fix as it would be prepared now, or null when the facts changed.
async function live(c,ctx,fix,cache){
  if(fix.kind==='MERGE'){
    cache.merges??=await mergeOptions(c,ctx.workspaceId);
    return cache.merges.options.get(fix.sku_id)||null;
  }
  const rows=await problemRows(c,ctx.workspaceId,{skuIds:[fix.sku_id],limit:1});
  return (await skuOptions(c,ctx.workspaceId,rows)).find(o=>o.kind===fix.kind)||null;
}

async function approveIn(c,ctx,id,input,cache){
  const fix=await load(c,ctx,id,{lock:true});
  if(fix.status==='DONE'&&input.fingerprint===fix.fingerprint)return {replayed:true,id:fix.id,kind:fix.kind};
  if(!['DRAFT','HELD'].includes(fix.status))throw new ValidationError('This fix is no longer waiting for you.');
  if(input.confirmed!=='yes'||input.fingerprint!==fix.fingerprint)throw new ValidationError('Review the current fix and confirm it.');
  const o=await live(c,ctx,fix,cache);
  if(!o||o.fingerprint!==fix.fingerprint)throw new ValidationError('The product changed since this fix was prepared. Check again for a fresh fix.');
  if(o.hold)throw new ValidationError(o.hold);
  const value=o.ask&&o.kind!=='MERGE'?await chosen(c,ctx,o,input):null;
  return act(c,ctx,fix,o,{automatic:false,value});
}

// A person approves one exact fix, giving a value when the fix asks for one.
async function approve(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true,stop:true});
    return approveIn(c,ctx,id,input,{});
  });
}

// A person approves the bulk fix list: every ready fix they ticked.
async function approveMany(database,ctx,input={}){
  const chosenFixes=[...new Set((Array.isArray(input.fix)?input.fix:[input.fix]).filter(Boolean).map(String))];
  if(!chosenFixes.length||chosenFixes.length>200)throw new ValidationError('Tick between 1 and 200 fixes to approve.');
  if(input.confirmed!=='yes')throw new ValidationError('Confirm the fixes you ticked.');
  return tx(database,async c=>{
    await access(c,ctx,{lock:true,stop:true});
    const cache={},result={done:0,failed:[]};
    for(const entry of chosenFixes){
      const [id,fingerprint]=entry.split(':');
      await c.query('SAVEPOINT catalog_bulk_fix');
      try{
        const fix=await load(c,ctx,id);
        if(fix.status==='HELD')throw new ValidationError('This fix needs your answer first.');
        const done=await approveIn(c,ctx,id,{confirmed:'yes',fingerprint},cache);
        await c.query('RELEASE SAVEPOINT catalog_bulk_fix');
        if(!done.replayed)result.done++;
      }catch(error){
        if(!expected(error))throw error;
        await c.query('ROLLBACK TO SAVEPOINT catalog_bulk_fix');
        result.failed.push({id,reason:error.message});
      }
    }
    if(result.done)await audit.record(c,ctx,{action:'Catalog fixes approved in bulk',reference:'catalog-fixes',after:{approved:result.done,stopped:result.failed.length}});
    return result;
  });
}

async function dismiss(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true});
    const fix=await load(c,ctx,id,{lock:true});
    if(fix.status==='DISMISSED')return {replayed:true};
    if(!['DRAFT','HELD'].includes(fix.status))throw new ValidationError('This fix is no longer waiting for you.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that the product stays as it is.');
    await c.query(`UPDATE ${fixes} SET status='DISMISSED',reason='You kept the product as it is.',decided_by=$3,decided_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Catalog fix dismissed',reference:id,after:{kind:fix.kind,sku:fix.details.code}});
    return {dismissed:true};
  });
}

// What can still be undone: the change is still the one the fix made.
async function undoable(db,ctx,fix){
  if(fix.status!=='DONE')return false;
  const a=fix.applied,ws=ctx.workspaceId;
  if(fix.kind==='COST')return (await db.query('SELECT id FROM sku_purchase_costs WHERE workspace_id=$1 AND sku_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[ws,fix.sku_id])).rows[0]?.id===a.costId;
  if(fix.kind==='WEIGHT')return (await db.query('SELECT 1 FROM skus WHERE workspace_id=$1 AND id=$2 AND weight_grams=$3::numeric',[ws,fix.sku_id,a.grams])).rowCount>0;
  if(fix.kind==='SKU')return (await db.query('SELECT 1 FROM skus WHERE workspace_id=$1 AND id=$2 AND code=$3',[ws,fix.sku_id,a.after])).rowCount>0;
  return (await db.query('SELECT 1 FROM skus WHERE workspace_id=$1 AND id=$2 AND is_active=0',[ws,fix.sku_id])).rowCount>0;
}

async function undo(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true});
    const fix=await load(c,ctx,id,{lock:true});
    if(fix.status==='UNDONE')return {replayed:true};
    if(fix.status!=='DONE')throw new ValidationError('Only a fix that was made can be undone.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that this fix is undone.');
    const a=fix.applied,ws=ctx.workspaceId;
    const sku=(await c.query('SELECT id,item_id,code FROM skus WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ws,fix.sku_id])).rows[0];
    if(fix.kind==='COST'){
      if(!(await undoable(c,ctx,fix)))throw new ValidationError('The purchase cost changed after this fix. Change it on the product.');
      await c.query('DELETE FROM sku_purchase_costs WHERE workspace_id=$1 AND id=$2',[ws,a.costId]);
      await history(c,ctx,sku,'catalog_fix_cost_undone',{amountMinor:a.amountMinor,currency:a.currency},{});
    }else if(fix.kind==='WEIGHT'){
      const changed=await c.query('UPDATE skus SET weight_grams=NULL WHERE workspace_id=$1 AND id=$2 AND weight_grams=$3::numeric',[ws,fix.sku_id,a.grams]);
      if(!changed.rowCount)throw new ValidationError('The weight changed after this fix. Change it on the product.');
      await history(c,ctx,sku,'catalog_fix_weight_undone',{weightGrams:a.grams},{weightGrams:null});
    }else if(fix.kind==='SKU'){
      if(sku.code!==a.after)throw new ValidationError('The SKU changed after this fix. Change it on the product.');
      if(!(await codeFree(c,ws,sku.id,a.before)))throw new ValidationError('Another product now uses “'+a.before+'”.');
      await c.query('UPDATE skus SET code=$3 WHERE workspace_id=$1 AND id=$2',[ws,sku.id,a.before]);
      await history(c,ctx,sku,'catalog_fix_code_undone',{code:a.after},{code:a.before});
    }else await unmerge(c,ctx,fix);
    await c.query(`UPDATE ${fixes} SET status='UNDONE',decided_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ws,id]);
    await audit.record(c,ctx,{action:'Catalog fix undone',reference:id,after:{kind:fix.kind,sku:fix.details.code,automatic:fix.automatic}});
    return {undone:true,kind:fix.kind};
  });
}

// The owner's daily limit for one kind of fix. Pro needs a completed manual example.
async function configure(database,ctx,type,input={}){
  if(!KINDS.includes(type))throw new ValidationError('Choose a merge, SKU, cost or weight limit.');
  return tx(database,async c=>{
    await owner(c,ctx,{lock:true});
    const state=await policy.accountState(c,ctx.workspaceId);
    policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,JOB,'automatic',{trained:true});
    const prior=(await c.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND kind=$2 FOR UPDATE`,[ctx.workspaceId,type])).rows[0];
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the page to see the current limit.');
    if(input.stop==='yes'){
      if(!prior||prior.enabled){
        await c.query(`INSERT INTO ${rules} AS r(workspace_id,kind,enabled,daily_limit,authorized_by) VALUES($1,$2,false,$3,$4)
          ON CONFLICT(workspace_id,kind) DO UPDATE SET enabled=false,revision=r.revision+1,updated_at=clock_timestamp()`,[ctx.workspaceId,type,DEFAULT_DAILY,ctx.actorId]);
        await audit.record(c,ctx,{action:'Catalog fix limit stopped',reference:type});
      }
      return {stopped:true};
    }
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the limit before saving it.');
    const limit=Number(String(input.dailyLimit??'').trim());
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new ValidationError('Enter how many fixes of this kind a day, from 1 to 1,000.');
    const trained=policy.allowance(state.plan,JOB)==='trained',taught=trained?await example(c,ctx.workspaceId,type,ctx.actorId):null;
    if(trained&&!taught)throw new ValidationError('Approve one fix of this kind yourself first.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'catalog-fix-rule:'+type+':'+((prior?.revision||0)+1),4096,{finished:true});
    await c.query(`INSERT INTO ${rules} AS r(workspace_id,kind,daily_limit,authorized_by,example_fix_id) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(workspace_id,kind) DO UPDATE SET enabled=true,daily_limit=excluded.daily_limit,authorized_by=excluded.authorized_by,
      example_fix_id=excluded.example_fix_id,revision=r.revision+1,updated_at=clock_timestamp()`,[ctx.workspaceId,type,limit,ctx.actorId,taught?.id||null]);
    await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,idempotencyKey:'catalog-fixes:rule:'+type+':'+((prior?.revision||0)+1),payload:{},priority:55,maxAttempts:3});
    await audit.record(c,ctx,{action:'Catalog fix limit saved',reference:type,before:prior?{enabled:prior.enabled,dailyLimit:prior.daily_limit}:{},
      after:{dailyLimit:limit,example:taught?.id||null}});
    return {saved:true};
  });
}

// ---- Pages ------------------------------------------------------------------

const labels={DRAFT:'Ready',HELD:'Needs you',DONE:'Done',DISMISSED:'Kept as it is',UNDONE:'Undone'};
async function page(db,ctx,{page:number=1,kind:type=''}={}){
  const state=await access(db,ctx);
  number=Number(number);
  if(!Number.isSafeInteger(number)||number<1||number>1000000)throw new ValidationError('Choose a valid page.');
  type=KINDS.includes(String(type).toUpperCase())?String(type).toUpperCase():'';
  const counts=(await db.query(`SELECT kind,count(*) FILTER(WHERE status='DRAFT')::int AS ready,count(*) FILTER(WHERE status='HELD')::int AS held
    FROM ${fixes} WHERE workspace_id=$1 AND status IN ('DRAFT','HELD') GROUP BY kind`,[ctx.workspaceId])).rows;
  const waiting=(await db.query(`SELECT * FROM ${fixes} WHERE workspace_id=$1 AND status IN ('DRAFT','HELD') AND ($3='' OR kind=$3)
    ORDER BY status,array_position(ARRAY['MERGE','SKU','COST','WEIGHT'],kind),(details->>'name'),(details->>'code'),id LIMIT 51 OFFSET $2`,
  [ctx.workspaceId,(number-1)*50,type])).rows;
  const recent=(await db.query(`SELECT * FROM ${fixes} WHERE workspace_id=$1 AND status IN ('DONE','UNDONE') ORDER BY decided_at DESC,id LIMIT 25`,[ctx.workspaceId])).rows;
  const done=[];
  for(const f of recent)done.push({...f,text:doneText(f),
    label:f.status==='UNDONE'?'Undone':f.automatic?'Made on its own':'Approved by you',undoable:await undoable(db,ctx,f),
    link:'/inventory/'+encodeURIComponent(f.kind==='MERGE'?f.details.keeper.itemId:f.details.itemId)});
  const mode=policy.allowance(state.plan,JOB),limits=[];
  if(policy.permits(state.plan,JOB,'automatic',{trained:true}))for(const k of KINDS){
    const rule=await loadRule(db,ctx.workspaceId,k);
    const canTeach=mode!=='trained'||Boolean(await example(db,ctx.workspaceId,k,ctx.actorId));
    const on=mode==='trained'?Boolean(rule?.enabled&&rule.example_fix_id&&await example(db,ctx.workspaceId,k,rule.authorized_by)):!rule||rule.enabled;
    limits.push({kind:k,label:kindLabels[k],rule,canTeach,on,dailyLimit:rule?.enabled?rule.daily_limit:mode==='trained'?null:DEFAULT_DAILY});
  }
  const stop=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
  return {mode,stop,page:number,kind:type,more:waiting.length>50,kinds:KINDS.map(k=>({kind:k,label:kindLabels[k],...(counts.find(r=>r.kind===k)||{ready:0,held:0})})),
    waiting:waiting.slice(0,50).map(f=>({...f,text:describe(f),label:labels[f.status],blocked:Boolean(f.details.blocked)})),done,limits};
}

async function inbox(db,workspaceId){
  if(!await require('../db/schema-installed').has(db,fixes))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const row=(await db.query(`SELECT count(*) FILTER(WHERE status='DRAFT')::int AS ready,count(*) FILTER(WHERE status='HELD')::int AS held,
    min(created_at) AS at FROM ${fixes} WHERE workspace_id=$1 AND status IN ('DRAFT','HELD')`,[workspaceId])).rows[0];
  if(!row.ready&&!row.held)return [];
  return [{kind:'catalog',importance:'Needs You',priority:45,grouped:true,title:'Product data fixes need you',
    happened:[row.ready?row.ready+(row.ready===1?' fix is':' fixes are')+' ready for your approval.':null,
      row.held?row.held+(row.held===1?' fix needs':' fixes need')+' your answer.':null].filter(Boolean).join(' '),
    why:'Duplicates, missing costs and weights, and bad SKUs cause wrong orders, wrong margins and rejected listings.',
    recommendation:'Approve the bulk fix list, or answer the fixes that ask.',href:path,actionLabel:'Review product fixes',sourceId:'catalog-fixes',at:row.at,createdAt:row.at}];
}

// The live review behind the agent reviews list. Starter gets one suggestion.
async function review(db,ctx,{filter='',page=1}={}){
  const merges=await mergeOptions(db,ctx.workspaceId);
  const rows=await problemRows(db,ctx.workspaceId,{filter,include:[...merges.options.keys()],order:'name',limit:101,offset:(page-1)*100});
  const more=rows.length>100,shown=rows.slice(0,100);
  const found=await skuOptions(db,ctx.workspaceId,shown,{skip:new Set(merges.options.keys())});
  const all=[...shown.map(r=>merges.options.get(r.id)).filter(Boolean),...found];
  return {more,summary:'Products with duplicates, missing purchase cost or weight, or SKUs sales channels reject. Each line says how it can be fixed.',
    rows:shown.map(r=>{const mine=all.filter(o=>o.skuId===r.id);return {Product:r.name,SKU:r.code,
      'What to fix':mine.map(explain).join('. ')||'Review this product',
      'Fix ready':mine.length&&mine.every(o=>!o.hold&&!o.ask)?'Yes':'Needs you',link:'/inventory/'+r.item_id};})};
}

// Product page notes: what was merged into this product, or where it went.
async function merged(db,workspaceId,itemId){
  if(!await require('../db/schema-installed').has(db,fixes))return [];
  return (await db.query(`SELECT f.details->>'code' AS from_code,f.details->>'itemId' AS from_item,f.details#>>'{keeper,code}' AS to_code,
      f.details#>>'{keeper,itemId}' AS to_item,f.details#>>'{keeper,itemId}'=$2 AS kept,f.decided_at
    FROM ${fixes} f WHERE f.workspace_id=$1 AND f.kind='MERGE' AND f.status='DONE'
      AND (f.details#>>'{keeper,itemId}'=$2 OR f.details->>'itemId'=$2) ORDER BY f.decided_at DESC,f.id LIMIT 20`,[workspaceId,itemId])).rows;
}

const definition={id:JOB,key:'catalog-fixes',label:'Find duplicates and missing product data',readPage:review};

module.exports={JOB,ACTION,kind,path,KINDS,SAFE,SAFE_SQL,DUPLICATES,mergeOptions,problemRows,skuOptions,describe,run,schedule,afterImport,check,
  approve,approveMany,dismiss,undo,configure,page,inbox,review,merged,load,definition};

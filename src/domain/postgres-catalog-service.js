'use strict';

const { ValidationError, NotFoundError } = require('./errors');
const { TRACKING_MODE_IDS } = require('./constants');
const { newId, nowIso, trimOrNull, requireText, requireOneOf } = require('../lib/util');
const { parseOptions, codeSlug } = require('./item-service');
const identity=require('./catalog-identity');

function normaliseBoolean(value) {
  return value === true || value === '1' || value === 'on';
}

function combinations(options) {
  return options.reduce((rows, option) => rows.flatMap((row) => option.values.map((value) => [
    ...row,
    { optionId: option.id, value },
  ])), [[]]);
}

async function uniqueCode(client, workspaceId, candidate, taken) {
  const base = candidate || 'SKU';
  let code = base;
  let suffix = 1;
  while (taken.has(code.toLowerCase()) || (await client.query(
    'SELECT 1 FROM skus WHERE workspace_id=$1 AND lower(btrim(code))=lower(btrim($2)) LIMIT 1',
    [workspaceId, code]
  )).rows.length) {
    suffix += 1;
    code = `${base}-${suffix}`;
  }
  taken.add(code.toLowerCase());
  return code;
}

async function createItemInTransaction(client, ctx, input) {
  const name = requireText(input.name, 'Item name', { max: 240 });
  const trackingMode = requireOneOf(input.trackingMode, TRACKING_MODE_IDS, 'Tracking type');
  if(['lot','serial'].includes(trackingMode))await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'inventory.lot_serial');
  const hasVariants = normaliseBoolean(input.hasVariants);
  const baseCode = trimOrNull(input.baseCode);
  const description = trimOrNull(input.description);
  const unitLabel = identity.unitLabel(input.unitLabel);
  const options = hasVariants ? parseOptions(input.options) : [];
  if(!(await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [`catalog:${ctx.workspaceId}`])).rows[0].acquired)
    throw new ValidationError('Another product update is running in this inventory. Wait for it to finish, then add this product. Nothing from this form was saved.',{reason:'catalog_busy'});
    if (baseCode) {
      const clash = await client.query('SELECT 1 FROM items WHERE workspace_id=$1 AND (lower(btrim(base_code))=lower(btrim($2)) OR id IN (SELECT item_id FROM skus WHERE workspace_id=$1 AND lower(btrim(code))=lower(btrim($2)))) LIMIT 1',
        [ctx.workspaceId, baseCode]);
      if (clash.rows.length) throw new ValidationError(`Another item already uses the code ${baseCode}.`, { field: 'baseCode' });
    }
    const commercialScope=await require('../commercial/entitlements').ownerScopeForWorkspace(client,ctx.workspaceId);
    await require('../commercial/entitlements').assertMeterCapacity(client,commercialScope,'products',1);
    const at = nowIso();
    const itemId = newId('item');
    await client.query(`INSERT INTO items(id,workspace_id,name,base_code,description,unit_label,tracking_mode,
      has_variants,allow_negative,is_active,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,1,$9,$9)`,
    [itemId, ctx.workspaceId, name, baseCode, description, unitLabel, trackingMode, hasVariants ? 1 : 0, at]);
    const optionRows = [];
    for (const [position, option] of options.entries()) {
      const row = { ...option, id: newId('opt') };
      await client.query(`INSERT INTO item_options(id,workspace_id,item_id,name,position)
        VALUES($1,$2,$3,$4,$5)`, [row.id, ctx.workspaceId, itemId, row.name, position]);
      optionRows.push(row);
    }
    const variants = hasVariants ? combinations(optionRows) : [[]];
    const taken = new Set();
    const skuIds = [];
    for (const [position, variant] of variants.entries()) {
      const label = variant.length ? variant.map((part) => part.value).join(' / ') : null;
      const codeBase = [baseCode || codeSlug(name), ...variant.map((part) => codeSlug(part.value))]
        .filter(Boolean).join('-');
      const code = await uniqueCode(client, ctx.workspaceId, codeBase, taken);
      const skuId = newId('sku');
      await client.query(`INSERT INTO skus(id,workspace_id,item_id,code,variant_label,is_default,position,is_active,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)`,
      [skuId, ctx.workspaceId, itemId, code, label, variant.length ? 0 : 1, position, at]);
      for (const part of variant) {
        await client.query('INSERT INTO sku_option_values(sku_id,option_id,value) VALUES($1,$2,$3)',
          [skuId, part.optionId, part.value]);
      }
      skuIds.push(skuId);
    }
  const pricing=require('../pricing/postgres-service'),money=require('./currency'),currency=money.code(input.currency||'USD');
  if(input.sellingPrice!=null&&String(input.sellingPrice).trim()!=='')await pricing.setPricesInTransaction(client,ctx,skuIds.map(skuId=>({skuId,amount:input.sellingPrice,currency})),{initialize:true});
  if(input.purchaseCost!=null&&String(input.purchaseCost).trim()!=='')for(const skuId of skuIds)await pricing.setPurchaseCostInTransaction(client,ctx,{skuId,amount:input.purchaseCost,currency});
  const physical={};for(const[key,column]of Object.entries({weightGrams:'weight_grams',lengthMm:'length_mm',widthMm:'width_mm',heightMm:'height_mm'})){if(input[key]==null||String(input[key]).trim()==='')continue;const n=Number(input[key]);if(!Number.isSafeInteger(n)||n<=0||n>1000000000)throw new ValidationError(key+' must be a whole number from 1 to 1,000,000,000.');physical[column]=n;}
  if(Object.keys(physical).length)await client.query('UPDATE skus SET '+Object.keys(physical).map((k,i)=>k+'=$'+(i+3)).join(',')+' WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,skuIds,...Object.values(physical)]);
  if(input.startingQuantity!=null&&String(input.startingQuantity).trim()!==''&&Number(input.startingQuantity)!==0){
    if(skuIds.length!==1)throw new ValidationError('Add starting stock for each variant after creating this item.');
    await require('./postgres-opening-stock').receiveInTransaction(client,ctx,{skuId:skuIds[0],locationId:input.startingLocationId,quantity:input.startingQuantity,unitCost:input.startingCost,lotCode:input.startingLotCode,serials:String(input.startingSerials||'').split(/[\r\n,]+/).map(v=>v.trim()).filter(Boolean),idempotencyKey:'item-opening:'+itemId});
  }
  return { itemId, skuIds };
}

async function createItem(database, ctx, input) {
  return database.transaction((client) => createItemInTransaction(client, ctx, input),
    { isolation: 'SERIALIZABLE' });
}

async function createImportedItemInTransaction(client,ctx,input){
  return (await createImportedItemsInTransaction(client,ctx,[input]))[0];
}

// One canonical imported-catalog implementation for single and bulk callers.
// All records are validated before writes; the enclosing caller owns atomicity.
async function createImportedItemsInTransaction(client,ctx,inputs){
  if(!Array.isArray(inputs))throw new ValidationError('Imported products must be a list.');
  if(!inputs.length)return [];
  const normalized=inputs.map(input=>({...input,name:requireText(input.name,'Item name',{max:240}),
    unitLabel:identity.unitLabel(input.unitLabel),trackingMode:requireOneOf(input.trackingMode,TRACKING_MODE_IDS,'Tracking type'),
    variants:Array.isArray(input.variants)&&input.variants.length?input.variants:[{}]}));
  if(normalized.some(i=>['lot','serial'].includes(i.trackingMode)))
    await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'inventory.lot_serial');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['catalog:'+ctx.workspaceId]);
  const commercialScope=await require('../commercial/entitlements').ownerScopeForWorkspace(client,ctx.workspaceId);
  await require('../commercial/entitlements').assertMeterCapacity(client,commercialScope,'products',normalized.filter(i=>!i.appendToItemId).length);
  const candidates=normalized.flatMap(input=>input.variants.map(v=>trimOrNull(v.code)||[codeSlug(input.name),...(v.options||[]).map(p=>codeSlug(p.value))].filter(Boolean).join('-')||'SKU'));
  const existing=new Set((await client.query('SELECT lower(btrim(code)) AS code FROM skus WHERE workspace_id=$1 AND lower(btrim(code))=ANY($2::text[])',[ctx.workspaceId,[...new Set(candidates.map(identity.codeKey))]])).rows.map(r=>r.code));
  const taken=new Set(),itemRows=[],optionRows=[],skuRows=[],valueRows=[],created=[],at=nowIso();let ci=0;
  for(const input of normalized){
    const itemId=input.appendToItemId||newId('item'),options=new Map(),result={itemId,skus:[]};
    let optionPosition=0,skuPosition=0;
    if(input.appendToItemId){
      const parent=(await client.query('SELECT name,tracking_mode,is_active,xmin::text=pg_current_xact_id()::text AS created_here FROM items WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,itemId])).rows[0];
      const resumed=!parent?.created_here&&input.importPlanId&&(await client.query(`SELECT 1 FROM import_catalogue_bindings b JOIN import_plans p ON p.id=b.import_id AND p.workspace_id=b.workspace_id
        WHERE b.workspace_id=$1 AND b.import_id=$2 AND b.product_key=$3 AND b.item_id=$4 AND p.integrity_hash=$5 AND p.approval_status='APPROVED' LIMIT 1`,[ctx.workspaceId,input.importPlanId,input.importProductKey,itemId,input.importIntegrityHash])).rows.length;
      const cutover=!parent?.created_here&&input.cutoverPackageId&&(await client.query("SELECT 1 FROM migration_packages p JOIN external_identity_maps e ON e.workspace_id=p.workspace_id AND e.source_namespace=p.source_namespace AND e.first_package_id=p.id WHERE p.id=$1 AND p.workspace_id=$2 AND p.status='APPLYING' AND p.postgres_state IS NOT NULL AND p.approved_by_user_id=$3 AND e.entity_type='product' AND e.external_key=$4 AND e.local_type='item' AND e.local_id=$5 AND current_setting('stockchief.cutover_package_id',true)=p.id",[input.cutoverPackageId,ctx.workspaceId,ctx.actorId,input.cutoverProductKey,itemId])).rows.length;
      if(!(parent?.created_here||resumed||cutover)||!Number(parent.is_active)||parent.tracking_mode!==input.trackingMode||parent.name!==input.name)
        throw new ValidationError('Import variants may only extend the matching product created by this approved import.');
      for(const row of (await client.query('SELECT id,name,position FROM item_options WHERE workspace_id=$1 AND item_id=$2 ORDER BY position,id',[ctx.workspaceId,itemId])).rows){options.set(row.name,row.id);optionPosition=Math.max(optionPosition,Number(row.position)+1);}
      skuPosition=Number((await client.query('SELECT position+1 AS next FROM skus WHERE workspace_id=$1 AND item_id=$2 ORDER BY position DESC,id DESC LIMIT 1',[ctx.workspaceId,itemId])).rows[0]?.next||0);
    }
    const optionNames=[...new Set(input.variants.flatMap(v=>(v.options||[]).map(p=>requireText(p.name,'Option name',{max:120}))))];
    for(const name of optionNames){if(options.has(name))continue;const id=newId('opt');options.set(name,id);optionRows.push({id,item_id:itemId,name,position:optionPosition++});}
    for(const [position,v]of input.variants.entries()){
      const parts=(v.options||[]).map(p=>({name:p.name,value:requireText(p.value,'Option value',{max:120})}));
      let candidate=requireText(candidates[ci++],'SKU code',{max:240});
      if(trimOrNull(v.code)&&(taken.has(identity.codeKey(candidate))||existing.has(identity.codeKey(candidate))))throw new ValidationError('The SKU code '+candidate+' already exists or repeats in this source. Recheck the preview; an explicit code will not be silently renamed.');
      const code=taken.has(candidate.toLowerCase())||existing.has(candidate.toLowerCase())?await uniqueCode(client,ctx.workspaceId,candidate,taken):candidate;
      taken.add(code.toLowerCase());const skuId=newId('sku'),label=parts.length?parts.map(p=>p.value).join(' / '):trimOrNull(v.label);
      skuRows.push({id:skuId,item_id:itemId,code,barcode:trimOrNull(v.barcode),variant_label:label,is_default:parts.length?0:1,position:skuPosition+position});
      for(const p of parts)valueRows.push({sku_id:skuId,option_id:options.get(p.name),value:p.value});
      result.skus.push({key:v.key,skuId,code});
    }
    if(!input.appendToItemId)itemRows.push({id:itemId,name:input.name,base_code:optionNames.length?null:result.skus[0].code,
      description:trimOrNull(input.description),unit_label:trimOrNull(input.unitLabel)||'unit',tracking_mode:input.trackingMode,has_variants:optionNames.length?1:0});
    created.push(result);
  }
  for(let start=0;start<itemRows.length;start+=500)await client.query(`INSERT INTO items(id,workspace_id,name,base_code,description,unit_label,tracking_mode,has_variants,allow_negative,is_active,created_at,updated_at)
    SELECT x.id,$1,x.name,x.base_code,x.description,x.unit_label,x.tracking_mode,x.has_variants,0,1,$2,$2
    FROM jsonb_to_recordset($3::jsonb) AS x(id text,name text,base_code text,description text,unit_label text,tracking_mode text,has_variants bigint)`,[ctx.workspaceId,at,JSON.stringify(itemRows.slice(start,start+500))]);
  for(let start=0;start<optionRows.length;start+=500)await client.query(`INSERT INTO item_options(id,workspace_id,item_id,name,position)
    SELECT x.id,$1,x.item_id,x.name,x.position FROM jsonb_to_recordset($2::jsonb) AS x(id text,item_id text,name text,position bigint)`,[ctx.workspaceId,JSON.stringify(optionRows.slice(start,start+500))]);
  for(let start=0;start<skuRows.length;start+=500)await client.query(`INSERT INTO skus(id,workspace_id,item_id,code,barcode,variant_label,is_default,position,is_active,created_at)
    SELECT x.id,$1,x.item_id,x.code,x.barcode,x.variant_label,x.is_default,x.position,1,$2
    FROM jsonb_to_recordset($3::jsonb) AS x(id text,item_id text,code text,barcode text,variant_label text,is_default bigint,position bigint)`,[ctx.workspaceId,at,JSON.stringify(skuRows.slice(start,start+500))]);
  for(let start=0;start<valueRows.length;start+=500)await client.query(`INSERT INTO sku_option_values(sku_id,option_id,value)
    SELECT x.sku_id,x.option_id,x.value FROM jsonb_to_recordset($1::jsonb) AS x(sku_id text,option_id text,value text)`,[JSON.stringify(valueRows.slice(start,start+500))]);
  return created;
}

function listOrder(sort) {
  if (sort === 'stock_desc') return 'on_hand DESC,i.name,i.id';
  if (sort === 'stock_asc') return 'on_hand ASC,i.name,i.id';
  if (sort === 'newest') return 'i.created_at DESC,i.id';
  return 'i.name,i.id';
}

async function updateImportedNamesInTransaction(client,ctx,changes){
  if(!changes.length)return;
  const ids=changes.map(c=>c.itemId),rows=(await client.query('SELECT id,name FROM items WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[ctx.workspaceId,ids])).rows;
  const existing=new Map(rows.map(r=>[r.id,r]));
  for(const change of changes){requireText(change.name,'Item name',{max:240});if(!existing.has(change.itemId)||existing.get(change.itemId).name!==change.expectedName)throw new ValidationError('A product name changed after the import preview. Recheck the file before approval.');}
  await client.query('UPDATE items i SET name=x.name,updated_at=$3 FROM jsonb_to_recordset($2::jsonb) AS x("itemId" text,name text) WHERE i.workspace_id=$1 AND i.id=x."itemId" AND i.name IS DISTINCT FROM x.name',[ctx.workspaceId,JSON.stringify(changes),nowIso()]);
}

async function listItems(database, workspaceId, input = {}) {
  const page = Math.max(1, Number.parseInt(input.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(input.pageSize, 10) || 25));
  const q = String(input.q || '').trim().slice(0, 160);
  const trackingMode = TRACKING_MODE_IDS.includes(input.trackingMode) ? input.trackingMode : null;
  const locationId = trimOrNull(input.locationId);
  const archivedOnly = input.archivedOnly === true;
  const includeArchived = archivedOnly || input.includeArchived === true;
  const group = ['shortage','empty','incoming','healthy'].includes(input.group) ? input.group : null;
  const pageFirst = !group && !['stock_desc','stock_asc'].includes(input.sort);
  let anchor=null;
  if(pageFirst && input.afterItemId){
    anchor=(await database.query('SELECT id,name,created_at FROM items WHERE workspace_id=$1 AND id=$2',[workspaceId,String(input.afterItemId).slice(0,160)])).rows[0];
    if(!anchor)throw new ValidationError('That catalogue page has changed. Return to the first page.');
  }
  const values = [workspaceId, q || null, trackingMode, locationId, includeArchived, archivedOnly, pageSize + 1,
    anchor?0:(page - 1) * pageSize,group,anchor?.id||null,anchor?.name||null,anchor?.created_at||null];
  const result = await database.query(`WITH selected_items AS MATERIALIZED (
      SELECT i.* FROM items i
      WHERE i.workspace_id=$1 AND ($5 OR i.is_active=1) AND (NOT $6 OR i.is_active=0)
        AND ($3::text IS NULL OR i.tracking_mode=$3)
        AND ($2::text IS NULL OR i.name ILIKE '%'||$2||'%' OR COALESCE(i.base_code,'') ILIKE '%'||$2||'%'
          OR EXISTS(SELECT 1 FROM skus search_sku WHERE search_sku.workspace_id=$1 AND search_sku.item_id=i.id AND search_sku.code ILIKE '%'||$2||'%'))
        AND ($10::text IS NULL OR ${input.sort==='newest'?'(i.created_at<$12::text OR (i.created_at=$12::text AND i.id>$10))':'(i.name,i.id)>($11::text,$10::text)'} )
        AND ($11::text IS NULL OR TRUE) AND ($12::text IS NULL OR TRUE)
      ${pageFirst?`ORDER BY ${listOrder(input.sort)} LIMIT $7::bigint OFFSET $8::bigint`:''}
    )
    SELECT i.*,COALESCE(r.sku_count,0) AS sku_count,r.first_sku_code,
      COALESCE(stock.on_hand,0) AS on_hand,COALESCE(committed_item.quantity,0) AS committed,
      COALESCE(purchase_incoming.quantity,0) AS on_order,
      EXISTS(SELECT 1 FROM movements m WHERE m.workspace_id=$1 AND m.item_id=i.id LIMIT 1)::int AS has_history
    FROM selected_items i LEFT JOIN item_catalog_rollups r ON r.item_id=i.id
    LEFT JOIN LATERAL (SELECT SUM(b.on_hand) AS on_hand FROM item_location_balances b
      WHERE b.workspace_id=$1 AND b.item_id=i.id AND ($4::text IS NULL OR b.location_id=$4)) stock ON TRUE
    LEFT JOIN LATERAL (SELECT SUM(a.quantity) AS quantity FROM skus s
      JOIN sales_order_lines sol ON sol.sku_id=s.id AND sol.workspace_id=s.workspace_id
      JOIN sales_order_allocations a ON a.sales_order_line_id=sol.id AND a.workspace_id=sol.workspace_id
      WHERE s.workspace_id=$1 AND s.item_id=i.id) committed_item ON TRUE
    LEFT JOIN LATERAL (SELECT SUM(pol.quantity_units-pol.quantity_received_units) AS quantity FROM skus s
      JOIN purchase_order_lines pol ON pol.sku_id=s.id AND pol.workspace_id=s.workspace_id
      JOIN purchase_orders po ON po.id=pol.purchase_order_id AND po.workspace_id=pol.workspace_id
      WHERE s.workspace_id=$1 AND s.item_id=i.id AND po.status IN ('ORDERED','PARTIALLY_RECEIVED')) purchase_incoming ON TRUE
    WHERE ($9::text IS NULL OR ($9='shortage' AND COALESCE(committed_item.quantity,0)>COALESCE(stock.on_hand,0))
        OR ($9='empty' AND COALESCE(stock.on_hand,0)<=0)
        OR ($9='incoming' AND COALESCE(purchase_incoming.quantity,0)>0)
        OR ($9='healthy' AND COALESCE(stock.on_hand,0)>0
          AND COALESCE(committed_item.quantity,0)<=COALESCE(stock.on_hand,0)))
    ORDER BY ${listOrder(input.sort)} LIMIT $7::bigint OFFSET ${pageFirst?'0':'$8::bigint'}`, values);
  const hasMore = result.rows.length > pageSize;
  const items = result.rows.slice(0, pageSize).map((row) => {
    const onHand = Number(row.on_hand || 0);
    const committed = Number(row.committed || 0);
    return { ...row, sku_count: Number(row.sku_count || 0), on_hand: onHand, committed,
      available: Math.max(0, onHand - committed), onOrder: Number(row.on_order || 0),
      hasHistory: Boolean(Number(row.has_history)), is_active: Number(row.is_active) };
  });
  return { items, page, pageSize, hasMore, nextAfterItemId:pageFirst&&hasMore?items.at(-1)?.id:null };
}

async function getItem(database, workspaceId, itemId, input = {}) {
  const trackingQuery=String(input.trackingQuery||'').trim().slice(0,240),trackingLimit=100;
  const itemResult = await database.query('SELECT * FROM items WHERE workspace_id=$1 AND id=$2', [workspaceId, itemId]);
  if (!itemResult.rows.length) throw new NotFoundError('That product could not be found.');
  const item = { ...itemResult.rows[0], is_active: Number(itemResult.rows[0].is_active),
    has_variants: Number(itemResult.rows[0].has_variants),allow_negative:Number(itemResult.rows[0].allow_negative) };
  const totalResult = await database.query(`SELECT COALESCE((SELECT sku_count FROM item_catalog_rollups WHERE workspace_id=$1 AND item_id=$2),0) AS sku_count,
    COALESCE((SELECT SUM(on_hand) FROM item_location_balances WHERE workspace_id=$1 AND item_id=$2),0) AS on_hand`, [workspaceId, itemId]);
  const skuCount = Number(totalResult.rows[0].sku_count || 0);
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(skuCount / pageSize));
  const page = Math.min(pageCount, Math.max(1, Number.parseInt(input.page, 10) || 1));
  const skuResult = await database.query(`WITH selected_skus AS MATERIALIZED (
      SELECT * FROM skus WHERE workspace_id=$1 AND item_id=$2 ORDER BY position,id LIMIT $3 OFFSET $4
    ), committed AS (
      SELECT sol.sku_id,COALESCE(SUM(a.quantity),0) AS quantity FROM sales_order_allocations a
      JOIN sales_order_lines sol ON sol.id=a.sales_order_line_id AND sol.workspace_id=a.workspace_id
      WHERE a.workspace_id=$1 AND sol.sku_id IN (SELECT id FROM selected_skus) GROUP BY sol.sku_id
    ), purchase_incoming AS (
      SELECT pol.sku_id,COALESCE(SUM(pol.quantity_units-pol.quantity_received_units),0) AS quantity
      FROM purchase_order_lines pol JOIN purchase_orders po ON po.id=pol.purchase_order_id
      WHERE pol.workspace_id=$1 AND pol.sku_id IN (SELECT id FROM selected_skus) AND po.status IN ('ORDERED','PARTIALLY_RECEIVED') GROUP BY pol.sku_id
    ), stock AS (
      SELECT sku_id,COALESCE(SUM(on_hand),0) AS on_hand FROM balances WHERE workspace_id=$1 AND sku_id IN (SELECT id FROM selected_skus) GROUP BY sku_id
    )
    SELECT s.*,COALESCE(stock.on_hand,0) AS on_hand,COALESCE(committed.quantity,0) AS committed,
      COALESCE(purchase_incoming.quantity,0) AS on_order
    FROM selected_skus s LEFT JOIN stock ON stock.sku_id=s.id LEFT JOIN committed ON committed.sku_id=s.id
    LEFT JOIN purchase_incoming ON purchase_incoming.sku_id=s.id
    ORDER BY s.position,s.id`,
  [workspaceId, itemId, pageSize, (page - 1) * pageSize]);
  const skuIds = skuResult.rows.map((row) => row.id);
  let positions = [];
  if (skuIds.length) {
    positions = (await database.query(`WITH committed AS (
      SELECT sol.sku_id,a.location_id,COALESCE(SUM(a.quantity),0) AS quantity
      FROM sales_order_allocations a JOIN sales_order_lines sol ON sol.id=a.sales_order_line_id
      WHERE a.workspace_id=$1 AND sol.sku_id=ANY($2::text[]) GROUP BY sol.sku_id,a.location_id
    ) SELECT b.sku_id,b.location_id,l.name AS location_name,b.on_hand,COALESCE(committed.quantity,0) AS committed
      FROM balances b JOIN locations l ON l.id=b.location_id AND l.workspace_id=b.workspace_id
      LEFT JOIN committed ON committed.sku_id=b.sku_id AND committed.location_id=b.location_id
      WHERE b.workspace_id=$1 AND b.sku_id=ANY($2::text[]) AND b.on_hand<>0 ORDER BY l.name`,
    [workspaceId, skuIds])).rows;
  }
  const skus = skuResult.rows.map((row) => {
    const total = Number(row.on_hand || 0);
    const committed = Number(row.committed || 0);
    return { ...row, total, committed, available: Math.max(0, total - committed),
      onOrder: Number(row.on_order || 0), is_active: Number(row.is_active),
      perLocation: positions.filter((position) => position.sku_id === row.id).map((position) => ({
        locationId: position.location_id, locationName: position.location_name, onHand: Number(position.on_hand),
        committed:Number(position.committed||0),available:Number(position.on_hand)-Number(position.committed||0),
      })) };
  });
  const locations = (await database.query(`SELECT * FROM locations WHERE workspace_id=$1 AND is_active=1
    ORDER BY name,id`, [workspaceId])).rows.map((row) => ({ ...row, is_active: Number(row.is_active) }));
  const recentRows = (await database.query(`SELECT m.id,m.item_id,m.operation,m.quantity_delta,m.reason_code,m.reference,m.notes,
      m.occurred_at,s.code,s.variant_label,l.name AS location_name,u.name AS actor_name
    FROM movements m JOIN skus s ON s.id=m.sku_id JOIN locations l ON l.id=m.location_id
    LEFT JOIN users u ON u.id=m.actor_user_id
    WHERE m.workspace_id=$1 AND m.item_id=$2 ORDER BY m.occurred_at DESC,m.seq DESC LIMIT 20`,
  [workspaceId, itemId])).rows;
  const positionTotal = (await database.query(`SELECT
      COALESCE((SELECT SUM(a.quantity) FROM sales_order_allocations a
        JOIN sales_order_lines sol ON sol.id=a.sales_order_line_id
        JOIN skus s ON s.id=sol.sku_id WHERE a.workspace_id=$1 AND s.item_id=$2),0) AS committed,
      COALESCE((SELECT SUM(pol.quantity_units-pol.quantity_received_units) FROM purchase_order_lines pol
        JOIN purchase_orders po ON po.id=pol.purchase_order_id JOIN skus s ON s.id=pol.sku_id
        WHERE pol.workspace_id=$1 AND s.item_id=$2 AND po.status IN ('ORDERED','PARTIALLY_RECEIVED')),0)
      AS on_order`,
  [workspaceId,itemId])).rows[0];
  const committedTotal = Number(positionTotal.committed || 0);
  const onOrderTotal = Number(positionTotal.on_order || 0);
  const total = Number(totalResult.rows[0].on_hand || 0);
  const [optionResult,lotResult,unitResult,locationTotalResult]=await Promise.all([
    database.query(`SELECT option_row.*,COALESCE(json_agg(DISTINCT value_row.value)
      FILTER (WHERE value_row.value IS NOT NULL),'[]') AS values
      FROM item_options option_row LEFT JOIN sku_option_values value_row ON value_row.option_id=option_row.id
      WHERE option_row.workspace_id=$1 AND option_row.item_id=$2 GROUP BY option_row.id
      ORDER BY option_row.position,option_row.id`,[workspaceId,itemId]),
    database.query(`WITH selected_lots AS MATERIALIZED (
      SELECT lot.* FROM lots lot JOIN skus sku ON sku.id=lot.sku_id AND sku.workspace_id=lot.workspace_id
      WHERE lot.workspace_id=$1 AND sku.item_id=$2
        AND ($3='' OR lower(lot.code)=lower($3))
        AND ($4::text IS NULL OR (COALESCE(lot.expires_at,'9999-12-31'),lot.code,lot.id)>(
          SELECT COALESCE(anchor.expires_at,'9999-12-31'),anchor.code,anchor.id FROM lots anchor
          JOIN skus anchor_sku ON anchor_sku.id=anchor.sku_id AND anchor_sku.workspace_id=anchor.workspace_id
          WHERE anchor.workspace_id=$1 AND anchor_sku.item_id=$2 AND anchor.id=$4))
        AND EXISTS(SELECT 1 FROM lot_balances balance WHERE balance.workspace_id=lot.workspace_id AND balance.lot_id=lot.id AND balance.quantity>0)
      ORDER BY lot.expires_at NULLS LAST,lot.code,lot.id LIMIT $5)
      SELECT lot.id,lot.sku_id,lot.code,lot.received_at,lot.expires_at,sku.variant_label,
      balance.location_id,location.name AS location_name,balance.quantity
      FROM selected_lots lot JOIN skus sku ON sku.id=lot.sku_id
      JOIN lot_balances balance ON balance.lot_id=lot.id AND balance.workspace_id=lot.workspace_id
      JOIN locations location ON location.id=balance.location_id
      WHERE lot.workspace_id=$1 AND sku.item_id=$2 AND balance.quantity>0
      ORDER BY lot.expires_at NULLS LAST,lot.code,lot.id,location.name`,[workspaceId,itemId,trackingQuery,input.afterLotId||null,trackingLimit+1]),
    database.query(`SELECT unit.id,unit.sku_id,unit.serial,unit.condition,unit.status,unit.location_id,
      location.name AS location_name,sku.variant_label
      FROM serial_units unit JOIN skus sku ON sku.id=unit.sku_id
      JOIN locations location ON location.id=unit.location_id
      WHERE unit.workspace_id=$1 AND sku.item_id=$2
        AND ($3='' OR lower(unit.serial)=lower($3)) AND ($4::text IS NULL OR unit.id>$4)
      ORDER BY unit.id LIMIT $5`,[workspaceId,itemId,trackingQuery,input.afterSerialId||null,trackingLimit+1]),
    database.query(`SELECT location.id,location.name,COALESCE(SUM(balance.on_hand),0) AS total
      FROM balances balance JOIN skus sku ON sku.id=balance.sku_id
      JOIN locations location ON location.id=balance.location_id
      WHERE balance.workspace_id=$1 AND sku.item_id=$2 GROUP BY location.id,location.name
      HAVING COALESCE(SUM(balance.on_hand),0)<>0 ORDER BY location.name`,[workspaceId,itemId]),
  ]);
  const lotsById=new Map();for(const row of lotResult.rows){let lot=lotsById.get(row.id);if(!lot){lot={id:row.id,
      sku_id:row.sku_id,code:row.code,received_at:row.received_at,expires_at:row.expires_at,
      variant_label:row.variant_label,total:0,perLocation:[]};lotsById.set(row.id,lot);}
    const quantity=Number(row.quantity);lot.total+=quantity;lot.perLocation.push({location_id:row.location_id,
      location_name:row.location_name,quantity});}
  const movementSentence=(row)=>{const quantity=Math.abs(Number(row.quantity_delta));const product=row.variant_label||item.name;
    if(row.operation==='receive')return `Received ${quantity} × ${product} into ${row.location_name}.`;
    if(row.operation==='issue')return `Issued ${quantity} × ${product} from ${row.location_name}.`;
    if(row.operation==='adjust')return `Corrected ${product} by ${Number(row.quantity_delta)>0?'+':''}${row.quantity_delta} at ${row.location_name}.`;
    if(row.operation==='transfer_out')return `Sent ${quantity} × ${product} from ${row.location_name}.`;
    if(row.operation==='transfer_in')return `Received ${quantity} × ${product} at ${row.location_name} from another location.`;
    return `${String(row.operation).replaceAll('_',' ')} ${quantity} × ${product} at ${row.location_name}.`;};
  const recent=recentRows.map((row)=>({...row,itemId:row.item_id,displayName:row.variant_label||item.name,
    sentence:movementSentence(row),actorName:row.actor_name||'StockChief',occurredAt:row.occurred_at,reasonLabel:null}));
  return { item, skus, locations, recent, total, committed: committedTotal,
    available: Math.max(0, total - committedTotal), onOrder: onOrderTotal,
    options:optionResult.rows,lots:[...lotsById.values()].slice(0,trackingLimit),units:unitResult.rows.slice(0,trackingLimit),
    trackingCoverage:{query:trackingQuery,limit:trackingLimit,
      nextLotId:lotsById.size>trackingLimit?[...lotsById.keys()][trackingLimit-1]:null,
      nextSerialId:unitResult.rows.length>trackingLimit?unitResult.rows[trackingLimit-1].id:null},
    locationTotals:locationTotalResult.rows.map((row)=>({...row,total:Number(row.total)})),
    variantTotal: skuCount, variantPage: page, variantPageSize: pageSize,variantPageCount: pageCount };
}

async function updateItem(database,ctx,itemId,input){
  const name=requireText(input.name,'Item name',{max:240});
  const baseCode=trimOrNull(input.baseCode);const unitLabel=identity.unitLabel(input.unitLabel);
  return database.transaction(async(client)=>{
    const current=(await client.query('SELECT * FROM items WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [ctx.workspaceId,itemId])).rows[0];
    if(!current)throw new NotFoundError('That product could not be found.');
    if(input.expectedDetailsVersion!==undefined&&input.expectedDetailsVersion!==identity.detailsVersion(current))
      throw new ValidationError('This product changed after you opened it. Reload its latest details before saving; your change has not overwritten them.',{reason:'stale_product_details'});
    if(baseCode){const clash=await client.query('SELECT 1 FROM items WHERE workspace_id=$1 AND id<>$3 AND (lower(btrim(base_code))=lower(btrim($2)) OR id IN (SELECT item_id FROM skus WHERE workspace_id=$1 AND lower(btrim(code))=lower(btrim($2))))',
      [ctx.workspaceId,baseCode,itemId]);if(clash.rows.length)throw new ValidationError(`Another item already uses the code ${baseCode}.`);}
    const updated=(await client.query(`UPDATE items SET name=$3,base_code=$4,description=$5,unit_label=$6,
      allow_negative=$7,updated_at=$8 WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [ctx.workspaceId,itemId,name,baseCode,trimOrNull(input.description),unitLabel,normaliseBoolean(input.allowNegative)?1:0,nowIso()])).rows[0];
    return updated;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function addVariant(database,ctx,itemId,input){
  return database.transaction(async(client)=>{
    if(!(await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`catalog:${ctx.workspaceId}`])).rows[0].acquired)
      throw new ValidationError('Another product update is running in this inventory. Wait for it to finish before adding a variant.',{reason:'catalog_busy'});
    const item=(await client.query('SELECT * FROM items WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [ctx.workspaceId,itemId])).rows[0];
    if(!item)throw new NotFoundError('That product could not be found.');
    if(!Number(item.has_variants))throw new ValidationError('This product was not created with variants.');
    const optionRows=(await client.query(`SELECT * FROM item_options WHERE workspace_id=$1 AND item_id=$2
      ORDER BY position,id`,[ctx.workspaceId,itemId])).rows;
    if(!optionRows.length)throw new ValidationError('This product has no variant options.');
    const values=[];
    for(const option of optionRows){
      const value=requireText(input.optionValues?.[option.id],option.name,{max:120});
      values.push({optionId:option.id,value});
    }
    const label=values.map((part)=>part.value).join(' / ');
    const duplicate=await client.query('SELECT 1 FROM skus WHERE workspace_id=$1 AND item_id=$2 AND lower(variant_label)=lower($3)',
      [ctx.workspaceId,itemId,label]);
    if(duplicate.rows.length)throw new ValidationError('That variant already exists.');
    const code=await uniqueCode(client,ctx.workspaceId,[item.base_code||codeSlug(item.name),
      ...values.map((part)=>codeSlug(part.value))].filter(Boolean).join('-'),new Set());
    const position=Number((await client.query('SELECT COALESCE(MAX(position),-1)+1 AS position FROM skus WHERE item_id=$1',
      [itemId])).rows[0].position);
    const skuId=newId('sku');const at=nowIso();
    await client.query(`INSERT INTO skus(id,workspace_id,item_id,code,variant_label,is_default,position,is_active,created_at)
      VALUES($1,$2,$3,$4,$5,0,$6,1,$7)`,[skuId,ctx.workspaceId,itemId,code,label,position,at]);
    for(const part of values)await client.query('INSERT INTO sku_option_values(sku_id,option_id,value) VALUES($1,$2,$3)',
      [skuId,part.optionId,part.value]);
    return {skuId,code,label};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function setItemActive(database, ctx, itemId, active) {
  return database.transaction(async(client)=>{
    if(active){
      const prior=(await client.query('SELECT is_active FROM items WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,itemId])).rows[0];
      if(prior&&!Number(prior.is_active)){const entitlements=require('../commercial/entitlements'),scope=await entitlements.ownerScopeForWorkspace(client,ctx.workspaceId);await entitlements.assertMeterCapacity(client,scope,'products',1);}
    }
    if(!active){
      const stock=await client.query(`SELECT COALESCE(SUM(balance.on_hand),0) AS total FROM balances balance
        JOIN skus sku ON sku.id=balance.sku_id WHERE balance.workspace_id=$1 AND sku.item_id=$2`,
      [ctx.workspaceId,itemId]);
      if(Number(stock.rows[0].total)!==0)throw new ValidationError('Move or issue all stock before archiving this product.');
    }
    const result = await client.query(`UPDATE items SET is_active=$3,updated_at=$4
      WHERE workspace_id=$1 AND id=$2 RETURNING *`, [ctx.workspaceId, itemId, active ? 1 : 0, nowIso()]);
    if (!result.rows.length) throw new NotFoundError('That product could not be found.');
    await client.query('UPDATE skus SET is_active=$3 WHERE workspace_id=$1 AND item_id=$2',
      [ctx.workspaceId, itemId, active ? 1 : 0]);
    return result.rows[0];
  },{isolation:'SERIALIZABLE'});
}

module.exports = { createItem, createItemInTransaction, createImportedItemInTransaction, createImportedItemsInTransaction,
  updateImportedNamesInTransaction,listItems, getItem, updateItem, addVariant, setItemActive };
require('../commercial/enforcement').guardExports(module.exports,0,1,{createItem:'inventory.core',createItemInTransaction:'inventory.core',
 createImportedItemInTransaction:'inventory.core',createImportedItemsInTransaction:'inventory.core',updateItem:'inventory.core',addVariant:'inventory.core',setItemActive:'inventory.core'});

'use strict';

const { ValidationError, NotFoundError } = require('./errors');
const { TRACKING_MODE_IDS } = require('./constants');
const { newId, nowIso, trimOrNull, requireText, requireOneOf } = require('../lib/util');
const { parseOptions, codeSlug } = require('./item-service');

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
    'SELECT 1 FROM skus WHERE workspace_id=$1 AND code=$2 LIMIT 1',
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
  const hasVariants = normaliseBoolean(input.hasVariants);
  const baseCode = trimOrNull(input.baseCode);
  const description = trimOrNull(input.description);
  const unitLabel = trimOrNull(input.unitLabel) || 'unit';
  const options = hasVariants ? parseOptions(input.options) : [];
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`catalog:${ctx.workspaceId}`]);
    if (baseCode) {
      const clash = await client.query('SELECT 1 FROM items WHERE workspace_id=$1 AND base_code=$2 LIMIT 1',
        [ctx.workspaceId, baseCode]);
      if (clash.rows.length) throw new ValidationError(`Another item already uses the code ${baseCode}.`, { field: 'baseCode' });
    }
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
  return { itemId, skuIds };
}

async function createItem(database, ctx, input) {
  return database.transaction((client) => createItemInTransaction(client, ctx, input),
    { isolation: 'SERIALIZABLE' });
}

async function createImportedItemInTransaction(client, ctx, input) {
  const name = requireText(input.name, 'Item name', { max: 240 });
  const trackingMode = requireOneOf(input.trackingMode, TRACKING_MODE_IDS, 'Tracking type');
  const variants = Array.isArray(input.variants) && input.variants.length ? input.variants : [{}];
  const description = trimOrNull(input.description);
  const unitLabel = trimOrNull(input.unitLabel) || 'unit';
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`catalog:${ctx.workspaceId}`]);
  const at = nowIso();
  const itemId = newId('item');
  await client.query(`INSERT INTO items(id,workspace_id,name,base_code,description,unit_label,tracking_mode,
    has_variants,allow_negative,is_active,created_at,updated_at)
    VALUES($1,$2,$3,NULL,$4,$5,$6,$7,0,1,$8,$8)`,
  [itemId, ctx.workspaceId, name, description, unitLabel, trackingMode,
    variants.some((row) => row.options?.length) ? 1 : 0, at]);
  const optionNames = [...new Set(variants.flatMap((variant) => (variant.options || []).map((part) => part.name)))];
  const optionIds = new Map();
  for (const [position, optionName] of optionNames.entries()) {
    const optionId = newId('opt');
    optionIds.set(optionName, optionId);
    await client.query(`INSERT INTO item_options(id,workspace_id,item_id,name,position)
      VALUES($1,$2,$3,$4,$5)`, [optionId, ctx.workspaceId, itemId, optionName, position]);
  }
  const taken = new Set();
  const created = [];
  for (const [position, variant] of variants.entries()) {
    const options = variant.options || [];
    const label = options.length ? options.map((part) => part.value).join(' / ') : trimOrNull(variant.label);
    const candidate = trimOrNull(variant.code) ||
      [codeSlug(name), ...options.map((part) => codeSlug(part.value))].filter(Boolean).join('-');
    const code = await uniqueCode(client, ctx.workspaceId, candidate, taken);
    const skuId = newId('sku');
    await client.query(`INSERT INTO skus(id,workspace_id,item_id,code,barcode,variant_label,is_default,position,is_active,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9)`,
    [skuId, ctx.workspaceId, itemId, code, trimOrNull(variant.barcode), label, options.length ? 0 : 1, position, at]);
    for (const part of options) {
      await client.query('INSERT INTO sku_option_values(sku_id,option_id,value) VALUES($1,$2,$3)',
        [skuId, optionIds.get(part.name), part.value]);
    }
    created.push({ key:variant.key, skuId, code });
  }
  return { itemId, skus:created };
}

function listOrder(sort) {
  if (sort === 'stock_desc') return 'on_hand DESC,i.name,i.id';
  if (sort === 'stock_asc') return 'on_hand ASC,i.name,i.id';
  if (sort === 'newest') return 'i.created_at DESC,i.id';
  return 'i.name,i.id';
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
  const values = [workspaceId, q || null, trackingMode, locationId, includeArchived, archivedOnly, pageSize + 1,
    (page - 1) * pageSize,group];
  const result = await database.query(`WITH stock AS (
      SELECT s.item_id,COALESCE(SUM(b.on_hand) FILTER (WHERE $4::text IS NULL OR b.location_id=$4),0) AS on_hand
      FROM skus s LEFT JOIN balances b ON b.sku_id=s.id AND b.workspace_id=s.workspace_id
      WHERE s.workspace_id=$1 GROUP BY s.item_id
    ), committed AS (
      SELECT sol.sku_id,COALESCE(SUM(a.quantity),0) AS quantity FROM sales_order_allocations a
      JOIN sales_order_lines sol ON sol.id=a.sales_order_line_id AND sol.workspace_id=a.workspace_id
      WHERE a.workspace_id=$1 GROUP BY sol.sku_id
    ), committed_item AS (
      SELECT s.item_id,COALESCE(SUM(c.quantity),0) AS quantity FROM skus s
      LEFT JOIN committed c ON c.sku_id=s.id WHERE s.workspace_id=$1 GROUP BY s.item_id
    ), purchase_incoming AS (
      SELECT s.item_id,COALESCE(SUM(pol.quantity_units-pol.quantity_received_units),0) AS quantity
      FROM purchase_order_lines pol JOIN purchase_orders po ON po.id=pol.purchase_order_id
      JOIN skus s ON s.id=pol.sku_id
      WHERE pol.workspace_id=$1 AND po.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED') GROUP BY s.item_id
    ), transfer_incoming AS (
      SELECT s.item_id,COALESCE(SUM(CASE t.status WHEN 'REQUESTED' THEN tl.requested_quantity
        WHEN 'APPROVED' THEN tl.approved_quantity WHEN 'PICKED' THEN tl.picked_quantity
        ELSE tl.shipped_quantity-tl.received_quantity-tl.lost_quantity-tl.damaged_quantity END),0) AS quantity
      FROM inventory_transfer_lines tl JOIN inventory_transfers t ON t.id=tl.transfer_id
      JOIN skus s ON s.id=tl.sku_id WHERE tl.workspace_id=$1
        AND t.status IN ('REQUESTED','APPROVED','PICKED','SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED') GROUP BY s.item_id
    ), incoming AS (
      SELECT item_id,SUM(quantity) AS quantity FROM (
        SELECT * FROM purchase_incoming UNION ALL SELECT * FROM transfer_incoming
      ) sources GROUP BY item_id
    ), history AS (
      SELECT item_id,1 AS has_history FROM movements WHERE workspace_id=$1 GROUP BY item_id
    )
    SELECT i.*,COALESCE(r.sku_count,0) AS sku_count,r.first_sku_code,
      COALESCE(stock.on_hand,0) AS on_hand,COALESCE(committed_item.quantity,0) AS committed,
      COALESCE(incoming.quantity,0) AS on_order,COALESCE(history.has_history,0) AS has_history
    FROM items i LEFT JOIN item_catalog_rollups r ON r.item_id=i.id
    LEFT JOIN stock ON stock.item_id=i.id LEFT JOIN committed_item ON committed_item.item_id=i.id
    LEFT JOIN incoming ON incoming.item_id=i.id LEFT JOIN history ON history.item_id=i.id
    WHERE i.workspace_id=$1 AND ($5 OR i.is_active=1) AND (NOT $6 OR i.is_active=0)
      AND ($3::text IS NULL OR i.tracking_mode=$3)
      AND ($9::text IS NULL OR ($9='shortage' AND COALESCE(committed_item.quantity,0)>COALESCE(stock.on_hand,0))
        OR ($9='empty' AND COALESCE(stock.on_hand,0)<=0)
        OR ($9='incoming' AND COALESCE(incoming.quantity,0)>0)
        OR ($9='healthy' AND COALESCE(stock.on_hand,0)>0
          AND COALESCE(committed_item.quantity,0)<=COALESCE(stock.on_hand,0)))
      AND ($2::text IS NULL OR i.name ILIKE '%'||$2||'%' OR COALESCE(i.base_code,'') ILIKE '%'||$2||'%'
        OR EXISTS(SELECT 1 FROM skus search_sku WHERE search_sku.item_id=i.id AND search_sku.code ILIKE '%'||$2||'%'))
    ORDER BY ${listOrder(input.sort)} LIMIT $7 OFFSET $8`, values);
  const hasMore = result.rows.length > pageSize;
  const items = result.rows.slice(0, pageSize).map((row) => {
    const onHand = Number(row.on_hand || 0);
    const committed = Number(row.committed || 0);
    return { ...row, sku_count: Number(row.sku_count || 0), on_hand: onHand, committed,
      available: Math.max(0, onHand - committed), onOrder: Number(row.on_order || 0),
      hasHistory: Boolean(Number(row.has_history)), is_active: Number(row.is_active) };
  });
  return { items, page, pageSize, hasMore };
}

async function getItem(database, workspaceId, itemId, input = {}) {
  const itemResult = await database.query('SELECT * FROM items WHERE workspace_id=$1 AND id=$2', [workspaceId, itemId]);
  if (!itemResult.rows.length) throw new NotFoundError('That product could not be found.');
  const item = { ...itemResult.rows[0], is_active: Number(itemResult.rows[0].is_active),
    has_variants: Number(itemResult.rows[0].has_variants),allow_negative:Number(itemResult.rows[0].allow_negative) };
  const totalResult = await database.query(`SELECT COUNT(DISTINCT s.id) AS sku_count,COALESCE(SUM(b.on_hand),0) AS on_hand
    FROM skus s LEFT JOIN balances b ON b.sku_id=s.id AND b.workspace_id=s.workspace_id
    WHERE s.workspace_id=$1 AND s.item_id=$2`, [workspaceId, itemId]);
  const skuCount = Number(totalResult.rows[0].sku_count || 0);
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(skuCount / pageSize));
  const page = Math.min(pageCount, Math.max(1, Number.parseInt(input.page, 10) || 1));
  const skuResult = await database.query(`WITH committed AS (
      SELECT sol.sku_id,COALESCE(SUM(a.quantity),0) AS quantity FROM sales_order_allocations a
      JOIN sales_order_lines sol ON sol.id=a.sales_order_line_id AND sol.workspace_id=a.workspace_id
      WHERE a.workspace_id=$1 GROUP BY sol.sku_id
    ), purchase_incoming AS (
      SELECT pol.sku_id,COALESCE(SUM(pol.quantity_units-pol.quantity_received_units),0) AS quantity
      FROM purchase_order_lines pol JOIN purchase_orders po ON po.id=pol.purchase_order_id
      WHERE pol.workspace_id=$1 AND po.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED') GROUP BY pol.sku_id
    ), transfer_incoming AS (
      SELECT tl.sku_id,COALESCE(SUM(CASE t.status WHEN 'REQUESTED' THEN tl.requested_quantity
        WHEN 'APPROVED' THEN tl.approved_quantity WHEN 'PICKED' THEN tl.picked_quantity
        ELSE tl.shipped_quantity-tl.received_quantity-tl.lost_quantity-tl.damaged_quantity END),0) AS quantity
      FROM inventory_transfer_lines tl JOIN inventory_transfers t ON t.id=tl.transfer_id
      WHERE tl.workspace_id=$1 AND t.status IN ('REQUESTED','APPROVED','PICKED','SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED')
      GROUP BY tl.sku_id
    ), incoming AS (
      SELECT sku_id,SUM(quantity) AS quantity FROM (
        SELECT * FROM purchase_incoming UNION ALL SELECT * FROM transfer_incoming
      ) sources GROUP BY sku_id
    ), stock AS (
      SELECT sku_id,COALESCE(SUM(on_hand),0) AS on_hand FROM balances WHERE workspace_id=$1 GROUP BY sku_id
    )
    SELECT s.*,COALESCE(stock.on_hand,0) AS on_hand,COALESCE(committed.quantity,0) AS committed,
      COALESCE(incoming.quantity,0) AS on_order
    FROM skus s LEFT JOIN stock ON stock.sku_id=s.id LEFT JOIN committed ON committed.sku_id=s.id
    LEFT JOIN incoming ON incoming.sku_id=s.id
    WHERE s.workspace_id=$1 AND s.item_id=$2 ORDER BY s.position,s.id LIMIT $3 OFFSET $4`,
  [workspaceId, itemId, pageSize, (page - 1) * pageSize]);
  const skuIds = skuResult.rows.map((row) => row.id);
  let positions = [];
  if (skuIds.length) {
    positions = (await database.query(`SELECT b.sku_id,b.location_id,l.name AS location_name,b.on_hand
      FROM balances b JOIN locations l ON l.id=b.location_id AND l.workspace_id=b.workspace_id
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
      })) };
  });
  const locations = (await database.query(`SELECT * FROM locations WHERE workspace_id=$1 AND is_active=1
    ORDER BY name,id`, [workspaceId])).rows.map((row) => ({ ...row, is_active: Number(row.is_active) }));
  const recent = (await database.query(`SELECT m.id,m.operation,m.quantity_delta,m.reason_code,m.reference,m.notes,
      m.occurred_at,s.code,s.variant_label,l.name AS location_name
    FROM movements m JOIN skus s ON s.id=m.sku_id JOIN locations l ON l.id=m.location_id
    WHERE m.workspace_id=$1 AND m.item_id=$2 ORDER BY m.occurred_at DESC,m.seq DESC LIMIT 20`,
  [workspaceId, itemId])).rows;
  const positionTotal = (await database.query(`SELECT
      COALESCE((SELECT SUM(a.quantity) FROM sales_order_allocations a
        JOIN sales_order_lines sol ON sol.id=a.sales_order_line_id
        JOIN skus s ON s.id=sol.sku_id WHERE a.workspace_id=$1 AND s.item_id=$2),0) AS committed,
      COALESCE((SELECT SUM(pol.quantity_units-pol.quantity_received_units) FROM purchase_order_lines pol
        JOIN purchase_orders po ON po.id=pol.purchase_order_id JOIN skus s ON s.id=pol.sku_id
        WHERE pol.workspace_id=$1 AND s.item_id=$2 AND po.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED')),0)
      + COALESCE((SELECT SUM(CASE t.status WHEN 'REQUESTED' THEN tl.requested_quantity
          WHEN 'APPROVED' THEN tl.approved_quantity WHEN 'PICKED' THEN tl.picked_quantity
          ELSE tl.shipped_quantity-tl.received_quantity-tl.lost_quantity-tl.damaged_quantity END)
        FROM inventory_transfer_lines tl JOIN inventory_transfers t ON t.id=tl.transfer_id
        JOIN skus s ON s.id=tl.sku_id WHERE tl.workspace_id=$1 AND s.item_id=$2
          AND t.status IN ('REQUESTED','APPROVED','PICKED','SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED')),0) AS on_order`,
  [workspaceId,itemId])).rows[0];
  const committedTotal = Number(positionTotal.committed || 0);
  const onOrderTotal = Number(positionTotal.on_order || 0);
  const total = Number(totalResult.rows[0].on_hand || 0);
  const [optionResult,lotResult,unitResult]=await Promise.all([
    database.query(`SELECT option_row.*,COALESCE(json_agg(DISTINCT value_row.value)
      FILTER (WHERE value_row.value IS NOT NULL),'[]') AS values
      FROM item_options option_row LEFT JOIN sku_option_values value_row ON value_row.option_id=option_row.id
      WHERE option_row.workspace_id=$1 AND option_row.item_id=$2 GROUP BY option_row.id
      ORDER BY option_row.position,option_row.id`,[workspaceId,itemId]),
    database.query(`SELECT lot.id,lot.sku_id,lot.code,lot.received_at,lot.expires_at,
      balance.location_id,location.name AS location_name,balance.quantity
      FROM lots lot JOIN skus sku ON sku.id=lot.sku_id
      JOIN lot_balances balance ON balance.lot_id=lot.id AND balance.workspace_id=lot.workspace_id
      JOIN locations location ON location.id=balance.location_id
      WHERE lot.workspace_id=$1 AND sku.item_id=$2 AND balance.quantity>0
      ORDER BY lot.expires_at NULLS LAST,lot.code,location.name`,[workspaceId,itemId]),
    database.query(`SELECT unit.id,unit.sku_id,unit.serial,unit.condition,unit.location_id,location.name AS location_name
      FROM serial_units unit JOIN skus sku ON sku.id=unit.sku_id
      JOIN locations location ON location.id=unit.location_id
      WHERE unit.workspace_id=$1 AND sku.item_id=$2 AND unit.status='in_stock'
      ORDER BY location.name,unit.serial`,[workspaceId,itemId]),
  ]);
  return { item, skus, locations, recent, total, committed: committedTotal,
    available: Math.max(0, total - committedTotal), onOrder: onOrderTotal,
    options:optionResult.rows,lots:lotResult.rows.map((row)=>({...row,quantity:Number(row.quantity)})),
    units:unitResult.rows,variantTotal: skuCount, variantPage: page, variantPageSize: pageSize,
    variantPageCount: pageCount };
}

async function updateItem(database,ctx,itemId,input){
  const name=requireText(input.name,'Item name',{max:240});
  const baseCode=trimOrNull(input.baseCode);const unitLabel=trimOrNull(input.unitLabel)||'unit';
  return database.transaction(async(client)=>{
    const current=(await client.query('SELECT * FROM items WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [ctx.workspaceId,itemId])).rows[0];
    if(!current)throw new NotFoundError('That product could not be found.');
    if(baseCode){const clash=await client.query('SELECT 1 FROM items WHERE workspace_id=$1 AND base_code=$2 AND id<>$3',
      [ctx.workspaceId,baseCode,itemId]);if(clash.rows.length)throw new ValidationError(`Another item already uses the code ${baseCode}.`);}
    const updated=(await client.query(`UPDATE items SET name=$3,base_code=$4,description=$5,unit_label=$6,
      allow_negative=$7,updated_at=$8 WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [ctx.workspaceId,itemId,name,baseCode,trimOrNull(input.description),unitLabel,normaliseBoolean(input.allowNegative)?1:0,nowIso()])).rows[0];
    return updated;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function addVariant(database,ctx,itemId,input){
  return database.transaction(async(client)=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`catalog:${ctx.workspaceId}`]);
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

module.exports = { createItem, createItemInTransaction, createImportedItemInTransaction,
  listItems, getItem, updateItem, addVariant, setItemActive };

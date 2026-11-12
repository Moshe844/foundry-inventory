'use strict';

// Job 132: what staff see about a discontinued product wherever they meet it:
// planning, the product page, order entry, the order page and pick lists.
// These paths are shared, so each read first checks that the retirement table
// exists (an older database may not have it yet).

const {has}=require('../db/schema-installed');
const work='stockchief_runtime.agent_product_retirements';
const OPEN="('SELLING_DOWN','RETIRED')";

// Discontinued SKUs among these. Planning never reorders them.
async function discontinued(db,workspaceId,skuIds){
  const ids=[...new Set(skuIds)];
  if(!ids.length||!await has(db,work))return new Set();
  return new Set((await db.query(`SELECT sku_id FROM ${work} WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND status IN ${OPEN}`,
    [workspaceId,ids])).rows.map(r=>r.sku_id));
}

// Each discontinued SKU among these, with its replacement when one is recorded
// and still active.
async function forSkus(db,workspaceId,skuIds){
  const ids=[...new Set(skuIds)],out=new Map();
  if(!ids.length||!await has(db,work))return out;
  const rows=(await db.query(`SELECT r.id,r.sku_id,r.status,old.code,
      CASE WHEN t.is_active=1 AND ti.is_active=1 THEN t.id END AS replacement_sku_id,
      CASE WHEN t.is_active=1 AND ti.is_active=1 THEN t.code END AS replacement_code,
      CASE WHEN t.is_active=1 AND ti.is_active=1 THEN t.item_id END AS replacement_item_id,
      CASE WHEN t.is_active=1 AND ti.is_active=1 THEN ti.name||CASE WHEN coalesce(t.variant_label,'')='' THEN '' ELSE ' / '||t.variant_label END END AS replacement_name
    FROM ${work} r JOIN skus old ON old.workspace_id=r.workspace_id AND old.id=r.sku_id
    LEFT JOIN skus t ON t.workspace_id=r.workspace_id AND t.id=r.replacement_sku_id LEFT JOIN items ti ON ti.workspace_id=t.workspace_id AND ti.id=t.item_id
    WHERE r.workspace_id=$1 AND r.sku_id=ANY($2::text[]) AND r.status IN ${OPEN}`,[workspaceId,ids])).rows;
  for(const r of rows)out.set(r.sku_id,r);
  return out;
}

// The replacements of retired products whose code, barcode or name matches a
// search, so order entry offers the product to use instead.
async function replacementsFor(db,workspaceId,search){
  const term=String(search||'').trim().toLowerCase();
  if(term.length<2||!await has(db,work))return [];
  return (await db.query(`SELECT r.replacement_sku_id AS sku_id,min(old.code) AS replaces FROM ${work} r
    JOIN skus old ON old.workspace_id=r.workspace_id AND old.id=r.sku_id JOIN items oi ON oi.workspace_id=old.workspace_id AND oi.id=old.item_id
    JOIN skus t ON t.workspace_id=r.workspace_id AND t.id=r.replacement_sku_id AND t.is_active=1
    WHERE r.workspace_id=$1 AND r.status='RETIRED' AND (lower(old.code)=$2 OR lower(coalesce(old.barcode,''))=$2 OR position($2 in lower(old.code||' '||oi.name))>0)
    GROUP BY r.replacement_sku_id ORDER BY min(old.code) LIMIT 10`,[workspaceId,term])).rows;
}

// The product page: each discontinued SKU of this product, the stock still to
// sell, its clearance plan and its replacement.
async function forItem(db,workspaceId,itemId){
  if(!await has(db,work))return null;
  return (await db.query(`SELECT r.id,r.status,r.sku_id,old.code AS old_code,r.applied->>'clearancePlanId' AS clearance_plan_id,
      trim_scale(coalesce((SELECT sum(b.on_hand) FROM balances b WHERE b.workspace_id=r.workspace_id AND b.sku_id=r.sku_id),0)::numeric)::text AS on_hand,
      CASE WHEN t.is_active=1 AND ti.is_active=1 THEN t.code END AS replacement_code,
      CASE WHEN t.is_active=1 AND ti.is_active=1 THEN t.item_id END AS replacement_item_id,
      CASE WHEN t.is_active=1 AND ti.is_active=1 THEN ti.name END AS replacement_name
    FROM ${work} r JOIN skus old ON old.workspace_id=r.workspace_id AND old.id=r.sku_id
    LEFT JOIN skus t ON t.workspace_id=r.workspace_id AND t.id=r.replacement_sku_id LEFT JOIN items ti ON ti.workspace_id=t.workspace_id AND ti.id=t.item_id
    WHERE r.workspace_id=$1 AND r.item_id=$2 AND r.status IN ${OPEN} ORDER BY old.code`,[workspaceId,itemId])).rows;
}

module.exports={discontinued,forSkus,replacementsFor,forItem};

'use strict';

const { ValidationError } = require('../domain/errors');
const { hash } = require('../pricing/postgres-promotions');
const policy = require('../commercial/agent-plan');
const owner = require('../autopilot/team-procedure-source').owner;

function input(raw) {
  const supplierId = String(raw.supplierId || '');
  const reference = String(raw.reference || '').trim();
  const text = String(raw.products || '');
  if (!supplierId || !reference || reference.length > 200 || /[\x00-\x1f]/.test(reference) || text.length > 30000)
    throw new ValidationError('Choose the known supplier, enter its discontinuation reference and list the exact old and replacement SKUs.');
  const grid = require('../imports/parser').parseDelimited(text, ',');
  if (grid.length < 2 || grid.length > 101 || grid[0].join(',').toLowerCase() !== 'discontinued sku,replacement sku')
    throw new ValidationError('Use the columns Discontinued SKU,Replacement SKU, with one to 100 product pairs.');
  const seen = new Set();
  const pairs = grid.slice(1).map(row => {
    const oldCode = String(row[0] || '').trim(), replacementCode = String(row[1] || '').trim();
    if (row.length !== 2 || !oldCode || !replacementCode || oldCode.length > 160 || replacementCode.length > 160 || oldCode.toLowerCase() === replacementCode.toLowerCase() || seen.has(oldCode.toLowerCase()))
      throw new ValidationError('Each discontinued SKU needs one different, exact replacement SKU. List each old SKU once.');
    seen.add(oldCode.toLowerCase());
    return { oldCode, replacementCode };
  });
  if (pairs.some(p => seen.has(p.replacementCode.toLowerCase())))
    throw new ValidationError('A replacement cannot also be discontinued in this notice.');
  return { supplierId, reference, pairs };
}

async function facts(db, ctx, raw) {
  await owner(db, ctx);
  await policy.requireWorkspaceJob(db, ctx.workspaceId, 132, 'draft');
  const parsed = input(raw);
  const supplier = (await db.query("SELECT id,name,email,status FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'", [ctx.workspaceId, parsed.supplierId])).rows[0];
  if (!supplier) throw new ValidationError('Choose an active supplier already recorded in this inventory.');
  const codes = [...new Set(parsed.pairs.flatMap(p => [p.oldCode.toLowerCase(), p.replacementCode.toLowerCase()]))];
  const products = (await db.query(`SELECT s.id,s.code,s.item_id,s.is_active AS sku_active,i.name,i.is_active AS item_active,
      i.unit_label,i.tracking_mode,i.quantity_precision,i.quantity_increment,i.secondary_unit_label,i.secondary_precision,i.secondary_increment,
      (SELECT count(*)::int FROM skus sibling WHERE sibling.workspace_id=s.workspace_id AND sibling.item_id=s.item_id) AS variants,
      EXISTS(SELECT 1 FROM supplier_items si WHERE si.workspace_id=s.workspace_id AND si.sku_id=s.id AND si.supplier_id=$3 AND si.is_active=1) AS linked
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND lower(s.code)=ANY($2::text[]) ORDER BY s.id`, [ctx.workspaceId, codes, supplier.id])).rows;
  const pairs = parsed.pairs.map(pair => {
    const old = products.filter(p => p.code.toLowerCase() === pair.oldCode.toLowerCase());
    const replacements = products.filter(p => p.code.toLowerCase() === pair.replacementCode.toLowerCase());
    if (old.length !== 1 || replacements.length !== 1 || !old[0].linked || !replacements[0].linked)
      throw new ValidationError('Match each SKU to one existing product linked to this supplier. New products or uncertain replacements need separate review.');
    const a = old[0], b = replacements[0];
    if (a.variants !== 1 || b.variants !== 1 || !Number(a.item_active) || !Number(a.sku_active) || !Number(b.item_active) || !Number(b.sku_active))
      throw new ValidationError('This workflow retires active, single-SKU products and points to active, single-SKU replacements. Review variants separately.');
    if (a.unit_label !== b.unit_label || a.tracking_mode !== b.tracking_mode || a.quantity_precision !== b.quantity_precision || String(a.quantity_increment) !== String(b.quantity_increment) || a.secondary_unit_label !== b.secondary_unit_label || a.secondary_unit_label&&(a.secondary_precision!==b.secondary_precision||String(a.secondary_increment)!==String(b.secondary_increment)))
      throw new ValidationError('The old product and replacement use different stock units or tracking. Review the replacement separately.');
    return { old: a, replacement: b };
  });
  const ids = pairs.map(p => p.old.id);
  const blocked = (await db.query(`SELECT s.code,
      EXISTS(SELECT 1 FROM balances b WHERE b.workspace_id=s.workspace_id AND b.sku_id=s.id AND (b.on_hand<>0 OR coalesce(b.secondary_on_hand,0)<>0)) AS stock,
      EXISTS(SELECT 1 FROM accounting_inventory_cost_balances c WHERE c.workspace_id=s.workspace_id AND c.sku_id=s.id AND (c.quantity_units<>0 OR coalesce(c.secondary_quantity_units,0)<>0 OR c.total_cost_minor<>0)) AS book_stock,
      EXISTS(SELECT 1 FROM sales_order_lines l JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
        WHERE l.workspace_id=s.workspace_id AND l.sku_id=s.id AND o.status NOT IN ('FULFILLED','CANCELLED')) AS sales,
      EXISTS(SELECT 1 FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
        WHERE l.workspace_id=s.workspace_id AND l.sku_id=s.id AND o.status NOT IN ('RECEIVED','CANCELLED')) AS purchases,
      EXISTS(SELECT 1 FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.workspace_id=l.workspace_id AND t.id=l.transfer_id
        WHERE l.workspace_id=s.workspace_id AND l.sku_id=s.id AND t.status NOT IN ('RECEIVED','CANCELLED')) AS transfers,
      EXISTS(SELECT 1 FROM kit_components k WHERE k.workspace_id=s.workspace_id AND (k.kit_sku_id=s.id OR k.component_sku_id=s.id)) AS kit,
      EXISTS(SELECT 1 FROM manufacturing_boms b WHERE b.workspace_id=s.workspace_id AND b.status<>'RETIRED'
        AND (b.output_sku_id=s.id OR b.definition @> jsonb_build_object('components',jsonb_build_array(jsonb_build_object('skuId',s.id))))) AS production,
      EXISTS(SELECT 1 FROM stockchief_runtime.agent_product_replacements r WHERE r.workspace_id=s.workspace_id AND r.replacement_sku_id=s.id) AS used_replacement
    FROM skus s WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])`, [ctx.workspaceId, ids])).rows;
  for (const p of blocked) {
    if (p.stock || p.book_stock) throw new ValidationError(p.code + ' still has stock. Resolve it through the ordinary physical stock workflow before retiring the product. No stock is written off here.');
    if (p.sales || p.purchases) throw new ValidationError(p.code + ' has an unfinished order. Complete or separately cancel it before retirement.');
    if (p.transfers || p.kit || p.production) throw new ValidationError(p.code + ' is used by an unfinished transfer, kit or production recipe. Review that work before retirement.');
    if (p.used_replacement) throw new ValidationError(p.code + ' is a saved replacement for another retired product. Review that guidance first.');
  }
  const core = { supplier, reference: parsed.reference, pairs };
  return { ...core, products: raw.products, sourceFingerprint: hash(core) };
}

module.exports = { input, facts, owner };

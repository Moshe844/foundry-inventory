'use strict';

const money=require('../domain/currency');
const {AuthorizationError,ValidationError}=require('../domain/errors');
const plan=require('../commercial/agent-plan');

// Each observation is a cost in minor currency units per an exact pricing
// quantity. Native catalogue sale prices are before sales tax. Receipt costs
// are booked goods costs, and invoice taxes and header charges are separate.
const comparisons=`WITH products AS MATERIALIZED (
  SELECT s.id,s.code,s.item_id,coalesce(i.secondary_unit_label,i.unit_label) AS unit,i.secondary_unit_label
  FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ($2='' OR s.id=$2 OR lower(s.code)=lower($2))
    AND EXISTS(SELECT 1 FROM sku_prices p WHERE p.workspace_id=$1 AND p.sku_id=s.id AND p.amount_minor>0)
), observations AS (
  SELECT c.sku_id,c.id,c.created_at AS at,c.currency,c.amount_minor::numeric AS numerator,1::numeric AS denominator,
    'Catalogue cost' AS kind,'/inventory/'||s.item_id AS link,'Saved catalogue cost' AS reference,1 AS precedence
  FROM products s JOIN sku_purchase_costs c ON c.workspace_id=$1 AND c.sku_id=s.id
  UNION ALL
  -- A receipt in another currency is booked in the accounting currency (job 40).
  SELECT s.id,r.id,r.created_at,coalesce(fx.base_currency,po.currency),
    CASE WHEN min(cm.unit_cost_minor)=max(cm.unit_cost_minor) AND bool_and(cm.unit_cost_minor IS NOT NULL
      AND (cm.secondary_quantity_delta>0) IS NOT DISTINCT FROM (CASE WHEN s.secondary_unit_label IS NOT NULL THEN true END)
      AND (cm.unit_cost_minor=0 OR (j.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries reversal
        WHERE reversal.workspace_id=j.workspace_id AND reversal.reversal_of_entry_id=j.id AND reversal.status='POSTED'))))
      THEN min(cm.unit_cost_minor) END,1,'Posted receipt','/purchasing/orders/'||po.id,po.po_number,2
  FROM products s JOIN purchase_order_receipt_lines l ON l.workspace_id=$1 AND l.sku_id=s.id
  JOIN purchase_order_receipts r ON r.workspace_id=l.workspace_id AND r.id=l.receipt_id
  JOIN purchase_orders po ON po.workspace_id=r.workspace_id AND po.id=r.purchase_order_id
  LEFT JOIN accounting_inventory_cost_movements cm ON cm.workspace_id=l.workspace_id AND cm.sku_id=l.sku_id
    AND cm.cost_source_type='purchase_order_receipt' AND cm.cost_source_record_id=r.id AND cm.quantity_delta>0 AND cm.quantity_delta=l.quantity_units
    AND l.movement_ids::jsonb ? cm.inventory_movement_id
  LEFT JOIN accounting_journal_entries j ON j.workspace_id=cm.workspace_id AND j.id=cm.journal_entry_id
    AND j.status='POSTED' AND j.source_type='purchase_receipt' AND j.source_record_id=r.id AND j.reversal_of_entry_id IS NULL
  LEFT JOIN LATERAL (SELECT x.base_currency FROM stockchief_runtime.agent_fx_receipt_rates x
    WHERE x.workspace_id=r.workspace_id AND x.receipt_id=r.id LIMIT 1) fx ON true
  WHERE po.delivery_kind<>'CUSTOMER_DIRECT'
  GROUP BY s.id,r.id,r.created_at,po.id,po.currency,fx.base_currency,po.po_number
  UNION ALL
  SELECT s.id,r.id,r.created_at,po.currency,
    CASE WHEN count(*)=1 AND bool_and(coalesce(fact->>'weightUnit',fact->>'unit')=s.unit
      AND (CASE WHEN s.secondary_unit_label IS NULL THEN l.secondary_quantity IS NULL ELSE l.secondary_quantity>0 END))
      THEN min((fact->>'unitCostMinor')::numeric) END,
    1,'Posted supplier dispatch','/autopilot/direct-shipments/'||o.id,po.po_number||' · '||d.supplier_reference,2
  FROM products s JOIN purchase_order_receipt_lines l ON l.workspace_id=$1 AND l.sku_id=s.id AND l.direct_dispatch_line_id IS NOT NULL
  JOIN purchase_order_receipts r ON r.workspace_id=l.workspace_id AND r.id=l.receipt_id
  JOIN purchase_orders po ON po.workspace_id=r.workspace_id AND po.id=r.purchase_order_id AND po.delivery_kind='CUSTOMER_DIRECT'
  JOIN stockchief_runtime.agent_direct_dispatch_lines dl ON dl.workspace_id=l.workspace_id AND dl.id=l.direct_dispatch_line_id
    AND dl.quantity=l.quantity_units AND dl.secondary_quantity IS NOT DISTINCT FROM l.secondary_quantity
  JOIN stockchief_runtime.agent_direct_dispatches d ON d.workspace_id=dl.workspace_id AND d.id=dl.dispatch_id
    AND d.state='APPLIED' AND d.purchase_receipt_id=r.id
  JOIN stockchief_runtime.agent_direct_order_lines ol ON ol.workspace_id=dl.workspace_id AND ol.id=dl.direct_order_line_id
    AND ol.purchase_order_line_id=l.purchase_order_line_id AND ol.direct_order_id=d.direct_order_id
  JOIN stockchief_runtime.agent_direct_orders o ON o.workspace_id=ol.workspace_id AND o.id=ol.direct_order_id AND o.purchase_order_id=po.id
  LEFT JOIN LATERAL jsonb_array_elements(o.facts->'products') fact
    ON fact->>'skuId'=s.id AND fact->>'salesOrderLineId'=ol.sales_order_line_id
  JOIN accounting_journal_entries j ON j.workspace_id=dl.workspace_id AND j.id=dl.journal_entry_id
    AND j.status='POSTED' AND j.source_type='sale_fulfillment' AND j.source_record_id=o.sales_order_id
    AND j.metadata::jsonb#>>'{supplierDirect,dispatchLineId}'=dl.id AND (j.metadata::jsonb#>>'{supplierDirect,costMinor}')::numeric=dl.cost_minor
  WHERE NOT EXISTS(SELECT 1 FROM accounting_journal_entries reversal
    WHERE reversal.workspace_id=j.workspace_id AND reversal.reversal_of_entry_id=j.id AND reversal.status='POSTED')
  GROUP BY s.id,r.id,r.created_at,po.currency,o.id,po.po_number,d.supplier_reference
  UNION ALL
  SELECT s.id,b.id,b.opened_at,b.currency,
    CASE WHEN count(*)=1 AND bool_and(
      (CASE WHEN s.secondary_unit_label IS NULL THEN l.secondary_quantity IS NULL ELSE l.secondary_quantity>0 END)
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.charges) charge WHERE charge->>'kind'='discount'))
      THEN min(coalesce(l.source_unit_cost_minor,l.unit_cost_minor)) END,
    min(coalesce(l.source_price_quantity,l.price_quantity)),'Posted bill','/money/bills/'||b.id,b.bill_number,3
  FROM products s JOIN accounting_supplier_bill_lines l ON l.workspace_id=$1 AND l.sku_id=s.id
  JOIN accounting_supplier_bills b ON b.workspace_id=l.workspace_id AND b.id=l.bill_id
  JOIN purchase_order_lines pol ON pol.workspace_id=l.workspace_id AND pol.id=l.purchase_order_line_id
    AND pol.sku_id=s.id AND pol.purchase_order_id=b.purchase_order_id
  JOIN accounting_journal_entries j ON j.workspace_id=b.workspace_id AND j.id=b.journal_entry_id AND j.status='POSTED'
    AND j.source_type='supplier_invoice' AND j.source_record_id=b.id AND j.reversal_of_entry_id IS NULL
  WHERE b.status IN ('OPEN','PARTIALLY_PAID','PAID') AND b.match_status='MATCHED' AND b.opened_at IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries reversal
      WHERE reversal.workspace_id=j.workspace_id AND reversal.reversal_of_entry_id=j.id AND reversal.status='POSTED')
  GROUP BY s.id,b.id,b.opened_at,b.currency,b.bill_number
), history AS (
  SELECT o.*,lag(currency) OVER recorded AS prior_currency,lag(numerator) OVER recorded AS prior_num,
    lag(denominator) OVER recorded AS prior_den
  FROM observations o
  WINDOW recorded AS (PARTITION BY sku_id ORDER BY at,precedence,id)
), changes AS (
  SELECT h.*,row_number() OVER (PARTITION BY sku_id ORDER BY at DESC,precedence DESC,id DESC) AS age,
    sum(CASE WHEN currency IS DISTINCT FROM prior_currency OR numerator IS NULL OR prior_num IS NULL THEN 1 ELSE 0 END)
      OVER (PARTITION BY sku_id ORDER BY at,precedence,id) AS comparable_period
  FROM history h WHERE currency IS DISTINCT FROM prior_currency OR numerator IS NULL OR prior_num IS NULL
    OR numerator*prior_den<>prior_num*denominator
), priced AS (
  SELECT DISTINCT ON(s.id) s.*,c.id AS cost_id,c.kind,c.reference,c.at AS cost_at,c.link AS cost_link,c.currency,c.numerator,trim_scale(c.denominator) AS denominator,
    base.id AS previous_cost_id,base.kind AS previous_kind,base.reference AS previous_reference,base.at AS previous_cost_at,
    base.numerator AS previous_num,trim_scale(base.denominator) AS previous_den,
    p.id AS price_id,p.amount_minor AS price,old.id AS previous_price_id,old.amount_minor AS previous_price,
    old.amount_minor::numeric*c.numerator*base.denominator AS price_num,
    base.numerator*c.denominator AS price_den
  FROM products s JOIN changes c ON c.sku_id=s.id AND c.age=1
  JOIN changes prev ON prev.sku_id=s.id AND prev.age=2 AND prev.comparable_period=c.comparable_period
  JOIN changes base ON base.sku_id=s.id AND base.age>=2 AND base.comparable_period=c.comparable_period
    AND (base.kind='Catalogue cost')=(prev.kind='Catalogue cost')
  JOIN LATERAL(SELECT id,currency,amount_minor,source FROM sku_prices WHERE workspace_id=$1 AND sku_id=s.id
    ORDER BY created_at DESC,id DESC LIMIT 1) p ON p.currency=c.currency AND p.source NOT IN ('provider_catalog_sync','provider_opening_catalog')
  JOIN LATERAL(SELECT id,currency,amount_minor,source,created_at FROM sku_prices WHERE workspace_id=$1 AND sku_id=s.id AND created_at<c.at
    ORDER BY created_at DESC,id DESC LIMIT 1) old ON old.currency=c.currency AND old.source NOT IN ('provider_catalog_sync','provider_opening_catalog')
  WHERE c.denominator>0 AND prev.denominator>0 AND c.numerator*prev.denominator>prev.numerator*c.denominator
  -- Keep the last margin the selling price actually covered. Subsequent
  -- cost increases do not turn an unapproved price into the new baseline.
  ORDER BY s.id,(base.at<=old.created_at) DESC,CASE WHEN base.at<=old.created_at THEN base.at END DESC,base.at,
    base.precedence DESC,base.id DESC
), candidates AS (
  SELECT priced.*,div(price_num,nullif(price_den,0))+CASE WHEN mod(price_num,nullif(price_den,0))>0 THEN 1 ELSE 0 END AS suggested
  FROM priced WHERE price_den>0 AND previous_price*previous_den>previous_num AND numerator*previous_den>previous_num*denominator
)
SELECT * FROM candidates WHERE price<suggested AND suggested<=9007199254740991`;

const summary='Compares goods costs before tax using the saved selling unit and the same currency. A higher cost can come from a catalogue cost, posted receipt, supplier dispatch or matched bill. The suggestion preserves the gross goods margin before the rise and rounds up to a whole minor currency unit. Review mismatched currency, unit or tax evidence before changing a price. Each catalogue price change needs your approval.';
const notices=`SELECT 77 AS job,'Cost increase' AS kind,id AS ref,'/autopilot/reviews/margin-prices' AS link,$3::date AS due
  FROM (${comparisons}) margin_changes`;

function costLabel(numerator,denominator,currency,unit){
  const basis=denominator==='1'?unit:denominator+' '+(unit==='unit'?'units':unit);
  return money.format(numerator,currency)+' per '+basis;
}

async function candidates(db,ctx,sku,page){
  const {rows}=await db.query(comparisons+' ORDER BY code,id LIMIT 51 OFFSET $3',[ctx.workspaceId,sku,(page-1)*50]);
  return rows;
}

async function review(db,ctx,{filter,page}){
  const results=await candidates(db,ctx,filter,page);
  return {rows:results.slice(0,50).map(r=>({SKU:r.code,'Pricing unit':r.unit,Currency:r.currency,
    'Previous cost':costLabel(r.previous_num,r.previous_den,r.currency,r.unit),
    'Previous cost evidence':r.previous_kind+' · '+r.previous_reference+' · '+r.previous_cost_at.slice(0,10),
    'Current cost':costLabel(r.numerator,r.denominator,r.currency,r.unit),'Current cost evidence':r.kind+' · '+r.reference+' · '+r.cost_at.slice(0,10),
    'Current selling price':money.format(r.price,r.currency),'Suggested selling price':money.format(r.suggested,r.currency),link:r.cost_link})),
    more:results.length>50,summary};
}

async function assertOwner(db,ctx){
  const owner=await db.query(`SELECT 1 FROM workspaces w JOIN users u ON u.workspace_id=w.id AND u.account_id=w.owner_account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId]);
  if(!owner.rowCount)throw new AuthorizationError('Only the current inventory owner can approve a margin price.');
}

async function build(db,ctx,_record,args){
  await assertOwner(db,ctx);
  const state=await plan.accountState(db,ctx.workspaceId);
  plan.requireJob(plan.usesAgentTerms(state)?state.plan:null,77,'draft');
  const restriction=await plan.stopped(db,ctx.workspaceId,state,'catalog.restore_margin',false);
  if(restriction)throw new ValidationError(restriction);
  if(!args.sku)throw new ValidationError('Choose the exact SKU to review.');
  const rows=await candidates(db,ctx,args.sku,1);
  if(rows.length!==1)throw new ValidationError('There is no single comparable margin-recovery price for that SKU. Check the recorded units, currencies and goods costs.');
  const r=rows[0];
  return {payload:{skuId:r.id,costId:r.cost_id,priorCostId:r.previous_cost_id,priceId:r.price_id,priorPriceId:r.previous_price_id,
    amountMinor:money.integer(r.suggested),currency:r.currency,unit:r.unit,
    currentCost:r.numerator+'/'+r.denominator,priorCost:r.previous_num+'/'+r.previous_den},
    summary:'Change the catalogue price of '+r.code+' from '+money.format(r.price,r.currency)+' to '+money.format(r.suggested,r.currency)+
      ' per '+r.unit+'. Cost rose from '+costLabel(r.previous_num,r.previous_den,r.currency,r.unit)+' ('+r.previous_reference+
      ') to '+costLabel(r.numerator,r.denominator,r.currency,r.unit)+' ('+r.reference+'). Approve this price for the local catalogue.'};
}

async function execute(client,ctx,p){
  await client.query('SELECT id FROM skus WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,p.skuId]);
  const current=(await build(client,ctx,null,{sku:p.skuId})).payload;
  // Earlier proposals froze the same record IDs and price but had no
  // explicit pricing-unit fields. Recheck those IDs against today's evidence.
  const fields=['skuId','costId','priorCostId','priceId','priorPriceId','amountMinor','currency'];
  for(const field of ['unit','currentCost','priorCost'])if(Object.hasOwn(p,field))fields.push(field);
  if(fields.some(key=>current[key]!==p[key]))throw new ValidationError('The recorded costs or selling price changed. Review a new price.');
  return require('./postgres-service').setPriceInTransaction(client,ctx,{skuId:p.skuId,amountMinor:p.amountMinor,
    currency:p.currency,expectedCurrentId:p.priceId,source:'agent_margin_approval',
    sourceDetail:{costId:p.costId,priorCostId:p.priorCostId,unit:current.unit,currentCost:current.currentCost,priorCost:current.priorCost}});
}

async function verify(db,ctx,result,p){
  const price=await require('./postgres-service').currentPrice(db,ctx.workspaceId,p.skuId);
  return price.id===result.id&&price.amount_minor===p.amountMinor&&price.currency===p.currency;
}

module.exports={summary,notices,review,assertOwner,build,execute,verify};

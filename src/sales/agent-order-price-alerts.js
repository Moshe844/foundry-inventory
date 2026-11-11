'use strict';

const money=require('../domain/currency');
const history=require('../commercial/agent-history');

// Use the immutable quote for the exact order and line, even when the order
// points to an older revision. Older quotes used their saved line index.
function findings(historyFrom){
  return `WITH selected AS MATERIALIZED (
    SELECT o.id,o.order_number,o.currency,o.discount_minor,o.pricing_quote_id,q.id AS quote_id,q.quote,
      CASE WHEN jsonb_typeof(q.quote->'lineIds')='array' THEN ARRAY(SELECT jsonb_array_elements_text(q.quote->'lineIds')) END AS line_ids,
      q.created_at::text AS priced_at
    FROM sales_orders o LEFT JOIN LATERAL (
      SELECT snap.id,snap.quote,snap.created_at FROM stockchief_runtime.pricing_order_snapshots snap
      WHERE snap.workspace_id=o.workspace_id AND snap.sales_order_id=o.id
      ORDER BY snap.created_at DESC,(snap.id=o.pricing_quote_id) DESC,snap.id DESC LIMIT 1
    ) q ON true
    WHERE o.workspace_id=$1 AND o.status<>'CANCELLED' AND (${historyFrom}::text IS NULL OR o.order_date>=${historyFrom})
      AND ($2='' OR lower(o.order_number)=lower($2) OR EXISTS (
        SELECT 1 FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
        WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id AND lower(s.code)=lower($2)))
  ), postings AS (
    SELECT o.id,j.metadata::jsonb AS evidence
    FROM selected o JOIN accounting_settings a ON a.workspace_id=$1 AND a.base_currency=o.currency
    JOIN accounting_journal_entries j ON j.workspace_id=a.workspace_id AND j.source_record_id=o.id
      AND j.source_record_type='sales_order' AND j.source_type='sale_fulfillment'
      AND j.status='POSTED' AND j.reversal_of_entry_id IS NULL
    WHERE NOT EXISTS(SELECT 1 FROM accounting_journal_entries reversal WHERE reversal.workspace_id=j.workspace_id
      AND reversal.reversal_of_entry_id=j.id AND reversal.status='POSTED')
  ), fulfilled AS (
    SELECT p.id,evidence->>'salesOrderLineId' AS line_id,
      sum((evidence->>'grossMinor')::numeric-(evidence->>'discountMinor')::numeric
        +least(coalesce((evidence->>'chargesMinor')::numeric,0),0)) AS net,
      sum((evidence->>'cogsMinor')::numeric) AS cost
    FROM postings p WHERE jsonb_typeof(evidence->'grossMinor')='number'
      AND jsonb_typeof(evidence->'discountMinor')='number' AND jsonb_typeof(evidence->'cogsMinor')='number'
    GROUP BY p.id,evidence->>'salesOrderLineId'
  ), ordered_lines AS (
    SELECT o.id,o.order_number,o.currency,o.quote_id,o.priced_at,o.quote->>'currency' AS quote_currency,
      s.code,l.id AS line_id,l.sku_id,l.unit_price_minor,l.quantity_ordered,l.secondary_quantity_ordered,l.external_line_id,
      l.pricing_snapshot AS copy,o.quote->'lines' AS saved_lines,f.net AS actual_net,f.cost AS actual_cost,
      CASE WHEN o.line_ids IS NOT NULL THEN array_position(o.line_ids,l.id)-1
        WHEN l.pricing_snapshot->>'index'~'^[0-9]{1,3}$' THEN (l.pricing_snapshot->>'index')::int END AS line_index
    FROM selected o JOIN sales_order_lines l ON l.workspace_id=$1 AND l.sales_order_id=o.id
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    LEFT JOIN fulfilled f ON f.id=o.id AND f.line_id=l.id
  ), mapped AS (
    SELECT l.*,CASE WHEN line_index IS NOT NULL AND count(*) OVER(PARTITION BY id,line_index)=1
      THEN saved_lines->line_index END AS quoted
    FROM ordered_lines l
  ), compared AS (
    SELECT m.*,(quoted->>'discountMinor')::numeric AS quoted_discount,
      (quoted->>'netMinor')::numeric+least(coalesce((quoted->>'chargesMinor')::numeric,0),0) AS quoted_net,
      coalesce((quoted->>'pricingQuantity')::numeric,(quoted->>'quantity')::numeric) AS pricing_quantity,
      CASE WHEN quoted#>>'{costEvidence,currency}'=currency THEN (quoted#>>'{costEvidence,amountMinor}')::numeric END AS cost_amount,
      CASE WHEN quoted#>>'{costEvidence,currency}'=currency THEN (quoted#>>'{costEvidence,quantity}')::numeric END AS cost_quantity,
      quoted#>>'{costEvidence,unit}' AS unit,(quoted->>'costUnitMinor')::numeric AS rounded_cost,
      quantity_ordered IS NOT DISTINCT FROM (quoted->>'quantity')::numeric
        AND secondary_quantity_ordered IS NOT DISTINCT FROM (quoted->>'pricingQuantity')::numeric AS quantities_match,
      quoted IS NOT NULL AND quoted->>'skuId'=sku_id AND quoted->>'externalLineId' IS NOT DISTINCT FROM external_line_id
        AND quote_currency=currency AS exact_line
    FROM mapped m
  ), problems AS (
    SELECT o.id,o.order_number,o.currency,NULL::text AS code,o.id AS line_id,o.priced_at,p.*
    FROM selected o CROSS JOIN LATERAL (VALUES
      ('Order uses an older pricing revision',o.quote_id IS NOT NULL AND o.pricing_quote_id IS DISTINCT FROM o.quote_id,
        true,NULL::numeric,NULL::numeric,NULL::numeric,NULL::text,'Saved quote revision'),
      ('Order discount differs from approved quote',o.quote->>'currency'=o.currency
        AND o.discount_minor IS DISTINCT FROM (o.quote->>'discountMinor')::bigint,
        true,o.discount_minor::numeric,(o.quote->>'discountMinor')::numeric,NULL,NULL,'Recorded and approved discount'),
      ('Order currency differs from approved quote',o.quote_id IS NOT NULL AND o.quote->>'currency' IS DISTINCT FROM o.currency,
        false,NULL,NULL,NULL,NULL,'Currency needs review')
    ) p(problem,found,actionable,recorded,compared_amount,basis_quantity,basis_unit,evidence) WHERE p.found
    UNION ALL
    SELECT l.id,l.order_number,l.currency,l.code,l.line_id,l.priced_at,p.*
    FROM compared l CROSS JOIN LATERAL (VALUES
      ('No reviewed line price',l.exact_line IS NOT TRUE OR l.copy IS NULL,false,NULL::numeric,NULL::numeric,NULL::numeric,NULL::text,'Saved line evidence is incomplete'),
      ('Price differs from the reviewed line',l.exact_line AND
        (l.unit_price_minor IS DISTINCT FROM (l.quoted->>'unitPriceMinor')::bigint
          OR l.copy IS NOT NULL AND l.copy->'unitPriceMinor' IS DISTINCT FROM l.quoted->'unitPriceMinor'),
        true,l.unit_price_minor::numeric,(l.quoted->>'unitPriceMinor')::numeric,NULL,NULL,'Recorded and approved unit price'),
      ('Line discount differs from reviewed amounts',l.exact_line AND l.copy IS NOT NULL
        AND (l.copy->'discountMinor' IS DISTINCT FROM l.quoted->'discountMinor'
          OR l.copy->'netMinor' IS DISTINCT FROM l.quoted->'netMinor' OR l.copy->'grossMinor' IS DISTINCT FROM l.quoted->'grossMinor'
          OR l.copy->'adjustments' IS DISTINCT FROM l.quoted->'adjustments'),
        true,CASE WHEN jsonb_typeof(l.copy->'discountMinor')='number' THEN (l.copy->>'discountMinor')::numeric END,
        l.quoted_discount,NULL,NULL,'Recorded and approved line discount'),
      ('Order quantity differs from the reviewed line',l.exact_line
        AND (NOT l.quantities_match
          OR l.copy IS NOT NULL AND l.copy->'pricingQuantity' IS DISTINCT FROM l.quoted->'pricingQuantity'),
        false,NULL,NULL,NULL,NULL,'Pricing quantity needs review'),
      ('Selling below recorded cost',l.actual_net<l.actual_cost,
        true,l.actual_net,l.actual_cost,NULL,NULL,'Posted goods revenue and cost'),
      ('Selling below recorded cost',l.exact_line AND l.quantities_match
        AND l.unit_price_minor=(l.quoted->>'unitPriceMinor')::bigint AND (l.actual_net<l.actual_cost) IS NOT TRUE AND (
        l.cost_quantity>0 AND l.quoted_net*l.cost_quantity<l.cost_amount*l.pricing_quantity
        OR l.cost_amount IS NULL AND l.rounded_cost>0 AND l.quoted_net<=(l.rounded_cost-1)*l.pricing_quantity),
        true,l.quoted_net,l.cost_amount,l.cost_quantity,l.unit,'Quoted goods revenue and saved cost basis'),
      ('Cost precision needs review',l.exact_line AND l.cost_amount IS NULL AND l.rounded_cost>0
        AND l.quoted_net>(l.rounded_cost-1)*l.pricing_quantity AND l.quoted_net<l.rounded_cost*l.pricing_quantity,
        false,l.quoted_net,NULL,NULL,NULL,'Earlier cost evidence was rounded per unit'),
      ('Cost evidence unavailable',l.exact_line AND l.cost_amount IS NULL AND l.rounded_cost IS NULL AND l.actual_cost IS NULL,
        false,NULL,NULL,NULL,NULL,'No same-currency cost was saved')
    ) p(problem,found,actionable,recorded,compared_amount,basis_quantity,basis_unit,evidence) WHERE p.found
      AND ($2='' OR lower(l.order_number)=lower($2) OR lower(l.code)=lower($2))
  )
  SELECT id,order_number,currency,code,line_id,priced_at,problem,actionable,trim_scale(recorded) AS recorded,
    trim_scale(compared_amount) AS compared_amount,
    trim_scale(basis_quantity) AS basis_quantity,basis_unit,evidence FROM problems`;
}

const summary='Compares the order with its latest saved pricing revision and checks goods revenue after approved discounts, before tax. Below-cost findings use the exact cost saved when the order was priced or the posted cost of fulfilled goods. Missing or rounded evidence is listed for review.';

function notices(historyFrom){
  return `SELECT DISTINCT 82 AS job,'Order pricing' AS kind,id AS ref,'/orders/'||id AS link,$3::date AS due
    FROM (${findings(historyFrom)}) prices WHERE actionable`;
}

async function review(db,ctx,{filter,page}){
  const {salesFrom}=await history.access(db,ctx.workspaceId);
  const {rows}=await db.query(findings('$3')+` ORDER BY actionable DESC,order_number,code NULLS FIRST,line_id,problem
    LIMIT 101 OFFSET $4`,[ctx.workspaceId,filter,salesFrom,(page-1)*100]);
  return {rows:rows.slice(0,100).map(row=>{
    const amount=value=>value==null?null:money.format(value,row.currency);
    const basis=amount(row.compared_amount);
    return {Order:row.order_number,SKU:row.code,Problem:row.problem,Evidence:row.evidence,
      'Recorded amount':amount(row.recorded),
      'Compared amount':basis&&row.basis_quantity?basis+' per '+row.basis_quantity+' '+row.basis_unit:basis,
      'Saved pricing revision':row.priced_at,link:'/orders/'+row.id};
  }),more:rows.length>100,summary};
}

module.exports={summary,notices,review};

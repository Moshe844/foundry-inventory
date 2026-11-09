'use strict';
const sql=`WITH connectors AS (
  SELECT c.*,coalesce((v.configuration->>'syncIntervalSeconds')::integer,60) AS minimum_seconds
  FROM workspace_connectors c JOIN workspaces w ON w.id=c.workspace_id
  LEFT JOIN account_subscriptions sub ON sub.account_id=w.owner_account_id LEFT JOIN commercial_plan_versions v ON v.id=sub.plan_version_id AND v.plan_id=sub.plan_id
  WHERE c.workspace_id=$1 AND (c.provider_type IN ('shopify','woocommerce','square','clover','bigcommerce','amazon','ebay')
    OR EXISTS(SELECT 1 FROM connection_commerce_positions p WHERE p.workspace_id=c.workspace_id AND p.connector_id=c.id))
), health AS (
  SELECT c.*,CASE WHEN c.paused_at IS NOT NULL OR c.config::jsonb->>'syncDisabled'='true' THEN 'Sync paused'
    WHEN c.status='error' OR c.setup_status='REAUTHORIZATION_REQUIRED' OR nullif(c.last_error,'') IS NOT NULL THEN 'Sync needs attention'
    WHEN c.status='disconnected' AND c.provider_account_id IS NOT NULL THEN 'Channel disconnected'
    WHEN c.status='connected' AND greatest(c.last_synced_at::timestamptz,c.last_activity_at::timestamptz,c.created_at::timestamptz)
       +greatest(c.expected_interval_minutes*60,c.minimum_seconds,60)*interval '2 seconds'<now() THEN 'No recent sync activity' END AS problem FROM connectors c
), positions AS (
  SELECT c.id,c.display_name,s.code,l.name AS location,p.id AS position,CASE WHEN jsonb_typeof(p.baseline_provider)='number' THEN p.baseline_provider::text::numeric END AS remote,
    CASE WHEN l.custody_agreement_id IS NOT NULL THEN 0 ELSE greatest(0,least(coalesce(b.on_hand,0),coalesce(cost.quantity_units,0))
      -coalesce(alloc.quantity,0)) END AS available,p.last_verified_at
  FROM connectors c JOIN connection_commerce_positions p ON p.workspace_id=c.workspace_id AND p.connector_id=c.id AND p.field='quantity' AND p.mode<>'off'
  JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id AND s.is_active=1
  JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id AND l.is_active=1
  LEFT JOIN balances b ON b.workspace_id=p.workspace_id AND b.sku_id=p.sku_id AND b.location_id=p.location_id
  LEFT JOIN accounting_inventory_cost_balances cost ON cost.workspace_id=p.workspace_id AND cost.sku_id=p.sku_id AND cost.location_id=p.location_id
  LEFT JOIN LATERAL (SELECT sum(quantity) AS quantity FROM sales_stock_commitments a WHERE a.workspace_id=p.workspace_id AND a.sku_id=p.sku_id AND a.location_id=p.location_id) alloc ON true
  WHERE jsonb_typeof(p.baseline_provider)='number' AND p.last_verified_at IS NOT NULL AND c.status='connected'
), problems AS (
  SELECT id,display_name,problem,NULL::text AS sku,NULL::text AS location,NULL::numeric AS remote,NULL::numeric AS available,
    last_synced_at::timestamptz AS observed,id AS reference FROM health WHERE problem IS NOT NULL
  UNION ALL SELECT id,display_name,'Channel quantity exceeds available stock',code,location,remote,available,last_verified_at,position FROM positions WHERE remote>available
) SELECT display_name AS "Channel",problem AS "Alert",sku AS "SKU",location AS "Location",remote AS "Last verified channel quantity",
  available AS "Stock after sales commitments",observed AS "Last evidence",reference,'/settings/connections/'||id AS link
  FROM problems WHERE $2='' OR lower(display_name)=lower($2) OR lower(sku)=lower($2)
  ORDER BY display_name,problem,sku,location,reference`;
module.exports={sql};

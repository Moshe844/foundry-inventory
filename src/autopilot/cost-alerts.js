'use strict';

// Job 170: cost and margin alerts. Alone on Growth, Pro and Custom; Starter
// is excluded.
//
// The routine check (operational-notices.refresh, run by the worker) raises an
// alert for each of these and clears it when it no longer holds:
//  - a cost that rose by the owner's percentage or more (any rise when the
//    owner set none) in the last 30 days. Each kind of cost is compared with
//    the one before it of the same kind:
//      the saved purchase cost of a product;
//      the cost of goods when received, per unit, with the freight, duty and
//      other charges added to that receipt (landed cost);
//      a supplier's price on an invoice, quote or price list still open for
//      review, against the approved purchase order or earlier trusted price
//      (job 91's evidence).
//  - gross margin under the owner's percentage:
//      per item: its selling price against its newest recorded cost;
//      per category and per sales channel: posted sales minus the posted cost
//      of the goods sold, over the last 30 days.
// Gross margin is used, before fees and shipping. Net margin after fees,
// shipping and returns has its own alert (job 85). A cost in another currency
// is never compared: a change of currency starts a new comparison.
//
// Alerts change nothing, so they show in the app and in Needs you in every
// mode. Email goes through agent-alerts.js.

const money=require('../domain/currency');

const JOB=170,key='cost-alerts',path='/autopilot/reviews/'+key,label='Cost and margin alerts';
const WINDOW_DAYS=30;
const summary='Costs that rose by your percentage or more in the last 30 days, each against the cost before it in the same currency: the saved purchase cost, '+
  'the cost when goods arrived (with freight and duty), and supplier prices waiting for review. Margins are gross margins, before fees and shipping: '+
  'each item’s price against its newest cost, and each category’s and sales channel’s sales over the last 30 days.';

// $1 workspace, $2 an exact SKU, category or channel ('' for all), $3 the business date.
const sql=`WITH setting AS MATERIALIZED (
  SELECT margin_pct,cost_rise_pct FROM stockchief_runtime.agent_alert_settings WHERE workspace_id=$1 AND job_id=${JOB}
), zone AS MATERIALIZED (
  SELECT coalesce(w.time_zone,a.time_zone,'UTC') AS tz FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1
), products AS MATERIALIZED (
  SELECT s.id,s.code,s.item_id,nullif(trim(f.category),'') AS category
  FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
  LEFT JOIN catalogue_item_facts f ON f.workspace_id=s.workspace_id AND f.item_id=s.item_id
  WHERE s.workspace_id=$1 AND s.is_active=1
), receipts AS (
  SELECT l.sku_id,r.id,max(r.received_at)::timestamptz AS at,coalesce(fx.base_currency,po.currency) AS currency,po.po_number,
    CASE WHEN count(cm.id)=count(*) AND sum(l.quantity_units)>0
      THEN (sum(cm.cost_delta_minor)+coalesce(sum(lc.landed),0))::numeric/sum(l.quantity_units) END AS unit_cost,
    coalesce(sum(lc.landed),0)<>0 AS landed
  FROM purchase_order_receipt_lines l JOIN products p ON p.id=l.sku_id
  JOIN purchase_order_receipts r ON r.workspace_id=l.workspace_id AND r.id=l.receipt_id
  JOIN purchase_orders po ON po.workspace_id=r.workspace_id AND po.id=r.purchase_order_id AND po.delivery_kind<>'CUSTOMER_DIRECT'
  LEFT JOIN LATERAL (SELECT x.base_currency FROM stockchief_runtime.agent_fx_receipt_rates x
    WHERE x.workspace_id=r.workspace_id AND x.receipt_id=r.id LIMIT 1) fx ON true
  LEFT JOIN accounting_inventory_cost_movements cm ON cm.workspace_id=l.workspace_id AND cm.sku_id=l.sku_id
    AND cm.cost_source_type='purchase_order_receipt' AND cm.cost_source_record_id=r.id AND cm.quantity_delta=l.quantity_units
    AND l.movement_ids::jsonb ? cm.inventory_movement_id
  LEFT JOIN LATERAL (SELECT sum(a.amount_minor) AS landed FROM landed_cost_allocations a
    JOIN landed_cost_documents d ON d.workspace_id=a.workspace_id AND d.id=a.document_id AND d.status='APPLIED'
      AND d.currency=coalesce(fx.base_currency,po.currency)
    WHERE a.workspace_id=l.workspace_id AND a.receipt_line_id=l.id) lc ON true
  WHERE l.workspace_id=$1
  GROUP BY l.sku_id,r.id,fx.base_currency,po.currency,po.po_number
), costs AS (
  SELECT c.sku_id,'Purchase cost' AS source,c.id AS ref,c.created_at::timestamptz AS at,c.currency,c.amount_minor::numeric AS unit_cost,
    'Saved purchase cost' AS evidence
  FROM sku_purchase_costs c JOIN products p ON p.id=c.sku_id WHERE c.workspace_id=$1
  UNION ALL
  SELECT sku_id,'Cost when received',id,at,currency,unit_cost,
    'Receipt on '||po_number||CASE WHEN landed THEN ', with freight and duty' ELSE '' END FROM receipts
), ordered AS (
  SELECT c.*,lag(c.currency) OVER w AS previous_currency,lag(c.unit_cost) OVER w AS previous_cost,
    row_number() OVER (PARTITION BY c.sku_id,c.source ORDER BY c.at DESC,c.ref DESC) AS age,
    row_number() OVER (PARTITION BY c.sku_id ORDER BY c.at DESC,c.ref DESC) AS newest
  FROM costs c WINDOW w AS (PARTITION BY c.sku_id,c.source ORDER BY c.at,c.ref)
), rises AS (
  SELECT o.* FROM ordered o CROSS JOIN zone z LEFT JOIN setting st ON true
  WHERE o.age=1 AND o.previous_currency=o.currency AND o.previous_cost>0 AND o.unit_cost>o.previous_cost
    AND (st.cost_rise_pct IS NULL OR 100*(o.unit_cost-o.previous_cost)>=st.cost_rise_pct*o.previous_cost)
    AND (o.at AT TIME ZONE z.tz)::date BETWEEN $3::date-${WINDOW_DAYS - 1} AND $3::date
), supplier AS (
  SELECT f.sku,f.supplier,f.kind,f.source_id,f.document,f.currency,f.href,
    f.amount::numeric/f.priced::numeric AS unit_cost,f.prior_amount::numeric/f.prior_priced::numeric AS previous_cost
  FROM (${require('../purchasing/agent-supplier-price-increases').findings}) f
  WHERE f.actionable AND f.priced::numeric>0 AND f.prior_priced::numeric>0 AND f.prior_amount::numeric>0
), supplier_rises AS (
  SELECT s.*,p.item_id FROM supplier s JOIN products p ON p.code=s.sku LEFT JOIN setting st ON true
  WHERE s.unit_cost>s.previous_cost AND (st.cost_rise_pct IS NULL OR 100*(s.unit_cost-s.previous_cost)>=st.cost_rise_pct*s.previous_cost)
), prices AS (
  SELECT p.id AS sku_id,x.amount_minor AS selling,x.currency FROM products p
  JOIN LATERAL (SELECT amount_minor,currency FROM sku_prices WHERE workspace_id=$1 AND sku_id=p.id ORDER BY created_at DESC,id DESC LIMIT 1) x
    ON x.amount_minor IS NOT NULL
), item_margins AS (
  SELECT o.*,pr.selling,st.margin_pct,CASE WHEN pr.selling>0 THEN round(100.0*(pr.selling-o.unit_cost)/pr.selling,2) END AS margin
  FROM ordered o JOIN prices pr ON pr.sku_id=o.sku_id AND pr.currency=o.currency CROSS JOIN setting st
  WHERE o.newest=1 AND o.unit_cost IS NOT NULL AND st.margin_pct IS NOT NULL
    AND (pr.selling>0 AND 100*(pr.selling-o.unit_cost)<pr.selling*st.margin_pct OR pr.selling=0 AND o.unit_cost>0)
), sold AS MATERIALIZED (
  SELECT coalesce(o.id,r.sales_order_id) AS order_id,l.sku_id,l.currency,
    sum(CASE WHEN a.system_key IN ('SALES_REVENUE','SALES_RETURNS') THEN l.credit_minor-l.debit_minor ELSE 0 END)::numeric AS revenue,
    sum(CASE WHEN a.system_key='COST_OF_GOODS_SOLD' THEN l.debit_minor-l.credit_minor ELSE 0 END)::numeric AS cogs
  FROM accounting_journal_entries e
  LEFT JOIN accounting_journal_entries original ON original.workspace_id=e.workspace_id AND original.id=e.reversal_of_entry_id
  CROSS JOIN LATERAL (SELECT coalesce(original.source_record_type,e.source_record_type) AS kind,
    coalesce(original.source_record_id,e.source_record_id) AS record) src
  LEFT JOIN sales_orders o ON src.kind='sales_order' AND o.workspace_id=e.workspace_id AND o.id=src.record
  LEFT JOIN customer_returns r ON src.kind='customer_return' AND r.workspace_id=e.workspace_id AND r.id=src.record
  JOIN accounting_journal_lines l ON l.workspace_id=e.workspace_id AND l.entry_id=e.id
  JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
    AND a.system_key IN ('SALES_REVENUE','SALES_RETURNS','COST_OF_GOODS_SOLD')
  WHERE e.workspace_id=$1 AND e.status='POSTED' AND e.posting_date>=($3::date-${WINDOW_DAYS - 1})::text AND e.posting_date<=($3::date)::text
    AND coalesce(o.id,r.sales_order_id) IS NOT NULL AND EXISTS(SELECT 1 FROM setting WHERE margin_pct IS NOT NULL)
  GROUP BY 1,2,3
), channels AS (
  SELECT x.order_id,CASE WHEN count(c.id)=0 THEN 'Direct' WHEN count(DISTINCT c.id)=1 THEN min(c.display_name) END AS name
  FROM (SELECT DISTINCT order_id FROM sold) x
  LEFT JOIN connection_mappings m ON m.workspace_id=$1 AND m.entity_type='sales_order' AND m.foundry_record_id=x.order_id
  LEFT JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id
  GROUP BY x.order_id
), groups AS (
  SELECT 'Category' AS level,min(p.category) AS name,lower(p.category) AS group_key,s.currency,sum(s.revenue) AS revenue,sum(s.cogs) AS cogs
  FROM sold s JOIN products p ON p.id=s.sku_id WHERE p.category IS NOT NULL GROUP BY lower(p.category),s.currency
  UNION ALL
  SELECT 'Channel',min(c.name),lower(c.name),s.currency,sum(s.revenue),sum(s.cogs)
  FROM sold s JOIN channels c ON c.order_id=s.order_id WHERE c.name IS NOT NULL GROUP BY lower(c.name),s.currency
), group_margins AS (
  SELECT g.*,st.margin_pct,CASE WHEN g.revenue>0 THEN round(100.0*(g.revenue-g.cogs)/g.revenue,2) END AS margin
  FROM groups g CROSS JOIN setting st
  WHERE st.margin_pct IS NOT NULL AND (g.revenue>0 AND 100*(g.revenue-g.cogs)<g.revenue*st.margin_pct OR g.revenue<=0 AND g.cogs>0)
), alerts AS (
  SELECT p.code AS subject,CASE r.source WHEN 'Purchase cost' THEN 'Purchase cost increased' ELSE 'Received cost increased' END AS alert,
    r.evidence AS source,r.currency,r.unit_cost AS cost,r.previous_cost,round(100*(r.unit_cost-r.previous_cost)/r.previous_cost,2) AS rise,
    NULL::numeric AS price,NULL::numeric AS sales,NULL::numeric AS margin,NULL::numeric AS minimum,
    CASE r.source WHEN 'Purchase cost' THEN r.ref ELSE r.ref||':'||r.sku_id END AS reference,'/inventory/'||p.item_id AS link
  FROM rises r JOIN products p ON p.id=r.sku_id
  UNION ALL
  SELECT s.sku,'Supplier price increased',s.kind||' '||s.document||coalesce(' from '||s.supplier,''),s.currency,s.unit_cost,s.previous_cost,
    round(100*(s.unit_cost-s.previous_cost)/s.previous_cost,2),NULL,NULL,NULL,NULL,s.kind||':'||s.source_id||':'||s.sku,s.href
  FROM supplier_rises s
  UNION ALL
  SELECT p.code,'Below your gross margin',m.evidence,m.currency,m.unit_cost,CASE WHEN m.previous_currency=m.currency THEN m.previous_cost END,NULL,
    m.selling,NULL,m.margin,m.margin_pct,p.code,'/inventory/'||p.item_id
  FROM item_margins m JOIN products p ON p.id=m.sku_id
  UNION ALL
  SELECT g.name,g.level||' below your gross margin','Posted sales, last ${WINDOW_DAYS} days',g.currency,g.cogs,NULL,NULL,NULL,g.revenue,g.margin,g.margin_pct,
    lower(g.level)||':'||g.group_key||':'||g.currency,'${path}'
  FROM group_margins g
) SELECT subject AS "Applies to",alert AS "Alert",source AS "Source",currency AS "Currency",cost,previous_cost,rise AS "Cost up %",
  price,sales,margin AS "Gross margin %",minimum AS "Your minimum %",reference,link
FROM alerts WHERE ($2='' OR lower(subject)=lower($2)) ORDER BY subject,alert,reference`;

const amount=(value,currency)=>value==null?null:money.format(Math.round(Number(value)),currency);
const percent=value=>value==null?null:String(Number(value))+'%';
// One row for the page: who it is about, what happened, and the evidence.
function describe(r){
  const margin=r.Alert.endsWith('below your gross margin')||r.Alert==='Below your gross margin';
  const details=r.Alert==='Below your gross margin'?'Sells at '+amount(r.price,r.Currency)+' · your minimum '+percent(r['Your minimum %'])+' · '+r.Source
    :margin?amount(r.sales,r.Currency)+' net sales, '+amount(r.cost,r.Currency)+' cost of goods, last '+WINDOW_DAYS+' days · your minimum '+percent(r['Your minimum %'])
    :'Up '+percent(r['Cost up %'])+' · '+r.Source;
  return {'Applies to':r['Applies to'],Alert:r.Alert,
    Cost:r.Alert==='Below your gross margin'||!margin?amount(r.cost,r.Currency):'',
    'Previous cost':margin&&r.Alert!=='Below your gross margin'?'':amount(r.previous_cost,r.Currency)??'',
    'Gross margin %':margin?(r['Gross margin %']==null?'None':r['Gross margin %']):'',
    Details:details,link:r.link};
}

async function ready(db){return require('../db/schema-installed').has(db,'stockchief_runtime.agent_alert_settings','cost_rise_pct');}

async function review(db,ctx,{filter='',page=1,today}){
  if(!await ready(db))return {rows:[],more:false,summary:'Cost and margin alerts are being upgraded. Check back shortly.'};
  const {rows}=await db.query(sql+' LIMIT 101 OFFSET $4',[ctx.workspaceId,filter||'',today,(page-1)*100]);
  return {rows:rows.slice(0,100).map(describe),more:rows.length>100,summary};
}

// One plain line per alert, for the alert email.
function line(r){
  if(r.Alert==='Below your gross margin')return 'Below your gross margin: '+r['Applies to']+' sells at '+amount(r.price,r.Currency)+' and costs '+amount(r.cost,r.Currency)+
    (r['Gross margin %']==null?'.':', a '+percent(r['Gross margin %'])+' gross margin.')+' Your minimum is '+percent(r['Your minimum %'])+'.';
  if(r.Alert.endsWith('below your gross margin'))return r.Alert+': '+r['Applies to']+' made '+(r['Gross margin %']==null?'no gross margin':percent(r['Gross margin %'])+' gross margin')+
    ' on '+amount(r.sales,r.Currency)+' of net sales in the last '+WINDOW_DAYS+' days. Your minimum is '+percent(r['Your minimum %'])+'.';
  return r.Alert+': '+r['Applies to']+' from '+amount(r.previous_cost,r.Currency)+' to '+amount(r.cost,r.Currency)+' (up '+percent(r['Cost up %'])+'). '+r.Source+'.';
}
async function lines(db,workspaceId,keys){
  const today=await require('../lib/business-time').today(db,workspaceId);
  const rows=(await db.query(sql,[workspaceId,'',today])).rows;
  const found=new Map(rows.map(r=>[r.Alert+'\u0000'+r.reference+'\u0000'+r.link,r]));
  return keys.map(k=>{const r=found.get(k.kind+'\u0000'+k.reference+'\u0000'+k.link);return r?line(r):k.kind+'.';});
}

module.exports={JOB,key,path,label,summary,sql,ready,review,lines,describe};

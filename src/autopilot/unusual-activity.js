'use strict';

// Job 171: unusual activity. Alone on Pro and Custom; Starter and Growth are
// excluded.
//
// The routine check (operational-notices.refresh, run by the worker) raises an
// alert for each of these in the last seven days of the business calendar,
// and clears it when it no longer holds:
//  - a stock correction (count adjustment) of the owner's number of units or
//    more, or one at least three times the product's usual correction over the
//    90 days before it (with three or more earlier corrections);
//  - a selling price change of the owner's percentage or more, or one at least
//    three times the product's usual price change over the year before it
//    (with three or more earlier changes);
//  - one person making the owner's number of changes or deletions in a day, or
//    at least ten and three times their usual daily number over the four weeks
//    before; changes are stock corrections, price and cost changes and product
//    edits, and deletions are customers, suppliers, products and imports;
//  - any stock movement, price or cost change, product edit or deletion inside
//    the hours the owner watches (outside business hours).
// Logins from new places are not recorded by StockChief, so they are not
// checked.
//
// An alert never blocks work: it is shown, audited (agent-alerts.track) and
// emailed to the owner. The circuit breaker (job 201) stays separate.

const money=require('../domain/currency');

const JOB=171,key='unusual-stock-activity',path='/autopilot/reviews/'+key,label='Unusual activity';
const summary='Activity in the last seven days that looks unusual: a big stock correction, a big selling price change, many changes or deletions '+
  'by one person in a day, and anything changed during the hours you watch. Big means your own number, or three times what is usual for that product or person. '+
  'Nothing is blocked; you are told.';

// Text timestamps are ISO dates first: a day of margin keeps the index usable.
const after=(column,bound)=>`${column}>=to_char((${bound}) AT TIME ZONE 'UTC'-interval '1 day','YYYY-MM-DD') AND ${column}::timestamptz>=${bound}`;

// $1 workspace, $2 an exact SKU, person or location ('' for all), $3 the business date.
const sql=`WITH zone AS MATERIALIZED (
  SELECT coalesce(i.time_zone,a.time_zone,'UTC') AS tz FROM workspaces i JOIN accounts a ON a.id=i.owner_account_id WHERE i.id=$1
), rules AS MATERIALIZED (
  SELECT st.adjustment_units,st.night_from,st.night_until,st.edit_count,st.price_change_pct FROM (SELECT 1) one
  LEFT JOIN stockchief_runtime.agent_alert_settings st ON st.workspace_id=$1 AND st.job_id=${JOB}
), bounds AS MATERIALIZED (
  SELECT z.tz,($3::date-6)::timestamp AT TIME ZONE z.tz AS since,($3::date+1)::timestamp AT TIME ZONE z.tz AS until,
    ($3::date-34)::timestamp AT TIME ZONE z.tz AS history FROM zone z
), people AS MATERIALIZED (SELECT id,name FROM users WHERE workspace_id=$1
), stock AS MATERIALIZED (
  SELECT m.id,m.operation,m.quantity_delta,m.sku_id,s.code,s.item_id,l.name AS location,m.actor_user_id AS actor,m.occurred_at::timestamptz AS at
  FROM movements m CROSS JOIN bounds b JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id
  JOIN locations l ON l.workspace_id=m.workspace_id AND l.id=m.location_id
  WHERE m.workspace_id=$1 AND ${after('m.occurred_at','b.since')} AND m.occurred_at::timestamptz<b.until
), corrections AS (
  SELECT st.id,h.n AS earlier,h.usual FROM stock st
  LEFT JOIN LATERAL (SELECT count(*) AS n,avg(abs(x.quantity_delta)) AS usual FROM movements x
    WHERE x.workspace_id=$1 AND x.sku_id=st.sku_id AND x.operation='adjust' AND x.id<>st.id
      AND ${after('x.occurred_at',"st.at-interval '90 days'")} AND x.occurred_at::timestamptz<st.at) h ON true
  WHERE st.operation='adjust'
), touched AS (
  SELECT DISTINCT p.sku_id FROM sku_prices p CROSS JOIN bounds b
  WHERE p.workspace_id=$1 AND ${after('p.created_at','b.since')} AND p.created_at::timestamptz<b.until
), price_steps AS (
  SELECT p.id,p.sku_id,p.currency,p.amount_minor,p.created_by_user_id AS actor,p.created_at::timestamptz AS at,
    lag(p.amount_minor) OVER w AS previous,lag(p.currency) OVER w AS previous_currency
  FROM sku_prices p JOIN touched t ON t.sku_id=p.sku_id WHERE p.workspace_id=$1
  WINDOW w AS (PARTITION BY p.sku_id ORDER BY p.created_at,p.id)
), price_moves AS (
  SELECT *,abs(amount_minor-previous)*100.0/previous AS pct FROM price_steps
  WHERE previous_currency=currency AND previous>0 AND amount_minor IS NOT NULL AND amount_minor<>previous
), price_history AS MATERIALIZED (
  SELECT m.*,count(*) OVER previous_year AS earlier,avg(m.pct) OVER previous_year AS usual
  FROM price_moves m CROSS JOIN bounds b WHERE m.at>=b.since-interval '365 days' AND m.at<b.until
  WINDOW previous_year AS (PARTITION BY m.sku_id ORDER BY m.at
    RANGE BETWEEN interval '365 days' PRECEDING AND interval '1 microsecond' PRECEDING)
), prices AS (
  SELECT m.*,s.code,s.item_id FROM price_history m CROSS JOIN bounds b
  JOIN skus s ON s.workspace_id=$1 AND s.id=m.sku_id
  WHERE m.at>=b.since AND m.at<b.until
), changes AS (
  SELECT m.id,'Stock correction' AS what,m.actor_user_id AS actor,m.occurred_at::timestamptz AS at,false AS deleted,NULL::text AS subject,NULL::text AS link
  FROM movements m CROSS JOIN bounds b WHERE m.workspace_id=$1 AND m.operation='adjust' AND ${after('m.occurred_at','b.history')}
  UNION ALL
  SELECT p.id,'Selling price change',p.created_by_user_id,p.created_at::timestamptz,false,s.code,'/inventory/'||s.item_id
  FROM sku_prices p CROSS JOIN bounds b JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id
  WHERE p.workspace_id=$1 AND ${after('p.created_at','b.history')}
  UNION ALL
  SELECT c.id,'Purchase cost change',c.created_by_user_id,c.created_at::timestamptz,false,s.code,'/inventory/'||s.item_id
  FROM sku_purchase_costs c CROSS JOIN bounds b JOIN skus s ON s.workspace_id=c.workspace_id AND s.id=c.sku_id
  WHERE c.workspace_id=$1 AND ${after('c.created_at','b.history')}
  UNION ALL
  SELECT h.id,'Product change',h.actor_id,h.created_at,false,coalesce(s.code,i.name),'/inventory/'||h.item_id
  FROM catalogue_change_history h CROSS JOIN bounds b LEFT JOIN skus s ON s.workspace_id=h.workspace_id AND s.id=h.sku_id
  LEFT JOIN items i ON i.workspace_id=h.workspace_id AND i.id=h.item_id
  WHERE h.workspace_id=$1 AND h.created_at>=b.history
  UNION ALL
  SELECT e.id,'Deleted '||coalesce(e.after_state->>'kind','record'),e.actor_id,e.created_at,true,e.reference,'/activity'
  FROM security_event_history e CROSS JOIN bounds b WHERE e.workspace_id=$1 AND e.action='Record deleted' AND e.created_at>=b.history
), daily AS (
  SELECT c.actor,(c.at AT TIME ZONE b.tz)::date AS day,count(*) AS n,count(*) FILTER (WHERE c.deleted) AS deleted
  FROM changes c CROSS JOIN bounds b WHERE c.actor IS NOT NULL AND c.at>=b.since AND c.at<b.until GROUP BY 1,2
), usual AS (
  SELECT c.actor,count(*) AS n FROM changes c CROSS JOIN bounds b WHERE c.actor IS NOT NULL AND c.at<b.since GROUP BY 1
), busy AS (
  SELECT d.*,coalesce(u.n,0)/28.0 AS usual FROM daily d LEFT JOIN usual u ON u.actor=d.actor CROSS JOIN rules r
  WHERE r.edit_count IS NOT NULL AND d.n>=r.edit_count OR u.n>0 AND d.n>=10 AND d.n*28>=3*u.n
), watched AS (
  SELECT x.*,r.adjustment_units,r.price_change_pct,
    r.night_from IS NOT NULL AND CASE WHEN r.night_from<r.night_until
      THEN extract(hour FROM x.at AT TIME ZONE b.tz)>=r.night_from AND extract(hour FROM x.at AT TIME ZONE b.tz)<r.night_until
      ELSE extract(hour FROM x.at AT TIME ZONE b.tz)>=r.night_from OR extract(hour FROM x.at AT TIME ZONE b.tz)<r.night_until END AS night,
    to_char(x.at AT TIME ZONE b.tz,'YYYY-MM-DD HH24:MI') AS local_time
  FROM (
    SELECT 'stock' AS area,st.id,st.code AS subject,'/inventory/'||st.item_id AS link,st.actor,st.at,st.operation AS what,st.quantity_delta AS units,st.location,
      NULL::text AS currency,NULL::numeric AS amount,NULL::numeric AS previous,
      CASE WHEN c.earlier>=3 AND abs(st.quantity_delta)>=3*c.usual THEN c.usual END AS usual
    FROM stock st LEFT JOIN corrections c ON c.id=st.id
    UNION ALL
    SELECT 'price',p.id,p.code,'/inventory/'||p.item_id,p.actor,p.at,'Selling price change',NULL,NULL,p.currency,p.amount_minor,p.previous,
      CASE WHEN p.earlier>=3 AND p.pct>=3*p.usual THEN p.usual END
    FROM prices p
    UNION ALL
    SELECT 'change',c.id,c.subject,c.link,c.actor,c.at,c.what,NULL,NULL,NULL,NULL,NULL,NULL
    FROM changes c CROSS JOIN bounds b WHERE c.what<>'Stock correction' AND c.what<>'Selling price change' AND c.at>=b.since AND c.at<b.until
  ) x CROSS JOIN rules r CROSS JOIN bounds b
), alerts AS (
  SELECT w.*,CASE
      WHEN w.area='stock' AND w.what='adjust' AND (w.adjustment_units IS NOT NULL AND abs(w.units)>=w.adjustment_units OR w.usual IS NOT NULL)
        THEN CASE WHEN w.night THEN 'Large adjustment during watched hours' WHEN w.adjustment_units IS NOT NULL AND abs(w.units)>=w.adjustment_units
          THEN 'Large adjustment' ELSE 'Unusual adjustment for this product' END
      WHEN w.area='price' AND (w.price_change_pct IS NOT NULL AND abs(w.amount-w.previous)*100>=w.price_change_pct*w.previous OR w.usual IS NOT NULL)
        THEN 'Unusual price change'
      WHEN w.night THEN CASE WHEN w.area='stock' THEN 'Stock change during watched hours' ELSE 'Change during watched hours' END
    END AS alert
  FROM watched w
)
SELECT a.subject,a.alert AS "Alert",a.area,a.what,a.units,a.location,a.currency,a.amount,a.previous,a.usual,a.adjustment_units,a.price_change_pct,
  NULL::bigint AS changes,NULL::bigint AS deletions,coalesce(p.name,CASE WHEN a.actor IS NULL THEN 'StockChief or a connection' ELSE 'A former team member' END) AS person,
  a.local_time,a.at,a.id::text AS reference,a.link
FROM alerts a LEFT JOIN people p ON p.id=a.actor
WHERE a.alert IS NOT NULL AND ($2='' OR lower(a.subject)=lower($2) OR lower(p.name)=lower($2) OR lower(a.location)=lower($2))
UNION ALL
SELECT p.name,'Many changes by one person','person',NULL,NULL,NULL,NULL,NULL,NULL,y.usual,NULL,NULL,y.n,y.deleted,p.name,y.day::text,
  y.day::timestamp AT TIME ZONE b.tz,y.actor||':'||y.day::text,'/activity'
FROM busy y CROSS JOIN bounds b JOIN people p ON p.id=y.actor
WHERE $2='' OR lower(p.name)=lower($2)
ORDER BY at DESC,reference`;

const operations={adjust:'Stock correction',receive:'Stock received',issue:'Stock issued',transfer:'Stock moved'};
const units=value=>{const n=Number(value);return (n>0?'+':'')+n+' '+(Math.abs(n)===1?'unit':'units');};
const amount=(value,currency)=>money.format(Math.round(Number(value)),currency);
const round=value=>String(Math.round(Number(value)*10)/10);
// What happened, in plain words.
function details(r){
  if(r.area==='person')return r.changes+' change'+(Number(r.changes)===1?'':'s')+(Number(r.deletions)?', '+r.deletions+' of them deletions':'')+
    (r.usual!=null&&Number(r.usual)>0?' · usually about '+round(r.usual)+' a day':'');
  if(r.area==='stock')return (operations[r.what]||r.what)+' of '+units(r.units)+' at '+r.location+
    (r.usual!=null?' · usually about '+round(r.usual)+(round(r.usual)==='1'?' unit':' units'):r.adjustment_units!=null&&r.Alert.startsWith('Large')?' · your limit '+Number(r.adjustment_units)+' units':'');
  if(r.area==='price'){
    const change=Math.round(Math.abs(Number(r.amount)-Number(r.previous))*1000/Number(r.previous))/10;
    return 'Selling price '+amount(r.previous,r.currency)+' to '+amount(r.amount,r.currency)+' ('+(Number(r.amount)>Number(r.previous)?'up':'down')+' '+change+'%)'+
      (r.usual!=null?' · usually about '+round(r.usual)+'%':'');
  }
  return r.what;
}
function describe(r){
  return {What:r.subject,Alert:r.Alert,'Units changed':r.area==='stock'?Number(r.units):'','Recorded by':r.person,
    'Local time':r.local_time,Details:details(r),link:r.link};
}

async function ready(db){return require('../db/schema-installed').has(db,'stockchief_runtime.agent_alert_settings','edit_count');}

async function review(db,ctx,{filter='',page=1,today}){
  if(!await ready(db))return {rows:[],more:false,summary:'Unusual activity alerts are being upgraded. Check back shortly.'};
  const {rows}=await db.query(sql+' LIMIT 101 OFFSET $4',[ctx.workspaceId,filter||'',today,(page-1)*100]);
  return {rows:rows.slice(0,100).map(describe),more:rows.length>100,summary};
}

// One plain line per alert, for the alert email.
function line(r){
  return r.Alert+': '+(r.area==='person'?r.person+' on '+r.local_time:(r.subject?r.subject+', ':'')+'by '+r.person+' at '+r.local_time)+'. '+details(r)+'.';
}
async function lines(db,workspaceId,keys){
  const today=await require('../lib/business-time').today(db,workspaceId);
  const rows=(await db.query(sql,[workspaceId,'',today])).rows;
  const found=new Map(rows.map(r=>[r.Alert+'\u0000'+r.reference+'\u0000'+r.link,r]));
  return keys.map(k=>{const r=found.get(k.kind+'\u0000'+k.reference+'\u0000'+k.link);return r?line(r):k.kind+'.';});
}

module.exports={JOB,key,path,label,summary,sql,ready,review,lines,describe};

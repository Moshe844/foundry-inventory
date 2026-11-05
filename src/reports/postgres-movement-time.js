'use strict';
const zone="(SELECT coalesce(w.time_zone,a.time_zone,'UTC') FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1)";
const instant='stockchief_movement_instant(m.occurred_at)';
const boundsMarker='/* movement_date_bounds */';
// A headline needs one additive total, not a timestamp table that is then
// immediately summed again. Apply the same indexed bounds to the raw quantity.
const additiveTotalSource=`SELECT m.quantity_delta::numeric AS quantity_delta FROM movements m WHERE m.workspace_id=$1 ${boundsMarker}`;
// A receipt batch often contains many movements at the same instant. Preserve
// exact additive quantities, then convert each distinct timestamp once. Counts,
// averages and row-value filters must continue to read individual events.
const additiveSource=`WITH movement_instants AS MATERIALIZED (
 SELECT m.occurred_at,sum(m.quantity_delta)::numeric AS quantity_delta
 FROM movements m WHERE m.workspace_id=$1 ${boundsMarker}
 GROUP BY m.occurred_at
) SELECT m.quantity_delta,to_char(stockchief_movement_instant(m.occurred_at) AT TIME ZONE ${zone},'YYYY-MM-DD') AS occurred_on
 FROM movement_instants m`;
function applied(filter){return filter.field==='occurred_on'&&['after','at_least','before','at_most','equals','greater_than','less_than','is_null'].includes(filter.operator);}
function bound(source,config,{parameterBase=1,dateContext=null,values=null}={}){
 // The clock was already read for this report. Binding its zone lets PostgreSQL
 // estimate the actual indexed date range instead of an unknown InitPlan value.
 const needsZone=source.includes(zone)||config.filters.some(filter=>applied(filter)&&filter.operator!=='is_null');
 const reportZone=needsZone&&dateContext?.timeZone&&values?`$${values.push(dateContext.timeZone)}::text`:zone;
 const additiveChart=source===additiveSource;
 if(reportZone!==zone)source=source.replaceAll(zone,reportZone);
 let parameter=parameterBase;const predicates=[],lower=[],upper=[];let first=-Infinity,last=Infinity;
 for(const filter of config.filters){
  if(!['is_null','is_empty','not_empty'].includes(filter.operator))parameter++;
  if(filter.field!=='occurred_on')continue;
  if(applied(filter)&&filter.operator!=='is_null'){
   const value=String(filter.value),parsed=Date.parse(value);
   if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.startsWith('0000-')||!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==value)
    throw new(require('../domain/errors').ValidationError)('Choose a real calendar date for movement records.');
   const day=`$${parameter}::text::date`;
   if(['after','at_least','equals','greater_than'].includes(filter.operator)){
    const next=filter.operator==='greater_than';lower.push(next?`(${day}+1)`:day);first=Math.max(first,parsed+(next?86400000:0));
   }
   if(['before','at_most','equals','less_than'].includes(filter.operator)){
    const prior=filter.operator==='less_than';upper.push(prior?`(${day}-1)`:day);last=Math.min(last,parsed-(prior?86400000:0));
   }
  }
  const start=`($${parameter}::text::date::timestamp AT TIME ZONE ${reportZone})`;
  // Add a calendar day before converting to UTC: DST days are not always 24h.
  const end=`(($${parameter}::text::date+1)::timestamp AT TIME ZONE ${reportZone})`;
  if(['after','at_least','equals'].includes(filter.operator))predicates.push(`${instant}>=${start}`);
  if(['before','at_most','equals'].includes(filter.operator))predicates.push(`${instant}<${end}`);
  if(filter.operator==='greater_than')predicates.push(`${instant}>=${end}`);
  if(filter.operator==='less_than')predicates.push(`${instant}<${start}`);
  if(filter.operator==='is_null')predicates.push(`${instant} IS NULL`);
 }
 // A bounded calendar chart needs one indexed SUM per business day, not a
 // hash table for every distinct timestamp. Each UTC range is calculated once
 // from the local midnight and the following local midnight, including DST.
 // Open-ended, very long and row-level reports retain the general source.
 const summary=require('../projections/postgres-movement-buckets');
 if(additiveChart&&dateContext?.timeZone&&lower.length&&upper.length&&last-first<=366*86400000&&config.filters.every(f=>applied(f)&&f.operator!=='is_null'))return `
  WITH movement_bucket_ready AS MATERIALIZED(${summary.readySql}),movement_days AS (
   SELECT day,day AT TIME ZONE ${reportZone} AS day_start,(day+interval '1 day') AT TIME ZONE ${reportZone} AS day_end
   FROM generate_series(GREATEST(${lower.join(',')})::timestamp,LEAST(${upper.join(',')})::timestamp,interval '1 day') AS days(day)
  ) SELECT m.quantity_delta,to_char(d.day,'YYYY-MM-DD') AS occurred_on FROM movement_days d
  CROSS JOIN LATERAL(SELECT sum(parts.quantity_delta)::numeric AS quantity_delta FROM (${summary.rangeSource('d.day_start','d.day_end')}) parts) m
  WHERE m.quantity_delta IS NOT NULL`;
 if(source===additiveTotalSource&&dateContext?.timeZone&&lower.length&&upper.length&&config.filters.every(f=>applied(f)&&f.operator!=='is_null')){
  const start=`(GREATEST(${lower.join(',')})::timestamp AT TIME ZONE ${reportZone})`,end=`((LEAST(${upper.join(',')})+1)::timestamp AT TIME ZONE ${reportZone})`;
  return `WITH movement_bucket_ready AS MATERIALIZED(${summary.readySql}) ${summary.rangeSource(start,end)}`;
 }
 const bounds=predicates.length?' AND '+predicates.join(' AND '):'';
 return source.includes(boundsMarker)?source.replace(boundsMarker,bounds):source+bounds;
}
async function warnings(database,workspaceId){
 const rows=(await database.query(`SELECT coalesce(nullif(s.code,''),i.name,'an item') label
  FROM movements m LEFT JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id
  LEFT JOIN items i ON i.workspace_id=m.workspace_id AND i.id=m.item_id
  WHERE m.workspace_id=$1 AND stockchief_movement_instant(m.occurred_at) IS NULL
  LIMIT 3`,[workspaceId])).rows;
 return rows.length?['Some stock movement dates need review: '+rows.map(r=>r.label).join(', ')+'. These movements are excluded from date-filtered totals.']:[];
}
module.exports={bound,applied,warnings,additiveSource,additiveTotalSource};

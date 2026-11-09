'use strict';
const eligible="source='postgres_autopilot' AND category IN ('stock_transfer','replenishment_plan') AND NOT (coalesce(outcome,'{}')::jsonb ? 'decision')";
const pending="approval_requirement<>'NONE' AND execution_status NOT IN ('COMPLETED','CANCELLED','FAILED')";
const base=`SELECT id,created_at,priority,inbox_kind AS kind,inbox_location AS location,inbox_currency AS currency,inbox_value AS money FROM work_items WHERE workspace_id=$1 AND ${pending} AND ${eligible}`;
async function summary(db,workspaceId){
 const groups=(await db.query(`WITH candidates AS (${base}) SELECT kind,location,currency,count(*)::int AS count,min(created_at) AS created_at,max(priority) AS priority FROM candidates GROUP BY kind,location,currency ORDER BY max(priority) DESC,kind,location,currency`,[workspaceId])).rows;
 // Three or more of the same decision are one line with an expandable list, whatever the total.
 if(groups.every(g=>g.count<3))return db.query(`SELECT * FROM work_items WHERE workspace_id=$1 AND ${pending} ORDER BY priority DESC,created_at`,[workspaceId]);
 // Shown one by one: pending work that is not a grouped candidate, plus the
 // candidates of groups smaller than three. Both id sets come from partial
 // indexes; only the rows shown are read in full (a large inbox held 62,666).
 const small=groups.filter(g=>g.count<3).map(g=>({kind:g.kind,location:g.location,currency:g.currency}));
 const rows=(await db.query(`WITH pending_ids AS MATERIALIZED (SELECT id FROM work_items WHERE workspace_id=$1 AND ${pending}),
  candidate_ids AS MATERIALIZED (SELECT id,inbox_kind,inbox_location,inbox_currency FROM work_items WHERE workspace_id=$1 AND ${pending} AND ${eligible}),
  wanted AS (SELECT id FROM pending_ids EXCEPT SELECT id FROM candidate_ids
   UNION SELECT c.id FROM candidate_ids c JOIN jsonb_to_recordset($2::jsonb) g(kind text,location text,currency text)
    ON c.inbox_kind IS NOT DISTINCT FROM g.kind AND c.inbox_location IS NOT DISTINCT FROM g.location AND c.inbox_currency IS NOT DISTINCT FROM g.currency)
  SELECT w.* FROM wanted JOIN work_items w ON w.workspace_id=$1 AND w.id=wanted.id ORDER BY w.priority DESC,w.created_at`,[workspaceId,JSON.stringify(small)])).rows;
 const locations=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[])',[workspaceId,groups.map(g=>g.location).filter(Boolean)])).rows;
 // Each large group shows its three most valuable decisions (read by index order)
 // and how many are urgent (a partial index holds only the urgent ones).
 const same=(g,values)=>[['inbox_kind',g.kind],['inbox_location',g.location],['inbox_currency',g.currency]].map(([column,value])=>value==null?` AND ${column} IS NULL`:(values.push(value),` AND ${column}=$${values.length}`)).join('');
 const urgentRows=(await db.query(`SELECT inbox_kind AS kind,inbox_location AS location,inbox_currency AS currency,count(*)::int AS urgent FROM work_items
  WHERE workspace_id=$1 AND ${pending} AND ${eligible} AND urgency='immediate' GROUP BY 1,2,3`,[workspaceId])).rows;
 const previews=[];
 for(const g of groups){if(g.count<3)continue;const values=[workspaceId];
  const names=(await db.query(`SELECT w.recommended_action::jsonb->>'displayName' AS name FROM (SELECT id,inbox_value,priority,created_at FROM work_items
   WHERE workspace_id=$1 AND ${pending} AND ${eligible}${same(g,values)} ORDER BY inbox_value DESC NULLS LAST,priority DESC,created_at,id LIMIT 3) top
   JOIN work_items w ON w.workspace_id=$1 AND w.id=top.id ORDER BY top.inbox_value DESC NULLS LAST,top.priority DESC,top.created_at,top.id`,values)).rows.map(r=>r.name);
  previews.push({kind:g.kind,location:g.location,currency:g.currency,names,urgent:urgentRows.find(u=>u.kind===g.kind&&u.location===g.location&&u.currency===g.currency)?.urgent||0});}
 for(const g of groups){if(g.count<3)continue;const preview=previews.find(p=>p.kind===g.kind&&p.location===g.location&&p.currency===g.currency)||{names:[],urgent:0};const name=locations.find(l=>l.id===g.location)?.name||'all locations',params=new URLSearchParams({kind:g.kind,location:g.location,currency:g.currency});rows.unshift({id:'group:'+params.toString(),summary:true,names:preview.names||[],urgentCount:preview.urgent||0,count:g.count,kind:g.kind,priority:g.priority,created_at:g.created_at,title:g.count.toLocaleString()+' replenishment decisions for '+name,href:'/needs-you/work?'+params.toString(),recommended_action:{type:g.kind},groupLabel:g.kind==='transfer'?'stock transfers':'supplier purchases'});}
 return {rows};
}
async function page(db,workspaceId,input){
 const kind=input.kind==='transfer'?'transfer':'purchase',location=String(input.location||'').slice(0,160),currency=String(input.currency||'').slice(0,8),q=String(input.q||'').trim().slice(0,200),pageSize=require('../web/presentation/pagination').SIZES.includes(Number(input.pageSize))?Number(input.pageSize):50,page=Math.min(1000000,Math.max(1,Number.parseInt(input.page,10)||1));
 const rows=(await db.query(`WITH candidates AS (${base}) SELECT w.*,c.money,c.currency,count(*) OVER() AS total FROM candidates c JOIN work_items w ON w.id=c.id AND w.workspace_id=$1 WHERE c.kind=$2 AND c.location=$3 AND c.currency=$4 AND ($5::text='' OR w.recommended_action::jsonb->>'displayName' ILIKE '%'||$5||'%' OR w.recommended_action::jsonb->>'code' ILIKE '%'||$5||'%') ORDER BY c.money DESC NULLS LAST,c.priority DESC,c.created_at,c.id LIMIT ${pageSize+1} OFFSET $6`,[workspaceId,kind,location,currency,q,(page-1)*pageSize])).rows;
 return {rows:rows.slice(0,pageSize).map(r=>({...r,action:JSON.parse(r.recommended_action),evidence:typeof r.source_evidence==='string'?JSON.parse(r.source_evidence||'[]'):r.source_evidence||[]})),total:Number(rows[0]?.total||0),hasMore:rows.length>pageSize,kind,location,currency,q,page};
}
module.exports={summary,page};

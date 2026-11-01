'use strict';
const eligible="source='postgres_autopilot' AND category IN ('stock_transfer','replenishment_plan') AND NOT (coalesce(outcome,'{}')::jsonb ? 'decision')";
const pending="approval_requirement<>'NONE' AND execution_status NOT IN ('COMPLETED','CANCELLED','FAILED')";
const base=`SELECT id,created_at,priority,inbox_kind AS kind,inbox_location AS location,inbox_currency AS currency,inbox_value AS money FROM work_items WHERE workspace_id=$1 AND ${pending} AND ${eligible}`;
async function summary(db,workspaceId){
 const groups=(await db.query(`WITH candidates AS (${base}) SELECT kind,location,currency,count(*)::int AS count,min(created_at) AS created_at,max(priority) AS priority FROM candidates GROUP BY kind,location,currency ORDER BY max(priority) DESC,kind,location,currency`,[workspaceId])).rows;
 if(groups.reduce((n,g)=>n+g.count,0)<=groups.length+10)return db.query(`SELECT * FROM work_items WHERE workspace_id=$1 AND ${pending} ORDER BY priority DESC,created_at`,[workspaceId]);
 const rows=(await db.query(`WITH candidates AS (${base}),ranked AS (SELECT id,row_number() OVER(PARTITION BY currency ORDER BY money DESC NULLS LAST,priority DESC,created_at,id) AS position FROM candidates),largest AS (SELECT id FROM ranked WHERE position<=10) SELECT * FROM work_items WHERE workspace_id=$1 AND ${pending} AND (NOT (${eligible}) OR id IN (SELECT id FROM largest)) ORDER BY priority DESC,created_at`,[workspaceId])).rows;
 const locations=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[])',[workspaceId,groups.map(g=>g.location).filter(Boolean)])).rows;
 for(const g of groups){const name=locations.find(l=>l.id===g.location)?.name||'all locations',params=new URLSearchParams({kind:g.kind,location:g.location,currency:g.currency});rows.unshift({id:'group:'+params.toString(),summary:true,count:g.count,kind:g.kind,priority:g.priority,created_at:g.created_at,title:g.count.toLocaleString()+' replenishment decisions for '+name,href:'/needs-you/work?'+params.toString(),recommended_action:{type:g.kind},groupLabel:g.kind==='transfer'?'stock transfers':'supplier purchases'});}
 return {rows};
}
async function page(db,workspaceId,input){
 const kind=input.kind==='transfer'?'transfer':'purchase',location=String(input.location||'').slice(0,160),currency=String(input.currency||'').slice(0,8),q=String(input.q||'').trim().slice(0,200),page=Math.min(1000000,Math.max(1,Number.parseInt(input.page,10)||1));
 const rows=(await db.query(`WITH candidates AS (${base}) SELECT w.*,c.money,c.currency,count(*) OVER() AS total FROM candidates c JOIN work_items w ON w.id=c.id AND w.workspace_id=$1 WHERE c.kind=$2 AND c.location=$3 AND c.currency=$4 AND ($5::text='' OR w.recommended_action::jsonb->>'displayName' ILIKE '%'||$5||'%' OR w.recommended_action::jsonb->>'code' ILIKE '%'||$5||'%') ORDER BY c.money DESC NULLS LAST,c.priority DESC,c.created_at,c.id LIMIT 51 OFFSET $6`,[workspaceId,kind,location,currency,q,(page-1)*50])).rows;
 return {rows:rows.slice(0,50).map(r=>({...r,action:JSON.parse(r.recommended_action)})),total:Number(rows[0]?.total||0),hasMore:rows.length>50,kind,location,currency,q,page};
}
module.exports={summary,page};

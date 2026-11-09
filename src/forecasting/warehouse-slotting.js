'use strict';
const {ValidationError}=require('../domain/errors');
const plans=require('../commercial/agent-plan');

async function saveDistance(db,ctx,input){
  const name=String(input.bin||'').trim(),value=String(input.metres??'').trim();
  if(!name||!/^\d{1,9}(\.\d{1,2})?$/.test(value))throw new ValidationError('Enter an active bin name and its measured distance to packing in metres.');
  return db.transaction(async c=>{
    const state=await require('../autopilot/job-reviews').ownerState(c,ctx);
    plans.requireJob(plans.usesAgentTerms(state)?state.plan:null,122,'draft');
    const {rows}=await c.query("SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND kind='bin' AND custody_agreement_id IS NULL AND (id=$2 OR lower(name)=lower($2)) FOR SHARE",[ctx.workspaceId,name]);
    if(rows.length!==1)throw new ValidationError('Choose one active bin in this inventory.');
    await c.query(`INSERT INTO stockchief_runtime.bin_packing_distances(workspace_id,location_id,metres,updated_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(workspace_id,location_id) DO UPDATE SET metres=EXCLUDED.metres,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [ctx.workspaceId,rows[0].id,value,ctx.actorId]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Recorded bin distance to packing',reference:rows[0].name,after:{metres:value}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function review(db,ctx,{filter,page,today}){
  // Restrict bin comparisons to the same measured site, through active parents.
  const {rows:bins}=await db.query(`WITH RECURSIVE tree(id,root,name) AS (
    SELECT id,id,name FROM locations WHERE workspace_id=$1 AND parent_location_id IS NULL AND is_active=1 AND custody_agreement_id IS NULL
    UNION ALL SELECT l.id,t.root,t.name FROM tree t JOIN locations l ON l.parent_location_id=t.id AND l.workspace_id=$1
      WHERE l.is_active=1 AND l.custody_agreement_id IS NULL)
    SELECT l.id,l.name,t.root,t.name site,d.metres,
      NOT EXISTS(SELECT 1 FROM balances b WHERE b.workspace_id=$1 AND b.location_id=l.id AND b.on_hand<>0) empty
    FROM stockchief_runtime.bin_packing_distances d JOIN locations l ON l.id=d.location_id AND l.workspace_id=d.workspace_id
    JOIN tree t ON t.id=l.id WHERE d.workspace_id=$1 AND l.kind='bin' AND l.parent_location_id IS NOT NULL
    ORDER BY d.metres,lower(l.name),l.id`,[ctx.workspaceId]);
  const byId=new Map(bins.map(b=>[b.id,b])),freeBins=new Map();
  for(const bin of bins.filter(b=>b.empty)){
    if(!freeBins.has(bin.root))freeBins.set(bin.root,{bins:[],next:0});
    freeBins.get(bin.root).bins.push(bin);
  }
  const zone=(await require('../lib/business-time').forWorkspace(db,ctx.workspaceId)).timeZone;
  const {rows:picks}=freeBins.size?await db.query(`SELECT m.location_id,m.sku_id,s.code,i.name,
    count(DISTINCT coalesce(nullif(m.reference,''),m.id))::int visits FROM movements m
    JOIN balances b ON b.workspace_id=m.workspace_id AND b.sku_id=m.sku_id AND b.location_id=m.location_id AND b.on_hand>0
    JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id AND s.is_active=1 JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    WHERE m.workspace_id=$1 AND m.location_id=ANY($2::text[]) AND m.operation='issue' AND m.reason_code='sale' AND m.quantity_delta<0
      AND m.occurred_at::timestamptz >= (($3::date-89)::timestamp AT TIME ZONE $4)
      AND m.occurred_at::timestamptz <= least(now(),(($3::date+1)::timestamp AT TIME ZONE $4))
    GROUP BY m.location_id,m.sku_id,s.code,i.name ORDER BY visits DESC,s.code,m.location_id,m.sku_id`,
    [ctx.workspaceId,bins.filter(b=>!b.empty&&freeBins.has(b.root)).map(b=>b.id),today,zone]):{rows:[]};
  const available=await require('../domain/postgres-kit-availability').stock(db,ctx.workspaceId,[...new Set(picks.map(p=>p.sku_id))]);
  const moves=[];
  for(const p of picks){
    const from=byId.get(p.location_id),group=freeBins.get(from.root),to=group.bins[group.next];
    const quantity=available.get(JSON.stringify([p.sku_id,p.location_id]))||0;
    if(!quantity||!to||Number(to.metres)>=Number(from.metres))continue;
    group.next++;
    if(filter&&![p.code,p.name,from.site,from.name,to.name].some(x=>x.toLowerCase()===filter.toLowerCase()))continue;
    moves.push({SKU:p.code,Product:p.name,Site:from.site,From:from.name,To:to.name,'Available units':quantity,'Order picks in 90 days':p.visits,
      'Metres closer to packing':Number((Number(from.metres)-Number(to.metres)).toFixed(2))});
  }
  return {rows:moves.slice((page-1)*100,page*100),more:moves.length>page*100,
    summary:'Enter walking distances for occupied and empty bins. The list assigns the nearest empty bin at the same site to the most frequently picked stock first. Check bin capacity and handling requirements before moving goods.'};
}
module.exports={saveDistance,definition:{id:122,key:'warehouse-slotting',label:'Plan warehouse bin moves',filterLabel:'SKU, product, site or bin',readPage:review}};

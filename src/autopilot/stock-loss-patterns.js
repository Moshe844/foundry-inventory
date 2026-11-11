'use strict';

const policy=require('../commercial/agent-plan');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');

const defaultStarts=[0,480,960];
const clock=minutes=>String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
const profileKey=id=>'stock_loss_shifts:'+id;

const sql=`WITH RECURSIVE sites AS (
  SELECT id,id AS site FROM locations WHERE workspace_id=$1 AND parent_location_id IS NULL
    AND is_active=1 AND custody_agreement_id IS NULL
  UNION ALL
  SELECT l.id,s.site FROM locations l JOIN sites s ON s.id=l.parent_location_id WHERE l.workspace_id=$1
), tenant AS (
  SELECT coalesce(w.time_zone,a.time_zone,'UTC') zone FROM workspaces w
  JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1
), loss AS (
  SELECT m.sku_id,s.site,m.quantity_delta,
    stockchief_movement_instant(m.occurred_at) AT TIME ZONE tenant.zone AS local_time
  FROM movements m JOIN sites s ON s.id=m.location_id CROSS JOIN tenant
  WHERE m.workspace_id=$1 AND m.operation='adjust' AND m.quantity_delta<0
    AND coalesce(m.reason_code,'') NOT IN ('damaged','scrap','write_off','expired')
    AND stockchief_movement_instant(m.occurred_at)>=($3::date-89)::timestamp AT TIME ZONE tenant.zone
    AND stockchief_movement_instant(m.occurred_at)<($3::date+1)::timestamp AT TIME ZONE tenant.zone
), checked AS (
  SELECT m.*,shift.start FROM loss m
  LEFT JOIN operational_preferences p ON p.workspace_id=$1 AND p.key='stock_loss_shifts:'||m.site
  CROSS JOIN LATERAL (
    SELECT value::int start FROM jsonb_array_elements_text(coalesce(p.value::jsonb->'starts','[0,480,960]'::jsonb)) starts(value)
    ORDER BY (value::int<=extract(hour FROM m.local_time)*60+extract(minute FROM m.local_time)) DESC,value::int DESC LIMIT 1
  ) shift
)
SELECT s.code AS "SKU",l.name AS "Warehouse",
  lpad((m.start/60)::text,2,'0')||':'||lpad((m.start%60)::text,2,'0') AS "Shift starts",
  count(*) AS "Adjustments",-sum(m.quantity_delta) AS "Units removed",
  s.id||':'||l.id||':'||m.start AS reference,'/inventory/'||s.item_id AS link
FROM checked m JOIN skus s ON s.workspace_id=$1 AND s.id=m.sku_id
JOIN locations l ON l.workspace_id=$1 AND l.id=m.site
WHERE ($2='' OR lower(s.code)=lower($2) OR lower(l.name)=lower($2))
GROUP BY s.id,s.code,l.id,l.name,m.start HAVING count(*)>1
ORDER BY count(*) DESC,s.id,l.id,m.start`;

async function review(db,ctx,{filter,page,today}){
  const {rows}=await db.query(sql+' LIMIT 101 OFFSET $4',[ctx.workspaceId,filter,today,(page-1)*100]);
  return {rows:rows.slice(0,100).map(({reference,...row})=>row),more:rows.length>100,
    summary:'Repeated negative stock corrections at the same warehouse and local shift over 90 business days. Review the underlying movements to determine the cause.'};
}

async function settings(db,workspaceId){
  const {rows}=await db.query(`SELECT l.id,l.name,p.value FROM locations l
    LEFT JOIN operational_preferences p ON p.workspace_id=l.workspace_id AND p.key='stock_loss_shifts:'||l.id
    WHERE l.workspace_id=$1 AND l.parent_location_id IS NULL AND l.is_active=1 AND l.custody_agreement_id IS NULL
    ORDER BY l.name,l.id`,[workspaceId]);
  return rows.map(row=>{
    const saved=JSON.parse(row.value||'{}');
    return {id:row.id,name:row.name,starts:(saved.starts||defaultStarts).map(clock).join(', '),revision:saved.revision||0};
  });
}

async function save(database,ctx,input){
  const text=String(input.starts||'').trim();
  const clocks=text?text.split(',').map(time=>time.trim()):defaultStarts.map(clock);
  const revision=Number(input.revision);
  if(clocks.length>8||clocks.some(time=>!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))||new Set(clocks).size!==clocks.length)
    throw new ValidationError('Enter one to eight distinct shift start times as HH:MM, separated by commas.');
  if(!Number.isSafeInteger(revision)||revision<0)throw new ValidationError('Open the current shift settings before saving.');
  const starts=clocks.map(time=>Number(time.slice(0,2))*60+Number(time.slice(3))).sort((a,b)=>a-b);
  return database.transaction(async db=>{
    const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,10,'automatic');
    const owner=await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND account_id=$3 AND role='owner'",
      [ctx.workspaceId,ctx.actorId,state.accountId]);
    if(!owner.rowCount)throw new AuthorizationError('Only the current inventory owner can set warehouse shifts.');
    const site=await db.query('SELECT 1 FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND parent_location_id IS NULL AND custody_agreement_id IS NULL',
      [ctx.workspaceId,input.locationId]);
    if(!site.rowCount)throw new ValidationError('Choose an active warehouse from this inventory.');
    const key=profileKey(input.locationId);
    const prior=(await db.query('SELECT value FROM operational_preferences WHERE workspace_id=$1 AND key=$2 FOR UPDATE',[ctx.workspaceId,key])).rows[0];
    if((JSON.parse(prior?.value||'{}').revision||0)!==revision)throw new ValidationError('The warehouse shifts changed. Open the current settings.');
    await db.query(`INSERT INTO operational_preferences(id,workspace_id,key,value,source,set_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,'configuration',$5,$6,$6) ON CONFLICT(workspace_id,key) DO UPDATE
      SET value=excluded.value,set_by_user_id=excluded.set_by_user_id,updated_at=excluded.updated_at`,
    [newId('pref'),ctx.workspaceId,key,JSON.stringify({starts,revision:revision+1}),ctx.actorId,nowIso()]);
    await require('../operations/postgres-security-audit').record(db,ctx,{action:'Warehouse loss shifts saved',reference:input.locationId,after:{starts:starts.map(clock)}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

module.exports={sql,settings,save,definition:{id:10,key:'repeat-loss',label:'Find repeated stock losses',filterLabel:'Exact SKU or warehouse',readPage:review}};

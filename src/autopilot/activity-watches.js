'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const exact=require('../domain/exact-quantity');
const costAlerts=require('./cost-alerts');

const activity=`WITH selected AS (
  SELECT m.id,m.operation,m.reference,m.quantity_delta,s.code,s.item_id,l.name AS location,u.name AS actor,w.adjustment_units,w.night_from,w.night_until,
    (m.occurred_at::timestamptz AT TIME ZONE coalesce(i.time_zone,a.time_zone,'UTC')) AS local_time
  FROM stockchief_runtime.agent_alert_settings w JOIN workspaces i ON i.id=w.workspace_id JOIN accounts a ON a.id=i.owner_account_id
  JOIN movements m ON m.workspace_id=w.workspace_id JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id
  JOIN locations l ON l.workspace_id=m.workspace_id AND l.id=m.location_id LEFT JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.actor_user_id
  WHERE w.workspace_id=$1 AND w.job_id=171 AND ($2='' OR lower(s.code)=lower($2) OR lower(l.name)=lower($2))
    AND m.occurred_at::timestamptz>=($3::date-6)::timestamp AT TIME ZONE coalesce(i.time_zone,a.time_zone,'UTC')
    AND m.occurred_at::timestamptz<($3::date+1)::timestamp AT TIME ZONE coalesce(i.time_zone,a.time_zone,'UTC')
), flags AS (
  SELECT *,operation='adjust' AND abs(quantity_delta)>=adjustment_units AS large,
    CASE WHEN night_from<night_until THEN extract(hour FROM local_time)>=night_from AND extract(hour FROM local_time)<night_until
      ELSE extract(hour FROM local_time)>=night_from OR extract(hour FROM local_time)<night_until END AS night FROM selected
) SELECT code AS "SKU",CASE WHEN large AND night THEN 'Large adjustment during watched hours' WHEN large THEN 'Large adjustment' ELSE 'Stock change during watched hours' END AS "Alert",
  operation AS "Movement",quantity_delta AS "Units changed",location AS "Location",actor AS "Recorded by",to_char(local_time,'YYYY-MM-DD HH24:MI') AS "Local time",
  id AS reference,'/inventory/'||item_id AS link FROM flags WHERE large OR night ORDER BY local_time DESC,id`;
const spec={169:{key:'channel-alerts',label:'Sales channel alerts',usesDate:false,sql:require('../connections/agent-channel-alerts').sql,summary:'Flags stopped or overdue checks and channel quantities last verified above costed physical stock after sales commitments. Transfer and rental holds can reduce available stock further.'},
  // Job 170 lives in cost-alerts.js; it needs migration 473.
  170:{key:costAlerts.key,label:costAlerts.label,sql:costAlerts.sql,summary:costAlerts.summary,readPage:costAlerts.review,ready:costAlerts.ready,filterLabel:'Exact SKU, category or channel'},
  171:{key:'unusual-stock-activity',label:'Unusual stock activity',sql:activity,summary:'Shows stock changes in the last seven business-calendar days against the unit threshold and local hours selected by the owner.'}};
function optional(value){return value==null||String(value).trim()===''?null:value;}
function hour(value){
  if(optional(value)===null)return null;
  if(!/^\d{1,2}$/.test(String(value))||Number(value)>23)throw new ValidationError('Choose a local hour from 0 to 23.');
  return Number(value);
}
async function settings(db,workspaceId,job){return (await db.query('SELECT * FROM stockchief_runtime.agent_alert_settings WHERE workspace_id=$1 AND job_id=$2',[workspaceId,job])).rows[0]||{revision:0};}
async function save(db,ctx,job,input){
  if(![170,171].includes(job))throw new ValidationError('Choose an alert with adjustable thresholds.');
  return db.transaction(async c=>{
    await policy.requireWorkspaceJob(c,ctx.workspaceId,job,'automatic');
    if(!(await c.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId])).rowCount)throw new AuthorizationError('Only the owner can change these alerts.');
    const pct=job===170&&optional(input.marginPct)!==null?exact.safeNumber(input.marginPct,{precision:2,label:'Minimum margin'}):null;
    if(pct>100)throw new ValidationError('Choose a gross margin from 0 to 100 percent.');
    if(job===170&&!await costAlerts.ready(c))throw new ValidationError('Cost and margin alerts are being upgraded. Try again shortly.');
    const rise=job===170&&optional(input.costRisePct)!==null?exact.safeNumber(input.costRisePct,{precision:2,positive:true,label:'Cost rise'}):null;
    if(rise>1000)throw new ValidationError('Choose a cost rise up to 1,000 percent.');
    const units=job===171&&optional(input.adjustmentUnits)!==null?exact.safeNumber(input.adjustmentUnits,{positive:true,label:'Adjustment units'}):null;
    const from=job===171?hour(input.nightFrom):null,until=job===171?hour(input.nightUntil):null;
    if((from===null)!==(until===null)||from!==null&&from===until)throw new ValidationError('Choose both ends of the watched hours, with a different start and end.');
    const revision=Number(input.revision);
    if(!Number.isSafeInteger(revision)||revision<0)throw new ValidationError('Refresh the page before changing the alert.');
    const prior=(await c.query('SELECT * FROM stockchief_runtime.agent_alert_settings WHERE workspace_id=$1 AND job_id=$2',[ctx.workspaceId,job])).rows[0]||null;
    const updated=await c.query(`INSERT INTO stockchief_runtime.agent_alert_settings AS w(workspace_id,job_id,margin_pct,adjustment_units,night_from,night_until,revision)
      VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(workspace_id,job_id) DO UPDATE SET margin_pct=excluded.margin_pct,
      adjustment_units=excluded.adjustment_units,night_from=excluded.night_from,night_until=excluded.night_until,revision=w.revision+1
      WHERE w.revision=$7 RETURNING revision`,[ctx.workspaceId,job,pct,units,from,until,revision]);
    if(!updated.rowCount||updated.rows[0].revision!==revision+1)throw new ValidationError('The settings changed. Reopen this alert before saving.');
    if(job===170)await c.query('UPDATE stockchief_runtime.agent_alert_settings SET cost_rise_pct=$3 WHERE workspace_id=$1 AND job_id=$2',[ctx.workspaceId,job,rise]);
    const after=job===170?{marginPct:pct,costRisePct:rise}:{adjustmentUnits:units,nightFrom:from,nightUntil:until};
    const before=!prior?{}:job===170?{marginPct:prior.margin_pct==null?null:Number(prior.margin_pct),costRisePct:prior.cost_rise_pct==null?null:Number(prior.cost_rise_pct)}
      :{adjustmentUnits:prior.adjustment_units==null?null:Number(prior.adjustment_units),nightFrom:prior.night_from,nightUntil:prior.night_until};
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Alert settings saved',reference:String(job),before,after});
    await require('./operational-notices').refresh(c,ctx.workspaceId);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
const definitions=Object.entries(spec).map(([key,d])=>({id:Number(key),key:d.key,label:d.label,filterLabel:d.filterLabel,readPage:d.readPage||(async(db,ctx,{filter,page,today})=>{
  const args=d.usesDate===false?[ctx.workspaceId,filter]:[ctx.workspaceId,filter,today];
  args.push((page-1)*100);
  const {rows}=await db.query(d.sql+' LIMIT 101 OFFSET $'+args.length,args);
  for(const r of rows)delete r.reference;
  return {rows:rows.slice(0,100),more:rows.length>100,summary:d.summary};
})}));
module.exports={spec,definitions,settings,save};

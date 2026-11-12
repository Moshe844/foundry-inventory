'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const exact=require('../domain/exact-quantity');
const costAlerts=require('./cost-alerts');
const unusualActivity=require('./unusual-activity');

const spec={
  // Job 170 lives in cost-alerts.js; it needs migration 473.
  170:{key:costAlerts.key,label:costAlerts.label,sql:costAlerts.sql,summary:costAlerts.summary,readPage:costAlerts.review,ready:costAlerts.ready,filterLabel:'Exact SKU, category or channel'},
  // Job 171 lives in unusual-activity.js; it needs migration 473.
  171:{key:unusualActivity.key,label:unusualActivity.label,sql:unusualActivity.sql,summary:unusualActivity.summary,readPage:unusualActivity.review,ready:unusualActivity.ready,
    filterLabel:'Exact SKU, person or location'}};
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
    if(job===171&&!await unusualActivity.ready(c))throw new ValidationError('Unusual activity alerts are being upgraded. Try again shortly.');
    const edits=job===171&&optional(input.editCount)!==null?Number(input.editCount):null;
    if(edits!==null&&(!Number.isSafeInteger(edits)||edits<1||edits>100000))throw new ValidationError('Choose a whole number of changes from 1 to 100,000.');
    const priceChange=job===171&&optional(input.priceChangePct)!==null?exact.safeNumber(input.priceChangePct,{precision:2,positive:true,label:'Price change'}):null;
    if(priceChange>1000)throw new ValidationError('Choose a price change up to 1,000 percent.');
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
    else await c.query('UPDATE stockchief_runtime.agent_alert_settings SET edit_count=$3,price_change_pct=$4 WHERE workspace_id=$1 AND job_id=$2',[ctx.workspaceId,job,edits,priceChange]);
    const number=value=>value==null?null:Number(value);
    const after=job===170?{marginPct:pct,costRisePct:rise}:{adjustmentUnits:units,nightFrom:from,nightUntil:until,editCount:edits,priceChangePct:priceChange};
    const before=!prior?{}:job===170?{marginPct:number(prior.margin_pct),costRisePct:number(prior.cost_rise_pct)}
      :{adjustmentUnits:number(prior.adjustment_units),nightFrom:prior.night_from,nightUntil:prior.night_until,editCount:prior.edit_count??null,priceChangePct:number(prior.price_change_pct)};
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

'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');

const cost=`WITH priced AS (
  SELECT s.code,s.item_id,c.id AS cost_id,c.amount_minor,c.currency,p.amount_minor AS selling,p.currency AS sell_currency,
    prior.amount_minor AS previous,prior.currency AS previous_currency,c.created_at::timestamptz AS cost_date,w.margin_pct,
    (c.created_at::timestamptz AT TIME ZONE coalesce(iw.time_zone,a.time_zone,'UTC'))::date AS day
  FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id AND i.is_active=1
  JOIN workspaces iw ON iw.id=s.workspace_id JOIN accounts a ON a.id=iw.owner_account_id
  JOIN LATERAL (SELECT id,amount_minor,currency,created_at FROM sku_purchase_costs WHERE workspace_id=$1 AND sku_id=s.id
    ORDER BY created_at DESC,id DESC LIMIT 1)c ON true
  LEFT JOIN LATERAL (SELECT amount_minor,currency FROM sku_purchase_costs WHERE workspace_id=$1 AND sku_id=s.id
    AND (created_at,id)<(c.created_at,c.id) ORDER BY created_at DESC,id DESC LIMIT 1)prior ON true
  LEFT JOIN LATERAL (SELECT amount_minor,currency FROM sku_prices WHERE workspace_id=$1 AND sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)p ON true
  LEFT JOIN stockchief_runtime.agent_alert_settings w ON w.workspace_id=s.workspace_id AND w.job_id=170
  WHERE s.workspace_id=$1 AND s.is_active=1 AND ($2='' OR lower(s.code)=lower($2) OR lower(i.name)=lower($2))
), issues AS (
  SELECT p.*,x.kind,x.reference,CASE WHEN selling>0 AND sell_currency=currency THEN round(100.0*(selling-amount_minor)/selling,2) END AS margin
  FROM priced p CROSS JOIN LATERAL (VALUES
    ('Purchase cost increased',cost_id,previous_currency=currency AND amount_minor>previous AND day BETWEEN $3::date-29 AND $3::date),
    ('Below your gross margin',code,margin_pct IS NOT NULL AND sell_currency=currency AND selling IS NOT NULL AND
      (selling>0 AND 100.0*(selling-amount_minor)<selling*margin_pct OR selling=0 AND amount_minor>0))
  ) x(kind,reference,applies) WHERE x.applies
) SELECT code AS "SKU",kind AS "Alert",currency AS "Currency",amount_minor AS "Cost",previous AS "Previous cost",previous_currency AS "Previous currency",
  selling AS "Price",sell_currency AS "Selling currency",margin AS "Gross margin %",margin_pct AS "Owner minimum %",reference,'/inventory/'||item_id AS link
  FROM issues ORDER BY code,kind`;
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
  170:{key:'cost-alerts',label:'Cost and gross margin alerts',sql:cost,summary:'The latest recorded purchase cost is compared with the previous cost in the same currency. Cost increases are shown for 30 days. Margins compare the current catalog price and cost in the same currency.'},
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
    const units=job===171&&optional(input.adjustmentUnits)!==null?exact.safeNumber(input.adjustmentUnits,{positive:true,label:'Adjustment units'}):null;
    const from=job===171?hour(input.nightFrom):null,until=job===171?hour(input.nightUntil):null;
    if((from===null)!==(until===null)||from!==null&&from===until)throw new ValidationError('Choose both ends of the watched hours, with a different start and end.');
    const revision=Number(input.revision);
    if(!Number.isSafeInteger(revision)||revision<0)throw new ValidationError('Refresh the page before changing the alert.');
    const updated=await c.query(`INSERT INTO stockchief_runtime.agent_alert_settings AS w(workspace_id,job_id,margin_pct,adjustment_units,night_from,night_until,revision)
      VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(workspace_id,job_id) DO UPDATE SET margin_pct=excluded.margin_pct,
      adjustment_units=excluded.adjustment_units,night_from=excluded.night_from,night_until=excluded.night_until,revision=w.revision+1
      WHERE w.revision=$7 RETURNING revision`,[ctx.workspaceId,job,pct,units,from,until,revision]);
    if(!updated.rowCount||updated.rows[0].revision!==revision+1)throw new ValidationError('The settings changed. Reopen this alert before saving.');
    await require('./operational-notices').refresh(c,ctx.workspaceId);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
const definitions=Object.entries(spec).map(([key,d])=>({id:Number(key),key:d.key,label:d.label,readPage:async(db,ctx,{filter,page,today})=>{
  const args=d.usesDate===false?[ctx.workspaceId,filter]:[ctx.workspaceId,filter,today];
  args.push((page-1)*100);
  const {rows}=await db.query(d.sql+' LIMIT 101 OFFSET $'+args.length,args);
  for(const r of rows){delete r.reference;if(d===spec[170]){
    for(const [amount,currency] of [['Cost','Currency'],['Previous cost','Previous currency'],['Price','Selling currency']])if(r[amount]!=null)r[amount]=money.format(r[amount],r[currency]);
    delete r['Previous currency'];delete r['Selling currency'];
  }}
  return {rows:rows.slice(0,100),more:rows.length>100,summary:d.summary};
}}));
module.exports={spec,definitions,settings,save};

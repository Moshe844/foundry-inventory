'use strict';

// Job 125: one view of stock across a Custom account's inventories (one per
// company or business). The worker keeps each inventory's own part current
// every 15 minutes: stock by product, stock value in that inventory's own
// currency, low stock and stockouts, open purchase orders and sales. The page
// then combines only the inventories the person may open, applying their
// access in each one, and matches products by code or barcode. Currencies
// are never added together, and products whose codes, barcodes or units do
// not agree are shown side by side for a person to check, not added up.
//
// It only reads. Watch only, the first 14 days and inventory-wide "Ask me
// first" let it keep looking; a pause stops the scheduled update, and this
// job's own "Ask me first" setting waits for the owner to approve each update.
const policy=require('../commercial/agent-plan');
const permissions=require('../actions/permissions');
const audit=require('../operations/postgres-security-audit');
const queue=require('../operations/postgres-job-queue');
const money=require('../domain/currency');
const stockTotals=require('../domain/stock-totals');
const time=require('../lib/business-time');
const {addDays}=require('../accounting/customer-money');
const {hash}=require('../pricing/postgres-promotions');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');

const JOB=125,KIND='agent.inventory-rollup.v1',EVERY_MINUTES=15,SALES_DAYS=30,PAGE=50,href='/inventory/combined';
const ROLLUPS='stockchief_runtime.agent_inventory_rollups',ITEMS='stockchief_runtime.agent_inventory_rollup_items';
const EXPORT_LIMITS={xlsx:20000,pdf:5000};
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
const problems={units:'Units differ. Not added up.',barcodes:'Same code, different barcodes. Not added up.',
  shared:'Two products in one inventory share this code or barcode. Not added up.',
  split:'This code is used for different barcodes. Not added up.'};
const shortProblems={units:'Units differ',barcodes:'Barcodes differ',shared:'Code used twice',split:'Code reused'};

async function ownerUser(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)
    ORDER BY u.created_at,u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}

// What the plan and the owner's settings allow for one inventory right now.
async function authority(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  const plan=policy.usesAgentTerms(account)?account.plan:null;
  if(!policy.permits(plan,JOB,'automatic'))return {permitted:false,plan,account};
  const config=(await db.query('SELECT paused,suspended FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];
  const mode=(await db.query('SELECT mode FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=$2',[workspaceId,JOB])).rows[0]?.mode;
  const hold=Number(config?.suspended)?'Automatic work is stopped in this inventory until the owner reviews it.'
    :Number(config?.paused)?'Automatic work is paused in this inventory.'
    :mode==='ask'?'This job is set to Ask me first. The owner approves each update.':null;
  return {permitted:true,plan,account,hold};
}

// A decimal amount, rounded half up to the currency's smallest unit.
function minorOf(text,currency){
  const match=/^(-?)(\d+)(?:\.(\d+))?$/.exec(String(text??'0').trim());
  if(!match)throw new ValidationError('A purchase amount could not be read exactly.');
  const digits=money.exponent(currency),fraction=(match[3]||'').padEnd(digits+1,'0');
  let minor=BigInt(match[2])*10n**BigInt(digits)+BigInt(fraction.slice(0,digits)||'0');
  if(Number(fraction[digits])>=5)minor+=1n;
  return (match[1]&&minor>0n?'-':'')+minor.toString();
}

const BARCODE=`regexp_replace(coalesce(s.barcode,''),'\\s','','g')`;
function itemsSql(){
  return `WITH low AS MATERIALIZED (${require('./low-stock-source').source({skuIdsOnly:true})}),
 stock AS MATERIALIZED (SELECT sku_id,sum(on_hand) AS on_hand FROM balances WHERE workspace_id=$1 GROUP BY sku_id),
 policies AS MATERIALIZED (SELECT DISTINCT sku_id FROM reorder_policies WHERE workspace_id=$1 AND reorder_point IS NOT NULL),
 incoming AS MATERIALIZED (SELECT l.sku_id,sum(greatest(l.quantity_units-l.quantity_received_units,0)) AS units
  FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
  WHERE l.workspace_id=$1 AND o.status IN ('ORDERED','PARTIALLY_RECEIVED') GROUP BY l.sku_id),
 sold AS MATERIALIZED (SELECT d.sku_id,sum(d.issued) AS units FROM stockchief_runtime.replenishment_demand_events d
  JOIN movements m ON m.workspace_id=d.workspace_id AND m.id=d.movement_id
  WHERE d.workspace_id=$1 AND d.occurred_at>=$2::timestamptz AND m.operation='issue' AND m.reason_code IN ('sale','sold') GROUP BY d.sku_id),
 src AS MATERIALIZED (
  SELECT s.id AS sku_id,s.item_id,s.code,upper(btrim(s.code)) AS code_key,nullif(btrim(s.barcode),'') AS barcode,
   CASE WHEN ${BARCODE}~'^[0-9]{8,14}$' THEN lpad(${BARCODE},14,'0') ELSE nullif(upper(${BARCODE}),'') END AS barcode_key,
   concat_ws(' — ',i.name,nullif(s.variant_label,'')) AS product,coalesce(nullif(btrim(i.unit_label),''),'unit') AS unit,
   lower(coalesce(nullif(btrim(i.unit_label),''),'unit'))||CASE WHEN ${stockTotals.MEASURED} THEN ' measured' ELSE '' END AS unit_key,
   coalesce(st.on_hand,0)::numeric AS on_hand,
   (lw.sku_id IS NOT NULL AND coalesce(st.on_hand,0)>0) AS is_low,
   (coalesce(st.on_hand,0)<=0 AND (p.sku_id IS NOT NULL OR coalesce(sd.units,0)>0)) AS is_out,
   coalesce(inc.units,0)::numeric AS incoming,coalesce(sd.units,0)::numeric AS sold
  FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  LEFT JOIN stock st ON st.sku_id=s.id LEFT JOIN low lw ON lw.sku_id=s.id LEFT JOIN policies p ON p.sku_id=s.id
  LEFT JOIN incoming inc ON inc.sku_id=s.id LEFT JOIN sold sd ON sd.sku_id=s.id
  WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1
   AND (coalesce(st.on_hand,0)<>0 OR p.sku_id IS NOT NULL OR coalesce(inc.units,0)>0 OR coalesce(sd.units,0)>0)),
 written AS (INSERT INTO ${ITEMS} AS r(workspace_id,sku_id,item_id,code,code_key,barcode,barcode_key,product,unit,unit_key,on_hand,is_low,is_out,incoming,sold)
  SELECT $1,sku_id,item_id,code,code_key,barcode,barcode_key,product,unit,unit_key,on_hand,is_low,is_out,incoming,sold FROM src
  ON CONFLICT(workspace_id,sku_id) DO UPDATE SET item_id=excluded.item_id,code=excluded.code,code_key=excluded.code_key,barcode=excluded.barcode,
   barcode_key=excluded.barcode_key,product=excluded.product,unit=excluded.unit,unit_key=excluded.unit_key,on_hand=excluded.on_hand,
   is_low=excluded.is_low,is_out=excluded.is_out,incoming=excluded.incoming,sold=excluded.sold
  WHERE (r.item_id,r.code,r.code_key,r.barcode,r.barcode_key,r.product,r.unit,r.unit_key,r.on_hand,r.is_low,r.is_out,r.incoming,r.sold)
   IS DISTINCT FROM (excluded.item_id,excluded.code,excluded.code_key,excluded.barcode,excluded.barcode_key,excluded.product,excluded.unit,
   excluded.unit_key,excluded.on_hand,excluded.is_low,excluded.is_out,excluded.incoming,excluded.sold)
  RETURNING 1),
 removed AS (DELETE FROM ${ITEMS} r WHERE r.workspace_id=$1 AND NOT EXISTS(SELECT 1 FROM src WHERE src.sku_id=r.sku_id) RETURNING 1)
 SELECT (SELECT count(*) FROM written)::int AS written,(SELECT count(*) FROM removed)::int AS removed`;
}

// The inventory's own figures, in its own currency.
async function summarize(c,workspaceId,clock,from){
  const counts=(await c.query(`SELECT count(*)::int AS products,count(*) FILTER(WHERE on_hand>0)::int AS in_stock,
    count(*) FILTER(WHERE is_low)::int AS low,count(*) FILTER(WHERE is_out)::int AS out FROM ${ITEMS} WHERE workspace_id=$1`,[workspaceId])).rows[0];
  const stock=await stockTotals.forBusiness(c,workspaceId);
  const books=(await c.query('SELECT base_currency,enabled FROM accounting_settings WHERE workspace_id=$1',[workspaceId])).rows[0];
  const recorded=Number(books?.enabled)===1;
  let value=null,sales=null;
  if(recorded){
    const total=(await c.query('SELECT coalesce(sum(total_cost_minor),0)::text AS minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[workspaceId])).rows[0];
    const coverage=await require('../accounting/postgres-quantity-coverage').read(c,workspaceId);
    value={currency:books.base_currency,minor:total.minor,missingCost:Number(coverage.missingCostUnits)>0?stockTotals.missingCostText(coverage):null};
    const posted=await require('../accounting/posted-sales').forPeriod(c,workspaceId,{from,to:clock.calendarDate});
    sales={currency:posted.currency,minor:String(posted.minor),from:posted.from,to:posted.to};
  }
  const orders=(await c.query(`SELECT o.currency,count(DISTINCT o.id)::int AS orders,
    coalesce(sum(greatest(l.quantity_units-l.quantity_received_units,0)*l.unit_cost::numeric),0)::text AS amount,
    count(*) FILTER(WHERE l.unit_cost IS NULL AND l.quantity_units>l.quantity_received_units)::int AS uncosted
    FROM purchase_orders o JOIN purchase_order_lines l ON l.workspace_id=o.workspace_id AND l.purchase_order_id=o.id
    WHERE o.workspace_id=$1 AND o.status IN ('ORDERED','PARTIALLY_RECEIVED') GROUP BY o.currency ORDER BY o.currency`,[workspaceId])).rows;
  return {products:counts.products,inStock:counts.in_stock,low:counts.low,out:counts.out,units:stock.units,measured:stock.measured,
    value,sales,books:recorded,salesDays:SALES_DAYS,today:clock.calendarDate,
    incoming:{orders:orders.reduce((n,r)=>n+r.orders,0),byCurrency:orders.map(r=>({currency:r.currency,orders:r.orders,minor:minorOf(r.amount,r.currency),uncosted:r.uncosted}))}};
}

// Worker: refresh one inventory's part. Replays of the same request do
// nothing; a refresh with unchanged figures writes nothing but its time.
async function process(c,workspaceId,payload={}){
  const requestKey=String(payload.requestKey||'');
  if(!/^[A-Za-z0-9:._-]{1,120}$/.test(requestKey))throw Object.assign(new ValidationError('A combined inventory update needs its request key.'),{retryable:false});
  await c.query(`INSERT INTO ${ROLLUPS}(workspace_id) SELECT id FROM workspaces WHERE id=$1 ON CONFLICT(workspace_id) DO NOTHING`,[workspaceId]);
  const prior=(await c.query(`SELECT * FROM ${ROLLUPS} WHERE workspace_id=$1 FOR UPDATE`,[workspaceId])).rows[0];
  if(!prior)return {skipped:'inventory'};
  if(prior.request_key===requestKey)return {replayed:true,revision:prior.revision};
  const auth=await authority(c,workspaceId);
  if(!auth.permitted)return {skipped:'plan'};
  const owner=await ownerUser(c,workspaceId);
  if(!owner)return {skipped:'owner'};
  const ctx={workspaceId,actorId:owner,accountId:auth.account.accountId};
  const approved=Boolean(payload.approvedBy);
  if(approved&&payload.approvedBy!==owner)return {skipped:'approver'};
  if(auth.hold&&!approved){
    if(prior.held_reason!==auth.hold)await audit.record(c,ctx,{action:'Held the combined inventory update',reference:workspaceId,
      before:{reason:prior.held_reason||null},after:{reason:auth.hold,job:JOB}});
    await c.query(`UPDATE ${ROLLUPS} SET held_reason=$2,held_at=now() WHERE workspace_id=$1`,[workspaceId,auth.hold]);
    return {held:auth.hold};
  }
  const clock=await time.forWorkspace(c,workspaceId),from=addDays(clock.calendarDate,1-SALES_DAYS);
  const rows=(await c.query(itemsSql(),[workspaceId,time.dayBoundary(from,clock.timeZone)])).rows[0];
  const summary=await summarize(c,workspaceId,clock,from),fingerprint=hash(summary);
  const changed=rows.written+rows.removed>0||fingerprint!==prior.fingerprint||!prior.refreshed_at;
  const saved=(await c.query(`UPDATE ${ROLLUPS} SET refreshed_at=now(),request_key=$2,fingerprint=$3,summary=$4::jsonb,held_reason=NULL,held_at=NULL,
    revision=revision+CASE WHEN $5 THEN 1 ELSE 0 END,approved_by=CASE WHEN $6 THEN $7 ELSE approved_by END,approved_at=CASE WHEN $6 THEN now() ELSE approved_at END
    WHERE workspace_id=$1 RETURNING revision,refreshed_at`,[workspaceId,requestKey,fingerprint,JSON.stringify(summary),changed,approved,owner])).rows[0];
  if(changed||approved)await audit.record(c,ctx,{action:approved?'Updated combined inventory figures after owner approval':'Updated combined inventory figures',
    reference:workspaceId,before:{revision:prior.revision,refreshedAt:prior.refreshed_at||null},
    after:{job:JOB,revision:saved.revision,automatic:!approved,products:summary.products,low:summary.low,out:summary.out,rowsChanged:rows.written+rows.removed}});
  return {refreshed:true,changed,revision:saved.revision};
}

// Runtime sweep: queue the inventories whose figures are due. Only accounts
// with more than one inventory on Custom are considered.
async function schedule(client,{now=Date.now()}={}){
  const bucket=Math.floor(now/(EVERY_MINUTES*60000));
  const due=(await client.query(`SELECT w.id FROM workspaces w
    JOIN account_subscriptions s ON s.account_id=w.owner_account_id AND s.plan_id='enterprise'
    LEFT JOIN ${ROLLUPS} r ON r.workspace_id=w.id
    WHERE w.deletion_requested_at IS NULL
      AND EXISTS(SELECT 1 FROM workspaces o WHERE o.owner_account_id=w.owner_account_id AND o.id<>w.id AND o.deletion_requested_at IS NULL)
      AND greatest(coalesce(r.refreshed_at,'-infinity'),coalesce(r.held_at,'-infinity'))<=to_timestamp($1::double precision/1000)-make_interval(mins=>$2)
    ORDER BY greatest(coalesce(r.refreshed_at,'-infinity'),coalesce(r.held_at,'-infinity')),w.id LIMIT 50`,[now,EVERY_MINUTES-1])).rows;
  let queued=0;
  for(const row of due){
    const saved=await queue.enqueue(scoped(client),{workspaceId:row.id,kind:KIND,idempotencyKey:'inventory-rollup:'+bucket,
      payload:{requestKey:'scheduled-'+bucket},priority:70,maxAttempts:3});
    if(saved.created)queued++;
  }
  return {queued};
}

// Who is looking, and what they may see in each of the account's inventories.
async function access(db,ctx){
  const me=(await db.query(`SELECT u.role,u.permissions,u.account_id,w.owner_account_id FROM users u JOIN workspaces w ON w.id=u.workspace_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!me)throw new AuthorizationError('Your inventory membership could not be verified.');
  permissions.assertCan(me,permissions.VIEW,'see stock');
  await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'automatic');
  const rows=(await db.query(`SELECT w.id,w.name,p.legal_name AS company,u.role,u.permissions,u.warehouse_location_ids,
      u.role='owner' AND u.account_id=w.owner_account_id AS owner
    FROM workspaces w JOIN users u ON u.workspace_id=w.id AND u.account_id=$2
    LEFT JOIN workspace_company_profiles p ON p.workspace_id=w.id
    WHERE w.owner_account_id=$1 AND w.deletion_requested_at IS NULL ORDER BY lower(w.name),w.id`,[me.owner_account_id,me.account_id])).rows;
  const inventories=[],limited=[];
  for(const r of rows){
    if(!permissions.can(r,permissions.VIEW))continue;
    if(r.role!=='owner'&&r.warehouse_location_ids!=null){limited.push({id:r.id,name:r.name});continue;}
    inventories.push({id:r.id,name:r.name,company:r.company&&r.company!==r.name?r.company:null,current:r.id===ctx.workspaceId,owner:r.owner,
      value:permissions.can(r,permissions.VIEW_ACCOUNTING),buying:permissions.can(r,permissions.VIEW_PURCHASING),
      sales:permissions.can(r,permissions.VIEW_SALES),money:permissions.can(r,permissions.VIEW_ACCOUNTING)});
  }
  return {inventories,limited,owner:me.role==='owner'&&rows.some(r=>r.id===ctx.workspaceId&&r.owner)};
}

const combinedSql=`WITH v AS MATERIALIZED (
  SELECT r.*,w.name AS inventory FROM ${ITEMS} r JOIN workspaces w ON w.id=r.workspace_id WHERE r.workspace_id=ANY($1::text[])),
 anchors AS MATERIALIZED (SELECT barcode_key,min(code_key) AS anchor FROM v WHERE barcode_key IS NOT NULL GROUP BY barcode_key),
 keyed AS MATERIALIZED (SELECT v.*,coalesce(a.anchor,v.code_key) AS match_key FROM v LEFT JOIN anchors a ON a.barcode_key=v.barcode_key),
 spread AS MATERIALIZED (SELECT code_key,count(DISTINCT match_key) AS groups FROM keyed GROUP BY code_key),
 grouped AS MATERIALIZED (SELECT k.match_key,min(k.product) AS product,array_agg(DISTINCT k.code ORDER BY k.code) AS codes,
   coalesce(array_agg(DISTINCT k.barcode ORDER BY k.barcode) FILTER(WHERE k.barcode IS NOT NULL),'{}') AS barcodes,
   count(DISTINCT k.barcode_key) AS barcode_count,count(DISTINCT k.unit_key) AS unit_count,
   count(*)>count(DISTINCT k.workspace_id) AS shared,bool_or(s.groups>1) AS split,count(DISTINCT k.code_key)>1 AS by_barcode,
   min(k.unit) AS unit,sum(k.on_hand) AS on_hand,
   sum(k.incoming) FILTER(WHERE k.workspace_id=ANY($2::text[])) AS incoming,sum(k.sold) FILTER(WHERE k.workspace_id=ANY($3::text[])) AS sold,
   count(*) FILTER(WHERE k.is_low)::int AS low_in,count(*) FILTER(WHERE k.is_out)::int AS out_in,
   bool_and(k.on_hand<=0) AS none_anywhere,count(DISTINCT k.workspace_id)::int AS inventories,
   jsonb_agg(jsonb_build_object('workspaceId',k.workspace_id,'itemId',k.item_id,'code',k.code,'barcode',k.barcode,'unit',k.unit,'onHand',k.on_hand,
     'low',k.is_low,'out',k.is_out,'incoming',CASE WHEN k.workspace_id=ANY($2::text[]) THEN k.incoming END,
     'sold',CASE WHEN k.workspace_id=ANY($3::text[]) THEN k.sold END) ORDER BY lower(k.inventory),k.workspace_id,k.code) AS parts
  FROM keyed k JOIN spread s ON s.code_key=k.code_key GROUP BY k.match_key),
 judged AS (SELECT g.*,CASE WHEN unit_count>1 THEN 'units' WHEN barcode_count>1 THEN 'barcodes' WHEN shared THEN 'shared' WHEN split THEN 'split' END AS problem FROM grouped g)`;
const FILTERS=['all','low','check'];
function where(filter){
  return `($4::text IS NULL OR lower(j.product) LIKE $4 ESCAPE '\\' OR EXISTS(SELECT 1 FROM unnest(j.codes||j.barcodes) c WHERE lower(c) LIKE $4 ESCAPE '\\'))
   AND ($5::text IS NULL OR j.match_key=$5)`+(filter==='low'?' AND (j.low_in>0 OR j.out_in>0)':filter==='check'?' AND j.problem IS NOT NULL':'');
}
function pattern(q){const term=String(q||'').trim().toLowerCase().slice(0,100);return term?'%'+term.replace(/[\\%_]/g,m=>'\\'+m)+'%':null;}

function present(row,names){
  const parts=row.parts.map(p=>({...p,inventory:names.get(p.workspaceId),onHand:Number(p.onHand),incoming:p.incoming==null?null:Number(p.incoming),sold:p.sold==null?null:Number(p.sold)}));
  return {key:row.match_key,product:row.product,codes:row.codes,barcodes:row.barcodes,unit:row.unit,problem:row.problem,
    problemText:row.problem?problems[row.problem]:null,problemShort:row.problem?shortProblems[row.problem]:null,matchedByBarcode:!row.problem&&row.by_barcode,
    total:row.problem?null:Number(row.on_hand),incoming:row.problem||row.incoming==null?null:Number(row.incoming),sold:row.problem||row.sold==null?null:Number(row.sold),
    lowIn:row.low_in,outIn:row.out_in,outEverywhere:row.out_in>0&&row.none_anywhere,inventories:row.inventories,parts};
}

function groupByCurrency(entries){
  const totals=new Map();
  for(const e of entries){const t=totals.get(e.currency)||{currency:e.currency,minor:'0',inventories:[]};
    t.minor=String(money.sum([t.minor,e.minor].map(Number),'Combined amount'));t.inventories.push(e.inventory);totals.set(e.currency,t);}
  return [...totals.values()].sort((a,b)=>a.currency.localeCompare(b.currency));
}

// Everything the page shows, for this person only.
async function model(db,ctx,input={}){
  const seen=await access(db,ctx),ids=seen.inventories.map(i=>i.id);
  const filter=FILTERS.includes(input.filter)?input.filter:'all',q=String(input.q||'').trim().slice(0,100);
  const number=Math.max(1,Math.min(10000,Number.parseInt(input.page,10)||1));
  const buying=seen.inventories.filter(i=>i.buying).map(i=>i.id),selling=seen.inventories.filter(i=>i.sales).map(i=>i.id);
  const names=new Map(seen.inventories.map(i=>[i.id,i.name]));
  const runs=new Map((await db.query(`SELECT workspace_id,refreshed_at,summary,held_reason,held_at,approved_at FROM ${ROLLUPS} WHERE workspace_id=ANY($1::text[])`,[ids])).rows.map(r=>[r.workspace_id,r]));
  const pending=new Set((await db.query(`SELECT DISTINCT workspace_id FROM stockchief_runtime.jobs WHERE workspace_id=ANY($1::text[]) AND kind=$2 AND status IN ('PENDING','RUNNING','RETRY') AND payload ? 'approvedBy'`,[ids,KIND])).rows.map(r=>r.workspace_id));
  const inventories=seen.inventories.map(i=>{
    const run=runs.get(i.id),s=run?.refreshed_at?run.summary:null;
    return {...i,refreshedAt:run?.refreshed_at?.toISOString?.()||null,heldReason:run?.held_reason||null,
      updateRequested:pending.has(i.id),mayApprove:Boolean(run?.held_reason)&&i.owner&&seen.owner,
      figures:s&&{products:s.products,inStock:s.inStock,units:s.units,measured:s.measured||[],low:s.low,out:s.out,
        value:i.value?s.value:undefined,books:s.books,
        incoming:i.buying?s.incoming:undefined,sales:i.money?s.sales:undefined,salesDays:s.salesDays}};
  });
  const totals={
    value:groupByCurrency(inventories.filter(i=>i.figures?.value).map(i=>({currency:i.figures.value.currency,minor:i.figures.value.minor,inventory:i.name}))),
    incoming:groupByCurrency(inventories.flatMap(i=>(i.figures?.incoming?.byCurrency||[]).map(r=>({currency:r.currency,minor:r.minor,inventory:i.name})))),
    sales:groupByCurrency(inventories.filter(i=>i.figures?.sales).map(i=>({currency:i.figures.sales.currency,minor:i.figures.sales.minor,inventory:i.name}))),
    missingCost:inventories.filter(i=>i.figures?.value?.missingCost).map(i=>({inventory:i.name,text:i.figures.value.missingCost})),
    uncosted:inventories.filter(i=>(i.figures?.incoming?.byCurrency||[]).some(r=>r.uncosted>0)).map(i=>i.name)};
  const args=[ids,buying,selling,pattern(q),input.key?String(input.key).slice(0,200):null];
  const counts=(await db.query(`${combinedSql} SELECT count(*)::int AS products,count(*) FILTER(WHERE low_in>0)::int AS low,
    count(*) FILTER(WHERE out_in>0)::int AS out,count(*) FILTER(WHERE out_in>0 AND none_anywhere)::int AS out_everywhere,
    count(*) FILTER(WHERE problem IS NOT NULL)::int AS to_check,count(*) FILTER(WHERE inventories>1 AND problem IS NULL)::int AS matched FROM judged`,[ids,buying,selling])).rows[0];
  const whole=Number.isSafeInteger(input.limit)&&input.limit>0,limit=whole?input.limit:PAGE,offset=whole?0:(number-1)*PAGE;
  const rows=(await db.query(`${combinedSql} SELECT j.*,count(*) OVER() AS total_rows FROM judged j WHERE ${where(filter)}
    ORDER BY lower(j.product),j.match_key LIMIT $6 OFFSET $7`,[...args,limit+1,offset])).rows;
  const more=rows.length>limit,shown=rows.slice(0,limit);
  return {inventories,limited:seen.limited,owner:seen.owner,totals,counts,filter,q,number,more,pages:Math.max(1,Math.ceil(Number(shown[0]?.total_rows||0)/PAGE)),
    found:Number(shown[0]?.total_rows||0),rows:shown.map(r=>present(r,names)),everyMinutes:EVERY_MINUTES,salesDays:SALES_DAYS,
    canBuy:buying.length>0,canSell:selling.length>0,canValue:inventories.some(i=>i.value),canMoney:inventories.some(i=>i.money)};
}

async function product(db,ctx,key){
  if(!key||String(key).length>200)throw new NotFoundError('That product is not in your combined view.');
  const view=await model(db,ctx,{key,limit:1});
  if(!view.rows.length)throw new NotFoundError('That product is not in your combined view.');
  return {...view,product:view.rows[0]};
}

// The owner approves one update for an inventory whose updates wait.
async function requestUpdate(db,ctx,inventoryId){
  const seen=await access(db,ctx),inventory=seen.inventories.find(i=>i.id===inventoryId);
  if(!inventory)throw new NotFoundError('That inventory is not in your combined view.');
  if(!inventory.owner||!seen.owner)throw new AuthorizationError('Only the business owner can approve an update.');
  const actor=(await db.query('SELECT id FROM users WHERE workspace_id=$1 AND account_id=$2',[inventoryId,ctx.accountId])).rows[0];
  const auth=await authority(db,inventoryId);
  if(!auth.permitted)policy.requireJob(auth.plan,JOB,'automatic');
  if(!auth.hold)return {queued:false,current:true};
  // One approval per waiting update: a second tap approves the same update.
  const run=(await db.query(`SELECT revision,held_at FROM ${ROLLUPS} WHERE workspace_id=$1`,[inventoryId])).rows[0];
  const slot=(run?.revision||0)+'-'+(run?.held_at?run.held_at.getTime():'new');
  const job=await queue.enqueue(db,{workspaceId:inventoryId,kind:KIND,idempotencyKey:'inventory-rollup:approved:'+slot,
    payload:{requestKey:'approved-'+slot,approvedBy:actor.id},priority:60,maxAttempts:3});
  if(job.created)await audit.record(db,{...ctx,workspaceId:inventoryId,actorId:actor.id},{action:'Approved a combined inventory update',reference:inventoryId,after:{job:JOB,reason:auth.hold}});
  return {queued:job.created,name:inventory.name};
}

// Excel and PDF use the existing report exports, with one section each for
// inventories, currency totals and products.
async function exportFile(db,ctx,format,input={}){
  if(!Object.hasOwn(EXPORT_LIMITS,format))throw new ValidationError('That export format is unavailable.');
  const view=await model(db,ctx,{...input,limit:EXPORT_LIMITS[format]});
  if(view.more)throw new ValidationError(`This export has more than ${EXPORT_LIMITS[format].toLocaleString('en-US')} products. Narrow it with a search or filter first.`);
  const amount=(minor,currency)=>money.format(Number(minor),currency);
  const qty=n=>n==null?'':String(Number(n));
  const columns=view.inventories.map((i,n)=>({key:'inventory_'+n,id:i.id,label:i.name+(view.inventories.filter(x=>x.name===i.name).length>1?' ('+(n+1)+')':'')}));
  const inventorySheet={name:'Inventories',title:'Inventories',sourceLabel:'One line per inventory you can open.',
    columns:['inventory','company','updated','in_stock','units','low','out','value','incoming','sales'],
    columnLabels:{inventory:'Inventory',company:'Company',updated:'Updated',in_stock:'Products in stock',units:'Units on hand',low:'Low',out:'Out of stock',
      value:'Stock value',incoming:'On open purchase orders',sales:`Sales, last ${SALES_DAYS} days`},
    columnTypes:{in_stock:'number',units:'number',low:'number',out:'number'},
    rows:view.inventories.map(i=>{const f=i.figures;return {inventory:i.name,company:i.company||'',
      updated:i.refreshedAt?i.refreshedAt.slice(0,16).replace('T',' ')+' UTC':'Not updated yet',
      in_stock:f?f.inStock:null,units:f?f.units:null,low:f?f.low:null,out:f?f.out:null,
      value:!f||f.value===undefined?'':f.value?amount(f.value.minor,f.value.currency)+(f.value.missingCost?' (missing costs)':''):'Books not set up',
      incoming:!f||f.incoming===undefined?'':f.incoming.byCurrency.map(r=>amount(r.minor,r.currency)).join('; ')||'None',
      sales:!f||f.sales===undefined?'':f.sales?amount(f.sales.minor,f.sales.currency):'Books not set up'};})};
  const currencies=[...new Set([...view.totals.value,...view.totals.incoming,...view.totals.sales].map(t=>t.currency))].sort();
  const find=(list,c)=>list.find(t=>t.currency===c);
  const totalSheet={name:'Totals by currency',title:'Totals by currency',sourceLabel:'Each currency on its own line. Currencies are never added together.',
    columns:['currency','value','incoming','sales'],columnLabels:{currency:'Currency',value:'Stock value',incoming:'On open purchase orders',sales:`Sales, last ${SALES_DAYS} days`},
    columnTypes:{value:'money_minor',incoming:'money_minor',sales:'money_minor'},
    rows:currencies.map(c=>({currency:c,value:find(view.totals.value,c)?.minor??null,incoming:find(view.totals.incoming,c)?.minor??null,sales:find(view.totals.sales,c)?.minor??null})),
    displayRows:currencies.map(c=>({currency:c,...Object.fromEntries(['value','incoming','sales'].map(k=>{const t=find(view.totals[k],c);return [k,t?amount(t.minor,c):''];}))}))};
  const productSheet={name:'Products',title:'Products',sourceLabel:'Matched by code or barcode across inventories. Products that do not agree are not added up.',
    columns:['product','codes','unit',...columns.map(c=>c.key),'total','incoming','sold','note'],
    columnLabels:{product:'Product',codes:'Code',unit:'Unit',...Object.fromEntries(columns.map(c=>[c.key,c.label])),total:'Total on hand',incoming:'On order',sold:`Sold, last ${SALES_DAYS} days`,note:'Note'},
    columnTypes:{...Object.fromEntries(columns.map(c=>[c.key,'number'])),total:'number',incoming:'number',sold:'number'},
    rows:view.rows.map(r=>({product:r.product,codes:r.codes.join(', '),unit:r.problem==='units'?[...new Set(r.parts.map(p=>p.unit))].join(' / '):r.unit,
      ...Object.fromEntries(columns.map(c=>{const p=r.parts.filter(x=>x.workspaceId===c.id);return [c.key,p.length===1?p[0].onHand:null];})),
      total:r.total,incoming:r.incoming,sold:r.sold,
      note:[r.problemText,r.matchedByBarcode?'Matched by barcode; codes differ.':null,r.outEverywhere?'Out of stock everywhere.':r.outIn?'Out of stock in '+r.outIn+'.':null,r.lowIn?'Low in '+r.lowIn+'.':null].filter(Boolean).join(' ')}))};
  productSheet.displayRows=productSheet.rows.map(r=>({...r,...Object.fromEntries(columns.map(c=>[c.key,qty(r[c.key])])),total:qty(r.total),incoming:qty(r.incoming),sold:qty(r.sold)}));
  const result={config:{title:'All inventories together'},sheets:[inventorySheet,totalSheet,productSheet]};
  const file=await require('./exports')[format](result);
  await audit.record(db,ctx,{action:'Exported combined inventory figures',reference:ctx.workspaceId,after:{job:JOB,format,inventories:view.inventories.length,products:view.rows.length}});
  return {file,name:'all-inventories-'+(await time.today(db,ctx.workspaceId))+'.'+format};
}

// One line per inventory, for an owner playbook step.
async function inventoryRows(db,ctx){
  const view=await model(db,ctx,{limit:1});
  return view.inventories.map(i=>({inventory:i.name,updated:i.refreshedAt||'Not updated yet',
    products_in_stock:i.figures?.inStock??null,units_on_hand:i.figures?.units??null,low_stock:i.figures?.low??null,out_of_stock:i.figures?.out??null,
    stock_value:i.figures?.value?money.format(Number(i.figures.value.minor),i.figures.value.currency):''}));
}

module.exports={JOB,KIND,href,EVERY_MINUTES,authority,process,schedule,access,model,product,requestUpdate,exportFile,inventoryRows,minorOf};

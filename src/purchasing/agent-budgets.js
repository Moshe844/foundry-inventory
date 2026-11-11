'use strict';

const money=require('../domain/currency');
const plan=require('../commercial/agent-plan');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {addDays}=require('../accounting/customer-money');

function period(value){
  if(typeof value!=='string'||!/^([1-9]\d{3})-(0[1-9]|1[0-2])$/.test(value))throw new ValidationError('Choose a month in YYYY-MM format.');
  const start=value+'-01',next=addDays(start,32).slice(0,7)+'-01';
  return {start,next};
}
async function save(db,ctx,input){
  const {start}=period(input.month),category=String(input.category||'').trim().toLowerCase();
  if(category.length>160)throw new ValidationError('Use a category of 160 characters or fewer.');
  const currency=money.code(input.currency),amount=money.userToMinor(input.amount,currency);
  const revision=Number(input.revision??0);
  if(!Number.isSafeInteger(revision)||revision<0)throw new ValidationError('Open the current budget before editing.');
  return db.transaction(async client=>{
    const owner=await client.query("SELECT id FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId]);
    if(!owner.rowCount)throw new AuthorizationError('Only the inventory owner can set a purchase budget.');
    const state=await plan.accountState(client,ctx.workspaceId);
    plan.requireJob(plan.usesAgentTerms(state)?state.plan:null,110,'draft');
    const args=[ctx.workspaceId,start,category,currency,amount];
    const changed=revision===0
      ?await client.query(`INSERT INTO stockchief_runtime.purchase_budgets(workspace_id,month_start,category,currency,amount_minor)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,args)
      :await client.query(`UPDATE stockchief_runtime.purchase_budgets SET amount_minor=$5,revision=revision+1
          WHERE workspace_id=$1 AND month_start=$2 AND category=$3 AND currency=$4 AND revision=$6`,[...args,revision]);
    if(!changed.rowCount)throw new ValidationError('This budget already exists or changed. Reload the month and edit the current amount.');
    await require('../operations/postgres-security-audit').record(client,ctx,{action:'Monthly purchase budget set',
      reference:input.month,after:{category:category||'Uncategorized',amount:money.format(amount,currency)}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

function actualPurchases(start,next){
  return `
    SELECT lower(trim(coalesce(f.category,''))) category,b.currency,sum(l.line_total_minor) actual
    FROM accounting_supplier_bills b JOIN accounting_supplier_bill_lines l ON l.workspace_id=b.workspace_id AND l.bill_id=b.id
    JOIN accounting_journal_entries e ON e.workspace_id=b.workspace_id AND e.id=b.journal_entry_id AND e.status='POSTED'
    LEFT JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    LEFT JOIN catalogue_item_facts f ON f.workspace_id=l.workspace_id AND f.item_id=coalesce(l.item_id,s.item_id)
    WHERE b.workspace_id=$1 AND b.status IN ('OPEN','PARTIALLY_PAID','PAID') AND b.issue_date>=${start} AND b.issue_date<${next}
    GROUP BY 1,2`;
}

const budgetNoticeMonth="date_trunc('month',$3::date)::date";
const budgetNoticeActual=actualPurchases(
  '('+budgetNoticeMonth+')::text',
  '('+budgetNoticeMonth+"+interval '1 month')::date::text");
const overBudgetNotices=`
  SELECT 110,'Purchase budget',b.currency||':'||b.category,
    '/autopilot/reviews/purchase-budget?filter='||to_char(b.month_start,'YYYY-MM'),b.month_start
  FROM stockchief_runtime.purchase_budgets b
  JOIN (${budgetNoticeActual}) a USING(category,currency)
  WHERE b.workspace_id=$1 AND b.month_start=${budgetNoticeMonth} AND a.actual>b.amount_minor`;

async function monitoringEnabled(db,workspaceId,state){
  if(!plan.usesAgentTerms(state)||!plan.permits(state.plan,110,'automatic')||state.shadow)return false;
  return Boolean((await db.query(`SELECT 1 FROM workspaces w
    LEFT JOIN workspace_autopilot a ON a.workspace_id=w.id
    LEFT JOIN stockchief_runtime.agent_job_modes m ON m.workspace_id=w.id AND m.job_id=110
    WHERE w.id=$1 AND w.deletion_requested_at IS NULL AND a.mode IS DISTINCT FROM 'OBSERVE'
      AND coalesce(a.paused,0)=0 AND coalesce(a.suspended,0)=0
      AND coalesce(m.mode,'inherit') NOT IN ('watch','ask')
      AND EXISTS(SELECT 1 FROM users u WHERE u.workspace_id=w.id AND u.account_id=w.owner_account_id AND u.role='owner')`,
  [workspaceId])).rowCount);
}

async function report(db,ctx,{filter,today,page},openToBuy=false){
  const month=filter||today.slice(0,7),{start,next}=period(month);
  const {rows:totals}=await db.query(`WITH actual AS (${actualPurchases('$2','$3')}), outstanding AS (
    SELECT lower(trim(coalesce(f.category,''))) category,p.currency,l.unit_cost,
      greatest(l.quantity_units-coalesce(billed.units,0),0) units
    FROM purchase_orders p JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    LEFT JOIN catalogue_item_facts f ON f.workspace_id=s.workspace_id AND f.item_id=s.item_id
    LEFT JOIN LATERAL (SELECT sum(bl.quantity) units FROM accounting_supplier_bill_lines bl JOIN accounting_supplier_bills b
      ON b.workspace_id=bl.workspace_id AND b.id=bl.bill_id JOIN accounting_journal_entries e
      ON e.workspace_id=b.workspace_id AND e.id=b.journal_entry_id AND e.status='POSTED'
      WHERE bl.workspace_id=l.workspace_id AND bl.purchase_order_line_id=l.id AND b.status IN ('OPEN','PARTIALLY_PAID','PAID') AND b.issue_date<$3) billed ON true
    WHERE $4 AND p.workspace_id=$1 AND p.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED')
      AND coalesce(p.expected_date,p.order_date)>=$2 AND coalesce(p.expected_date,p.order_date)<$3),
    committed AS (SELECT category,currency,round(sum(units::numeric*unit_cost::numeric),($6::jsonb->>currency)::int) amount,
      count(*) FILTER(WHERE units>0 AND unit_cost IS NULL) unknown FROM outstanding GROUP BY 1,2),
    budgets AS (SELECT * FROM stockchief_runtime.purchase_budgets WHERE workspace_id=$1 AND month_start=$2::text::date),
    categories AS (SELECT category,currency FROM budgets UNION SELECT category,currency FROM actual UNION SELECT category,currency FROM committed)
    SELECT k.category,k.currency,b.amount_minor,coalesce(a.actual,0) actual,coalesce(c.amount,0) committed,coalesce(c.unknown,0) unknown
    FROM categories k LEFT JOIN budgets b USING(category,currency) LEFT JOIN actual a USING(category,currency) LEFT JOIN committed c USING(category,currency)
    ORDER BY k.currency,k.category LIMIT 101 OFFSET $5`,[ctx.workspaceId,start,next,openToBuy,(page-1)*100,currencyDigits]);
  const rows=totals.slice(0,100).map(row=>{
    const fmt=n=>money.format(n,row.currency);
    const budget=row.amount_minor===null?null:money.integer(row.amount_minor);
    const spent=money.integer(row.actual);
    const base={Month:month,Category:row.category||'Uncategorized',Currency:row.currency,Budget:budget===null?null:fmt(budget),'Billed purchases':fmt(spent)};
    if(!openToBuy)return {...base,'Budget less actual':budget===null?null:fmt(budget-spent),
      Status:budget===null?'No budget set':spent>budget?'Over budget':'Within budget'};
    const committed=Number(row.unknown)||!Object.hasOwn(currencyDigits,row.currency)?null:money.toMinor(row.committed,row.currency);
    return {...base,'Unbilled commitments':committed===null?null:fmt(committed),'Open to buy':budget===null||committed===null?null:fmt(budget-spent-committed),
      'Lines missing a price':Number(row.unknown)};
  });
  return {rows,more:totals.length>100,summary:openToBuy?'Monthly buying capacity is the budget less posted bill lines and unbilled approved orders due that month. Orders without a delivery date use the order date. A missing price leaves the available budget unknown.':
    'Monthly gross purchases use posted supplier bill lines before tax and credits, grouped by current catalog category and currency.'};
}

const currencyDigits=Object.fromEntries([...Intl.supportedValuesOf('currency'),'CLF','UYW'].map(code=>[code,money.exponent(code)]));
async function settings(db,ctx,requestedMonth){
  const state=await require('../autopilot/job-reviews').ownerState(db,ctx);
  plan.requireJob(plan.usesAgentTerms(state)?state.plan:null,110,'draft');
  const month=requestedMonth||(await require('../lib/business-time').today(db,ctx.workspaceId)).slice(0,7);
  const {start}=period(month);
  const {rows}=await db.query(`SELECT category,currency,amount_minor,revision FROM stockchief_runtime.purchase_budgets
    WHERE workspace_id=$1 AND month_start=$2 ORDER BY currency,category`,[ctx.workspaceId,start]);
  const {rows:[books]}=await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId]);
  return {month,budgets:rows.map(row=>({...row,amount:money.fromMinor(row.amount_minor,row.currency)})),currency:books?.base_currency||'USD'};
}

module.exports={period,save,report,settings,monitoringEnabled,overBudgetNotices};

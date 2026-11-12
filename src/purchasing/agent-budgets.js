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
    await require('./postgres-purchase-exposure').lock(client,ctx.workspaceId,{budgetFence:true});
    const owner=(await client.query(`SELECT w.owner_account_id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
      WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL FOR SHARE OF w,u`,[ctx.workspaceId,ctx.actorId])).rows[0];
    if(!owner)throw new AuthorizationError('Only the current inventory owner can set a purchase budget.');
    await client.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE',[owner.owner_account_id]);
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
    AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=e.workspace_id AND r.reversal_of_entry_id=e.id AND r.status='POSTED')
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

async function report(db,ctx,{filter,today,page},openToBuy=false){
  const month=filter||today.slice(0,7),{start,next}=period(month);
  if(openToBuy){
    const totals=await headroom(db,ctx.workspaceId,{month,today,limit:101,offset:(page-1)*100});
    const rows=totals.slice(0,100).map(r=>{const fmt=n=>n==null?null:money.format(n,r.currency);
      return {Month:month,Category:r.category||'Uncategorized',Currency:r.currency,Budget:fmt(r.budget),'Billed purchases':fmt(r.spent),
        'Unbilled commitments':fmt(r.committed),'Reserved by open-to-buy drafts':fmt(r.reserved),'Open to buy':fmt(r.remaining),
        'Lines missing a price or measure':r.unknown,'Undated or overdue orders to check':r.undated};});
    return {rows,more:totals.length>100,summary:'Monthly goods headroom subtracts posted bills, unbilled approved orders and active drafts created from an open-to-buy plan. Missing price, measure or applicable date evidence needs review.'};
  }
  const {rows:totals}=await db.query(`WITH actual AS (${actualPurchases('$2','$3')}),
    budgets AS (SELECT * FROM stockchief_runtime.purchase_budgets WHERE workspace_id=$1 AND month_start=$2::text::date),
    categories AS (SELECT category,currency FROM budgets UNION SELECT category,currency FROM actual)
    SELECT k.category,k.currency,b.amount_minor,coalesce(a.actual,0) actual
    FROM categories k LEFT JOIN budgets b USING(category,currency) LEFT JOIN actual a USING(category,currency)
    ORDER BY k.currency,k.category LIMIT 101 OFFSET $4`,[ctx.workspaceId,start,next,(page-1)*100]);
  const rows=totals.slice(0,100).map(row=>{
    const fmt=n=>money.format(n,row.currency),budget=row.amount_minor===null?null:money.integer(row.amount_minor),spent=money.integer(row.actual);
    return {Month:month,Category:row.category||'Uncategorized',Currency:row.currency,Budget:budget===null?null:fmt(budget),'Billed purchases':fmt(spent),
      'Budget less actual':budget===null?null:fmt(budget-spent),Status:budget===null?'No budget set':spent>budget?'Over budget':'Within budget'};
  });
  return {rows,more:totals.length>100,summary:'Monthly gross purchases use posted supplier bill lines before tax and credits, grouped by current catalog category and currency.'};
}

const currencyDigits=Object.fromEntries([...Intl.supportedValuesOf('currency'),'CLF','UYW'].map(code=>[code,money.exponent(code)]));
async function headroom(db,workspaceId,{month,today,limit=null,offset=0,excludeOrderId=null}){
  const {start,next}=period(month);
  const {rows}=await db.query(`WITH actual AS (${actualPurchases('$2','$3')}), outstanding AS (
    SELECT lower(trim(coalesce(f.category,''))) category,p.currency,l.unit_cost,
      greatest(coalesce(l.secondary_quantity_ordered,l.quantity_units)-coalesce(billed.units,0),0) units,
      (coalesce(billed.incomplete,0)>0 OR i.secondary_unit_label IS NOT NULL AND l.secondary_quantity_ordered IS NULL) invalid_bill,
      p.status IN('DRAFT','AWAITING_APPROVAL') draft,
      (coalesce(p.expected_date,p.order_date)>=$2 AND coalesce(p.expected_date,p.order_date)<$3) in_month,
      p.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED') AND l.quantity_units>l.quantity_received_units
        AND (p.expected_date IS NULL OR p.expected_date<$4) uncertain_date
    FROM purchase_orders p JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
    JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    LEFT JOIN catalogue_item_facts f ON f.workspace_id=s.workspace_id AND f.item_id=s.item_id
    LEFT JOIN stockchief_runtime.agent_open_to_buy_drafts d ON d.workspace_id=p.workspace_id AND d.purchase_order_id=p.id
    LEFT JOIN LATERAL (SELECT sum(CASE WHEN l.secondary_quantity_ordered IS NULL THEN bl.quantity ELSE bl.secondary_quantity END)
       FILTER(WHERE b.currency=p.currency) units,
      count(*) FILTER(WHERE b.currency<>p.currency OR l.secondary_quantity_ordered IS NOT NULL AND bl.secondary_quantity IS NULL) incomplete
      FROM accounting_supplier_bill_lines bl JOIN accounting_supplier_bills b ON b.workspace_id=bl.workspace_id AND b.id=bl.bill_id
      JOIN accounting_journal_entries e ON e.workspace_id=b.workspace_id AND e.id=b.journal_entry_id AND e.status='POSTED'
      WHERE bl.workspace_id=l.workspace_id AND bl.purchase_order_line_id=l.id AND b.status IN('OPEN','PARTIALLY_PAID','PAID') AND b.issue_date<$3
      AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=e.workspace_id AND r.reversal_of_entry_id=e.id AND r.status='POSTED')) billed ON true
    WHERE p.workspace_id=$1 AND p.id IS DISTINCT FROM $5::text
      AND (p.status IN('APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED') OR d.purchase_order_id IS NOT NULL AND p.status IN('DRAFT','AWAITING_APPROVAL'))
      AND ((coalesce(p.expected_date,p.order_date)>=$2 AND coalesce(p.expected_date,p.order_date)<$3)
        OR $3>$4 AND p.status IN('APPROVED','ORDERED','PARTIALLY_RECEIVED') AND l.quantity_units>l.quantity_received_units
          AND (p.expected_date IS NULL OR p.expected_date<$4))),
    commitments AS (
      SELECT category,currency,
        coalesce(sum(round(units::numeric*unit_cost::numeric,($6::jsonb->>currency)::int)) FILTER(WHERE in_month AND NOT draft),0) committed,
        coalesce(sum(round(units::numeric*unit_cost::numeric,($6::jsonb->>currency)::int)) FILTER(WHERE in_month AND draft),0) reserved,
        count(*) FILTER(WHERE in_month AND (invalid_bill OR units>0 AND unit_cost IS NULL)) unknown,
        count(*) FILTER(WHERE uncertain_date AND (units>0 OR invalid_bill)) undated
      FROM outstanding GROUP BY 1,2),
    budgets AS(SELECT * FROM stockchief_runtime.purchase_budgets WHERE workspace_id=$1 AND month_start=$2::text::date),
    keys AS(SELECT category,currency FROM budgets UNION SELECT category,currency FROM actual UNION SELECT category,currency FROM commitments)
    SELECT k.category,k.currency,b.amount_minor,b.revision,coalesce(a.actual,0) actual,
      coalesce(c.committed,0) committed,coalesce(c.reserved,0) reserved,coalesce(c.unknown,0) unknown,coalesce(c.undated,0) undated
    FROM keys k LEFT JOIN budgets b USING(category,currency) LEFT JOIN actual a USING(category,currency)
    LEFT JOIN commitments c USING(category,currency) ORDER BY k.currency,k.category LIMIT $7 OFFSET $8`,
    [workspaceId,start,next,today,excludeOrderId,currencyDigits,limit,offset]);
  return rows.map(r=>{
    const supported=Object.hasOwn(currencyDigits,r.currency),budget=r.amount_minor==null?null:money.integer(r.amount_minor),spent=money.integer(r.actual);
    const committed=!supported||Number(r.unknown)?null:money.toMinor(r.committed,r.currency),reserved=supported?money.toMinor(r.reserved,r.currency):null;
    return {category:r.category,currency:r.currency,revision:r.revision,budget,spent,committed,reserved,
      unknown:Number(r.unknown),undated:Number(r.undated),remaining:budget==null||committed==null||reserved==null||Number(r.undated)?
        null:money.sum([budget,-spent,-committed,-reserved])};
  });
}
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

module.exports={period,save,report,settings,overBudgetNotices,headroom};

'use strict';
const agent=require('../commercial/agent-plan'),time=require('../lib/business-time');
const {AuthorizationError,NotFoundError}=require('../domain/errors');
const path='/autopilot/reviews/monthly-product-classes';

const currency='(SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1)';
const category="CASE WHEN abc_month.month_start IS NOT NULL THEN coalesce(abc_value.class,'C') END";

// Class C is implicit only after a current snapshot has covered the sale ledger.
function currentJoins(itemId,month){
  return `LEFT JOIN stockchief_runtime.product_class_months abc_month ON abc_month.workspace_id=$1
    AND abc_month.month_start=${month} AND abc_month.currency IS NOT DISTINCT FROM ${currency}
    LEFT JOIN stockchief_runtime.product_class_values abc_value ON abc_value.workspace_id=abc_month.workspace_id
    AND abc_value.month_start=abc_month.month_start AND abc_value.item_id=${itemId}`;
}

async function calculate(c,workspaceId){
  const workspace=(await c.query(`SELECT w.owner_account_id FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id
    WHERE w.id=$1 AND w.deletion_requested_at IS NULL FOR SHARE OF w,a`,[workspaceId])).rows[0];
  if(!workspace)return {skipped:true};
  await c.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE',[workspace.owner_account_id]);
  const state=await agent.accountState(c,workspaceId);
  if(!agent.usesAgentTerms(state)||!agent.permits(state.plan,15,'automatic'))return {skipped:true};
  const when=await time.forWorkspace(c,workspaceId),month=when.calendarDate.slice(0,7)+'-01';
  const header=await c.query(`INSERT INTO stockchief_runtime.product_class_months(workspace_id,month_start,currency)
    SELECT $1,$2,${currency}
    ON CONFLICT DO NOTHING RETURNING currency`,[workspaceId,month]);
  if(!header.rowCount)return {month,replayed:true};
  // Gross cost of physically sold units. Missing cost on even one sale keeps
  // that item out of the ranking. Equal consumption values share one class.
  const stored=await c.query(`WITH consumption AS (
    SELECT s.item_id,bool_and($4::text IS NOT NULL AND v.cost_delta_minor IS NOT NULL
      AND v.quantity_delta=-d.issued AND v.secondary_quantity_delta IS NOT DISTINCT FROM m.secondary_quantity_delta
      AND v.cost_delta_minor<=0 AND ((v.cost_delta_minor=0 AND v.journal_entry_id IS NULL) OR (
        j.status='POSTED' AND EXISTS(SELECT 1 FROM accounting_journal_lines jl WHERE jl.entry_id=j.id AND jl.workspace_id=d.workspace_id AND jl.currency=$4)
        AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries reversal WHERE reversal.workspace_id=d.workspace_id AND reversal.reversal_of_entry_id=j.id AND reversal.status='POSTED')
      )) IS TRUE) AS complete,
      sum(-v.cost_delta_minor) AS value
    FROM stockchief_runtime.replenishment_demand_events d JOIN movements m ON m.workspace_id=d.workspace_id AND m.id=d.movement_id
      AND m.reason_code IN ('sale','sold')
    JOIN skus s ON s.workspace_id=d.workspace_id AND s.id=d.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    LEFT JOIN accounting_inventory_cost_movements v ON v.workspace_id=d.workspace_id AND v.inventory_movement_id=d.movement_id
      AND v.sku_id=d.sku_id AND v.location_id=d.location_id
    LEFT JOIN accounting_journal_entries j ON j.workspace_id=v.workspace_id AND j.id=v.journal_entry_id
    WHERE d.workspace_id=$1 AND d.occurred_at>=($2::date-interval '12 months') AT TIME ZONE $3 AND d.occurred_at<$2::date::timestamp AT TIME ZONE $3 GROUP BY s.item_id
  ), bands AS (
    SELECT value,sum(value) AS band FROM consumption WHERE complete AND value>0 GROUP BY value
  ), ranked AS (
    SELECT value,sum(band) OVER(ORDER BY value DESC)-band AS prior,sum(band) OVER() AS total FROM bands
  ), recorded AS (
    INSERT INTO stockchief_runtime.product_class_values(workspace_id,month_start,item_id,class,consumption_minor)
    SELECT $1,$2,c.item_id,CASE WHEN NOT c.complete THEN 'Review' WHEN c.value=0 THEN 'C' WHEN r.prior<r.total*0.80 THEN 'A'
      WHEN r.prior<r.total*0.95 THEN 'B' ELSE 'C' END,CASE WHEN c.complete THEN c.value END
    FROM consumption c LEFT JOIN ranked r ON r.value=c.value RETURNING *
  ) SELECT count(*)::int AS count,coalesce(sum(octet_length(convert_to(to_jsonb(recorded)::text,'UTF8'))),0) AS bytes FROM recorded`,
    [workspaceId,month,when.timeZone,header.rows[0].currency]);
  const result=stored.rows[0];
  await require('../commercial/storage-capacity').reserve(c,workspaceId,'product-classes:'+month,8192+Number(result.bytes),{finished:true});
  return {month,withSales:result.count};
}

function saleCost(row){
  if(!row.currency||!row.category||row.category==='Review')return null;
  const money=require('../domain/currency'),value=row.consumption_minor||'0';
  if(Number.isSafeInteger(Number(value))&&Number(value)<2**51)return money.format(value,row.currency);
  const digits=money.exponent(row.currency),amount=String(value).padStart(digits+1,'0');
  return row.currency+' '+(digits?amount.slice(0,-digits)+'.'+amount.slice(-digits):amount);
}

async function review(db,ctx,{filter,page,today}){
  const month=today.slice(0,7)+'-01';
  const result=await db.query(`SELECT i.id,i.name,i.base_code,abc_month.currency,abc_value.consumption_minor,${category} AS category
    FROM items i ${currentJoins('i.id','$2::date')}
    WHERE i.workspace_id=$1 AND i.is_active=1 AND ($3='' OR lower(i.name)=lower($3) OR lower(i.base_code)=lower($3)
      OR lower(${category})=lower($3))
    ORDER BY category,i.name,i.id LIMIT 101 OFFSET $4`,[ctx.workspaceId,month,filter,(page-1)*100]);
  return {more:result.rowCount>100,summary:'Monthly ABC classes use the gross stock cost of sales in the previous 12 complete months. A covers the first 80% of value, B the next 15%, and C the rest, including products with no recorded sales. Products with equal consumption stay together. Missing sale costs require review. Open a product for count and safety-stock planning.',
    rows:result.rows.slice(0,100).map(r=>({Product:r.name,'Product code':r.base_code,Class:r.category||'Awaiting monthly review','Month beginning':month,
      'Sale cost':saleCost(r),link:path+'/products/'+encodeURIComponent(r.id)}))};
}

async function productForPlanning(db,ctx,itemId){
  const owner=await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId]);
  if(!owner.rowCount)throw new AuthorizationError('Only the current inventory owner can review ABC safety planning.');
  await agent.requireWorkspaceJob(db,ctx.workspaceId,15,'suggest');
  const month=(await time.today(db,ctx.workspaceId)).slice(0,7)+'-01';
  const product=(await db.query(`SELECT i.id,i.name,i.base_code,i.unit_label,abc_month.currency,abc_value.consumption_minor,
    abc_value.item_id IS NOT NULL AS has_sales,${category} AS category
    FROM items i ${currentJoins('i.id','$2::date')} WHERE i.workspace_id=$1 AND i.id=$3 AND i.is_active=1`,
    [ctx.workspaceId,month,itemId])).rows[0];
  if(!product)throw new NotFoundError('Choose an active product in this inventory.');
  return {...product,month,saleCost:saleCost(product)};
}

module.exports={calculate,review,currentJoins,category,productForPlanning,path};

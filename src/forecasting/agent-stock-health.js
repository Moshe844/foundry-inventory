'use strict';

const money=require('../domain/currency');

async function report(db,ctx,{filter,page,today}){
  const {rows}=await db.query(`WITH selected AS (
    SELECT s.id,s.code,s.item_id,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ($2='' OR lower(s.code)=lower($2) OR lower(i.name)=lower($2))
    ORDER BY s.code,s.id LIMIT 51 OFFSET $4
  ), book AS (
    SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1
  ), daily AS (
    SELECT l.sku_id,e.posting_date::date AS day,
      sum(CASE WHEN a.system_key='INVENTORY_ASSET' THEN l.debit_minor-l.credit_minor ELSE 0 END)::numeric AS assets,
      sum(CASE WHEN a.system_key IN ('SALES_REVENUE','SALES_RETURNS') THEN l.credit_minor-l.debit_minor ELSE 0 END)::numeric AS sales,
      sum(CASE WHEN a.system_key='COST_OF_GOODS_SOLD' THEN l.debit_minor-l.credit_minor ELSE 0 END)::numeric AS cogs
    FROM accounting_journal_lines l JOIN selected s ON s.id=l.sku_id
    JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id AND e.status='POSTED'
    JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
    JOIN book ON book.base_currency=l.currency WHERE l.workspace_id=$1 AND e.posting_date::date<=$3::date
      AND a.system_key IN ('INVENTORY_ASSET','SALES_REVENUE','SALES_RETURNS','COST_OF_GOODS_SOLD')
    GROUP BY l.sku_id,e.posting_date::date
  ), first_day AS (
    SELECT sku_id,greatest(min(day),$3::date-89) AS first FROM daily GROUP BY sku_id
  ), financial AS (
    SELECT d.sku_id,f.first,($3::date-f.first+1) AS days,sum(d.assets) AS closing,
      sum(d.assets*($3::date-greatest(f.first,d.day)+1))/($3::date-f.first+1) AS average,
      sum(d.sales) FILTER(WHERE d.day>=f.first) AS sales,sum(d.cogs) FILTER(WHERE d.day>=f.first) AS cogs
    FROM daily d JOIN first_day f ON f.sku_id=d.sku_id GROUP BY d.sku_id,f.first
  ), physical AS (
    SELECT b.sku_id,sum(b.on_hand) AS units,sum(coalesce(c.total_cost_minor,0)) AS valuation,
      bool_and(b.on_hand=coalesce(c.quantity_units,0) AND b.on_hand>=0) AS covered
    FROM balances b JOIN selected s ON s.id=b.sku_id LEFT JOIN accounting_inventory_cost_balances c
      ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id
    WHERE b.workspace_id=$1 GROUP BY b.sku_id
  ), issued AS (
    SELECT m.sku_id,sum(-m.quantity_delta) AS units FROM movements m JOIN first_day f ON f.sku_id=m.sku_id
    JOIN workspaces w ON w.id=m.workspace_id JOIN accounts a ON a.id=w.owner_account_id
    WHERE m.workspace_id=$1 AND m.operation='issue' AND m.reason_code IN ('sold','sale')
      AND (m.occurred_at::timestamptz AT TIME ZONE coalesce(w.time_zone,a.time_zone,'UTC'))::date BETWEEN f.first AND $3::date
    GROUP BY m.sku_id)
  SELECT s.*,f.days,f.average,f.closing,f.sales,f.cogs,p.covered,p.units,p.valuation,coalesce(i.units,0) AS issued,
    (SELECT base_currency FROM book) AS currency FROM selected s LEFT JOIN financial f ON f.sku_id=s.id
    LEFT JOIN physical p ON p.sku_id=s.id LEFT JOIN issued i ON i.sku_id=s.id ORDER BY s.code,s.id`,
    [ctx.workspaceId,filter,today,(page-1)*50]);
  return {more:rows.length>50,summary:'Turns and gross margin return on inventory (GMROI) use up to 90 days of posted SKU activity in the inventory currency. Average investment is the daily closing stock value. Days of supply uses physical stock and recorded sales issues during the same period.',
    rows:rows.slice(0,50).map(r=>{
      const reconciled=r.covered===true && r.closing!=null && Number(r.closing)===Number(r.valuation);
      const average=Number(r.average),eligible=reconciled&&average>0;
      const rounded=value=>Math.round(value*100)/100;
      return {SKU:r.code,Product:r.name,'Days measured':r.days,'Average stock value':reconciled?money.format(Math.round(average),r.currency):null,
        'Inventory turns':eligible?rounded(Number(r.cogs??0)/average):null,'GMROI':eligible?rounded((Number(r.sales??0)-Number(r.cogs??0))/average):null,
        'Days of supply':Number(r.issued)>0&&r.units!=null?rounded(Number(r.units)*r.days/Number(r.issued)):null,
        'Valuation check':reconciled?'Matches the stock ledger':'Stock valuation needs review',link:'/inventory/'+r.item_id};
    })};
}

module.exports={report};

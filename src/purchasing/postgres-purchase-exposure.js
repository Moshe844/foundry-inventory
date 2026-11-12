'use strict';
const {ValidationError}=require('../domain/errors');
async function lock(client,workspaceId,{budgetFence=false}={}){
 await client.query("SELECT pg_advisory_xact_lock(hashtextextended('purchase-authority:'||$1,0))",[workspaceId]);
 if(!budgetFence)return;
 const installed=(await client.query("SELECT to_regclass('stockchief_runtime.agent_open_to_buy_fences') IS NOT NULL installed")).rows[0].installed;
 if(!installed)return;
 // A transaction may already have a serializable snapshot before it waits for
 // the advisory lock. Updating the fence forces a stale snapshot to retry.
 await client.query(`INSERT INTO stockchief_runtime.agent_open_to_buy_fences(workspace_id) VALUES($1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=agent_open_to_buy_fences.revision+1`,[workspaceId]);
}
async function read(database,workspaceId,{now=null}={}){
 const rows=(await database.query(`WITH lines AS(SELECT purchase_order_id,SUM(unit_cost::numeric*quantity_units) AS full_amount,SUM(GREATEST(quantity_units-quantity_received_units,0)*unit_cost::numeric) AS pending_amount,COUNT(*) FILTER(WHERE unit_cost IS NULL) AS unknown_prices FROM purchase_order_lines WHERE workspace_id=$1 GROUP BY purchase_order_id),
 charges AS(SELECT purchase_order_id,SUM(amount_minor) FILTER(WHERE kind<>'deposit') AS amount_minor FROM purchase_order_charges WHERE workspace_id=$1 GROUP BY purchase_order_id)
 SELECT po.id,po.currency,po.status,COALESCE(po.approved_at,po.ordered_at,po.created_at)::timestamptz>=COALESCE($2::timestamptz,CURRENT_TIMESTAMP)-interval '7 days' AS in_window,
  COALESCE(lines.full_amount,0)::text AS full_amount,COALESCE(lines.pending_amount,0)::text AS pending_amount,
  COALESCE(charges.amount_minor,0)::text AS charge_minor,COALESCE(lines.unknown_prices,0) AS unknown_prices
 FROM purchase_orders po LEFT JOIN lines ON lines.purchase_order_id=po.id LEFT JOIN charges ON charges.purchase_order_id=po.id
 WHERE po.workspace_id=$1 AND po.status IN('APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED')
  AND(COALESCE(po.approved_at,po.ordered_at,po.created_at)::timestamptz>=COALESCE($2::timestamptz,CURRENT_TIMESTAMP)-interval '7 days' OR po.status IN('APPROVED','ORDERED','PARTIALLY_RECEIVED')) ORDER BY po.id`,[workspaceId,now])).rows;
 const currency=require('../domain/currency'),currencies={},orders=[];for(const row of rows){const charges=currency.integer(row.charge_minor,'Purchase charges',{signed:true}),amount=currency.sum([currency.toMinor(row.in_window?row.full_amount:row.pending_amount,row.currency,{label:'Purchase commitments'}),charges]);if(amount<0)throw new ValidationError('Existing purchase commitments need review before automatic spending can continue.');currencies[row.currency]=currency.sum([currencies[row.currency]||0,amount]);orders.push({id:row.id,currency:row.currency,amountMinor:amount,basis:row.in_window?'recent_commitment':'older_open_commitment'});}
 return {currencies,unknownPrices:rows.some(row=>Number(row.unknown_prices)>0),orders};
}
module.exports={lock,read};

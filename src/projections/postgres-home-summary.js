'use strict';
// What Home says about the business and about StockChief's own work. Every figure is a
// count or total from the records, over the business's own calendar.
const clock=require('../lib/business-time'),sales=require('../accounting/posted-sales');
const DAYS=7;
function sameDaysLastMonth(today){const year=Number(today.slice(0,4)),month=Number(today.slice(5,7)),day=Number(today.slice(8,10)),last=new Date(Date.UTC(year,month-1,0)),pad=n=>String(n).padStart(2,'0');return {from:last.getUTCFullYear()+'-'+pad(last.getUTCMonth()+1)+'-01',to:last.getUTCFullYear()+'-'+pad(last.getUTCMonth()+1)+'-'+pad(Math.min(day,last.getUTCDate()))};}
async function read(db,workspaceId,{seesMoney=false,sales:current=null}={}){
 const since=new Date(Date.now()-DAYS*86400000).toISOString();
 const [work,findings,ready,state,skus]=await Promise.all([
  db.query(`SELECT count(*) FILTER (WHERE execution_status='COMPLETED' AND approval_requirement='NONE' AND completed_at::timestamptz>=$2)::int AS alone,count(*) FILTER (WHERE execution_status='COMPLETED' AND approval_requirement<>'NONE' AND completed_at::timestamptz>=$2)::int AS approved,count(*) FILTER (WHERE created_at::timestamptz>=$2)::int AS proposed FROM work_items WHERE workspace_id=$1`,[workspaceId,since]),
  db.query(`SELECT count(*) FILTER (WHERE first_detected_at::timestamptz>=$2)::int AS found,count(*) FILTER (WHERE status='RESOLVED' AND resolved_at::timestamptz>=$2)::int AS resolved FROM attention_items WHERE workspace_id=$1`,[workspaceId,since]),
  db.query("SELECT count(*)::int AS count FROM sales_orders WHERE workspace_id=$1 AND status='CONFIRMED'",[workspaceId]),
  require('../autopilot/postgres-service').getState(db,workspaceId),
  db.query('SELECT count(*)::int AS count FROM skus WHERE workspace_id=$1 AND is_active=1',[workspaceId]),
 ]);
 const out={days:DAYS,watching:skus.rows[0].count,found:work.rows[0].proposed+findings.rows[0].found,resolved:findings.rows[0].resolved,doneAlone:work.rows[0].alone,doneApproved:work.rows[0].approved,readyToShip:ready.rows[0].count,canAutomate:Boolean(state.canAutomate),salesChange:null,stockValue:null};
 if(seesMoney&&current){
  const today=(await clock.forWorkspace(db,workspaceId)).calendarDate,prior=await sales.forPeriod(db,workspaceId,sameDaysLastMonth(today));
  if(Number(prior.minor)>0)out.salesChange=Math.round((Number(current.minor)-Number(prior.minor))*100/Number(prior.minor));
  const stock=(await db.query('SELECT coalesce(sum(total_cost_minor),0)::bigint AS minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[workspaceId])).rows[0];
  out.stockValue={minor:Number(stock.minor),currency:current.currency};
 }
 return out;
}
module.exports={read,sameDaysLastMonth};

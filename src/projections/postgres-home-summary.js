'use strict';
// What Home says about the business and about StockChief's own work. Every figure is a
// count or total from the records, over the business's own calendar.
const clock=require('../lib/business-time'),sales=require('../accounting/posted-sales');
const DAYS=7;
function sameDaysLastMonth(today){const year=Number(today.slice(0,4)),month=Number(today.slice(5,7)),day=Number(today.slice(8,10)),last=new Date(Date.UTC(year,month-1,0)),pad=n=>String(n).padStart(2,'0');return {from:last.getUTCFullYear()+'-'+pad(last.getUTCMonth()+1)+'-01',to:last.getUTCFullYear()+'-'+pad(last.getUTCMonth()+1)+'-'+pad(Math.min(day,last.getUTCDate()))};}
async function activityCounts(db,workspaceId,since){
 return (await db.query(`SELECT completed.alone,completed.approved,
  (SELECT count(*)::int FROM work_items WHERE workspace_id=$1
   AND stockchief_movement_instant(created_at)>=$2::timestamptz) AS proposed,
  (SELECT count(*)::int FROM attention_items WHERE workspace_id=$1
   AND stockchief_movement_instant(first_detected_at)>=$2::timestamptz) AS found,
  (SELECT count(*)::int FROM attention_items WHERE workspace_id=$1 AND status='RESOLVED'
   AND stockchief_movement_instant(resolved_at)>=$2::timestamptz) AS resolved
 FROM (SELECT count(*) FILTER(WHERE approval_requirement='NONE')::int AS alone,
  count(*) FILTER(WHERE approval_requirement<>'NONE')::int AS approved
  FROM work_items WHERE workspace_id=$1 AND execution_status='COMPLETED'
   AND stockchief_movement_instant(completed_at)>=$2::timestamptz) completed`,[workspaceId,since])).rows[0];
}
async function read(db,workspaceId,{seesMoney=false,sales:current=null,skuCount=null}={}){
 const since=new Date(Date.now()-DAYS*86400000).toISOString();
 const [work,ready,state,watching]=await Promise.all([
  activityCounts(db,workspaceId,since),
  db.query("SELECT count(*)::int AS count FROM sales_orders WHERE workspace_id=$1 AND status='CONFIRMED'",[workspaceId]),
  require('../autopilot/postgres-service').getState(db,workspaceId),
  skuCount===null?db.query('SELECT count(*)::int AS count FROM skus WHERE workspace_id=$1 AND is_active=1',[workspaceId]).then(result=>result.rows[0].count):skuCount,
 ]);
 if(!Number.isSafeInteger(watching)||watching<0)throw new RangeError('Home needs an exact active-SKU count.');
 const out={days:DAYS,watching,found:work.proposed+work.found,resolved:work.resolved,doneAlone:work.alone,doneApproved:work.approved,readyToShip:ready.rows[0].count,canAutomate:Boolean(state.canAutomate),salesChange:null,salesDays:null,stockValue:null};
 if(seesMoney&&current){
  const today=(await clock.forWorkspace(db,workspaceId)).calendarDate;
  const [prior,days]=await Promise.all([sales.forPeriod(db,workspaceId,sameDaysLastMonth(today)),sales.byDay(db,workspaceId,{from:current.from||today.slice(0,7)+'-01',to:current.to||today})]);
  // Each day of the month so far, and how many days the month has, for Home's sales bars.
  if(days)out.salesDays={days,monthDays:new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7)),0)).getUTCDate()};
  if(Number(prior.minor)>0)out.salesChange=Math.round((Number(current.minor)-Number(prior.minor))*100/Number(prior.minor));
  const stock=await require('../lib/versioned-read-model').read(db,workspaceId,['home-stock-value'],()=>require('./postgres-cost-summaries').value(db,workspaceId),{domain:'business'});
  out.stockValue={minor:Number(stock.minor),currency:current.currency};
 }
 return out;
}
module.exports={read,sameDaysLastMonth,activityCounts};

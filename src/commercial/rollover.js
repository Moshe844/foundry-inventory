'use strict';
const {newId}=require('../lib/util');
// Period snapshots keep a later plan change from rewriting an earned balance.
// Carry expires at this period's end and can never roll over a second time.
async function balance(db,scope,meter,bounds,policy,baseUnits){
 if(Number(policy.rollover_months)!==1||baseUnits===null)return null;
 const record=(await db.query(`INSERT INTO commercial_usage_periods(id,account_id,meter,period_start,period_end,base_units,carry_units)
 SELECT $1,$2,$3,$4,$5,$6,COALESCE((SELECT GREATEST(0,p.base_units-COALESCE((SELECT sum(a.units)
 FROM commercial_usage_allocations a JOIN commercial_usage_events e ON e.id=a.event_id
 WHERE e.account_id=p.account_id AND e.meter=p.meter AND a.grant_id IS NULL AND a.rollover_id IS NULL
 AND e.status IN ('RESERVED','COMMITTED') AND e.occurred_at>=p.period_start AND e.occurred_at<p.period_end),0))
 FROM commercial_usage_periods p WHERE p.account_id=$2 AND p.meter=$3 AND p.period_end=$4),0)
 ON CONFLICT(account_id,meter,period_start) DO UPDATE SET base_units=GREATEST(commercial_usage_periods.base_units,EXCLUDED.base_units)
 RETURNING *`,[newId('usageperiod'),scope.accountId,meter,bounds.start,bounds.end,baseUnits])).rows[0];
 const totals=(await db.query(`SELECT COALESCE(sum(a.units) FILTER(WHERE e.status='COMMITTED'),0) used,
 COALESCE(sum(a.units) FILTER(WHERE e.status='RESERVED'),0) reserved FROM commercial_usage_allocations a
 JOIN commercial_usage_events e ON e.id=a.event_id WHERE a.rollover_id=$1`,[record.id])).rows[0];
 return {id:record.id,units:Number(record.carry_units),used:Number(totals.used),reserved:Number(totals.reserved),
  remaining:Math.max(0,Number(record.carry_units)-Number(totals.used)-Number(totals.reserved)),expiresAt:record.period_end};
}
module.exports={balance};

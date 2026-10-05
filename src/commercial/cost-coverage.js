'use strict';
// Administrator-only diagnostics. Counts describe observed events, not proof
// that every possible production branch or provider contract is covered.
async function report(database,options={}){
 const end=options.end?new Date(options.end):new Date();
 const start=options.start?new Date(options.start):new Date(end.getTime()-30*86400000);
 if(!(end>start))throw Error('Cost coverage needs a valid period');
 const [operations,resources,invoices]=await Promise.all([
  database.query(`SELECT provider,operation,unit,model,provider_version,currency,COUNT(*)::int AS events,
   COUNT(*) FILTER(WHERE amount_minor IS NULL)::int AS missing_rates,SUM(quantity)::text AS measured_quantity,
   SUM(amount_minor)::text AS known_cost_minor FROM commercial_cost_events WHERE occurred_at>=$1 AND occurred_at<$2
   GROUP BY provider,operation,unit,model,provider_version,currency ORDER BY provider,operation,model,provider_version`,[start,end]),
  database.query(`SELECT resource_id,runtime_kind,attribution,COUNT(*)::int AS samples,
   MIN(started_at) AS first_sample,MAX(finished_at) AS last_sample,SUM(elapsed_microseconds)::text AS elapsed_microseconds,
   SUM(database_microseconds)::text AS database_microseconds,SUM(database_queries)::text AS database_queries
   FROM commercial_resource_measurements WHERE started_at>=$1 AND started_at<$2
   GROUP BY resource_id,runtime_kind,attribution ORDER BY resource_id,attribution`,[start,end]),
  database.query(`SELECT provider,resource_id,currency,COUNT(*)::int AS statement_lines,SUM(amount_minor)::text AS invoice_amount_minor
   FROM commercial_provider_cost_statements WHERE period_start<$2 AND period_end>$1
   GROUP BY provider,resource_id,currency ORDER BY provider,resource_id`,[start,end]),
 ]);
 return {start:start.toISOString(),end:end.toISOString(),observedOperations:operations.rows,resources:resources.rows,providerStatements:invoices.rows,
  observedMissingRateEvents:operations.rows.reduce((sum,row)=>sum+row.missing_rates,0),
  unmeteredOperationCount:null,completeCostCoverage:false,resourceTelemetry:require('./resource-metrics').status(),
  limitations:['Observed operations are not an exhaustive execution audit.',
   'Service occupancy and database latency are measurements, not per-tenant CPU or disk bytes.',
   'Shared/idle capacity, storage, backups, bandwidth and connected-provider contract liability require separate evidence.',
   'Invoice totals are source amounts, not amounts accrued to this reporting period; allocation does not happen here.']};
}
module.exports={report};

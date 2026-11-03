'use strict';
const guard=require('./staging-database-guard');
async function snapshot(db){
 return (await db.query(`SELECT queryid::text,calls::text,total_exec_time,mean_exec_time,rows::text,left(query,2000) AS statement
  FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
  AND query ~* '^[[:space:]]*(select|with|insert|update|delete|analyze|explain)[[:space:]]'
  AND(query ILIKE '%replenishment_%' OR query ILIKE '%import_%' OR query ILIKE '%movements%' OR query ILIKE '%accounting_%')
  ORDER BY total_exec_time DESC LIMIT 80`)).rows;
}
async function reset(db,{connectionString,serviceId}={}){
 const url=guard.assertDatabase(connectionString);
 if(serviceId!=='srv-daqh418473hc73853e7g')throw Error('Only the existing staging qualification worker may reset its database statistics.');
 const identity=(await db.query('SELECT current_database() AS name,oid::text AS oid FROM pg_database WHERE datname=current_database()')).rows[0];
 if(identity?.name!==decodeURIComponent(url.pathname.slice(1)))throw Error('The query statistics database does not match the guarded staging connection.');
 const previous=await snapshot(db);
 // Scope to this database, all its users/query IDs. Never reset other databases
 // on the PostgreSQL instance. The user explicitly requested this measurement.
 await db.query('SELECT pg_stat_statements_reset(0,$1::oid,0)',[identity.oid]);
 return {database:identity.name,resetAt:new Date().toISOString(),previous};
}
module.exports={reset,snapshot};

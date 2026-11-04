'use strict';
// Exercise recovery of a disposable derived view without replaying an older
// migration that would reinstall the removed shared write-path triggers.
module.exports=async function recreate(db,name){
 if(!['inventory_movement_second_totals','accounting_daily_account_totals','inventory_cost_coverage_totals'].includes(name))throw Error('UNKNOWN_TEST_READ_VIEW');
 await db.transaction(async client=>{
  const row=(await client.query("SELECT pg_get_viewdef($1::regclass,true) AS definition,reloptions FROM pg_class WHERE oid=$1::regclass AND relkind='v'",[name])).rows[0];
  if(!row?.reloptions?.includes('security_invoker=true'))throw Error('TEST_REQUIRES_INVOKER_VIEW');
  await client.query('DROP VIEW '+name);
  await client.query('CREATE VIEW '+name+' WITH(security_invoker=true) AS '+row.definition);
 },{isolation:'READ COMMITTED',retrySafe:true});
};

'use strict';const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function check(db,ctx,{closedJobs=50000,emptyWorkspaces=100}={}){
 let scheduleSql;await require('../../src/projections/postgres-sku-stock').schedule({query:async sql=>{scheduleSql=sql;return{rows:[]};}});
 const before=(await db.query('SELECT count(*)::int n FROM stockchief_runtime.jobs')).rows[0].n,positions=(await db.query('SELECT count(*)::int n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,prefix='locality-'+randomUUID()+'-';let proof;
 try{await db.transaction(async c=>{
  await c.query(`INSERT INTO workspaces(id,name,owner_account_id,created_at)
   SELECT $2||n,'Empty maintenance fixture',w.owner_account_id,now() FROM workspaces w CROSS JOIN generate_series(1,$3::int)n WHERE w.id=$1`,[ctx.workspaceId,prefix,emptyWorkspaces]);
  await c.query(`INSERT INTO stockchief_runtime.jobs(id,workspace_id,kind,payload,status,available_at,idempotency_key,created_at,updated_at)
   SELECT $2||n,$1,'fixture.maintenance-locality','{}',CASE WHEN n=0 THEN 'PAUSED' ELSE 'COMPLETED' END,0,$2||n,'2020-01-01','2020-01-01' FROM generate_series(0,$3::int)n`,[ctx.workspaceId,prefix,closedJobs]);
  let testedSchedule=scheduleSql;
  if(positions<150000){
   // Small focused fixtures still exercise a genuinely large occupied source.
   // Full round-17 certification uses its actual canonical stock positions.
   await c.query('CREATE TEMP TABLE maintenance_balance_fixture(workspace_id text NOT NULL,sku_id text NOT NULL,location_id text NOT NULL) ON COMMIT DROP');
   await c.query("INSERT INTO maintenance_balance_fixture SELECT $1,'sku-'||n,'location' FROM generate_series(1,150000)n",[ctx.workspaceId]);
   await c.query('CREATE INDEX maintenance_balance_scope ON maintenance_balance_fixture(workspace_id,sku_id,location_id)');await c.query('ANALYZE maintenance_balance_fixture');
   testedSchedule=scheduleSql.replaceAll('FROM balances b','FROM pg_temp.maintenance_balance_fixture b');assert.notEqual(testedSchedule,scheduleSql);
  }
  const pausedSql=require('../../src/operations/paused-jobs-source').source(),expected=(await c.query("SELECT id,workspace_id,last_error FROM stockchief_runtime.jobs WHERE status='PAUSED' AND workspace_id IS NOT NULL ORDER BY updated_at,id LIMIT 100")).rows,actual=(await c.query(pausedSql)).rows;assert.deepEqual(actual,expected);assert(actual.some(r=>r.id===prefix+'0'));
  const plans=[];for(const [kind,sql]of [['stock-scheduling',testedSchedule],['paused-jobs',pausedSql]]){const plan=(await c.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+sql)).rows[0]['QUERY PLAN'][0],nodes=[];const visit=p=>{nodes.push(p);for(const child of p.Plans||[])visit(child);};visit(plan.Plan);plans.push({kind,ms:plan['Execution Time'],nodes});assert(plan['Execution Time']<1500);
   if(kind==='stock-scheduling'){const balances=nodes.filter(p=>['balances','maintenance_balance_fixture'].includes(p['Relation Name']));assert(balances.length);assert(balances.every(p=>p['Node Type']!=='Seq Scan'),'Empty inventories must not scan the balances table');assert(balances.every(p=>p['Actual Rows']<=1));}
   else{assert(nodes.some(p=>p['Index Name']==='jobs_paused_updated_order'));assert(!nodes.some(p=>p['Relation Name']==='jobs'&&p['Node Type']==='Seq Scan'));assert(nodes.filter(p=>p['Relation Name']==='jobs').every(p=>p['Actual Rows']*p['Actual Loops']<=100));}
  }
  proof={maintenanceClosedJobs:closedJobs,maintenanceSourcePositions:Math.max(positions,150000),canonicalMaintenanceStock:positions>=150000,emptyInventoryChecks:emptyWorkspaces,emptyInventoryBalanceScan:false,pausedJobOrderExact:true,pausedJobBatchBound:100,stockScheduleMs:plans[0].ms,pausedJobMs:plans[1].ms,sourceRowsChanged:0,paidCalls:0};
  throw Object.assign(Error('Rollback maintenance locality fixture'),{qualificationRollback:true});
 },{isolation:'READ COMMITTED',jit:false});}catch(error){if(!error.qualificationRollback)throw error;}
 assert(proof);assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.jobs')).rows[0].n,before);assert.equal((await db.query('SELECT count(*)::int n FROM workspaces WHERE id LIKE $1',[prefix+'%'])).rows[0].n,0);return proof;
}
module.exports={check};

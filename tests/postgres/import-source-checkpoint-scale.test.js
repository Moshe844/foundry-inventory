'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');

test('source checkpoints update only their locked batch at 150,000 rows with stale statistics',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const imports=require('../../src/imports/postgres-service'),store=require('../../src/imports/postgres-row-store');
 const plan=await imports.analyse(db,ctx,{text:'Product,SKU\nCheckpoint fixture,CHECKPOINT-ONE',allowModel:false});
 const other=await imports.analyse(db,ctx,{text:'Product,SKU\nOther source,CHECKPOINT-OTHER',allowModel:false});
 const otherId=(await db.query('SELECT id FROM import_rows WHERE workspace_id=$1 AND import_id=$2',[ctx.workspaceId,other.id])).rows[0].id;
 await db.query('ANALYZE import_rows');
 await db.query(`INSERT INTO import_rows(id,import_id,workspace_id,row_number,raw,parsed,status,problems,created_at)
  SELECT 'checkpoint-scale-'||n,$2,$1,n,'{}','{}','VALID','[]',now() FROM generate_series(100,150099)n`,[ctx.workspaceId,plan.id]);
 const updates=Array.from({length:2000},(_,n)=>({id:'checkpoint-scale-'+(100+n*75),itemId:f.item.id,skuId:f.item.skuIds[0],locationId:f.location.id,movementIds:['verified-movement-'+n],quantity:1,at:'2026-11-06T00:00:00.000Z'}));
 const summaries=[];
 for(const mode of ['force_generic_plan','force_custom_plan']){
  const rollback=Error('rollback checkpoint probe');
  await assert.rejects(db.transaction(async c=>{
   await c.query('SET LOCAL plan_cache_mode='+mode);
   const measured={query:async(sql,values)=>{
    const explained=(await c.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+sql,values)).rows[0]['QUERY PLAN'][0];
    const nodes=[];const walk=p=>{nodes.push(p);for(const child of p.Plans||[])walk(child);};walk(explained.Plan);
    const scans=nodes.filter(p=>p['Relation Name']==='import_rows'&&p['Node Type']!=='ModifyTable');
    assert(scans.some(p=>p['Index Name']==='import_rows_pkey'),'Batch identities are resolved through the unique primary key');
    assert(scans.every(p=>p['Index Name']==='import_rows_pkey'),'Both the scoped lock and the final update use stable primary-key probes');
    assert(scans.every(p=>p['Actual Rows']<=1&&p['Actual Loops']<=2000),'No checkpoint scans the remaining source');
    assert.equal(nodes.some(p=>p['Node Type']==='Seq Scan'),false);
    summaries.push({mode,ms:explained['Execution Time'],rows:updates.length});return {rowCount:updates.length};
   }};
   await store.markImported(measured,ctx.workspaceId,plan.id,updates);
   const saved=(await c.query("SELECT id,quantity,movement_ids FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status='IMPORTED'",[ctx.workspaceId,plan.id])).rows;
   assert.equal(saved.length,2000);assert(saved.every(r=>r.quantity==='1'&&JSON.parse(r.movement_ids).length===1));
   throw rollback;
  },{isolation:'READ COMMITTED',statementTimeoutMs:15000}),e=>e===rollback);
 }
 assert.equal((await db.query("SELECT count(*)::int n FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status='IMPORTED'",[ctx.workspaceId,plan.id])).rows[0].n,0,'Rolled-back progress never survives');
 for(const [workspaceId,importId,rows] of [[ctx.workspaceId,plan.id,[{...updates[0],id:otherId}]],['foreign-workspace',plan.id,[updates[0]]],[ctx.workspaceId,plan.id,[updates[0],updates[0]]]]){
  await assert.rejects(db.transaction(c=>store.markImported(c,workspaceId,importId,rows),{isolation:'READ COMMITTED'}),/identities did not reconcile/);
 }
 assert.equal((await db.query('SELECT status FROM import_rows WHERE id=$1',[otherId])).rows[0].status,'VALID','Another source is unchanged');
 await db.transaction(c=>store.markImported(c,ctx.workspaceId,plan.id,updates),{isolation:'READ COMMITTED'});
 await db.transaction(c=>store.markImported(c,ctx.workspaceId,plan.id,updates),{isolation:'READ COMMITTED'});
 assert.equal((await db.query("SELECT count(*)::int n FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status='IMPORTED'",[ctx.workspaceId,plan.id])).rows[0].n,2000,'Replay never expands the completed source set');
 // READ COMMITTED may encounter a newer physical tuple while waiting for a
 // row lock. The checkpoint must follow the locked version, not a stale ctid.
 const locked=Promise.withResolvers(),release=Promise.withResolvers(),started=Promise.withResolvers();let pending;
 const writer=db.transaction(async c=>{
  await c.query('UPDATE import_rows SET quantity=2 WHERE id=$1',[updates[0].id]);locked.resolve();await release.promise;
 },{isolation:'READ COMMITTED'});
 try{
  await locked.promise;
  pending=db.transaction(async c=>{const pid=(await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;started.resolve(pid);await store.markImported(c,ctx.workspaceId,plan.id,[updates[0]]);},{isolation:'READ COMMITTED',lockTimeoutMs:10000});
  const pid=await started.promise;let blocked=false;
  for(let n=0;n<100&&!blocked;n++){blocked=(await db.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked;if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));}
  assert(blocked,'Checkpoint waits for the conflicting source-row writer');
 }finally{release.resolve();await writer;if(pending)await pending;}
 assert.equal((await db.query('SELECT quantity FROM import_rows WHERE id=$1',[updates[0].id])).rows[0].quantity,'1','Checkpoint follows the latest locked tuple after a concurrent commit');
 t.diagnostic(JSON.stringify({sourceRows:150000,checkpointRows:2000,bounded:true,summaries}));
});

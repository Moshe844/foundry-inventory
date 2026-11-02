'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('Ask inspection and telemetry survive terminated idle database connections without broadening read permissions',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);let server;
 t.after(async()=>{await server?.close();await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Recovery owner',businessName:'Idle connection recovery',email:'idle-recovery@example.test',password:'Idle-recovery-fixture!'}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const foreign=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Foreign owner',businessName:'Foreign recovery fixture',email:'foreign-idle@example.test',password:'Foreign-idle-fixture!'}),other={workspaceId:foreign.workspaceId,actorId:foreign.userId};
 for(const [actor,code] of [[ctx,'OWN'],[other,'FOREIGN']]){
  const item=await require('../../src/domain/postgres-catalog-service').createItem(db,actor,{name:code+' item',baseCode:code,trackingMode:'quantity'}),location=await require('../../src/domain/postgres-location-service').createLocation(db,actor,{name:code+' warehouse',kind:'warehouse'});
  await require('../../src/domain/postgres-inventory-engine').receive(db,actor,{skuId:item.skuIds[0],locationId:location.id,quantity:5,idempotencyKey:'idle-opening'});
  await db.query("INSERT INTO customers(id,workspace_id,name,record_state,created_by_user_id,created_at,updated_at) VALUES($1,$2,$1,'ACTIVE',$3,now(),now())",[code+'-customer',actor.workspaceId,actor.actorId]);
  const flows=require('../../src/operations/postgres-business-workflows'),order=await flows.createSalesOrder(db,actor,{customerId:code+'-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:location.id,idempotencyKey:'idle-order',lines:[{skuId:item.skuIds[0],quantity:1,unitPriceMinor:100}]});await flows.confirmSalesOrder(db,actor,order.salesOrderId,{idempotencyKey:'idle-confirm'});
 }
 server=await require('../../scripts/environment-agent-demo/inspection').createInspectionServer({cluster,database:db,ctx});
 assert.deepEqual((await server.readonly.query('SELECT DISTINCT workspace_id FROM sales_stock_commitments')).rows,[{workspace_id:ctx.workspaceId}]);
 async function waitFor(condition){const end=Date.now()+5000;while(!condition()){if(Date.now()>end)throw Error('The idle connection error was not observed');await new Promise(r=>setTimeout(r,10));}}
 const readPid=(await server.readonly.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 await db.query('SELECT pg_terminate_backend($1)',[readPid]);await waitFor(()=>server.readonly.connectionErrors.length>0);
 assert.equal((await server.readonly.query('SELECT 7 AS healthy')).rows[0].healthy,7);
 assert.deepEqual((await server.readonly.query('SELECT DISTINCT workspace_id FROM sales_stock_commitments')).rows,[{workspace_id:ctx.workspaceId}]);
 const telemetryPid=(await db.query("SELECT pid FROM pg_stat_activity WHERE usename LIKE 'demo_metrics_%' AND state='idle' LIMIT 1")).rows[0]?.pid;assert(telemetryPid);
 await db.query('SELECT pg_terminate_backend($1)',[telemetryPid]);await waitFor(()=>server.telemetryErrors.length>0);
 const page=await fetch(server.origin+'/inventory');assert.equal(page.status,200);await page.arrayBuffer();await server.flushTelemetry();
 await assert.rejects(server.readonly.query('UPDATE workspaces SET name=$1 WHERE id=$2',['forbidden',ctx.workspaceId]),/permission|read.only/i);
 assert.equal((await db.query('SELECT name FROM workspaces WHERE id=$1',[ctx.workspaceId])).rows[0].name,'Idle connection recovery');
 assert(server.readonly.connectionErrors.every(e=>Object.keys(e).sort().join(',')==='at,code'));assert(!JSON.stringify(server.telemetryErrors).includes('postgres://'));
 await server.close();server=null;
 await db.query('ALTER VIEW public.sales_stock_commitments SET (security_invoker=false)');
 try{await assert.rejects(require('../../scripts/environment-agent-demo/inspection').inspectionDatabase(cluster,db,ctx),/UNSAFE_INSPECTION_STOCK_VIEW/);}finally{await db.query('ALTER VIEW public.sales_stock_commitments SET (security_invoker=true)');}
});

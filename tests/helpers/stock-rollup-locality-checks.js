'use strict';const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function check(db,ctx){
 const before=(await db.query('SELECT sum(on_hand)::text quantity,count(*)::int positions FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];let triggerMs;
 await db.transaction(async client=>{const c={...client,transaction:fn=>fn(client)},parent=(await client.query("SELECT id FROM locations WHERE workspace_id=$1 AND parent_location_id IS NULL AND kind='warehouse' AND is_active=1 ORDER BY id LIMIT 1",[ctx.workspaceId])).rows[0].id,location=await require('../../src/domain/postgres-location-service').createLocation(c,ctx,{name:'Rollback stock rollup '+randomUUID(),kind:'bin',parentLocationId:parent});
  const skus=(await client.query('SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.is_active=1 AND i.quantity_precision=0 AND i.secondary_unit_label IS NULL ORDER BY s.id LIMIT 2000',[ctx.workspaceId])).rows;assert.equal(skus.length,2000);
  const settings=(await client.query("SELECT current_setting('enable_hashjoin') hash,current_setting('enable_mergejoin') merge")).rows[0];
  const plan=(await client.query("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) INSERT INTO balances(workspace_id,sku_id,location_id,on_hand,updated_at) SELECT $1,x.id,$2,1,$3 FROM jsonb_to_recordset($4::jsonb)x(id text)",[ctx.workspaceId,location.id,new Date().toISOString(),JSON.stringify(skus)])).rows[0]['QUERY PLAN'][0];
  assert.deepEqual((await client.query("SELECT current_setting('enable_hashjoin') hash,current_setting('enable_mergejoin') merge")).rows[0],settings,'The caller keeps its own planner settings');
  const trigger=plan.Triggers.find(t=>t['Trigger Name']==='stockchief_batch_rollup_insert');assert(trigger);triggerMs=trigger.Time;assert(triggerMs<1000,'A 2000-row item rollup must leave room for the remaining import work');
  const units=async()=>Number((await client.query('SELECT sum(on_hand)::text quantity FROM item_location_balances WHERE workspace_id=$1 AND location_id=$2',[ctx.workspaceId,location.id])).rows[0].quantity);
  assert.equal(await units(),2000);await client.query('UPDATE balances SET on_hand=2 WHERE workspace_id=$1 AND location_id=$2',[ctx.workspaceId,location.id]);assert.equal(await units(),4000);await client.query('DELETE FROM balances WHERE workspace_id=$1 AND location_id=$2',[ctx.workspaceId,location.id]);assert.equal(await units(),0);
  throw Object.assign(Error('Rollback stock rollup check'),{rollupProbe:true});
 },{isolation:'READ COMMITTED',statementTimeoutMs:15000}).catch(e=>{if(!e.rollupProbe)throw e;});
 assert.deepEqual((await db.query('SELECT sum(on_hand)::text quantity,count(*)::int positions FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0],before);
 return {stockRollupRows:2000,stockPositions:before.positions,triggerMs,exactInsertUpdateDelete:true,callerPlannerUnchanged:true,canonicalUnchanged:true,paidCalls:0};
}
module.exports={check};

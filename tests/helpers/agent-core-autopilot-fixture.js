'use strict';
const {randomUUID}=require('node:crypto');
async function fixture(t){
 const f=await require('./agent-workflow-fixture').fixture(t,{units:20}),{db,ctx}=f;await f.subscribe('enterprise');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);const autonomy=require('../../src/autopilot/postgres-service');await autonomy.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');const destination=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Core quota destination',kind:'warehouse'});
 await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at) VALUES($1,$2,$3,$4,5,10,0,'manual',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId,f.item.skuIds[0],destination.id]);await autonomy.configureRoutine(db,ctx,{role:'owner'},{transferEnabled:true,maximumQuantity:10,locationIds:[f.location.id,destination.id]});return {...f,destination,autonomy};
}
module.exports={fixture};

'use strict';
const assert=require('node:assert/strict'),request=require('supertest'),{randomUUID}=require('node:crypto');
async function check(t,{db,ctx,owner,password:ownerPassword,locations}){
 const team=require('../../src/operations/postgres-team-access'),access=require('../../src/operations/postgres-warehouse-access'),auth=require('../../src/domain/postgres-auth-service');
 const password='Warehouse!'+randomUUID(),person=await auth.createBusiness(db,{name:'Warehouse operator',businessName:'Foreign warehouse business',email:randomUUID()+'@example.test',password});
 const userId='warehouse-'+randomUUID();await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,permissions,created_at) VALUES($1,$2,$3,'Warehouse operator','staff',$4,now())",[userId,ctx.workspaceId,person.accountId,JSON.stringify(['VIEW','OPERATE','ADJUST'])]);
 const member={workspaceId:ctx.workspaceId,actorId:userId},sku=(await db.query("SELECT s.id FROM skus s JOIN items i ON i.id=s.item_id WHERE s.workspace_id=$1 AND i.tracking_mode='quantity' AND i.secondary_unit_label IS NULL ORDER BY s.id LIMIT 1",[ctx.workspaceId])).rows[0].id;
 const role=await team.saveRole(db,ctx,{name:'Warehouse counting '+randomUUID().slice(0,8),permissions:['VIEW','OPERATE','ADJUST']});
 const token=await require('../../src/connections/postgres-public-api').create(db,member,{name:'Before restriction',scopes:['inventory:read']});
 const bin=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Assigned child bin',kind:'bin',parentLocationId:locations[0].id});
 await assert.rejects(team.assign(db,ctx,userId,{revision:1,warehouseScope:'SELECTED',warehouseIds:[person.workspaceId]}),/Choose active warehouses/);
 await team.assign(db,ctx,userId,{revision:1,customRoleId:role.id,warehouseScope:'SELECTED',warehouseIds:[locations[0].id]});
 await access.assertLocations(db,member,[locations[0].id,bin.id]);await assert.rejects(access.assertLocations(db,member,[locations[1].id]),/outside your assigned/);
 await assert.rejects(require('../../src/connections/postgres-public-api').authenticate(db,'Bearer '+token.token,'inventory:read'),/limited to assigned/);
 await assert.rejects(require('../../src/assistant/postgres-goal-store').create(db,member,'Count all inventory'),/limited to assigned/);
 const inventory=require('../../src/domain/postgres-inventory-engine');await assert.rejects(inventory.receive(db,member,{skuId:sku,locationId:locations[1].id,quantity:1,idempotencyKey:'forbidden-warehouse-receipt'}),/outside your assigned/);
 await assert.rejects(db.transaction(c=>inventory.receiveManyInTransaction(c,member,[{skuId:sku,locationId:locations[1].id,quantity:1,idempotencyKey:'forbidden-bulk'}])),/outside your assigned/);
 await assert.rejects(require('../../src/operations/postgres-count-reviews').prepare(db,member,{locationId:locations[1].id,lines:[{skuId:sku,quantity:1}]}),/outside your assigned/);
 await require('../../src/accounting/postgres-stock-receipt').receive(db,member,{skuId:sku,locationId:bin.id,quantity:1,unitCost:'2',idempotencyKey:'allowed-warehouse-receipt'});
 await auth.rememberWorkspace(db,person.accountId,ctx.workspaceId);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'warehouse-member-security'});t.after(()=>app.locals.sessionStore.close());const agent=request.agent(app),login=await agent.get('/login'),csrf=/name="_csrf" value="([^"]+)"/.exec(login.text)[1];
 await agent.post('/login').type('form').send({_csrf:csrf,email:person.email,password});
 const page=await agent.get('/warehouse/stock?locationId='+bin.id);assert.equal(page.status,200);assert.match(page.text,/Assigned child bin/);assert(!page.text.includes(locations[1].name));
 for(const path of ['/','/money','/reports','/inventory/export','/settings','/ask'])assert.equal((await agent.get(path)).headers.location,'/warehouse/stock',path);
 assert.equal((await agent.get('/warehouse/stock?locationId='+locations[1].id)).status,403);
 assert.equal((await agent.post('/warehouse/stock/receive').set('Accept','application/json').type('form').send({_csrf:/name="_csrf" value="([^"]+)"/.exec(page.text)[1],skuId:sku,locationId:locations[1].id,quantity:1,unitCost:'2',operationKey:'forged-warehouse'})).status,403);
 assert.equal((await agent.get('/api/search?q=anything')).status,403);
 await db.query("UPDATE account_subscriptions SET plan_id='starter',plan_version_id=NULL WHERE account_id=$1",[owner.accountId]);
 await assert.rejects(access.assertLocations(db,member,[locations[1].id]),/outside your assigned/);
 // A downgrade preserves restrictions; restore the test plan without altering membership.
 await db.query("UPDATE account_subscriptions SET plan_id='enterprise',plan_version_id=NULL WHERE account_id=$1",[owner.accountId]);
 await team.assign(db,ctx,userId,{revision:2,warehouseScope:'SELECTED',warehouseIds:[]});assert.equal((await access.locations(db,ctx.workspaceId,await access.scope(db,member))).length,0);
 await team.assign(db,ctx,userId,{revision:3,warehouseScope:'ALL'});assert.equal(await access.scope(db,member),null);
 assert.equal((await require('../../src/connections/postgres-public-api').authenticate(db,'Bearer '+token.token,'inventory:read')).actorId,userId);
}
module.exports={check};

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('complete simple Ask counts use fewer than twenty queries with no model or browser',{timeout:120000},async t=>{
 const {db,ctx,item,location}=await require('../helpers/postgres-shipping-fixture').fixture(t);
 await db.query("INSERT INTO skus(id,workspace_id,item_id,code,variant_label,is_active,created_at) VALUES($1,$2,$3,'DIRECT-VARIANT','Any option value',1,now())",[randomUUID(),ctx.workspaceId,item.itemId]);
 let queries=0,models=0;const sql=[];
 const measured={...db,query:(statement,values)=>{queries++;sql.push(statement);return db.query(statement,values);},transaction:(operation,settings)=>db.transaction(client=>operation({query:(statement,values)=>{queries++;sql.push(statement);return client.query(statement,values);}}),settings)};
 const service=require('../../src/assistant/postgres-service'),results=[];
 for(const [message,expected]of [['How many products do I have?',/1 active product/],['How many SKUs are there?',/2 active SKUs/],['How many variants?',/2 active SKUs/]]){
  queries=0;sql.length=0;const answer=await service.ask(measured,ctx,message,{provider:{name:'offline-forbidden',model:'none',complete:async()=>{models++;throw Error('SIMPLE_READ_MODEL_FORBIDDEN');}}});
  assert.equal(answer.status,'ANSWERED');assert.match(answer.answer,expected);assert.equal(models,0);assert(queries<20,'Complete Ask request exceeded the SQL budget: '+queries);
  assert(!sql.some(statement=>/assistant_goals|codex_pilot_calls/.test(statement)),'A simple count must not start a planning goal');
  results.push({message,queries,models:0});
 }
 await db.query("UPDATE users SET role='staff',permissions='[\"VIEW\"]',warehouse_location_ids=$3::jsonb WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId,JSON.stringify([location.id])]);
 await assert.rejects(service.ask(measured,ctx,'How many products do I have?'),/limited to assigned warehouses/);
 t.diagnostic(JSON.stringify({simpleRequests:results,browsers:0,paidCalls:0}));
});

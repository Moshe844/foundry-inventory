'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');

test('merged Ask conversation controls preserve answers and isolate each person and inventory',{timeout:120000},async t=>{
 const {db,ctx}=await require('../helpers/postgres-shipping-fixture').fixture(t),store=require('../../src/assistant/postgres-goal-store'),chats=require('../../src/assistant/postgres-chats');
 const goal=await store.create(db,ctx,'Where is the coffee?'),chatId='preferences-'+goal.id;
 await db.query("UPDATE stockchief_runtime.assistant_goals SET status='COMPLETED',answer='Coffee is in Receiving.',checkpoint=checkpoint||jsonb_build_object('chatId',$2::text) WHERE id=$1",[goal.id,chatId]);
 await chats.rename(db,ctx,chatId,'Coffee review');await chats.pin(db,ctx,chatId,true);
 const list=await chats.list(db,ctx,{q:'Coffee review'});assert.equal(list.length,1);assert.equal(list[0].chat_id,chatId);assert.equal(list[0].label,'Coffee review');assert(list[0].pinned_at);
 assert.deepEqual((await chats.transcript(db,ctx,chatId)).map(turn=>[turn.message,turn.answer]),[['Where is the coffee?','Coffee is in Receiving.']]);
 for(const foreign of [{...ctx,actorId:'another-person'},{...ctx,workspaceId:'another-inventory'}]){
  assert.deepEqual(await chats.list(db,foreign),[]);
  for(const operation of [()=>chats.rename(db,foreign,chatId,'Changed'),()=>chats.pin(db,foreign,chatId,false),()=>chats.remove(db,foreign,chatId),()=>chats.transcript(db,foreign,chatId)])await assert.rejects(operation,/not in your saved work/);
 }
 const active=await store.create(db,ctx,'A request still waiting to run');
 await assert.rejects(chats.remove(db,ctx,active.id),/work in progress/);
 await chats.remove(db,ctx,chatId);assert.equal(await chats.isDeleted(db,ctx,chatId),true);
 assert(!(await chats.list(db,ctx)).some(chat=>chat.chat_id===chatId));
 await assert.rejects(chats.transcript(db,ctx,chatId),/not in your saved work/);
 const retained=(await db.query('SELECT status,answer FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3',[ctx.workspaceId,ctx.actorId,goal.id])).rows[0];
 assert.deepEqual(retained,{status:'COMPLETED',answer:'Coffee is in Receiving.'});
});

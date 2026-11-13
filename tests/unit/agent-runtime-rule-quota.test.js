'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {restriction,sources,countConfigured}=require('../../src/commercial/agent-rule-quota');

test('saving and executing rules count the same sources and use exact plan ceilings',async()=>{
 const statements=[];
 const database=(used,{installed=true}={})=>({query:async(sql,args)=>{
  if(sql.includes('to_regclass'))return {rows:installed?[]:args[0].map(name=>({name}))};
  statements.push({sql,args});
  return {rows:[{used,unrecognized:false}]};
 }});
 const readSources=sql=>[...sql.matchAll(/FROM stockchief_runtime\.(\w+) t\s+JOIN owned o ON o.id=t.workspace_id\s*(?:WHERE (.*?))?(?: LIMIT \$2::int)?\) counted/g)]
  .map(([,table,predicate])=>[table,predicate||'']);
 assert.equal(await countConfigured(database(4),'owner'),4);
 const creation=readSources(statements.at(-1).sql);
 assert.deepEqual(creation,sources.map(([table,predicate])=>[table,predicate||'']));
 assert.equal(creation.find(([table])=>table==='agent_direct_orders')[1],'routine AND rule_id IS NULL');
 assert.equal(creation.find(([table])=>table==='agent_channel_buffer_recipes')[1],'active_members>0');
 for(const [plan,limit] of [['starter',5],['growth',50],['pro',500]]){
  assert.equal(await restriction(database(limit),{plan,accountId:'owner'}),null);
  const {sql,args}=statements.at(-1);
  assert.deepEqual(args,['owner',limit+1]);
  assert.deepEqual(readSources(sql),creation);
  assert.match(sql,/deletion_requested_at IS NULL/);
  assert.doesNotMatch(sql,/operating_instruction_proposals/);
  assert.match(await restriction(database(limit+1),{plan,accountId:'owner'}),new RegExp(String(limit)));
 }
 assert.equal(await countConfigured(database(2,{installed:false}),'owner'),2);
 assert.doesNotMatch(statements.at(-1).sql,/agent_approval_routes|agent_staff_task_rules/);
 assert.equal(await restriction({query:()=>{throw Error('Custom must not acquire a finite quota');}},{plan:'enterprise'}),null);
 assert.match(await restriction({}, {plan:'growth'}),/review/i);
 assert.match(await restriction({query:async()=>({rows:[]})},{plan:'growth',accountId:'owner'}),/could not verify/);
});

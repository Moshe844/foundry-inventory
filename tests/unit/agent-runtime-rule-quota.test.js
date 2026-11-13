'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{restriction,sources,count}=require('../../src/commercial/agent-rule-quota');
test('rule execution probes every configured rule source and uses exact plan ceilings without truncating ownership',async()=>{
 // Saving a standing instruction counts through the same one list (count()), not a copy of it.
 const fs=require('node:fs'),path=require('node:path'),s=fs.readFileSync(path.join(__dirname,'../../src/manager/postgres-operating-instructions.js'),'utf8');
 assert.match(s,/require\('\.\.\/commercial\/agent-rule-quota'\)\.count\(client,state\.accountId\)/,'Standing instructions count rules through agent-rule-quota.js');
 assert.doesNotMatch(s,/FROM stockchief_runtime\.agent_draft_rules WHERE workspace_id IN\(SELECT id FROM owned\)/,'No second copy of the rule list');
 const expected=sources;
 assert.equal(expected.find(([table])=>table==='agent_direct_orders')[1],'routine AND rule_id IS NULL','A saved direct-purchasing rule counts once, including its member orders');
 assert.equal(expected.find(([table])=>table==='agent_channel_buffer_recipes')[1],'active_members>0','Only recipes with active members consume a rule slot');
 for(const [plan,limit]of [['starter',5],['growth',50],['pro',500]]){
  const db={query:async(sql,args)=>{if(sql.includes('to_regclass'))return {rows:sources.map(([table])=>({t:table}))};assert.equal(args[1],limit+1);assert(sql.includes('deletion_requested_at IS NULL'));assert(!sql.includes('operating_instruction_proposals'));return {rows:[{used:limit,unrecognized:false}]};}};assert.equal(await restriction(db,{plan,accountId:'owner'}),null);assert.match(await restriction({query:async()=>({rows:[{used:limit+1,unrecognized:false}]})},{plan,accountId:'owner'}),new RegExp(String(limit)));
 }
 const statements=[];
 const partial={query:async(sql)=>{
  statements.push(sql);
  return sql.includes('to_regclass')?{rows:[{t:'agent_draft_rules'}]}:{rows:[{n:2}]};
 }};
 assert.equal(await count(partial,'owner'),2);
 assert.match(statements.at(-1),/agent_draft_rules/);
 assert.doesNotMatch(statements.at(-1),/agent_approval_routes|agent_staff_task_rules/);
 assert.equal(await restriction({query:()=>{throw Error('Custom must not acquire a finite quota');}},{plan:'enterprise'}),null);
 assert.match(await restriction({}, {plan:'growth'}),/review/i);
 assert.match(await restriction({query:async()=>({rows:[]})},{plan:'growth',accountId:'owner'}),/could not verify/);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{restriction,sources}=require('../../src/commercial/agent-rule-quota');
test('rule execution probes every configured rule source and uses exact plan ceilings without truncating ownership',async()=>{
 const fs=require('node:fs'),path=require('node:path'),s=fs.readFileSync(path.join(__dirname,'../../src/manager/postgres-operating-instructions.js'),'utf8'),block=s.slice(s.indexOf('const configured=await client.query'),s.indexOf('async function approve',s.indexOf('const configured=await client.query'))),expected=[...block.matchAll(/SELECT count\(\*\) FROM stockchief_runtime\.([\w]+) WHERE workspace_id IN\(SELECT id FROM owned\)( AND (?:NOT )?\w+)?/g)].map(m=>[m[1],m[2]?.slice(5)]);
 assert.deepEqual(sources.map(([table,predicate])=>[table,predicate||'']),expected.map(([table,predicate])=>[table,predicate||'']),'A newly configured rule type must also participate in execution-time allowance checks');
 for(const [plan,limit]of [['starter',5],['growth',50],['pro',500]]){
  const db={query:async(sql,args)=>{assert.equal(args[1],limit+1);assert(sql.includes('deletion_requested_at IS NULL'));assert(!sql.includes('operating_instruction_proposals'));return {rows:[{used:limit,unrecognized:false}]};}};assert.equal(await restriction(db,{plan,accountId:'owner'}),null);assert.match(await restriction({query:async()=>({rows:[{used:limit+1,unrecognized:false}]})},{plan,accountId:'owner'}),new RegExp(String(limit)));
 }
 assert.equal(await restriction({query:()=>{throw Error('Custom must not acquire a finite quota');}},{plan:'enterprise'}),null);
 assert.match(await restriction({}, {plan:'growth'}),/review/i);assert.match(await restriction({query:async()=>({rows:[]})},{plan:'growth',accountId:'owner'}),/could not verify/);
});

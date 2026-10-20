'use strict';const test=require('node:test'),assert=require('node:assert/strict'),{unchangedTable}=require('../../src/assistant/business-row-verification');
test('host table projections keep exact membership and selected fields while unrelated receipt timestamps advance',()=>{
 const old=[{id:'a',amount:0,status:'OPEN',checkedAt:'2026-10-20T12:00:00Z'},{id:'b',amount:null,status:'WAITING',checkedAt:null}],current=structuredClone(old);current[0].checkedAt='2026-10-20T12:01:00Z';
 assert.deepEqual(unchangedTable(old,current,['amount','status']),{applicable:true,matched:true});
 for(const changed of [[...current].reverse(),current.slice(0,1),[...current,{id:'c',amount:0,status:'OPEN'}],[current[0],{...current[1],id:'a'}],[{...current[0],amount:null},current[1]],[{...current[0],status:'PAID'},current[1]],[{...current[0],id:'foreign'},current[1]]])assert.equal(unchangedTable(old,changed,['amount','status']).matched,false);
 assert.equal(unchangedTable(old,current,['checkedAt']).matched,false);assert.equal(unchangedTable(old,current,['missing']).matched,false);
 assert.equal(unchangedTable([{name:'same',amount:1}],[{name:'same',amount:1}],['amount']).applicable,false,'No canonical ID means the original strict verifier must decide');
});
test('ordinary model claims cannot supply the private host table-projection scope',()=>{
 const raw={status:'completed',outcome:'answer',answer:'Observed facts.',claims:[{evidenceId:'e',path:'/rows',value:[{id:'a',amount:1}],tableColumns:['amount']}]},parsed=require('../../src/assistant/agent-conversation').parse(raw);
 assert(parsed);assert(!Object.hasOwn(parsed.claims[0],'tableColumns'));assert.deepEqual(parsed.claims[0].value,raw.claims[0].value);
});

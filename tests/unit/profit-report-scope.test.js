'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),scope=require('../../src/reports/postgres-profit-scope');
test('profit account identities are workspace scoped and non-profit reports need no lookup',async()=>{
 const calls=[],db={async query(sql,values){calls.push({sql,values});return {rows:[{id:'profit-1'},{id:'profit-2'}]};}};
 assert.equal(await scope.accountIds(db,'inventory-a',{dataset:'movements'}),null);assert.equal(calls.length,0);
 assert.deepEqual(await scope.accountIds(db,'inventory-a',{dataset:'profit_activity'}),['profit-1','profit-2']);
 assert.deepEqual(calls[0].values,['inventory-a']);assert.match(calls[0].sql,/workspace_id=\$1/);assert.match(calls[0].sql,/'INCOME','COGS','EXPENSE'/);
});
test('profit identities use one bound parameter without changing existing filter positions',()=>{
 const values=['inventory-a','USD',2,0],source='SELECT 1 WHERE true /*profit-account-scope*/ OR false /*profit-account-scope*/';
 const sql=scope.bind(source,values,["id'quoted"]);
 assert.equal(sql.match(/ANY\(\$5::text\[\]\)/g).length,2);assert(!sql.includes("id'quoted"));
 assert.deepEqual(values,['inventory-a','USD',2,0,["id'quoted"]]);
 assert.equal(scope.bind('SELECT 1',values,[]),'SELECT 1');assert.equal(values.length,5);
 const empty=[];assert.match(scope.bind(source,empty,[]),/ANY\(\$1::text\[\]\)/);assert.deepEqual(empty,[[]]);
});

'use strict';const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{record}=require('../../scripts/environment-agent-demo/dependency-diagnostics');
test('unhandled dependency diagnostics retain only host module identity and owned source paths',()=>{
 const rows=[],error=Object.assign(Error("Cannot find module './runtime-adapter'\nRequire stack:\nPRIVATE_CONTENT"),{code:'MODULE_NOT_FOUND',requireStack:[path.resolve('scripts/environment-agent-demo/worker.js'),path.resolve('../private/customer.js')]});
 assert(record(error,{goalId:'goal_example',phase:'native_worker',log:r=>rows.push(r)}));assert.deepEqual(rows[0],{kind:'native_dependency_unavailable',code:'MODULE_NOT_FOUND',phase:'native_worker',goalId:'goal_example',module:'./runtime-adapter',origins:['scripts/environment-agent-demo/worker.js']});assert(!JSON.stringify(rows).includes('PRIVATE_CONTENT'));assert(!JSON.stringify(rows).includes(path.resolve('..')));
 assert(record(Object.assign(Error('Wrapper'),{cause:error}),{log:r=>rows.push(r)}));assert.equal(rows.length,2);
});
test('untrusted error messages, unrelated failures and logging failures cannot leak content or change control flow',()=>{
 const rows=[],log=r=>rows.push(r);assert.equal(record(Error('Customer private data'),{log}),false);
 assert(record(Object.assign(Error("Cannot find module 'private-customer-data'"),{code:'MODULE_NOT_FOUND'}),{phase:'secret value',goalId:'private account',log}));assert.equal(rows[0].module,null);assert.equal(rows[0].goalId,null);assert.deepEqual(rows[0].origins,[]);assert(!JSON.stringify(rows).includes('private-customer-data'));
 assert.equal(record(Object.assign(Error('ignored'),{code:'MODULE_NOT_FOUND'}),{log:()=>{throw Error('LOGGER_UNAVAILABLE');}}),false);
});

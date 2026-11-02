'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {observePoolErrors}=require('../../scripts/environment-agent-demo/inspection');
test('idle inspection-pool errors stay bounded and never expose a client, credential or raw error message',()=>{
 const pool=new EventEmitter(),errors=[];assert.equal(observePoolErrors(pool,errors),pool);
 const error=Object.assign(Error('postgres://secret-password@internal-host/private-data'),{code:'ECONNRESET'}),client={password:'secret-password'};
 for(let n=0;n<50;n++)pool.emit('error',error,client);assert.equal(errors.length,20);assert(errors.every(e=>e.code==='ECONNRESET'&&Number.isFinite(Date.parse(e.at))));assert(!JSON.stringify(errors).includes('secret-password'));
 pool.emit('error',{code:'postgres://private-password@host/database'});assert.equal(errors.at(-1).code,'connection_error');assert.equal(errors.length,20);
});

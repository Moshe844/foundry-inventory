'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{multipart}=require('../../src/web/multipart');
function request(bytes){const req=new EventEmitter(),res=new EventEmitter();req.get=k=>k==='content-type'?'multipart/form-data; boundary=test':bytes;req.resume=()=>{};res.status=n=>res.statusCode=n;res.set=()=>{};return {req,res};}
test('concurrent uploads retain admission through parsing and release it on completion or abort',()=>{
 const middleware=multipart({limit:100,memoryBudgetBytes:100});
 const first=request('60'),second=request('60');middleware(first.req,first.res,e=>assert.ifError(e));
 let denied;middleware(second.req,second.res,e=>denied=e);assert.equal(denied.status,503);
 first.req.emit('data',Buffer.from('--test--\r\n'));first.req.emit('end');
 const whileSaving=request('60');middleware(whileSaving.req,whileSaving.res,e=>denied=e);assert.equal(whileSaving.res.statusCode,503);
 first.res.emit('finish');first.res.emit('close');
 const third=request('60');middleware(third.req,third.res,e=>assert.ifError(e));third.req.emit('aborted');
 const unknown=request();middleware(unknown.req,unknown.res,e=>assert.ifError(e));unknown.req.emit('aborted');
 const last=request('100');middleware(last.req,last.res,e=>assert.ifError(e));last.res.emit('close');
});

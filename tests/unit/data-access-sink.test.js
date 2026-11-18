'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const access=require('../../src/operations/postgres-data-access');
test('the read-only renderer audit sink cannot become a business write or a different tenant audit',async()=>{
 const ctx={workspaceId:'workspace-one',accountId:'account-one',actorId:'member-one'},calls=[];
 const sink=access.scopedSink({query:async(sql,args)=>{calls.push({sql,args});return {rowCount:1};}},ctx);
 await access.record(sink,ctx,{area:'sales',method:'GET'});assert.equal(calls.length,1);
 assert.throws(()=>sink.query('DELETE FROM customers',[]),/refused/);
 await assert.rejects(access.record(sink,{...ctx,workspaceId:'foreign'},{area:'sales',method:'GET'}),/refused/);
 await assert.rejects(access.record(sink,{...ctx,actorId:'foreign'},{area:'sales',method:'GET'}),/refused/);
 await assert.rejects(access.record(sink,ctx,{area:'sales',method:'POST'}),/refused/);
 await assert.rejects(access.record(sink,ctx,{area:'untrusted_private_value',method:'GET'}),/refused/);
 assert.equal(calls.length,1,'No refused operation reached the privileged host database.');
 assert.equal(access.area('/sales/customer-secret?token=secret'),'sales');
 assert.equal(access.area('/private-token-value'),'business');
});

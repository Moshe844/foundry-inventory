'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),metadata=require('../../scripts/environment-agent-demo/inspection-metadata');
test('inspection catalogue retries only a known aborted metadata transaction',async()=>{
 let attempts=0;const db={transaction:async operation=>{if(++attempts===1)throw Object.assign(Error('tuple concurrently updated'),{code:'XX000'});return operation({ready:true});}};
 assert.equal(await metadata.transaction(db,async c=>c.ready),true);assert.equal(attempts,2);
});
test('unknown commit outcome is never repeated by inspection metadata recovery',async()=>{
 let attempts=0;const failure=Object.assign(Error('Connection lost while committing'),{code:'08006'}),db={transaction:async()=>{attempts++;throw failure;}};
 await assert.rejects(metadata.transaction(db,()=>{}),e=>e===failure);assert.equal(attempts,1);
});
test('an unrelated internal database error is not classified as a recoverable catalogue conflict',async()=>{
 let attempts=0;const failure=Object.assign(Error('Unrelated database failure'),{code:'XX000'}),db={transaction:async()=>{attempts++;throw failure;}};
 await assert.rejects(metadata.transaction(db,()=>{}),e=>e===failure);assert.equal(attempts,1);
});

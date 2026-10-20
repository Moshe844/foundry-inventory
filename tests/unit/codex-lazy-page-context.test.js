'use strict';const test=require('node:test'),assert=require('node:assert/strict'),{prepareContext}=require('../../scripts/environment-agent-demo/codex-runtime');
test('fresh native context preserves unfamiliar page hints without loading a browser or fabricating page facts',async()=>{
 let contracts=0,browser=0;const page={path:'/unfamiliar/catalogue?view=branch'},saved={goalContext:{page,originalRequest:'Explain this business situation.'},native:{}},session={load:async()=>saved};
 const context=await prepareContext({session,browser:{act:()=>{browser++;throw Error('UNREQUESTED_BROWSER');}},gateway:{initialContracts:async()=>{contracts++;return{authorized:true};}}});assert.equal(context.saved.goalContext.page,page);assert.equal(context.initialView,null);assert.equal(contracts,1);assert.equal(browser,0);assert.deepEqual(context.initialContracts,{authorized:true});
});
test('resuming a native conversation still reloads its execution receipts without replacing its context',async()=>{
 let receipts=0;const saved={goalContext:{page:{path:'/unfamiliar/approval'}},native:{codex:{threadId:'saved-native-thread'}}},session={load:async()=>saved,executionState:async()=>{receipts++;return{committed:true};}};
 const context=await prepareContext({session,browser:{act:()=>{throw Error('UNREQUESTED_BROWSER');}},gateway:{initialContracts:()=>{throw Error('ALREADY_IN_NATIVE_CONTEXT');}}});assert.equal(receipts,1);assert.equal(context.saved.native.codex.threadId,'saved-native-thread');assert.equal(context.executionState.committed,true);assert.equal(context.initialView,null);
});
